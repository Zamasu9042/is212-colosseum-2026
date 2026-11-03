const express = require('express');
const { Op } = require('sequelize');
const { body, query, param } = require('express-validator');
const { sequelize, EventRequest, Event, Notification, Role, User } = require('../models');
const { authenticate } = require('../middleware/auth');
const { authorize, authorizeOwnerOrRoles, ROLE_NAMES } = require('../middleware/rbac');
const { validateRequest } = require('../middleware/validate');

const router = express.Router();

// Fields an Event Organiser is allowed to set directly when creating or
// editing their own request. Deliberately excludes organiserId,
// organisationId, status, submittedAt, and every reviewed*/review*
// field — those are either derived from the authenticated account or
// only ever changed by the approval flow (PATCH /:id/status below).
// Whitelisting like this is what guarantees a draft save can never be
// used to smuggle in an approval, a submission, or someone else's id.
const DRAFT_FIELDS = [
  'eventName',
  'description',
  'purpose',
  'category',
  'preferredStart',
  'preferredEnd',
  'expectedAttendance',
  'venueRequirements',
  'requestedLayout',
  'accessibilityRequirements',
  'facilityRequirements',
  'setupRequirements',
  'equipmentRequirements',
  'layout',
  'registrationSetup',
  'registrationRequired',
];

function pickDraftFields(body) {
  const result = {};
  for (const key of DRAFT_FIELDS) {
    if (key in body) result[key] = body[key];
  }
  return result;
}

// Loose on purpose: a draft is explicitly allowed to be incomplete, so
// nothing is .notEmpty()/required here — only type-checked IF present.
const draftValidators = [
  body('eventName').optional({ nullable: true }).isString().isLength({ max: 200 }),
  body('description').optional({ nullable: true }).isString(),
  body('purpose').optional({ nullable: true }).isString(),
  body('category').optional({ nullable: true }).isString().isLength({ max: 50 }),
  body('preferredStart').optional({ nullable: true }).isISO8601(),
  body('preferredEnd').optional({ nullable: true }).isISO8601(),
  body('expectedAttendance').optional({ nullable: true }).isInt({ min: 1 }),
  body('venueRequirements').optional({ nullable: true }).isString(),
  body('requestedLayout').optional({ nullable: true }).isString().isLength({ max: 100 }),
  body('accessibilityRequirements').optional({ nullable: true }).isString(),
  body('facilityRequirements').optional({ nullable: true }).isString(),
  body('setupRequirements').optional({ nullable: true }).isString(),
  body('equipmentRequirements').optional({ nullable: true }).isString(),
  body('layout').optional({ nullable: true }).isString(),
  body('registrationSetup').optional({ nullable: true }).isString(),
  body('registrationRequired').optional({ nullable: true }).isBoolean(),
];

const organiserInclude = {
  model: User,
  as: 'organiser',
  attributes: ['id', 'email', 'firstName', 'lastName', 'organisationId'],
};

const assignedCoordinatorInclude = {
  model: User,
  as: 'assignedCoordinator',
  attributes: ['id', 'email', 'firstName', 'lastName'],
};

const detailedIncludes = [organiserInclude, assignedCoordinatorInclude];

// These are the minimum operational details a Venue Staff member needs before
// accepting a reservation.  A string containing only whitespace is not a
// usable requirement, and attendance must be a positive number.
const MANDATORY_BOOKING_DETAILS = [
  ['eventName', 'event name'],
  ['preferredStart', 'start date and time'],
  ['preferredEnd', 'end date and time'],
  ['expectedAttendance', 'expected attendance'],
  ['requestedLayout', 'requested layout'],
  ['accessibilityRequirements', 'accessibility needs'],
  ['facilityRequirements', 'facility requirements'],
  ['setupRequirements', 'setup requirements'],
];

function isMissingBookingDetail(field, value) {
  if (field === 'expectedAttendance') return !Number.isInteger(value) || value < 1;
  return value === null || value === undefined || (typeof value === 'string' && !value.trim());
}

