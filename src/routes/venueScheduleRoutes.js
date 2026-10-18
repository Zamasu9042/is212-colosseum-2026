// Venue Schedule Conflict Identification
//
//   POST   /api/venues/conflicts                          check one or more venues
//   GET    /api/venues/:id/holds                          list tentative holds
//   POST   /api/venues/:id/holds                          place a tentative hold (409 on conflict)
//   PATCH  /api/venues/:id/holds/:holdId/release          release a hold
//   GET    /api/venues/:id/unavailability                 list unavailability periods
//   POST   /api/venues/:id/unavailability                 record an unavailability period; flags
//                                                         overlapping venue bookings as needs_replacement
//                                                         and notifies the responsible coordinators
//   DELETE /api/venues/:id/unavailability/:periodId       remove an unavailability period
//
// All conflict rules live in utils/venueConflicts.js; this file only
// handles HTTP, validation and permissions.

const express = require('express');
const { Op } = require('sequelize');
const { body, param } = require('express-validator');
const {
  sequelize,
  Venue,
  Event,
  EventRequest,
  VenueHold,
  VenueUnavailability,
  VenueBooking,
  Notification,
} = require('../models');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');
const {
  VenueConflictError,
  lockVenues,
  loadVenueSchedules,
  checkVenueConflicts,
  assertNoVenueConflicts,
} = require('../services/venueConflictService');
const {
  isHoldActive,
  findAffectedByUnavailability,
  getEffectiveWindow,
  windowsOverlap,
} = require('../utils/venueConflicts');
const { ACTIVE_BOOKING_STATUSES } = require('../services/venueConflictService');

const router = express.Router();

const MAX_VENUES_PER_CHECK = 20;

const INTERNAL_PLANNERS = [ROLE_NAMES.VENUE_STAFF, ROLE_NAMES.EVENT_COORDINATOR];

const windowValidators = [
  body('startDateTime').notEmpty().withMessage('startDateTime is required.').bail().isISO8601()
    .withMessage('startDateTime must be a valid ISO8601 date.'),
  body('endDateTime').notEmpty().withMessage('endDateTime is required.').bail().isISO8601()
    .withMessage('endDateTime must be a valid ISO8601 date.'),
  body('endDateTime').custom((end, { req }) => {
    if (new Date(end) <= new Date(req.body.startDateTime)) {
      throw new Error('endDateTime must be after startDateTime.');
    }
    return true;
  }),
];

const venueIdParam = param('id').isUUID().withMessage('Venue id must be a valid UUID.');

async function findVenueOr404(id, res) {
  const venue = await Venue.findByPk(id);
  if (!venue) res.status(404).json({ error: 'Venue not found.' });
  return venue;
}

function sendConflict(res, err) {
  return res.status(409).json({ error: err.message, ...err.result });
}

