const { EventRegistration, Notification, User } = require('../models');
const { sendEventChangeEmail } = require('./emailService');

const ACTIVE_REGISTRATION_STATUSES = ['confirmed', 'awaiting_reconfirmation'];

function formatDateTime(value) {
  return new Date(value).toLocaleString('en-SG', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore',
  });
}

function eventChanges(before, after) {
  const changes = [];
  if (new Date(before.startDatetime).getTime() !== new Date(after.startDatetime).getTime()) {
    changes.push({ field: 'startDatetime', label: 'Start time', before: formatDateTime(before.startDatetime), after: formatDateTime(after.startDatetime) });
  }
  if (new Date(before.endDatetime).getTime() !== new Date(after.endDatetime).getTime()) {
    changes.push({ field: 'endDatetime', label: 'End time', before: formatDateTime(before.endDatetime), after: formatDateTime(after.endDatetime) });
  }
  if ((before.venueId || null) !== (after.venueId || null)) {
    changes.push({ field: 'venueId', label: 'Venue', before: before.venueName || 'Not assigned', after: after.venueName || 'Not assigned' });
  }
  if (before.status !== after.status) {
    changes.push({ field: 'status', label: 'Status', before: before.status, after: after.status });
  }
  return changes;
}

const FIELD_LABELS = {
  eventName: 'Event name',
  description: 'Description',
  purpose: 'Purpose',
  category: 'Category',
  startDatetime: 'Start time',
  endDatetime: 'End time',
  expectedAttendance: 'Expected attendance',
  venueRequirements: 'Venue requirements',
  requestedLayout: 'Requested layout',
  accessibilityRequirements: 'Accessibility requirements',
  facilityRequirements: 'Facility requirements',
  setupRequirements: 'Setup requirements',
  equipmentRequirements: 'Equipment requirements',
  layout: 'Layout',
  registrationSetup: 'Registration setup',
  registrationRequired: 'Registration required',
  venueId: 'Venue',
  status: 'Status',
};

function displayValue(field, value) {
  if (value == null || value === '') return 'Not specified';
  if (field === 'startDatetime' || field === 'endDatetime') return formatDateTime(value);
  if (field === 'registrationRequired') return value ? 'Yes' : 'No';
  return String(value);
}

// The planning/change-request service already produces authoritative old/new
// values. Convert them into the same attendee-facing shape used by the
// operational event update route, so no approved edit can bypass notices.
function loggedChanges(changes) {
  return Object.entries(changes || {}).map(([field, value]) => ({
    field,
    label: FIELD_LABELS[field] || field,
    before: displayValue(field, value.from),
    after: displayValue(field, value.to),
  }));
}

function registrationActions(registrationId) {
  const base = `/api/attendees/registrations/${registrationId}`;
  return [
    { label: 'Re-confirm registration', method: 'POST', url: `${base}/reconfirm` },
    { label: 'Withdraw registration', method: 'POST', url: `${base}/withdraw` },
  ];
}

async function notifyEventChange({ event, before, changes: suppliedChanges, eventName, transaction }) {
  const changes = suppliedChanges ? loggedChanges(suppliedChanges) : eventChanges(before, event);
  if (!changes.length) return { changes, recipients: 0 };

  const registrations = await EventRegistration.findAll({
    where: { eventId: event.id, status: ACTIVE_REGISTRATION_STATUSES },
    include: [{ model: User, as: 'attendee', attributes: ['id', 'email', 'firstName', 'lastName', 'communicationPrefs'] }],
    transaction,
  });
  const rescheduled = changes.some((change) => ['startDatetime', 'endDatetime'].includes(change.field));

  // A rescheduled attendee keeps their place but must explicitly acknowledge
  // the new time. Do this before generating actions so state and notice agree.
  if (rescheduled) {
    await EventRegistration.update(
      { status: 'awaiting_reconfirmation' },
      { where: { eventId: event.id, status: 'confirmed' }, transaction }
    );
  }

  const deliveries = registrations.map(async (registration) => {
    const attendee = registration.attendee;
    const preferences = attendee.communicationPrefs || {};
    const actions = rescheduled ? registrationActions(registration.id) : [];
    const detailText = changes.map((change) => `${change.label}: ${change.before} → ${change.after}`).join('; ');
    const message = `${eventName} has been updated. ${detailText}${rescheduled ? ' Please re-confirm your registration or withdraw.' : ''}`;
    if (preferences.inAppNotifications !== false) {
      await Notification.create({
        userId: attendee.id, eventId: event.id, type: event.status === 'cancelled' ? 'event_cancelled' : 'event_changed', message,
        metadata: { changes, actions, requiresReconfirmation: rescheduled },
      }, { transaction });
    }
    return { attendee, actions };
  });

  // In-app rows are transactionally consistent with the update. Email is
  // deliberately dispatched after commit by the caller.
  const recipients = await Promise.all(deliveries);
  return { changes, recipients, emailRecipients: recipients.filter(({ attendee }) => attendee.communicationPrefs?.emailNotifications !== false) };
}

async function sendEventChangeEmails({ eventName, changes, emailRecipients }) {
  return Promise.allSettled(emailRecipients.map(({ attendee, actions }) =>
    sendEventChangeEmail({
      to: attendee.email,
      attendeeName: [attendee.firstName, attendee.lastName].filter(Boolean).join(' ') || attendee.email,
      eventName,
      changes,
      actions,
    })
  ));
}

module.exports = {
  ACTIVE_REGISTRATION_STATUSES,
  eventChanges,
  loggedChanges,
  notifyEventChange,
  sendEventChangeEmails,
};
