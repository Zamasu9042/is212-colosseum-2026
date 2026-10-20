const express = require('express');
const { Equipment } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');

const router = express.Router();

// Coordinators, Technical Support Staff, and Safety Officers can view the
// equipment catalogue to plan work or assess event safety information.
router.get(
  '/',
  authenticate,
  authorize(
    ROLE_NAMES.EVENT_COORDINATOR,
    ROLE_NAMES.TECHNICAL_SUPPORT_STAFF,
    ROLE_NAMES.SAFETY_OFFICER
  ),
  async (req, res, next) => {
    try {
      const equipment = await Equipment.findAll();
      res.json({ equipment });
    } catch (err) {
      next(err);
    }
  }
);

// Only Technical Support Staff maintain the equipment catalogue itself.
router.post(
  '/',
  authenticate,
  authorize(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF),
  async (req, res, next) => {
    try {
      const item = await Equipment.create(req.body);
      res.status(201).json({ equipment: item });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:id',
  authenticate,
  authorize(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF),
  async (req, res, next) => {
    try {
      const item = await Equipment.findByPk(req.params.id);
      if (!item) return res.status(404).json({ error: 'Equipment not found.' });
      await item.update(req.body);
      res.json({ equipment: item });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
