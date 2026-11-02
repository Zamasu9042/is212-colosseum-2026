// Applying changes to an event's information during planning.
//
// Used by BOTH:
//   - the assigned Event Coordinator editing an event directly
//     (PATCH /api/events/:eventId), and
//   - approval of an Event Organiser's change request, so the two paths
//     can never drift apart.
//
// What it does, in one transaction supplied by the caller:
//   1. works out which fields really changed (old -> new),
//   2. classifies the change as MAJOR or ordinary,
//   3. refuses a date/time move that would clash with the event's venue,
//   4. updates the Event and its EventRequest consistently,
//   5. for major changes, flags the event for reassessment and reports
//      which venue bookings / equipment arrangements need a second look
//      (it never cancels or edits them),
//   6. writes a permanent change-log row and sends notifications.

const { Op } = require('sequelize');
const {
  Event,
  EventRequest,
  EventChangeLog,
  EventEquipmentRequest,
  EquipmentReservation,
  Notification,
  User,
  Role,
  Venue,
  VenueBooking,
  ROLE_NAMES,
} = require('../models');
const { checkVenueConflicts, ACTIVE_BOOKING_STATUSES } = require('./venueConflictService');

class EventChangeError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'EventChangeError';
    this.status = status;
    this.extra = extra;
  }
}

// Fields a change can touch. `target` says which row stores the value;
// `mirror` keeps the original request's preferred time in step with the event.
const FIELDS = {
  eventName: { target: 'request' },
  description: { target: 'request' },
  purpose: { target: 'request' },
  category: { target: 'request' },
  startDatetime: { target: 'event', mirror: 'preferredStart', date: true },
  endDatetime: { target: 'event', mirror: 'preferredEnd', date: true },
  expectedAttendance: { target: 'request' },
  venueRequirements: { target: 'request' },
  requestedLayout: { target: 'request' },
  accessibilityRequirements: { target: 'request' },
  facilityRequirements: { target: 'request' },
  setupRequirements: { target: 'request' },
  equipmentRequirements: { target: 'request' },
  layout: { target: 'request' },
  registrationSetup: { target: 'request' },
  registrationRequired: { target: 'request' },
};

// MAJOR = the kind of change other teams' arrangements depend on.
const MAJOR_FIELDS = new Set([
  'startDatetime',
  'endDatetime',
  'expectedAttendance',
  'venueRequirements',
  'equipmentRequirements',
]);

// Events in these states no longer accept planning changes.
const CLOSED_EVENT_STATUSES = ['completed', 'cancelled'];

const EDITABLE_FIELDS = Object.keys(FIELDS);

function currentValue(field, event, eventRequest) {
  const def = FIELDS[field];
  const row = def.target === 'event' ? event : eventRequest;
  const value = row[field];
  return value === undefined ? null : value;
}

