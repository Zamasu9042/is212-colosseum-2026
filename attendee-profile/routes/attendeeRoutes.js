const express = require('express');
const { authenticate } = require('../../src/middleware/auth');
const { authorize, ROLE_NAMES } = require('../../src/middleware/rbac');
const { validateRequest } = require('../../src/middleware/validate');

const attendeeController = require('../controllers/attendeeController');
const registrationRoutes = require('./registrationRoutes');
const {
  validateProfileUpdate,
  validatePreferencesUpdate,
} = require('../validators/attendeeValidator');

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

router.use('/registrations', registrationRoutes);

router.get(
  '/preferences',
  authenticate,
  authorize(ROLE_NAMES.ATTENDEE),
  attendeeController.getPreferences
);

router.patch(
  '/preferences',
  authenticate,
  authorize(ROLE_NAMES.ATTENDEE),
  validatePreferencesUpdate,
  validateRequest,
  attendeeController.updatePreferences
);

module.exports = router;
