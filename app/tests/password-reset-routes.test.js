const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { authenticator } = require('otplib');
const { ACTIONS } = require('../src/models/audit-entry');
const cryptoService = require('../src/services/crypto');
const { createFakeDatabase } = require('./helpers/fake-database');
const { testApp, seedUser, PASSWORD, TWO_FACTOR_CODE } = require('./helpers/test-app');

// PRD 0020 — TOTP-based password reset, replacing PRD 0015's emailed-token
// flow. This route verifies identity with the user's already-enrolled 2FA
// TOTP code via the real, unmodified services/two-factor-verifier.js — not
// through the fake verifyTwoFactorCode test-app.js wires into session-issuer
// for login — so these tests build a genuine AES-256-GCM-encrypted TOTP
// secret and compute real codes against it, the same pattern
// two-factor-verifier.test.js and two-factor-routes.test.js already use.

const TEST_AES_KEY = crypto.randomBytes(32);
const originalAesKey = process.env.AES_ENCRYPTION_KEY;

beforeAll(() => {
  process.env.AES_ENCRYPTION_KEY = TEST_AES_KEY.toString('base64');
});
afterAll(() => {
  process.env.AES_ENCRYPTION_KEY = originalAesKey;
});

const NEW_PASSWORD = 'New-Correct9!';

// A real TOTP secret + its current code, packaged as the encryptedSecret
// shape ports/users.js attaches to a User (see two-factor-verifier.js's own
// param doc) — this is what makes the route's direct call into the real
// verifier succeed or fail exactly as it would in production.
function realTotpConfig() {
  const secret = authenticator.generateSecret();
  return {
    secret,
    code: authenticator.generate(secret),
    twoFactorConfig: {
      method: 'TOTP',
      enabled: true,
      encryptedSecret: cryptoService.encrypt(secret),
    },
  };
}

function buildWithTotp() {
  const totp = realTotpConfig();
  const db = createFakeDatabase({
    users: [seedUser({ twoFactorConfig: totp.twoFactorConfig })],
  });
  return { ...testApp({ db }), db, totp };
}

function buildWithNoTwoFactor() {
  const db = createFakeDatabase({ users: [seedUser({ twoFactorConfig: undefined })] });
  return { ...testApp({ db }), db };
}

const resetRequest = (app, overrides = {}) =>
  request(app)
    .post('/api/password-reset')
    .send({ email: 'owner@example.com', newPassword: NEW_PASSWORD, ...overrides });

