const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
const REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

if (!ACCESS_SECRET || !REFRESH_SECRET) {
  // Fail fast: running with missing/default secrets is a security risk.
  console.warn(
    '⚠️  JWT_ACCESS_SECRET / JWT_REFRESH_SECRET are not set. Set them in your .env before deploying.'
  );
}

/**
 * Short-lived access token. Carries only the claims needed for RBAC
 * decisions (user id + role) so the API never has to hit the DB just
 * to authorise a request.
 */
function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.roleName, email: user.email, type: 'access' },
    ACCESS_SECRET,
    { expiresIn: ACCESS_EXPIRES_IN }
  );
}

/**
 * Longer-lived refresh token used only to mint new access tokens.
 * Its hash is persisted server-side (see RefreshToken model) so it
 * can be revoked (logout, password change, compromise) individually.
 */
function signRefreshToken(user) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ sub: user.id, type: 'refresh', jti }, REFRESH_SECRET, {
    expiresIn: REFRESH_EXPIRES_IN,
  });
  return { token, jti };
}

function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

/** Store only a SHA-256 hash of the refresh token server-side. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshExpiryDate() {
  const now = Date.now();
  const ms = parseDurationToMs(REFRESH_EXPIRES_IN);
  return new Date(now + ms);
}

/** Minimal duration parser supporting 15m, 7d, 1h, 3600 (seconds) formats. */
function parseDurationToMs(duration) {
  if (typeof duration === 'number') return duration * 1000;
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) return 7 * 24 * 60 * 60 * 1000; // default 7 days
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const unitMs = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * unitMs[unit];
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  refreshExpiryDate,
};
