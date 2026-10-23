// Unit tests for Manage Expiring Tentative Venue Holds (pure rules).
// Grouped by acceptance criterion so each AC traces to its tests.

const {
  HoldExpiryError,
  getHoldConfig,
  resolveHoldExpiry,
  isHoldDueForExpiry,
  holdLifecycleState,
  needsExpiryWarning,
  holdRecipients,
  expiryWarningMessage,
  expiredMessage,
} = require('../src/utils/holdExpiry');
const { isHoldActive, findVenueConflicts } = require('../src/utils/venueConflicts');

const NOW = new Date('2026-10-01T00:00:00Z');
const hoursFrom = (date, h) => new Date(date.getTime() + h * 60 * 60 * 1000);

function hold(overrides = {}) {
  return {
    id: 'hold-1',
    venueId: 'venue-A',
    eventId: 'event-1',
    heldBy: 'coord-1',
    status: 'active',
    startDatetime: new Date('2026-10-10T10:00:00Z'),
    endDatetime: new Date('2026-10-10T12:00:00Z'),
    expiresAt: hoursFrom(NOW, 48),
    expiryWarningSentAt: null,
    ...overrides,
  };
}

describe('configuration', () => {
  test('defaults: 72h hold, 24h warning, 60s sweep', () => {
    expect(getHoldConfig({})).toEqual({ defaultDurationHours: 72, warningHours: 24, sweepIntervalMs: 60000 });
  });

  test('reads overrides from the environment and ignores invalid values', () => {
    expect(
      getHoldConfig({ HOLD_DEFAULT_DURATION_HOURS: '12', HOLD_EXPIRY_WARNING_HOURS: '2', HOLD_EXPIRY_SWEEP_INTERVAL_MS: 'x' })
    ).toEqual({ defaultDurationHours: 12, warningHours: 2, sweepIntervalMs: 60000 });
    expect(getHoldConfig({ HOLD_DEFAULT_DURATION_HOURS: '-5' }).defaultDurationHours).toBe(72);
  });
});

