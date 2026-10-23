const express = require('express');
const { param, query } = require('express-validator');
const { Notification } = require('../models');
const { authenticate } = require('../middleware/auth');
const { validateRequest } = require('../middleware/validate');

const router = express.Router();

// GET /api/notifications?unread=true — the signed-in user's own notifications.
router.get(
  '/',
  authenticate,
  query('unread').optional().isBoolean(),
  validateRequest,
  async (req, res, next) => {
    try {
      const where = { userId: req.user.id };
      if (req.query.unread === 'true') where.readAt = null;
      const notifications = await Notification.findAll({
        where,
        order: [['created_at', 'DESC']],
      });
      res.json({ notifications, count: notifications.length });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/notifications/:id/read — own notifications only.
router.patch(
  '/:id/read',
  authenticate,
  param('id').isUUID(),
  validateRequest,
  async (req, res, next) => {
    try {
      const notification = await Notification.findOne({
        where: { id: req.params.id, userId: req.user.id },
      });
      if (!notification) return res.status(404).json({ error: 'Notification not found.' });
      await notification.update({ readAt: new Date() });
      res.json({ notification });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;