// ---------------------------------------------------------------------
// POST /api/venues/conflicts
//
// Body:
//   venueIds        - array of venue UUIDs requested for the event (1..20)
//   startDateTime   - proposed published start (ISO8601)
//   endDateTime     - proposed published end (ISO8601)
//   excludeEventId  - optional; ignore this event and its own holds, so an
//                     existing event can be re-checked after a change
//   excludeHoldId   - optional; ignore this hold (e.g. when converting it)
//
// Always 200 — this is a read-only check. Each venue is evaluated
// independently and reports its own effective window and conflicts.
// ---------------------------------------------------------------------
router.post(
  '/conflicts',
  authorize(...INTERNAL_PLANNERS),
  [
    body('venueIds')
      .isArray({ min: 1, max: MAX_VENUES_PER_CHECK })
      .withMessage(`venueIds must be an array of 1 to ${MAX_VENUES_PER_CHECK} venue ids.`),
    body('venueIds.*').isUUID().withMessage('Each venueId must be a valid UUID.'),
    ...windowValidators,
    body('excludeEventId').optional({ nullable: true }).isUUID(),
    body('excludeHoldId').optional({ nullable: true }).isUUID(),
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      const { venueIds, startDateTime, endDateTime, excludeEventId, excludeHoldId } = req.body;
      const result = await checkVenueConflicts({
        venueIds,
        start: startDateTime,
        end: endDateTime,
        excludeEventId,
        excludeHoldId,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// Tentative holds
// ---------------------------------------------------------------------
function serializeHold(hold, now = new Date()) {
  return { ...hold.toJSON(), isActive: isHoldActive(hold, now) };
}

router.get(
  '/:id/holds',
  authorize(...INTERNAL_PLANNERS),
  [venueIdParam],
  validateRequest,
  async (req, res, next) => {
    try {
      const venue = await findVenueOr404(req.params.id, res);
      if (!venue) return;
      const holds = await VenueHold.findAll({
        where: { venueId: venue.id },
        order: [['startDatetime', 'ASC']],
      });
      const now = new Date();
      res.json({ holds: holds.map((h) => serializeHold(h, now)) });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:id/holds',
  authorize(...INTERNAL_PLANNERS),
  [
    venueIdParam,
    ...windowValidators,
    body('expiresAt')
      .optional({ nullable: true })
      .isISO8601()
      .withMessage('expiresAt must be a valid ISO8601 date.')
      .bail()
      .custom((value) => {
        if (new Date(value) <= new Date()) throw new Error('expiresAt must be in the future.');
        return true;
      }),
    body('eventId').optional({ nullable: true }).isUUID(),
    body('notes').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      const venue = await findVenueOr404(req.params.id, res);
      if (!venue) return;

      const { startDateTime, endDateTime, expiresAt, eventId, notes } = req.body;
      if (eventId && !(await Event.findByPk(eventId))) {
        return res.status(404).json({ error: 'Event not found.' });
      }

      // Lock the venue row so two concurrent hold requests for the same
      // venue are checked one after the other, not both against the
      // pre-insert schedule.
      const hold = await sequelize.transaction(async (transaction) => {
        await lockVenues([venue.id], transaction);
        await assertNoVenueConflicts({
          venueIds: [venue.id],
          start: startDateTime,
          end: endDateTime,
          excludeEventId: eventId,
          transaction,
        });
        return VenueHold.create(
          {
            venueId: venue.id,
            eventId: eventId || null,
            heldBy: req.user.id,
            startDatetime: startDateTime,
            endDatetime: endDateTime,
            expiresAt: expiresAt || null,
            notes,
          },
          { transaction }
        );
      });

      res.status(201).json({ hold: serializeHold(hold) });
    } catch (err) {
      if (err instanceof VenueConflictError) return sendConflict(res, err);
      next(err);
    }
  }
);

router.patch(
  '/:id/holds/:holdId/release',
  authorize(...INTERNAL_PLANNERS),
  [venueIdParam, param('holdId').isUUID()],
  validateRequest,
  async (req, res, next) => {
    try {
      const hold = await VenueHold.findOne({
        where: { id: req.params.holdId, venueId: req.params.id },
      });
      if (!hold) return res.status(404).json({ error: 'Hold not found.' });

      // Venue Staff manage every hold; a Coordinator may only release their own.
      if (req.user.role === ROLE_NAMES.EVENT_COORDINATOR && hold.heldBy !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden. You can only release holds you placed.' });
      }
      if (hold.status !== 'active') {
        return res.status(409).json({ error: `Hold is already ${hold.status}.` });
      }

      await hold.update({ status: 'released' });
      res.json({ hold: serializeHold(hold) });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// Unavailability periods
// ---------------------------------------------------------------------
router.get(
  '/:id/unavailability',
  authorize(...INTERNAL_PLANNERS),
  [venueIdParam],
  validateRequest,
  async (req, res, next) => {
    try {
      const venue = await findVenueOr404(req.params.id, res);
      if (!venue) return;
      const periods = await VenueUnavailability.findAll({
        where: { venueId: venue.id },
        order: [['startDatetime', 'ASC']],
      });
      res.json({ unavailability: periods });
    } catch (err) {
      next(err);
    }
  }
);

// Recording unavailability is never blocked by existing bookings (a burst
// pipe can't be rescheduled). Instead:
//   - overlapping venue bookings are flagged `needs_replacement` (the event
//     is NOT cancelled and no booking/event details are changed),
//   - the Event Coordinator responsible for each affected event is notified
//     that alternative arrangements are required,
//   - the response lists everything affected so staff can follow up.
router.post(
  '/:id/unavailability',
  authorize(ROLE_NAMES.VENUE_STAFF),
  [
    venueIdParam,
    ...windowValidators,
    body('reason')
      .isString()
      .withMessage('reason is required.')
      .bail()
      .trim()
      .isLength({ min: 1, max: 500 })
      .withMessage('reason is required (max 500 characters).'),
    // Optional for backwards compatibility; defaults to "other".
    body('reasonCategory')
      .optional()
      .isIn(VenueUnavailability.REASON_CATEGORIES)
      .withMessage(`reasonCategory must be one of: ${VenueUnavailability.REASON_CATEGORIES.join(', ')}.`),
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      const venue = await findVenueOr404(req.params.id, res);
      if (!venue) return;

      const { startDateTime, endDateTime, reason, reasonCategory } = req.body;

      const { period, affected, affectedBookings, notificationsSent } = await sequelize.transaction(
        async (transaction) => {
          const created = await VenueUnavailability.create(
            {
              venueId: venue.id,
              startDatetime: startDateTime,
              endDatetime: endDateTime,
              reason,
              reasonCategory: reasonCategory || 'other',
              createdBy: req.user.id,
            },
            { transaction }
          );

          const { events, holds } = await loadVenueSchedules([venue.id], { transaction });
          // Venue bookings are handled below, so only plain events/holds here.
          const plainEvents = events.filter((e) => !e.isVenueBooking);
          const found = findAffectedByUnavailability({
            venue,
            start: created.startDatetime,
            end: created.endDatetime,
            events: plainEvents,
            holds,
          });

          // Live venue bookings whose occupied window (incl. setup/teardown)
          // runs into the new period.
          const liveBookings = await VenueBooking.findAll({
            where: { venueId: venue.id, status: { [Op.in]: ACTIVE_BOOKING_STATUSES } },
            include: [{ model: Event, include: [{ model: EventRequest, attributes: ['eventName'] }] }],
            transaction,
          });
          const hitBookings = liveBookings.filter((b) => {
            const occupied = getEffectiveWindow(b.startDatetime, b.endDatetime, venue);
            return windowsOverlap(occupied.start, occupied.end, created.startDatetime, created.endDatetime);
          });

          // Flag only the status; venue, times and requirements stay as submitted.
          for (const booking of hitBookings) {
            await booking.update({ status: 'needs_replacement' }, { transaction });
          }

          const label = created.reasonCategory.replace('_', ' ');
          const periodText = `${created.startDatetime.toISOString()} to ${created.endDatetime.toISOString()}`;
          const makeMessage = (eventName, start, end) =>
            `${venue.name} is unavailable (${label}: ${reason}) from ${periodText}. ` +
            `"${eventName || 'Your event'}" (${new Date(start).toISOString()} - ${new Date(end).toISOString()}) ` +
            'is affected; please arrange an alternative venue.';

          let sent = 0;
          for (const booking of hitBookings) {
            const coordinatorId = booking.Event?.coordinatorId;
            if (!coordinatorId) continue;
            await Notification.create(
              {
                userId: coordinatorId,
                type: 'venue_unavailable',
                message: makeMessage(booking.Event.EventRequest?.eventName, booking.startDatetime, booking.endDatetime),
                eventId: booking.eventId,
                venueBookingId: booking.id,
              },
              { transaction }
            );
            sent += 1;
          }

          // Events that reference the venue directly (no venue booking row).
          const eventIds = found.filter((a) => a.type === 'booking').map((a) => a.eventId);
          const affectedEvents = eventIds.length
            ? await Event.findAll({
                where: { id: { [Op.in]: eventIds } },
                include: [{ model: EventRequest, attributes: ['eventName'] }],
                transaction,
              })
            : [];
          for (const event of affectedEvents) {
            if (!event.coordinatorId) continue;
            await Notification.create(
              {
                userId: event.coordinatorId,
                type: 'venue_unavailable',
                message: makeMessage(event.EventRequest?.eventName, event.startDatetime, event.endDatetime),
                eventId: event.id,
              },
              { transaction }
            );
            sent += 1;
          }

          return {
            period: created,
            affected: found,
            affectedBookings: hitBookings.map((b) => ({
              bookingId: b.id,
              eventId: b.eventId,
              eventName: b.Event?.EventRequest?.eventName ?? null,
              coordinatorId: b.Event?.coordinatorId ?? null,
              startDatetime: b.startDatetime,
              endDatetime: b.endDatetime,
              status: b.status,
            })),
            notificationsSent: sent,
          };
        }
      );

      res.status(201).json({ unavailability: period, affected, affectedBookings, notificationsSent });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/:id/unavailability/:periodId',
  authorize(ROLE_NAMES.VENUE_STAFF),
  [venueIdParam, param('periodId').isUUID()],
  validateRequest,
  async (req, res, next) => {
    try {
      const deleted = await VenueUnavailability.destroy({
        where: { id: req.params.periodId, venueId: req.params.id },
      });
      if (!deleted) return res.status(404).json({ error: 'Unavailability period not found.' });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;