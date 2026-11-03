const express = require('express');
const { body, param } = require('express-validator');
const { authenticate } = require('../../src/middleware/auth');
const { authorize, ROLE_NAMES } = require('../../src/middleware/rbac');
const { validateRequest } = require('../../src/middleware/validate');
const registrationController = require('../controllers/registrationController');

const router = express.Router();
const attendeeOnly = [authenticate, authorize(ROLE_NAMES.ATTENDEE)];

router.get('/', ...attendeeOnly, registrationController.listRegistrations);
router.get('/events', ...attendeeOnly, registrationController.listRegisterableEvents);
router.post(
  '/',
  ...attendeeOnly,
  body('eventId').isUUID().withMessage('eventId must be a valid UUID.'),
  body('fullName').isString().trim().notEmpty().isLength({ max: 200 }).withMessage('Full Name is required and must be at most 200 characters.'),
  body('workEmail').isEmail().withMessage('Work Email must be a valid email address.').normalizeEmail(),
  body('contactNumber').isString().trim().matches(/^\+?\d{7,15}$/).withMessage('Contact Number must contain 7-15 digits and may start with +.'),
  validateRequest,
  registrationController.createRegistration
);
router.post('/:id/withdraw', ...attendeeOnly, param('id').isUUID().withMessage('id must be a valid UUID.'), validateRequest, registrationController.withdrawRegistration);
router.post('/:id/reconfirm', ...attendeeOnly, param('id').isUUID().withMessage('id must be a valid UUID.'), validateRequest, registrationController.reconfirmRegistration);

module.exports = router;
