const express = require('express');
const authRoutes = require('./authRoutes');
const venueRoutes = require('./venueRoutes');
const equipmentRoutes = require('./equipmentRoutes');
const eventRequestRoutes = require('./eventRequestRoutes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/venues', venueRoutes);
router.use('/equipment', equipmentRoutes);
router.use('/event-requests', eventRequestRoutes);

module.exports = router;
