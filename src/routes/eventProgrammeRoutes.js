const express = require('express');
const { body } = require('express-validator');
const { EventProgramme, AgendaItem, Event, EventRequest } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');

const router = express.Router();

const AGENDA_ITEM_FIELDS = ['title', 'description', 'startTime', 'endTime', 'speaker', 'allowOverlap'];

function pickAgendaItemFields(body) {
  const result = {};
  for (const key of AGENDA_ITEM_FIELDS) {
    if (key in body) result[key] = body[key];
  }
  return result;
}

const agendaItemValidators = [
  body('title').notEmpty().withMessage('title is required').isString().isLength({ max: 200 }),
  body('description').optional({ nullable: true }).isString(),
  body('startTime').notEmpty().withMessage('startTime is required').isISO8601(),
  body('endTime').notEmpty().withMessage('endTime is required').isISO8601(),
  body('speaker').optional({ nullable: true }).isString().isLength({ max: 200 }),
  body('allowOverlap').optional({ nullable: true }).isBoolean(),
];

// Partial version for PATCH — same rules, but nothing is required since
// an edit may only touch one field.
const agendaItemPatchValidators = [
  body('title').optional().isString().isLength({ max: 200 }),
  body('description').optional({ nullable: true }).isString(),
  body('startTime').optional().isISO8601(),
  body('endTime').optional().isISO8601(),
  body('speaker').optional({ nullable: true }).isString().isLength({ max: 200 }),
  body('allowOverlap').optional({ nullable: true }).isBoolean(),
];

function timesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Finds existing agenda items (in the same programme, excluding
// excludeItemId) whose time range conflicts with [startTime, endTime],
// where neither side has explicitly permitted the overlap.
async function findBlockingConflicts(programmeId, startTime, endTime, allowOverlap, excludeItemId) {
  if (allowOverlap) return []; // this item itself permits overlapping, so nothing blocks it

  const items = await AgendaItem.findAll({ where: { programmeId } });
  return items.filter((item) => {
    if (excludeItemId && item.id === excludeItemId) return false;
    if (item.allowOverlap) return false; // the other item also permits it
    return timesOverlap(new Date(startTime), new Date(endTime), item.startTime, item.endTime);
  });
}

// Loads the Event + its parent EventRequest (for organiser ownership
// checks) in one place, since almost every route here needs both.
async function loadEventContext(eventId) {
  const event = await Event.findByPk(eventId);
  if (!event) return null;
  const eventRequest = await EventRequest.findByPk(event.eventRequestId);
  return { event, eventRequest };
}

function isAssignedCoordinator(req, event) {
  return req.user.role === ROLE_NAMES.EVENT_COORDINATOR && event.coordinatorId === req.user.id;
}

function isOwningOrganiser(req, eventRequest) {
  return (
    req.user.role === ROLE_NAMES.EVENT_ORGANISER &&
    eventRequest &&
    eventRequest.organiserId === req.user.id
  );
}

// Create the programme shell for an event. One per event — calling
// this again on an event that already has one is a conflict, not an
// update (use the agenda item endpoints below to build it out).
router.post(
  '/events/:eventId/programme',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  async (req, res, next) => {
    try {
      const context = await loadEventContext(req.params.eventId);
      if (!context) return res.status(404).json({ error: 'Event not found.' });
      if (!isAssignedCoordinator(req, context.event)) {
        return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
      }

      const existing = await EventProgramme.findOne({ where: { eventId: context.event.id } });
      if (existing) {
        return res.status(409).json({ error: 'This event already has a programme.' });
      }

      const programme = await EventProgramme.create({ eventId: context.event.id, status: 'draft' });
      res.status(201).json({ programme });
    } catch (err) {
      next(err);
    }
  }
);

// View the programme and its agenda items, in chronological order.
// - The assigned Coordinator can always view it (draft or published).
// - The Organiser who owns the underlying request can always view it.
// - Anyone else authenticated may view it only once it's published —
//   this is the "Display the published programme" criterion.
router.get(
  '/events/:eventId/programme',
  authenticate,
  async (req, res, next) => {
    try {
      const context = await loadEventContext(req.params.eventId);
      if (!context) return res.status(404).json({ error: 'Event not found.' });

      const programme = await EventProgramme.findOne({ where: { eventId: context.event.id } });
      if (!programme) return res.status(404).json({ error: 'This event has no programme yet.' });

      const canViewDraft = isAssignedCoordinator(req, context.event) || isOwningOrganiser(req, context.eventRequest);
      if (programme.status !== 'published' && !canViewDraft) {
        return res.status(403).json({ error: 'This programme has not been published yet.' });
      }

      const agendaItems = await AgendaItem.findAll({
        where: { programmeId: programme.id },
        order: [['start_time', 'ASC']],
      });

      res.json({ programme, agendaItems });
    } catch (err) {
      next(err);
    }
  }
);

// Add an agenda item to a draft programme.
router.post(
  '/events/:eventId/programme/items',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  agendaItemValidators,
  validateRequest,
  async (req, res, next) => {
    try {
      const context = await loadEventContext(req.params.eventId);
      if (!context) return res.status(404).json({ error: 'Event not found.' });
      if (!isAssignedCoordinator(req, context.event)) {
        return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
      }

      const programme = await EventProgramme.findOne({ where: { eventId: context.event.id } });
      if (!programme) return res.status(404).json({ error: 'This event has no programme yet.' });
      if (programme.status !== 'draft') {
        return res.status(409).json({ error: 'Only a draft programme can be edited.' });
      }

      const { startTime, endTime } = req.body;
      if (new Date(endTime) <= new Date(startTime)) {
        return res.status(400).json({ error: 'endTime must be after startTime.' });
      }

      const allowOverlap = req.body.allowOverlap === true;
      const conflicts = await findBlockingConflicts(programme.id, startTime, endTime, allowOverlap, null);
      if (conflicts.length > 0) {
        return res.status(409).json({
          error: 'This agenda item overlaps with existing items. Set allowOverlap to permit this.',
          conflictingItemIds: conflicts.map((item) => item.id),
        });
      }

      const maxOrder = await AgendaItem.max('sortOrder', { where: { programmeId: programme.id } });
      const agendaItem = await AgendaItem.create({
        ...pickAgendaItemFields(req.body),
        programmeId: programme.id,
        sortOrder: (Number.isFinite(maxOrder) ? maxOrder : -1) + 1,
      });

      res.status(201).json({ agendaItem });
    } catch (err) {
      next(err);
    }
  }
);

// Reorder agenda items. Body: { order: [itemId, itemId, ...] } — the
// array's position becomes each item's new sortOrder. This is separate
// from editing an item's start/end time: reordering is purely about
// display order and never touches scheduling or overlap rules.
//
// NOTE: this is registered BEFORE the "/items/:itemId" routes below on
// purpose. Express matches routes in registration order, and ":itemId"
// is a wildcard that would otherwise swallow a request to
// ".../items/reorder" by treating the literal string "reorder" as an
// itemId — so the more specific literal path has to come first.
router.patch(
  '/events/:eventId/programme/items/reorder',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  body('order').isArray({ min: 1 }).withMessage('order must be a non-empty array of agenda item ids'),
  validateRequest,
  async (req, res, next) => {
    try {
      const context = await loadEventContext(req.params.eventId);
      if (!context) return res.status(404).json({ error: 'Event not found.' });
      if (!isAssignedCoordinator(req, context.event)) {
        return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
      }

      const programme = await EventProgramme.findOne({ where: { eventId: context.event.id } });
      if (!programme) return res.status(404).json({ error: 'This event has no programme yet.' });
      if (programme.status !== 'draft') {
        return res.status(409).json({ error: 'Only a draft programme can be edited.' });
      }

      const items = await AgendaItem.findAll({ where: { programmeId: programme.id } });
      const itemIds = new Set(items.map((item) => item.id));
      const { order } = req.body;

      if (order.length !== items.length || !order.every((id) => itemIds.has(id))) {
        return res.status(400).json({ error: 'order must contain exactly the current agenda item ids.' });
      }

      await Promise.all(
        order.map((id, index) => AgendaItem.update({ sortOrder: index }, { where: { id } }))
      );

      const reordered = await AgendaItem.findAll({
        where: { programmeId: programme.id },
        order: [['sort_order', 'ASC']],
      });
      res.json({ agendaItems: reordered });
    } catch (err) {
      next(err);
    }
  }
);

// Edit an agenda item on a draft programme.
router.patch(
  '/events/:eventId/programme/items/:itemId',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  agendaItemPatchValidators,
  validateRequest,
  async (req, res, next) => {
    try {
      const context = await loadEventContext(req.params.eventId);
      if (!context) return res.status(404).json({ error: 'Event not found.' });
      if (!isAssignedCoordinator(req, context.event)) {
        return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
      }

      const programme = await EventProgramme.findOne({ where: { eventId: context.event.id } });
      if (!programme) return res.status(404).json({ error: 'This event has no programme yet.' });
      if (programme.status !== 'draft') {
        return res.status(409).json({ error: 'Only a draft programme can be edited.' });
      }

      const agendaItem = await AgendaItem.findOne({
        where: { id: req.params.itemId, programmeId: programme.id },
      });
      if (!agendaItem) return res.status(404).json({ error: 'Agenda item not found.' });

      const startTime = req.body.startTime ?? agendaItem.startTime;
      const endTime = req.body.endTime ?? agendaItem.endTime;
      if (new Date(endTime) <= new Date(startTime)) {
        return res.status(400).json({ error: 'endTime must be after startTime.' });
      }

      const allowOverlap = req.body.allowOverlap ?? agendaItem.allowOverlap;
      const conflicts = await findBlockingConflicts(
        programme.id,
        startTime,
        endTime,
        allowOverlap,
        agendaItem.id
      );
      if (conflicts.length > 0) {
        return res.status(409).json({
          error: 'This agenda item overlaps with existing items. Set allowOverlap to permit this.',
          conflictingItemIds: conflicts.map((item) => item.id),
        });
      }

      await agendaItem.update(pickAgendaItemFields(req.body));
      res.json({ agendaItem });
    } catch (err) {
      next(err);
    }
  }
);

// Delete an agenda item from a draft programme.
router.delete(
  '/events/:eventId/programme/items/:itemId',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  async (req, res, next) => {
    try {
      const context = await loadEventContext(req.params.eventId);
      if (!context) return res.status(404).json({ error: 'Event not found.' });
      if (!isAssignedCoordinator(req, context.event)) {
        return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
      }

      const programme = await EventProgramme.findOne({ where: { eventId: context.event.id } });
      if (!programme) return res.status(404).json({ error: 'This event has no programme yet.' });
      if (programme.status !== 'draft') {
        return res.status(409).json({ error: 'Only a draft programme can be edited.' });
      }

      const agendaItem = await AgendaItem.findOne({
        where: { id: req.params.itemId, programmeId: programme.id },
      });
      if (!agendaItem) return res.status(404).json({ error: 'Agenda item not found.' });

      await agendaItem.destroy();
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

// Publish the programme. Requires at least one agenda item — publishing
// an empty programme wouldn't give attendees anything to see.
router.post(
  '/events/:eventId/programme/publish',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  async (req, res, next) => {
    try {
      const context = await loadEventContext(req.params.eventId);
      if (!context) return res.status(404).json({ error: 'Event not found.' });
      if (!isAssignedCoordinator(req, context.event)) {
        return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
      }

      const programme = await EventProgramme.findOne({ where: { eventId: context.event.id } });
      if (!programme) return res.status(404).json({ error: 'This event has no programme yet.' });
      if (programme.status === 'published') {
        return res.status(409).json({ error: 'This programme is already published.' });
      }

      const itemCount = await AgendaItem.count({ where: { programmeId: programme.id } });
      if (itemCount === 0) {
        return res.status(400).json({ error: 'Cannot publish a programme with no agenda items.' });
      }

      await programme.update({ status: 'published', publishedAt: new Date() });
      res.json({ programme });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;