function getMissingBookingDetails(eventRequest) {
  return MANDATORY_BOOKING_DETAILS.filter(([field]) => isMissingBookingDetail(field, eventRequest[field]))
    .map(([, label]) => label);
}

function serializeBookingForReview(eventRequest) {
  const booking = eventRequest.toJSON ? eventRequest.toJSON() : eventRequest;
  const missingDetails = getMissingBookingDetails(booking);

  return {
    ...booking,
    bookingDetails: {
      startDateTime: booking.preferredStart,
      endDateTime: booking.preferredEnd,
      expectedAttendance: booking.expectedAttendance,
      requestedLayout: booking.requestedLayout,
      accessibilityNeeds: booking.accessibilityRequirements,
      facilityRequirements: booking.facilityRequirements,
      setupRequirements: booking.setupRequirements,
    },
    missingDetails,
    isReadyForApproval: missingDetails.length === 0,
  };
}

// Booking requests are EventRequest records in this application.  Keep the
// search definition in one place so the pending queue and decision history
// behave identically for Venue Staff.
const bookingSearchValidators = [
  query('search').optional().isString().trim().isLength({ max: 200 }),
];

function bookingSearchWhere(search) {
  if (!search) return undefined;

  return {
    [Op.or]: [
      { eventName: { [Op.iLike]: `%${search}%` } },
      { description: { [Op.iLike]: `%${search}%` } },
      { purpose: { [Op.iLike]: `%${search}%` } },
      { category: { [Op.iLike]: `%${search}%` } },
      { venueRequirements: { [Op.iLike]: `%${search}%` } },
      // `$alias.column$` is emitted literally by Sequelize, so these use
      // the persisted snake_case column names rather than model attributes.
      { '$organiser.first_name$': { [Op.iLike]: `%${search}%` } },
      { '$organiser.last_name$': { [Op.iLike]: `%${search}%` } },
      { '$organiser.email$': { [Op.iLike]: `%${search}%` } },
    ],
  };
}

async function findBookingRequests(statuses, search) {
  const searchCondition = bookingSearchWhere(search);
  const conditions = [{ status: { [Op.in]: statuses } }];
  if (searchCondition) conditions.push(searchCondition);

  return EventRequest.findAll({
    where: { [Op.and]: conditions },
    include: [organiserInclude],
    // A left join keeps requests accessible even if an organiser account has
    // since been removed, while still allowing organiser-name searching.
    subQuery: false,
    order: [['updated_at', 'DESC']],
  });
}

// Only Event Organisers can create requests (Attendees, staff cannot).
// Saving here always produces a 'draft' — there is no way for the
// client to set status via this endpoint, so this alone can never
// submit, trigger approval, or send a notification.
router.post(
  '/',
  authenticate,
  authorize(ROLE_NAMES.EVENT_ORGANISER),
  draftValidators,
  validateRequest,
  async (req, res, next) => {
    try {
      const request = await EventRequest.create({
        ...pickDraftFields(req.body),
        organiserId: req.user.id,
        organisationId: req.user.organisationId,
        status: 'draft',
      });
      res.status(201).json({ eventRequest: request });
    } catch (err) {
      next(err);
    }
  }
);

// An Event Organiser's own saved drafts — what they see when they leave
// and come back to the system. Coordinators aren't included here; they
// work from the review queue (under_review/approved/etc.), not an
// individual organiser's draft list.
router.get(
  '/',
  authenticate,
  authorize(ROLE_NAMES.EVENT_ORGANISER),
  async (req, res, next) => {
    try {
      // ?scope=all returns every request the organiser owns (used by the
      // web UI to show submitted/approved requests too). Default stays
      // drafts-only for backwards compatibility.
      const where = { organiserId: req.user.id };
      if (req.query.scope !== 'all') where.status = 'draft';
      const drafts = await EventRequest.findAll({
        where,
        // NOTE: this model's createdAt/updatedAt options were passed as
        // strings ('created_at' / 'updated_at'), which renames the actual
        // Sequelize attribute to that string, not just the column — so
        // the attribute here really is 'updated_at', not 'updatedAt'.
        order: [['updated_at', 'DESC']],
      });
      res.json({ eventRequests: drafts });
    } catch (err) {
      next(err);
    }
  }
);

