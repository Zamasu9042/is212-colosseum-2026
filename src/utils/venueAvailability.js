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

/**
 * Creates an ordered, non-overlapping availability timeline for one venue.
 * Setup and teardown are included in each reservation's occupied window.
 * Confirmed bookings take precedence over tentative holds if bad legacy data
 * contains overlapping reservations. Expired holds are shown for context but
 * remain available for a new request.
 */
function buildAvailabilitySlots(venue, events, rangeStart, rangeEnd) {
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
    ...(event ? {
      eventId: event.id,
      eventStatus: event.status,
      hasConflict: conflictsForEvent(event.id).length > 0,
      conflictingEventIds: conflictsForEvent(event.id),
    } : {}),
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

  const boundaries = [...new Set([start.getTime(), end.getTime(), ...reservations.flatMap((r) => [r.start.getTime(), r.end.getTime()])])]
    .sort((a, b) => a - b);
  const priority = {
    [AVAILABILITY_STATES.EXPIRED_HOLD]: 1,
    [AVAILABILITY_STATES.TENTATIVE_HOLD]: 2,
    [AVAILABILITY_STATES.CONFIRMED_BOOKING]: 3,
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
    if (previous && previous.state === slot.state && previous.eventId === slot.eventId) {
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
