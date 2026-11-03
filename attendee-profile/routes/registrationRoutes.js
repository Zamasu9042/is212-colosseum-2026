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
router.post('/', ...attendeeOnly, body('eventId').isUUID().withMessage('eventId must be a valid UUID.'), validateRequest, registrationController.createRegistration);
router.post('/:id/withdraw', ...attendeeOnly, param('id').isUUID().withMessage('id must be a valid UUID.'), validateRequest, registrationController.withdrawRegistration);
router.post('/:id/reconfirm', ...attendeeOnly, param('id').isUUID().withMessage('id must be a valid UUID.'), validateRequest, registrationController.reconfirmRegistration);

module.exports = router;
