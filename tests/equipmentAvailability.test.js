// Unit tests for src/utils/equipmentAvailability.js
// Traceability: describe blocks are named after the story + AC they cover.
const {
  EQUIPMENT_STATUSES,
  MANUAL_EQUIPMENT_STATUSES,
  windowsOverlap,
  isLiveReservation,
  overlappingReservations,
  reservablePool,
  availableQuantityInWindow,
  deriveCatalogueStatus,
  nonReservableReason,
  isSelectableForReservation,
  parseStatusFilter,
  allocationSummary,
  peakConcurrentQuantity,
  sameType,
} = require('../src/utils/equipmentAvailability');

const T = (h, m = 0) => new Date(Date.UTC(2027, 4, 10, h, m));
const item = (o = {}) => ({ id: 'e1', name: 'Projector', status: 'available', quantityTotal: 1, quantityAvailable: 1, ...o });
const res = (o = {}) => ({ id: 'r1', status: 'active', quantity: 1, startDatetime: T(10), endDatetime: T(12), ...o });

describe('SCRUM-24 AC1/AC2 — plain time-slot overlap, no transit buffer', () => {
  test('overlapping windows conflict', () => {
    expect(windowsOverlap(T(10), T(12), T(11), T(13))).toBe(true);
    expect(windowsOverlap(T(10), T(12), T(9), T(10, 1))).toBe(true);
  });
  test('containment conflicts both ways', () => {
    expect(windowsOverlap(T(9), T(17), T(10), T(11))).toBe(true);
    expect(windowsOverlap(T(10), T(11), T(9), T(17))).toBe(true);
  });
  test('back-to-back windows do NOT conflict (no buffer added)', () => {
    expect(windowsOverlap(T(10), T(12), T(12), T(14))).toBe(false);
    expect(windowsOverlap(T(12), T(14), T(10), T(12))).toBe(false);
  });
  test('a one-minute gap is enough — no transit time is assumed', () => {
    expect(windowsOverlap(T(10), T(12), T(12, 1), T(14))).toBe(false);
  });
  test('accepts ISO strings as well as Dates', () => {
    expect(windowsOverlap('2027-05-10T10:00:00Z', '2027-05-10T12:00:00Z', T(11), T(13))).toBe(true);
  });
});

describe('SCRUM-21 AC2 — overlapping reservations and free quantity', () => {
  test('cancelled reservations are ignored', () => {
    expect(overlappingReservations([res({ status: 'cancelled' })], T(10), T(12))).toHaveLength(0);
  });
  test('excludeId skips the reservation being re-checked', () => {
    expect(overlappingReservations([res()], T(10), T(12), { excludeId: 'r1' })).toHaveLength(0);
  });
  test('single-unit item: one overlapping reservation leaves 0 free', () => {
    expect(availableQuantityInWindow(item(), [res()], T(11), T(13))).toBe(0);
  });
  test('single-unit item: non-overlapping reservation leaves 1 free', () => {
    expect(availableQuantityInWindow(item(), [res()], T(12), T(14))).toBe(1);
  });
  test('multi-unit item subtracts reserved quantity', () => {
    const it = item({ quantityTotal: 5, quantityAvailable: 5 });
    expect(availableQuantityInWindow(it, [res({ quantity: 2 }), res({ id: 'r2', quantity: 1 })], T(10), T(11))).toBe(2);
  });
  test('never negative', () => {
    expect(availableQuantityInWindow(item(), [res({ quantity: 3 })], T(10), T(11))).toBe(0);
  });
  test('missing quantity counts as 1', () => {
    expect(availableQuantityInWindow(item({ quantityAvailable: 2, quantityTotal: 2 }), [res({ quantity: undefined })], T(10), T(11))).toBe(1);
  });
});

