// Unit tests for Venue Schedule Conflict Identification (pure rules).
// Grouped by acceptance criterion so each AC traces to its tests.

const {
  CONFLICT_TYPES,
  windowsOverlap,
  getEffectiveWindow,
  isHoldActive,
  findVenueConflicts,
  findConflictsForVenues,
  findAffectedByUnavailability,
} = require('../src/utils/venueConflicts');

const NOW = new Date('2026-10-01T00:00:00Z');
const at = (hhmm, day = '2026-10-10') => new Date(`${day}T${hhmm}:00Z`);

function venue(overrides = {}) {
  return { id: 'venue-A', status: 'available', setupMinutes: 30, teardownMinutes: 30, ...overrides };
}

// Existing confirmed booking in venue A, 10:00-14:00 (effective 09:30-14:30).
function booking(overrides = {}) {
  return {
    id: 'event-1',
    venueId: 'venue-A',
    status: 'confirmed',
    startDatetime: at('10:00'),
    endDatetime: at('14:00'),
    ...overrides,
  };
}

function hold(overrides = {}) {
  return {
    id: 'hold-1',
    venueId: 'venue-A',
    eventId: null,
    status: 'active',
    startDatetime: at('10:00'),
    endDatetime: at('14:00'),
    expiresAt: null,
    ...overrides,
  };
}

function unavailable(overrides = {}) {
  return {
    id: 'period-1',
    venueId: 'venue-A',
    startDatetime: at('10:00'),
    endDatetime: at('14:00'),
    reason: 'Air-conditioning repair',
    ...overrides,
  };
}

function check(args) {
  return findVenueConflicts({ venue: venue(), now: NOW, ...args });
}

describe('helpers', () => {
  test('windowsOverlap treats windows as half-open (touching is not overlapping)', () => {
    expect(windowsOverlap(at('09:00'), at('10:00'), at('10:00'), at('11:00'))).toBe(false);
    expect(windowsOverlap(at('09:00'), at('10:01'), at('10:00'), at('11:00'))).toBe(true);
    expect(windowsOverlap('2026-10-10T09:00:00Z', '2026-10-10T12:00:00Z', at('10:00'), at('11:00'))).toBe(true);
  });

  test('getOccupiedWindow (search adapter) buffers an event by the venue setup/teardown', () => {
    const { getOccupiedWindow } = require('../src/utils/venueAvailability');
    expect(getOccupiedWindow(booking(), venue())).toEqual({ start: at('09:30'), end: at('14:30') });
  });

  test('findAffectedByUnavailability defaults to no records and the current time', () => {
    expect(findAffectedByUnavailability({ venue: venue(), start: at('10:00'), end: at('11:00') })).toEqual([]);
  });

  test('getEffectiveWindow defaults missing buffers to zero', () => {
    const w = getEffectiveWindow(at('10:00'), at('11:00'), { id: 'v' });
    expect(w).toEqual({ start: at('10:00'), end: at('11:00') });
  });
});

describe('AC — Setup/turnaround: effective occupied period', () => {
  test('reports the proposed booking effective window including setup and teardown', () => {
    const result = check({ start: at('16:00'), end: at('18:00') });
    expect(result.effectiveWindow).toEqual({ start: at('15:30'), end: at('18:30') });
    expect(result.hasConflict).toBe(false);
  });

  test('direct overlap with a confirmed booking conflicts', () => {
    const result = check({ start: at('11:00'), end: at('12:00'), events: [booking()] });
    expect(result.hasConflict).toBe(true);
    expect(result.conflicts[0]).toMatchObject({
      type: CONFLICT_TYPES.BOOKING,
      id: 'event-1',
      effectiveStart: at('09:30'),
      effectiveEnd: at('14:30'),
    });
  });

  test("starting right after the existing published end conflicts with its turnaround + our setup", () => {
    // Existing ends 14:00 (+30 teardown = 14:30). Proposed 14:30 needs setup from 14:00.
    expect(check({ start: at('14:30'), end: at('16:00'), events: [booking()] }).hasConflict).toBe(true);
  });

  test('a gap equal to teardown + setup is exactly enough (boundary)', () => {
    // Existing effective end 14:30; proposed 15:00 - 30 setup = 14:30.
    expect(check({ start: at('15:00'), end: at('16:00'), events: [booking()] }).hasConflict).toBe(false);
    // One minute less is not enough.
    expect(check({ start: at('14:59'), end: at('16:00'), events: [booking()] }).hasConflict).toBe(true);
  });

  test('ending right before the existing published start conflicts with setup buffers', () => {
    expect(check({ start: at('08:00'), end: at('09:30'), events: [booking()] }).hasConflict).toBe(true);
    expect(check({ start: at('08:00'), end: at('09:00'), events: [booking()] }).hasConflict).toBe(false);
  });

  test("uses the venue's own buffer lengths", () => {
    const longTurnaround = venue({ setupMinutes: 60, teardownMinutes: 120 });
    // Existing effective 09:00-16:00; proposed 17:00 - 60 = 16:00 -> touching, ok.
    expect(
      findVenueConflicts({ venue: longTurnaround, start: at('17:00'), end: at('18:00'), events: [booking()] })
        .hasConflict
    ).toBe(false);
    expect(
      findVenueConflicts({ venue: longTurnaround, start: at('16:30'), end: at('18:00'), events: [booking()] })
        .hasConflict
    ).toBe(true);
  });

  test('zero-buffer venues only conflict on a real overlap', () => {
    const noBuffer = venue({ setupMinutes: 0, teardownMinutes: 0 });
    const run = (s, e) =>
      findVenueConflicts({ venue: noBuffer, start: s, end: e, events: [booking()] }).hasConflict;
    expect(run(at('14:00'), at('15:00'))).toBe(false);
    expect(run(at('13:59'), at('15:00'))).toBe(true);
  });

  test('cancelled bookings never conflict; every other non-cancelled status does', () => {
    const window = { start: at('11:00'), end: at('12:00') };
    expect(check({ ...window, events: [booking({ status: 'cancelled' })] }).hasConflict).toBe(false);
    for (const status of ['planning', 'awaiting_arrangements', 'confirmed', 'completed']) {
      expect(check({ ...window, events: [booking({ status })] }).hasConflict).toBe(true);
    }
  });

  test('excludeEventId lets an event be re-checked without conflicting with itself', () => {
    const result = check({
      start: at('10:00'),
      end: at('15:00'),
      events: [booking()],
      excludeEventId: 'event-1',
    });
    expect(result.hasConflict).toBe(false);
  });
});

