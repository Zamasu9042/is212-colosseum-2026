// Shared helper for determining whether a venue is available, either in
// general (its own status) or for a specific proposed date/time window
// (its status AND no conflicting booking, once setup/teardown turnaround
// time is taken into account).
//
// Kept separate from the route handlers so the conflict-detection logic
// has a single definition and can be unit tested without spinning up the
// whole HTTP stack.

// Event statuses that still hold a real claim on a venue. A cancelled
// event should NOT continue to occupy the venue (matches the customer
// briefing's "Cancelled events may continue to occupy venue ... reservations"
// pain point) — this is deliberately excluded here.
const BLOCKING_EVENT_STATUSES = ['planning', 'awaiting_arrangements', 'confirmed', 'completed'];

/**
 * A venue's real occupied window is wider than its published start/end —
 * it also needs `setupMinutes` beforehand and `teardownMinutes` after.
 */
function getOccupiedWindow(event, venue) {
  const setupMs = (venue.setupMinutes ?? 0) * 60 * 1000;
  const teardownMs = (venue.teardownMinutes ?? 0) * 60 * 1000;
  return {
    start: new Date(new Date(event.startDatetime).getTime() - setupMs),
    end: new Date(new Date(event.endDatetime).getTime() + teardownMs),
  };
}

/** Do two [start, end) windows overlap at all? */
function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * True if `event` (for this venue) conflicts with the proposed
 * [queryStart, queryEnd) window, once the venue's own setup/teardown
 * buffer is applied to the event's occupied time.
 */
function eventConflictsWithWindow(event, venue, queryStart, queryEnd) {
  if (!BLOCKING_EVENT_STATUSES.includes(event.status)) return false;
  const occupied = getOccupiedWindow(event, venue);
  return windowsOverlap(occupied.start, occupied.end, queryStart, queryEnd);
}

/**
 * Determines whether `venue` is available.
 *
 * - With no requested window (queryStart/queryEnd undefined), this is
 *   just the venue's own operational status.
 * - With a requested window, it additionally checks `events` (every
 *   Event row for this venue, any status) for a conflicting booking.
 *
 * Returns { isAvailable, conflictingEvents } so callers can both filter
 * and display *why* a venue was excluded, if useful.
 */
function computeAvailability(venue, events, queryStart, queryEnd) {
  if (venue.status !== 'available') {
    return { isAvailable: false, conflictingEvents: [] };
  }

  if (!queryStart || !queryEnd) {
    return { isAvailable: true, conflictingEvents: [] };
  }

  const conflictingEvents = (events || []).filter((event) =>
    eventConflictsWithWindow(event, venue, queryStart, queryEnd)
  );

  return { isAvailable: conflictingEvents.length === 0, conflictingEvents };
}

module.exports = {
  BLOCKING_EVENT_STATUSES,
  getOccupiedWindow,
  windowsOverlap,
  eventConflictsWithWindow,
  computeAvailability,
};
