const express = require('express');
const { Venue } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');

const router = express.Router();

// All authenticated internal + external users may browse the venue
// catalogue (read-only) — matches "Venue Catalogue" being visible to
// Event Coordinators, Venue Staff, and Event Organisers when planning.
router.get('/', authenticate, async (req, res, next) => {
  try {
    const venues = await Venue.findAll();
    res.json({ venues });
  } catch (err) {
    next(err);
  }
});

// Only Venue Staff may create, update, or block/unblock venues.
router.post('/', authenticate, authorize(ROLE_NAMES.VENUE_STAFF), async (req, res, next) => {
  try {
    const venue = await Venue.create(req.body);
    res.status(201).json({ venue });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', authenticate, authorize(ROLE_NAMES.VENUE_STAFF), async (req, res, next) => {
  try {
    const venue = await Venue.findByPk(req.params.id);
    if (!venue) return res.status(404).json({ error: 'Venue not found.' });
    await venue.update(req.body);
    res.json({ venue });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
