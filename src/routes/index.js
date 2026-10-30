const express = require('express');
const authRoutes = require('./authRoutes');
const venueRoutes = require('./venueRoutes');
const venueScheduleRoutes = require('./venueScheduleRoutes');
const equipmentRoutes = require('./equipmentRoutes');
const eventRequestRoutes = require('./eventRequestRoutes');
const { attendeeRoutes } = require('../../attendee-profile');
const eventProgrammeRoutes = require('./eventProgrammeRoutes');
const venueBookingRoutes = require('./venueBookingRoutes');
const notificationRoutes = require('./notificationRoutes');
const eventRoutes = require('./eventRoutes');
const equipmentReservationRoutes = require('./equipmentReservationRoutes');
const userRoutes = require('./userRoutes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
// Schedule routes first: POST /venues/conflicts must not be shadowed by
// anything generic in venueRoutes.
router.use('/venues', venueScheduleRoutes);
router.use('/venues', venueRoutes);
router.use('/equipment', equipmentRoutes);
router.use('/event-requests', eventRequestRoutes);
router.use('/', eventRoutes);
router.use('/attendees', attendeeRoutes);
// eventProgrammeRoutes defines its own full paths (e.g. '/events/:eventId/programme'),
// so it's mounted at root rather than under a fixed prefix like the others.
router.use('/', eventProgrammeRoutes);
// Venue booking routes define their own full paths (/events/:eventId/venue-bookings,
// /venue-bookings/...), so they are mounted at root like the programme routes.
router.use('/', venueBookingRoutes);
router.use('/notifications', notificationRoutes);
// Equipment reservations / requests / technical readiness (SCRUM-21/22/24)
// use full paths under /events/... and /equipment-reservations/...
router.use('/', equipmentReservationRoutes);

module.exports = router;
