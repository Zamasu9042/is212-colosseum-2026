const express = require('express');
const { body, param, query } = require('express-validator');
const { Op } = require('sequelize');
const { sequelize, Event, EventRequest, User, Venue } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');
const { listReservations, getAllocationSummary } = require('../services/equipmentReservationService');
const { notifyEventChange, sendEventChangeEmails } = require('../services/eventChangeNotificationService');

const router = express.Router();

const eventIncludes = [
  { model: EventRequest },
  { model: User, as: 'coordinator', attributes: ['id', 'email', 'firstName', 'lastName'] },
  { model: Venue, attributes: ['id', 'name', 'location'] },
];

const EVENT_UPDATE_FIELDS = ['startDatetime', 'endDatetime', 'venueId', 'status'];
const EVENT_STATUSES = ['planning', 'awaiting_arrangements', 'awaiting_safety_approval', 'confirmed', 'preparation', 'completed', 'cancelled'];

function eventSnapshot(event) {
  return {
    startDatetime: event.startDatetime,
    endDatetime: event.endDatetime,
    venueId: event.venueId,
    venueName: event.Venue?.name,
    status: event.status,
  };
}

function pickEventUpdate(body) {
  return EVENT_UPDATE_FIELDS.reduce((update, field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) update[field] = body[field];
    return update;
  }, {});
}

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

// Coordinator-owned operational update. Any schedule, venue, or lifecycle
// change is fanned out to every active attendee registration immediately.
router.patch(
  '/events/:id',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  param('id').isUUID(),
  body('startDatetime').optional().isISO8601(),
  body('endDatetime').optional().isISO8601(),
  body('venueId').optional({ nullable: true }).isUUID(),
  body('status').optional().isIn(EVENT_STATUSES),
  validateRequest,
  async (req, res, next) => {
    try {
      const updates = pickEventUpdate(req.body);
      if (!Object.keys(updates).length) {
        return res.status(400).json({ error: 'Provide at least one of: startDatetime, endDatetime, venueId, status.' });
      }
      const result = await sequelize.transaction(async (transaction) => {
        // Lock only the event row. PostgreSQL cannot apply FOR UPDATE to the
        // nullable side of the optional context joins used for notifications.
        const event = await Event.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!event) return { error: 'Event not found.', status: 404 };
        if (event.coordinatorId !== req.user.id) {
          return { error: 'Forbidden. You do not have access to this resource.', status: 403 };
        }
        if (['completed', 'cancelled'].includes(event.status)) {
          return { error: `A ${event.status} event cannot be modified.`, status: 409 };
        }
        if (updates.status === 'completed') {
          return { error: 'Use the completion workflow to complete an event.', status: 409 };
        }
        if (updates.status === 'cancelled') updates.cancelledAt = new Date();
        const start = new Date(updates.startDatetime || event.startDatetime);
        const end = new Date(updates.endDatetime || event.endDatetime);
        if (end <= start) return { error: 'endDatetime must be after startDatetime.', status: 400 };
        if (Object.prototype.hasOwnProperty.call(updates, 'venueId') && updates.venueId !== null) {
          const venue = await Venue.findByPk(updates.venueId, { transaction });
          if (!venue) return { error: 'Venue not found.', status: 404 };
        }
        await event.reload({ include: eventIncludes, transaction });
        const before = eventSnapshot(event);
        await event.update(updates, { transaction });
        await event.reload({ include: eventIncludes, transaction });
        const eventName = event.EventRequest?.eventName || 'Your event';
        const notification = await notifyEventChange({ event, before, eventName, transaction });
        return { event, notification, eventName };
      });
      if (result.error) return res.status(result.status).json({ error: result.error });

      // Delivery happens only after the event + in-app notification commit.
      // SMTP failures must never roll back a valid event modification.
      const emailDelivery = await sendEventChangeEmails({
        eventName: result.eventName,
        changes: result.notification.changes,
        emailRecipients: result.notification.emailRecipients || [],
      });
      const emailFailures = emailDelivery.filter((delivery) => delivery.status === 'rejected').length;
      res.json({
        event: result.event,
        changes: result.notification.changes,
        recipients: result.notification.recipients || 0,
        email: { attempted: (result.notification.emailRecipients || []).length, failed: emailFailures },
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
