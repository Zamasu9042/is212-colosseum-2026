const express = require('express');
const { Op } = require('sequelize');
const { body, param, query } = require('express-validator');
const {
  Event,
  EventRequest,
  Venue,
  User,
  VenueBooking,
  Notification,
} = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');
const { runBookingChecks } = require('../utils/bookingChecks');
const { checkVenueConflicts } = require('../services/venueConflictService');

const router = express.Router();

const FORBIDDEN = { error: 'Forbidden. You do not have access to this resource.' };

// Events that can no longer take venue bookings.
const CLOSED_EVENT_STATUSES = ['completed', 'cancelled'];

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
const bookingInclude = [
  { model: Venue, attributes: ['id', 'name', 'location', 'capacity', 'status'] },
];

async function loadEvent(eventId) {
  return Event.findByPk(eventId, { include: [{ model: EventRequest }] });
}

const isAssignedCoordinator = (req, event) =>
  req.user.role === ROLE_NAMES.EVENT_COORDINATOR && event.coordinatorId === req.user.id;

const isOwningOrganiser = (req, event) =>
  req.user.role === ROLE_NAMES.EVENT_ORGANISER &&
  event.EventRequest &&
  event.EventRequest.organiserId === req.user.id;

/** Coordinator assigned to the event, Venue Staff, or the organiser who owns the request. */
const canViewEventBookings = (req, event) =>
  isAssignedCoordinator(req, event) ||
  isOwningOrganiser(req, event) ||
  req.user.role === ROLE_NAMES.VENUE_STAFF ||
  req.user.role === ROLE_NAMES.SAFETY_OFFICER;

async function notify(userId, type, message, { eventId, venueBookingId } = {}) {
  if (!userId) return;
  await Notification.create({ userId, type, message, eventId, venueBookingId });
}

function checksFailed(res, failures) {
  return res.status(422).json({
    error: 'The venue booking request did not pass the venue checks.',
    failures,
  });
}

/** Loads a booking + its event, and enforces "assigned coordinator". */
async function loadBookingForCoordinator(req, res) {
  const booking = await VenueBooking.findByPk(req.params.id, { include: bookingInclude });
  if (!booking) {
    res.status(404).json({ error: 'Venue booking not found.' });
    return null;
  }
  const event = await loadEvent(booking.eventId);
  if (!isAssignedCoordinator(req, event)) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { booking, event };
}

const idParam = (name) => param(name).isUUID().withMessage(`${name} must be a valid UUID.`);

const requiredBookingFields = [
  body('venueId')
    .exists({ checkFalsy: true }).withMessage('venueId is required.')
    .bail().isUUID().withMessage('venueId must be a valid UUID.'),
  body('startDatetime')
    .exists({ checkFalsy: true }).withMessage('startDatetime is required.')
    .bail().isISO8601().withMessage('startDatetime must be a valid ISO8601 date.'),
  body('endDatetime')
    .exists({ checkFalsy: true }).withMessage('endDatetime is required.')
    .bail().isISO8601().withMessage('endDatetime must be a valid ISO8601 date.'),
];

const optionalBookingFields = [
  body('expectedAttendance').optional().isInt({ min: 1 }).withMessage('expectedAttendance must be a positive integer.'),
  body('requirements').optional({ nullable: true }).isString().isLength({ max: 2000 }),
];

