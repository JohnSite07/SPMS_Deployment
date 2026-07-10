const request = require('supertest');
const { ACTIONS } = require('../src/models/audit-entry');
const { ALLOWED_METHODS } = require('../src/routes/audit');
const { createFakeDatabase } = require('./helpers/fake-database');
const { testApp, seedUser, seedAdmin, PASSWORD, TWO_FACTOR_CODE } = require('./helpers/test-app');

function build(dbOptions = {}) {
  const db = createFakeDatabase({ users: [seedUser(), seedAdmin()], ...dbOptions });
  return { ...testApp({ db }), db };
}

async function login(app, email) {
  const res = await request(app)
    .post('/api/session')
    .send({ email, password: PASSWORD, code: TWO_FACTOR_CODE });
  expect(res.status).toBe(201);
  return res.body.token;
}

const asOwner = (app) => login(app, 'owner@example.com');
const asAdmin = (app) => login(app, 'admin@example.com');

const history = (app, token, userId, query = '') =>
  request(app).get(`/api/admin/audit/${userId}${query}`).set('Authorization', `Bearer ${token}`);

let errorSpy;
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe('authorisation', () => {
  it('serves an admin', async () => {
    const { app } = build();
    await asOwner(app);
    const res = await history(app, await asAdmin(app), 'user-42');

    expect(res.status).toBe(200);
    expect(res.body.entries.every((e) => e.userId === 'user-42')).toBe(true);
  });

  // 403, not 404 and not 405: the route exists, the caller is authenticated,
  // and a different caller would be let through.
  it('answers 403 to an owner', async () => {
    const { app } = build();
    const res = await history(app, await asOwner(app), 'user-42');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });

  it('answers 403 to an owner reading their own history', async () => {
    const { app } = build();
    expect((await history(app, await asOwner(app), 'user-42')).status).toBe(403);
  });

  it('answers 401 with no token, before the role is even considered', async () => {
    const { app } = build();
    expect((await request(app).get('/api/admin/audit/user-42')).status).toBe(401);
  });

  // The role rides on the signed token, and it comes from the user row.
  it('grants admin from the user row, not from anything the client sends', async () => {
    const { app, tokenService } = build();
    const ownerToken = await asOwner(app);

    expect(tokenService.verify(ownerToken).role).toBe('owner');
    expect(tokenService.verify(await asAdmin(app)).role).toBe('admin');
  });

  // The signature is now the only thing between an owner and an admin, so
  // pin that it actually holds.
  it('refuses a token whose role claim was tampered with', async () => {
    const { app } = build();
    const ownerToken = await asOwner(app);

    const [header, payload, signature] = ownerToken.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const forged = Buffer.from(JSON.stringify({ ...claims, role: 'admin' })).toString('base64url');

    const res = await history(app, `${header}.${forged}.${signature}`, 'user-42');
    expect(res.status).toBe(401);
  });

  it('gives an owner no hint about which role would work', async () => {
    const { app } = build();
    const res = await history(app, await asOwner(app), 'user-42');
    expect(JSON.stringify(res.body)).not.toContain('admin');
  });
});

describe('reading a user\'s history', () => {
  it('returns the target user\'s entries, not the admin\'s', async () => {
    const { app } = build();
    await asOwner(app);
    const adminToken = await asAdmin(app);

    const res = await history(app, adminToken, 'user-42');

    expect(res.body.entries.map((e) => e.action)).toContain(ACTIONS.LOGIN_SUCCEEDED);
    expect(res.body.entries.every((e) => e.userId === 'user-42')).toBe(true);
  });

  it('paginates with the same keyset cursor', async () => {
    const { app } = build();
    const ownerToken = await asOwner(app);
    for (let i = 0; i < 4; i += 1) {
      await request(app)
        .post('/api/credentials')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: `i-${i}`, encryptedPassword: 'AES256:x' });
    }
    const adminToken = await asAdmin(app);

    const first = await history(app, adminToken, 'user-42', '?limit=2');
    expect(first.body.entries).toHaveLength(2);

    const second = await history(
      app,
      adminToken,
      'user-42',
      `?limit=50&cursor=${first.body.nextCursor}`
    );
    const ids = [...first.body.entries, ...second.body.entries].map((e) => e.entryId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['a bad limit', '?limit=0'],
    ['a bad cursor', '?cursor=nope'],
  ])('answers 400 for %s', async (_name, query) => {
    const { app } = build();
    const res = await history(app, await asAdmin(app), 'user-42', query);
    expect(res.status).toBe(400);
  });

  // An AuditLog belongs to a User. A read of nobody's log cannot be recorded,
  // so it must not happen at all.
  it('answers 404 for a user who does not exist, writing nothing', async () => {
    const { app, db } = build();
    const adminToken = await asAdmin(app);
    const before = db.state.entries.length;

    const res = await history(app, adminToken, 'user-does-not-exist');

    expect(res.status).toBe(404);
    expect(db.state.entries).toHaveLength(before);
  });

  it('discloses no vault contents — the log never held any', async () => {
    const { app } = build();
    const ownerToken = await asOwner(app);
    await request(app)
      .post('/api/credentials')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Bank', encryptedPassword: 'AES256:secret-ciphertext' });

    const res = await history(app, await asAdmin(app), 'user-42');

    expect(res.text).not.toContain('AES256');
    expect(res.text).not.toContain('Bank');
  });
});

