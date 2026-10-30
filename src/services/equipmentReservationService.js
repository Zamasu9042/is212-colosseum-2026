/**
 * Equipment reservations and technical readiness (SCRUM-21, SCRUM-22, SCRUM-24).
 *
 * Every write runs in a transaction that row-locks the equipment item
 * first, so two concurrent reservations for the same item are serialised
 * and cannot both pass the overlap check (no double-booking).
 */
const { Op } = require('sequelize');
const {
  sequelize,
  Equipment,
  EquipmentReservation,
  EventEquipmentRequest,
  Event,
  EventRequest,
  User,
  Notification,
} = require('../models');
const {
  RESERVABLE_EVENT_STATUSES,
  overlappingReservations,
  reservablePool,
  availableQuantityInWindow,
  deriveCatalogueStatus,
  nonReservableReason,
  allocationSummary,
  sameType,
  NON_RESERVABLE_STATUSES,
} = require('../utils/equipmentAvailability');

class EquipmentReservationError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'EquipmentReservationError';
    this.status = status;
    this.extra = extra;
  }
}

const reservationIncludes = [
  { model: Equipment, attributes: ['id', 'name', 'type', 'location', 'status'] },
  {
    model: Event,
    attributes: ['id', 'startDatetime', 'endDatetime', 'status', 'coordinatorId'],
    include: [{ model: EventRequest, attributes: ['id', 'eventName'] }],
  },
  { model: User, as: 'reserver', attributes: ['id', 'firstName', 'lastName', 'email'] },
  { model: User, as: 'canceller', attributes: ['id', 'firstName', 'lastName', 'email'] },
];

/** Flat, UI-friendly shape carrying the metadata SCRUM-21 AC3 requires. */
function serializeReservation(r) {
  const json = r.toJSON ? r.toJSON() : r;
  return {
    id: json.id,
    eventId: json.eventId,
    eventName: json.Event?.EventRequest?.eventName || null,
    equipmentId: json.equipmentId,
    equipmentName: json.Equipment?.name || null,
    equipmentType: json.Equipment?.type || null,
    equipmentRequestId: json.equipmentRequestId || null,
    quantity: json.quantity,
    startDatetime: json.startDatetime,
    endDatetime: json.endDatetime,
    organiserName: json.organiserName,
    status: json.status,
    reservedAt: json.reservedAt,
    reservedBy: json.reserver
      ? { id: json.reserver.id, name: `${json.reserver.firstName} ${json.reserver.lastName}` }
      : null,
    cancelledAt: json.cancelledAt || null,
    cancelledBy: json.canceller
      ? { id: json.canceller.id, name: `${json.canceller.firstName} ${json.canceller.lastName}` }
      : null,
    cancellationReason: json.cancellationReason || null,
  };
}

