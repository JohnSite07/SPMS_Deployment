const request = require('supertest');
const { ACTIONS } = require('../src/models/audit-entry');
const { createFakeDatabase } = require('./helpers/fake-database');
const { testApp, seedUser } = require('./helpers/test-app');

// PRD 0018 — the missing self-service front door. Before this route, every
// USERS row existed because a developer hand-wrote it (plus its
// TWO_FACTOR_CONFIGS row) into Cloud SQL Studio.

const STRONG_PASSWORD = 'Sup3r$ecret!'; // 12 chars, all four classes.
const WEAK_PASSWORD = 'short';

function build(dbOptions = {}) {
  const db = createFakeDatabase({ users: [], ...dbOptions });
  return { ...testApp({ db }), db };
}

const register = (app, overrides = {}) =>
  request(app)
    .post('/api/register')
    .send({ email: 'new-user@example.com', password: STRONG_PASSWORD, ...overrides });

describe('POST /api/register', () => {
  it('is reachable without a bearer token', async () => {
    const { app } = build();
    const res = await register(app);
    expect(res.status).not.toBe(401);
  });

  it('creates exactly one USERS row and one composed VAULTS row, and logs ACCOUNT_CREATED', async () => {
    const { app, db } = build();

    const res = await register(app);

    expect(res.status).toBe(201);
    expect(res.body.userId).toEqual(expect.any(String));
    expect(res.body.userId.length).toBeGreaterThan(0);
    // No session token: a fresh account has no 2FA configured yet.
    expect(res.body.token).toBeUndefined();

    expect(db.state.users.size).toBe(1);
    const created = db.state.users.get(res.body.userId);
    expect(created.email).toBe('new-user@example.com');
    // The stored value is whatever the injected hashPassword returned, never
    // the plaintext password read back unchanged. (The fake hasher's output
    // shape deliberately embeds the input so tests can assert on it; the
    // real bcrypt hasher is exercised separately in password-hasher.test.js.)
    expect(created.masterPasswordHash).toBe(`hash:${STRONG_PASSWORD}`);

    expect(db.state.vaults.size).toBe(1);
    const vault = db.state.vaults.get(res.body.userId);
    expect(vault.autoLockMinutes).toBe(10);
    // A vault nobody has ever logged into starts locked (schema default;
    // UC-01 treats "unlocked" as a login post-condition, not a starting
    // state) — matches ports/vaults.js's real insert.
    expect(vault.isLocked).toBe(true);

    expect(db.actions()).toEqual([ACTIONS.ACCOUNT_CREATED]);
    expect(db.entriesFor(res.body.userId)[0].userId).toBe(res.body.userId);
  });

  it('writes the audit entry inside the same transaction as the user/vault rows', async () => {
    const { app, db } = build();
    await register(app);
    expect(db.appendContexts.every((c) => c && typeof c.id === 'string')).toBe(true);
  });

  it('answers 409 for an already-registered email and creates nothing', async () => {
    const { app, db } = build({ users: [seedUser()] }); // owner@example.com

    const before = new Map(db.state.users);
    const res = await register(app, { email: 'owner@example.com' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'email_already_registered' });
    // The existing user is untouched, and no second row was added.
    expect(db.state.users.size).toBe(before.size);
    expect(db.state.users.get('user-42')).toEqual(before.get('user-42'));
    expect(db.state.vaults.size).toBe(0);
    expect(db.actions()).toEqual([]);
  });

  it('rejects a password failing business rule 2 and creates nothing', async () => {
    const { app, db } = build();

    const res = await register(app, { password: WEAK_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'weak_password' });
    expect(db.state.users.size).toBe(0);
    expect(db.state.vaults.size).toBe(0);
    expect(db.actions()).toEqual([]);
  });

  it('rejects a missing/blank email without touching storage', async () => {
    const { app, db } = build();

    const res = await register(app, { email: '' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    expect(db.state.users.size).toBe(0);
  });

  describe('atomicity: a failed vault insert rolls back the user insert too', () => {
    let errorSpy;
    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => errorSpy.mockRestore());

    it('leaves no orphan USERS row when VAULTS insert fails', async () => {
      const { app, db } = build({ failVaultCreate: true });

      const res = await register(app);

      expect(res.status).toBe(500);
      expect(db.state.users.size).toBe(0);
      expect(db.state.vaults.size).toBe(0);
      expect(db.actions()).toEqual([]);
    });
  });

  it('a fresh registration cannot log in until 2FA is set up (same generic 401 as any no-2FA account)', async () => {
    const { app, db } = build();

    const registered = await register(app);
    expect(registered.status).toBe(201);

    const login = await request(app)
      .post('/api/session')
      .send({ email: 'new-user@example.com', password: STRONG_PASSWORD });

    expect(login.status).toBe(401);
    expect(login.body).toEqual({ error: 'invalid_credentials' });
    // No session/token exists for this account.
    expect(db.state.sessions.size).toBe(0);
  });

  it('never logs the plaintext password to the console', async () => {
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      jest.spyOn(console, method).mockImplementation(() => {})
    );

    try {
      const { app } = build();
      await register(app);
      await register(app, { email: 'weak@example.com', password: WEAK_PASSWORD });

      for (const spy of consoleSpies) {
        for (const call of spy.mock.calls) {
          expect(call.join(' ')).not.toContain(STRONG_PASSWORD);
          expect(call.join(' ')).not.toContain(WEAK_PASSWORD);
        }
      }
    } finally {
      consoleSpies.forEach((spy) => spy.mockRestore());
    }
  });
});
