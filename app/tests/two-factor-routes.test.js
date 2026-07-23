const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { ACTIONS } = require('../src/models/audit-entry');
const { createFakeDatabase } = require('./helpers/fake-database');
const { testApp, seedUser, PASSWORD, TWO_FACTOR_CODE } = require('./helpers/test-app');

// PRD 0017 — the missing self-service path onto UC-01's "2FA set up"
// precondition. These routes are as much of a password-guessing surface as
// POST /api/session, so most of this file mirrors session-routes.test.js's
// shape: generic failures, lockout accounting, and no account enumeration.

// routes/two-factor.js encrypts the freshly generated secret via
// services/crypto.js's default loadKey(), which reads AES_ENCRYPTION_KEY
// from the environment — set one for this process, same pattern as
// two-factor-verifier.test.js, so this suite never depends on a real secret.
const TEST_AES_KEY = crypto.randomBytes(32);
const originalAesKey = process.env.AES_ENCRYPTION_KEY;

beforeAll(() => {
  process.env.AES_ENCRYPTION_KEY = TEST_AES_KEY.toString('base64');
});
afterAll(() => {
  process.env.AES_ENCRYPTION_KEY = originalAesKey;
});

function buildWithNoTwoFactor(dbOptions = {}) {
  const db = createFakeDatabase({
    users: [seedUser({ twoFactorConfig: undefined })],
    ...dbOptions,
  });
  return { ...testApp({ db }), db };
}

function build(dbOptions = {}) {
  const db = createFakeDatabase({ users: [seedUser()], ...dbOptions });
  return { ...testApp({ db }), db };
}

const enroll = (app, overrides = {}) =>
  request(app)
    .post('/api/2fa/enroll')
    .send({ email: 'owner@example.com', password: PASSWORD, ...overrides });

const confirm = (app, overrides = {}) =>
  request(app)
    .post('/api/2fa/confirm')
    .send({ email: 'owner@example.com', password: PASSWORD, code: TWO_FACTOR_CODE, ...overrides });

describe('POST /api/2fa/enroll', () => {
  it('is reachable without a bearer token', async () => {
    const { app } = buildWithNoTwoFactor();
    const res = await enroll(app);
    expect(res.status).not.toBe(401);
  });

  it('generates a secret, encrypts it, and stores a pending (enabled=false) row', async () => {
    const { app, db } = buildWithNoTwoFactor();

    const res = await enroll(app);

    expect(res.status).toBe(200);
    expect(res.body.secret).toEqual(expect.any(String));
    expect(res.body.secret.length).toBeGreaterThan(0);
    expect(res.body.otpauthUri).toEqual(expect.any(String));
    expect(res.body.otpauthUri).toContain('otpauth://');

    const stored = db.state.users.get('user-42').twoFactorConfig;
    expect(stored.method).toBe('TOTP');
    expect(stored.enabled).toBe(false);
    expect(stored.encryptedSecret).toBeTruthy();
    // The stored form is AES-256-GCM ciphertext, never the plaintext secret.
    expect(Buffer.isBuffer(stored.encryptedSecret.ciphertext)).toBe(true);
    expect(stored.encryptedSecret.ciphertext.equals(Buffer.from(res.body.secret, 'utf8'))).toBe(
      false
    );
  });

  it('answers 409 and does not overwrite an already-enabled config', async () => {
    const { app, db } = build(); // seedUser()'s default twoFactorConfig is enabled: true

    const before = db.state.users.get('user-42').twoFactorConfig;
    const res = await enroll(app);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'two_factor_already_enabled' });
    expect(db.state.users.get('user-42').twoFactorConfig).toEqual(before);
  });

  it('answers the same generic 401 for a wrong password as an unknown email', async () => {
    const { app } = buildWithNoTwoFactor();

    const wrongPassword = await enroll(app, { password: 'wrong' });
    const unknownEmail = await enroll(app, { email: 'nobody@example.com' });

    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body).toEqual({ error: 'invalid_credentials' });
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body).toEqual({ error: 'invalid_credentials' });
  });

  it('counts a wrong password toward the five-failure lockout', async () => {
    const { app, db } = buildWithNoTwoFactor();

    for (let i = 0; i < 5; i += 1) {
      await enroll(app, { password: 'wrong' });
    }

    expect(db.state.users.get('user-42').isLocked).toBe(true);
  });

  it('writes no row for an unknown email', async () => {
    const { app, db } = buildWithNoTwoFactor();
    await enroll(app, { email: 'nobody@example.com' });
    expect(db.state.users.get('user-42').twoFactorConfig).toBeUndefined();
  });
});