async function loadEventWithOrganiser(eventId, transaction, lock = false) {
  const event = await Event.findByPk(eventId, {
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!event) return null;
  const eventRequest = await EventRequest.findByPk(event.eventRequestId, {
    include: [{ model: User, as: 'organiser', attributes: ['firstName', 'lastName'] }],
    transaction,
  });
  return { event, eventRequest };
}

/**
 * SCRUM-21 AC1/AC5: recompute the catalogue flag from live reservations.
 * Leaves in_repair / unavailable untouched.
 */
async function syncEquipmentStatus(equipmentId, transaction) {
  const equipment = await Equipment.findByPk(equipmentId, { transaction });
  if (!equipment) return null;
  const liveCount = await EquipmentReservation.count({
    where: { equipmentId, status: 'active', endDatetime: { [Op.gt]: new Date() } },
    transaction,
  });
  const next = deriveCatalogueStatus(equipment.status, liveCount > 0);
  if (next !== equipment.status) await equipment.update({ status: next }, { transaction });
  return equipment;
}

async function notify(userId, type, message, eventId, transaction) {
  if (!userId) return;
  await Notification.create({ userId, type, message, eventId }, { transaction });
}

/**
 * SCRUM-21 / SCRUM-22 / SCRUM-24: reserve units of one item for an event.
 *
 * Errors (EquipmentReservationError.status):
 *   404  event or equipment not found
 *   409  event not reservable, or the window overlaps existing reservations
 *        (extra.conflicts lists them)
 *   422  item in repair / unavailable, bad window, bad quantity, or a
 *        request line that does not match
 */
async function reserveEquipment({
  eventId,
  equipmentId,
  quantity = 1,
  startDatetime,
  endDatetime,
  equipmentRequestId,
  user,
}) {
  return sequelize.transaction(async (transaction) => {
    // Lock the item first: concurrent reservations for it queue here.
    const equipment = await Equipment.findByPk(equipmentId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!equipment) throw new EquipmentReservationError(404, 'Equipment not found.');

    const loaded = await loadEventWithOrganiser(eventId, transaction);
    if (!loaded) throw new EquipmentReservationError(404, 'Event not found.');
    const { event, eventRequest } = loaded;

    if (!RESERVABLE_EVENT_STATUSES.includes(event.status)) {
      throw new EquipmentReservationError(
        409,
        `Equipment can only be reserved for an approved event that is still being planned or confirmed (this event is ${event.status}).`
      );
    }

    // SCRUM-22 AC2: block in-repair / unavailable items with a clear error.
    const blockedReason = nonReservableReason(equipment);
    if (blockedReason) {
      throw new EquipmentReservationError(422, blockedReason, {
        code: 'EQUIPMENT_NOT_RESERVABLE',
        equipmentStatus: equipment.status,
      });
    }

    // SCRUM-21 AC1: the window is the approved event's window, or a
    // slot inside it (e.g. one session of a multi-session event).
    const start = startDatetime ? new Date(startDatetime) : event.startDatetime;
    const end = endDatetime ? new Date(endDatetime) : event.endDatetime;
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new EquipmentReservationError(422, 'Reservation end must be after its start.');
    }
    if (end <= new Date()) {
      throw new EquipmentReservationError(422, 'This time window has already ended; equipment can only be reserved for upcoming time slots.');
    }
    if (start < event.startDatetime || end > event.endDatetime) {
      throw new EquipmentReservationError(
        422,
        "Reservation window must fall within the approved event's time window.",
        { eventWindow: { startDatetime: event.startDatetime, endDatetime: event.endDatetime } }
      );
    }

    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      throw new EquipmentReservationError(422, 'quantity must be a whole number of at least 1.');
    }
    const pool = reservablePool(equipment);
    if (qty > pool) {
      throw new EquipmentReservationError(
        422,
        `Only ${pool} unit(s) of ${equipment.name} are in service; cannot reserve ${qty}.`
      );
    }

    // SCRUM-24: optional link to the event's equipment request line.
    let requestLine = null;
    if (equipmentRequestId) {
      requestLine = await EventEquipmentRequest.findByPk(equipmentRequestId, { transaction });
      if (!requestLine || requestLine.eventId !== event.id) {
        throw new EquipmentReservationError(422, 'equipmentRequestId does not belong to this event.');
      }
      if (requestLine.equipmentId && requestLine.equipmentId !== equipment.id) {
        throw new EquipmentReservationError(422, 'This request line is pinned to a different equipment item.');
      }
      if (!requestLine.equipmentId && !sameType(requestLine.equipmentType, equipment.type)) {
        throw new EquipmentReservationError(
          422,
          `This request line needs ${requestLine.equipmentType} equipment, but ${equipment.name} is ${equipment.type}.`
        );
      }
      // Reservations on items that are now out of service don't count, so a
      // replacement can be allocated to the line.
      const linked = await EquipmentReservation.findAll({
        where: { equipmentRequestId: requestLine.id, status: 'active' },
        include: [{ model: Equipment, attributes: ['status'] }],
        transaction,
      });
      const alreadyAllocated = linked
        .filter((r) => !NON_RESERVABLE_STATUSES.includes(r.Equipment?.status))
        .reduce((sum, r) => sum + r.quantity, 0);
      const remaining = requestLine.quantityRequested - alreadyAllocated;
      if (qty > remaining) {
        throw new EquipmentReservationError(
          422,
          remaining > 0
            ? `This request line only needs ${remaining} more unit(s).`
            : 'This request line is already fully allocated.'
        );
      }
    }

    // SCRUM-21 AC2 / SCRUM-24 AC1-2: plain overlap test, no transit buffer.
    const existing = await EquipmentReservation.findAll({
      where: {
        equipmentId: equipment.id,
        status: 'active',
        startDatetime: { [Op.lt]: end },
        endDatetime: { [Op.gt]: start },
      },
      include: [
        {
          model: Event,
          attributes: ['id'],
          include: [{ model: EventRequest, attributes: ['eventName'] }],
        },
      ],
      transaction,
    });
    const overlapping = overlappingReservations(existing, start, end);
    const free = availableQuantityInWindow(equipment, overlapping, start, end);
    if (qty > free) {
      const conflicts = overlapping.map((r) => ({
        reservationId: r.id,
        eventId: r.eventId,
        eventName: r.Event?.EventRequest?.eventName || null,
        startDatetime: r.startDatetime,
        endDatetime: r.endDatetime,
        quantity: r.quantity,
      }));
      const names = conflicts.map((c) => c.eventName || c.eventId).join(', ');
      throw new EquipmentReservationError(
        409,
        `Conflict: ${equipment.name} is already reserved for an overlapping time window (${names}). ` +
          `${free} of ${pool} unit(s) free in this window; ${qty} requested.`,
        { code: 'EQUIPMENT_RESERVATION_CONFLICT', conflicts, availableQuantity: free }
      );
    }

    const organiser = eventRequest?.organiser;
    const reservation = await EquipmentReservation.create(
      {
        eventId: event.id,
        equipmentId: equipment.id,
        equipmentRequestId: requestLine ? requestLine.id : null,
        quantity: qty,
        startDatetime: start,
        endDatetime: end,
        organiserName: organiser ? `${organiser.firstName} ${organiser.lastName}` : null,
        status: 'active',
        reservedBy: user.id,
        reservedAt: new Date(),
      },
      { transaction }
    );

    await syncEquipmentStatus(equipment.id, transaction);
    await notify(
      event.coordinatorId,
      'equipment_reserved',
      `${qty} x ${equipment.name} reserved for ${eventRequest?.eventName || 'your event'}.`,
      event.id,
      transaction
    );

    await reservation.reload({ include: reservationIncludes, transaction });
    return reservation;
  });
}

