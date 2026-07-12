const { getPool } = require('../../../src/db/pool');
const { createUsersPort } = require('../../../src/ports/users');
const { createSessionsPort } = require('../../../src/ports/sessions');
const { createCredentialsPort } = require('../../../src/ports/credentials');
const { createAuditReaderPort, createAuditAppend } = require('../../../src/ports/audit-reader');

// The real half of the port contract. Only ever constructed when DB_HOST is
// set (see mysql.contract.test.js) — requiring this file is safe with no DB
// env (db/pool.js is lazy), but calling buildMysqlFixture() is not, and
// nothing in this repo does so outside that guard.
//
// Targets the RECONCILED schema (docs/action_plan/
// 0014-database-schema-implementation.md): USERS.is_deleted, no
// SESSIONS.token_hash, AUDIT_ENTRIES.target_user_id/actor_user_id +
// RESTRICT FKs. It does not create or migrate that schema — it assumes 0014
// has already been applied to whatever DB_* points at, exactly like the
// application itself does.
async function buildMysqlFixture() {
  const pool = getPool();
  const users = createUsersPort({ pool });
  const sessions = createSessionsPort({ pool });
  const credentials = createCredentialsPort({ pool });
  const auditReader = createAuditReaderPort({ pool });
  const append = createAuditAppend({ pool });

  const createdUserIds = [];

  async function seedUser(overrides = {}) {
    const email =
      overrides.email ??
      `contract-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

    const [result] = await pool.execute(
      'INSERT INTO USERS (email, master_password_hash, failed_attempts, is_locked) VALUES (?, ?, ?, ?)',
      [
        email,
        overrides.masterPasswordHash ?? 'x'.repeat(60),
        overrides.failedAttempts ?? 0,
        overrides.isLocked ?? false,
      ]
    );
    const userId = String(result.insertId);
    createdUserIds.push(userId);

    // Credentials.add() resolves the caller's vault_id from VAULTS; every
    // real user has exactly one (1:1, DATABASE.md UQ_VAULTS_USER).
    await pool.execute('INSERT INTO VAULTS (user_id) VALUES (?)', [userId]);

    return { userId, email };
  }

  async function cleanup() {
    if (createdUserIds.length === 0) {
      return;
    }
    // AUDIT_ENTRIES first: its FKs are ON DELETE RESTRICT (0014), so a
    // seeded user cannot be deleted while a row still references it, as
    // either the acting user or an admin-read association.
    await pool.query(
      'DELETE FROM AUDIT_ENTRIES WHERE user_id IN (?) OR target_user_id IN (?) OR actor_user_id IN (?)',
      [createdUserIds, createdUserIds, createdUserIds]
    );
    // VAULTS/VAULT_ITEMS/CREDENTIALS/SESSIONS all cascade off USERS.
    await pool.query('DELETE FROM USERS WHERE user_id IN (?)', [createdUserIds]);
    createdUserIds.length = 0;
  }

  return { users, sessions, credentials, auditReader, append, seedUser, cleanup };
}

module.exports = { buildMysqlFixture };
