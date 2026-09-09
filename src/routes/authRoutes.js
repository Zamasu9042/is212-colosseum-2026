const express = require('express');
const { body } = require('express-validator');
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { validateRequest } = require('../middleware/validate');

const router = express.Router();

router.post(
  '/register',
  [
    body('email').isEmail().withMessage('A valid email is required.'),
    body('password').isString().notEmpty(),
    body('firstName').isString().notEmpty(),
    body('lastName').isString().notEmpty(),
    body('role').isString().notEmpty(),
  ],
  validateRequest,
  authController.register
);

router.post(
  '/login',
  [body('email').isEmail(), body('password').isString().notEmpty()],
  validateRequest,
  authController.login
);

router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

// Requires an authenticated account (demonstrates account enforcement).
router.get('/me', authenticate, authController.me);

module.exports = router;
