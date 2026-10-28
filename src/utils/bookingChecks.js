// Per-venue checks for a venue booking request. Each requested venue goes
// through these on its own (Book Multiple Venues AC3-AC5), so one venue
// failing never affects another booking on the same event.
//
// The schedule rules themselves (setup/teardown buffers, other events,
// live bookings, tentative holds, unavailability periods, venue status)
// live in services/venueConflictService.js. This file adds the
// capacity/suitability check and groups the results into three
// coordinator-friendly categories:
//   suitability  - is the venue big enough for the expected attendance?
//   availability - venue closed, or inside a temporary unavailability period
//   conflict     - clashes with another event, booking or active hold

const { checkVenueConflicts } = require('../services/venueConflictService');
const { CONFLICT_TYPES } = require('./venueConflicts');

const AVAILABILITY_TYPES = [CONFLICT_TYPES.VENUE_STATUS, CONFLICT_TYPES.UNAVAILABILITY];

/**
 * Runs the checks for one proposed booking.
 * @returns {Promise<Array<{check: string, message: string, details?: object[]}>>} empty when OK
 */
async function runBookingChecks({ venue, event, start, end, attendance, excludeBookingId, transaction }) {
  const failures = [];

  if (attendance > venue.capacity) {
    failures.push({
      check: 'suitability',
      message: `${venue.name} holds ${venue.capacity} people but ${attendance} are expected.`,
    });
  }

  // excludeEventId ignores the event's own legacy venue row and its own
  // tentative holds (so a hold can be turned into a booking); the event's
  // other venue bookings still count.
  const result = await checkVenueConflicts({
    venueIds: [venue.id],
    start,
    end,
    excludeEventId: event.id,
    excludeBookingId,
    transaction,
  });
  const conflicts = result.venues[0].conflicts;

  const unavailable = conflicts.filter((c) => AVAILABILITY_TYPES.includes(c.type));
  if (unavailable.length) {
    failures.push({
      check: 'availability',
      message: `${venue.name} is not available during the requested time.`,
      details: unavailable,
    });
  }

  const clashes = conflicts.filter((c) => !AVAILABILITY_TYPES.includes(c.type));
  if (clashes.length) {
    failures.push({
      check: 'conflict',
      message: `${venue.name} is already booked or held during the requested time (setup and teardown time included).`,
      details: clashes,
    });
  }

  return failures;
}

module.exports = { runBookingChecks };