/**
 * SCRUM-21 AC5: cancel a reservation; the item reverts to available when
 * no other live reservation remains. If the event had technical readiness
 * marked complete and this leaves a request line short, readiness goes
 * back to pending (SCRUM-24 AC3 must keep holding).
 */
async function cancelReservation(reservationId, { user, reason } = {}) {
  return sequelize.transaction(async (transaction) => {
    const reservation = await EquipmentReservation.findByPk(reservationId, { transaction });
    if (!reservation) throw new EquipmentReservationError(404, 'Reservation not found.');
    // Lock the item, then re-read the reservation under that lock.
    await Equipment.findByPk(reservation.equipmentId, { transaction, lock: transaction.LOCK.UPDATE });
    await reservation.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (reservation.status !== 'active') {
      throw new EquipmentReservationError(409, 'This reservation has already been cancelled.');
    }

    await reservation.update(
      {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: user?.id || null,
        cancellationReason: reason || null,
      },
      { transaction }
    );
    const equipment = await syncEquipmentStatus(reservation.equipmentId, transaction);

    const event = await Event.findByPk(reservation.eventId, { transaction });
    let readinessReverted = false;
    if (event && event.technicalReadiness === 'complete') {
      const summary = await getAllocationSummary(event.id, transaction);
      if (!summary.fullyAllocated) {
        await event.update(
          { technicalReadiness: 'pending', technicalReadinessAt: null, technicalReadinessBy: null },
          { transaction }
        );
        readinessReverted = true;
      }
    }
    if (event) {
      await notify(
        event.coordinatorId,
        'equipment_reservation_cancelled',
        `Reservation of ${reservation.quantity} x ${equipment?.name || 'equipment'} was cancelled.` +
          (readinessReverted ? ' Technical readiness is back to pending.' : ''),
        event.id,
        transaction
      );
    }

    await reservation.reload({ include: reservationIncludes, transaction });
    return { reservation, equipment, readinessReverted };
  });
}

async function listReservations(where) {
  const rows = await EquipmentReservation.findAll({
    where,
    include: reservationIncludes,
    order: [['start_datetime', 'ASC']],
  });
  return rows.map(serializeReservation);
}

async function getAllocationSummary(eventId, transaction) {
  const [requests, reservations] = await Promise.all([
    EventEquipmentRequest.findAll({ where: { eventId }, order: [['created_at', 'ASC']], transaction }),
    EquipmentReservation.findAll({
      where: { eventId, status: 'active' },
      include: [{ model: Equipment, attributes: ['status'] }],
      transaction,
    }),
  ]);
  return allocationSummary(
    requests,
    reservations.map((r) => ({ ...r.toJSON(), equipmentStatus: r.Equipment?.status }))
  );
}

