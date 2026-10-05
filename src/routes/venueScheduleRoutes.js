// Venue Schedule Conflict Identification
//
//   POST   /api/venues/conflicts                          check one or more venues
//   GET    /api/venues/:id/holds                          list tentative holds
//   POST   /api/venues/:id/holds                          place a tentative hold (409 on conflict)
//   PATCH  /api/venues/:id/holds/:holdId/release          release a hold
//   GET    /api/venues/:id/unavailability                 list unavailability periods
//   POST   /api/venues/:id/unavailability                 record an unavailability period
//   DELETE /api/venues/:id/unavailability/:periodId       remove an unavailability period
//
// All conflict rules live in utils/venueConflicts.js; this file only
// handles HTTP, validation and permissions.

const express = require('express');
const { body, param } = require('express-validator');
const { sequelize, Venue, Event, VenueHold, VenueUnavailability } = require('../models');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');
const {
  VenueConflictError,
  lockVenues,
  loadVenueSchedules,
  checkVenueConflicts,
  assertNoVenueConflicts,
} = require('../services/venueConflictService');
const { isHoldActive, findAffectedByUnavailability } = require('../utils/venueConflicts');

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
// pipe can't be rescheduled), but the response lists the bookings and
// active holds it now clashes with so staff can follow up.
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
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      const venue = await findVenueOr404(req.params.id, res);
      if (!venue) return;

      const { startDateTime, endDateTime, reason } = req.body;
      const period = await VenueUnavailability.create({
        venueId: venue.id,
        startDatetime: startDateTime,
        endDatetime: endDateTime,
        reason,
        createdBy: req.user.id,
      });

      const { events, holds } = await loadVenueSchedules([venue.id]);
      const affected = findAffectedByUnavailability({
        venue,
        start: period.startDatetime,
        end: period.endDatetime,
        events,
        holds,
      });

      res.status(201).json({ unavailability: period, affected });
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
