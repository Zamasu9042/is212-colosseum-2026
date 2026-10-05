const express = require('express');
const { Op } = require('sequelize');
const { query } = require('express-validator');
const { Venue } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');
const { computeAvailability } = require('../utils/venueAvailability');
const { loadVenueSchedules } = require('../services/venueConflictService');

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

/** Groups rows (events/holds/unavailability) by venueId for O(1) lookup. */
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

function serializeVenue(venue, queryStart, queryEnd, schedules) {
  const { isAvailable, conflicts } = computeAvailability(
    venue,
    schedules.events[venue.id],
    queryStart,
    queryEnd,
    { holds: schedules.holds[venue.id], unavailability: schedules.unavailability[venue.id] }
  );
  return {
    ...venue.toJSON(),
    isAvailable,
    conflictingEventCount: conflicts.filter((c) => c.type === 'booking').length,
    conflictCount: conflicts.length,
  };
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
router.post('/', authenticate, authorize(ROLE_NAMES.VENUE_STAFF), async (req, res, next) => {
  try {
    const venue = await Venue.create(req.body);
    res.status(201).json({ venue });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', authenticate, authorize(ROLE_NAMES.VENUE_STAFF), async (req, res, next) => {
  try {
    const venue = await Venue.findByPk(req.params.id);
    if (!venue) return res.status(404).json({ error: 'Venue not found.' });
    await venue.update(req.body);
    res.json({ venue });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
