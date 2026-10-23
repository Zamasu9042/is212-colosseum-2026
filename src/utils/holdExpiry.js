// Manage Expiring Tentative Venue Holds — pure rules, no DB access.
//
// AC1  Every hold has an expiry. If the coordinator does not give one, the
//      hold gets the default window (HOLD_DEFAULT_DURATION_HOURS, 72h),
//      capped at the start of the held slot.
// AC2  A hold blocks its venue/time slot only while active
//      (see isHoldActive in ./venueConflicts.js).
// AC3  Once expiresAt is reached the hold is due for expiry
//      (isHoldDueForExpiry) and the sweep moves it to 'expired'.
// AC4  An expired hold no longer blocks anything — conflict detection
//      ignores it from the exact expiry instant, sweep or no sweep.
// AC5  'expired' is its own lifecycle state, never 'converted'.
// AC6  Coordinators are reminded HOLD_EXPIRY_WARNING_HOURS (24h) before the
//      deadline (needsExpiryWarning) and told again when it expires.
//
// AC7 (what happens to the related booking request) and AC8 (extending a
// hold) are pending customer clarification, so nothing here changes a
// booking request or moves an expiry date once the hold exists.

const HOUR_MS = 60 * 60 * 1000;

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getHoldConfig(env = process.env) {
  return {
    defaultDurationHours: positiveNumber(env.HOLD_DEFAULT_DURATION_HOURS, 72),
    warningHours: positiveNumber(env.HOLD_EXPIRY_WARNING_HOURS, 24),
    sweepIntervalMs: positiveNumber(env.HOLD_EXPIRY_SWEEP_INTERVAL_MS, 60 * 1000),
  };
}

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

class HoldExpiryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HoldExpiryError';
    this.status = 400;
  }
}

/**
 * Works out the expiry for a new hold (AC1).
 *  - An explicit expiresAt must be in the future and no later than the
 *    start of the held slot (a hold that outlives the event start would
 *    never need a decision).
 *  - Otherwise: now + defaultDurationHours, capped at the slot start.
 * Throws HoldExpiryError (400) when no valid expiry exists.
 */
function resolveHoldExpiry({ requestedExpiresAt, start, now = new Date(), defaultDurationHours }) {
  const startAt = toDate(start);
  const nowAt = toDate(now);
  const hours = defaultDurationHours ?? getHoldConfig().defaultDurationHours;

  if (requestedExpiresAt != null && requestedExpiresAt !== '') {
    const expiresAt = toDate(requestedExpiresAt);
    if (Number.isNaN(expiresAt.getTime())) throw new HoldExpiryError('expiresAt must be a valid ISO8601 date.');
    if (expiresAt <= nowAt) throw new HoldExpiryError('expiresAt must be in the future.');
    if (expiresAt > startAt) {
      throw new HoldExpiryError('expiresAt cannot be later than the start of the held time slot.');
    }
    return expiresAt;
  }

  const byDefault = new Date(nowAt.getTime() + hours * HOUR_MS);
  const expiresAt = byDefault < startAt ? byDefault : startAt;
  if (expiresAt <= nowAt) {
    throw new HoldExpiryError('A tentative hold can only be placed on a time slot that starts in the future.');
  }
  return expiresAt;
}

/** Active by status but past its deadline: the sweep should expire it (AC3). */
function isHoldDueForExpiry(hold, now = new Date()) {
  return hold.status === 'active' && hold.expiresAt != null && toDate(hold.expiresAt) <= toDate(now);
}

/**
 * The hold's real state at `now`. A hold whose deadline has passed reads
 * as 'expired' even if the sweep has not stamped it yet.
 */
function holdLifecycleState(hold, now = new Date()) {
  if (isHoldDueForExpiry(hold, now)) return 'expired';
  return hold.status;
}

/** Still active, not yet warned, and its deadline is within the warning window (AC6). */
function needsExpiryWarning(hold, now = new Date(), warningHours = getHoldConfig().warningHours) {
  if (hold.status !== 'active' || hold.expiryWarningSentAt || hold.expiresAt == null) return false;
  const msLeft = toDate(hold.expiresAt).getTime() - toDate(now).getTime();
  return msLeft > 0 && msLeft <= warningHours * HOUR_MS;
}

/** Everyone who should hear about a hold: the event's coordinator and whoever placed it. */
function holdRecipients(hold, event) {
  return [...new Set([event?.coordinatorId, hold.heldBy].filter(Boolean))];
}

function describeSlot(hold) {
  return `${toDate(hold.startDatetime).toISOString()} - ${toDate(hold.endDatetime).toISOString()}`;
}

function expiryWarningMessage({ hold, venueName, eventName }) {
  const forEvent = eventName ? ` for "${eventName}"` : '';
  return (
    `Your tentative hold on ${venueName || 'the venue'}${forEvent} (${describeSlot(hold)}) ` +
    `expires at ${toDate(hold.expiresAt).toISOString()}. Complete the booking before then, ` +
    'otherwise the hold will expire and the venue/time slot will be released.'
  );
}

function expiredMessage({ hold, venueName, eventName }) {
  const forEvent = eventName ? ` for "${eventName}"` : '';
  return (
    `Your tentative hold on ${venueName || 'the venue'}${forEvent} (${describeSlot(hold)}) ` +
    `expired at ${toDate(hold.expiresAt).toISOString()}. The venue/time slot has been released ` +
    'and is NOT booked for your event.'
  );
}

module.exports = {
  HOUR_MS,
  HoldExpiryError,
  getHoldConfig,
  resolveHoldExpiry,
  isHoldDueForExpiry,
  holdLifecycleState,
  needsExpiryWarning,
  holdRecipients,
  expiryWarningMessage,
  expiredMessage,
};