describe('AC — Tentative holds', () => {
  test('an active hold with no expiry conflicts', () => {
    const result = check({ start: at('11:00'), end: at('12:00'), holds: [hold()] });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ type: CONFLICT_TYPES.TENTATIVE_HOLD, id: 'hold-1' });
  });

  test('an active hold that has not yet expired conflicts', () => {
    const result = check({
      start: at('11:00'),
      end: at('12:00'),
      holds: [hold({ expiresAt: new Date('2026-10-05T00:00:00Z') })],
    });
    expect(result.hasConflict).toBe(true);
    expect(result.conflicts[0].expiresAt).toEqual(new Date('2026-10-05T00:00:00Z'));
  });

  test('an expired hold does not conflict (expiry is exclusive at "now")', () => {
    expect(
      check({ start: at('11:00'), end: at('12:00'), holds: [hold({ expiresAt: NOW })] }).hasConflict
    ).toBe(false);
  });

  test('released and converted holds do not conflict', () => {
    for (const status of ['released', 'converted']) {
      expect(check({ start: at('11:00'), end: at('12:00'), holds: [hold({ status })] }).hasConflict).toBe(false);
    }
  });

  test("holds are buffered with the venue's setup/turnaround too", () => {
    expect(check({ start: at('14:30'), end: at('16:00'), holds: [hold()] }).hasConflict).toBe(true);
    expect(check({ start: at('15:00'), end: at('16:00'), holds: [hold()] }).hasConflict).toBe(false);
  });

  test("an event's own hold and an explicitly excluded hold are ignored", () => {
    const own = hold({ eventId: 'event-9' });
    expect(
      check({ start: at('11:00'), end: at('12:00'), holds: [own], excludeEventId: 'event-9' }).hasConflict
    ).toBe(false);
    expect(
      check({ start: at('11:00'), end: at('12:00'), holds: [hold()], excludeHoldId: 'hold-1' }).hasConflict
    ).toBe(false);
  });

  test('isHoldActive uses the current time by default', () => {
    expect(isHoldActive(hold({ expiresAt: new Date(Date.now() + 60000) }))).toBe(true);
    expect(isHoldActive(hold({ expiresAt: new Date(Date.now() - 60000) }))).toBe(false);
  });
});

