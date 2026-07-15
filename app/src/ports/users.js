const { getPool } = require('../db/pool');

// The `users` port session-issuer.js and routes/session.js read/write
// through. Method-for-method identical to tests/helpers/fake-database.js's
// `users_` object, which is the reference contract this file must satisfy.
//
// Schema target: docs/action_plan/0014-database-schema-implementation.md's
// reconciled shape — USERS gains `is_deleted` (soft delete, see that PRD's
// rationale for the audit FK becoming RESTRICT), everything else as captured
// in docs/action_plan/DATABASE.md.

// Business rule 1's other half, enforced here rather than only in the route:
// five consecutive failures lock the account for fifteen minutes.
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

// Reconciliation gap (see PRD 0009's final report): the USERS table has no
// `role` column. session-issuer.js reads `user.role ?? ROLES.OWNER`, so
// omitting the field here is safe and every real-DB login is OWNER — the
// ADMIN role (routes/admin-audit.js) is reachable only through a fixture
// that sets `role` directly (e.g. tests/helpers/test-app.js's seedAdmin,
// which the fake in-memory store honours). Adding real admin accounts needs
// a schema column, out of this PRD's scope.
function mapTwoFactorConfig(row) {
  if (!row || row.tfa_method === null || row.tfa_method === undefined) {
    return undefined;
  }
  return {
    method: row.tfa_method,
    enabled: !!row.tfa_enabled,
    encryptedSecret: {
      ciphertext: row.tfa_secret_enc,
      iv: row.tfa_secret_iv,
      tag: row.tfa_secret_tag,
    },
  };
}

function mapUserRow(row) {
  if (!row) {
    return null;
  }
  return {
    userId: String(row.user_id),
    email: row.email,
    masterPasswordHash: row.master_password_hash,
    failedAttempts: row.failed_attempts,
    isLocked: !!row.is_locked,
    twoFactorConfig: mapTwoFactorConfig(row),
  };
}

// One query, LEFT JOINed to the 0..1 TWO_FACTOR_CONFIGS row, so a lookup is
// a single round trip rather than two racing against a concurrent enrolment.
const USER_WITH_TFA_QUERY = `
  SELECT u.user_id, u.email, u.master_password_hash, u.failed_attempts, u.is_locked,
         t.method AS tfa_method, t.enabled AS tfa_enabled,
         t.secret_enc AS tfa_secret_enc, t.secret_iv AS tfa_secret_iv, t.secret_tag AS tfa_secret_tag
    FROM USERS u
    LEFT JOIN TWO_FACTOR_CONFIGS t ON t.user_id = u.user_id
   WHERE u.is_deleted = 0 AND
`;

function createUsersPort({ pool = getPool() } = {}) {
  return {
    async findById(userId) {
      const [rows] = await pool.execute(`${USER_WITH_TFA_QUERY} u.user_id = ?`, [userId]);
      return mapUserRow(rows[0]);
    },

    async findByEmail(email) {
      const [rows] = await pool.execute(`${USER_WITH_TFA_QUERY} u.email = ?`, [email]);
      return mapUserRow(rows[0]);
    },

    // Single atomic UPDATE: the IF()s read `failed_attempts` at its
    // pre-statement value (MySQL evaluates a multi-assignment SET against the
    // row's original values, not values assigned earlier in the same
    // statement), so a concurrent pair of failed logins cannot both read
    // "4" and both fail to trip the lock.
    async recordFailedAttempt(userId) {
      await pool.execute(
        `UPDATE USERS
            SET failed_attempts = failed_attempts + 1,
                is_locked = IF(failed_attempts + 1 >= ?, TRUE, is_locked),
                lockout_until = IF(failed_attempts + 1 >= ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), lockout_until)
          WHERE user_id = ?`,
        [LOCKOUT_THRESHOLD, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES, userId]
      );
    },

    async resetFailedAttempts(userId) {
      await pool.execute(
        'UPDATE USERS SET failed_attempts = 0, is_locked = FALSE, lockout_until = NULL WHERE user_id = ?',
        [userId]
      );
    },

    // PRD 0015 (password reset). Takes `tx` — unlike the methods above — so
    // the hash update can commit inside the same transaction as the reset
    // token being consumed and the MASTER_PASSWORD_CHANGED audit entry: if
    // the entry fails to write, this update must roll back with it.
    async updateMasterPasswordHash(tx, { userId, hash }) {
      const conn = tx ?? pool;
      await conn.execute('UPDATE USERS SET master_password_hash = ? WHERE user_id = ?', [
        hash,
        userId,
      ]);
    },
  };
}

module.exports = { createUsersPort, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES };
