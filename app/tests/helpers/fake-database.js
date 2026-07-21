const crypto = require('crypto');

// One in-memory database behind every port, because that is how the real one
// is shaped: a single MySQL instance whose transactions span the credential
// tables and the audit table. Ports that each owned a private store could
// never roll a credential back when its audit entry failed, and the atomicity
// the routes claim would go untested.
//
// transaction() really does roll back — it snapshots and restores — so a test
// that makes the audit append fail can assert the credential is still absent.

function snapshot(state) {
  return {
    credentials: new Map([...state.credentials].map(([k, v]) => [k, { ...v }])),
    entries: [...state.entries],
    sessions: new Map([...state.sessions].map(([k, v]) => [k, { ...v }])),
    revoked: new Set(state.revoked),
    users: new Map([...state.users].map(([k, v]) => [k, { ...v }])),
    resetTokens: new Map([...state.resetTokens].map(([k, v]) => [k, { ...v }])),
    vaults: new Map([...state.vaults].map(([k, v]) => [k, { ...v }])),
  };
}

/**
 * @param users        seed rows: { userId, email, masterPasswordHash, ... }
 * @param knownSessions session ids to pre-register as live.
 * @param failAppendOn  an ACTIONS value whose audit append should throw, to
 *                      drive the "unlogged action must not stand" tests.
 * @param failVaultCreate  PRD 0018: when true, `vaults.create` throws — the
 *                      fake's way of driving the "a failed vault insert must
 *                      roll back the user insert too" atomicity test.
 */