// ---------------------------------------------------------------------
// POST /api/events/:eventId/venue-bookings
// Event Coordinator submits a booking request for ONE venue. Call it
// again for each extra venue (Book Multiple Venues for One Event) —
// every request is checked on its own and linked to the same event.
// ---------------------------------------------------------------------
router.post(
  '/events/:eventId/venue-bookings',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  idParam('eventId'),
  ...requiredBookingFields,
  ...optionalBookingFields,
  validateRequest,
  async (req, res, next) => {
    try {
      const event = await loadEvent(req.params.eventId);
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      if (!isAssignedCoordinator(req, event)) return res.status(403).json(FORBIDDEN);
      if (CLOSED_EVENT_STATUSES.includes(event.status)) {
        return res.status(409).json({ error: `Cannot book venues for a ${event.status} event.` });
      }

      const start = new Date(req.body.startDatetime);
      const end = new Date(req.body.endDatetime);
      if (!(end > start)) {
        return res.status(400).json({ error: 'endDatetime must be after startDatetime.' });
      }

      const attendance = req.body.expectedAttendance ?? event.EventRequest?.expectedAttendance;
      if (!attendance) {
        return res.status(400).json({
          error: 'expectedAttendance is required because the event request has no expected attendance.',
        });
      }

      const venue = await Venue.findByPk(req.body.venueId);
      if (!venue) return res.status(404).json({ error: 'Venue not found.' });

      const failures = await runBookingChecks({ venue, event, start, end, attendance });
      if (failures.length) return checksFailed(res, failures);

      const booking = await VenueBooking.create({
        eventId: event.id,
        venueId: venue.id,
        requestedBy: req.user.id,
        startDatetime: start,
        endDatetime: end,
        expectedAttendance: attendance,
        requirements: req.body.requirements,
        status: 'pending',
      });

      res.status(201).json({ booking });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/events/:eventId/venue-bookings
// All venue bookings for an event (any status), for the assigned
// Coordinator, the owning Organiser and Venue Staff.
// ---------------------------------------------------------------------
router.get(
  '/events/:eventId/venue-bookings',
  authenticate,
  idParam('eventId'),
  validateRequest,
  async (req, res, next) => {
    try {
      const event = await loadEvent(req.params.eventId);
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      if (!canViewEventBookings(req, event)) return res.status(403).json(FORBIDDEN);

      const bookings = await VenueBooking.findAll({
        where: { eventId: event.id },
        include: bookingInclude,
        order: [['start_datetime', 'ASC'], ['created_at', 'ASC']],
      });
      res.json({ eventId: event.id, bookings, count: bookings.length });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/venue-bookings — Venue Staff queue. Defaults to pending.
// ?status=pending|approved|rejected|cancelled|needs_replacement|replaced|all
// ?venueId=<uuid>
// ---------------------------------------------------------------------
router.get(
  '/venue-bookings',
  authenticate,
  authorize(ROLE_NAMES.VENUE_STAFF),
  query('status').optional().isIn([...VenueBooking.STATUSES, 'all']),
  query('venueId').optional().isUUID(),
  validateRequest,
  async (req, res, next) => {
    try {
      const status = req.query.status || 'pending';
      const where = {};
      if (status !== 'all') where.status = status;
      if (req.query.venueId) where.venueId = req.query.venueId;

      const bookings = await VenueBooking.findAll({
        where,
        include: [
          ...bookingInclude,
          { model: Event, include: [{ model: EventRequest, attributes: ['eventName'] }] },
          { model: User, as: 'requester', attributes: ['id', 'firstName', 'lastName', 'email'] },
        ],
        order: [['created_at', 'ASC']],
      });
      res.json({ bookings, count: bookings.length });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// Replacement search + request (Mark Venue Temporarily Unavailable AC8).
// Registered before the generic /venue-bookings/:id routes below.
// ---------------------------------------------------------------------

// GET /api/venue-bookings/:id/replacement-venues
// Venues that could take over a booking: big enough, open, not in an
// unavailable period and free of conflicts for the booking's window.
// Optional filters: search, minCapacity, facilities (comma list), venueType.
router.get(
  '/venue-bookings/:id/replacement-venues',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  idParam('id'),
  query('minCapacity').optional().isInt({ min: 1 }),
  validateRequest,
  async (req, res, next) => {
    try {
      const ctx = await loadBookingForCoordinator(req, res);
      if (!ctx) return;
      const { booking, event } = ctx;

      const and = [
        { id: { [Op.ne]: booking.venueId } },
        { status: 'available' },
        { capacity: { [Op.gte]: Math.max(booking.expectedAttendance, parseInt(req.query.minCapacity || 1, 10)) } },
      ];
      if (req.query.search) {
        and.push({
          [Op.or]: [
            { name: { [Op.iLike]: `%${req.query.search}%` } },
            { location: { [Op.iLike]: `%${req.query.search}%` } },
          ],
        });
      }
      if (req.query.venueType) and.push({ venueType: { [Op.iLike]: req.query.venueType } });
      const facilities = (req.query.facilities || '').split(',').map((f) => f.trim()).filter(Boolean);
      if (facilities.length) and.push({ facilities: { [Op.contains]: facilities } });

      const venues = await Venue.findAll({ where: { [Op.and]: and }, order: [['name', 'ASC']] });

      // Same rules as a real booking request: buffers, other events and
      // bookings, holds and unavailability periods. The booking being
      // replaced is excluded so it can't block its own replacement.
      let results = [];
      if (venues.length) {
        const check = await checkVenueConflicts({
          venueIds: venues.map((v) => v.id),
          start: booking.startDatetime,
          end: booking.endDatetime,
          excludeEventId: event.id,
          excludeBookingId: booking.id,
        });
        const free = new Set(check.venues.filter((v) => !v.hasConflict).map((v) => v.venueId));
        results = venues.filter((v) => free.has(v.id)).map((v) => v.toJSON());
      }

      res.json({ bookingId: booking.id, venues: results, count: results.length });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/venue-bookings/:id/replace  { venueId, startDatetime?, endDatetime?, requirements? }
// Requests a replacement venue for a booking flagged needs_replacement.
// The original booking is kept (status -> replaced) for the audit trail
// and the new one starts as a normal pending request.
router.post(
  '/venue-bookings/:id/replace',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  idParam('id'),
  body('venueId').exists({ checkFalsy: true }).withMessage('venueId is required.').bail().isUUID(),
  body('startDatetime').optional().isISO8601(),
  body('endDatetime').optional().isISO8601(),
  ...optionalBookingFields,
  validateRequest,
  async (req, res, next) => {
    try {
      const ctx = await loadBookingForCoordinator(req, res);
      if (!ctx) return;
      const { booking, event } = ctx;

      if (booking.status !== 'needs_replacement') {
        return res.status(409).json({ error: 'Only a booking that needs a replacement can be replaced.' });
      }
      const venue = await Venue.findByPk(req.body.venueId);
      if (!venue) return res.status(404).json({ error: 'Venue not found.' });

      const start = new Date(req.body.startDatetime || booking.startDatetime);
      const end = new Date(req.body.endDatetime || booking.endDatetime);
      if (!(end > start)) {
        return res.status(400).json({ error: 'endDatetime must be after startDatetime.' });
      }
      const attendance = req.body.expectedAttendance ?? booking.expectedAttendance;

      const failures = await runBookingChecks({ venue, event, start, end, attendance });
      if (failures.length) return checksFailed(res, failures);

      const replacement = await VenueBooking.sequelize.transaction(async (transaction) => {
        const created = await VenueBooking.create(
          {
            eventId: event.id,
            venueId: venue.id,
            requestedBy: req.user.id,
            startDatetime: start,
            endDatetime: end,
            expectedAttendance: attendance,
            requirements: req.body.requirements ?? booking.requirements,
            status: 'pending',
            replacesBookingId: booking.id,
          },
          { transaction }
        );
        await booking.update({ status: 'replaced' }, { transaction });
        return created;
      });

      res.status(201).json({ booking: replacement, replaced: booking.id });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// PATCH /api/venue-bookings/:id — change timing/attendance/requirements
// of ONE booking. Other bookings of the event are never touched. An
// approved booking goes back to pending so Venue Staff re-review it.
// (To move to a different venue, cancel and submit a new request.)
// ---------------------------------------------------------------------
router.patch(
  '/venue-bookings/:id',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  idParam('id'),
  body('startDatetime').optional().isISO8601(),
  body('endDatetime').optional().isISO8601(),
  ...optionalBookingFields,
  validateRequest,
  async (req, res, next) => {
    try {
      const ctx = await loadBookingForCoordinator(req, res);
      if (!ctx) return;
      const { booking, event } = ctx;

      if (!['pending', 'approved'].includes(booking.status)) {
        return res.status(409).json({ error: `A ${booking.status} booking cannot be changed.` });
      }

      const start = new Date(req.body.startDatetime || booking.startDatetime);
      const end = new Date(req.body.endDatetime || booking.endDatetime);
      if (!(end > start)) {
        return res.status(400).json({ error: 'endDatetime must be after startDatetime.' });
      }
      const attendance = req.body.expectedAttendance ?? booking.expectedAttendance;

      const failures = await runBookingChecks({
        venue: await Venue.findByPk(booking.venueId),
        event,
        start,
        end,
        attendance,
        excludeBookingId: booking.id,
      });
      if (failures.length) return checksFailed(res, failures);

      await booking.update({
        startDatetime: start,
        endDatetime: end,
        expectedAttendance: attendance,
        requirements: req.body.requirements !== undefined ? req.body.requirements : booking.requirements,
        status: 'pending',
        reviewReason: null,
        reviewedBy: null,
        reviewedAt: null,
      });
      res.json({ booking });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/venue-bookings/:id/cancel — cancels ONE booking only.
router.post(
  '/venue-bookings/:id/cancel',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  idParam('id'),
  validateRequest,
  async (req, res, next) => {
    try {
      const ctx = await loadBookingForCoordinator(req, res);
      if (!ctx) return;
      const { booking } = ctx;

      if (!['pending', 'approved', 'needs_replacement'].includes(booking.status)) {
        return res.status(409).json({ error: `A ${booking.status} booking cannot be cancelled.` });
      }
      await booking.update({ status: 'cancelled' });
      res.json({ booking });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// Venue Staff review — each booking is decided independently.
// (Whether a multi-venue event can be partly approved is still pending
// customer clarification; independent decisions follow the Week 7
// customer change note and are easy to tighten later.)
// ---------------------------------------------------------------------
async function loadPendingBooking(req, res) {
  const booking = await VenueBooking.findByPk(req.params.id);
  if (!booking) {
    res.status(404).json({ error: 'Venue booking not found.' });
    return null;
  }
  if (booking.status !== 'pending') {
    res.status(409).json({ error: `Only pending bookings can be reviewed (this one is ${booking.status}).` });
    return null;
  }
  return booking;
}

router.post(
  '/venue-bookings/:id/approve',
  authenticate,
  authorize(ROLE_NAMES.VENUE_STAFF),
  idParam('id'),
  validateRequest,
  async (req, res, next) => {
    try {
      const booking = await loadPendingBooking(req, res);
      if (!booking) return;
      const event = await loadEvent(booking.eventId);
      const venue = await Venue.findByPk(booking.venueId);

      // Things may have changed since submission (new maintenance period,
      // another approved booking) so re-check before confirming.
      const failures = (
        await runBookingChecks({
          venue,
          event,
          start: booking.startDatetime,
          end: booking.endDatetime,
          attendance: booking.expectedAttendance,
          excludeBookingId: booking.id,
        })
      );
      if (failures.length) {
        return res.status(409).json({ error: 'This booking can no longer be approved.', failures });
      }

      await booking.update({
        status: 'approved',
        reviewedBy: req.user.id,
        reviewedAt: new Date(),
        reviewReason: null,
      });
      await notify(
        event.coordinatorId,
        'venue_booking_approved',
        `Your booking for ${venue.name} has been approved.`,
        { eventId: event.id, venueBookingId: booking.id }
      );
      res.json({ booking });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/venue-bookings/:id/reject',
  authenticate,
  authorize(ROLE_NAMES.VENUE_STAFF),
  idParam('id'),
  body('reason').exists({ checkFalsy: true }).withMessage('A reason is required to reject a booking.')
    .bail().isString().trim().isLength({ min: 1, max: 2000 }),
  validateRequest,
  async (req, res, next) => {
    try {
      const booking = await loadPendingBooking(req, res);
      if (!booking) return;
      const event = await loadEvent(booking.eventId);
      const venue = await Venue.findByPk(booking.venueId);

      await booking.update({
        status: 'rejected',
        reviewedBy: req.user.id,
        reviewedAt: new Date(),
        reviewReason: req.body.reason,
      });
      await notify(
        event.coordinatorId,
        'venue_booking_rejected',
        `Your booking for ${venue.name} was rejected: ${req.body.reason}`,
        { eventId: event.id, venueBookingId: booking.id }
      );
      res.json({ booking });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
