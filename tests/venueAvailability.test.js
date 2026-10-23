const {
  computeAvailability,
  getOccupiedWindow,
  findReservationConflicts,
  buildAvailabilitySlots,
  AVAILABILITY_STATES,
} = require('../src/utils/venueAvailability');

function venue(overrides = {}) {
  return {
    id: 'venue-1',
    status: 'available',
    setupMinutes: 30,
    teardownMinutes: 30,
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    venueId: 'venue-1',
    status: 'confirmed',
    startDatetime: '2026-10-01T10:00:00Z',
    endDatetime: '2026-10-01T14:00:00Z',
    ...overrides,
  };
}

describe('computeAvailability', () => {
  test('a venue under maintenance is never available, even with no proposed window', () => {
    const result = computeAvailability(venue({ status: 'maintenance' }), []);
    expect(result.isAvailable).toBe(false);
  });

  test('a venue under maintenance is never available, even with a free proposed window', () => {
    const result = computeAvailability(
      venue({ status: 'blocked' }),
      [],
      new Date('2026-11-01T00:00:00Z'),
      new Date('2026-11-01T01:00:00Z')
    );
    expect(result.isAvailable).toBe(false);
  });

  test('an available venue with no proposed window and no bookings is available', () => {
    const result = computeAvailability(venue(), []);
    expect(result.isAvailable).toBe(true);
  });

  test('a proposed window fully inside a confirmed booking conflicts', () => {
    const result = computeAvailability(
      venue(),
      [event()],
      new Date('2026-10-01T11:00:00Z'),
      new Date('2026-10-01T12:00:00Z')
    );
    expect(result.isAvailable).toBe(false);
    expect(result.conflictingEvents).toHaveLength(1);
  });

  test('a proposed window well clear of the booking (and its buffers) does not conflict', () => {
    const result = computeAvailability(
      venue(),
      [event()],
      new Date('2026-10-01T15:00:00Z'),
      new Date('2026-10-01T16:00:00Z')
    );
    expect(result.isAvailable).toBe(true);
    expect(result.conflictingEvents).toHaveLength(0);
  });

  test('a proposed window overlapping only the teardown buffer still conflicts', () => {
    // Event ends 14:00, teardownMinutes=30 -> occupied until 14:30.
    const result = computeAvailability(
      venue(),
      [event()],
      new Date('2026-10-01T14:15:00Z'),
      new Date('2026-10-01T14:45:00Z')
    );
    expect(result.isAvailable).toBe(false);
  });

  test('a proposed window overlapping only the setup buffer still conflicts', () => {
    // Event starts 10:00, setupMinutes=30 -> occupied from 09:30.
    const result = computeAvailability(
      venue(),
      [event()],
      new Date('2026-10-01T09:15:00Z'),
      new Date('2026-10-01T09:45:00Z')
    );
    expect(result.isAvailable).toBe(false);
  });

  test("a proposed window whose own teardown runs into the existing booking's setup conflicts", () => {
    // Proposed 09:00-09:30 + 30 min teardown -> occupies until 10:00,
    // which overlaps the existing booking's setup from 09:30.
    const result = computeAvailability(
      venue(),
      [event()],
      new Date('2026-10-01T09:00:00Z'),
      new Date('2026-10-01T09:30:00Z')
    );
    expect(result.isAvailable).toBe(false);
  });

  test("a proposed window whose teardown ends exactly as the existing setup begins does not conflict", () => {
    // Proposed 08:30-09:00 + 30 min teardown -> occupied until 09:30,
    // exactly when the existing booking's setup begins.
    const result = computeAvailability(
      venue(),
      [event()],
      new Date('2026-10-01T08:30:00Z'),
      new Date('2026-10-01T09:00:00Z')
    );
    expect(result.isAvailable).toBe(true);
  });

  test('an active tentative hold or unavailability period passed in makes the venue unavailable', () => {
    const qs = new Date('2026-10-02T10:00:00Z');
    const qe = new Date('2026-10-02T11:00:00Z');
    const hold = { venueId: 'venue-1', status: 'active', startDatetime: qs, endDatetime: qe };
    const period = { venueId: 'venue-1', startDatetime: qs, endDatetime: qe, reason: 'Maintenance' };

    expect(computeAvailability(venue(), [], qs, qe, { holds: [hold] }).isAvailable).toBe(false);
    expect(computeAvailability(venue(), [], qs, qe, { unavailability: [period] }).isAvailable).toBe(false);
  });

  test('a cancelled booking never blocks the venue', () => {
    const result = computeAvailability(
      venue(),
      [event({ status: 'cancelled' })],
      new Date('2026-10-01T11:00:00Z'),
      new Date('2026-10-01T12:00:00Z')
    );
    expect(result.isAvailable).toBe(true);
    expect(result.conflictingEvents).toHaveLength(0);
  });

  test('venues with zero setup/teardown minutes only conflict on exact overlap', () => {
    const zeroBufferVenue = venue({ setupMinutes: 0, teardownMinutes: 0 });
    const noConflict = computeAvailability(
      zeroBufferVenue,
      [event()],
      new Date('2026-10-01T14:00:00Z'),
      new Date('2026-10-01T15:00:00Z')
    );
    expect(noConflict.isAvailable).toBe(true);

    const conflict = computeAvailability(
      zeroBufferVenue,
      [event()],
      new Date('2026-10-01T13:59:00Z'),
      new Date('2026-10-01T15:00:00Z')
    );
    expect(conflict.isAvailable).toBe(false);
  });

  test('calendar slots show a tentative hold including setup and turnaround time', () => {
    const slots = buildAvailabilitySlots(
      venue(),
      [event({ status: 'planning' })],
      '2026-10-01T09:00:00Z',
      '2026-10-01T15:00:00Z'
    );

    expect(slots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state: AVAILABILITY_STATES.TENTATIVE_HOLD,
        displayState: 'Tentative Hold',
        startDateTime: '2026-10-01T09:30:00.000Z',
        endDateTime: '2026-10-01T14:30:00.000Z',
        isAvailable: false,
      }),
    ]));
  });

  test('calendar slots distinguish confirmed, expired, and temporarily unavailable states', () => {
    const rangeStart = '2026-10-01T09:00:00Z';
    const rangeEnd = '2026-10-01T15:00:00Z';
    const confirmed = buildAvailabilitySlots(venue(), [event()], rangeStart, rangeEnd);
    expect(confirmed.find((slot) => slot.state === AVAILABILITY_STATES.CONFIRMED_BOOKING)).toBeTruthy();

    const expired = buildAvailabilitySlots(venue(), [event({ status: 'cancelled' })], rangeStart, rangeEnd);
    expect(expired.find((slot) => slot.state === AVAILABILITY_STATES.EXPIRED_HOLD)).toMatchObject({ isAvailable: true });

    const unavailable = buildAvailabilitySlots(venue({ status: 'maintenance' }), [], rangeStart, rangeEnd);
    expect(unavailable).toEqual([expect.objectContaining({
      state: AVAILABILITY_STATES.TEMPORARILY_UNAVAILABLE,
      displayState: 'Temporarily Unavailable',
      isAvailable: false,
    })]);
  });

  test('a 10:00–12:00 event with 30-minute setup and 45-minute turnaround occupies 09:30–12:45', () => {
    const occupied = getOccupiedWindow(
      event({ startDatetime: '2026-10-01T10:00:00Z', endDatetime: '2026-10-01T12:00:00Z' }),
      venue({ setupMinutes: 30, teardownMinutes: 45 })
    );
    expect(occupied.start.toISOString()).toBe('2026-10-01T09:30:00.000Z');
    expect(occupied.end.toISOString()).toBe('2026-10-01T12:45:00.000Z');
  });

  test('effective occupied-window conflicts are retained and identified for existing reservations', () => {
    const configuredVenue = venue({ setupMinutes: 30, teardownMinutes: 45 });
    const conflicts = findReservationConflicts(configuredVenue, [
      event({ id: 'confirmed-event', startDatetime: '2026-10-01T10:00:00Z', endDatetime: '2026-10-01T12:00:00Z' }),
      event({ id: 'tentative-event', status: 'planning', startDatetime: '2026-10-01T13:00:00Z', endDatetime: '2026-10-01T14:00:00Z' }),
    ]);

    expect(conflicts).toEqual([expect.objectContaining({
      eventIds: expect.arrayContaining(['confirmed-event', 'tentative-event']),
    })]);
  });
});
