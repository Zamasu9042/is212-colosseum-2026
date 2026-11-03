jest.mock('../src/models', () => ({
  EventRegistration: { findAll: jest.fn(), update: jest.fn() },
  Notification: { create: jest.fn() },
  User: {},
}));
jest.mock('../src/services/emailService', () => ({ sendEventChangeEmail: jest.fn() }));

const { EventRegistration, Notification } = require('../src/models');
const { sendEventChangeEmail } = require('../src/services/emailService');
const {
  eventChanges, loggedChanges, notifyEventChange, sendEventChangeEmails,
} = require('../src/services/eventChangeNotificationService');

describe('event change notification details', () => {
  beforeEach(() => jest.clearAllMocks());

  test('identifies each attendee-relevant change with before and after values', () => {
    const changes = eventChanges(
      {
        startDatetime: '2027-06-01T09:00:00.000Z', endDatetime: '2027-06-01T12:00:00.000Z',
        venueId: 'old-venue', venueName: 'Auditorium A', status: 'confirmed',
      },
      {
        startDatetime: '2027-06-02T10:00:00.000Z', endDatetime: '2027-06-02T13:00:00.000Z',
        venueId: 'new-venue', venueName: 'Hall B', status: 'cancelled',
      }
    );

    expect(changes.map(({ field }) => field)).toEqual(['startDatetime', 'endDatetime', 'venueId', 'status']);
    expect(changes.find(({ field }) => field === 'venueId')).toMatchObject({
      label: 'Venue', before: 'Auditorium A', after: 'Hall B',
    });
    expect(changes.find(({ field }) => field === 'status')).toMatchObject({
      before: 'confirmed', after: 'cancelled',
    });
  });

  test('converts approved planning and change-request edits into attendee-facing details', () => {
    expect(loggedChanges({
      description: { from: null, to: 'Arrive ten minutes early' },
      registrationRequired: { from: false, to: true },
      startDatetime: { from: '2027-08-01T10:00:00.000Z', to: '2027-08-02T10:00:00.000Z' },
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'description', label: 'Description', before: 'Not specified' }),
      expect.objectContaining({ field: 'registrationRequired', before: 'No', after: 'Yes' }),
      expect.objectContaining({ field: 'startDatetime', label: 'Start time' }),
    ]));
  });

  test('creates only opted-in in-app notices and sends eligible recipients the action links', async () => {
    const attendee = (id, prefs) => ({ id, email: `${id}@example.com`, communicationPrefs: prefs });
    EventRegistration.findAll.mockResolvedValue([
      { id: 'reg-in-app', attendee: attendee('in-app', {}) },
      { id: 'reg-email-only', attendee: attendee('email-only', { inAppNotifications: false }) },
      { id: 'reg-none', attendee: attendee('none', { inAppNotifications: false, emailNotifications: false }) },
    ]);
    EventRegistration.update.mockResolvedValue([1]);
    Notification.create.mockResolvedValue({});

    const result = await notifyEventChange({
      event: { id: 'event-1', startDatetime: '2027-08-02T10:00:00Z', endDatetime: '2027-08-02T12:00:00Z', status: 'confirmed' },
      before: { startDatetime: '2027-08-01T10:00:00Z', endDatetime: '2027-08-01T12:00:00Z', status: 'confirmed' },
      eventName: 'Changed event', transaction: 'tx',
    });

    expect(EventRegistration.update).toHaveBeenCalledWith(
      { status: 'awaiting_reconfirmation' },
      expect.objectContaining({ where: { eventId: 'event-1', status: 'confirmed' } })
    );
    expect(Notification.create).toHaveBeenCalledTimes(1);
    expect(Notification.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'in-app', type: 'event_changed',
      metadata: expect.objectContaining({ requiresReconfirmation: true, actions: expect.arrayContaining([
        expect.objectContaining({ url: '/api/attendees/registrations/reg-in-app/reconfirm' }),
        expect.objectContaining({ url: '/api/attendees/registrations/reg-in-app/withdraw' }),
      ]) }),
    }), { transaction: 'tx' });
    expect(result.emailRecipients.map(({ attendee: recipient }) => recipient.id)).toEqual(['in-app', 'email-only']);

    sendEventChangeEmail.mockResolvedValue({ sent: true });
    await sendEventChangeEmails({ eventName: 'Changed event', changes: result.changes, emailRecipients: result.emailRecipients });
    expect(sendEventChangeEmail).toHaveBeenCalledTimes(2);
    expect(sendEventChangeEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'in-app@example.com', actions: expect.arrayContaining([
        expect.objectContaining({ label: 'Re-confirm registration' }),
      ]),
    }));
  });

  test('marks cancellations distinctly without requesting re-confirmation', async () => {
    EventRegistration.findAll.mockResolvedValue([
      { id: 'reg-cancelled', attendee: { id: 'attendee-1', email: 'attendee@example.com', communicationPrefs: {} } },
    ]);
    Notification.create.mockResolvedValue({});

    const result = await notifyEventChange({
      event: { id: 'event-2', startDatetime: '2027-08-01T10:00:00Z', endDatetime: '2027-08-01T12:00:00Z', status: 'cancelled' },
      before: { startDatetime: '2027-08-01T10:00:00Z', endDatetime: '2027-08-01T12:00:00Z', status: 'confirmed' },
      eventName: 'Cancelled event', transaction: 'tx',
    });

    expect(EventRegistration.update).not.toHaveBeenCalled();
    expect(Notification.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'event_cancelled', metadata: expect.objectContaining({ requiresReconfirmation: false, actions: [] }),
    }), { transaction: 'tx' });
    expect(result.emailRecipients).toHaveLength(1);
  });
});
