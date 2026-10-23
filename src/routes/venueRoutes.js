const express = require('express');
const { Op } = require('sequelize');

const { body, query } = require('express-validator');
const { Venue, Event } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');
const {
  computeAvailability,
  buildAvailabilitySlots,
  findReservationConflicts,
  AVAILABILITY_STATES,
} = require('../utils/venueAvailability');
const { loadVenueSchedules } = require('../services/venueConflictService');
const {
  SCHEDULE_AFFECTING_VENUE_FIELDS,
  auditVenueConflicts,
} = require('../services/bookingConflictAudit');

const router = express.Router();

const SORTABLE_FIELDS = ['name', 'location', 'capacity', 'availability'];

// Shared query-param validation for anything that accepts an optional
// startDateTime/endDateTime "is this venue free for my proposed slot?"
// window (used by both the search list and the single-venue lookup).
const dateRangeValidators = [
  query('startDateTime').optional().isISO8601().withMessage('startDateTime must be a valid ISO8601 date.'),
  query('endDateTime').optional().isISO8601().withMessage('endDateTime must be a valid ISO8601 date.'),
];

const venueSearchValidators = [
  ...dateRangeValidators,
  query('search').optional().isString().trim().isLength({ max: 200 }),
  query('name').optional().isString().trim().isLength({ max: 200 }),
  query('location').optional().isString().trim().isLength({ max: 255 }),
  query('venueType').optional().isString().trim().isLength({ max: 500 }),
  query('facilities').optional().isString().trim().isLength({ max: 500 }),
  query('minCapacity').optional().isInt({ min: 1 }).withMessage('minCapacity must be a positive integer.'),
  query('capacity').optional().isInt({ min: 1 }).withMessage('capacity must be a positive integer.'),
  query('maxCapacity').optional().isInt({ min: 1 }).withMessage('maxCapacity must be a positive integer.'),
  query('availability').optional().isIn(['available', 'unavailable']),
  query('sortBy').optional().isIn(SORTABLE_FIELDS),
  query('sortOrder').optional().isIn(['asc', 'desc', 'ASC', 'DESC']),
];

/**
 * Parses/validates a startDateTime+endDateTime pair from query params.
 * Both-or-neither: returns { queryStart: undefined, queryEnd: undefined }
 * when neither was given. Throws a { status, message } object (caught by
 * the route handler) if only one was given, or end <= start.
 */
function parseDateRange(reqQuery) {
  const { startDateTime, endDateTime } = reqQuery;
  if (!startDateTime && !endDateTime) return {};

  if (!startDateTime || !endDateTime) {
    throw { status: 400, message: 'startDateTime and endDateTime must be provided together.' };
  }

  const queryStart = new Date(startDateTime);
  const queryEnd = new Date(endDateTime);
  if (!(queryEnd > queryStart)) {
    throw { status: 400, message: 'endDateTime must be after startDateTime.' };
  }

  return { queryStart, queryEnd };
}

