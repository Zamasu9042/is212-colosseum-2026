const express = require('express');
const { body } = require('express-validator');
const { EventRequest } = require('../models');
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
  body('registrationRequired').optional({ nullable: true }).isBoolean(),
];

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
      const request = await EventRequest.findByPk(req.params.id);
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
      const validStatuses = ['under_review', 'approved', 'rejected', 'returned'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
      }
      const request = await EventRequest.findByPk(req.params.id);
      if (!request) return res.status(404).json({ error: 'Event request not found.' });
      request.status = status;
      await request.save();
      res.json({ eventRequest: request });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;