/**
 * Request Changes to a Submitted Event
 *
 *   POST /api/events/:eventId/change-requests    Event Organiser asks for changes
 *   GET  /api/events/:eventId/change-requests    organiser (own), assigned coordinator, lead
 *   GET  /api/event-change-requests              queue: coordinator (own events), organiser (own), lead (all)
 *   POST /api/event-change-requests/:id/approve  assigned Coordinator; applies the change
 *   POST /api/event-change-requests/:id/reject   assigned Coordinator; reason required
 *   POST /api/event-change-requests/:id/withdraw organiser who made it (while pending)
 *
 * An organiser may ask to change: date/time, expected attendance, venue
 * requirements and equipment requirements. Nothing changes until the
 * Coordinator approves; approval goes through the same service as a direct
 * coordinator edit, so it is logged and major changes trigger reassessment.
 */
const express = require('express');
const { Op } = require('sequelize');
const { body, param, query } = require('express-validator');
const {
  sequelize,
  Event,
  EventRequest,
  EventChangeRequest,
  Notification,
  User,
} = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');
const {
  EventChangeError,
  CLOSED_EVENT_STATUSES,
  computeChanges,
  snapshotFields,
  applyEventChanges,
} = require('../services/eventChangeService');

const router = express.Router();

const FORBIDDEN = { error: 'Forbidden. You do not have access to this resource.' };

// What an organiser may ask to change.
const REQUESTABLE_FIELDS = [
  'startDatetime',
  'endDatetime',
  'expectedAttendance',
  'venueRequirements',
  'equipmentRequirements',
];

const requesterInclude = { model: User, as: 'requester', attributes: ['id', 'firstName', 'lastName', 'email'] };
const reviewerInclude = { model: User, as: 'reviewer', attributes: ['id', 'firstName', 'lastName', 'email'] };
const eventInclude = {
  model: Event,
  include: [{ model: EventRequest, attributes: ['id', 'eventName', 'organiserId'] }],
};

function sendError(err, res, next) {
  if (err instanceof EventChangeError) {
    return res.status(err.status).json({ error: err.message, ...err.extra });
  }
  return next(err);
}

const eventName = (event) => event.EventRequest?.eventName || 'your event';

async function loadChangeRequest(id) {
  return EventChangeRequest.findByPk(id, {
    include: [
      { model: Event, include: [{ model: EventRequest }] },
      requesterInclude,
    ],
  });
}

