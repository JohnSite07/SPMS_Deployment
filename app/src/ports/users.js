const { getPool, transaction: sharedTransaction } = require('../db/pool');

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

function createUsersPort({ pool = getPool(), transaction = sharedTransaction } = {}) {
  return {
    // Exposed the same way ports/credentials.js, ports/password-reset-store.js
    // and ports/sessions.js expose theirs: routes/register.js runs the USERS
    // insert, the paired VAULTS insert (ports/vaults.js), and the
    // ACCOUNT_CREATED audit entry on this one connection, so all three commit
    // together or not at all.
    transaction,

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

    // PRD 0017 (2FA self-enrollment). Writes a *pending* (enabled=FALSE) TOTP
    // config — findByEmail/findById's LEFT JOIN above returns this row
    // regardless of `enabled`, so routes/two-factor.js can read it straight
    // back to confirm it. UQ_TFA_USER makes this a clean upsert: a user
    // re-running /enroll (e.g. after a botched confirm) replaces the pending
    // secret rather than accumulating rows.
    async upsertPendingTwoFactorConfig(userId, { ciphertext, iv, tag }) {
      await pool.execute(
        `INSERT INTO TWO_FACTOR_CONFIGS (user_id, method, secret_enc, secret_iv, secret_tag, enabled)
              VALUES (?, 'TOTP', ?, ?, ?, FALSE)
         ON DUPLICATE KEY UPDATE
              method = 'TOTP',
              secret_enc = VALUES(secret_enc),
              secret_iv = VALUES(secret_iv),
              secret_tag = VALUES(secret_tag),
              enabled = FALSE`,
        [userId, ciphertext, iv, tag]
      );
    },

    // PRD 0017. The only place `enabled` ever flips to TRUE — routes/
    // two-factor.js calls this only after a live TOTP code has verified
    // against the pending secret. Takes `tx`, same pattern as
    // updateMasterPasswordHash above: routes/two-factor.js commits this in
    // the same transaction as the TWO_FACTOR_ENABLED audit entry and the
    // session it starts, so a failure anywhere in that chain rolls all of it
    // back rather than leaving `enabled=TRUE` with no entry describing it.
    async enableTwoFactorConfig(tx, userId) {
      const conn = tx ?? pool;
      await conn.execute('UPDATE TWO_FACTOR_CONFIGS SET enabled = TRUE WHERE user_id = ?', [
        userId,
      ]);
    },

    // PRD 0018 (self-service registration). The exact query DATABASE.md's
    // catalogue anticipates. Takes `tx`, same pattern as
    // updateMasterPasswordHash/enableTwoFactorConfig above: routes/
    // register.js commits this in the same transaction as the paired
    // ports/vaults.js insert and the ACCOUNT_CREATED audit entry, so a
    // failure anywhere in that chain rolls the USERS row back too — this
    // codebase never allows a User without its composed Vault to exist, even
    // transiently.
    async createUser(tx, { email, passwordHash }) {
      const conn = tx ?? pool;
      const [result] = await conn.execute(
        'INSERT INTO USERS (email, master_password_hash) VALUES (?, ?)',
        [email, passwordHash]
      );
      return String(result.insertId);
    },
  };
}

module.exports = { createUsersPort, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES };
