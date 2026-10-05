const express = require('express');
const { Op } = require('sequelize');
const { body } = require('express-validator');
const { sequelize, EventRequest, Role, User } = require('../models');
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
  'accessibilityRequirements',
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
  body('accessibilityRequirements').optional({ nullable: true }).isString(),
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

async function findLeastAssignedCoordinator(transaction) {
  const coordinators = await User.findAll({
    attributes: ['id', 'email', 'firstName', 'lastName'],
    where: { isActive: true },
    include: [
      {
        model: Role,
        attributes: [],
        where: { name: ROLE_NAMES.EVENT_COORDINATOR },
        required: true,
      },
    ],
    order: [
      ['email', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });

  if (coordinators.length === 0) return null;

  const coordinatorsWithCounts = await Promise.all(
    coordinators.map(async (coordinator) => ({
      coordinator,
      assignedCount: await EventRequest.count({
        where: {
          assignedCoordinatorId: coordinator.id,
          status: { [Op.in]: ['submitted', 'under_review'] },
        },
        transaction,
      }),
    }))
  );

  return coordinatorsWithCounts.reduce((leastAssigned, current) =>
    current.assignedCount < leastAssigned.assignedCount ? current : leastAssigned
  ).coordinator;
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
      const drafts = await EventRequest.findAll({
        where: { organiserId: req.user.id, status: 'draft' },
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

// Event Coordinators review submitted requests from this queue. It
// deliberately excludes drafts (still private working copies) and final
// outcomes such as approved/rejected/returned.
router.get(
  '/review-queue',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  async (req, res, next) => {
    try {
      const requests = await EventRequest.findAll({
        where: { status: { [Op.in]: ['submitted', 'under_review'] } },
        include: detailedIncludes,
        order: [['updated_at', 'DESC']],
      });
      res.json({ eventRequests: requests });
    } catch (err) {
      next(err);
    }
  }
);

// Event Coordinators can view any request (to review/assign).
// An Event Organiser may only view their OWN request — this enforces
// the briefing's requirement that an Organiser should not see events
// belonging to unrelated clients.
router.get(
  '/:id',
  authenticate,
  authorizeOwnerOrRoles(
    async (req) => {
      const request = await EventRequest.findByPk(req.params.id);
      return !!request && request.organiserId === req.user.id;
    },
    ROLE_NAMES.EVENT_COORDINATOR
  ),
  async (req, res, next) => {
    try {
      const request = await EventRequest.findByPk(req.params.id, { include: detailedIncludes });
      if (!request) return res.status(404).json({ error: 'Event request not found.' });
      res.json({ eventRequest: request });
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

// Only Event Coordinators can approve/reject/return a submitted request.
router.patch(
  '/:id/status',
  authenticate,
  authorize(ROLE_NAMES.EVENT_COORDINATOR),
  async (req, res, next) => {
    try {
      const { status } = req.body;
      const reviewReason =
        typeof req.body.reviewReason === 'string' ? req.body.reviewReason.trim() : null;
      const validStatuses = ['approved', 'rejected', 'returned'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
      }

      if (status === 'rejected' && !reviewReason) {
        return res.status(400).json({ error: 'reviewReason is required when rejecting a request.' });
      }

      const request = await EventRequest.findByPk(req.params.id);
      if (!request) return res.status(404).json({ error: 'Event request not found.' });

      if (!['submitted', 'under_review'].includes(request.status)) {
        return res
          .status(409)
          .json({ error: 'Only submitted or under review requests can be reviewed.' });
      }

      await request.update({
        status,
        reviewReason,
        reviewedAt: new Date(),
        reviewedBy: req.user.id,
      });
      res.json({ eventRequest: request });
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

      const assignedCoordinator = await sequelize.transaction(async (transaction) => {
        const coordinator = await findLeastAssignedCoordinator(transaction);
        if (!coordinator) return null;

        await eventRequest.update(
          {
            status: 'submitted',
            submittedAt: new Date(),
            assignedCoordinatorId: coordinator.id,
          },
          { transaction }
        );

        return coordinator;
      });

      if (!assignedCoordinator) {
        return res.status(409).json({ error: 'No active Event Coordinator is available.' });
      }

      await eventRequest.reload({ include: detailedIncludes });
      res.json({ eventRequest });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