// ---------------------------------------------------------------------
// POST /api/events/:eventId/change-requests
// ---------------------------------------------------------------------
router.post(
  '/events/:eventId/change-requests',
  authenticate,
  authorize(ROLE_NAMES.EVENT_ORGANISER),
  param('eventId').isUUID().withMessage('eventId must be a valid UUID.'),
  body('startDatetime').optional().isISO8601().withMessage('startDatetime must be a valid ISO8601 date.'),
  body('endDatetime').optional().isISO8601().withMessage('endDatetime must be a valid ISO8601 date.'),
  body('expectedAttendance').optional().isInt({ min: 1 }).withMessage('expectedAttendance must be a positive integer.').toInt(),
  body('venueRequirements').optional().isString().withMessage('venueRequirements must be text.'),
  body('equipmentRequirements').optional().isString().withMessage('equipmentRequirements must be text.'),
  body('reason').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  validateRequest,
  async (req, res, next) => {
    try {
      const event = await Event.findByPk(req.params.eventId, { include: [{ model: EventRequest }] });
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      if (event.EventRequest?.organiserId !== req.user.id) return res.status(403).json(FORBIDDEN);
      if (CLOSED_EVENT_STATUSES.includes(event.status)) {
        return res.status(409).json({ error: `A ${event.status} event can no longer be changed.` });
      }

      const input = {};
      for (const f of REQUESTABLE_FIELDS) if (f in req.body) input[f] = req.body[f];
      if (!Object.keys(input).length) {
        return res.status(400).json({
          error: 'No requestable fields supplied.',
          requestableFields: REQUESTABLE_FIELDS,
        });
      }

      // Only keep fields that actually differ from the event today.
      const { changes, isMajor } = computeChanges(event, event.EventRequest, input);
      if (!Object.keys(changes).length) {
        return res.status(422).json({ error: 'The requested values are the same as the current event details.' });
      }
      const proposed = Object.fromEntries(Object.entries(changes).map(([f, c]) => [f, c.to]));
      const current = snapshotFields(event, event.EventRequest, Object.keys(changes));

      const newStart = new Date(proposed.startDatetime ?? event.startDatetime);
      const newEnd = new Date(proposed.endDatetime ?? event.endDatetime);
      if (!(newEnd > newStart)) {
        return res.status(400).json({ error: 'endDatetime must be after startDatetime.' });
      }

      const existing = await EventChangeRequest.findOne({ where: { eventId: event.id, status: 'pending' } });
      if (existing) {
        return res.status(409).json({
          error: 'This event already has a pending change request. Withdraw it or wait for the Coordinator to decide.',
          changeRequestId: existing.id,
        });
      }

      const changeRequest = await sequelize.transaction(async (transaction) => {
        const created = await EventChangeRequest.create(
          {
            eventId: event.id,
            requestedBy: req.user.id,
            proposedChanges: proposed,
            currentValues: current,
            reason: req.body.reason || null,
            isMajor,
            status: 'pending',
          },
          { transaction }
        );
        if (event.coordinatorId) {
          await Notification.create(
            {
              userId: event.coordinatorId,
              type: 'event_change_requested',
              message:
                `The organiser of "${eventName(event)}" requested changes (${Object.keys(proposed).join(', ')})` +
                `${isMajor ? ' - a major change that may need reassessment' : ''}.`,
              eventId: event.id,
            },
            { transaction }
          );
        }
        return created;
      });

      res.status(201).json({
        changeRequest,
        isMajor,
        coordinatorNotified: Boolean(event.coordinatorId),
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/events/:eventId/change-requests
// ---------------------------------------------------------------------
router.get(
  '/events/:eventId/change-requests',
  authenticate,
  authorize(ROLE_NAMES.EVENT_ORGANISER, ROLE_NAMES.EVENT_COORDINATOR, ROLE_NAMES.EVENT_COORDINATOR_LEAD),
  param('eventId').isUUID(),
  validateRequest,
  async (req, res, next) => {
    try {
      const event = await Event.findByPk(req.params.eventId, { include: [{ model: EventRequest }] });
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      if (req.user.role === ROLE_NAMES.EVENT_ORGANISER && event.EventRequest?.organiserId !== req.user.id) {
        return res.status(403).json(FORBIDDEN);
      }
      if (req.user.role === ROLE_NAMES.EVENT_COORDINATOR && event.coordinatorId !== req.user.id) {
        return res.status(403).json(FORBIDDEN);
      }
      const changeRequests = await EventChangeRequest.findAll({
        where: { eventId: event.id },
        include: [requesterInclude, reviewerInclude],
        order: [['created_at', 'DESC']],
      });
      res.json({ changeRequests, count: changeRequests.length });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/my-events  (organiser: the events created from their own requests)
// ---------------------------------------------------------------------
router.get(
  '/my-events',
  authenticate,
  authorize(ROLE_NAMES.EVENT_ORGANISER),
  async (req, res, next) => {
    try {
      const events = await Event.findAll({
        include: [{ model: EventRequest, where: { organiserId: req.user.id }, required: true }],
        order: [['start_datetime', 'ASC']],
      });
      res.json({ events, count: events.length });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/event-change-requests?status=pending|approved|rejected|withdrawn|all
// ---------------------------------------------------------------------
router.get(
  '/event-change-requests',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR, ROLE_NAMES.EVENT_ORGANISER, ROLE_NAMES.EVENT_COORDINATOR_LEAD),
  query('status').optional().isIn(['pending', 'approved', 'rejected', 'withdrawn', 'all']),
  validateRequest,
  async (req, res, next) => {
    try {
      const status = req.query.status || 'pending';
      const where = {};
      if (status !== 'all') where.status = status;
      if (req.user.role === ROLE_NAMES.EVENT_ORGANISER) where.requestedBy = req.user.id;

      const include = [requesterInclude, reviewerInclude, { ...eventInclude, required: true }];
      if (req.user.role === ROLE_NAMES.EVENT_COORDINATOR) {
        include[2] = { ...eventInclude, required: true, where: { coordinatorId: req.user.id } };
      }

      const changeRequests = await EventChangeRequest.findAll({
        where,
        include,
        order: [['created_at', 'ASC']],
      });
      res.json({ changeRequests, count: changeRequests.length });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// Coordinator decision
// ---------------------------------------------------------------------
async function loadPendingForCoordinator(req, res) {
  const changeRequest = await loadChangeRequest(req.params.id);
  if (!changeRequest) {
    res.status(404).json({ error: 'Change request not found.' });
    return null;
  }
  if (changeRequest.Event.coordinatorId !== req.user.id) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  if (changeRequest.status !== 'pending') {
    res.status(409).json({ error: `Only pending change requests can be decided (this one is ${changeRequest.status}).` });
    return null;
  }
  return changeRequest;
}

router.post(
  '/event-change-requests/:id/approve',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  param('id').isUUID(),
  body('reviewReason').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  validateRequest,
  async (req, res, next) => {
    try {
      const changeRequest = await loadPendingForCoordinator(req, res);
      if (!changeRequest) return;
      const event = changeRequest.Event;

      const result = await sequelize.transaction(async (transaction) => {
        const applied = await applyEventChanges({
          event,
          input: changeRequest.proposedChanges,
          actor: req.user,
          source: 'change_request',
          reason: changeRequest.reason,
          changeRequestId: changeRequest.id,
          transaction,
        });
        await changeRequest.update(
          {
            status: 'approved',
            reviewedBy: req.user.id,
            reviewedAt: new Date(),
            reviewReason: req.body.reviewReason || null,
          },
          { transaction }
        );
        await Notification.create(
          {
            userId: changeRequest.requestedBy,
            type: 'event_change_approved',
            message:
              `Your change request for "${eventName(event)}" was approved.` +
              (applied.reassessment ? ' Venue and equipment arrangements will be reassessed.' : ''),
            eventId: event.id,
          },
          { transaction }
        );
        return applied;
      });

      await event.reload({ include: [{ model: EventRequest }] });
      res.json({
        changeRequest,
        changeType: result.changeType,
        changes: result.changes,
        reassessment: result.reassessment,
        event,
      });
    } catch (err) {
      sendError(err, res, next);
    }
  }
);

router.post(
  '/event-change-requests/:id/reject',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  param('id').isUUID(),
  body('reviewReason')
    .exists({ checkFalsy: true }).withMessage('reviewReason is required when rejecting a change request.')
    .bail().isString().trim().isLength({ min: 1, max: 1000 }),
  validateRequest,
  async (req, res, next) => {
    try {
      const changeRequest = await loadPendingForCoordinator(req, res);
      if (!changeRequest) return;

      await sequelize.transaction(async (transaction) => {
        await changeRequest.update(
          {
            status: 'rejected',
            reviewedBy: req.user.id,
            reviewedAt: new Date(),
            reviewReason: req.body.reviewReason,
          },
          { transaction }
        );
        await Notification.create(
          {
            userId: changeRequest.requestedBy,
            type: 'event_change_rejected',
            message: `Your change request for "${eventName(changeRequest.Event)}" was rejected: ${req.body.reviewReason}`,
            eventId: changeRequest.eventId,
          },
          { transaction }
        );
      });
      res.json({ changeRequest });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// Organiser withdraws their own pending request
// ---------------------------------------------------------------------
router.post(
  '/event-change-requests/:id/withdraw',
  authenticate,
  authorize(ROLE_NAMES.EVENT_ORGANISER),
  param('id').isUUID(),
  validateRequest,
  async (req, res, next) => {
    try {
      const changeRequest = await EventChangeRequest.findByPk(req.params.id);
      if (!changeRequest) return res.status(404).json({ error: 'Change request not found.' });
      if (changeRequest.requestedBy !== req.user.id) return res.status(403).json(FORBIDDEN);
      if (changeRequest.status !== 'pending') {
        return res.status(409).json({ error: `Only pending change requests can be withdrawn (this one is ${changeRequest.status}).` });
      }
      await changeRequest.update({ status: 'withdrawn' });
      res.json({ changeRequest });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;