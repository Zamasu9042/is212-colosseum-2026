const express = require('express');
const authRoutes = require('./authRoutes');
const venueRoutes = require('./venueRoutes');
const equipmentRoutes = require('./equipmentRoutes');
const eventRequestRoutes = require('./eventRequestRoutes');
const eventProgrammeRoutes = require('./eventProgrammeRoutes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/venues', venueRoutes);
router.use('/equipment', equipmentRoutes);
router.use('/event-requests', eventRequestRoutes);
// eventProgrammeRoutes defines its own full paths (e.g. '/events/:eventId/programme'),
// so it's mounted at root rather than under a fixed prefix like the others.
router.use('/', eventProgrammeRoutes);

module.exports = router;