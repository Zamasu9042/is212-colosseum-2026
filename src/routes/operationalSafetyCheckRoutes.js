const express = require('express');
const { body, param } = require('express-validator');
const {
  sequelize,
  Event,
  EventRequest,
  Venue,
  VenueBooking,
  OperationalSafetyCheck,
} = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');

const router = express.Router();
const eventId = [param('eventId').isUUID(), validateRequest];
const nonBlank = (field) => body(field).isString().trim().notEmpty();

function canCoordinate(req, event) {
  return event.coordinatorId === req.user.id;
}

async function getSafetyContext(eventId, transaction) {
  const event = await Event.findByPk(eventId, {
    include: [
      { model: EventRequest },
      { model: Venue },
      { model: VenueBooking, as: 'venueBookings', include: [{ model: Venue }] },
      { model: OperationalSafetyCheck, as: 'operationalSafetyCheck' },
    ],
    transaction,
  });
  return event;
}

// A confirmed direct venue OR one/more approved booking(s) is sufficient.
// In either case, an outstanding venue decision means arrangements are not
// ready for safety review.
function arrangementState(event) {
  const bookings = event.venueBookings || [];
  const pending = bookings.filter((booking) => ['pending', 'needs_replacement'].includes(booking.status));
  const approved = bookings.filter((booking) => booking.status === 'approved');
  return {
    ready: pending.length === 0 && (Boolean(event.venueId) || approved.length > 0),
    pendingCount: pending.length,
    approvedCount: approved.length,
  };
}

function serializeContext(event) {
  const request = event.EventRequest;
  const bookings = event.venueBookings || [];
  return {
    event,
    reviewInformation: {
      expectedAttendance: request?.expectedAttendance ?? null,
      venueCapacity: event.Venue?.capacity ?? bookings.map((b) => b.Venue?.capacity ?? null),
      venueLayout: request?.requestedLayout || request?.layout || null,
      accessibilityRequirements: request?.accessibilityRequirements || null,
      equipmentRequirements: request?.equipmentRequirements || null,
      knownVenueRestrictions: bookings.map((b) => b.requirements).filter(Boolean),
    },
  };
}

router.get(
  '/operational-safety-checks/pending',
  authenticate,
  authorize(ROLE_NAMES.SAFETY_OFFICER),
  async (req, res, next) => {
    try {
      const checks = await OperationalSafetyCheck.findAll({
        where: { status: 'pending' },
        include: [{ model: Event, include: [{ model: EventRequest }] }],
        order: [['requested_at', 'ASC']],
      });
      res.json({ operationalSafetyChecks: checks, count: checks.length });
    } catch (err) { next(err); }
  }
);

router.get(
  '/events/:eventId/operational-safety-check',
  authenticate,
  authorize(ROLE_NAMES.SAFETY_OFFICER, ROLE_NAMES.EVENT_COORDINATOR, ROLE_NAMES.EVENT_COORDINATOR_LEAD),
  ...eventId,
  async (req, res, next) => {
    try {
      const event = await getSafetyContext(req.params.eventId);
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      if (req.user.role === ROLE_NAMES.EVENT_COORDINATOR && !canCoordinate(req, event)) {
        return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
      }
      if (!event.operationalSafetyCheck) return res.status(404).json({ error: 'Operational safety check not found.' });
      res.json({ operationalSafetyCheck: event.operationalSafetyCheck, ...serializeContext(event) });
    } catch (err) { next(err); }
  }
);

