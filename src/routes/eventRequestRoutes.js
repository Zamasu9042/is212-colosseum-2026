const express = require('express');
const { EventRequest } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, authorizeOwnerOrRoles, ROLE_NAMES } = require('../middleware/rbac');

const router = express.Router();

// Only Event Organisers can create requests (Attendees, staff cannot).
router.post('/', authenticate, authorize(ROLE_NAMES.EVENT_ORGANISER), async (req, res, next) => {
  try {
    const request = await EventRequest.create({ ...req.body, organiserId: req.user.id });
    res.status(201).json({ eventRequest: request });
  } catch (err) {
    next(err);
  }
});

// Event Coordinators can view any request (to review/assign).
// An Event Organiser may only view their OWN request — this enforces
// the briefing's requirement that an Organiser should not see events
// belonging to unrelated clients.
router.get(
  '/:id',
  authenticate,
  authorizeOwnerOrRoles(
    async (req) => {
      const request = await EventRequest.findByPk(req.params.id);
      return !!request && request.organiserId === req.user.id;
    },
    ROLE_NAMES.EVENT_COORDINATOR
  ),
  async (req, res, next) => {
    try {
      const request = await EventRequest.findByPk(req.params.id);
      if (!request) return res.status(404).json({ error: 'Event request not found.' });
      res.json({ eventRequest: request });
    } catch (err) {
      next(err);
    }
  }
);

// Only Event Coordinators can approve/reject/return a submitted request.
router.patch(
  '/:id/status',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  async (req, res, next) => {
    try {
      const { status } = req.body;
      const validStatuses = ['under_review', 'approved', 'rejected', 'returned'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
      }
      const request = await EventRequest.findByPk(req.params.id);
      if (!request) return res.status(404).json({ error: 'Event request not found.' });
      request.status = status;
      await request.save();
      res.json({ eventRequest: request });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
