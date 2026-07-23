const { getPool, transaction: sharedTransaction } = require('../db/pool');

// The `vaults` port routes/register.js writes through. New in PRD 0018:
// before this, VAULTS rows only ever existed because a developer hand-wrote
// one alongside a hand-written USERS row (DATABASE.md's seed block still
// does this unaffected — see that PRD's Out of scope). This is the first
// port to insert a VAULTS row on an application code path.
//
// DATABASE.md #2: VAULTS is 1:1 with USERS (UQ_VAULTS_USER), and
// domain-model.md composes exactly one Vault into a User — so a USERS row
// with no matching VAULTS row is an invalid, half-built object per that
// model, never a valid intermediate state. This port therefore exposes only
// `create(tx, ...)`, never a variant that can run outside a transaction: the
// one caller (routes/register.js) always runs it on the same connection as
// users.createUser and the ACCOUNT_CREATED audit entry, so all three commit
// or roll back together.
//
// ports/credentials.js already SELECTs a caller's `vault_id` (see its own
// comment on a missing vault meaning the registration invariant was
// violated upstream) — this file is the other half: the write that is
// supposed to make that SELECT always find a row.

/**
 * @param pool         mysql2 pool; defaults to the shared one.
 * @param transaction  defaults to db/pool.js's transaction(fn) — the same
 *                      helper every other port uses. Exposed here too so a
 *                      caller that only holds the vaults port (e.g. a future
 *                      admin/maintenance path) can still run one, though
 *                      routes/register.js reuses users.transaction rather
 *                      than opening a second one for the same request.
 */
function createVaultsPort({ pool = getPool(), transaction = sharedTransaction } = {}) {
  return {
    transaction,

    // Business rule 5 (10-minute auto-lock): a fresh account's vault is
    // provisioned with `auto_lock_minutes = 10` from the start, not left to
    // a default the row might not otherwise get. `is_locked = TRUE` matches
    // both the schema's own declared default (DATABASE.md's
    // `is_locked BOOLEAN NOT NULL DEFAULT TRUE`) and this codebase's
    // fail-closed posture everywhere else (session-issuer's default-deny,
    // PUBLIC_PATHS default-deny): UC-01 treats "vault unlocked" as a
    // post-condition of a successful login (verify -> validate 2FA ->
    // decrypt and show vault), never a starting state, so a vault nobody has
    // ever logged into has no business starting unlocked. (An earlier draft
    // of this file set FALSE here, reasoning from DATABASE.md's illustrative
    // alice/bob seed rows, which happen to show `is_locked=FALSE` alongside
    // `USERS.is_locked=FALSE` — but those are two unrelated columns
    // (account-lockout vs vault-lock) whose seed values simply covary; that
    // is not a documented rule they must match. Corrected per infra-reviewer
    // sign-off on PRD 0018.)
    async create(tx, { userId }) {
      const conn = tx ?? pool;
      await conn.execute(
        'INSERT INTO VAULTS (user_id, auto_lock_minutes, is_locked) VALUES (?, 10, TRUE)',
        [userId]
      );
    },
  };
}

module.exports = { createVaultsPort };
