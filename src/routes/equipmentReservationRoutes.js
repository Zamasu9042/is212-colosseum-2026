/**
 * Equipment reservations, event equipment requests and technical readiness.
 *
 *   SCRUM-21  Reserve Equipment for an Event
 *   SCRUM-22  Manage Equipment Catalogue Status (reservation blocking)
 *   SCRUM-24  Reserve Equipment for Approved Event Window
 *
 * Mounted at the API root because the paths span /events/... and
 * /equipment-reservations/... (same pattern as venueBookingRoutes).
 */
const express = require('express');
const { body, param, query } = require('express-validator');
const { Event, EventEquipmentRequest, EquipmentReservation, Equipment } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');
const {
  EquipmentReservationError,
  reserveEquipment,
  cancelReservation,
  listReservations,
  serializeReservation,
  getAllocationSummary,
  markTechnicalReadiness,
} = require('../services/equipmentReservationService');

const router = express.Router();

const EVENT_READERS = [
  ROLE_NAMES.TECHNICAL_SUPPORT_STAFF,
  ROLE_NAMES.EVENT_COORDINATOR,
  ROLE_NAMES.EVENT_COORDINATOR_LEAD,
  ROLE_NAMES.SAFETY_OFFICER,
];

function handleError(err, res, next) {
  if (err instanceof EquipmentReservationError) {
    return res.status(err.status).json({ error: err.message, ...err.extra });
  }
  return next(err);
}

/**
 * Loads req.params.eventId into req.event. An Event Coordinator may only
 * act on events they coordinate; other allowed roles see every event.
 */
async function loadEvent(req, res, next) {
  try {
    const event = await Event.findByPk(req.params.eventId);
    if (!event) return res.status(404).json({ error: 'Event not found.' });
    if (req.user.role === ROLE_NAMES.EVENT_COORDINATOR && event.coordinatorId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
    }
    req.event = event;
    return next();
  } catch (err) {
    return next(err);
  }
}

const eventIdParam = [param('eventId').isUUID(), validateRequest];

// --- Reservations ----------------------------------------------------