describe('SCRUM-21 AC1/AC5 — catalogue status follows live reservations', () => {
  test('available -> reserved when a live reservation exists', () => {
    expect(deriveCatalogueStatus('available', true)).toBe('reserved');
  });
  test('reserved -> available when none remain', () => {
    expect(deriveCatalogueStatus('reserved', false)).toBe('available');
  });
  test('in_repair / unavailable are never overwritten', () => {
    expect(deriveCatalogueStatus('in_repair', true)).toBe('in_repair');
    expect(deriveCatalogueStatus('unavailable', false)).toBe('unavailable');
  });
  test('isLiveReservation: active and not yet ended', () => {
    const now = T(11);
    expect(isLiveReservation(res(), now)).toBe(true);
    expect(isLiveReservation(res({ status: 'cancelled' }), now)).toBe(false);
    expect(isLiveReservation(res({ endDatetime: T(10) }), now)).toBe(false);
  });
});

describe('SCRUM-22 AC1/AC2 — in-repair and unavailable items', () => {
  test('status vocabulary', () => {
    expect(EQUIPMENT_STATUSES).toEqual(['available', 'reserved', 'in_repair', 'unavailable']);
    expect(MANUAL_EQUIPMENT_STATUSES).not.toContain('reserved');
  });
  test('reservable pool is 0 for in_repair / unavailable', () => {
    expect(reservablePool(item({ status: 'in_repair' }))).toBe(0);
    expect(reservablePool(item({ status: 'unavailable' }))).toBe(0);
    expect(reservablePool(item({ status: 'reserved', quantityAvailable: 3, quantityTotal: 3 }))).toBe(3);
  });
  test('pool falls back to quantityTotal when quantityAvailable is missing', () => {
    expect(reservablePool({ status: 'available', quantityTotal: 4 })).toBe(4);
  });
  test('nonReservableReason explains why', () => {
    expect(nonReservableReason(item({ status: 'in_repair' }))).toMatch(/in repair/);
    expect(nonReservableReason(item({ status: 'unavailable' }))).toMatch(/unavailable/);
    expect(nonReservableReason(item())).toBeNull();
    expect(nonReservableReason(item({ status: 'reserved' }))).toBeNull();
  });
  test('selectable list excludes in_repair / unavailable', () => {
    expect(isSelectableForReservation(item({ status: 'in_repair' }))).toBe(false);
    expect(isSelectableForReservation(item({ status: 'unavailable' }))).toBe(false);
    expect(isSelectableForReservation(item())).toBe(true);
  });
  test('selectable with a window excludes fully-booked items', () => {
    const w = { startDatetime: T(11), endDatetime: T(12) };
    expect(isSelectableForReservation(item(), [res()], w)).toBe(false);
    expect(isSelectableForReservation(item(), [res()], { startDatetime: T(13), endDatetime: T(14) })).toBe(true);
  });
  test('item with zero units in service is not selectable', () => {
    expect(isSelectableForReservation(item({ quantityAvailable: 0 }))).toBe(false);
  });
});

describe('SCRUM-22 AC3 — status filter parsing', () => {
  test('empty / all means no filter', () => {
    expect(parseStatusFilter(undefined)).toEqual({ statuses: null });
    expect(parseStatusFilter('')).toEqual({ statuses: null });
    expect(parseStatusFilter('all')).toEqual({ statuses: null });
  });
  test('single and comma-separated values, trimmed and lower-cased', () => {
    expect(parseStatusFilter('available')).toEqual({ statuses: ['available'] });
    expect(parseStatusFilter(' Available , in_repair ')).toEqual({ statuses: ['available', 'in_repair'] });
  });
  test('unknown values are rejected', () => {
    expect(parseStatusFilter('broken').error).toMatch(/Unknown status filter: broken/);
  });
});

