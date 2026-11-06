jest.mock('../src/models', () => ({
  sequelize: { transaction: jest.fn() },
  VenueHold: { findAll: jest.fn() },
  Venue: { findAll: jest.fn() },
  Event: { findAll: jest.fn() },
  EventRequest: {},
  Notification: { create: jest.fn() },
}));

const { sequelize, VenueHold, Venue, Event, Notification } = require('../src/models');
const { expireDueHolds, sendExpiryWarnings, processHoldExpiries } = require('../src/services/holdExpiryService');

const now = new Date('2027-01-01T00:00:00.000Z');

function hold(overrides = {}) {
  return {
    id: 'hold-1', venueId: 'venue-1', eventId: 'event-1', heldBy: 'coord-1',
    startDatetime: new Date('2027-01-02T09:00:00.000Z'), endDatetime: new Date('2027-01-02T10:00:00.000Z'),
    expiresAt: new Date('2026-12-31T23:00:00.000Z'),
    update: jest.fn().mockResolvedValue(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sequelize.transaction.mockImplementation((callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }));
  Venue.findAll.mockResolvedValue([{ id: 'venue-1', name: 'Hall A' }]);
  Event.findAll.mockResolvedValue([{ id: 'event-1', coordinatorId: 'coord-2', EventRequest: { eventName: 'Expo' } }]);
  Notification.create.mockResolvedValue({});
});

describe('Hold expiry service', () => {
  test('returns no expiry results when no active hold is due', async () => {
    VenueHold.findAll.mockResolvedValue([]);
    await expect(expireDueHolds({ now })).resolves.toEqual([]);
    expect(Notification.create).not.toHaveBeenCalled();
  });

  test('expires due holds and notifies the holder and assigned coordinator', async () => {
    const due = hold();
    VenueHold.findAll.mockResolvedValue([due]);
    const result = await expireDueHolds({ now });
    expect(due.update).toHaveBeenCalledWith({ status: 'expired', expiredAt: now }, expect.any(Object));
    expect(Notification.create).toHaveBeenCalledTimes(2);
    expect(result).toEqual([expect.objectContaining({ holdId: due.id, notified: 2 })]);
  });

  test('warns about an active hold once and combines expiry and warning results', async () => {
    const warning = hold({ expiresAt: new Date('2027-01-01T02:00:00.000Z') });
    VenueHold.findAll.mockResolvedValueOnce([]).mockResolvedValueOnce([warning]);
    const result = await processHoldExpiries({ now, warningHours: 3 });
    expect(warning.update).toHaveBeenCalledWith({ expiryWarningSentAt: now }, expect.any(Object));
    expect(result).toMatchObject({ ranAt: now, expired: [], warned: [expect.objectContaining({ holdId: warning.id, notified: 2 })] });
  });
});