// SCRUM-21 AC4: reservations on the event detail page.
router.get(
  '/events/:eventId/equipment-reservations',
  authenticate,
  authorize(...EVENT_READERS),
  ...eventIdParam,
  loadEvent,
  async (req, res, next) => {
    try {
      const reservations = await listReservations({ eventId: req.event.id });
      res.json({
        reservations,
        activeReservations: reservations.filter((r) => r.status === 'active'),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/events/:eventId/equipment-reservations  (Technical Support Staff)
 * Body: { equipmentId, quantity?=1, startDatetime?, endDatetime?, equipmentRequestId? }
 * Window defaults to the event's own start/end.
 */
router.post(
  '/events/:eventId/equipment-reservations',
  authenticate,
  authorize(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF),
  param('eventId').isUUID(),
  body('equipmentId').isUUID().withMessage('equipmentId must be a valid id.'),
  body('quantity').optional().isInt({ min: 1 }).withMessage('quantity must be at least 1.'),
  body('startDatetime').optional({ nullable: true }).isISO8601(),
  body('endDatetime').optional({ nullable: true }).isISO8601(),
  body('equipmentRequestId').optional({ nullable: true }).isUUID(),
  validateRequest,
  async (req, res, next) => {
    try {
      const reservation = await reserveEquipment({
        eventId: req.params.eventId,
        equipmentId: req.body.equipmentId,
        quantity: req.body.quantity === undefined ? 1 : Number(req.body.quantity),
        startDatetime: req.body.startDatetime,
        endDatetime: req.body.endDatetime,
        equipmentRequestId: req.body.equipmentRequestId,
        user: req.user,
      });
      const equipment = await Equipment.findByPk(reservation.equipmentId);
      res.status(201).json({ reservation: serializeReservation(reservation), equipment });
    } catch (err) {
      handleError(err, res, next);
    }
  }
);

// Cross-event list for Technical Support Staff / Leads.
router.get(
  '/equipment-reservations',
  authenticate,
  authorize(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF, ROLE_NAMES.EVENT_COORDINATOR_LEAD),
  query('equipmentId').optional().isUUID(),
  query('eventId').optional().isUUID(),
  query('status').optional().isIn(['active', 'cancelled']),
  validateRequest,
  async (req, res, next) => {
    try {
      const where = {};
      for (const k of ['equipmentId', 'eventId', 'status']) if (req.query[k]) where[k] = req.query[k];
      const reservations = await listReservations(where);
      res.json({ reservations, count: reservations.length });
    } catch (err) {
      next(err);
    }
  }
);

// SCRUM-21 AC5: cancel; equipment reverts to available if nothing else holds it.
router.post(
  '/equipment-reservations/:id/cancel',
  authenticate,
  authorize(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF),
  param('id').isUUID(),
  body('reason').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  validateRequest,
  async (req, res, next) => {
    try {
      const { reservation, equipment, readinessReverted } = await cancelReservation(req.params.id, {
        user: req.user,
        reason: req.body.reason,
      });
      res.json({ reservation: serializeReservation(reservation), equipment, readinessReverted });
    } catch (err) {
      handleError(err, res, next);
    }
  }
);

// --- Equipment requests (SCRUM-24) -----------------------------------

async function requestsWithAllocation(eventId) {
  const [requests, summary] = await Promise.all([
    EventEquipmentRequest.findAll({
      where: { eventId },
      include: [{ model: Equipment, attributes: ['id', 'name', 'type', 'status'] }],
      order: [['created_at', 'ASC']],
    }),
    getAllocationSummary(eventId),
  ]);
  const byId = new Map(summary.lines.map((l) => [l.equipmentRequestId, l]));
  return {
    equipmentRequests: requests.map((r) => ({ ...r.toJSON(), allocation: byId.get(r.id) })),
    allocation: summary,
  };
}

router.get(
  '/events/:eventId/equipment-requests',
  authenticate,
  authorize(...EVENT_READERS),
  ...eventIdParam,
  loadEvent,
  async (req, res, next) => {
    try {
      res.json(await requestsWithAllocation(req.event.id));
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/events/:eventId/equipment-requests
 * Body: { equipmentType, quantityRequested, equipmentId?, technicalRequirements? }
 * The event's Coordinator records needs; Technical Support Staff may too.
 */
router.post(
  '/events/:eventId/equipment-requests',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR, ROLE_NAMES.TECHNICAL_SUPPORT_STAFF),
  param('eventId').isUUID(),
  body('equipmentType').optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
  body('equipmentId').optional({ nullable: true }).isUUID(),
  body('quantityRequested').isInt({ min: 1 }).withMessage('quantityRequested must be at least 1.'),
  body('technicalRequirements').optional({ nullable: true }).isString(),
  validateRequest,
  loadEvent,
  async (req, res, next) => {
    try {
      let { equipmentType } = req.body;
      if (req.body.equipmentId) {
        const item = await Equipment.findByPk(req.body.equipmentId);
        if (!item) return res.status(422).json({ error: 'equipmentId does not match any equipment.' });
        equipmentType = equipmentType || item.type;
      }
      if (!equipmentType) {
        return res.status(400).json({ error: 'equipmentType (or equipmentId) is required.' });
      }
      const line = await EventEquipmentRequest.create({
        eventId: req.event.id,
        equipmentType,
        equipmentId: req.body.equipmentId || null,
        quantityRequested: Number(req.body.quantityRequested),
        technicalRequirements: req.body.technicalRequirements || null,
        requestedBy: req.user.id,
      });
      // A new unmet need means readiness can no longer be complete.
      if (req.event.technicalReadiness === 'complete') {
        await req.event.update({ technicalReadiness: 'pending', technicalReadinessAt: null, technicalReadinessBy: null });
      }
      res.status(201).json({ equipmentRequest: line, ...(await requestsWithAllocation(req.event.id)) });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/events/:eventId/equipment-requests/:requestId',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR, ROLE_NAMES.TECHNICAL_SUPPORT_STAFF),
  param('eventId').isUUID(),
  param('requestId').isUUID(),
  validateRequest,
  loadEvent,
  async (req, res, next) => {
    try {
      const line = await EventEquipmentRequest.findOne({
        where: { id: req.params.requestId, eventId: req.event.id },
      });
      if (!line) return res.status(404).json({ error: 'Equipment request not found.' });
      const active = await EquipmentReservation.count({ where: { equipmentRequestId: line.id, status: 'active' } });
      if (active) {
        return res.status(409).json({ error: 'Cancel the reservations allocated to this request line first.' });
      }
      await line.destroy();
      res.json(await requestsWithAllocation(req.event.id));
    } catch (err) {
      next(err);
    }
  }
);

// --- Technical readiness (SCRUM-24 AC3) --------------------------------

router.get(
  '/events/:eventId/technical-readiness',
  authenticate,
  authorize(...EVENT_READERS),
  ...eventIdParam,
  loadEvent,
  async (req, res, next) => {
    try {
      const allocation = await getAllocationSummary(req.event.id);
      res.json({
        technicalReadiness: req.event.technicalReadiness,
        technicalReadinessAt: req.event.technicalReadinessAt,
        canComplete: allocation.fullyAllocated,
        allocation,
      });
    } catch (err) {
      next(err);
    }
  }
);

/** PATCH /api/events/:eventId/technical-readiness  Body: { complete: boolean } */
router.patch(
  '/events/:eventId/technical-readiness',
  authenticate,
  authorize(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF),
  param('eventId').isUUID(),
  body('complete').isBoolean().withMessage('complete must be true or false.'),
  validateRequest,
  async (req, res, next) => {
    try {
      const complete = req.body.complete === true || req.body.complete === 'true';
      const { event, summary } = await markTechnicalReadiness(req.params.eventId, { user: req.user, complete });
      res.json({
        technicalReadiness: event.technicalReadiness,
        technicalReadinessAt: event.technicalReadinessAt,
        allocation: summary,
      });
    } catch (err) {
      handleError(err, res, next);
    }
  }
);

module.exports = router;
