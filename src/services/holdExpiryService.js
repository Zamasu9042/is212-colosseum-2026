// Automatic expiry of tentative venue holds (Week 7).
//
// processHoldExpiries() is one sweep:
//   1. Every active hold whose expiresAt has passed becomes 'expired'
//      (expiredAt stamped) and its coordinator is notified (AC3, AC6).
//   2. Every active hold whose deadline is within the warning window and
//      that has not been warned yet triggers an "expiring soon" notice
//      (AC6), sent once (expiryWarningSentAt).
//
// Availability does NOT depend on this sweep running: conflict detection
// already ignores a hold from the instant expiresAt passes (AC2/AC4). The
// sweep only makes the state explicit and tells people about it.
//
// Rows are claimed with FOR UPDATE SKIP LOCKED so two app instances (or
// the scheduler and the manual endpoint) never process the same hold
// twice or send duplicate notifications.
//
// AC7/AC8 are TBD: the sweep never touches booking requests and never
// extends a hold.

const { Op } = require('sequelize');
const { sequelize, VenueHold, Venue, Event, EventRequest, Notification } = require('../models');
const {
  HOUR_MS,
  getHoldConfig,
  holdRecipients,
  expiryWarningMessage,
  expiredMessage,
} = require('../utils/holdExpiry');

async function loadHoldContext(holds, transaction) {
  const venueIds = [...new Set(holds.map((h) => h.venueId))];
  const eventIds = [...new Set(holds.map((h) => h.eventId).filter(Boolean))];
  // Sequential: queries on one transaction share a single connection.
  const venues = venueIds.length ? await Venue.findAll({ where: { id: { [Op.in]: venueIds } }, transaction }) : [];
  const events = eventIds.length
    ? await Event.findAll({
        where: { id: { [Op.in]: eventIds } },
        include: [{ model: EventRequest, attributes: ['eventName'] }],
        transaction,
      })
    : [];
  return {
    venuesById: new Map(venues.map((v) => [v.id, v])),
    eventsById: new Map(events.map((e) => [e.id, e])),
  };
}

async function notifyHold({ hold, type, buildMessage, ctx, transaction }) {
  const venue = ctx.venuesById.get(hold.venueId);
  const event = hold.eventId ? ctx.eventsById.get(hold.eventId) : null;
  const message = buildMessage({
    hold,
    venueName: venue?.name,
    eventName: event?.EventRequest?.eventName,
  });
  const recipients = holdRecipients(hold, event);
  for (const userId of recipients) {
    await Notification.create(
      { userId, type, message, eventId: hold.eventId || null, venueHoldId: hold.id },
      { transaction }
    );
  }
  return recipients.length;
}

/** Step 1: expire every active hold whose deadline has passed. */
async function expireDueHolds({ now = new Date() } = {}) {
  return sequelize.transaction(async (transaction) => {
    const due = await VenueHold.findAll({
      where: { status: 'active', expiresAt: { [Op.lte]: now } },
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
      transaction,
    });
    if (!due.length) return [];

    const ctx = await loadHoldContext(due, transaction);
    const results = [];
    for (const hold of due) {
      await hold.update({ status: 'expired', expiredAt: now }, { transaction });
      const notified = await notifyHold({
        hold,
        type: 'venue_hold_expired',
        buildMessage: expiredMessage,
        ctx,
        transaction,
      });
      results.push({ holdId: hold.id, venueId: hold.venueId, eventId: hold.eventId, notified });
    }
    return results;
  });
}

/** Step 2: remind coordinators about holds that will expire soon. */
async function sendExpiryWarnings({ now = new Date(), warningHours = getHoldConfig().warningHours } = {}) {
  const horizon = new Date(now.getTime() + warningHours * HOUR_MS);
  return sequelize.transaction(async (transaction) => {
    const expiring = await VenueHold.findAll({
      where: {
        status: 'active',
        expiryWarningSentAt: null,
        expiresAt: { [Op.gt]: now, [Op.lte]: horizon },
      },
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
      transaction,
    });
    if (!expiring.length) return [];

    const ctx = await loadHoldContext(expiring, transaction);
    const results = [];
    for (const hold of expiring) {
      await hold.update({ expiryWarningSentAt: now }, { transaction });
      const notified = await notifyHold({
        hold,
        type: 'venue_hold_expiring',
        buildMessage: expiryWarningMessage,
        ctx,
        transaction,
      });
      results.push({ holdId: hold.id, venueId: hold.venueId, eventId: hold.eventId, expiresAt: hold.expiresAt, notified });
    }
    return results;
  });
}

/** One full sweep. Expire first so a just-expired hold never also gets a "soon" warning. */
async function processHoldExpiries({ now = new Date(), warningHours } = {}) {
  const expired = await expireDueHolds({ now });
  const warned = await sendExpiryWarnings({ now, warningHours });
  return { ranAt: now, expired, warned };
}

/**
 * Runs processHoldExpiries immediately and then every `intervalMs`.
 * Overlapping runs are skipped. Returns a stop() function.
 * Started from server.js only, so tests never get a background timer.
 */
function startHoldExpiryScheduler({ intervalMs = getHoldConfig().sweepIntervalMs, logger = console } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { expired, warned } = await processHoldExpiries();
      if (expired.length || warned.length) {
        logger.log(`⏰ Hold expiry sweep: ${expired.length} expired, ${warned.length} expiry reminder(s) sent.`);
      }
    } catch (err) {
      logger.error('Hold expiry sweep failed:', err.message);
    } finally {
      running = false;
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  expireDueHolds,
  sendExpiryWarnings,
  processHoldExpiries,
  startHoldExpiryScheduler,
};
