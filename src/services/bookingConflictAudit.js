// Flags existing reservations that conflict under the updated (Week 7)
// venue booking rules — Extend Venue Conflict Detection, last AC:
//
//   "Existing bookings that become conflicting because of the new rules
//    are flagged and preserved rather than automatically deleted."
//
// For every live reservation of a venue (pending/approved venue bookings
// and events that reference the venue directly) the audit runs the same
// conflict rules used for new requests: setup time before, turnaround time
// after, active tentative holds, temporary unavailability periods and the
// venue status. Each venue is audited on its own.
//
// What it changes — and what it never changes:
//   - conflicting reservation -> conflictFlaggedAt + conflictDetails set
//     (events: venueConflictFlaggedAt + venueConflictDetails)
//   - no longer conflicting   -> the flag is cleared
//   - status, times, venue and requirements are NEVER touched and nothing
//     is deleted or cancelled. Venue Staff / the coordinator decide.
//   - the event's coordinator is notified the first time it is flagged.
//
// Runs automatically when a venue's setup/turnaround minutes or status
// change and when unavailability periods are added/removed, and on demand
// via POST /api/venues/conflicts/audit (e.g. once after deploying the new
// rules, to re-check bookings accepted under the old ones).

const { Op } = require('sequelize');
const {
  sequelize,
  Venue,
  Event,
  EventRequest,
  VenueBooking,
  VenueHold,
  VenueUnavailability,
  Notification,
} = require('../models');
const { ACTIVE_BOOKING_STATUSES, lockVenues } = require('./venueConflictService');
const { BLOCKING_EVENT_STATUSES, auditExistingReservations } = require('../utils/venueConflicts');

const CONFLICT_LABELS = {
  booking: 'another booking (setup/turnaround time included)',
  tentative_hold: 'an active tentative hold',
  unavailability: 'a period when the venue is unavailable',
  venue_status: 'the venue being out of service',
};

function describeConflicts(conflicts) {
  return [...new Set(conflicts.map((c) => CONFLICT_LABELS[c.type] || c.type))].join(', ');
}

/** Venues that still have something live from `now` onwards. */
async function venuesWithLiveReservations(now) {
  const [bookings, events] = await Promise.all([
    VenueBooking.findAll({
      attributes: ['venueId'],
      where: { status: { [Op.in]: ACTIVE_BOOKING_STATUSES }, endDatetime: { [Op.gt]: now } },
      raw: true,
    }),
    Event.findAll({
      attributes: ['venueId'],
      where: {
        venueId: { [Op.ne]: null },
        status: { [Op.in]: BLOCKING_EVENT_STATUSES },
        endDatetime: { [Op.gt]: now },
      },
      raw: true,
    }),
  ]);
  return [...new Set([...bookings, ...events].map((r) => r.venueId))];
}

const FLAG_FIELDS = {
  venue_booking: { at: 'conflictFlaggedAt', details: 'conflictDetails' },
  event: { at: 'venueConflictFlaggedAt', details: 'venueConflictDetails' },
};

async function auditOneVenue(venueId, { now, notify }) {
  return sequelize.transaction(async (transaction) => {
    // Same lock the write paths use, so the audit sees a consistent schedule.
    const [venue] = await lockVenues([venueId], transaction);
    if (!venue) return null;

    // Sequential: queries on one transaction share a single connection.
    const bookings = await VenueBooking.findAll({
      where: { venueId, status: { [Op.in]: ACTIVE_BOOKING_STATUSES } },
      include: [{ model: Event, include: [{ model: EventRequest, attributes: ['eventName'] }] }],
      transaction,
    });
    const events = await Event.findAll({
      where: { venueId, status: { [Op.in]: BLOCKING_EVENT_STATUSES } },
      include: [{ model: EventRequest, attributes: ['eventName'] }],
      transaction,
    });
    const holds = await VenueHold.findAll({ where: { venueId, status: 'active' }, transaction });
    const unavailability = await VenueUnavailability.findAll({ where: { venueId }, transaction });

    const rowsByKey = new Map([
      ...bookings.map((b) => [`venue_booking:${b.id}`, b]),
      ...events.map((e) => [`event:${e.id}`, e]),
    ]);

    const results = auditExistingReservations({ venue, bookings, events, holds, unavailability, now });
    const flagged = [];
    const cleared = [];

    for (const result of results) {
      const row = rowsByKey.get(`${result.kind}:${result.id}`);
      const fields = FLAG_FIELDS[result.kind];
      const wasFlagged = Boolean(row[fields.at]);
      const event = result.kind === 'event' ? row : row.Event;
      const summary = {
        type: result.kind,
        id: row.id,
        eventId: result.eventId,
        eventName: event?.EventRequest?.eventName ?? null,
        coordinatorId: event?.coordinatorId ?? null,
        startDatetime: row.startDatetime,
        endDatetime: row.endDatetime,
        status: row.status,
      };

      if (result.conflicts.length) {
        await row.update(
          { [fields.at]: wasFlagged ? row[fields.at] : now, [fields.details]: result.conflicts },
          { transaction }
        );
        flagged.push({ ...summary, newlyFlagged: !wasFlagged, conflicts: result.conflicts });

        if (!wasFlagged && notify && summary.coordinatorId) {
          await Notification.create(
            {
              userId: summary.coordinatorId,
              type: 'venue_booking_conflict_flagged',
              message:
                `"${summary.eventName || 'Your event'}" at ${venue.name} ` +
                `(${new Date(row.startDatetime).toISOString()} - ${new Date(row.endDatetime).toISOString()}) ` +
                `now conflicts with ${describeConflicts(result.conflicts)} under the updated venue booking rules. ` +
                'The booking has been kept and flagged for review; nothing was cancelled.',
              eventId: result.eventId,
              venueBookingId: result.kind === 'venue_booking' ? row.id : null,
            },
            { transaction }
          );
        }
      } else if (wasFlagged) {
        await row.update({ [fields.at]: null, [fields.details]: null }, { transaction });
        cleared.push(summary);
      }
    }

    return { venueId: venue.id, venueName: venue.name, checked: results.length, flagged, cleared };
  });
}

/**
 * Audits the given venues (or every venue with live reservations when
 * venueIds is empty). Each venue is audited independently in its own
 * transaction.
 */
async function auditVenueConflicts({ venueIds, now = new Date(), notify = true } = {}) {
  const ids = venueIds && venueIds.length ? [...new Set(venueIds)] : await venuesWithLiveReservations(now);

  const venues = [];
  for (const id of ids) {
    const result = await auditOneVenue(id, { now, notify });
    if (result) venues.push(result);
  }

  const totals = venues.reduce(
    (acc, v) => ({
      checked: acc.checked + v.checked,
      flagged: acc.flagged + v.flagged.length,
      newlyFlagged: acc.newlyFlagged + v.flagged.filter((f) => f.newlyFlagged).length,
      cleared: acc.cleared + v.cleared.length,
    }),
    { checked: 0, flagged: 0, newlyFlagged: 0, cleared: 0 }
  );

  return { auditedAt: now, venues, totals };
}

/** Venue fields whose change can turn an existing booking into a conflict. */
const SCHEDULE_AFFECTING_VENUE_FIELDS = ['setupMinutes', 'teardownMinutes', 'status'];

module.exports = {
  SCHEDULE_AFFECTING_VENUE_FIELDS,
  auditVenueConflicts,
};
