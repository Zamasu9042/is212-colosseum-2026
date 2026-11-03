jest.mock('../../src/models', () => ({
  sequelize: { transaction: jest.fn() },
  Event: { findByPk: jest.fn() },
  EventRequest: {},
  EventRegistration: { findByPk: jest.fn(), findOne: jest.fn(), create: jest.fn(), count: jest.fn() },
  Notification: { create: jest.fn() },
}));
jest.mock('../../src/services/emailService', () => ({ sendWithdrawalEmail: jest.fn() }));

const { sequelize, Event, EventRegistration, Notification } = require('../../src/models');
const { sendWithdrawalEmail } = require('../../src/services/emailService');
const { createRegistration, withdrawRegistration, canWithdraw } = require('../controllers/registrationController');

function response() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('Attendee registration withdrawal', () => {
  const now = new Date();
  const attendee = {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'attendee@example.com',
    communicationPrefs: { emailNotifications: true, inAppNotifications: true },
  };

  function buildEvent(startDatetime = new Date(now.getTime() + 60 * 60 * 1000)) {
    return {
      id: '22222222-2222-2222-2222-222222222222',
      status: 'confirmed',
      startDatetime,
      registrationCapacity: 10,
      availableCapacity: 5,
      EventRequest: { eventName: 'ConnectSphere Demo', expectedAttendance: 10 },
      update: jest.fn().mockImplementation(function (fields) { Object.assign(this, fields); return Promise.resolve(this); }),
    };
  }

  function buildRegistration() {
    return {
      id: '33333333-3333-3333-3333-333333333333',
      eventId: '22222222-2222-2222-2222-222222222222',
      attendeeId: attendee.id,
      status: 'confirmed',
      confirmedAt: now,
      withdrawnAt: null,
      update: jest.fn().mockImplementation(function (fields) { Object.assign(this, fields); return Promise.resolve(this); }),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    sequelize.transaction.mockImplementation((callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }));
    sendWithdrawalEmail.mockResolvedValue({ sent: true, messageId: 'test-message' });
  });

  test('withdraws a confirmed future registration, releases capacity, and sends confirmations', async () => {
    const event = buildEvent();
    const registration = buildRegistration();
    EventRegistration.findByPk.mockResolvedValueOnce(registration).mockResolvedValueOnce(registration);
    Event.findByPk.mockResolvedValue(event);
    EventRegistration.count.mockResolvedValue(5);
    const res = response();

    await withdrawRegistration({ params: { id: registration.id }, user: attendee }, res, jest.fn());

    expect(registration.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'withdrawn', withdrawnAt: expect.any(Date) }), expect.any(Object));
    expect(event.update).toHaveBeenCalledWith({ availableCapacity: 6 }, expect.any(Object));
    expect(Notification.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: attendee.id, eventId: event.id, type: 'registration_withdrawn',
    }), expect.any(Object));
    expect(sendWithdrawalEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: attendee.email, eventName: 'ConnectSphere Demo',
    }));
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ availableCapacity: 6 }));
  });

  test('creates a confirmed registration and reduces available capacity immediately', async () => {
    const event = buildEvent();
    event.availableCapacity = 6;
    const registration = buildRegistration();
    Event.findByPk.mockResolvedValue(event);
    EventRegistration.findOne.mockResolvedValue(null);
    EventRegistration.count.mockResolvedValue(4);
    EventRegistration.create.mockResolvedValue(registration);
    const res = response();

    await createRegistration({ body: { eventId: event.id }, user: attendee }, res, jest.fn());

    expect(EventRegistration.create).toHaveBeenCalledWith(expect.objectContaining({
      eventId: event.id, attendeeId: attendee.id, status: 'confirmed',
    }), expect.any(Object));
    expect(event.update).toHaveBeenCalledWith({ availableCapacity: 5 }, expect.any(Object));
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ availableCapacity: 5 }));
  });

  test('does not allow withdrawal after the event starts and exposes canWithdraw as false', async () => {
    const event = buildEvent(new Date(now.getTime() - 60 * 1000));
    const registration = buildRegistration();
    EventRegistration.findByPk.mockResolvedValueOnce(registration).mockResolvedValueOnce(registration);
    Event.findByPk.mockResolvedValue(event);
    const next = jest.fn();

    await withdrawRegistration({ params: { id: registration.id }, user: attendee }, response(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(registration.update).not.toHaveBeenCalled();
    expect(canWithdraw(registration, event)).toBe(false);
    expect(sendWithdrawalEmail).not.toHaveBeenCalled();
  });

  test('does not expose a different attendee registration', async () => {
    const registration = { ...buildRegistration(), attendeeId: '44444444-4444-4444-4444-444444444444' };
    EventRegistration.findByPk.mockResolvedValue(registration);
    const res = response();

    await withdrawRegistration({ params: { id: registration.id }, user: attendee }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(Notification.create).not.toHaveBeenCalled();
  });
});
