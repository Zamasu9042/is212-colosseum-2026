// Venue Schedule Conflict Identification — pure rules, no DB access.
//
// A proposed booking for a venue conflicts with anything that occupies the
// same venue during the proposed booking's EFFECTIVE occupied period:
//
//   effective period = [start - venue.setupMinutes, end + venue.teardownMinutes)
//
// The buffers apply to BOTH sides of the comparison: a new booking needs its
// own setup/turnaround time just as much as an existing one does. Two
// back-to-back events in a venue with 30 min setup + 30 min teardown
// therefore need a 60 min gap between the published end of one and the
// published start of the next.
//
// Things that can occupy a venue:
//   - booking        : an Event in a blocking status (not cancelled)
//   - tentative_hold : a VenueHold that is still active (see isHoldActive)
//   - unavailability : a VenueUnavailability period (maintenance etc.)
//   - venue_status   : the venue itself is marked maintenance/blocked
//
// Bookings and holds are buffered with the venue's setup/teardown (they
// represent events). Unavailability periods are NOT buffered — they are
// already the exact window the venue is out of action — but the proposed
// booking's own buffers must still not run into them.
//
// Every venue is evaluated independently: only records whose venueId matches
// the venue being checked are considered (AC — Multiple venues).

const BLOCKING_EVENT_STATUSES = ['planning', 'awaiting_arrangements', 'confirmed', 'completed'];

const CONFLICT_TYPES = Object.freeze({
  BOOKING: 'booking',
  TENTATIVE_HOLD: 'tentative_hold',
  UNAVAILABILITY: 'unavailability',
  VENUE_STATUS: 'venue_status',
});

const MINUTE_MS = 60 * 1000;

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

/** Half-open [start, end) overlap: touching windows do NOT conflict. */
function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  return toDate(aStart) < toDate(bEnd) && toDate(aEnd) > toDate(bStart);
}

/** The window a venue is actually occupied for an event, including buffers. */
function getEffectiveWindow(start, end, venue) {
  const setupMs = (venue?.setupMinutes ?? 0) * MINUTE_MS;
  const teardownMs = (venue?.teardownMinutes ?? 0) * MINUTE_MS;
  return {
    start: new Date(toDate(start).getTime() - setupMs),
    end: new Date(toDate(end).getTime() + teardownMs),
  };
}

/** A hold blocks the venue only while status is 'active' and it has not expired. */
function isHoldActive(hold, now = new Date()) {
  if (hold.status !== 'active') return false;
  if (hold.expiresAt == null) return true;
  return toDate(hold.expiresAt) > toDate(now);
}

function belongsToVenue(record, venue) {
  // Records without a venueId are assumed pre-filtered by the caller.
  return record.venueId == null || record.venueId === venue.id;
}

/**
 * Identifies every schedule conflict for ONE venue and a proposed
 * [start, end) booking.
 *
 * @param {object}  args
 * @param {object}  args.venue            { id, status, setupMinutes, teardownMinutes }
 * @param {Date|string} args.start        proposed published start
 * @param {Date|string} args.end          proposed published end
 * @param {Array}   [args.events]         Event rows for this venue
 * @param {Array}   [args.holds]          VenueHold rows for this venue
 * @param {Array}   [args.unavailability] VenueUnavailability rows for this venue
 * @param {string}  [args.excludeEventId] ignore this event and its own holds
 *                                        (re-checking an existing event)
 * @param {string}  [args.excludeHoldId]  ignore this hold (e.g. converting it)
 * @param {boolean} [args.ignoreVenueStatus] skip the venue_status check
 * @param {Date}    [args.now]            clock used for hold expiry
 * @returns {{ venueId, effectiveWindow, hasConflict, conflicts: Array }}
 */
