// Loads everything that can occupy a set of venues and runs the pure
// conflict rules from utils/venueConflicts.js over it.
//
// assertNoVenueConflicts() is the guard any write path that claims a
// venue (tentative holds today; venue booking requests/approvals next)
// should call so double-bookings are prevented, not just reported.

const { Op } = require('sequelize');
const { Venue, Event, VenueHold, VenueUnavailability, VenueBooking } = require('../models');
const { BLOCKING_EVENT_STATUSES, findConflictsForVenues } = require('../utils/venueConflicts');

// Venue booking statuses that still hold a claim on the venue.
const ACTIVE_BOOKING_STATUSES = ['pending', 'approved'];

class VenueConflictError extends Error {
  constructor(result) {
    super('The requested time conflicts with the existing schedule for one or more venues.');
    this.name = 'VenueConflictError';
    this.status = 409;
    this.result = result;
  }
}

/**
 * Loads blocking events, active-status holds and unavailability periods
 * for the given venues. Expiry of holds is evaluated in the pure layer
 * (against `now`) rather than in SQL so the rule has one definition.
 */
async function loadVenueSchedules(venueIds, { transaction, excludeBookingId } = {}) {
  if (!venueIds.length) return { events: [], holds: [], unavailability: [] };
  const inVenues = { venueId: { [Op.in]: venueIds } };

  const bookingWhere = { ...inVenues, status: { [Op.in]: ACTIVE_BOOKING_STATUSES } };
  if (excludeBookingId) bookingWhere.id = { [Op.ne]: excludeBookingId };

  const [events, holds, unavailability, bookings] = await Promise.all([
    Event.findAll({
      where: { ...inVenues, status: { [Op.in]: BLOCKING_EVENT_STATUSES } },
      transaction,
    }),
    VenueHold.findAll({ where: { ...inVenues, status: 'active' }, transaction }),
    VenueUnavailability.findAll({ where: inVenues, transaction }),
    VenueBooking.findAll({ where: bookingWhere, transaction }),
  ]);

  // Live venue bookings (pending/approved) occupy a venue exactly like a
  // booked event does, so they are fed to the conflict rules as events.
  // `id` is the booking id (so excluding an event never hides its own
  // other bookings); `eventId` points back to the real event.
  const bookingsAsEvents = bookings.map((b) => ({
    id: b.id,
    eventId: b.eventId,
    venueId: b.venueId,
    startDatetime: b.startDatetime,
    endDatetime: b.endDatetime,
    status: 'planning',
    isVenueBooking: true,
  }));

  return { events: [...events, ...bookingsAsEvents], holds, unavailability };
}

function serializeResult(result, venuesById) {
  return {
    hasConflicts: result.hasConflicts,
    venues: result.venues.map((v) => ({
      venueId: v.venueId,
      venueName: venuesById.get(v.venueId)?.name,
      effectiveWindow: v.effectiveWindow,
      hasConflict: v.hasConflict,
      conflicts: v.conflicts,
    })),
  };
}

/**
 * Checks a proposed [start, end) booking against every requested venue,
 * independently. Throws { status: 404 } if any venue id is unknown.
 * Pass `transaction` when the check guards a write (see assertNoVenueConflicts).
 */
async function checkVenueConflicts({
  venueIds,
  start,
  end,
  excludeEventId,
  excludeHoldId,
  excludeBookingId,
  now,
  transaction,
}) {
  const uniqueIds = [...new Set(venueIds)];
  const venues = await Venue.findAll({ where: { id: { [Op.in]: uniqueIds } }, transaction });

  const venuesById = new Map(venues.map((v) => [v.id, v]));
  const missing = uniqueIds.filter((id) => !venuesById.has(id));
  if (missing.length) {
    const err = new Error(`Venue(s) not found: ${missing.join(', ')}`);
    err.status = 404;
    throw err;
  }

  const schedules = await loadVenueSchedules(uniqueIds, { transaction, excludeBookingId });
  const result = findConflictsForVenues({
    // Preserve the caller's requested order in the response.
    venues: uniqueIds.map((id) => venuesById.get(id)),
    start: new Date(start),
    end: new Date(end),
    ...schedules,
    excludeEventId,
    excludeHoldId,
    now: now || new Date(),
  });

  return {
    requestedWindow: { start: new Date(start), end: new Date(end) },
    ...serializeResult(result, venuesById),
  };
}

/**
 * Same as checkVenueConflicts, but throws a 409 VenueConflictError on any
 * conflict. When guarding a write, call it inside a transaction that has
 * already locked the venue row(s) (see lockVenues) so two concurrent
 * requests cannot both pass the check and double-book.
 */
async function assertNoVenueConflicts(args) {
  const result = await checkVenueConflicts(args);
  if (result.hasConflicts) throw new VenueConflictError(result);
  return result;
}

/**
 * Row-locks the venues (SELECT ... FOR UPDATE) in a stable order so
 * concurrent claims on the same venue are serialised without deadlocking.
 */
async function lockVenues(venueIds, transaction) {
  const ids = [...new Set(venueIds)].sort();
  return Venue.findAll({
    where: { id: { [Op.in]: ids } },
    order: [['id', 'ASC']],
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
}

module.exports = {
  ACTIVE_BOOKING_STATUSES,
  VenueConflictError,
  lockVenues,
  loadVenueSchedules,
  checkVenueConflicts,
  assertNoVenueConflicts,
};