function normalise(field, value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (FIELDS[field].date) return new Date(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return value;
}

function sameValue(field, a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (FIELDS[field].date) return new Date(a).getTime() === new Date(b).getTime();
  return a === b;
}

const serialise = (value) => (value instanceof Date ? value.toISOString() : value);

/**
 * Compares `input` with the event's current values.
 * @returns {{ changes: Object, isMajor: boolean }} changes = { field: { from, to } }
 */
function computeChanges(event, eventRequest, input) {
  const changes = {};
  for (const field of EDITABLE_FIELDS) {
    if (!(field in input)) continue;
    const to = normalise(field, input[field]);
    const from = currentValue(field, event, eventRequest);
    if (sameValue(field, from, to)) continue;
    changes[field] = { from: serialise(from), to: serialise(to) };
  }
  return { changes, isMajor: Object.keys(changes).some((f) => MAJOR_FIELDS.has(f)) };
}

/** The editable values of an event right now, for a reviewer's before/after view. */
function snapshotFields(event, eventRequest, fields) {
  const out = {};
  for (const f of fields) out[f] = serialise(currentValue(f, event, eventRequest));
  return out;
}

async function notify(userId, type, message, eventId, transaction) {
  if (!userId) return;
  await Notification.create({ userId, type, message, eventId }, { transaction });
}

async function notifyRole(roleName, type, message, eventId, transaction) {
  const users = await User.findAll({
    include: [{ model: Role, where: { name: roleName }, attributes: [] }],
    where: { isActive: true },
    attributes: ['id'],
    transaction,
  });
  for (const u of users) await notify(u.id, type, message, eventId, transaction);
}

/**
 * Works out which existing arrangements a major change puts in doubt.
 * Report only — nothing is modified here.
 */
async function assessImpact({ event, eventRequest, changes, transaction }) {
  const timeChanged = 'startDatetime' in changes || 'endDatetime' in changes;
  const attendanceChanged = 'expectedAttendance' in changes;

  const bookings = await VenueBooking.findAll({
    where: { eventId: event.id, status: { [Op.in]: ACTIVE_BOOKING_STATUSES } },
    include: [{ model: Venue, attributes: ['id', 'name', 'capacity'] }],
    transaction,
  });

  const affectedBookings = [];
  for (const b of bookings) {
    const reasons = [];
    if (attendanceChanged && eventRequest.expectedAttendance > (b.Venue?.capacity ?? Infinity)) {
      reasons.push('capacity');
    }
    if (
      timeChanged &&
      (new Date(b.startDatetime) < new Date(event.startDatetime) ||
        new Date(b.endDatetime) > new Date(event.endDatetime))
    ) {
      reasons.push('outside_event_window');
    }
    if (reasons.length) {
      affectedBookings.push({
        bookingId: b.id,
        venueId: b.venueId,
        venueName: b.Venue?.name ?? null,
        status: b.status,
        reasons,
      });
    }
  }

  const [equipmentLines, activeReservations] = await Promise.all([
    EventEquipmentRequest.count({ where: { eventId: event.id }, transaction }),
    EquipmentReservation.count({ where: { eventId: event.id, status: 'active' }, transaction }),
  ]);

  return {
    affectedBookings,
    activeVenueBookings: bookings.length,
    equipmentRequestLines: equipmentLines,
    activeEquipmentReservations: timeChanged ? activeReservations : 0,
  };
}

/**
 * Applies `input` to the event. Throws EventChangeError for problems the
 * caller should report (400 invalid window, 409 closed event / venue clash).
 *
 * @param {object} args
 * @param {Event} args.event            loaded Event (with its EventRequest on `.EventRequest`, or pass eventRequest)
 * @param {EventRequest} [args.eventRequest]
 * @param {object} args.input           whitelisted field values
 * @param {User|{id:string}} args.actor
 * @param {'coordinator_update'|'change_request'} args.source
 * @param {string} [args.reason]
 * @param {string} [args.changeRequestId]
 * @param {Transaction} args.transaction
 */
async function applyEventChanges({
  event,
  eventRequest: providedRequest,
  input,
  actor,
  source,
  reason,
  changeRequestId,
  transaction,
}) {
  if (CLOSED_EVENT_STATUSES.includes(event.status)) {
    throw new EventChangeError(409, `A ${event.status} event can no longer be changed.`);
  }
  const eventRequest =
    providedRequest || event.EventRequest || (await EventRequest.findByPk(event.eventRequestId, { transaction }));

  const { changes, isMajor } = computeChanges(event, eventRequest, input);
  if (!Object.keys(changes).length) {
    return { changed: false, changes: {}, changeType: null, reassessment: null, logEntry: null };
  }

  // Resulting window must still be valid.
  const newStart = changes.startDatetime ? new Date(changes.startDatetime.to) : event.startDatetime;
  const newEnd = changes.endDatetime ? new Date(changes.endDatetime.to) : event.endDatetime;
  if (!(new Date(newEnd) > new Date(newStart))) {
    throw new EventChangeError(400, 'endDatetime must be after startDatetime.');
  }
  const timeChanged = Boolean(changes.startDatetime || changes.endDatetime);

  // A date/time move must not collide with the event's own venue schedule.
  if (timeChanged && event.venueId) {
    const result = await checkVenueConflicts({
      venueIds: [event.venueId],
      start: newStart,
      end: newEnd,
      excludeEventId: event.id,
      transaction,
    });
    if (result.hasConflicts) {
      throw new EventChangeError(409, 'The new date/time conflicts with the event venue\'s schedule.', {
        conflicts: result.venues[0].conflicts,
      });
    }
  }

  // Apply to both rows.
  const eventUpdate = {};
  const requestUpdate = {};
  for (const [field, { to }] of Object.entries(changes)) {
    const def = FIELDS[field];
    const value = def.date && to != null ? new Date(to) : to;
    if (def.target === 'event') eventUpdate[field] = value;
    else requestUpdate[field] = value;
    if (def.mirror) requestUpdate[def.mirror] = value;
  }
  if (Object.keys(requestUpdate).length) await eventRequest.update(requestUpdate, { transaction });
  if (Object.keys(eventUpdate).length) await event.update(eventUpdate, { transaction });

  // Major change => reassessment.
  let reassessment = null;
  if (isMajor) {
    const impact = await assessImpact({ event, eventRequest, changes, transaction });
    reassessment = {
      required: true,
      flaggedAt: new Date().toISOString(),
      majorFields: Object.keys(changes).filter((f) => MAJOR_FIELDS.has(f)),
      ...impact,
    };
    await event.update(
      { reassessmentFlaggedAt: new Date(), reassessmentDetails: reassessment },
      { transaction }
    );

    // New date/time or equipment needs can no longer be called "ready".
    const equipmentAffected = timeChanged || 'equipmentRequirements' in changes;
    if (equipmentAffected && event.technicalReadiness === 'complete') {
      await event.update(
        { technicalReadiness: 'pending', technicalReadinessAt: null, technicalReadinessBy: null },
        { transaction }
      );
    }
  }

  const logEntry = await EventChangeLog.create(
    {
      eventId: event.id,
      changedBy: actor?.id ?? null,
      changeType: isMajor ? 'major' : 'ordinary',
      source,
      changes,
      reason: reason || null,
      changeRequestId: changeRequestId || null,
    },
    { transaction }
  );

  // Notifications (major changes only; ordinary edits are in the log).
  if (isMajor) {
    const name = eventRequest.eventName || 'An event';
    const fields = reassessment.majorFields.join(', ');
    // Tell the organiser of direct coordinator edits. (A change-request
    // approval already sends its own "approved" notification.)
    if (source === 'coordinator_update' && eventRequest.organiserId !== actor?.id) {
      await notify(
        eventRequest.organiserId,
        'event_updated',
        `"${name}" was updated (${fields}).`,
        event.id,
        transaction
      );
    }
    if (reassessment.activeVenueBookings > 0) {
      await notifyRole(
        ROLE_NAMES.VENUE_STAFF,
        'event_reassessment_required',
        `"${name}" changed (${fields}); its venue booking(s) need reassessment.`,
        event.id,
        transaction
      );
    }
    if (reassessment.equipmentRequestLines > 0) {
      await notifyRole(
        ROLE_NAMES.TECHNICAL_SUPPORT_STAFF,
        'event_reassessment_required',
        `"${name}" changed (${fields}); its equipment arrangements need reassessment.`,
        event.id,
        transaction
      );
    }
  }

  return {
    changed: true,
    changes,
    changeType: isMajor ? 'major' : 'ordinary',
    reassessment,
    logEntry,
  };
}

module.exports = {
  EventChangeError,
  EDITABLE_FIELDS,
  MAJOR_FIELDS,
  CLOSED_EVENT_STATUSES,
  computeChanges,
  snapshotFields,
  applyEventChanges,
};