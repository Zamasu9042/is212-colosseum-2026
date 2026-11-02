/**
 * Manage Event Information During Planning
 *
 *   PATCH /api/events/:eventId             assigned Event Coordinator edits event info
 *   GET   /api/events/:eventId/change-log  history of applied changes
 *
 * Major vs ordinary:
 *   MAJOR   date/time, expected attendance, venue requirements, equipment
 *           requirements. Applying one flags the event for reassessment and
 *           reports the venue bookings / equipment arrangements to re-check.
 *   ordinary everything else (name, description, layout, accessibility...).
 * Every applied change is stored in the change log (old and new values).
 *
 * Mounted at the API root (full paths), like the other /events/... routers.
 */
const express = require('express');
const { body, param } = require('express-validator');
const { sequelize, Event, EventRequest, EventChangeLog, User } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');
const { EventChangeError, EDITABLE_FIELDS, applyEventChanges } = require('../services/eventChangeService');

const router = express.Router();

const FORBIDDEN = { error: 'Forbidden. You do not have access to this resource.' };
const nullableText = (name) => body(name).optional({ nullable: true }).isString();

const patchValidators = [
  param('eventId').isUUID().withMessage('eventId must be a valid UUID.'),
  body('eventName')
    .optional()
    .isString().withMessage('eventName must be text.')
    .bail().trim().isLength({ min: 1, max: 200 }).withMessage('eventName must be 1-200 characters.'),
  nullableText('description'),
  nullableText('purpose'),
  body('category').optional({ nullable: true }).isString().isLength({ max: 50 }),
  body('startDatetime').optional().isISO8601().withMessage('startDatetime must be a valid ISO8601 date.'),
  body('endDatetime').optional().isISO8601().withMessage('endDatetime must be a valid ISO8601 date.'),
  body('expectedAttendance').optional().isInt({ min: 1 }).withMessage('expectedAttendance must be a positive integer.').toInt(),
  nullableText('venueRequirements'),
  body('requestedLayout').optional({ nullable: true }).isString().isLength({ max: 100 }),
  nullableText('accessibilityRequirements'),
  nullableText('facilityRequirements'),
  nullableText('setupRequirements'),
  nullableText('equipmentRequirements'),
  nullableText('layout'),
  nullableText('registrationSetup'),
  body('registrationRequired').optional().isBoolean().withMessage('registrationRequired must be true or false.').toBoolean(),
  body('reason').optional({ nullable: true }).isString().isLength({ max: 1000 }),
];

function sendError(err, res, next) {
  if (err instanceof EventChangeError) {
    return res.status(err.status).json({ error: err.message, ...err.extra });
  }
  return next(err);
}

// Only the Coordinator assigned to the event may edit it. Organisers use the
// change-request flow; Leads, Venue Staff and Technical Support are read-only.
router.patch(
  '/events/:eventId',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  patchValidators,
  validateRequest,
  async (req, res, next) => {
    try {
      const input = {};
      for (const f of EDITABLE_FIELDS) if (f in req.body) input[f] = req.body[f];
      if (!Object.keys(input).length) {
        return res.status(400).json({
          error: 'No editable fields supplied.',
          editableFields: EDITABLE_FIELDS,
        });
      }

      const event = await Event.findByPk(req.params.eventId, { include: [{ model: EventRequest }] });
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      if (event.coordinatorId !== req.user.id) return res.status(403).json(FORBIDDEN);

      const result = await sequelize.transaction((transaction) =>
        applyEventChanges({
          event,
          input,
          actor: req.user,
          source: 'coordinator_update',
          reason: req.body.reason,
          transaction,
        })
      );

      await event.reload({ include: [{ model: EventRequest }] });
      res.json({
        changed: result.changed,
        changeType: result.changeType,
        changes: result.changes,
        reassessment: result.reassessment,
        event,
        message: result.changed ? 'Event updated.' : 'No changes: the values already match.',
      });
    } catch (err) {
      sendError(err, res, next);
    }
  }
);

// Who may read the history: the people with a stake in the event.
router.get(
  '/events/:eventId/change-log',
  authenticate,
  authorize(
    ROLE_NAMES.EVENT_COORDINATOR,
    ROLE_NAMES.EVENT_COORDINATOR_LEAD,
    ROLE_NAMES.EVENT_ORGANISER,
    ROLE_NAMES.VENUE_STAFF,
    ROLE_NAMES.TECHNICAL_SUPPORT_STAFF
  ),
  param('eventId').isUUID(),
  validateRequest,
  async (req, res, next) => {
    try {
      const event = await Event.findByPk(req.params.eventId, { include: [{ model: EventRequest }] });
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      if (req.user.role === ROLE_NAMES.EVENT_COORDINATOR && event.coordinatorId !== req.user.id) {
        return res.status(403).json(FORBIDDEN);
      }
      if (req.user.role === ROLE_NAMES.EVENT_ORGANISER && event.EventRequest?.organiserId !== req.user.id) {
        return res.status(403).json(FORBIDDEN);
      }

      const entries = await EventChangeLog.findAll({
        where: { eventId: event.id },
        include: [{ model: User, as: 'changer', attributes: ['id', 'firstName', 'lastName', 'email'] }],
        order: [['created_at', 'DESC']],
      });
      res.json({
        eventId: event.id,
        reassessmentFlaggedAt: event.reassessmentFlaggedAt,
        reassessmentDetails: event.reassessmentDetails,
        entries,
        count: entries.length,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;