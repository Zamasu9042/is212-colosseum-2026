const bcrypt = require('bcrypt');

const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 12;

/**
 * Hash a plaintext password. Never store or log the plaintext value.
 */
async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

/**
 * Compare a plaintext password against a stored bcrypt hash.
 */
async function comparePassword(plainPassword, passwordHash) {
  return bcrypt.compare(plainPassword, passwordHash);
}

/**
 * Basic password strength check enforced at registration time.
 * Real deployments may want to layer in a breached-password check.
 */
function isPasswordStrongEnough(password) {
  if (typeof password !== 'string' || password.length < 8) return false;
  const hasLetter = /[A-Za-z]/.test(password);
  const hasNumber = /\d/.test(password);
  return hasLetter && hasNumber;
}

module.exports = { hashPassword, comparePassword, isPasswordStrongEnough };
