const {
  sequelize,
  Event,
  EventRequest,
  EventRegistration,
  Notification,
} = require('../../src/models');
const { Op } = require('sequelize');
const { sendWithdrawalEmail } = require('../../src/services/emailService');
const { ACTIVE_REGISTRATION_STATUSES } = require('../../src/services/eventChangeNotificationService');

const REGISTRABLE_EVENT_STATUSES = ['confirmed'];

function isBeforeStart(event, now = new Date()) {
  return new Date(event.startDatetime) > now;
}

function registrationAvailability(event, { availableCapacity, now = new Date() } = {}) {
  if (!REGISTRABLE_EVENT_STATUSES.includes(event.status)) {
    return { registrationOpen: false, registrationUnavailableReason: 'Event is not confirmed.' };
  }
  if (!event.registrationStartDatetime || !event.registrationEndDatetime) {
    return { registrationOpen: false, registrationUnavailableReason: 'Registration window has not been configured.' };
  }
  const start = new Date(event.registrationStartDatetime);
  const end = new Date(event.registrationEndDatetime);
  if (now < start) return { registrationOpen: false, registrationUnavailableReason: 'Registration has not opened yet.' };
  if (now >= end) return { registrationOpen: false, registrationUnavailableReason: 'Registration window has closed.' };
  if (availableCapacity !== undefined && availableCapacity < 1) {
    return { registrationOpen: false, registrationUnavailableReason: 'Event Full' };
  }
  return { registrationOpen: true, registrationUnavailableReason: null };
}

function canWithdraw(registration, event, now = new Date()) {
  return ACTIVE_REGISTRATION_STATUSES.includes(registration.status) &&
    REGISTRABLE_EVENT_STATUSES.includes(event.status) &&
    isBeforeStart(event, now);
}

async function loadLockedEvent(eventId, transaction) {
  // PostgreSQL rejects FOR UPDATE with the optional EventRequest join. Lock
  // the event first, then load the display/capacity context in the same tx.
  const event = await Event.findByPk(eventId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!event) return null;
  // Lightweight controller tests use a plain event double; a persisted
  // Sequelize instance always has reload.
  if (typeof event.reload !== 'function') return event;
  await event.reload({
    include: [{ model: EventRequest, attributes: ['eventName', 'expectedAttendance'] }],
    transaction,
  });
  return event;
}

async function ensureCapacity(event, transaction) {
  const capacity = event.registrationCapacity ?? event.EventRequest?.expectedAttendance;
  if (!Number.isInteger(capacity) || capacity < 1) {
    const error = new Error('Registration capacity has not been configured for this event.');
    error.status = 409;
    throw error;
  }

  const confirmed = await EventRegistration.count({
    where: { eventId: event.id, status: ACTIVE_REGISTRATION_STATUSES },
    transaction,
  });
  const availableCapacity = Math.max(capacity - confirmed, 0);
  if (event.registrationCapacity !== capacity || event.availableCapacity !== availableCapacity) {
    await event.update({ registrationCapacity: capacity, availableCapacity }, { transaction });
  }
  return { capacity, availableCapacity };
}

function serializeRegistration(registration, event) {
  return {
    id: registration.id,
    eventId: registration.eventId,
    status: registration.status,
    confirmedAt: registration.confirmedAt,
    withdrawnAt: registration.withdrawnAt,
    fullName: registration.fullName,
    workEmail: registration.workEmail,
    contactNumber: registration.contactNumber,
    event: {
      id: event.id,
      name: event.EventRequest?.eventName,
      startDatetime: event.startDatetime,
      status: event.status,
    },
    canWithdraw: canWithdraw(registration, event),
    canReconfirm: registration.status === 'awaiting_reconfirmation' &&
      REGISTRABLE_EVENT_STATUSES.includes(event.status) && isBeforeStart(event),
  };
}

async function listRegistrations(req, res, next) {
  try {
    const registrations = await EventRegistration.findAll({
      where: { attendeeId: req.user.id },
      include: [{ model: Event, include: [{ model: EventRequest, attributes: ['eventName'] }] }],
      order: [['confirmed_at', 'DESC']],
    });
    res.json({ registrations: registrations.map((registration) => serializeRegistration(registration, registration.Event)) });
  } catch (err) {
    next(err);
  }
}

// Attendees need a discovery endpoint as well as their own registrations.
// Internal event-list endpoints intentionally exclude attendees, so exposing a
// small public-to-attendees projection here keeps the access boundary intact.
async function listRegisterableEvents(req, res, next) {
  try {
    const events = await Event.findAll({
      where: {
        status: 'confirmed',
        startDatetime: { [Op.gt]: new Date() },
      },
      include: [{ model: EventRequest, attributes: ['eventName', 'expectedAttendance'] }],
      order: [['start_datetime', 'ASC']],
    });

    const items = await Promise.all(events.map(async (event) => {
      const capacity = event.registrationCapacity ?? event.EventRequest?.expectedAttendance;
      if (!Number.isInteger(capacity) || capacity < 1) return null;
      const registered = await EventRegistration.count({
        where: { eventId: event.id, status: ACTIVE_REGISTRATION_STATUSES },
      });
      const availableCapacity = Math.max(capacity - registered, 0);
      return {
        id: event.id,
        name: event.EventRequest?.eventName || 'Untitled event',
        startDatetime: event.startDatetime,
        status: event.status,
        registrationCapacity: capacity,
        availableCapacity,
        registrationStartDatetime: event.registrationStartDatetime,
        registrationEndDatetime: event.registrationEndDatetime,
        ...registrationAvailability(event, { availableCapacity }),
      };
    }));
    res.json({ events: items.filter(Boolean) });
  } catch (err) { next(err); }
}

