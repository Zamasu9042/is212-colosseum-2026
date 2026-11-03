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
const operationalSafetyCheckRoutes = require('./operationalSafetyCheckRoutes');
const equipmentReservationRoutes = require('./equipmentReservationRoutes');
const userRoutes = require('./userRoutes');
const eventPlanningRoutes = require('./eventPlanningRoutes');
const eventChangeRequestRoutes = require('./eventChangeRequestRoutes');
const equipmentRequirementRoutes = require('./equipmentRequirementRoutes');

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
router.use('/', operationalSafetyCheckRoutes);
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
// Event planning: coordinator edits + change log, organiser change requests,
// and equipment requirement edits. All define full paths, so mounted at root.
router.use('/', eventPlanningRoutes);
router.use('/', eventChangeRequestRoutes);
router.use('/', equipmentRequirementRoutes);

module.exports = router;
