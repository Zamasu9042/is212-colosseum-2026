const express = require('express');
const { authenticate } = require('../../src/middleware/auth');
const { authorize, ROLE_NAMES } = require('../../src/middleware/rbac');
const { validateRequest } = require('../../src/middleware/validate');

const attendeeController = require('../controllers/attendeeController');
const { validateProfileUpdate } = require('../validators/attendeeValidator');

const router = express.Router();

/**
 * All routes in this module require an authenticated account with the 'attendee' role.
 * Fails closed if accessed by guests (401) or other roles (403).
 */

// Profile maintenance
router.get(
  '/profile',
  authenticate,
  authorize(ROLE_NAMES.ATTENDEE),
  attendeeController.getProfile
);

router.patch(
  '/profile',
  authenticate,
  authorize(ROLE_NAMES.ATTENDEE),
  validateProfileUpdate,
  validateRequest,
  attendeeController.updateProfile
);

module.exports = router;
