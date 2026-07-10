const request = require('supertest');
const { ACTIONS } = require('../src/models/audit-entry');
const { createFakeDatabase } = require('./helpers/fake-database');
const { testApp, seedUser, PASSWORD, TWO_FACTOR_CODE } = require('./helpers/test-app');

const OTHER = seedUser({ userId: 'user-99', email: 'other@example.com' });

function build(dbOptions = {}) {
  const db = createFakeDatabase({ users: [seedUser(), OTHER], ...dbOptions });
  return { ...testApp({ db }), db };
}

async function login(app, email = 'owner@example.com') {
  const res = await request(app)
    .post('/api/session')
    .send({ email, password: PASSWORD, code: TWO_FACTOR_CODE });
  expect(res.status).toBe(201);
  return res.body.token;
}

const NEW_CREDENTIAL = {
  title: 'Bank',
  url: 'https://bank.example.com',
  username: 'owner',
  // Ciphertext. The server never sees the plaintext password, so it can never
  // log it — the reason the audit entry has no free-form details field.
  encryptedPassword: 'AES256:8f3a...',
};

async function addCredential(app, token, body = NEW_CREDENTIAL) {
  return request(app).post('/api/credentials').set('Authorization', `Bearer ${token}`).send(body);
}

// Routes that fail write a stack to the server log; keep the test output clean.
let errorSpy;
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe('POST /api/credentials (UC-02 add)', () => {
  it('stores the credential and records credential.added', async () => {
    const { app, db } = build();
    const token = await login(app);

    const res = await addCredential(app, token);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: 'Bank', encryptedPassword: 'AES256:8f3a...' });
    expect(db.actions()).toEqual([ACTIONS.LOGIN_SUCCEEDED, ACTIONS.CREDENTIAL_ADDED]);
  });

  it('attributes the entry to the authenticated user, not the request body', async () => {
    const { app, db } = build();
    const token = await login(app);

    await addCredential(app, token, { ...NEW_CREDENTIAL, userId: 'user-99' });

    const [entry] = db.entriesFor('user-42').filter((e) => e.action === ACTIONS.CREDENTIAL_ADDED);
    expect(entry.userId).toBe('user-42');
    expect(db.entriesFor('user-99')).toEqual([]);
  });

  it('writes the entry in the same transaction as the credential', async () => {
    const { app, db } = build();
    const token = await login(app);
    await addCredential(app, token);

    // Every append during a route ran with a transaction handle, not bare.
    expect(db.appendContexts.every((c) => c && typeof c.id === 'string')).toBe(true);
  });

  // UC-02 exception: required field empty -> save blocked.
  it.each([
    ['no title', { encryptedPassword: 'AES256:x' }],
    ['no encryptedPassword', { title: 'Bank' }],
    ['empty body', {}],
  ])('rejects %s with 400 and writes nothing', async (_name, body) => {
    const { app, db } = build();
    const token = await login(app);

    const res = await addCredential(app, token, body);

    expect(res.status).toBe(400);
    expect(db.state.credentials.size).toBe(0);
    expect(db.actions()).toEqual([ACTIONS.LOGIN_SUCCEEDED]);
  });

  // The guarantee the whole design exists for: an action that cannot be
  // logged does not happen.
  it('rolls the credential back when its audit entry cannot be written', async () => {
    const { app, db } = build({ failAppendOn: ACTIONS.CREDENTIAL_ADDED });
    const token = await login(app);

    const res = await addCredential(app, token);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
    expect(db.state.credentials.size).toBe(0);
  });

  it('requires authentication', async () => {
    const { app } = build();
    const res = await request(app).post('/api/credentials').send(NEW_CREDENTIAL);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/credentials/:itemId (UC-03 view)', () => {
  it('returns the credential and records credential.retrieved', async () => {
    const { app, db } = build();
    const token = await login(app);
    const { body } = await addCredential(app, token);

    const res = await request(app)
      .get(`/api/credentials/${body.itemId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.encryptedPassword).toBe('AES256:8f3a...');
    expect(db.actions()).toContain(ACTIONS.CREDENTIAL_RETRIEVED);
  });

  // Business rule 6, and no oracle: not-yours reads exactly like not-there.
  it("answers 404 for another user's credential and logs no access", async () => {
    const { app, db } = build();
    const ownerToken = await login(app);
    const { body } = await addCredential(app, ownerToken);
    const otherToken = await login(app, 'other@example.com');

    const res = await request(app)
      .get(`/api/credentials/${body.itemId}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(404);
    expect(db.entriesFor('user-99').map((e) => e.action)).toEqual([ACTIONS.LOGIN_SUCCEEDED]);
  });

  it('answers 404 for a credential that does not exist, writing no entry', async () => {
    const { app, db } = build();
    const token = await login(app);

    const res = await request(app)
      .get('/api/credentials/nope')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(db.actions()).not.toContain(ACTIONS.CREDENTIAL_RETRIEVED);
  });

  // If the access cannot be logged, the plaintext is not disclosed.
  it('does not disclose the credential when the access cannot be logged', async () => {
    const { app } = build({ failAppendOn: ACTIONS.CREDENTIAL_RETRIEVED });
    const token = await login(app);
    const { body } = await addCredential(app, token);

    const res = await request(app)
      .get(`/api/credentials/${body.itemId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.text).not.toContain('AES256:8f3a');
  });
});

describe('PATCH /api/credentials/:itemId (edit)', () => {
  it('updates the credential and records credential.updated', async () => {
    const { app, db } = build();
    const token = await login(app);
    const { body } = await addCredential(app, token);

    const res = await request(app)
      .patch(`/api/credentials/${body.itemId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ encryptedPassword: 'AES256:rotated' });

    expect(res.status).toBe(200);
    expect(res.body.encryptedPassword).toBe('AES256:rotated');
    expect(db.actions()).toContain(ACTIONS.CREDENTIAL_UPDATED);
  });

  // A PATCH that could set userId would move a credential into another user's
  // vault in one request. `userId` is not a mutable field, so this is a
  // no-op patch and therefore a 400 — not a silent transfer.
  it('refuses to reassign ownership', async () => {
    const { app, db } = build();
    const token = await login(app);
    const { body } = await addCredential(app, token);

    const res = await request(app)
      .patch(`/api/credentials/${body.itemId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'user-99', itemId: 'other-id' });

    expect(res.status).toBe(400);
    expect(db.state.credentials.get(body.itemId).userId).toBe('user-42');
    expect(db.actions()).not.toContain(ACTIONS.CREDENTIAL_UPDATED);
  });

  it("answers 404 for another user's credential and changes nothing", async () => {
    const { app, db } = build();
    const ownerToken = await login(app);
    const { body } = await addCredential(app, ownerToken);
    const otherToken = await login(app, 'other@example.com');

    const res = await request(app)
      .patch(`/api/credentials/${body.itemId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ title: 'Stolen' });

    expect(res.status).toBe(404);
    expect(db.state.credentials.get(body.itemId).title).toBe('Bank');
    expect(db.actions()).not.toContain(ACTIONS.CREDENTIAL_UPDATED);
  });

  it('rolls the edit back when its audit entry cannot be written', async () => {
    const { app, db } = build({ failAppendOn: ACTIONS.CREDENTIAL_UPDATED });
    const token = await login(app);
    const { body } = await addCredential(app, token);

    const res = await request(app)
      .patch(`/api/credentials/${body.itemId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Renamed' });

    expect(res.status).toBe(500);
    expect(db.state.credentials.get(body.itemId).title).toBe('Bank');
  });
});

describe('DELETE /api/credentials/:itemId (delete)', () => {
  it('removes the credential and records credential.deleted', async () => {
    const { app, db } = build();
    const token = await login(app);
    const { body } = await addCredential(app, token);

    const res = await request(app)
      .delete(`/api/credentials/${body.itemId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(db.state.credentials.size).toBe(0);
    expect(db.actions()).toContain(ACTIONS.CREDENTIAL_DELETED);
  });

  it('answers 404 the second time, having written one entry', async () => {
    const { app, db } = build();
    const token = await login(app);
    const { body } = await addCredential(app, token);
    const url = `/api/credentials/${body.itemId}`;

    await request(app).delete(url).set('Authorization', `Bearer ${token}`);
    const second = await request(app).delete(url).set('Authorization', `Bearer ${token}`);

    expect(second.status).toBe(404);
    expect(db.actions().filter((a) => a === ACTIONS.CREDENTIAL_DELETED)).toHaveLength(1);
  });

  it("answers 404 for another user's credential and deletes nothing", async () => {
    const { app, db } = build();
    const ownerToken = await login(app);
    const { body } = await addCredential(app, ownerToken);
    const otherToken = await login(app, 'other@example.com');

    const res = await request(app)
      .delete(`/api/credentials/${body.itemId}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(404);
    expect(db.state.credentials.has(body.itemId)).toBe(true);
    expect(db.actions()).not.toContain(ACTIONS.CREDENTIAL_DELETED);
  });

  // The destructive action the log most needs to witness. If it cannot be
  // witnessed, it does not happen.
  it('keeps the credential when its deletion cannot be logged', async () => {
    const { app, db } = build({ failAppendOn: ACTIONS.CREDENTIAL_DELETED });
    const token = await login(app);
    const { body } = await addCredential(app, token);

    const res = await request(app)
      .delete(`/api/credentials/${body.itemId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(db.state.credentials.has(body.itemId)).toBe(true);
  });
});