// Calendar requests can target a whole UTC calendar date, or an explicit
// range. A date is intentionally kept separate from search's proposed-event
// range because this endpoint returns *all* slots in the requested period.
// Calendar requests can target a whole UTC calendar date, or an explicit
// range. A date is intentionally kept separate from search's proposed-event
// range because this endpoint returns all slots in the requested period.
function parseAvailabilityRange(reqQuery) {
  if (reqQuery.date) {
    if (reqQuery.startDateTime || reqQuery.endDateTime) {
      throw { status: 400, message: 'date cannot be combined with startDateTime or endDateTime.' };
    }
    const start = new Date(`${reqQuery.date}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { queryStart: start, queryEnd: end };
  }
  return parseDateRange(reqQuery);
}

/** Groups Event rows by venueId for the calendar endpoint. */
function groupEventsByVenue(events) {
  return events.reduce((acc, event) => {
    if (!acc[event.venueId]) acc[event.venueId] = [];
    acc[event.venueId].push(event);
    return acc;
  }, {});
}

/** Groups events, holds, or unavailability rows by venueId. */
function groupByVenue(rows) {
  return rows.reduce((acc, row) => {
    if (!acc[row.venueId]) acc[row.venueId] = [];
    acc[row.venueId].push(row);
    return acc;
  }, {});
}

/**
 * Loads everything that can occupy these venues (blocking bookings, active
 * tentative holds, unavailability periods) and indexes it by venue.
 */
async function loadSchedulesByVenue(venueIds) {
  const { events, holds, unavailability } = await loadVenueSchedules(venueIds);
  return {
    events: groupByVenue(events),
    holds: groupByVenue(holds),
    unavailability: groupByVenue(unavailability),
  };
}

function serializeVenue(
  venue,
  queryStart,
  queryEnd,
  schedules = { events: {}, holds: {}, unavailability: {} }
) {
  const { isAvailable, conflicts } = computeAvailability(
    venue,
    schedules.events[venue.id],
    queryStart,
    queryEnd,
    { holds: schedules.holds[venue.id], unavailability: schedules.unavailability[venue.id] }
  );
  return {
    ...venue.toJSON(),
    // `teardownMinutes` is the persisted column name retained for backwards
    // compatibility. Expose the user-story term as well for staff clients.
    turnaroundMinutes: venue.teardownMinutes,
    isAvailable,
    conflictingEventCount: conflicts.filter((c) => c.type === 'booking').length,
    conflictCount: conflicts.length,
  };
}

const venueTimingValidators = [
  body('setupMinutes').optional().isInt({ min: 0, max: 1440 }).withMessage('setupMinutes must be between 0 and 1440 minutes.'),
  body('teardownMinutes').optional().isInt({ min: 0, max: 1440 }).withMessage('teardownMinutes must be between 0 and 1440 minutes.'),
  body('turnaroundMinutes').optional().isInt({ min: 0, max: 1440 }).withMessage('turnaroundMinutes must be between 0 and 1440 minutes.'),
];

function normalizeVenueTiming(payload) {
  const normalized = { ...payload };
  if (normalized.turnaroundMinutes !== undefined && normalized.teardownMinutes !== undefined
    && Number(normalized.turnaroundMinutes) !== Number(normalized.teardownMinutes)) {
    throw { status: 400, message: 'turnaroundMinutes and teardownMinutes must match when both are provided.' };
  }
  if (normalized.turnaroundMinutes !== undefined) normalized.teardownMinutes = Number(normalized.turnaroundMinutes);
  if (normalized.setupMinutes !== undefined) normalized.setupMinutes = Number(normalized.setupMinutes);
  if (normalized.teardownMinutes !== undefined) normalized.teardownMinutes = Number(normalized.teardownMinutes);
  delete normalized.turnaroundMinutes;
  return normalized;
}

// ---------------------------------------------------------------------
// GET /api/venues — search, filter, sort the venue catalogue.
//
// All authenticated internal + external users may browse/search the
// venue catalogue (read-only) — matches "Venue Catalogue" being visible
// to Event Coordinators, Venue Staff, and Event Organisers when planning,
// even though the primary user for this story is the Event Coordinator.
//
// Query params (all optional):
//   search        - matches venue name OR location (partial, case-insensitive)
//   name          - matches venue name (partial, case-insensitive)
//   location      - matches venue location (partial, case-insensitive)
//   minCapacity / capacity - only venues with capacity >= this value
//   maxCapacity   - only venues with capacity <= this value
//   venueType     - comma-separated list of venue types (exact, case-insensitive)
//   facilities    - comma-separated list of required facilities (venue must have ALL)
//   availability  - "available" | "unavailable"
//   startDateTime / endDateTime - proposed event window (ISO8601, both-or-neither);
//                   when given, availability additionally checks for conflicting
//                   bookings, active tentative holds and unavailability periods
//                   (factoring in each venue's setup/teardown time)
//   sortBy        - "name" | "location" | "capacity" | "availability" (default "name")
//   sortOrder     - "asc" | "desc" (default "asc")
// ---------------------------------------------------------------------
router.get('/', authenticate, venueSearchValidators, validateRequest, async (req, res, next) => {
  try {
    let queryStart, queryEnd;
    try {
      ({ queryStart, queryEnd } = parseDateRange(req.query));
    } catch (rangeErr) {
      return res.status(rangeErr.status).json({ error: rangeErr.message });
    }

    const { search, name, location, venueType, facilities, availability } = req.query;
    const minCapacity = req.query.minCapacity ?? req.query.capacity;
    const maxCapacity = req.query.maxCapacity;

    const andConditions = [];

    if (search) {
      andConditions.push({
        [Op.or]: [
          { name: { [Op.iLike]: `%${search}%` } },
          { location: { [Op.iLike]: `%${search}%` } },
        ],
      });
    }
    if (name) andConditions.push({ name: { [Op.iLike]: `%${name}%` } });
    if (location) andConditions.push({ location: { [Op.iLike]: `%${location}%` } });
    if (minCapacity) andConditions.push({ capacity: { [Op.gte]: parseInt(minCapacity, 10) } });
    if (maxCapacity) andConditions.push({ capacity: { [Op.lte]: parseInt(maxCapacity, 10) } });

    const venueTypes = venueType
      ? venueType.split(',').map((t) => t.trim()).filter(Boolean)
      : [];
    if (venueTypes.length) {
      andConditions.push({ [Op.or]: venueTypes.map((t) => ({ venueType: { [Op.iLike]: t } })) });
    }

    const facilityList = facilities
      ? facilities.split(',').map((f) => f.trim()).filter(Boolean)
      : [];
    if (facilityList.length) {
      andConditions.push({ facilities: { [Op.contains]: facilityList } });
    }

    // Necessary (but not sufficient, when a date window is given) condition:
    // a venue under maintenance/blocked can never be "available".
    if (availability === 'available') {
      andConditions.push({ status: 'available' });
    }

    const sortBy = SORTABLE_FIELDS.includes(req.query.sortBy) ? req.query.sortBy : 'name';
    const sortDirection = String(req.query.sortOrder || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    // "availability" isn't a DB column (it's computed below), so fetch in
    // a stable default order and re-sort by it afterwards in JS.
    const dbOrder = sortBy === 'availability' ? [['name', 'ASC']] : [[sortBy, sortDirection]];

    const venues = await Venue.findAll({
      where: andConditions.length ? { [Op.and]: andConditions } : undefined,
      order: dbOrder,
    });

    const schedules = await loadSchedulesByVenue(venues.map((v) => v.id));

    let results = venues.map((venue) => serializeVenue(venue, queryStart, queryEnd, schedules));

    if (availability === 'available') results = results.filter((v) => v.isAvailable);
    if (availability === 'unavailable') results = results.filter((v) => !v.isAvailable);

    if (sortBy === 'availability') {
      const dir = sortDirection === 'DESC' ? -1 : 1;
      results.sort((a, b) => dir * ((b.isAvailable ? 1 : 0) - (a.isAvailable ? 1 : 0)));
    }

    const response = { venues: results, count: results.length };
    if (results.length === 0) {
      response.message = 'No venues match your search criteria. Try adjusting your filters.';
    }

    res.json(response);
  } catch (err) {
    next(err);
  }
});

// GET /api/venues/availability — calendar-friendly venue availability.
// Filter by `venueId` (a comma-separated list is accepted) and either
// `date=YYYY-MM-DD` or startDateTime+endDateTime. Slots include each venue's
// setup/teardown turnaround time, so displayed availability is request-safe.
const availabilityValidators = [
  query('date').optional().isISO8601({ strict: true, strictSeparator: true }).withMessage('date must be YYYY-MM-DD.'),
  ...dateRangeValidators,
  query('venueId').optional().isString().trim().isLength({ max: 2000 }),
];

router.get('/availability', authenticate, availabilityValidators, validateRequest, async (req, res, next) => {
  try {
    let queryStart, queryEnd;
    try {
      ({ queryStart, queryEnd } = parseAvailabilityRange(req.query));
    } catch (rangeErr) {
      return res.status(rangeErr.status).json({ error: rangeErr.message });
    }
    if (!queryStart || !queryEnd) {
      return res.status(400).json({ error: 'Provide date or startDateTime and endDateTime.' });
    }

    const venueIds = req.query.venueId
      ? req.query.venueId.split(',').map((id) => id.trim()).filter(Boolean)
      : [];
    if (venueIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
      return res.status(400).json({ error: 'venueId must contain valid UUID values.' });
    }

    const venues = await Venue.findAll({
      where: venueIds.length ? { id: { [Op.in]: venueIds } } : undefined,
      order: [['name', 'ASC']],
    });
    const events = venues.length
      ? await Event.findAll({ where: { venueId: { [Op.in]: venues.map((venue) => venue.id) } } })
      : [];
    const eventsByVenue = groupEventsByVenue(events);
    const availability = venues.map((venue) => ({
      venue: {
        id: venue.id,
        name: venue.name,
        location: venue.location,
        status: venue.status,
        setupMinutes: venue.setupMinutes,
        teardownMinutes: venue.teardownMinutes,
        turnaroundMinutes: venue.teardownMinutes,
      },
      slots: buildAvailabilitySlots(venue, eventsByVenue[venue.id], queryStart, queryEnd),
      conflicts: findReservationConflicts(venue, eventsByVenue[venue.id]),
    }));

    res.json({
      startDateTime: queryStart.toISOString(),
      endDateTime: queryEnd.toISOString(),
      states: Object.values(AVAILABILITY_STATES),
      availability,
      count: availability.length,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/venues/:id — full details for one venue, e.g. after selecting
// it from search results, for further review or to proceed to booking.
// Accepts the same optional startDateTime/endDateTime window so the
// viewer can confirm it's actually free for their proposed event slot.
router.get('/:id', authenticate, dateRangeValidators, validateRequest, async (req, res, next) => {
  try {
    const venue = await Venue.findByPk(req.params.id);
    if (!venue) return res.status(404).json({ error: 'Venue not found.' });

    let queryStart, queryEnd;
    try {
      ({ queryStart, queryEnd } = parseDateRange(req.query));
    } catch (rangeErr) {
      return res.status(rangeErr.status).json({ error: rangeErr.message });
    }

    const schedules = await loadSchedulesByVenue([venue.id]);
    res.json({ venue: serializeVenue(venue, queryStart, queryEnd, schedules) });
  } catch (err) {
    next(err);
  }
});

// Only Venue Staff may create, update, or block/unblock venues.
router.post('/', authenticate, authorize(ROLE_NAMES.VENUE_STAFF), venueTimingValidators, validateRequest, async (req, res, next) => {
  try {
    const venue = await Venue.create(normalizeVenueTiming(req.body));
    res.status(201).json({ venue: serializeVenue(venue) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Changing setup/turnaround minutes or the venue status can make existing
// bookings conflict under the updated rules. Existing reservations are
// flagged for review; they are never deleted or cancelled automatically.
router.patch(
  '/:id',
  authenticate,
  authorize(ROLE_NAMES.VENUE_STAFF),
  venueTimingValidators,
  validateRequest,
  async (req, res, next) => {
    try {
      const venue = await Venue.findByPk(req.params.id);
      if (!venue) return res.status(404).json({ error: 'Venue not found.' });

      const before = Object.fromEntries(
        SCHEDULE_AFFECTING_VENUE_FIELDS.map((field) => [field, venue[field]])
      );

      await venue.update(normalizeVenueTiming(req.body));

      const scheduleChanged = SCHEDULE_AFFECTING_VENUE_FIELDS.some(
        (field) => venue[field] !== before[field]
      );

      const events = await Event.findAll({ where: { venueId: venue.id } });
      const conflicts = findReservationConflicts(venue, events);

      const conflictAudit = scheduleChanged
        ? await auditVenueConflicts({ venueIds: [venue.id] })
        : undefined;

      return res.json({
        venue: serializeVenue(venue),
        conflicts,
        hasConflicts: conflicts.length > 0,
        ...(conflictAudit ? { conflictAudit } : {}),
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }
);

module.exports = router;