describe('AC — Venue unavailability', () => {
  test('a booking overlapping an unavailability period conflicts and reports the reason', () => {
    const result = check({ start: at('11:00'), end: at('12:00'), unavailability: [unavailable()] });
    expect(result.conflicts[0]).toMatchObject({
      type: CONFLICT_TYPES.UNAVAILABILITY,
      id: 'period-1',
      reason: 'Air-conditioning repair',
    });
  });

  test("the proposed booking's setup cannot run into an unavailability period", () => {
    // Unavailable until 14:00 (no buffer on the period itself); proposed 14:15 needs setup from 13:45.
    expect(check({ start: at('14:15'), end: at('16:00'), unavailability: [unavailable()] }).hasConflict).toBe(true);
    expect(check({ start: at('14:30'), end: at('16:00'), unavailability: [unavailable()] }).hasConflict).toBe(false);
  });

  test('a venue marked maintenance/blocked conflicts regardless of time', () => {
    const result = findVenueConflicts({
      venue: venue({ status: 'maintenance' }),
      start: at('20:00', '2027-01-01'),
      end: at('21:00', '2027-01-01'),
    });
    expect(result.conflicts).toEqual([
      expect.objectContaining({ type: CONFLICT_TYPES.VENUE_STATUS, venueStatus: 'maintenance' }),
    ]);
  });

  test('reports every conflict, not just the first', () => {
    const result = check({
      start: at('11:00'),
      end: at('12:00'),
      events: [booking()],
      holds: [hold()],
      unavailability: [unavailable()],
    });
    expect(result.conflicts.map((c) => c.type).sort()).toEqual(
      ['booking', 'tentative_hold', 'unavailability'].sort()
    );
  });

  test('findAffectedByUnavailability lists bookings and active holds a new block clashes with', () => {
    const affected = findAffectedByUnavailability({
      venue: venue(),
      start: at('14:10'), // inside the booking's teardown buffer
      end: at('15:00'),
      events: [booking(), booking({ id: 'event-x', status: 'cancelled' })],
      holds: [hold({ id: 'hold-live' }), hold({ id: 'hold-gone', status: 'released' })],
      now: NOW,
    });
    expect(affected.map((a) => a.id).sort()).toEqual(['event-1', 'hold-live']);
  });
});

describe('works with ORM instances (getter-backed fields)', () => {
  // Sequelize exposes columns as prototype getters, so `{ ...instance }`
  // silently drops them. Regression test: the rules must read the venue
  // directly rather than copying it.
  class FakeModel {
    constructor(data) {
      this.dataValues = data;
    }
    get id() { return this.dataValues.id; }
    get status() { return this.dataValues.status; }
    get setupMinutes() { return this.dataValues.setupMinutes; }
    get teardownMinutes() { return this.dataValues.teardownMinutes; }
  }

  test('buffers and venue id are honoured for a getter-backed venue', () => {
    const ormVenue = new FakeModel(venue());
    const affected = findAffectedByUnavailability({
      venue: ormVenue,
      start: at('14:15'),
      end: at('15:00'),
      events: [booking()],
      now: NOW,
    });
    expect(affected.map((a) => a.id)).toEqual(['event-1']);

    const { computeAvailability } = require('../src/utils/venueAvailability');
    const result = computeAvailability(ormVenue, [booking()], at('14:30'), at('15:00'));
    expect(result.conflictingEvents).toHaveLength(1);
  });
});

describe('AC — Multiple venues', () => {
  const venueA = venue({ id: 'venue-A' });
  const venueB = venue({ id: 'venue-B', setupMinutes: 0, teardownMinutes: 0 });

  test('each venue is evaluated independently, with its own records and buffers', () => {
    const result = findConflictsForVenues({
      venues: [venueA, venueB],
      start: at('14:15'),
      end: at('16:00'),
      events: [booking({ venueId: 'venue-A' }), booking({ id: 'event-2', venueId: 'venue-B' })],
      now: NOW,
    });
    // Same booking time in both venues, but only A's 30-min turnaround causes a clash.
    expect(result.hasConflicts).toBe(true);
    expect(result.venues.map((v) => [v.venueId, v.hasConflict])).toEqual([
      ['venue-A', true],
      ['venue-B', false],
    ]);
    expect(result.venues[1].effectiveWindow).toEqual({ start: at('14:15'), end: at('16:00') });
  });

  test("records for one venue are never reported against another", () => {
    const result = findConflictsForVenues({
      venues: [venueA, venueB],
      start: at('11:00'),
      end: at('12:00'),
      events: [booking({ venueId: 'venue-A' })],
      holds: [hold({ venueId: 'venue-A' })],
      unavailability: [unavailable({ venueId: 'venue-A' })],
      now: NOW,
    });
    expect(result.venues[0].conflicts).toHaveLength(3);
    expect(result.venues[1].conflicts).toHaveLength(0);
  });

  test('a single-venue check ignores records tagged with a different venueId', () => {
    const result = check({
      start: at('11:00'),
      end: at('12:00'),
      events: [booking({ venueId: 'venue-Z' })],
      holds: [hold({ venueId: 'venue-Z' })],
      unavailability: [unavailable({ venueId: 'venue-Z' })],
    });
    expect(result.hasConflict).toBe(false);
  });

  test('hasConflicts is false only when every venue is clear', () => {
    const result = findConflictsForVenues({ venues: [venueA, venueB], start: at('11:00'), end: at('12:00') });
    expect(result.hasConflicts).toBe(false);
  });
});
