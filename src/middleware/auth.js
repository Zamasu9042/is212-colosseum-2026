const { verifyAccessToken } = require('../utils/jwt');
const { User, Role } = require('../models');

/**
 * Routes that do NOT require an authenticated account. Everything else
 * in the API is blocked for unauthenticated ("guest") requests — this
 * is the "Account Enforcement" deliverable.
 *
 * Keep this list tight and explicit rather than pattern-matching, so
 * a new route is secure-by-default unless someone deliberately opts
 * it out here.
 */
const PUBLIC_ROUTES = [
  { method: 'GET', path: '/health' },
  { method: 'POST', path: '/api/auth/register' },
  { method: 'POST', path: '/api/auth/login' },
  { method: 'POST', path: '/api/auth/refresh' },
  // Logout only needs the httpOnly refreshToken cookie to revoke the
  // session server-side — requiring a *valid* access token here would
  // mean a user whose access token has already expired (a common case,
  // since access tokens are short-lived) could never log out.
  { method: 'POST', path: '/api/auth/logout' },
];

function isPublicRoute(req) {
  const path = req.originalUrl.split('?')[0]; // originalUrl survives mount-prefix stripping
  return PUBLIC_ROUTES.some(
    (route) => route.method === req.method && path === route.path
  );
}

/**
 * Verifies the access token from the Authorization header, loads the
 * corresponding active user, and attaches it to req.user. Rejects the
 * request with 401 for anything invalid, expired, or missing — there
 * is no "guest" fallthrough.
 */
async function authenticate(req, res, next) {
  if (isPublicRoute(req)) return next();

  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Authentication required. No token provided.' });
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    const message =
      err.name === 'TokenExpiredError' ? 'Access token expired.' : 'Invalid access token.';
    return res.status(401).json({ error: message });
  }

  if (payload.type !== 'access') {
    return res.status(401).json({ error: 'Invalid token type for this endpoint.' });
  }

  const user = await User.findByPk(payload.sub, { include: Role });
  if (!user || !user.isActive) {
    return res.status(401).json({ error: 'Account not found or has been deactivated.' });
  }

  req.user = {
    id: user.id,
    email: user.email,
    role: user.Role.name,
    organisationId: user.organisationId,
  };

  next();
}

module.exports = { authenticate, PUBLIC_ROUTES };
