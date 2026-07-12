const bcrypt = require('bcryptjs');

// bcrypt via bcryptjs — a pure-JS implementation (no native addon to compile
// in the container image) that reads and writes the same `$2b$` hash format
// as native bcrypt, which is what matters: DATABASE.md's seed rows are
// `$2b$12$...` hashes, and this module must verify them unchanged.
//
// Business rule 1: the master password is hashed-only, never stored or
// logged in recoverable form, and must be at least 12 characters. This
// module is the only place a master password is turned into (or checked
// against) a hash; nothing upstream should call bcrypt directly.

const SALT_ROUNDS = 12;
const MIN_MASTER_PASSWORD_LENGTH = 12;

/**
 * Hashes a master password for storage. Used at registration and on a
 * master-password change — not on every login, which only ever compares.
 *
 * @param password  plaintext, never persisted or logged by this module or
 *                   any caller of it.
 * @returns {Promise<string>} a `$2b$` bcrypt hash.
 */
async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_MASTER_PASSWORD_LENGTH) {
    throw new TypeError(
      `password must be a string of at least ${MIN_MASTER_PASSWORD_LENGTH} characters`
    );
  }
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Constant-time (bcrypt.compare) verification against a stored hash. Called
 * by session-issuer.js's verifyMasterPassword.
 *
 * @param hash      the stored `masterPasswordHash`.
 * @param password  the plaintext the caller is trying to log in with.
 * @returns {Promise<boolean>} never throws on a malformed hash — a corrupt
 *          or unexpected hash format simply fails to verify, so a storage
 *          anomaly denies a login instead of crashing the request.
 */
async function verifyPassword(hash, password) {
  if (typeof hash !== 'string' || hash === '' || typeof password !== 'string') {
    return false;
  }
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, SALT_ROUNDS, MIN_MASTER_PASSWORD_LENGTH };
