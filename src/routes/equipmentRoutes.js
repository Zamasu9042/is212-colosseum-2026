const express = require('express');
const { Op } = require('sequelize');
const { body, param, query } = require('express-validator');
const { sequelize, Equipment, EquipmentReservation, Event } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');
const {
  MANUAL_EQUIPMENT_STATUSES,
  NON_RESERVABLE_STATUSES,
  STATUS_LABELS,
  parseStatusFilter,
  availableQuantityInWindow,
  isSelectableForReservation,
  reservablePool,
  peakConcurrentQuantity,
} = require('../utils/equipmentAvailability');
const {
  syncEquipmentStatus,
  listReservations,
  releaseEndedReservations,
  handleEquipmentOutOfService,
} = require('../services/equipmentReservationService');

const router = express.Router();

const CATALOGUE_READERS = [
  ROLE_NAMES.EVENT_COORDINATOR,
  ROLE_NAMES.EVENT_COORDINATOR_LEAD,
  ROLE_NAMES.TECHNICAL_SUPPORT_STAFF,
  ROLE_NAMES.SAFETY_OFFICER,
];

// Fields Technical Support Staff may edit. `status` is handled separately
// so 'reserved' can never be set by hand.
const EDITABLE_FIELDS = ['name', 'type', 'description', 'quantityTotal', 'quantityAvailable', 'location'];

function pick(bodyIn, fields) {
  const out = {};
  for (const f of fields) if (f in bodyIn) out[f] = bodyIn[f];
  return out;
}

function withLabels(item, extra = {}) {
  const json = item.toJSON ? item.toJSON() : item;
  return {
    ...json,
    statusLabel: STATUS_LABELS[json.status] || json.status,
    isReservable: !NON_RESERVABLE_STATUSES.includes(json.status) && reservablePool(json) > 0,
    ...extra,
  };
}

const manualStatusValidator = (field) =>
  body(field)
    .isIn(MANUAL_EQUIPMENT_STATUSES)
    .withMessage(
      `status must be one of: ${MANUAL_EQUIPMENT_STATUSES.join(', ')}. 'reserved' is set automatically by reservations.`
    );

/**
 * GET /api/equipment
 *
 * SCRUM-22 AC3 — filters (all optional, combinable):
 *   status=available | status=available,reserved   (comma-separated)
 *   type=AV            exact type match (case-insensitive)
 *   search=projector   name / type / description / location contains
 *
 * SCRUM-22 AC1 — reservation picker:
 *   selectable=true    drops in_repair / unavailable items. With a window
 *                      (startDatetime+endDatetime, or eventId for the
 *                      event's own window) also drops items with no free
 *                      unit in that window and adds availableQuantity.
 */
