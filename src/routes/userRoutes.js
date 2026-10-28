const express = require('express');
const { query } = require('express-validator');
const { User, Role, ROLE_NAMES } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');

const router = express.Router();

// Staff directory lookup. Event Coordinator Leads need it to choose a
// Coordinator when assigning a request (PATCH /event-requests/:id/assignment
// takes a coordinatorId). Only internal staff roles can be listed, and only
// non-sensitive fields are returned.
const LISTABLE_ROLES = [
  ROLE_NAMES.EVENT_COORDINATOR,
  ROLE_NAMES.TECHNICAL_SUPPORT_STAFF,
  ROLE_NAMES.VENUE_STAFF,
];

router.get(
  '/',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR_LEAD),
  query('role').isIn(LISTABLE_ROLES).withMessage(`role must be one of: ${LISTABLE_ROLES.join(', ')}`),
  validateRequest,
  async (req, res, next) => {
    try {
      const users = await User.findAll({
        where: { isActive: true },
        attributes: ['id', 'email', 'firstName', 'lastName', 'department'],
        include: [{ model: Role, where: { name: req.query.role }, attributes: [] }],
        order: [['first_name', 'ASC'], ['last_name', 'ASC']],
      });
      res.json({ users, count: users.length });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