function findVenueConflicts({
  venue,
  start,
  end,
  events = [],
  holds = [],
  unavailability = [],
  excludeEventId,
  excludeHoldId,
  ignoreVenueStatus = false,
  now = new Date(),
}) {
  const effective = getEffectiveWindow(start, end, venue);
  const conflicts = [];

  if (!ignoreVenueStatus && venue.status && venue.status !== 'available') {
    conflicts.push({
      type: CONFLICT_TYPES.VENUE_STATUS,
      venueStatus: venue.status,
      reason: `Venue is currently marked as "${venue.status}".`,
    });
  }

  for (const event of events) {
    if (!belongsToVenue(event, venue)) continue;
    if (excludeEventId && event.id === excludeEventId) continue;
    if (!BLOCKING_EVENT_STATUSES.includes(event.status)) continue;

    const occupied = getEffectiveWindow(event.startDatetime, event.endDatetime, venue);
    if (windowsOverlap(effective.start, effective.end, occupied.start, occupied.end)) {
      conflicts.push({
        type: CONFLICT_TYPES.BOOKING,
        id: event.id,
        eventId: event.id,
        status: event.status,
        start: toDate(event.startDatetime),
        end: toDate(event.endDatetime),
        effectiveStart: occupied.start,
        effectiveEnd: occupied.end,
      });
    }
  }

  for (const hold of holds) {
    if (!belongsToVenue(hold, venue)) continue;
    if (excludeHoldId && hold.id === excludeHoldId) continue;
    if (excludeEventId && hold.eventId === excludeEventId) continue;
    if (!isHoldActive(hold, now)) continue;

    const occupied = getEffectiveWindow(hold.startDatetime, hold.endDatetime, venue);
    if (windowsOverlap(effective.start, effective.end, occupied.start, occupied.end)) {
      conflicts.push({
        type: CONFLICT_TYPES.TENTATIVE_HOLD,
        id: hold.id,
        eventId: hold.eventId ?? null,
        status: hold.status,
        start: toDate(hold.startDatetime),
        end: toDate(hold.endDatetime),
        effectiveStart: occupied.start,
        effectiveEnd: occupied.end,
        expiresAt: hold.expiresAt ? toDate(hold.expiresAt) : null,
      });
    }
  }

  for (const period of unavailability) {
    if (!belongsToVenue(period, venue)) continue;
    if (windowsOverlap(effective.start, effective.end, period.startDatetime, period.endDatetime)) {
      conflicts.push({
        type: CONFLICT_TYPES.UNAVAILABILITY,
        id: period.id,
        start: toDate(period.startDatetime),
        end: toDate(period.endDatetime),
        reason: period.reason,
      });
    }
  }

  return {
    venueId: venue.id,
    effectiveWindow: effective,
    hasConflict: conflicts.length > 0,
    conflicts,
  };
}

/**
 * Runs findVenueConflicts for every requested venue independently.
 * `records` holds Event / VenueHold / VenueUnavailability rows for ANY of
 * the venues — they are partitioned by venueId here, so a booking in
 * venue A can never be reported against venue B.
 */
function findConflictsForVenues({
  venues,
  start,
  end,
  events = [],
  holds = [],
  unavailability = [],
  ...options
}) {
  const byVenue = (rows, venueId) => rows.filter((row) => row.venueId === venueId);

  const results = venues.map((venue) =>
    findVenueConflicts({
      venue,
      start,
      end,
      events: byVenue(events, venue.id),
      holds: byVenue(holds, venue.id),
      unavailability: byVenue(unavailability, venue.id),
      ...options,
    })
  );

  return { hasConflicts: results.some((r) => r.hasConflict), venues: results };
}

/**
 * The reverse question, asked when Venue Staff record a new unavailability
 * period: which existing bookings / active holds does it run into? The
 * period itself is not buffered; the bookings' effective windows are.
 */
function findAffectedByUnavailability({ venue, start, end, events = [], holds = [], now = new Date() }) {
  const unavailabilityAsRecord = [{ venueId: venue.id, startDatetime: start, endDatetime: end }];
  const affected = [];

  for (const event of events) {
    const { hasConflict } = findVenueConflicts({
      venue,
      ignoreVenueStatus: true,
      start: event.startDatetime,
      end: event.endDatetime,
      unavailability: unavailabilityAsRecord,
    });
    if (belongsToVenue(event, venue) && BLOCKING_EVENT_STATUSES.includes(event.status) && hasConflict) {
      affected.push({ type: CONFLICT_TYPES.BOOKING, id: event.id, eventId: event.id, status: event.status });
    }
  }

  for (const hold of holds) {
    const { hasConflict } = findVenueConflicts({
      venue,
      ignoreVenueStatus: true,
      start: hold.startDatetime,
      end: hold.endDatetime,
      unavailability: unavailabilityAsRecord,
    });
    if (belongsToVenue(hold, venue) && isHoldActive(hold, now) && hasConflict) {
      affected.push({
        type: CONFLICT_TYPES.TENTATIVE_HOLD,
        id: hold.id,
        eventId: hold.eventId ?? null,
        status: hold.status,
      });
    }
  }

  return affected;
}

module.exports = {
  findAffectedByUnavailability,
  BLOCKING_EVENT_STATUSES,
  CONFLICT_TYPES,
  windowsOverlap,
  getEffectiveWindow,
  isHoldActive,
  findVenueConflicts,
  findConflictsForVenues,
};