describe('SCRUM-24 AC3 — allocation summary for technical readiness', () => {
  const lines = [
    { id: 'q1', equipmentType: 'AV', quantityRequested: 2 },
    { id: 'q2', equipmentType: 'Audio', quantityRequested: 1, equipmentId: 'm1' },
  ];
  test('no lines means fully allocated (nothing requested)', () => {
    const s = allocationSummary([], []);
    expect(s.fullyAllocated).toBe(true);
    expect(s.lines).toEqual([]);
  });
  test('partial allocation is not complete and reports the shortfall', () => {
    const s = allocationSummary(lines, [res({ equipmentRequestId: 'q1', quantity: 1 })]);
    expect(s.fullyAllocated).toBe(false);
    expect(s.lines[0]).toMatchObject({ quantityAllocated: 1, shortfall: 1, fullyAllocated: false });
    expect(s.outstanding.map((l) => l.equipmentRequestId)).toEqual(['q1', 'q2']);
  });
  test('cancelled reservations do not count', () => {
    const s = allocationSummary(lines, [
      res({ equipmentRequestId: 'q1', quantity: 2, status: 'cancelled' }),
      res({ id: 'r2', equipmentRequestId: 'q2' }),
    ]);
    expect(s.lines[0].quantityAllocated).toBe(0);
    expect(s.fullyAllocated).toBe(false);
  });
  test('full allocation across several reservations completes', () => {
    const s = allocationSummary(lines, [
      res({ equipmentRequestId: 'q1' }),
      res({ id: 'r2', equipmentRequestId: 'q1' }),
      res({ id: 'r3', equipmentRequestId: 'q2' }),
    ]);
    expect(s.fullyAllocated).toBe(true);
    expect(s.totalRequested).toBe(3);
    expect(s.totalAllocated).toBe(3);
  });
  test('reservations not linked to a line are ignored', () => {
    const s = allocationSummary([lines[0]], [res({ quantity: 2 })]);
    expect(s.fullyAllocated).toBe(false);
  });
});

describe('helpers', () => {
  test('sameType is case/space-insensitive', () => {
    expect(sameType(' av ', 'AV')).toBe(true);
    expect(sameType('AV', 'Audio')).toBe(false);
    expect(sameType(null, '')).toBe(true);
  });
});

describe('BUG-5 — out-of-service items do not count as allocated', () => {
  const line = { id: 'q1', equipmentType: 'Projector', quantityRequested: 1 };
  test.each(['in_repair', 'unavailable'])('reservation on a %s item is reported, not counted', (status) => {
    const s = allocationSummary([line], [res({ equipmentRequestId: 'q1', equipmentStatus: status })]);
    expect(s.fullyAllocated).toBe(false);
    expect(s.lines[0]).toMatchObject({ quantityAllocated: 0, outOfServiceQuantity: 1, shortfall: 1 });
  });
  test('reserved/available items still count', () => {
    const s = allocationSummary([line], [res({ equipmentRequestId: 'q1', equipmentStatus: 'reserved' })]);
    expect(s.fullyAllocated).toBe(true);
    expect(s.lines[0].outOfServiceQuantity).toBe(0);
  });
});

describe('BUG-6 — peak concurrent reserved quantity', () => {
  test('no reservations -> 0', () => expect(peakConcurrentQuantity([])).toBe(0));
  test('overlapping reservations add up', () => {
    expect(peakConcurrentQuantity([
      res({ quantity: 3, startDatetime: T(9), endDatetime: T(12) }),
      res({ id: 'r2', quantity: 2, startDatetime: T(11), endDatetime: T(13) }),
    ])).toBe(5);
  });
  test('back-to-back reservations do not add up', () => {
    expect(peakConcurrentQuantity([
      res({ quantity: 3, startDatetime: T(9), endDatetime: T(12) }),
      res({ id: 'r2', quantity: 4, startDatetime: T(12), endDatetime: T(13) }),
    ])).toBe(4);
  });
  test('cancelled reservations are ignored', () => {
    expect(peakConcurrentQuantity([res({ quantity: 9, status: 'cancelled' }), res({ id: 'r2', quantity: 2 })])).toBe(2);
  });
});