// The chosen design: admin accountability AND user transparency.
describe('the read is itself audited, in both logs', () => {
  it('writes one entry to the admin\'s log naming whose history was read', async () => {
    const { app, db } = build();
    await asOwner(app);
    await history(app, await asAdmin(app), 'user-42');

    const [entry] = db.entriesFor('admin-1').filter((e) => e.action === ACTIONS.AUDIT_LOG_READ);
    expect(entry.targetUserId).toBe('user-42');
    expect(entry.actorUserId).toBeNull();
  });

  it('writes one entry to the read user\'s log naming who read it', async () => {
    const { app, db } = build();
    await asOwner(app);
    await history(app, await asAdmin(app), 'user-42');

    const [entry] = db.entriesFor('user-42').filter((e) => e.action === ACTIONS.AUDIT_LOG_READ);
    expect(entry.actorUserId).toBe('admin-1');
    expect(entry.targetUserId).toBeNull();
  });

  // The property that makes this worth doing: the watched user can see it.
  it('surfaces the admin\'s read in the user\'s own activity view', async () => {
    const { app } = build();
    const ownerToken = await asOwner(app);
    await history(app, await asAdmin(app), 'user-42');

    const res = await request(app).get('/api/audit').set('Authorization', `Bearer ${ownerToken}`);

    const read = res.body.entries.find((e) => e.action === ACTIONS.AUDIT_LOG_READ);
    expect(read).toMatchObject({ userId: 'user-42', actorUserId: 'admin-1' });
    expect(read.targetUserId).toBeUndefined();
  });

  it('commits both entries in one transaction', async () => {
    const { app, db } = build();
    await asOwner(app);
    await history(app, await asAdmin(app), 'user-42');

    const reads = db.state.entries.filter((e) => e.action === ACTIONS.AUDIT_LOG_READ);
    expect(reads).toHaveLength(2);
    expect(db.appendContexts.every((c) => c && typeof c.id === 'string')).toBe(true);
  });

  // A privileged cross-user read that cannot be recorded does not happen.
  it('discloses nothing, and records nothing, when the entries cannot be written', async () => {
    const { app, db } = build({ failAppendOn: ACTIONS.AUDIT_LOG_READ });
    await asOwner(app);

    const res = await history(app, await asAdmin(app), 'user-42');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
    expect(db.state.entries.filter((e) => e.action === ACTIONS.AUDIT_LOG_READ)).toEqual([]);
  });

  it('records a single entry when an admin reads their own history', async () => {
    const { app, db } = build();
    await history(app, await asAdmin(app), 'admin-1');

    const reads = db.state.entries.filter((e) => e.action === ACTIONS.AUDIT_LOG_READ);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ userId: 'admin-1', targetUserId: 'admin-1' });
    expect(reads[0].actorUserId).toBeNull();
  });

  // One pair per page read. An admin walking a long history leaves a trail in
  // the user's activity view proportional to how much of it they looked at.
  it('records one pair per page, not one per walk', async () => {
    const { app, db } = build();
    const ownerToken = await asOwner(app);
    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post('/api/credentials')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: `i-${i}`, encryptedPassword: 'AES256:x' });
    }
    const adminToken = await asAdmin(app);

    const first = await history(app, adminToken, 'user-42', '?limit=2');
    await history(app, adminToken, 'user-42', `?limit=2&cursor=${first.body.nextCursor}`);

    expect(db.state.entries.filter((e) => e.action === ACTIONS.AUDIT_LOG_READ)).toHaveLength(4);
  });
});

// An admin has more reach than an owner, and still cannot rewrite history.
describe('append-only holds for admins too', () => {
  it.each(['post', 'put', 'patch', 'delete'])('refuses %s with 405', async (method) => {
    const { app, db } = build();
    const adminToken = await asAdmin(app);
    const before = db.state.entries.length;

    const res = await request(app)[method]('/api/admin/audit/user-42')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'forged' });

    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe(ALLOWED_METHODS);
    expect(db.state.entries).toHaveLength(before);
  });

  it('checks the role before refusing the method', async () => {
    const { app } = build();
    const res = await request(app)
      .delete('/api/admin/audit/user-42')
      .set('Authorization', `Bearer ${await asOwner(app)}`);

    expect(res.status).toBe(403);
  });
});