// Event Coordinators review only requests assigned to them. Drafts remain
// private working copies and final outcomes are excluded.
router.get(
  '/review-queue',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  async (req, res, next) => {
    try {
      const requests = await EventRequest.findAll({
        where: {
          status: { [Op.in]: ['submitted', 'under_review'] },
          assignedCoordinatorId: req.user.id,
        },
        include: detailedIncludes,
        order: [['updated_at', 'DESC']],
      });
      res.json({ eventRequests: requests });
    } catch (err) {
      next(err);
    }
  }
);

// Shared Lead queue. Assignment is deliberately not claimed by a Lead: every
// Event Coordinator Lead sees the same unassigned requests.
router.get(
  '/unassigned',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR_LEAD),
  async (req, res, next) => {
    try {
      const requests = await EventRequest.findAll({
        where: {
          status: { [Op.in]: ['submitted', 'under_review'] },
          assignedCoordinatorId: null,
        },
        include: detailedIncludes,
        order: [['updated_at', 'DESC']],
      });
      res.json({ eventRequests: requests, count: requests.length });
    } catch (err) {
      next(err);
    }
  }
);

// All Leads have shared supervisory visibility of Coordinator assignments.
router.get(
  '/assignments',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR_LEAD),
  async (req, res, next) => {
    try {
      const requests = await EventRequest.findAll({
        where: {
          status: { [Op.in]: ['submitted', 'under_review', 'approved'] },
          assignedCoordinatorId: { [Op.not]: null },
        },
        include: detailedIncludes,
        order: [['updated_at', 'DESC']],
      });
      res.json({ eventRequests: requests, count: requests.length });
    } catch (err) {
      next(err);
    }
  }
);