router.get(
  '/',
  authenticate,
  authorize(...CATALOGUE_READERS),
  query('selectable').optional().isBoolean(),
  query('startDatetime').optional().isISO8601(),
  query('endDatetime').optional().isISO8601(),
  query('eventId').optional().isUUID(),
  query('type').optional().isString().trim(),
  query('search').optional().isString().trim().isLength({ max: 200 }),
  validateRequest,
  async (req, res, next) => {
    try {
      const { statuses, error } = parseStatusFilter(req.query.status);
      if (error) return res.status(400).json({ error });

      let window = null;
      if (req.query.eventId) {
        const event = await Event.findByPk(req.query.eventId);
        if (!event) return res.status(404).json({ error: 'Event not found.' });
        window = { startDatetime: event.startDatetime, endDatetime: event.endDatetime };
      }
      if (req.query.startDatetime || req.query.endDatetime) {
        if (!req.query.startDatetime || !req.query.endDatetime) {
          return res.status(400).json({ error: 'startDatetime and endDatetime must be provided together.' });
        }
        window = { startDatetime: new Date(req.query.startDatetime), endDatetime: new Date(req.query.endDatetime) };
        if (window.endDatetime <= window.startDatetime) {
          return res.status(400).json({ error: 'endDatetime must be after startDatetime.' });
        }
      }
      const selectable = req.query.selectable === 'true';
      await releaseEndedReservations();

      const conditions = [];
      if (statuses) conditions.push({ status: { [Op.in]: statuses } });
      if (selectable) conditions.push({ status: { [Op.notIn]: NON_RESERVABLE_STATUSES } });
      if (req.query.type) conditions.push({ type: { [Op.iLike]: req.query.type } });
      if (req.query.search) {
        const like = { [Op.iLike]: `%${req.query.search}%` };
        conditions.push({
          [Op.or]: [{ name: like }, { type: like }, { description: like }, { location: like }],
        });
      }

      const items = await Equipment.findAll({
        where: conditions.length ? { [Op.and]: conditions } : undefined,
        order: [['name', 'ASC']],
      });

      let reservationsByItem = new Map();
      if (window && items.length) {
        const overlapping = await EquipmentReservation.findAll({
          where: {
            equipmentId: { [Op.in]: items.map((i) => i.id) },
            status: 'active',
            startDatetime: { [Op.lt]: window.endDatetime },
            endDatetime: { [Op.gt]: window.startDatetime },
          },
        });
        reservationsByItem = overlapping.reduce((m, r) => {
          if (!m.has(r.equipmentId)) m.set(r.equipmentId, []);
          m.get(r.equipmentId).push(r);
          return m;
        }, new Map());
      }

      let result = items.map((item) => {
        if (!window) return withLabels(item);
        const rs = reservationsByItem.get(item.id) || [];
        return withLabels(item, {
          availableQuantity: availableQuantityInWindow(item, rs, window.startDatetime, window.endDatetime),
          isSelectable: isSelectableForReservation(item, rs, window),
        });
      });
      if (selectable) {
        result = result.filter((i) => (window ? i.isSelectable : i.isReservable));
      }

      res.json({
        equipment: result,
        count: result.length,
        filters: { status: statuses, selectable, window },
        ...(result.length ? {} : { message: 'No equipment matches these filters.' }),
      });
    } catch (err) {
      next(err);
    }
  }
);

