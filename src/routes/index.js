const express = require('express');
const authRoutes = require('./authRoutes');
const venueRoutes = require('./venueRoutes');
const venueScheduleRoutes = require('./venueScheduleRoutes');
const equipmentRoutes = require('./equipmentRoutes');
const eventRequestRoutes = require('./eventRequestRoutes');
const { attendeeRoutes } = require('../../attendee-profile');
const eventProgrammeRoutes = require('./eventProgrammeRoutes');

const router = express.Router();

router.use('/auth', authRoutes);
// Schedule routes first: POST /venues/conflicts must not be shadowed by
// anything generic in venueRoutes.
router.use('/venues', venueScheduleRoutes);
router.use('/venues', venueRoutes);
router.use('/equipment', equipmentRoutes);
router.use('/event-requests', eventRequestRoutes);
router.use('/attendees', attendeeRoutes);
// eventProgrammeRoutes defines its own full paths (e.g. '/events/:eventId/programme'),
// so it's mounted at root rather than under a fixed prefix like the others.
router.use('/', eventProgrammeRoutes);

module.exports = router;