async function createRegistration(req, res, next) {
  try {
    const result = await sequelize.transaction(async (transaction) => {
      const event = await loadLockedEvent(req.body.eventId, transaction);
      if (!event) {
        const error = new Error('Event not found.'); error.status = 404; throw error;
      }
      const { availableCapacity } = await ensureCapacity(event, transaction);
      const availability = registrationAvailability(event, { availableCapacity });
      if (!availability.registrationOpen || !isBeforeStart(event)) {
        const error = new Error('Registration is unavailable for this event.'); error.status = 409; throw error;
      }
      const existing = await EventRegistration.findOne({
        where: { eventId: event.id, attendeeId: req.user.id }, transaction, lock: transaction.LOCK.UPDATE,
      });
      if (existing) {
        const error = new Error('You already have a registration for this event.'); error.status = 409; throw error;
      }
      if (availableCapacity < 1) {
        const error = new Error('This event is full.'); error.status = 409; throw error;
      }
      const registration = await EventRegistration.create({
        eventId: event.id, attendeeId: req.user.id, status: 'confirmed', confirmedAt: new Date(),
        fullName: req.body.fullName, workEmail: req.body.workEmail, contactNumber: req.body.contactNumber,
      }, { transaction });
      await event.update({ availableCapacity: availableCapacity - 1 }, { transaction });
      return { registration, event, availableCapacity: availableCapacity - 1 };
    });
    res.status(201).json({ registration: serializeRegistration(result.registration, result.event), availableCapacity: result.availableCapacity });
  } catch (err) { next(err); }
}

async function withdrawRegistration(req, res, next) {
  try {
    const initial = await EventRegistration.findByPk(req.params.id);
    if (!initial || initial.attendeeId !== req.user.id) {
      return res.status(404).json({ error: 'Registration not found.' });
    }

    const result = await sequelize.transaction(async (transaction) => {
      const event = await loadLockedEvent(initial.eventId, transaction);
      const registration = await EventRegistration.findByPk(initial.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!event || !registration || registration.attendeeId !== req.user.id) {
        const error = new Error('Registration not found.'); error.status = 404; throw error;
      }
      if (!canWithdraw(registration, event)) {
        const error = new Error('This registration can no longer be withdrawn.'); error.status = 409; throw error;
      }
      const { availableCapacity } = await ensureCapacity(event, transaction);
      await registration.update({ status: 'withdrawn', withdrawnAt: new Date() }, { transaction });
      await event.update({ availableCapacity: availableCapacity + 1 }, { transaction });
      if (req.user.communicationPrefs?.inAppNotifications !== false) {
        await Notification.create({
          userId: req.user.id,
          eventId: event.id,
          type: 'registration_withdrawn',
          message: `Your registration for ${event.EventRequest?.eventName || 'this event'} has been withdrawn.`,
        }, { transaction });
      }
      return { registration, event, availableCapacity: availableCapacity + 1 };
    });

    let email;
    if (req.user.communicationPrefs?.emailNotifications === false) {
      email = { sent: false, skipped: true };
    } else {
      try {
        email = await sendWithdrawalEmail({
          to: req.user.email,
          attendeeName: req.user.email,
          eventName: result.event.EventRequest?.eventName || 'your event',
          startDatetime: result.event.startDatetime,
        });
      } catch (emailError) {
        // The withdrawal and in-app confirmation are already committed; do not
        // report a failed withdrawal solely because a third-party SMTP server is unavailable.
        console.error('Withdrawal confirmation email failed:', emailError.message);
        email = { sent: false, error: 'Email delivery failed.' };
      }
    }
    res.json({
      message: 'Registration withdrawn successfully.',
      registration: serializeRegistration(result.registration, result.event),
      availableCapacity: result.availableCapacity,
      email,
    });
  } catch (err) { next(err); }
}

async function reconfirmRegistration(req, res, next) {
  try {
    const initial = await EventRegistration.findByPk(req.params.id);
    if (!initial || initial.attendeeId !== req.user.id) {
      return res.status(404).json({ error: 'Registration not found.' });
    }
    const result = await sequelize.transaction(async (transaction) => {
      const event = await loadLockedEvent(initial.eventId, transaction);
      const registration = await EventRegistration.findByPk(initial.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!event || !registration || registration.attendeeId !== req.user.id) {
        const error = new Error('Registration not found.'); error.status = 404; throw error;
      }
      if (registration.status !== 'awaiting_reconfirmation') {
        const error = new Error('This registration does not require re-confirmation.'); error.status = 409; throw error;
      }
      if (!REGISTRABLE_EVENT_STATUSES.includes(event.status) || !isBeforeStart(event)) {
        const error = new Error('This event can no longer be re-confirmed.'); error.status = 409; throw error;
      }
      await registration.update({ status: 'confirmed' }, { transaction });
      if (req.user.communicationPrefs?.inAppNotifications !== false) {
        await Notification.create({
          userId: req.user.id, eventId: event.id, type: 'registration_reconfirmed',
          message: `Your registration for ${event.EventRequest?.eventName || 'this event'} has been re-confirmed.`,
        }, { transaction });
      }
      return { registration, event };
    });
    res.json({
      message: 'Registration re-confirmed successfully.',
      registration: serializeRegistration(result.registration, result.event),
    });
  } catch (err) { next(err); }
}

module.exports = { listRegistrations, listRegisterableEvents, createRegistration, withdrawRegistration, reconfirmRegistration, canWithdraw, registrationAvailability };
