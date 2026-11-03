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
  isHoldActive,
} = require('./venueConflicts');

// These are API display states, rather than new database states.  Keeping the
// mapping here lets the calendar use the existing Event lifecycle without
// changing or invalidating records in a deployed database.
const AVAILABILITY_STATES = {
  AVAILABLE: 'available',
  TENTATIVE_HOLD: 'tentative_hold',
  CONFIRMED_BOOKING: 'confirmed_booking',
  TEMPORARILY_UNAVAILABLE: 'temporarily_unavailable',
  EXPIRED_HOLD: 'expired_hold',
};

const DISPLAY_STATE_LABELS = {
  [AVAILABILITY_STATES.AVAILABLE]: 'Available',
  [AVAILABILITY_STATES.TENTATIVE_HOLD]: 'Tentative Hold',
  [AVAILABILITY_STATES.CONFIRMED_BOOKING]: 'Confirmed Booking',
  [AVAILABILITY_STATES.TEMPORARILY_UNAVAILABLE]: 'Temporarily Unavailable',
  [AVAILABILITY_STATES.EXPIRED_HOLD]: 'Expired Hold',
};

function eventAvailabilityState(event) {
  if (['planning', 'awaiting_arrangements'].includes(event.status)) {
    return AVAILABILITY_STATES.TENTATIVE_HOLD;
  }
  if (['confirmed', 'completed'].includes(event.status)) {
    return AVAILABILITY_STATES.CONFIRMED_BOOKING;
  }
  if (event.status === 'cancelled') return AVAILABILITY_STATES.EXPIRED_HOLD;
  return null;
}

function findReservationConflicts(venue, events) {
  const reservations = (events || [])
    .filter((event) => [AVAILABILITY_STATES.TENTATIVE_HOLD, AVAILABILITY_STATES.CONFIRMED_BOOKING].includes(eventAvailabilityState(event)))
    .map((event) => ({ event, occupied: getOccupiedWindow(event, venue) }));
  const conflicts = [];

  for (let left = 0; left < reservations.length; left += 1) {
    for (let right = left + 1; right < reservations.length; right += 1) {
      const first = reservations[left];
      const second = reservations[right];
      if (windowsOverlap(first.occupied.start, first.occupied.end, second.occupied.start, second.occupied.end)) {
        conflicts.push({
          eventIds: [first.event.id, second.event.id],
          startDateTime: (first.occupied.start > second.occupied.start ? first.occupied.start : second.occupied.start).toISOString(),
          endDateTime: (first.occupied.end < second.occupied.end ? first.occupied.end : second.occupied.end).toISOString(),
        });
      }
    }
  }
  return conflicts;
}

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

/**
 * Creates an ordered, non-overlapping availability timeline for one venue.
 * Setup and teardown are included in each reservation's occupied window.
 * Confirmed bookings take precedence over tentative holds if bad legacy data
 * contains overlapping reservations. Expired holds are shown for context but
 * remain available for a new request.
 */
/**
 * Non-event records that also occupy a venue, as calendar reservations.
 * Same sources the booking conflict check uses (venueConflictService), so
 * the calendar never shows a slot as free that a request would be refused for:
 *   - venue bookings: pending -> tentative hold, approved -> confirmed booking
 *   - tentative holds: active -> tentative hold; expired -> expired hold (context)
 *   - unavailability periods -> temporarily unavailable (exact window, no buffer)
 */
function extraReservations(venue, { bookings = [], holds = [], unavailability = [], now = new Date() } = {}) {
  const out = [];
  for (const b of bookings) {
    const state = b.status === 'approved' ? AVAILABILITY_STATES.CONFIRMED_BOOKING
      : b.status === 'pending' ? AVAILABILITY_STATES.TENTATIVE_HOLD : null;
    if (!state) continue;
    out.push({
      state,
      window: getEffectiveWindow(b.startDatetime, b.endDatetime, venue),
      ref: { id: b.eventId, status: b.status, venueBookingId: b.id },
    });
  }
  for (const h of holds) {
    let state = null;
    if (isHoldActive(h, now)) state = AVAILABILITY_STATES.TENTATIVE_HOLD;
    else if (h.status === 'expired' || (h.status === 'active' && !isHoldActive(h, now))) state = AVAILABILITY_STATES.EXPIRED_HOLD;
    if (!state) continue;
    out.push({
      state,
      window: getEffectiveWindow(h.startDatetime, h.endDatetime, venue),
      ref: { id: h.eventId || null, status: h.status, venueHoldId: h.id },
    });
  }
  for (const u of unavailability) {
    out.push({
      state: AVAILABILITY_STATES.TEMPORARILY_UNAVAILABLE,
      window: { start: new Date(u.startDatetime), end: new Date(u.endDatetime) },
      ref: { id: null, status: 'unavailable', unavailabilityId: u.id, reason: u.reason },
    });
  }
  return out;
}

