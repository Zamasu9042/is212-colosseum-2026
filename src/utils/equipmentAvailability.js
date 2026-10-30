/**
 * Pure equipment availability rules shared by the catalogue, the
 * reservation service and the technical-readiness check. No database
 * access here, so every rule is unit-tested directly
 * (tests/equipmentAvailability.test.js).
 *
 * SCRUM-22  Manage Equipment Catalogue Status
 * SCRUM-21  Reserve Equipment for an Event
 * SCRUM-24  Reserve Equipment for Approved Event Window
 */

// All catalogue statuses. 'reserved' is system-managed (see deriveCatalogueStatus).
const EQUIPMENT_STATUSES = ['available', 'reserved', 'in_repair', 'unavailable'];

// Statuses Technical Support Staff may set by hand.
const MANUAL_EQUIPMENT_STATUSES = ['available', 'in_repair', 'unavailable'];

// SCRUM-22 AC1/AC2: these items are never selectable and never reservable.
const NON_RESERVABLE_STATUSES = ['in_repair', 'unavailable'];

const STATUS_LABELS = {
  available: 'Available',
  reserved: 'Reserved',
  in_repair: 'In repair',
  unavailable: 'Unavailable',
};

// An event exists only once its request has been approved. Equipment may be
// reserved while it is being planned or once confirmed, but not after it has
// finished or been cancelled.
const RESERVABLE_EVENT_STATUSES = ['planning', 'awaiting_arrangements', 'confirmed'];

const toMs = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

/**
 * SCRUM-24 AC1/AC2: two windows overlap when each starts before the other
 * ends. There is deliberately NO setup, turnaround or transit buffer, even
 * when the two events are at different venues: [10:00,12:00) and
 * [12:00,14:00) do not overlap, so the same item can go straight from one
 * to the other.
 */
function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  return toMs(aStart) < toMs(bEnd) && toMs(aEnd) > toMs(bStart);
}

function isLiveReservation(reservation, now = new Date()) {
  return reservation.status === 'active' && toMs(reservation.endDatetime) > toMs(now);
}

/** Active reservations of one item that overlap the given window. */
function overlappingReservations(reservations, startDatetime, endDatetime, { excludeId } = {}) {
  return reservations.filter(
    (r) =>
      r.status === 'active' &&
      r.id !== excludeId &&
      windowsOverlap(r.startDatetime, r.endDatetime, startDatetime, endDatetime)
  );
}

/**
 * Units of an item in service and therefore reservable at all. Uses
 * quantityAvailable (units in working order; quantityTotal can include
 * units written off). Zero when the whole item is in repair / unavailable.
 */
function reservablePool(equipment) {
  if (NON_RESERVABLE_STATUSES.includes(equipment.status)) return 0;
  const pool = Number.isInteger(equipment.quantityAvailable)
    ? equipment.quantityAvailable
    : equipment.quantityTotal;
  return Math.max(0, pool || 0);
}

/**
 * How many units remain free in a window after subtracting every
 * overlapping active reservation.
 */
function availableQuantityInWindow(equipment, reservations, startDatetime, endDatetime, opts) {
  const reserved = overlappingReservations(reservations, startDatetime, endDatetime, opts).reduce(
    (sum, r) => sum + (r.quantity || 1),
    0
  );
  return Math.max(0, reservablePool(equipment) - reserved);
}

/**
 * SCRUM-21 AC1/AC5: the catalogue flag follows live reservations, but a
 * manual in_repair/unavailable status always wins and is never overwritten.
 */
function deriveCatalogueStatus(currentStatus, hasLiveReservation) {
  if (NON_RESERVABLE_STATUSES.includes(currentStatus)) return currentStatus;
  return hasLiveReservation ? 'reserved' : 'available';
}

/**
 * SCRUM-22 AC2: why an item cannot be reserved, or null if it can.
 */
function nonReservableReason(equipment) {
  if (equipment.status === 'in_repair') {
    return `${equipment.name} is in repair and cannot be reserved.`;
  }
  if (equipment.status === 'unavailable') {
    return `${equipment.name} is marked unavailable and cannot be reserved.`;
  }
  return null;
}

/**
 * SCRUM-22 AC1: can this item appear in a reservation picker? With a
 * window, it must also have at least one free unit in that window.
 */
function isSelectableForReservation(equipment, reservations = [], window = null) {
  if (NON_RESERVABLE_STATUSES.includes(equipment.status)) return false;
  if (!window) return reservablePool(equipment) > 0;
  return availableQuantityInWindow(equipment, reservations, window.startDatetime, window.endDatetime) > 0;
}

/**
 * Parses a comma-separated ?status= filter. Returns { statuses } or { error }.
 */
function parseStatusFilter(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return { statuses: null };
  const statuses = String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const invalid = statuses.filter((s) => !EQUIPMENT_STATUSES.includes(s));
  if (invalid.length) {
    return { error: `Unknown status filter: ${invalid.join(', ')}. Use one of: ${EQUIPMENT_STATUSES.join(', ')}.` };
  }
  return { statuses };
}

/**
 * SCRUM-24 AC3: allocation per equipment-request line. A line is fully
 * allocated when its active reservations cover the requested quantity.
 * Readiness can be completed only when every line is fully allocated.
 */
function allocationSummary(requests, reservations) {
  const lines = requests.map((req) => {
    const linked = reservations.filter((r) => r.status === 'active' && r.equipmentRequestId === req.id);
    // A reservation on an item that has since gone in_repair/unavailable
    // cannot actually be delivered, so it does not count (SCRUM-22 + SCRUM-24).
    const outOfService = linked.filter((r) => NON_RESERVABLE_STATUSES.includes(r.equipmentStatus));
    const allocated = linked
      .filter((r) => !NON_RESERVABLE_STATUSES.includes(r.equipmentStatus))
      .reduce((sum, r) => sum + (r.quantity || 1), 0);
    const shortfall = Math.max(0, req.quantityRequested - allocated);
    return {
      equipmentRequestId: req.id,
      equipmentType: req.equipmentType,
      equipmentId: req.equipmentId || null,
      quantityRequested: req.quantityRequested,
      quantityAllocated: allocated,
      shortfall,
      fullyAllocated: shortfall === 0,
      outOfServiceQuantity: outOfService.reduce((sum, r) => sum + (r.quantity || 1), 0),
    };
  });
  const outstanding = lines.filter((l) => !l.fullyAllocated);
  return {
    lines,
    totalRequested: lines.reduce((s, l) => s + l.quantityRequested, 0),
    totalAllocated: lines.reduce((s, l) => s + Math.min(l.quantityAllocated, l.quantityRequested), 0),
    fullyAllocated: outstanding.length === 0,
    outstanding,
  };
}

/**
 * Highest number of units committed at any single moment across the given
 * active reservations (sweep over start/end points). Used to stop staff
 * lowering an item's units in service below what is already promised.
 */
function peakConcurrentQuantity(reservations) {
  const points = [];
  for (const r of reservations) {
    if (r.status !== 'active') continue;
    points.push([toMs(r.startDatetime), r.quantity || 1], [toMs(r.endDatetime), -(r.quantity || 1)]);
  }
  // Ends sort before starts at the same instant: touching windows don't overlap.
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of points) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

const sameType = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

module.exports = {
  EQUIPMENT_STATUSES,
  MANUAL_EQUIPMENT_STATUSES,
  NON_RESERVABLE_STATUSES,
  STATUS_LABELS,
  RESERVABLE_EVENT_STATUSES,
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
};