function createFakeDatabase({
  users = [],
  knownSessions = [],
  failAppendOn = null,
  failVaultCreate = false,
} = {}) {
  const state = {
    credentials: new Map(),
    entries: [],
    sessions: new Map(knownSessions.map((id) => [id, { sessionId: id, userId: 'user-42' }])),
    revoked: new Set(),
    users: new Map(users.map((u) => [u.userId, { failedAttempts: 0, isLocked: false, ...u }])),
    // Keyed by the token hash's hex encoding — same shape as the real
    // store's VARBINARY unique index, just addressed in memory.
    resetTokens: new Map(),
    // PRD 0018: keyed by userId, same 1:1 shape as the real VAULTS table
    // (UQ_VAULTS_USER).
    vaults: new Map(),
  };

  const appendContexts = [];

  async function transaction(fn) {
    const before = snapshot(state);
    const tx = { id: crypto.randomUUID() };
    try {
      return await fn(tx);
    } catch (err) {
      Object.assign(state, before);
      throw err;
    }
  }

  // The audit log's only writer. Signature matches createAuditLog's `append`.
  const append = jest.fn(async (entry, context) => {
    appendContexts.push(context);
    if (failAppendOn && entry.action === failAppendOn) {
      throw new Error('audit append failed');
    }
    state.entries.push(entry);
  });

  const credentials = {
    transaction,
    async add(tx, { userId, title, url, username, encryptedPassword }) {
      const itemId = crypto.randomUUID();
      const now = new Date();
      const credential = {
        itemId,
        userId,
        title,
        url: url ?? null,
        username: username ?? null,
        encryptedPassword,
        createdAt: now,
        updatedAt: now,
      };
      state.credentials.set(itemId, credential);
      return { ...credential };
    },
    // Ownership is checked here, in the store, not in the route: business
    // rule 6 holds even if a future route forgets to ask.
    async get({ userId, itemId }) {
      const credential = state.credentials.get(itemId);
      return credential && credential.userId === userId ? { ...credential } : null;
    },
    // PRD 0019. Newest-updated-first, mirroring ports/credentials.js's real
    // `ORDER BY vi.updated_at DESC`; filtered to the caller's own rows only
    // (business rule 6), same as get().
    async list({ userId }) {
      return [...state.credentials.values()]
        .filter((c) => c.userId === userId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map((c) => ({ ...c }));
    },
    async update(tx, { userId, itemId, patch }) {
      const credential = state.credentials.get(itemId);
      if (!credential || credential.userId !== userId) {
        return null;
      }
      const updated = { ...credential, ...patch, updatedAt: new Date() };
      state.credentials.set(itemId, updated);
      return { ...updated };
    },
    async remove(tx, { userId, itemId }) {
      const credential = state.credentials.get(itemId);
      if (!credential || credential.userId !== userId) {
        return false;
      }
      state.credentials.delete(itemId);
      return true;
    },
  };

  const sessions = {
    transaction,
    async start(tx, { userId }) {
      const sessionId = crypto.randomUUID();
      state.sessions.set(sessionId, { sessionId, userId });
      return { sessionId };
    },
    async revoke(tx, sessionId) {
      state.revoked.add(sessionId);
    },
    // PRD 0015: every session belonging to userId, revoked at once — the
    // real port's DELETE FROM SESSIONS WHERE user_id = ?, mirrored here as
    // "mark every matching session id revoked" rather than removing them
    // from the map, so isRevoked() below still has a row to answer "true"
    // about (matches revoke()'s own approach for a single session).
    async revokeAllForUser(tx, { userId }) {
      for (const [sessionId, session] of state.sessions) {
        if (session.userId === userId) {
          state.revoked.add(sessionId);
        }
      }
    },
    // Fail closed. A session the store has never heard of is treated as
    // revoked, not as fine: a token naming a session whose row was rolled
    // back would otherwise be honoured until its own expiry, and revocation
    // would have a hole exactly the size of a failed login transaction.
    async isRevoked(sessionId) {
      return !state.sessions.has(sessionId) || state.revoked.has(sessionId);
    },
  };

  const users_ = {
    // PRD 0018: routes/register.js runs the user insert, the paired vault
    // insert, and the ACCOUNT_CREATED audit entry all through
    // `users.transaction`, the same shared snapshot/restore `transaction`
    // every other fake port below reuses.
    transaction,
    async findById(userId) {
      return state.users.get(userId) ?? null;
    },
    async findByEmail(email) {
      return [...state.users.values()].find((u) => u.email === email) ?? null;
    },
    async recordFailedAttempt(userId) {
      const user = state.users.get(userId);
      user.failedAttempts += 1;
      if (user.failedAttempts >= 5) {
        user.isLocked = true;
      }
    },
    async resetFailedAttempts(userId) {
      state.users.get(userId).failedAttempts = 0;
    },
    // PRD 0015. `hash` replaces whatever the fixture seeded, so a login
    // attempted afterward with the old master password fails and one with
    // the new password succeeds — exactly what the route's contract claims.
    async updateMasterPasswordHash(tx, { userId, hash }) {
      const user = state.users.get(userId);
      if (user) {
        user.masterPasswordHash = hash;
      }
    },
    // PRD 0017 (2FA self-enrollment). Mirrors ports/users.js's upsert: writes
    // (or replaces) a pending — `enabled: false` — config, same shape
    // findByEmail/findById already attach to a seeded user.
    async upsertPendingTwoFactorConfig(userId, encryptedSecret) {
      const user = state.users.get(userId);
      if (user) {
        user.twoFactorConfig = { method: 'TOTP', enabled: false, encryptedSecret };
      }
    },
    // The only place `enabled` flips to true, matching ports/users.js. Takes
    // `tx` (unused here — this fake shares one in-memory state guarded by
    // transaction()'s own snapshot/restore) so callers exercise the same
    // (tx, userId) shape the real pooled port requires.
    async enableTwoFactorConfig(tx, userId) {
      const user = state.users.get(userId);
      if (user && user.twoFactorConfig) {
        user.twoFactorConfig = { ...user.twoFactorConfig, enabled: true };
      }
    },
    // PRD 0018 (self-service registration). Mirrors ports/users.js's INSERT:
    // a bare row with no twoFactorConfig, matching a genuinely fresh account
    // (no TWO_FACTOR_CONFIGS row exists for it yet).
    async createUser(tx, { email, passwordHash }) {
      const userId = crypto.randomUUID();
      state.users.set(userId, {
        userId,
        email,
        masterPasswordHash: passwordHash,
        failedAttempts: 0,
        isLocked: false,
      });
      return userId;
    },
  };

  const vaults = {
    transaction,
    // PRD 0018. `failVaultCreate` is this fake's hook for the atomicity
    // test: routes/register.js calls this inside the same
    // `users.transaction` as `createUser` above, and `transaction()`'s own
    // snapshot/restore is what makes a throw here roll the user insert back
    // too — the same mechanism every other atomicity test in this file
    // relies on.
    async create(tx, { userId }) {
      if (failVaultCreate) {
        throw new Error('vault insert failed');
      }
      // TRUE: a fresh vault starts locked — matches ports/vaults.js's real
      // insert and the schema's own default (see that file's comment).
      state.vaults.set(userId, { userId, autoLockMinutes: 10, isLocked: true });
    },
  };

  const resetTokenKey = (tokenHash) =>
    Buffer.isBuffer(tokenHash) ? tokenHash.toString('hex') : String(tokenHash);

  const resetTokens = {
    transaction,
    async create(tx, { userId, tokenHash, expiresAt }) {
      state.resetTokens.set(resetTokenKey(tokenHash), {
        userId,
        expiresAt,
        usedAt: null,
      });
    },
    // Mirrors the real store's single-use guarantee: a row is only ever
    // consumed once, and a missing/expired/already-used row all answer null.
    async consume(tx, { tokenHash }) {
      const row = state.resetTokens.get(resetTokenKey(tokenHash));
      if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
        return null;
      }
      row.usedAt = new Date();
      return { userId: row.userId };
    },
  };

  // Newest first, with entryId breaking ties so the ordering is total. Two
  // entries can share a millisecond; without the tiebreak, "everything older
  // than this timestamp" would either skip one or repeat it.
  const newestFirst = (a, b) =>
    b.timestamp.getTime() - a.timestamp.getTime() || (a.entryId < b.entryId ? 1 : -1);

  // `WHERE (timestamp, entryId) < (?, ?)` — strictly older than the cursor
  // position. Compared rather than looked up, so a cursor naming a row that no
  // longer exists still lands in the right place.
  const strictlyOlder = (after) => (entry) => {
    if (!after) {
      return true;
    }
    const millis = entry.timestamp.getTime();
    return (
      millis < after.timestampMillis ||
      (millis === after.timestampMillis && entry.entryId < after.entryId)
    );
  };

  const auditReader = {
    transaction,
    async list({ userId, limit, after = null }) {
      return state.entries
        .filter((e) => e.userId === userId)
        .filter(strictlyOlder(after))
        .sort(newestFirst)
        .slice(0, limit)
        .map((e) => e.toJSON());
    },
    async get({ userId, entryId }) {
      const entry = state.entries.find((e) => e.entryId === entryId && e.userId === userId);
      return entry ? entry.toJSON() : null;
    },
  };

  return {
    state,
    append,
    appendContexts,
    credentials,
    sessions,
    users: users_,
    vaults,
    auditReader,
    resetTokens,
    // Convenience for assertions.
    actions: () => state.entries.map((e) => e.action),
    entriesFor: (userId) => state.entries.filter((e) => e.userId === userId),
  };
}

module.exports = { createFakeDatabase };