/**
 * Clears the 'reserved' flag on items whose reservations have all ended.
 * syncEquipmentStatus only runs on writes, so without this an item stayed
 * 'reserved' forever after its last event finished. Called on catalogue
 * reads and by a periodic sweep in server.js. Returns rows changed.
 */
async function releaseEndedReservations() {
  const [, meta] = await sequelize.query(`
    UPDATE equipment e
       SET status = 'available'
     WHERE e.status = 'reserved'
       AND NOT EXISTS (
             SELECT 1 FROM equipment_reservations r
              WHERE r.equipment_id = e.id
                AND r.status = 'active'
                AND r.end_datetime > now())`);
  return meta?.rowCount || 0;
}

let equipmentSweepTimer = null;
function startEquipmentStatusScheduler(intervalMs = Number(process.env.EQUIPMENT_STATUS_SWEEP_INTERVAL_MS) || 60000) {
  if (equipmentSweepTimer) return equipmentSweepTimer;
  equipmentSweepTimer = setInterval(() => {
    releaseEndedReservations().catch((err) => console.error('Equipment status sweep failed:', err.message));
  }, intervalMs);
  equipmentSweepTimer.unref?.();
  return equipmentSweepTimer;
}

/**
 * An item went in_repair/unavailable: tell the coordinator of every upcoming
 * event that reserved it, and send any "complete" readiness back to pending
 * if the event is no longer fully allocated. Reservations are kept so staff
 * can swap in a replacement. Returns ids of events whose readiness reverted.
 */
async function handleEquipmentOutOfService(equipment, transaction) {
  const live = await EquipmentReservation.findAll({
    where: { equipmentId: equipment.id, status: 'active', endDatetime: { [Op.gt]: new Date() } },
    transaction,
  });
  const eventIds = [...new Set(live.map((r) => r.eventId))];
  const reverted = [];
  for (const eventId of eventIds) {
    const event = await Event.findByPk(eventId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!event) continue;
    let readinessText = '';
    if (event.technicalReadiness === 'complete') {
      const summary = await getAllocationSummary(event.id, transaction);
      if (!summary.fullyAllocated) {
        await event.update(
          { technicalReadiness: 'pending', technicalReadinessAt: null, technicalReadinessBy: null },
          { transaction }
        );
        reverted.push(event.id);
        readinessText = ' Technical readiness is back to pending.';
      }
    }
    await notify(
      event.coordinatorId,
      'equipment_out_of_service',
      `${equipment.name} is now ${equipment.status.replace('_', ' ')} but is reserved for your event; a replacement may be needed.${readinessText}`,
      event.id,
      transaction
    );
  }
  return reverted;
}

/**
 * SCRUM-24 AC3: mark technical readiness complete only when every
 * equipment request line is fully allocated. 409 lists the shortfalls.
 */
async function markTechnicalReadiness(eventId, { user, complete = true }) {
  return sequelize.transaction(async (transaction) => {
    const event = await Event.findByPk(eventId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!event) throw new EquipmentReservationError(404, 'Event not found.');

    if (!complete) {
      await event.update(
        { technicalReadiness: 'pending', technicalReadinessAt: null, technicalReadinessBy: null },
        { transaction }
      );
      return { event, summary: await getAllocationSummary(event.id, transaction) };
    }

    if (!RESERVABLE_EVENT_STATUSES.includes(event.status)) {
      throw new EquipmentReservationError(409, `Cannot change readiness of a ${event.status} event.`);
    }
    const summary = await getAllocationSummary(event.id, transaction);
    if (!summary.fullyAllocated) {
      const detail = summary.outstanding
        .map((l) => `${l.equipmentType}: ${l.quantityAllocated}/${l.quantityRequested}`)
        .join('; ');
      throw new EquipmentReservationError(
        409,
        `Technical readiness cannot be completed until all requested equipment is allocated (${detail}).`,
        { code: 'EQUIPMENT_NOT_FULLY_ALLOCATED', summary }
      );
    }
    await event.update(
      { technicalReadiness: 'complete', technicalReadinessAt: new Date(), technicalReadinessBy: user.id },
      { transaction }
    );
    return { event, summary };
  });
}

module.exports = {
  EquipmentReservationError,
  reservationIncludes,
  serializeReservation,
  syncEquipmentStatus,
  reserveEquipment,
  cancelReservation,
  listReservations,
  getAllocationSummary,
  markTechnicalReadiness,
  releaseEndedReservations,
  startEquipmentStatusScheduler,
  handleEquipmentOutOfService,
};
