const request = require('supertest');
const { ACTIONS } = require('../src/models/audit-entry');
const { createFakeDatabase } = require('./helpers/fake-database');
const { testApp, seedUser, PASSWORD, TWO_FACTOR_CODE } = require('./helpers/test-app');

function build(dbOptions = {}) {
  const db = createFakeDatabase({ users: [seedUser()], ...dbOptions });
  return { ...testApp({ db }), db };
}

const credentials = (overrides = {}) => ({
  email: 'owner@example.com',
  password: PASSWORD,
  code: TWO_FACTOR_CODE,
  ...overrides,
});

const login = (app, overrides) => request(app).post('/api/session').send(credentials(overrides));

let errorSpy;
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe('POST /api/session (UC-01 log in)', () => {
  it('is reachable without a token — it is what mints one', async () => {
    const { app } = build();
    const res = await login(app);

    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.sessionId).toEqual(expect.any(String));
  });

  it('records login.succeeded against the user', async () => {
    const { app, db } = build();
    await login(app);

    expect(db.actions()).toEqual([ACTIONS.LOGIN_SUCCEEDED]);
    expect(db.entriesFor('user-42')[0].userId).toBe('user-42');
  });

  it('writes the entry in the same transaction as the session row', async () => {
    const { app, db } = build();
    await login(app);
    expect(db.appendContexts.every((c) => c && typeof c.id === 'string')).toBe(true);
  });

  it('the minted token is accepted on the next request', async () => {
    const { app } = build();
    const { body } = await login(app);

    const res = await request(app)
      .get('/api/session')
      .set('Authorization', `Bearer ${body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(body.sessionId);
  });

  it.each([
    ['a wrong password', { password: 'wrong' }],
    ['a wrong 2FA code', { code: '000000' }],
  ])('records login.failed for %s', async (_name, overrides) => {
    const { app, db } = build();
    const res = await login(app, overrides);

    expect(res.status).toBe(401);
    expect(db.actions()).toEqual([ACTIONS.LOGIN_FAILED]);
  });

  // The response must not say which half was wrong, nor whether the account
  // exists at all.
  it('answers every failure identically', async () => {
    const { app } = build();

    const bodies = await Promise.all(
      [
        { password: 'wrong' },
        { code: '000000' },
        { email: 'nobody@example.com' },
      ].map(async (o) => (await login(app, o)).body)
    );

    expect(bodies).toEqual([
      { error: 'invalid_credentials' },
      { error: 'invalid_credentials' },
      { error: 'invalid_credentials' },
    ]);
  });

  // An AuditEntry needs a userId, and an unknown email has none: the domain
  // composes the AuditLog into a User. Deliberate gap, documented in the route.
  it('writes no entry for an email that matches no account', async () => {
    const { app, db } = build();
    const res = await login(app, { email: 'nobody@example.com' });

    expect(res.status).toBe(401);
    expect(db.state.entries).toEqual([]);
  });

  it('counts a failed attempt toward the five-failure lockout', async () => {
    const { app, db } = build();

    for (let i = 0; i < 5; i += 1) {
      await login(app, { password: 'wrong' });
    }

    expect(db.state.users.get('user-42').isLocked).toBe(true);
  });

  it('records account.locked, not login.failed, once the account is locked', async () => {
    const { app, db } = build({ users: [seedUser({ isLocked: true })] });

    const res = await login(app);

    expect(res.status).toBe(401);
    expect(db.actions()).toEqual([ACTIONS.ACCOUNT_LOCKED]);
  });

  it('does not extend the lockout by counting attempts against a locked account', async () => {
    const { app, db } = build({ users: [seedUser({ isLocked: true, failedAttempts: 5 })] });
    await login(app);

    expect(db.state.users.get('user-42').failedAttempts).toBe(5);
  });

  it('clears the failure count on a successful login', async () => {
    const { app, db } = build();
    await login(app, { password: 'wrong' });
    await login(app);

    expect(db.state.users.get('user-42').failedAttempts).toBe(0);
  });

  // A failed login that cannot be recorded must not be reported as a plain
  // failure: the lockout counts entries, so a suppressible write is an
  // unlimited brute-force budget.
  it('answers 500, not 401, when a failed login cannot be logged', async () => {
    const { app } = build({ failAppendOn: ACTIONS.LOGIN_FAILED });
    const res = await login(app, { password: 'wrong' });

    expect(res.status).toBe(500);
  });

  it('rolls the session back when login.succeeded cannot be logged', async () => {
    const { app, db } = build({ failAppendOn: ACTIONS.LOGIN_SUCCEEDED });
    const res = await login(app);

    expect(res.status).toBe(500);
    expect(db.state.sessions.size).toBe(0);
  });
});

describe('DELETE /api/session (log out)', () => {
  it('records session.ended and answers 204', async () => {
    const { app, db } = build();
    const { body } = await login(app);

    const res = await request(app)
      .delete('/api/session')
      .set('Authorization', `Bearer ${body.token}`);

    expect(res.status).toBe(204);
    expect(db.actions()).toEqual([ACTIONS.LOGIN_SUCCEEDED, ACTIONS.SESSION_ENDED]);
  });

  // The point of choosing revocation over an advisory logout: the token the
  // client held stops working immediately, not when its idle window lapses.
  it('kills the token it was called with', async () => {
    const { app } = build();
    const { body } = await login(app);
    const auth = { Authorization: `Bearer ${body.token}` };

    expect((await request(app).get('/api/session').set(auth)).status).toBe(200);
    await request(app).delete('/api/session').set(auth);

    const after = await request(app).get('/api/session').set(auth);
    expect(after.status).toBe(401);
    expect(after.body.error_description).toBe('Session ended');
  });

  // The renewed sliding-window token names the same session, so it dies too.
  it('kills the renewed token the middleware handed out', async () => {
    const { app } = build();
    const { body } = await login(app);
    const auth = { Authorization: `Bearer ${body.token}` };

    const active = await request(app).get('/api/session').set(auth);
    const renewed = active.headers['x-session-token'];

    await request(app).delete('/api/session').set(auth);

    const res = await request(app).get('/api/session').set('Authorization', `Bearer ${renewed}`);
    expect(res.status).toBe(401);
  });

  it('requires a token — logout is not public', async () => {
    const { app, db } = build();
    await login(app);

    const res = await request(app).delete('/api/session');

    expect(res.status).toBe(401);
    expect(db.actions()).not.toContain(ACTIONS.SESSION_ENDED);
  });

  // Otherwise "log out" reports success while the session lives on.
  it('leaves the session live when the logout cannot be logged', async () => {
    const { app, db } = build({ failAppendOn: ACTIONS.SESSION_ENDED });
    const { body } = await login(app);
    const auth = { Authorization: `Bearer ${body.token}` };

    const res = await request(app).delete('/api/session').set(auth);

    expect(res.status).toBe(500);
    expect(db.state.revoked.size).toBe(0);
    expect((await request(app).get('/api/session').set(auth)).status).toBe(200);
  });
});

describe('session revocation in the auth middleware', () => {
  it('refuses a token naming a session the store has never seen', async () => {
    const { app, tokenService } = build();
    const orphan = tokenService.sign({ userId: 'user-42', sessionId: 'never-started' });

    const res = await request(app).get('/api/session').set('Authorization', `Bearer ${orphan}`);
    expect(res.status).toBe(401);
  });

  // A token with no jti names no session, so logout could never revoke it.
  it('refuses a token carrying no session id', async () => {
    const { app, tokenService } = build();
    const sessionless = tokenService.sign({ userId: 'user-42' });

    const res = await request(app)
      .get('/api/session')
      .set('Authorization', `Bearer ${sessionless}`);
    expect(res.status).toBe(401);
  });

  it('issues no renewed token to a revoked session', async () => {
    const { app } = build();
    const { body } = await login(app);
    const auth = { Authorization: `Bearer ${body.token}` };
    await request(app).delete('/api/session').set(auth);

    const res = await request(app).get('/api/session').set(auth);
    expect(res.headers['x-session-token']).toBeUndefined();
  });

  // An unreachable session store must deny, not wave the request through.
  it('answers 500, not 200, when the session store is down', async () => {
    const db = createFakeDatabase({ users: [seedUser()] });
    const { app } = testApp({ db });
    const { body } = await request(app).post('/api/session').send(credentials());

    db.sessions.isRevoked = async () => {
      throw new Error('cloud sql connection lost');
    };

    const res = await request(app)
      .get('/api/session')
      .set('Authorization', `Bearer ${body.token}`);
    expect(res.status).toBe(500);
  });
});
