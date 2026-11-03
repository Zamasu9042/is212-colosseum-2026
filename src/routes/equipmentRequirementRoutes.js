/**
 * Record Equipment Requirements for an Event — the parts not already
 * covered by equipmentReservationRoutes.js (which has POST/GET/DELETE of
 * an event's equipment request lines):
 *
 *   PATCH /api/events/:eventId/equipment-requests/:requestId   edit a line
 *   GET   /api/equipment-requests                              all lines, for Technical Support Staff
 *
 * A line = equipment type + quantity + technical requirements, tied to
 * one event. Technical Support Staff view lines to assess availability
 * and then reserve equipment against them.
 */
const express = require('express');
const { body, param, query } = require('express-validator');
const { Op } = require('sequelize');
const { Event, EventRequest, EventEquipmentRequest, EquipmentReservation, Equipment } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');
const { getAllocationSummary } = require('../services/equipmentReservationService');

const router = express.Router();

const FORBIDDEN = { error: 'Forbidden. You do not have access to this resource.' };

// ---------------------------------------------------------------------
// PATCH — the event's Coordinator (or Technical Support Staff) edits a line.
// Quantity may not drop below what is already reserved for the line.
// ---------------------------------------------------------------------
router.patch(
  '/events/:eventId/equipment-requests/:requestId',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR, ROLE_NAMES.TECHNICAL_SUPPORT_STAFF),
  param('eventId').isUUID(),
  param('requestId').isUUID(),
  body('equipmentType').optional().isString().trim().isLength({ min: 1, max: 100 })
    .withMessage('equipmentType must be 1-100 characters.'),
  body('equipmentId').optional({ nullable: true }).isUUID(),
  body('quantityRequested').optional().isInt({ min: 1 }).withMessage('quantityRequested must be at least 1.').toInt(),
  body('technicalRequirements').optional({ nullable: true }).isString(),
  validateRequest,
  async (req, res, next) => {
    try {
      const event = await Event.findByPk(req.params.eventId);
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      if (req.user.role === ROLE_NAMES.EVENT_COORDINATOR && event.coordinatorId !== req.user.id) {
        return res.status(403).json(FORBIDDEN);
      }
      if (['completed', 'cancelled'].includes(event.status)) {
        return res.status(409).json({ error: `A ${event.status} event can no longer be changed.` });
      }

      const line = await EventEquipmentRequest.findOne({
        where: { id: req.params.requestId, eventId: event.id },
      });
      if (!line) return res.status(404).json({ error: 'Equipment request not found.' });

      const updates = {};
      for (const f of ['equipmentType', 'quantityRequested', 'technicalRequirements']) {
        if (f in req.body) updates[f] = req.body[f];
      }
      if ('equipmentId' in req.body) {
        if (req.body.equipmentId) {
          const item = await Equipment.findByPk(req.body.equipmentId);
          if (!item) return res.status(422).json({ error: 'equipmentId does not match any equipment.' });
        }
        updates.equipmentId = req.body.equipmentId || null;
      }
      if (!Object.keys(updates).length) {
        return res.status(400).json({ error: 'No editable fields supplied.' });
      }

      if (updates.quantityRequested !== undefined) {
        const reserved = (await EquipmentReservation.sum('quantity', {
          where: { equipmentRequestId: line.id, status: 'active' },
        })) || 0;
        if (updates.quantityRequested < reserved) {
          return res.status(409).json({
            error: `${reserved} unit(s) are already reserved for this line. Cancel reservations before lowering the quantity below that.`,
            reserved,
          });
        }
      }

      await line.update(updates);

      // A changed need means "technically ready" has to be re-confirmed.
      if (event.technicalReadiness === 'complete') {
        await event.update({ technicalReadiness: 'pending', technicalReadinessAt: null, technicalReadinessBy: null });
      }

      const allocation = await getAllocationSummary(event.id);
      res.json({ equipmentRequest: line, allocation });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/equipment-requests — Technical Support Staff worklist across events.
//   ?eventId=<uuid>   one event
//   ?unallocated=true only lines that still need equipment reserved
// ---------------------------------------------------------------------
router.get(
  '/equipment-requests',
  authenticate,
  authorize(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF, ROLE_NAMES.EVENT_COORDINATOR_LEAD),
  query('eventId').optional().isUUID(),
  query('unallocated').optional().isBoolean(),
  validateRequest,
  async (req, res, next) => {
    try {
      const where = {};
      if (req.query.eventId) where.eventId = req.query.eventId;

      const eventWhere = { status: { [Op.notIn]: ['completed', 'cancelled'] } };
      const lines = await EventEquipmentRequest.findAll({
        where,
        include: [
          { model: Equipment, attributes: ['id', 'name', 'type', 'status'] },
          {
            model: Event,
            required: true,
            where: eventWhere,
            attributes: ['id', 'startDatetime', 'endDatetime', 'status', 'coordinatorId'],
            include: [{ model: EventRequest, attributes: ['eventName'] }],
          },
        ],
        order: [[Event, 'start_datetime', 'ASC'], ['created_at', 'ASC']],
      });

      // Allocation per event (one query per distinct event).
      const summaries = new Map();
      for (const eventId of new Set(lines.map((l) => l.eventId))) {
        summaries.set(eventId, await getAllocationSummary(eventId));
      }
      let results = lines.map((l) => {
        const alloc = summaries.get(l.eventId).lines.find((x) => x.equipmentRequestId === l.id);
        return { ...l.toJSON(), allocation: alloc };
      });
      if (req.query.unallocated === 'true') {
        results = results.filter((r) => !r.allocation || r.allocation.shortfall > 0);
      }
      res.json({ equipmentRequests: results, count: results.length });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;