describe('AC1 — Expiry required', () => {
  const start = new Date('2026-10-10T10:00:00Z');

  test('a hold without a requested expiry gets the default window', () => {
    expect(resolveHoldExpiry({ start, now: NOW, defaultDurationHours: 72 })).toEqual(hoursFrom(NOW, 72));
    expect(resolveHoldExpiry({ requestedExpiresAt: '', start, now: NOW, defaultDurationHours: 72 })).toEqual(
      hoursFrom(NOW, 72)
    );
  });

  test('the default never runs past the start of the held slot', () => {
    const soon = hoursFrom(NOW, 5);
    expect(resolveHoldExpiry({ start: soon, now: NOW, defaultDurationHours: 72 })).toEqual(soon);
  });

  test('an explicit expiry is kept when valid', () => {
    const expiresAt = hoursFrom(NOW, 10);
    expect(resolveHoldExpiry({ requestedExpiresAt: expiresAt.toISOString(), start, now: NOW })).toEqual(expiresAt);
  });

  test.each([
    ['in the past', '2026-09-30T00:00:00Z', /in the future/],
    ['exactly now', NOW.toISOString(), /in the future/],
    ['after the slot starts', '2026-10-11T00:00:00Z', /cannot be later than the start/],
    ['not a date', 'not-a-date', /valid ISO8601/],
  ])('rejects an explicit expiry %s', (_label, requestedExpiresAt, message) => {
    expect(() => resolveHoldExpiry({ requestedExpiresAt, start, now: NOW })).toThrow(message);
  });

  test('rejects a hold on a slot that has already started', () => {
    const err = (() => {
      try {
        resolveHoldExpiry({ start: hoursFrom(NOW, -1), now: NOW });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(HoldExpiryError);
    expect(err.status).toBe(400);
  });
});

describe('AC2 / AC4 — Active hold blocks, expired hold releases the slot', () => {
  const venue = { id: 'venue-A', status: 'available', setupMinutes: 0, teardownMinutes: 0 };
  const check = (h, now) =>
    findVenueConflicts({ venue, start: h.startDatetime, end: h.endDatetime, holds: [h], now }).hasConflict;

  test('blocks the slot before the deadline', () => {
    expect(check(hold(), NOW)).toBe(true);
  });

  test('stops blocking at the exact deadline, before any sweep runs', () => {
    const h = hold({ expiresAt: hoursFrom(NOW, 1) });
    expect(check(h, hoursFrom(NOW, 1))).toBe(false);
    expect(isHoldActive(h, hoursFrom(NOW, 1))).toBe(false);
  });

  test('an expired-status hold never blocks', () => {
    expect(check(hold({ status: 'expired' }), NOW)).toBe(false);
  });
});

describe('AC3 / AC5 — Automatic expiry, not a booking', () => {
  test('due for expiry only when active and the deadline has passed', () => {
    expect(isHoldDueForExpiry(hold({ expiresAt: NOW }), NOW)).toBe(true);
    expect(isHoldDueForExpiry(hold({ expiresAt: hoursFrom(NOW, -1) }), NOW)).toBe(true);
    expect(isHoldDueForExpiry(hold(), NOW)).toBe(false);
    expect(isHoldDueForExpiry(hold({ status: 'released', expiresAt: hoursFrom(NOW, -1) }), NOW)).toBe(false);
  });

  test('lifecycle state reads expired once the deadline passes, never converted', () => {
    expect(holdLifecycleState(hold(), NOW)).toBe('active');
    expect(holdLifecycleState(hold({ expiresAt: hoursFrom(NOW, -1) }), NOW)).toBe('expired');
    expect(holdLifecycleState(hold({ status: 'expired' }), NOW)).toBe('expired');
    expect(holdLifecycleState(hold({ status: 'released', expiresAt: hoursFrom(NOW, -1) }), NOW)).toBe('released');
  });

  test('the expiry message states the slot is released and not booked', () => {
    const msg = expiredMessage({ hold: hold(), venueName: 'Hall', eventName: 'Gala' });
    expect(msg).toMatch(/Hall/);
    expect(msg).toMatch(/"Gala"/);
    expect(msg).toMatch(/released/);
    expect(msg).toMatch(/NOT booked/);
  });
});

describe('AC6 — Coordinator notification', () => {
  test('warns once the deadline is inside the warning window', () => {
    expect(needsExpiryWarning(hold({ expiresAt: hoursFrom(NOW, 23) }), NOW, 24)).toBe(true);
    expect(needsExpiryWarning(hold({ expiresAt: hoursFrom(NOW, 24) }), NOW, 24)).toBe(true);
    expect(needsExpiryWarning(hold({ expiresAt: hoursFrom(NOW, 25) }), NOW, 24)).toBe(false);
  });

  test('does not warn twice, after expiry, or for inactive holds', () => {
    const soon = hoursFrom(NOW, 1);
    expect(needsExpiryWarning(hold({ expiresAt: soon, expiryWarningSentAt: NOW }), NOW, 24)).toBe(false);
    expect(needsExpiryWarning(hold({ expiresAt: hoursFrom(NOW, -1) }), NOW, 24)).toBe(false);
    expect(needsExpiryWarning(hold({ expiresAt: soon, status: 'released' }), NOW, 24)).toBe(false);
    expect(needsExpiryWarning(hold({ expiresAt: null }), NOW, 24)).toBe(false);
  });

  test('uses the configured warning window by default', () => {
    expect(needsExpiryWarning(hold({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) }))).toBe(true);
  });

  test("notifies the event's coordinator and the holder, once each", () => {
    expect(holdRecipients(hold(), { coordinatorId: 'coord-2' })).toEqual(['coord-2', 'coord-1']);
    expect(holdRecipients(hold(), { coordinatorId: 'coord-1' })).toEqual(['coord-1']);
    expect(holdRecipients(hold({ eventId: null }), null)).toEqual(['coord-1']);
    expect(holdRecipients(hold({ heldBy: null }), null)).toEqual([]);
  });

  test('the warning message gives the deadline and the consequence', () => {
    const h = hold({ expiresAt: hoursFrom(NOW, 5) });
    const msg = expiryWarningMessage({ hold: h, venueName: 'Hall', eventName: null });
    expect(msg).toMatch(h.expiresAt.toISOString());
    expect(msg).toMatch(/will expire/);
    expect(msg).not.toMatch(/for "/);
    expect(expiryWarningMessage({ hold: h })).toMatch(/the venue/);
  });
});