describe('POST /api/password-reset', () => {
  it('is reachable without a bearer token', async () => {
    const { app, totp } = buildWithTotp();
    const res = await resetRequest(app, { code: totp.code });
    expect(res.status).not.toBe(401);
  });

  it('accepts a correct email, current TOTP code, and strong password: updates the hash, revokes sessions, and audits the change', async () => {
    const { app, db, totp } = buildWithTotp();

    const login = await request(app)
      .post('/api/session')
      .send({ email: 'owner@example.com', password: PASSWORD, code: TWO_FACTOR_CODE });
    expect(login.status).toBe(201);
    const auth = { Authorization: `Bearer ${login.body.token}` };
    expect((await request(app).get('/api/session').set(auth)).status).toBe(200);

    const res = await resetRequest(app, { code: totp.code });
    expect(res.status).toBe(204);

    // Prior session revoked.
    expect((await request(app).get('/api/session').set(auth)).status).toBe(401);

    // Audit entry recorded.
    expect(db.actions()).toContain(ACTIONS.MASTER_PASSWORD_CHANGED);

    // The failed-attempt counter is clean immediately after a successful
    // reset — checked before any further login attempt, since a *subsequent*
    // wrong-password attempt against the old password is its own, separate
    // failure that session.js is expected to count.
    expect(db.state.users.get('user-42').failedAttempts).toBe(0);

    // New password logs in; old password no longer does.
    const withNewPassword = await request(app)
      .post('/api/session')
      .send({ email: 'owner@example.com', password: NEW_PASSWORD, code: TWO_FACTOR_CODE });
    expect(withNewPassword.status).toBe(201);

    const withOldPassword = await request(app)
      .post('/api/session')
      .send({ email: 'owner@example.com', password: PASSWORD, code: TWO_FACTOR_CODE });
    expect(withOldPassword.status).toBe(401);
  });

  it('answers the same generic 401 for an unknown email, recording nothing', async () => {
    const { app, db } = buildWithTotp();

    const res = await resetRequest(app, { email: 'nobody@example.com', code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
    expect(db.state.users.get('user-42').failedAttempts).toBe(0);
    expect(db.actions()).not.toContain(ACTIONS.MASTER_PASSWORD_CHANGED);
  });

  it('answers the same generic 401 for an account with no enabled 2FA, recording nothing', async () => {
    const { app, db } = buildWithNoTwoFactor();

    const res = await resetRequest(app, { code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
    expect(db.state.users.get('user-42').failedAttempts).toBe(0);
    expect(db.actions()).not.toContain(ACTIONS.MASTER_PASSWORD_CHANGED);
  });

  it('answers the same generic 401 for a wrong code, and counts it toward the lockout', async () => {
    const { app, db } = buildWithTotp();

    const res = await resetRequest(app, { code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
    expect(db.state.users.get('user-42').failedAttempts).toBe(1);
    expect(db.actions()).not.toContain(ACTIONS.MASTER_PASSWORD_CHANGED);
  });

  it('locks the account for 15 minutes after five wrong codes — the endpoint\'s core brute-force protection', async () => {
    const { app, db } = buildWithTotp();

    for (let i = 0; i < 5; i += 1) {
      await resetRequest(app, { code: '000000' });
    }

    expect(db.state.users.get('user-42').isLocked).toBe(true);
    expect(db.state.users.get('user-42').failedAttempts).toBe(5);
  });

  // infra-reviewer sign-off blocker: once locked, a further wrong-code
  // attempt must not call recordFailedAttempt again — against the real port
  // (ports/users.js) that call re-arms lockout_until another 15 minutes into
  // the future every time, which would keep a real account locked
  // indefinitely under repeated guessing. Asserted here via the fake store:
  // the failure counter must not move past 5, and recordFailedAttempt itself
  // must not be invoked for the 6th attempt.
  it('does not extend the lockout window on wrong-code attempts once already locked', async () => {
    const { app, db } = buildWithTotp();

    for (let i = 0; i < 5; i += 1) {
      await resetRequest(app, { code: '000000' });
    }
    expect(db.state.users.get('user-42').isLocked).toBe(true);
    expect(db.state.users.get('user-42').failedAttempts).toBe(5);

    const recordFailedAttempt = jest.spyOn(db.users, 'recordFailedAttempt');

    const res = await resetRequest(app, { code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
    expect(recordFailedAttempt).not.toHaveBeenCalled();
    // Unmoved — a real lockout_until re-armed by another recordFailedAttempt
    // call is exactly what this test would otherwise miss.
    expect(db.state.users.get('user-42').failedAttempts).toBe(5);

    recordFailedAttempt.mockRestore();
  });

  // Matches session-issuer.js's verifyMasterPassword: a locked account is
  // refused outright, before any code is even checked — a correct TOTP code
  // does not bypass an active lockout, the same as a correct password does
  // not bypass one at login.
  it('denies a correct code against an already-locked account, same generic shape', async () => {
    const { app, db, totp } = buildWithTotp();

    for (let i = 0; i < 5; i += 1) {
      await resetRequest(app, { code: '000000' });
    }
    expect(db.state.users.get('user-42').isLocked).toBe(true);

    const res = await resetRequest(app, { code: totp.code });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
    expect(db.actions()).not.toContain(ACTIONS.MASTER_PASSWORD_CHANGED);
  });

  it.each([
    ['too short', 'Short9!Aa'],
    ['no uppercase', 'lowercase-only-999!'],
    ['no lowercase', 'UPPERCASE-ONLY-999!'],
    ['no number', 'NoNumbersHere!Aa'],
    ['no symbol', 'NoSymbolHereAtAll99'],
  ])('rejects a weak newPassword (%s), changing nothing', async (_name, weakPassword) => {
    const { app, db, totp } = buildWithTotp();

    const res = await resetRequest(app, { code: totp.code, newPassword: weakPassword });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'weak_password' });
    expect(db.actions()).not.toContain(ACTIONS.MASTER_PASSWORD_CHANGED);

    // The old password must still work — a rejected weak attempt must not
    // have consumed the (single-use-free) TOTP code's proof of anything else.
    const withOldPassword = await request(app)
      .post('/api/session')
      .send({ email: 'owner@example.com', password: PASSWORD, code: TWO_FACTOR_CODE });
    expect(withOldPassword.status).toBe(201);
  });

  // Business rule 7's atomicity, exercised the same way session-routes.test.js
  // exercises it for login: a write that cannot be logged must not stand.
  it('rolls back the hash change and session revocation when the audit append fails', async () => {
    const totp = realTotpConfig();
    const db = createFakeDatabase({
      users: [seedUser({ twoFactorConfig: totp.twoFactorConfig })],
      failAppendOn: ACTIONS.MASTER_PASSWORD_CHANGED,
    });
    const { app } = testApp({ db });

    const res = await resetRequest(app, { code: totp.code });

    expect(res.status).toBe(500);
    expect(db.actions()).not.toContain(ACTIONS.MASTER_PASSWORD_CHANGED);

    const withOldPassword = await request(app)
      .post('/api/session')
      .send({ email: 'owner@example.com', password: PASSWORD, code: TWO_FACTOR_CODE });
    expect(withOldPassword.status).toBe(201);
  });
});

// This route touches both a plaintext newPassword and a TOTP code — neither
// may ever reach a log line.
describe('the newPassword and TOTP code are never logged', () => {
  it('never calls any console method across a full run of successes and failures', async () => {
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      jest.spyOn(console, method).mockImplementation(() => {})
    );

    try {
      const { app, totp } = buildWithTotp();
      await resetRequest(app, { code: 'wrong' });
      await resetRequest(app, { code: totp.code, newPassword: 'weak' });
      await resetRequest(app, { code: totp.code });

      for (const spy of consoleSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      consoleSpies.forEach((spy) => spy.mockRestore());
    }
  });

  it('source file contains no console.* calls', () => {
    const file = path.join(__dirname, '..', 'src', 'routes', 'password-reset.js');
    const contents = fs.readFileSync(file, 'utf8');
    expect(contents).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });
});
