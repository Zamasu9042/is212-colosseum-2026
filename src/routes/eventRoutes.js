const express = require('express');
const { param, query } = require('express-validator');
const { Op } = require('sequelize');
const { Event, EventRequest, User, Venue } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');
const { listReservations, getAllocationSummary } = require('../services/equipmentReservationService');

const router = express.Router();

const eventIncludes = [
  { model: EventRequest },
  { model: User, as: 'coordinator', attributes: ['id', 'email', 'firstName', 'lastName'] },
];

// Shared oversight view for every Event Coordinator Lead. "Active" excludes
// only events that are complete or cancelled; Leads do not own or claim them.
router.get(
  '/events/active',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR_LEAD),
  async (req, res, next) => {
    try {
      const events = await Event.findAll({
        where: { status: { [Op.notIn]: ['completed', 'cancelled'] } },
        include: eventIncludes,
        order: [['start_datetime', 'ASC']],
      });
      res.json({ events, count: events.length });
    } catch (err) {
      next(err);
    }
  }
);

// Event list for internal staff. Technical Support Staff need it to pick an
// event to reserve equipment for (SCRUM-21). Coordinators see only events
// they coordinate. ?status= is a comma-separated filter.
router.get(
  '/events',
  authenticate,
  authorize(
    ROLE_NAMES.TECHNICAL_SUPPORT_STAFF,
    ROLE_NAMES.EVENT_COORDINATOR,
    ROLE_NAMES.EVENT_COORDINATOR_LEAD,
    ROLE_NAMES.SAFETY_OFFICER,
    ROLE_NAMES.VENUE_STAFF
  ),
  query('status').optional().isString(),
  validateRequest,
  async (req, res, next) => {
    try {
      const where = {};
      if (req.query.status) where.status = { [Op.in]: String(req.query.status).split(',').map((s) => s.trim()) };
      if (req.user.role === ROLE_NAMES.EVENT_COORDINATOR) where.coordinatorId = req.user.id;
      const events = await Event.findAll({
        where,
        include: [...eventIncludes, { model: Venue, attributes: ['id', 'name', 'location'] }],
        order: [['start_datetime', 'ASC']],
      });
      res.json({ events, count: events.length });
    } catch (err) {
      next(err);
    }
  }
);

// Read-only event context. Safety Officers need this alongside existing
// request, venue-booking, and equipment reads; no safety decision workflow is
// introduced here. An Event Coordinator may only inspect their own event.
// SCRUM-21 AC4: the event detail page also carries its equipment
// reservations, and SCRUM-24 its equipment allocation / readiness.
router.get(
  '/events/:id',
  authenticate,
  authorize(
    ROLE_NAMES.EVENT_COORDINATOR_LEAD,
    ROLE_NAMES.SAFETY_OFFICER,
    ROLE_NAMES.EVENT_COORDINATOR,
    ROLE_NAMES.TECHNICAL_SUPPORT_STAFF
  ),
  param('id').isUUID(),
  validateRequest,
  async (req, res, next) => {
    try {
      const event = await Event.findByPk(req.params.id, {
        include: [...eventIncludes, { model: Venue, attributes: ['id', 'name', 'location'] }],
      });
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      if (
        req.user.role === ROLE_NAMES.EVENT_COORDINATOR &&
        event.coordinatorId !== req.user.id
      ) {
        return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
      }
      const [equipmentReservations, equipmentAllocation] = await Promise.all([
        listReservations({ eventId: event.id }),
        getAllocationSummary(event.id),
      ]);
      res.json({ event, equipmentReservations, equipmentAllocation });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
