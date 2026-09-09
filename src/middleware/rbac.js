const { ROLE_NAMES } = require('../models/Role');

/**
 * Role-Based Access Control middleware factory.
 *
 * Usage:
 *   router.post('/venues', authenticate, authorize(ROLE_NAMES.VENUE_STAFF), createVenue);
 *   router.get('/events/:id', authenticate, authorize(
 *      ROLE_NAMES.EVENT_COORDINATOR, ROLE_NAMES.EVENT_ORGANISER
 *   ), getEvent);
 *
 * Must run AFTER `authenticate`, since it relies on req.user being set.
 * Fails closed: if req.user is missing (authenticate not applied, or a
 * bug), the request is rejected rather than allowed through.
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Forbidden. This action requires one of the following roles: ${allowedRoles.join(', ')}.`,
      });
    }

    next();
  };
}

/**
 * Ownership/relationship check helper: allows a request to proceed if
 * the user has one of the given roles, OR if a custom predicate
 * (e.g. "is this Organiser's own event request") returns true. This
 * supports the briefing's requirement that, e.g., an Event Organiser
 * should not view events belonging to unrelated clients.
 */
function authorizeOwnerOrRoles(predicate, ...allowedRoles) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    if (allowedRoles.includes(req.user.role)) return next();

    try {
      const isOwner = await predicate(req);
      if (isOwner) return next();
    } catch (err) {
      return next(err);
    }

    return res.status(403).json({ error: 'Forbidden. You do not have access to this resource.' });
  };
}

module.exports = { authorize, authorizeOwnerOrRoles, ROLE_NAMES };
