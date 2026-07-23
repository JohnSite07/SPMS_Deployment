const crypto = require('crypto');
const { ACTIONS, createAuditEntry } = require('../../src/models/audit-entry');
const { createAuditLog } = require('../../src/services/audit-log');

function tokenHash(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

// The reference contract, run twice: once against the in-memory fake
// (tests/helpers/fake-database.js) and once — only when a real database is
// reachable — against the MySQL adapters under src/ports/. Both halves call
// this same function with a different `buildFixture`, so a real adapter that
// silently drifted from the fake's behaviour fails a test that already
// passes against the fake, instead of only being caught by hand.
//
// `buildFixture()` returns, per test:
//   { users, sessions, credentials, auditReader, append, seedUser, cleanup }
// `seedUser(overrides?)` returns `{ userId, email }` for a freshly created
// row (and, for the real fixture, a VAULTS row to hang credentials off of).
function runPortContractSuite(label, buildFixture) {
  describe(`port contract: ${label}`, () => {
    let fixture;

    beforeEach(async () => {
      fixture = await buildFixture();
    });

    afterEach(async () => {
      if (fixture && fixture.cleanup) {
        await fixture.cleanup();
      }
    });

    describe('users', () => {
      it('finds a seeded user by email and by id', async () => {
        const { userId, email } = await fixture.seedUser();

        const byEmail = await fixture.users.findByEmail(email);
        const byId = await fixture.users.findById(userId);

        expect(byEmail).toMatchObject({ userId, email, isLocked: false, failedAttempts: 0 });
        expect(byId).toMatchObject({ userId, email, isLocked: false, failedAttempts: 0 });
      });

      it('returns null for an unknown email or id, not undefined or a throw', async () => {
        expect(await fixture.users.findByEmail('nobody@example.com')).toBeNull();
        expect(await fixture.users.findById('does-not-exist')).toBeNull();
      });

      it('locks the account on exactly the fifth failed attempt', async () => {
        const { userId } = await fixture.seedUser();

        for (let i = 0; i < 4; i += 1) {
           
          await fixture.users.recordFailedAttempt(userId);
        }
        expect((await fixture.users.findById(userId)).isLocked).toBe(false);
        expect((await fixture.users.findById(userId)).failedAttempts).toBe(4);

        await fixture.users.recordFailedAttempt(userId);
        expect((await fixture.users.findById(userId)).isLocked).toBe(true);
        expect((await fixture.users.findById(userId)).failedAttempts).toBe(5);
      });

      it('clears the failure count and lock on reset', async () => {
        const { userId } = await fixture.seedUser();
        for (let i = 0; i < 5; i += 1) {
           
          await fixture.users.recordFailedAttempt(userId);
        }

        await fixture.users.resetFailedAttempts(userId);

        const user = await fixture.users.findById(userId);
        expect(user.failedAttempts).toBe(0);
      });
    });

    describe('sessions', () => {
      it('fails closed: a session id the store has never seen is revoked', async () => {
        expect(await fixture.sessions.isRevoked('never-seen-session-id')).toBe(true);
      });

      it('a started session is live until explicitly revoked', async () => {
        const { userId } = await fixture.seedUser();

        const { sessionId } = await fixture.sessions.transaction((tx) =>
          fixture.sessions.start(tx, { userId })
        );
        expect(await fixture.sessions.isRevoked(sessionId)).toBe(false);

        await fixture.sessions.transaction((tx) => fixture.sessions.revoke(tx, sessionId));
        expect(await fixture.sessions.isRevoked(sessionId)).toBe(true);
      });

      it('rolls a started session back if its transaction throws — fail-closed holds', async () => {
        const { userId } = await fixture.seedUser();
        let sessionId;

        await expect(
          fixture.sessions.transaction(async (tx) => {
            ({ sessionId } = await fixture.sessions.start(tx, { userId }));
            throw new Error('boom');
          })
        ).rejects.toThrow('boom');

        expect(await fixture.sessions.isRevoked(sessionId)).toBe(true);
      });
    });

    describe('credentials', () => {
      async function addCredential(owner, fields = {}) {
        return fixture.credentials.transaction((tx) =>
          fixture.credentials.add(tx, {
            userId: owner.userId,
            title: 'Bank',
            url: 'https://bank.example.com',
            username: 'owner',
            encryptedPassword: 'AES256:opaque-client-ciphertext',
            ...fields,
          })
        );
      }

      it('adds a credential the owner can read back', async () => {
        const owner = await fixture.seedUser();
        const created = await addCredential(owner);

        expect(created).toMatchObject({
          title: 'Bank',
          url: 'https://bank.example.com',
          username: 'owner',
          encryptedPassword: 'AES256:opaque-client-ciphertext',
        });

        const read = await fixture.credentials.get({ userId: owner.userId, itemId: created.itemId });
        expect(read).toMatchObject({ itemId: created.itemId, title: 'Bank' });
      });

      // Business rule 6, enforced in the store: a stranger's userId matches
      // nothing, however correct the itemId.
      it('never returns, updates, or removes another user\'s credential', async () => {
        const owner = await fixture.seedUser();
        const stranger = await fixture.seedUser();
        const created = await addCredential(owner);

        expect(await fixture.credentials.get({ userId: stranger.userId, itemId: created.itemId })).toBeNull();

        const strangerUpdate = await fixture.credentials.transaction((tx) =>
          fixture.credentials.update(tx, {
            userId: stranger.userId,
            itemId: created.itemId,
            patch: { title: 'Stolen' },
          })
        );
        expect(strangerUpdate).toBeNull();

        const strangerRemove = await fixture.credentials.transaction((tx) =>
          fixture.credentials.remove(tx, { userId: stranger.userId, itemId: created.itemId })
        );
        expect(strangerRemove).toBe(false);

        // Untouched by either attempt.
        const stillThere = await fixture.credentials.get({ userId: owner.userId, itemId: created.itemId });
        expect(stillThere).toMatchObject({ title: 'Bank' });
      });

      it("updates the owner's own credential", async () => {
        const owner = await fixture.seedUser();
        const created = await addCredential(owner);

        const updated = await fixture.credentials.transaction((tx) =>
          fixture.credentials.update(tx, {
            userId: owner.userId,
            itemId: created.itemId,
            patch: { title: 'Renamed', encryptedPassword: 'AES256:rotated' },
          })
        );

        expect(updated).toMatchObject({ title: 'Renamed', encryptedPassword: 'AES256:rotated' });
      });

      it("removes the owner's own credential", async () => {
        const owner = await fixture.seedUser();
        const created = await addCredential(owner);

        const removed = await fixture.credentials.transaction((tx) =>
          fixture.credentials.remove(tx, { userId: owner.userId, itemId: created.itemId })
        );
        expect(removed).toBe(true);
        expect(await fixture.credentials.get({ userId: owner.userId, itemId: created.itemId })).toBeNull();
      });

      it('rolls a new credential back if its transaction throws', async () => {
        const owner = await fixture.seedUser();
        let itemId;

        await expect(
          fixture.credentials.transaction(async (tx) => {
            const created = await fixture.credentials.add(tx, {
              userId: owner.userId,
              title: 'Bank',
              encryptedPassword: 'AES256:x',
            });
            itemId = created.itemId;
            throw new Error('audit append failed');
          })
        ).rejects.toThrow('audit append failed');

        expect(await fixture.credentials.get({ userId: owner.userId, itemId })).toBeNull();
      });
    });

    describe('password-reset tokens (PRD 0015)', () => {
      it('consumes a valid token exactly once — a second consume returns null', async () => {
        const { userId } = await fixture.seedUser();
        const hash = tokenHash('raw-token-single-use');
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

        await fixture.resetTokens.transaction((tx) =>
          fixture.resetTokens.create(tx, { userId, tokenHash: hash, expiresAt })
        );

        const first = await fixture.resetTokens.transaction((tx) =>
          fixture.resetTokens.consume(tx, { tokenHash: hash })
        );
        expect(first).toEqual({ userId });

        const second = await fixture.resetTokens.transaction((tx) =>
          fixture.resetTokens.consume(tx, { tokenHash: hash })
        );
        expect(second).toBeNull();
      });

      it('returns null for an expired token, never consuming it', async () => {
        const { userId } = await fixture.seedUser();
        const hash = tokenHash('raw-token-expired');
        const expiresAt = new Date(Date.now() - 1000);

        await fixture.resetTokens.transaction((tx) =>
          fixture.resetTokens.create(tx, { userId, tokenHash: hash, expiresAt })
        );

        const outcome = await fixture.resetTokens.transaction((tx) =>
          fixture.resetTokens.consume(tx, { tokenHash: hash })
        );
        expect(outcome).toBeNull();
      });

      it('returns null for a token that was never issued', async () => {
        const outcome = await fixture.resetTokens.transaction((tx) =>
          fixture.resetTokens.consume(tx, { tokenHash: tokenHash('never-issued') })
        );
        expect(outcome).toBeNull();
      });
    });

    describe('audit reader + append', () => {
      it('lists a user\'s entries newest-first and pages with a keyset cursor', async () => {
        const { userId } = await fixture.seedUser();
        const base = Date.now();

        for (let i = 0; i < 3; i += 1) {
          const entry = createAuditEntry({
            userId,
            action: ACTIONS.LOGIN_SUCCEEDED,
            ipAddress: null,
            clock: () => base + i,
          });
           
          await fixture.append(entry, undefined);
        }

        const firstPage = await fixture.auditReader.list({ userId, limit: 2, after: null });
        expect(firstPage).toHaveLength(2);
        expect(Date.parse(firstPage[0].timestamp)).toBeGreaterThanOrEqual(
          Date.parse(firstPage[1].timestamp)
        );

        const cursor = firstPage[firstPage.length - 1];
        const secondPage = await fixture.auditReader.list({
          userId,
          limit: 10,
          after: { timestampMillis: Date.parse(cursor.timestamp), entryId: cursor.entryId },
        });
        expect(secondPage).toHaveLength(1);

        const allIds = new Set([...firstPage, ...secondPage].map((e) => e.entryId));
        expect(allIds.size).toBe(3);
      });

      it('never lists another user\'s entries', async () => {
        const owner = await fixture.seedUser();
        const stranger = await fixture.seedUser();

        await fixture.append(
          createAuditEntry({ userId: owner.userId, action: ACTIONS.LOGIN_SUCCEEDED, ipAddress: null }),
          undefined
        );

        expect(await fixture.auditReader.list({ userId: stranger.userId, limit: 10, after: null })).toEqual(
          []
        );
      });

      it('reads a single entry scoped to its owner, null for a stranger', async () => {
        const owner = await fixture.seedUser();
        const stranger = await fixture.seedUser();
        const entry = createAuditEntry({
          userId: owner.userId,
          action: ACTIONS.LOGIN_SUCCEEDED,
          ipAddress: null,
        });
        await fixture.append(entry, undefined);

        const found = await fixture.auditReader.get({ userId: owner.userId, entryId: entry.entryId });
        expect(found).toMatchObject({ action: ACTIONS.LOGIN_SUCCEEDED, userId: owner.userId });

        expect(
          await fixture.auditReader.get({ userId: stranger.userId, entryId: entry.entryId })
        ).toBeNull();
      });

      // The atomicity the whole design leans on: an action whose audit entry
      // cannot be written must not stand.
      it('rolls a credential back when its audit entry fails to append, in the same transaction', async () => {
        const { userId } = await fixture.seedUser();
        const audit = createAuditLog({
          append: async (entry, context) => {
            if (entry.action === ACTIONS.CREDENTIAL_ADDED) {
              throw new Error('audit append failed');
            }
            return fixture.append(entry, context);
          },
        });

        await expect(
          fixture.credentials.transaction(async (tx) => {
            const created = await fixture.credentials.add(tx, {
              userId,
              title: 'Bank',
              encryptedPassword: 'AES256:x',
            });
            await audit.logAction({
              userId,
              action: ACTIONS.CREDENTIAL_ADDED,
              ipAddress: null,
              context: tx,
            });
            return created;
          })
        ).rejects.toThrow('audit append failed');

        const entries = await fixture.auditReader.list({ userId, limit: 10, after: null });
        expect(entries.filter((e) => e.action === ACTIONS.CREDENTIAL_ADDED)).toEqual([]);
      });
    });
  });
}

module.exports = { runPortContractSuite };