// Only Technical Support Staff maintain the equipment catalogue itself.
router.post(
  '/',
  authenticate,
  authorize(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF),
  body('status').optional().isIn(MANUAL_EQUIPMENT_STATUSES)
    .withMessage(`status must be one of: ${MANUAL_EQUIPMENT_STATUSES.join(', ')}.`),
  validateRequest,
  async (req, res, next) => {
    try {
      const data = pick(req.body, EDITABLE_FIELDS);
      if (data.quantityAvailable === undefined && data.quantityTotal !== undefined) {
        data.quantityAvailable = data.quantityTotal;
      }
      const item = await Equipment.create({ ...data, status: req.body.status || 'available' });
      res.status(201).json({ equipment: withLabels(item) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/equipment/:id — equipment detail page.
 * SCRUM-21 AC4: includes every reservation of the item (newest window
 * first is not useful for planning, so sorted by start time).
 */
router.get(
  '/:id',
  authenticate,
  authorize(...CATALOGUE_READERS),
  param('id').isUUID(),
  validateRequest,
  async (req, res, next) => {
    try {
      await releaseEndedReservations();
      const item = await Equipment.findByPk(req.params.id);
      if (!item) return res.status(404).json({ error: 'Equipment not found.' });
      const reservations = await listReservations({ equipmentId: item.id });
      res.json({
        equipment: withLabels(item),
        reservations,
        activeReservations: reservations.filter((r) => r.status === 'active'),
      });
    } catch (err) {
      next(err);
    }
  }
);

async function applyStatusChange(item, newStatus, transaction) {
  const wasOutOfService = NON_RESERVABLE_STATUSES.includes(item.status);
  // Re-enabling an item: let live reservations decide available vs reserved.
  const target = newStatus === 'available' ? 'available' : newStatus;
  await item.update({ status: target }, { transaction });
  if (target === 'available') await syncEquipmentStatus(item.id, transaction);
  await item.reload({ transaction });

  // Taking an item out of service does NOT silently drop existing
  // reservations: they are returned so staff can follow up, coordinators
  // are told, and readiness that depended on the item reverts.
  if (NON_RESERVABLE_STATUSES.includes(target)) {
    const affected = await EquipmentReservation.findAll({
      where: { equipmentId: item.id, status: 'active', endDatetime: { [Op.gt]: new Date() } },
      transaction,
    });
    const readinessRevertedEventIds = wasOutOfService ? [] : await handleEquipmentOutOfService(item, transaction);
    return { affected, readinessRevertedEventIds };
  }
  return { affected: [], readinessRevertedEventIds: [] };
}

/**
 * Units in service may not drop below the most units already committed
 * at any one moment by upcoming reservations.
 */
async function assertPoolCoversReservations(item, newPool, transaction) {
  if (newPool === undefined || newPool === null) return null;
  const live = await EquipmentReservation.findAll({
    where: { equipmentId: item.id, status: 'active', endDatetime: { [Op.gt]: new Date() } },
    transaction,
  });
  const peak = peakConcurrentQuantity(live);
  if (Number(newPool) < peak) {
    return `Cannot set units in service to ${newPool}: upcoming reservations already commit ${peak} unit(s) at the same time. Cancel or move reservations first.`;
  }
  return null;
}

/**
 * PATCH /api/equipment/:id/status — SCRUM-22.
 * Body: { status: 'available' | 'in_repair' | 'unavailable' }
 */
router.patch(
  '/:id/status',
  authenticate,
  authorize(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF),
  param('id').isUUID(),
  manualStatusValidator('status'),
  validateRequest,
  async (req, res, next) => {
    try {
      const result = await sequelize.transaction(async (transaction) => {
        const item = await Equipment.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!item) return null;
        const { affected, readinessRevertedEventIds } = await applyStatusChange(item, req.body.status, transaction);
        return { item, affected, readinessRevertedEventIds };
      });
      if (!result) return res.status(404).json({ error: 'Equipment not found.' });
      res.json({
        equipment: withLabels(result.item),
        affectedReservations: result.affected.map((r) => r.toJSON()),
        readinessRevertedEventIds: result.readinessRevertedEventIds,
        ...(result.affected.length
          ? {
              warning: `${result.affected.length} upcoming reservation(s) still reference this item and need follow-up.`,
            }
          : {}),
      });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:id',
  authenticate,
  authorize(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF),
  param('id').isUUID(),
  body('status').optional().isIn(MANUAL_EQUIPMENT_STATUSES)
    .withMessage(`status must be one of: ${MANUAL_EQUIPMENT_STATUSES.join(', ')}. 'reserved' is set automatically by reservations.`),
  validateRequest,
  async (req, res, next) => {
    try {
      const result = await sequelize.transaction(async (transaction) => {
        const item = await Equipment.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!item) return null;
        const updates = pick(req.body, EDITABLE_FIELDS);
        const poolError = await assertPoolCoversReservations(item, updates.quantityAvailable, transaction);
        if (poolError) return { conflict: poolError };
        await item.update(updates, { transaction });
        const change = req.body.status
          ? await applyStatusChange(item, req.body.status, transaction)
          : { affected: [], readinessRevertedEventIds: [] };
        return { item, ...change };
      });
      if (!result) return res.status(404).json({ error: 'Equipment not found.' });
      if (result.conflict) return res.status(409).json({ error: result.conflict });
      res.json({
        equipment: withLabels(result.item),
        affectedReservations: result.affected.map((r) => r.toJSON()),
        readinessRevertedEventIds: result.readinessRevertedEventIds,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
