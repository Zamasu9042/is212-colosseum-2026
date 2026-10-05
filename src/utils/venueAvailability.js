// Shared helper for determining whether a venue is available, either in
// general (its own status) or for a specific proposed date/time window.
//
// The actual conflict rules (setup/turnaround buffers, tentative holds,
// unavailability periods) live in ./venueConflicts.js so that venue search
// and venue schedule conflict identification share ONE definition of
// "this venue is occupied". This module is a thin adapter kept for the
// search/filter routes.

const {
  BLOCKING_EVENT_STATUSES,
  windowsOverlap,
  getEffectiveWindow,
  findVenueConflicts,
} = require('./venueConflicts');

/**
 * A venue's real occupied window for an event is wider than its published
 * start/end — it also needs `setupMinutes` beforehand and `teardownMinutes`
 * after.
 */
function getOccupiedWindow(event, venue) {
  return getEffectiveWindow(event.startDatetime, event.endDatetime, venue);
}

/**
 * True if `event` (for this venue) conflicts with a proposed booking of
 * [queryStart, queryEnd), once setup/teardown buffers are applied to both
 * the existing event and the proposed booking.
 */
function eventConflictsWithWindow(event, venue, queryStart, queryEnd) {
  return findVenueConflicts({
    venue,
    ignoreVenueStatus: true,
    start: queryStart,
    end: queryEnd,
    events: [event],
  }).hasConflict;
}

/**
 * Determines whether `venue` is available.
 *
 * - With no requested window (queryStart/queryEnd undefined), this is
 *   just the venue's own operational status.
 * - With a requested window, it additionally checks `events`, plus any
 *   `holds` / `unavailability` passed in `extra`, for a conflict.
 *
 * Returns { isAvailable, conflictingEvents, conflicts } — conflictingEvents
 * is kept for backwards compatibility (Event rows only); conflicts is the
 * full typed list from venueConflicts.findVenueConflicts.
 */
function computeAvailability(venue, events, queryStart, queryEnd, extra = {}) {
  if (venue.status !== 'available') {
    return { isAvailable: false, conflictingEvents: [], conflicts: [] };
  }

  if (!queryStart || !queryEnd) {
    return { isAvailable: true, conflictingEvents: [], conflicts: [] };
  }

  const { conflicts } = findVenueConflicts({
    venue,
    start: queryStart,
    end: queryEnd,
    events: events || [],
    holds: extra.holds || [],
    unavailability: extra.unavailability || [],
    now: extra.now,
  });

  const conflictingEvents = (events || []).filter((event) =>
    eventConflictsWithWindow(event, venue, queryStart, queryEnd)
  );

  return { isAvailable: conflicts.length === 0, conflictingEvents, conflicts };
}

module.exports = {
  BLOCKING_EVENT_STATUSES,
  getOccupiedWindow,
  windowsOverlap,
  eventConflictsWithWindow,
  computeAvailability,
};
