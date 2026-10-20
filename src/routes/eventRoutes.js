const express = require('express');
const { param } = require('express-validator');
const { Op } = require('sequelize');
const { Event, EventRequest, User } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');

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

// Read-only event context. Safety Officers need this alongside existing
// request, venue-booking, and equipment reads; no safety decision workflow is
// introduced here. An Event Coordinator may only inspect their own event.
router.get(
  '/events/:id',
  authenticate,
  authorize(
    ROLE_NAMES.EVENT_COORDINATOR_LEAD,
    ROLE_NAMES.SAFETY_OFFICER,
    ROLE_NAMES.EVENT_COORDINATOR
  ),
  param('id').isUUID(),
  validateRequest,
  async (req, res, next) => {
    try {
      const event = await Event.findByPk(req.params.id, { include: eventIncludes });
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      if (
        req.user.role === ROLE_NAMES.EVENT_COORDINATOR &&
        event.coordinatorId !== req.user.id
      ) {
        return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
      }
      res.json({ event });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
