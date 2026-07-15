const { URL } = require('url');
const request = require('supertest');
const { ACTIONS } = require('../src/models/audit-entry');
const { createFakeDatabase } = require('./helpers/fake-database');
const { testApp, seedUser, PASSWORD, TWO_FACTOR_CODE, TEST_APP_BASE_URL } = require('./helpers/test-app');

// PRD 0015 — the reset half of "forgotten master password". Re-hash only:
// no vault re-encryption is exercised or expected here (see this PRD's "key
// decision"), only USERS.master_password_hash, SESSIONS, and the audit log.

function build(dbOptions = {}) {
  const db = createFakeDatabase({ users: [seedUser()], ...dbOptions });
  return { ...testApp({ db }), db };
}

function extractToken(resetUrl) {
  return new URL(resetUrl).searchParams.get('token');
}

async function requestReset(app, email, overrides = {}) {
  await request(app)
    .post('/api/password-reset/request')
    .send({ email: 'owner@example.com', ...overrides });
  const call = email.sendPasswordResetEmail.mock.calls.at(-1);
  return extractToken(call[0].resetUrl);
}

const NEW_PASSWORD = 'New-Correct9!';

describe('POST /api/password-reset/request', () => {
  it('is reachable without a bearer token', async () => {
    const { app } = build();
    const res = await request(app)
      .post('/api/password-reset/request')
      .send({ email: 'owner@example.com' });
    expect(res.status).not.toBe(401);
  });

  it('answers 200 { ok: true } and emails a link for a known email', async () => {
    const { app, email } = build();

    const res = await request(app)
      .post('/api/password-reset/request')
      .send({ email: 'owner@example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(email.sendPasswordResetEmail).toHaveBeenCalledTimes(1);

    const { to, resetUrl } = email.sendPasswordResetEmail.mock.calls[0][0];
    expect(to).toBe('owner@example.com');
    expect(resetUrl.startsWith(TEST_APP_BASE_URL)).toBe(true);
    expect(extractToken(resetUrl)).toEqual(expect.any(String));
  });

  it('answers the identical 200 body for an unknown email — no enumeration', async () => {
    const { app, email } = build();

    const res = await request(app)
      .post('/api/password-reset/request')
      .send({ email: 'nobody@example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(email.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('answers 200 identically with no email at all in the body', async () => {
    const { app, email } = build();
    const res = await request(app).post('/api/password-reset/request').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(email.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('stores only the token hash, never the raw token', async () => {
    const { app, db } = build();
    await request(app).post('/api/password-reset/request').send({ email: 'owner@example.com' });

    expect(db.state.resetTokens.size).toBe(1);
    const [key] = db.state.resetTokens.keys();
    // A hex-encoded 32-byte SHA-256 digest — never a plausible raw token.
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('POST /api/password-reset/confirm', () => {
  it('is reachable without a bearer token', async () => {
    const { app, email } = build();
    const token = await requestReset(app, email);

    const res = await request(app)
      .post('/api/password-reset/confirm')
      .send({ token, newPassword: NEW_PASSWORD });
    expect(res.status).not.toBe(401);
  });

  it('sets the new hash, revokes every session, and logs MASTER_PASSWORD_CHANGED', async () => {
    const { app, db, email } = build();

    const login = await request(app)
      .post('/api/session')
      .send({ email: 'owner@example.com', password: PASSWORD, code: TWO_FACTOR_CODE });
    const auth = { Authorization: `Bearer ${login.body.token}` };
    expect((await request(app).get('/api/session').set(auth)).status).toBe(200);

    const token = await requestReset(app, email);
    const res = await request(app)
      .post('/api/password-reset/confirm')
      .send({ token, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(204);

    // Prior session revoked.
    expect((await request(app).get('/api/session').set(auth)).status).toBe(401);

    // Audit entry recorded.
    expect(db.actions()).toContain(ACTIONS.MASTER_PASSWORD_CHANGED);

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

  it('rejects a token that was never issued, changing nothing', async () => {
    const { app, db } = build();

    const res = await request(app)
      .post('/api/password-reset/confirm')
      .send({ token: 'never-issued-token', newPassword: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(db.actions()).not.toContain(ACTIONS.MASTER_PASSWORD_CHANGED);
  });

  it('rejects an already-used token on the second attempt', async () => {
    const { app, email } = build();
    const token = await requestReset(app, email);

    const first = await request(app)
      .post('/api/password-reset/confirm')
      .send({ token, newPassword: NEW_PASSWORD });
    expect(first.status).toBe(204);

    const second = await request(app)
      .post('/api/password-reset/confirm')
      .send({ token, newPassword: 'Another-Correct9!' });
    expect(second.status).toBe(400);
  });

  it('rejects an expired token, changing nothing', async () => {
    // A resetClock stuck an hour in the past: the minted token's expiresAt
    // (resetClock() + ttlMinutes) is already behind real Date.now() by the
    // time /confirm runs.
    const anHourAgo = Date.now() - 60 * 60 * 1000;
    const db = createFakeDatabase({ users: [seedUser()] });
    const { app, email } = testApp({ db, resetClock: () => anHourAgo });

    const token = await requestReset(app, email);
    const res = await request(app)
      .post('/api/password-reset/confirm')
      .send({ token, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(db.actions()).not.toContain(ACTIONS.MASTER_PASSWORD_CHANGED);
  });

  it.each([
    ['too short', 'Short9!Aa'],
    ['no uppercase', 'lowercase-only-999!'],
    ['no lowercase', 'UPPERCASE-ONLY-999!'],
    ['no number', 'NoNumbersHere!Aa'],
    ['no symbol', 'NoSymbolHereAtAll99'],
  ])('rejects a weak newPassword (%s), changing nothing', async (_name, weakPassword) => {
    const { app, db, email } = build();
    const token = await requestReset(app, email);

    const res = await request(app)
      .post('/api/password-reset/confirm')
      .send({ token, newPassword: weakPassword });

    expect(res.status).toBe(400);
    expect(db.actions()).not.toContain(ACTIONS.MASTER_PASSWORD_CHANGED);

    // The token must still be usable with a strong password afterward — a
    // rejected weak attempt must not have consumed it.
    const retry = await request(app)
      .post('/api/password-reset/confirm')
      .send({ token, newPassword: NEW_PASSWORD });
    expect(retry.status).toBe(204);
  });

  // Business rule 7's atomicity, exercised the same way session-routes.test.js
  // exercises it for login: a write that cannot be logged must not stand.
  it('rolls back the hash change, session revocation, and token consumption when the audit append fails', async () => {
    const db = createFakeDatabase({
      users: [seedUser()],
      failAppendOn: ACTIONS.MASTER_PASSWORD_CHANGED,
    });
    const { app, email } = testApp({ db });
    const token = await requestReset(app, email);

    const res = await request(app)
      .post('/api/password-reset/confirm')
      .send({ token, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(500);
    expect(db.actions()).not.toContain(ACTIONS.MASTER_PASSWORD_CHANGED);

    // The old password still works — the hash was rolled back.
    const withOldPassword = await request(app)
      .post('/api/session')
      .send({ email: 'owner@example.com', password: PASSWORD, code: TWO_FACTOR_CODE });
    expect(withOldPassword.status).toBe(201);
  });

  it('rejects a missing token or missing newPassword without touching the store', async () => {
    const { app, db } = build();

    const noToken = await request(app)
      .post('/api/password-reset/confirm')
      .send({ newPassword: NEW_PASSWORD });
    expect(noToken.status).toBe(400);

    const noPassword = await request(app)
      .post('/api/password-reset/confirm')
      .send({ token: 'whatever' });
    expect(noPassword.status).toBe(400);

    expect(db.actions()).toEqual([]);
  });
});

// Deploy-safe lazy config (PRD 0015): when loadPasswordResetConfig() fails
// (SMTP not provisioned yet), server.js omits `email`/`appBaseUrl` and the
// rest of the app must still boot. routes/password-reset.js answers 503 on
// both endpoints instead of throwing at construction.
describe('disabled mode (SMTP not provisioned)', () => {
  function buildDisabled(dbOptions = {}) {
    const db = createFakeDatabase({ users: [seedUser()], ...dbOptions });
    return { ...testApp({ db, passwordResetEnabled: false }), db };
  }

  it('still constructs the app and serves unrelated routes', async () => {
    // The whole point: a missing SMTP integration must not take the service
    // down. If createApp() threw, testApp() would throw here and the suite
    // would error rather than reach the assertion below.
    const { app } = buildDisabled();
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('answers 503 on /request and mints no token', async () => {
    const { app, db } = buildDisabled();
    const res = await request(app)
      .post('/api/password-reset/request')
      .send({ email: 'owner@example.com' });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'service_unavailable' });
    expect(db.state.resetTokens.size).toBe(0);
  });

  it('answers 503 on /confirm and changes nothing', async () => {
    const { app, db } = buildDisabled();
    const res = await request(app)
      .post('/api/password-reset/confirm')
      .send({ token: 'anything', newPassword: NEW_PASSWORD });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'service_unavailable' });
    expect(db.actions()).not.toContain(ACTIONS.MASTER_PASSWORD_CHANGED);
  });

  it('is still public (503, not 401) when disabled', async () => {
    const { app } = buildDisabled();
    const res = await request(app).post('/api/password-reset/request').send({});
    expect(res.status).toBe(503);
  });
});