// Venue Staff's operational booking queue.  A pending decision is represented
// by submitted/under_review; drafts are intentionally excluded because they
// have not been submitted for a reservation decision yet.
//
// `search` matches the event and request details as well as the requester's
// name/email.  It is deliberately server-side so the result remains correct
// when the queue spans more than one client page.
router.get(
  '/booking-requests/pending',
  authenticate,
  authorize(ROLE_NAMES.VENUE_STAFF),
  bookingSearchValidators,
  validateRequest,
  async (req, res, next) => {
    try {
      const requests = await findBookingRequests(['submitted', 'under_review'], req.query.search);
      res.json({
        eventRequests: requests.map(serializeBookingForReview),
        count: requests.length,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Historical decisions for Venue Staff.  "Accepted" maps to the existing
// domain status `approved`; retaining that status avoids a second, conflicting
// approval lifecycle for the same request.
router.get(
  '/booking-requests/history',
  authenticate,
  authorize(ROLE_NAMES.VENUE_STAFF),
  bookingSearchValidators,
  validateRequest,
  async (req, res, next) => {
    try {
      const requests = await findBookingRequests(['approved', 'rejected'], req.query.search);
      res.json({
        eventRequests: requests.map(serializeBookingForReview),
        count: requests.length,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Full decision view for a single booking request. Unlike the generic event
// request endpoint, this makes the operational fields and completeness state
// explicit for the Venue Staff review experience.
router.get(
  '/booking-requests/:id',
  authenticate,
  authorize(ROLE_NAMES.VENUE_STAFF),
  async (req, res, next) => {
    try {
      const booking = await EventRequest.findByPk(req.params.id, { include: [organiserInclude] });
      if (!booking || !['submitted', 'under_review', 'approved', 'rejected'].includes(booking.status)) {
        return res.status(404).json({ error: 'Booking request not found.' });
      }
      res.json({ eventRequest: serializeBookingForReview(booking) });
    } catch (err) {
      next(err);
    }
  }
);

// An assigned Event Coordinator may view their request. An Event Organiser may
// only view their OWN request — this enforces
// the briefing's requirement that an Organiser should not see events
// belonging to unrelated clients.
router.get(
  '/:id',
  authenticate,
  authorizeOwnerOrRoles(
    async (req) => {
      const request = await EventRequest.findByPk(req.params.id);
      if (!request) return false;
      if (req.user.role === ROLE_NAMES.EVENT_COORDINATOR) {
        return request.assignedCoordinatorId === req.user.id;
      }
      return request.organiserId === req.user.id;
    },
    ROLE_NAMES.VENUE_STAFF,
    ROLE_NAMES.SAFETY_OFFICER
  ),
  async (req, res, next) => {
    try {
      const request = await EventRequest.findByPk(req.params.id, { include: detailedIncludes });
      if (!request) return res.status(404).json({ error: 'Event request not found.' });
      res.json({
        eventRequest:
          req.user.role === ROLE_NAMES.VENUE_STAFF ? serializeBookingForReview(request) : request,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Assign or reassign a Coordinator. The existing EventRequest assignment is
// the source of truth before an Event exists; once it does, both records stay
// aligned in one transaction. Leads share this capability—there is no claim
// or exclusive Lead ownership.
router.patch(
  '/:id/assignment',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR_LEAD),
  param('id').isUUID(),
  body('coordinatorId').isUUID(),
  validateRequest,
  async (req, res, next) => {
    try {
      const result = await sequelize.transaction(async (transaction) => {
        const eventRequest = await EventRequest.findByPk(req.params.id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!eventRequest) return { error: 'Event request not found.', status: 404 };

        const event = await Event.findOne({
          where: { eventRequestId: eventRequest.id },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!event && !['submitted', 'under_review'].includes(eventRequest.status)) {
          return { error: 'Only submitted or under review requests can be assigned.', status: 409 };
        }
        if (event && ['completed', 'cancelled'].includes(event.status)) {
          return { error: `Cannot reassign a ${event.status} event.`, status: 409 };
        }

        const coordinator = await User.findOne({
          where: { id: req.body.coordinatorId, isActive: true },
          include: [{ model: Role, where: { name: ROLE_NAMES.EVENT_COORDINATOR }, required: true }],
          transaction,
        });
        if (!coordinator) {
          return { error: 'coordinatorId must identify an active Event Coordinator.', status: 422 };
        }

        const previousCoordinatorId = eventRequest.assignedCoordinatorId;
        const isReassignment = Boolean(
          previousCoordinatorId && previousCoordinatorId !== coordinator.id
        );

        await eventRequest.update({ assignedCoordinatorId: coordinator.id }, { transaction });
        if (event) await event.update({ coordinatorId: coordinator.id }, { transaction });

        if (isReassignment) {
          const coordinatorName = [coordinator.firstName, coordinator.lastName].filter(Boolean).join(' ');
          await Notification.bulkCreate(
            [
              {
                userId: coordinator.id,
                type: 'event_coordinator_reassigned',
                eventId: event?.id || null,
                message: `You have been reassigned to coordinate event: ${eventRequest.eventName}.`,
              },
              {
                userId: previousCoordinatorId,
                type: 'event_coordinator_reassigned',
                eventId: event?.id || null,
                message: `You are no longer assigned to coordinate event: ${eventRequest.eventName}.`,
              },
              {
                userId: eventRequest.organiserId,
                type: 'event_coordinator_reassigned',
                eventId: event?.id || null,
                message: `Your event ${eventRequest.eventName} has been reassigned to ${coordinatorName}.`,
              },
            ],
            { transaction }
          );
        } else if (!previousCoordinatorId) {
          await Notification.create(
            {
              userId: coordinator.id,
              type: 'event_coordinator_assigned',
              eventId: event?.id || null,
              message: `You have been assigned to coordinate event request: ${eventRequest.eventName}.`,
            },
            { transaction }
          );
        }
        return { eventRequest, event };
      });

      if (result.error) return res.status(result.status).json({ error: result.error });
      await result.eventRequest.reload({ include: detailedIncludes });
      res.json({ eventRequest: result.eventRequest, event: result.event });
    } catch (err) {
      next(err);
    }
  }
);

// Edit and re-save a draft. Organiser-owned, and only while status is
// still 'draft' — once a request has moved past that (submitted and
// beyond), it's no longer freely editable through this endpoint. Like
// POST /, the field whitelist means this can never change status,
// organiserId, or trigger anything downstream — it only ever updates
// content columns, so saving an edit can't submit the request, trigger
// approval, or send a notification.
router.patch(
  '/:id',
  authenticate,
  authorize(ROLE_NAMES.EVENT_ORGANISER),
  draftValidators,
  validateRequest,
  async (req, res, next) => {
    try {
      const request = await EventRequest.findByPk(req.params.id);
      if (!request) return res.status(404).json({ error: 'Event request not found.' });

      if (request.organiserId !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
      }
      if (request.status !== 'draft') {
        return res
          .status(409)
          .json({ error: 'Only requests still in draft status can be edited this way.' });
      }

      await request.update(pickDraftFields(req.body));
      res.json({ eventRequest: request });
    } catch (err) {
      next(err);
    }
  }
);

// Event Coordinators can approve/reject/return a submitted request; Venue
// Staff have the narrower booking decision of approve/reject. reviewedBy
// always records the staff member who made the decision.
router.patch(
  '/:id/status',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR, ROLE_NAMES.VENUE_STAFF),
  async (req, res, next) => {
    try {
      const { status } = req.body;
      const reviewReason =
        typeof req.body.reviewReason === 'string' ? req.body.reviewReason.trim() : null;
      const validStatuses =
        req.user.role === ROLE_NAMES.VENUE_STAFF
          ? ['approved', 'rejected']
          : ['approved', 'rejected', 'returned'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
      }

      if (status === 'rejected' && !reviewReason) {
        return res.status(400).json({ error: 'reviewReason is required when rejecting a request.' });
      }

      const request = await EventRequest.findByPk(req.params.id);
      if (!request) return res.status(404).json({ error: 'Event request not found.' });

      if (
        req.user.role === ROLE_NAMES.EVENT_COORDINATOR &&
        request.assignedCoordinatorId !== req.user.id
      ) {
        return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
      }

      if (!['submitted', 'under_review'].includes(request.status)) {
        return res
          .status(409)
          .json({ error: 'Only submitted or under review requests can be reviewed.' });
      }

      // Venue Staff may reject an incomplete request with an explanation, but
      // cannot accept it until every operational booking detail is present.
      if (req.user.role === ROLE_NAMES.VENUE_STAFF && status === 'approved') {
        const missingDetails = getMissingBookingDetails(request);
        if (missingDetails.length) {
          return res.status(422).json({
            error: 'Booking request is incomplete and cannot be approved.',
            missingDetails,
          });
        }
      }

      await request.update({
        status,
        reviewReason,
        reviewedAt: new Date(),
        reviewedBy: req.user.id,
      });

      // An approved request becomes an Event (schema.sql: "Created once an
      // EventRequest is approved and a Coordinator assigned"). Downstream
      // planning — venue bookings, equipment reservations (SCRUM-21) —
      // hangs off that Event. Idempotent via findOrCreate.
      // Applies to both approval paths: a Coordinator approving after review,
      // or Venue Staff accepting the booking request.
      let event = null;
      if (status === 'approved' && request.preferredStart && request.preferredEnd) {
        [event] = await Event.findOrCreate({
          where: { eventRequestId: request.id },
          defaults: {
            eventRequestId: request.id,
            coordinatorId: request.assignedCoordinatorId,
            startDatetime: request.preferredStart,
            endDatetime: request.preferredEnd,
            status: 'planning',
          },
        });
      }
      res.json({ eventRequest: request, ...(event ? { event } : {}) });
    } catch (err) {
      next(err);
    }
  }
);

// Fields that must all be present before a request can be submitted.
// Drafts may remain incomplete; this endpoint is the deliberate gate
// into the pending-review queue.
const REQUIRED_TO_SUBMIT = [
  'eventName',
  'description',
  'purpose',
  'preferredStart',
  'preferredEnd',
  'expectedAttendance',
  'venueRequirements',
  'accessibilityRequirements',
  'equipmentRequirements',
  'layout',
  'registrationSetup',
];

function missingRequiredFields(eventRequest) {
  return REQUIRED_TO_SUBMIT.filter(
    (field) =>
      eventRequest[field] === null ||
      eventRequest[field] === undefined ||
      (typeof eventRequest[field] === 'string' && eventRequest[field].trim() === '')
  );
}

// Submit a completed draft for planning. This is the only place status
// can move from 'draft' to 'submitted' — POST / and PATCH /:id can
// never do this themselves (the DRAFT_FIELDS whitelist excludes
// status), so a request can only be submitted deliberately, through
// this endpoint, by the organiser who owns it, and only once every
// required field is actually filled in.
router.post(
  '/:id/submit',
  authenticate,
  authorize(ROLE_NAMES.EVENT_ORGANISER),
  async (req, res, next) => {
    try {
      const eventRequest = await EventRequest.findByPk(req.params.id);
      if (!eventRequest) return res.status(404).json({ error: 'Event request not found.' });

      if (eventRequest.organiserId !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
      }
      if (eventRequest.status !== 'draft') {
        return res
          .status(409)
          .json({ error: 'Only requests still in draft status can be submitted.' });
      }

      const missing = missingRequiredFields(eventRequest);
      if (missing.length > 0) {
        return res.status(400).json({
          error: 'Cannot submit: required information is missing.',
          missingFields: missing,
        });
      }

      await eventRequest.update({ status: 'submitted', submittedAt: new Date(), assignedCoordinatorId: null });

      await eventRequest.reload({ include: detailedIncludes });
      res.json({ eventRequest });
    } catch (err) {
      next(err);
    }
  }
);

// An Event Organiser may change their own request while it is still waiting
// for a decision (submitted / under_review). Nothing is approved yet, so no
// review step is needed; the assigned Coordinator is simply told it changed.
router.patch(
  '/:id/amend',
  authenticate,
  authorize(ROLE_NAMES.EVENT_ORGANISER),
  param('id').isUUID(),
  draftValidators,
  validateRequest,
  async (req, res, next) => {
    try {
      const eventRequest = await EventRequest.findByPk(req.params.id);
      if (!eventRequest) return res.status(404).json({ error: 'Event request not found.' });
      if (eventRequest.organiserId !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
      }
      if (!['submitted', 'under_review'].includes(eventRequest.status)) {
        return res.status(409).json({
          error: 'Only submitted requests awaiting a decision can be amended this way. Approved events need a change request.',
        });
      }
      const updates = pickDraftFields(req.body);
      if (!Object.keys(updates).length) {
        return res.status(400).json({ error: 'No editable fields supplied.' });
      }
      const merged = EventRequest.build({ ...eventRequest.toJSON(), ...updates });
      const missing = missingRequiredFields(merged);
      if (missing.length > 0) {
        return res.status(400).json({ error: 'Required information cannot be removed from a submitted request.', missingFields: missing });
      }
      const start = new Date(merged.preferredStart);
      const end = new Date(merged.preferredEnd);
      if (!(end > start)) {
        return res.status(400).json({ error: 'preferredEnd must be after preferredStart.' });
      }

      const changed = Object.keys(updates).filter((k) => String(eventRequest[k] ?? '') !== String(updates[k] ?? ''));
      await eventRequest.update(updates);
      if (changed.length && eventRequest.assignedCoordinatorId) {
        await Notification.create({
          userId: eventRequest.assignedCoordinatorId,
          type: 'event_request_amended',
          message: `The organiser updated the submitted request "${eventRequest.eventName}" (${changed.join(', ')}). Please review the latest version.`,
        });
      }
      await eventRequest.reload({ include: detailedIncludes });
      res.json({ eventRequest, changedFields: changed });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;