function buildAvailabilitySlots(venue, events, rangeStart, rangeEnd, extra = {}) {
  const start = new Date(rangeStart);
  const end = new Date(rangeEnd);
  if (!(end > start)) return [];

  const conflicts = findReservationConflicts(venue, events);
  const conflictsForEvent = (eventId) => conflicts
    .filter((conflict) => conflict.eventIds.includes(eventId))
    .flatMap((conflict) => conflict.eventIds.filter((id) => id !== eventId));
  const makeSlot = (slotStart, slotEnd, state, event) => ({
    startDateTime: new Date(slotStart).toISOString(),
    endDateTime: new Date(slotEnd).toISOString(),
    state,
    displayState: DISPLAY_STATE_LABELS[state],
    isAvailable: state === AVAILABILITY_STATES.AVAILABLE || state === AVAILABILITY_STATES.EXPIRED_HOLD,
    ...(event && event.id ? {
      eventId: event.id,
      eventStatus: event.status,
      hasConflict: conflictsForEvent(event.id).length > 0,
      conflictingEventIds: conflictsForEvent(event.id),
    } : {}),
    ...(event && event.venueBookingId ? { venueBookingId: event.venueBookingId } : {}),
    ...(event && event.venueHoldId ? { venueHoldId: event.venueHoldId } : {}),
    ...(event && event.unavailabilityId ? { unavailabilityId: event.unavailabilityId, reason: event.reason } : {}),
  });

  if (venue.status !== 'available') {
    return [makeSlot(start, end, AVAILABILITY_STATES.TEMPORARILY_UNAVAILABLE)];
  }

  const reservations = (events || [])
    .map((event) => {
      const state = eventAvailabilityState(event);
      if (!state) return null;
      const occupied = getOccupiedWindow(event, venue);
      const clippedStart = occupied.start > start ? occupied.start : start;
      const clippedEnd = occupied.end < end ? occupied.end : end;
      return clippedEnd > clippedStart ? { event, state, start: clippedStart, end: clippedEnd } : null;
    })
    .filter(Boolean);

  for (const r of extraReservations(venue, extra)) {
    const clippedStart = r.window.start > start ? r.window.start : start;
    const clippedEnd = r.window.end < end ? r.window.end : end;
    if (clippedEnd > clippedStart) reservations.push({ event: r.ref, state: r.state, start: clippedStart, end: clippedEnd });
  }

  const boundaries = [...new Set([start.getTime(), end.getTime(), ...reservations.flatMap((r) => [r.start.getTime(), r.end.getTime()])])]
    .sort((a, b) => a - b);
  const priority = {
    [AVAILABILITY_STATES.EXPIRED_HOLD]: 1,
    [AVAILABILITY_STATES.TENTATIVE_HOLD]: 2,
    [AVAILABILITY_STATES.CONFIRMED_BOOKING]: 3,
    [AVAILABILITY_STATES.TEMPORARILY_UNAVAILABLE]: 4,
  };
  const slots = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const slotStart = new Date(boundaries[index]);
    const slotEnd = new Date(boundaries[index + 1]);
    const active = reservations
      .filter((reservation) => windowsOverlap(reservation.start, reservation.end, slotStart, slotEnd))
      .sort((a, b) => priority[b.state] - priority[a.state]);
    const selected = active[0];
    const state = selected ? selected.state : AVAILABILITY_STATES.AVAILABLE;
    const slot = makeSlot(slotStart, slotEnd, state, selected && selected.event);
    const previous = slots[slots.length - 1];

    // A continuous run of the same state is easier for a calendar client to
    // render. Keep event identifiers separate so adjacent distinct holds are
    // still visible as distinct records.
    const sameRecord = previous && previous.eventId === slot.eventId
      && previous.venueBookingId === slot.venueBookingId && previous.venueHoldId === slot.venueHoldId
      && previous.unavailabilityId === slot.unavailabilityId;
    if (previous && previous.state === slot.state && sameRecord) {
      previous.endDateTime = slot.endDateTime;
    } else {
      slots.push(slot);
    }
  }
  return slots;
}

module.exports = {
  BLOCKING_EVENT_STATUSES,
  getOccupiedWindow,
  windowsOverlap,
  eventConflictsWithWindow,
  computeAvailability,
  AVAILABILITY_STATES,
  DISPLAY_STATE_LABELS,
  eventAvailabilityState,
  findReservationConflicts,
  buildAvailabilitySlots,
};