router.post(
  '/events/:eventId/operational-safety-check',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  ...eventId,
  body('technicalArrangementsConfirmed')
    .isBoolean().withMessage('technicalArrangementsConfirmed must be true.')
    .custom((value) => {
      if (value !== true && value !== 'true') throw new Error('technicalArrangementsConfirmed must be true.');
      return true;
    }),
  nonBlank('emergencyAccess'), nonBlank('equipmentPlacement'), nonBlank('crowdMovement'),
  body('venueRestrictions').optional({ nullable: true }).isString(),
  validateRequest,
  async (req, res, next) => {
    try {
      const result = await sequelize.transaction(async (transaction) => {
        const event = await getSafetyContext(req.params.eventId, transaction);
        if (!event) return { error: 'Event not found.', status: 404 };
        if (!canCoordinate(req, event)) return { error: 'Forbidden. You do not have access to this resource.', status: 403 };
        if (['completed', 'cancelled', 'preparation'].includes(event.status)) {
          return { error: `Cannot request a safety check for a ${event.status} event.`, status: 409 };
        }
        const arrangements = arrangementState(event);
        if (!arrangements.ready) {
          return { error: 'Venue arrangements must be confirmed before an operational safety check.', status: 409, arrangements };
        }
        const existing = event.operationalSafetyCheck;
        if (existing && ['pending', 'approved'].includes(existing.status)) {
          return { error: `Operational safety check is already ${existing.status}.`, status: 409 };
        }
        const details = {
          technicalArrangementsConfirmed: true,
          emergencyAccess: req.body.emergencyAccess.trim(),
          equipmentPlacement: req.body.equipmentPlacement.trim(),
          crowdMovement: req.body.crowdMovement.trim(),
          venueRestrictions: typeof req.body.venueRestrictions === 'string' ? req.body.venueRestrictions.trim() || null : null,
          requestedBy: req.user.id,
          requestedAt: new Date(),
          reviewedBy: null,
          reviewedAt: null,
          decisionReason: null,
          status: 'pending',
        };
        const check = existing
          ? await existing.update(details, { transaction })
          : await OperationalSafetyCheck.create({ eventId: event.id, ...details }, { transaction });
        await event.update({ status: 'awaiting_safety_approval' }, { transaction });
        return { check, event };
      });
      if (result.error) return res.status(result.status).json(result.arrangements ? { error: result.error, arrangements: result.arrangements } : { error: result.error });
      res.status(201).json({ operationalSafetyCheck: result.check, event: result.event });
    } catch (err) { next(err); }
  }
);

router.patch(
  '/events/:eventId/operational-safety-check/decision',
  authenticate,
  authorize(ROLE_NAMES.SAFETY_OFFICER),
  ...eventId,
  body('decision').isIn(['approve', 'reject', 'request_changes']),
  body('reason').optional({ nullable: true }).isString(),
  validateRequest,
  async (req, res, next) => {
    try {
      const result = await sequelize.transaction(async (transaction) => {
        const event = await Event.findByPk(req.params.eventId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!event) return { error: 'Event not found.', status: 404 };
        const check = await OperationalSafetyCheck.findOne({ where: { eventId: event.id }, transaction, lock: transaction.LOCK.UPDATE });
        if (!check) return { error: 'Operational safety check not found.', status: 404 };
        if (check.status !== 'pending') return { error: `Only a pending safety check can be decided (this one is ${check.status}).`, status: 409 };
        const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : null;
        if (['reject', 'request_changes'].includes(req.body.decision) && !reason) {
          return { error: 'reason is required when rejecting or requesting changes.', status: 400 };
        }
        const statusByDecision = { approve: 'approved', reject: 'rejected', request_changes: 'changes_requested' };
        const status = statusByDecision[req.body.decision];
        await check.update({ status, decisionReason: reason, reviewedBy: req.user.id, reviewedAt: new Date() }, { transaction });
        // Customer clarification is pending for rejection: it stays a recorded
        // blocking decision instead of silently cancelling or returning the event.
        await event.update({
          status: status === 'approved'
            ? 'confirmed'
            : status === 'changes_requested'
              ? 'awaiting_arrangements'
              : 'awaiting_safety_approval',
        }, { transaction });
        return { check, event };
      });
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json({ operationalSafetyCheck: result.check, event: result.event });
    } catch (err) { next(err); }
  }
);

router.post(
  '/events/:eventId/proceed-to-preparation',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  ...eventId,
  async (req, res, next) => {
    try {
      const event = await Event.findByPk(req.params.eventId, { include: [{ model: OperationalSafetyCheck, as: 'operationalSafetyCheck' }] });
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      if (!canCoordinate(req, event)) return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
      if (event.operationalSafetyCheck?.status !== 'approved') {
        return res.status(409).json({ error: 'Safety Officer approval is required before preparation can begin.' });
      }
      if (event.status === 'preparation') return res.status(409).json({ error: 'Event is already in preparation.' });
      if (['completed', 'cancelled'].includes(event.status)) return res.status(409).json({ error: `Cannot begin preparation for a ${event.status} event.` });
      await event.update({ status: 'preparation' });
      res.json({ event });
    } catch (err) { next(err); }
  }
);

module.exports = router;