describe('POST /api/2fa/confirm', () => {
  it('is reachable without a bearer token', async () => {
    const { app } = buildWithNoTwoFactor();
    await enroll(app);
    const res = await confirm(app);
    expect(res.status).not.toBe(401);
  });

  it('enables the row, logs TWO_FACTOR_ENABLED, and returns a working session token', async () => {
    const { app, db } = buildWithNoTwoFactor();
    await enroll(app);

    const res = await confirm(app);

    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.sessionId).toEqual(expect.any(String));

    expect(db.state.users.get('user-42').twoFactorConfig.enabled).toBe(true);
    expect(db.actions()).toEqual(
      expect.arrayContaining([ACTIONS.TWO_FACTOR_ENABLED, ACTIONS.LOGIN_SUCCEEDED])
    );

    const sessionRes = await request(app)
      .get('/api/session')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.body.sessionId).toBe(res.body.sessionId);
  });

  it('clears the failure count on a successful confirm', async () => {
    const { app, db } = buildWithNoTwoFactor();
    await enroll(app);
    await confirm(app, { code: 'wrong' });
    await confirm(app);

    expect(db.state.users.get('user-42').failedAttempts).toBe(0);
  });

  it('after confirming, a fresh login with a new code succeeds normally', async () => {
    const { app } = buildWithNoTwoFactor();
    await enroll(app);
    await confirm(app);

    const login = await request(app)
      .post('/api/session')
      .send({ email: 'owner@example.com', password: PASSWORD, code: TWO_FACTOR_CODE });
    expect(login.status).toBe(201);
  });

  // infra-reviewer sign-off finding: confirming an account that is already
  // fully enrolled must behave as a plain login, not fabricate a fresh
  // "2FA was just enabled" entry for something that happened weeks ago —
  // TWO_FACTOR_ENABLED is closed-vocabulary and means exactly that action.
  it('confirming an already-enabled account logs in normally without a duplicate TWO_FACTOR_ENABLED entry', async () => {
    const { app, db } = build(); // seedUser()'s default twoFactorConfig is already enabled: true

    const res = await confirm(app);

    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(db.actions()).toEqual([ACTIONS.LOGIN_SUCCEEDED]);
    expect(db.actions()).not.toContain(ACTIONS.TWO_FACTOR_ENABLED);

    const sessionRes = await request(app)
      .get('/api/session')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(sessionRes.status).toBe(200);
  });

  it('rejects a wrong code, leaves the row pending, and counts a failed attempt', async () => {
    const { app, db } = buildWithNoTwoFactor();
    await enroll(app);

    const res = await confirm(app, { code: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
    expect(db.state.users.get('user-42').twoFactorConfig.enabled).toBe(false);
    expect(db.state.users.get('user-42').failedAttempts).toBe(1);
    expect(db.actions()).not.toContain(ACTIONS.TWO_FACTOR_ENABLED);
  });

  it('allows re-confirming after a botched first attempt', async () => {
    const { app, db } = buildWithNoTwoFactor();
    await enroll(app);
    await confirm(app, { code: 'wrong' });

    const res = await confirm(app);

    expect(res.status).toBe(201);
    expect(db.state.users.get('user-42').twoFactorConfig.enabled).toBe(true);
  });

  it('answers the same generic 401 with no prior enroll — nothing to confirm', async () => {
    const { app, db } = buildWithNoTwoFactor();

    const res = await confirm(app);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
    expect(db.state.users.get('user-42').twoFactorConfig).toBeUndefined();
  });

  it('answers the same generic 401 for a wrong password', async () => {
    const { app } = buildWithNoTwoFactor();
    await enroll(app);

    const res = await confirm(app, { password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
  });

  it('a mix of enroll and confirm failures locks the account at five', async () => {
    const { app, db } = buildWithNoTwoFactor();
    await enroll(app);

    await enroll(app, { password: 'wrong' });
    await enroll(app, { password: 'wrong' });
    await confirm(app, { code: 'wrong' });
    await confirm(app, { code: 'wrong' });
    expect(db.state.users.get('user-42').isLocked).toBe(false);

    await confirm(app, { code: 'wrong' });
    expect(db.state.users.get('user-42').isLocked).toBe(true);
  });
});

// The whole point of generating the secret server-side and returning it
// exactly once: it must never end up in a log line. Asserted both by
// behaviour (console spies below) and by a static check of the two modules
// that ever touch the plaintext secret.
describe('the plaintext TOTP secret is never logged', () => {
  it('never calls any console method while enrolling or confirming', async () => {
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      jest.spyOn(console, method).mockImplementation(() => {})
    );

    try {
      const { app } = buildWithNoTwoFactor();
      await enroll(app);
      await confirm(app, { code: 'wrong' });
      await confirm(app);

      for (const spy of consoleSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      consoleSpies.forEach((spy) => spy.mockRestore());
    }
  });

  it('source files for enrollment contain no console.* calls', () => {
    const files = [
      path.join(__dirname, '..', 'src', 'services', 'two-factor-enrollment.js'),
      path.join(__dirname, '..', 'src', 'routes', 'two-factor.js'),
    ];

    for (const file of files) {
      const contents = fs.readFileSync(file, 'utf8');
      expect(contents).not.toMatch(/console\.(log|info|warn|error|debug)/);
    }
  });
});
