const request = require('supertest');
const { ACTIONS } = require('../src/models/audit-entry');
const { ALLOWED_METHODS } = require('../src/routes/audit');
const { createFakeDatabase } = require('./helpers/fake-database');
const { testApp, seedUser, PASSWORD, TWO_FACTOR_CODE } = require('./helpers/test-app');

const OTHER = seedUser({ userId: 'user-99', email: 'other@example.com' });

function build() {
  const db = createFakeDatabase({ users: [seedUser(), OTHER] });
  return { ...testApp({ db }), db };
}

async function login(app, email = 'owner@example.com') {
  const res = await request(app)
    .post('/api/session')
    .send({ email, password: PASSWORD, code: TWO_FACTOR_CODE });
  return res.body.token;
}

let errorSpy;
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

// Business rule 7. These are the tests that make the rule true rather than
// merely written down.
describe('append-only enforcement', () => {
  const MUTATING = ['post', 'put', 'patch', 'delete'];

  it.each(MUTATING)('refuses %s on the collection with 405', async (method) => {
    const { app } = build();
    const token = await login(app);

    const res = await request(app)[method]('/api/audit')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'forged' });

    expect(res.status).toBe(405);
    expect(res.body.error).toBe('method_not_allowed');
    expect(res.headers.allow).toBe(ALLOWED_METHODS);
  });

  it.each(MUTATING)('refuses %s on a single entry with 405', async (method) => {
    const { app, db } = build();
    const token = await login(app);
    const [entry] = db.entriesFor('user-42');

    const res = await request(app)[method](`/api/audit/${entry.entryId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'forged' });

    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe(ALLOWED_METHODS);
  });

  // A user who could POST an entry could record an action they never took.
  // That corrupts the log as thoroughly as editing one, and needs no existing
  // entry to find first — so "append-only" excludes user appends.
  it('leaves the log untouched after every refused method', async () => {
    const { app, db } = build();
    const token = await login(app);
    const before = db.entriesFor('user-42').map((e) => e.toJSON());
    const [entry] = db.entriesFor('user-42');

    for (const method of MUTATING) {
      await request(app)[method]('/api/audit')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: 'user-42', action: ACTIONS.LOGIN_SUCCEEDED });
      await request(app)[method](`/api/audit/${entry.entryId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ action: 'forged' });
    }

    expect(db.entriesFor('user-42').map((e) => e.toJSON())).toEqual(before);
  });

  // 405 rather than 403: the method does not exist on this resource for
  // anyone, which is a stronger and more honest statement than "not you".
  it('names the methods that are permitted', async () => {
    const { app } = build();
    const token = await login(app);

    const res = await request(app)
      .delete('/api/audit')
      .set('Authorization', `Bearer ${token}`);

    expect(res.headers.allow).toBe('GET, HEAD, OPTIONS');
  });

  // Preflight is not a mutation; answering it 405 would break a browser
  // client that only ever intended to read.
  it('answers OPTIONS with 204 and the Allow header', async () => {
    const { app } = build();
    const token = await login(app);

    const res = await request(app)
      .options('/api/audit')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(res.headers.allow).toBe(ALLOWED_METHODS);
  });

  it('still requires authentication before refusing the method', async () => {
    const { app } = build();
    const res = await request(app).delete('/api/audit');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/audit', () => {
  it('returns the caller\'s entries, newest first', async () => {
    const { app } = build();
    const token = await login(app);
    await request(app)
      .post('/api/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Bank', encryptedPassword: 'AES256:x' });

    const res = await request(app).get('/api/audit').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.entries.map((e) => e.action)).toEqual([
      ACTIONS.CREDENTIAL_ADDED,
      ACTIONS.LOGIN_SUCCEEDED,
    ]);
  });

  it('serialises the five fields of the model', async () => {
    const { app } = build();
    const token = await login(app);

    const res = await request(app).get('/api/audit').set('Authorization', `Bearer ${token}`);

    expect(Object.keys(res.body.entries[0]).sort()).toEqual([
      'action',
      'entryId',
      'ipAddress',
      'timestamp',
      'userId',
    ]);
  });

  // Business rule 6: a user reads their own log or nobody's.
  it("never returns another user's entries", async () => {
    const { app } = build();
    await login(app);
    const otherToken = await login(app, 'other@example.com');

    const res = await request(app).get('/api/audit').set('Authorization', `Bearer ${otherToken}`);

    expect(res.body.entries.every((e) => e.userId === 'user-99')).toBe(true);
  });

  it("answers 404 for another user's entry rather than revealing it exists", async () => {
    const { app, db } = build();
    await login(app);
    const otherToken = await login(app, 'other@example.com');
    const [ownersEntry] = db.entriesFor('user-42');

    const res = await request(app)
      .get(`/api/audit/${ownersEntry.entryId}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(404);
  });

  // Otherwise the log fills with the act of reading it, forever.
  it('does not audit the reading of the audit log', async () => {
    const { app, db } = build();
    const token = await login(app);

    await request(app).get('/api/audit').set('Authorization', `Bearer ${token}`);
    await request(app).get('/api/audit').set('Authorization', `Bearer ${token}`);

    expect(db.actions()).toEqual([ACTIONS.LOGIN_SUCCEEDED]);
  });

  it('requires authentication', async () => {
    const { app } = build();
    expect((await request(app).get('/api/audit')).status).toBe(401);
  });

  // restoreAuditEntry re-validates on the way out, so a row tampered with at
  // rest fails the read instead of being served as a well-formed entry.
  it('refuses to serve a row that was tampered with at rest', async () => {
    const { app, db } = build();
    const token = await login(app);

    db.auditReader.list = async () => [
      { entryId: 'e1', userId: 'user-42', action: 'credential.exfiltrated', timestamp: 0, ipAddress: null },
    ];

    const res = await request(app).get('/api/audit').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
  });
});

// The user-facing activity view.
describe('GET /api/audit pagination', () => {
  // Drives enough distinct actions to fill several pages.
  async function seedEntries(app, token, count) {
    for (let i = 0; i < count; i += 1) {
      await request(app)
        .post('/api/credentials')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: `item-${i}`, encryptedPassword: 'AES256:x' });
    }
  }

  const page = (app, token, query = '') =>
    request(app).get(`/api/audit${query}`).set('Authorization', `Bearer ${token}`);

  it('caps the page and hands back a cursor', async () => {
    const { app } = build();
    const token = await login(app);
    await seedEntries(app, token, 5); // + the login entry = 6

    const res = await page(app, token, '?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.nextCursor).toEqual(expect.any(String));
  });

  it('walks the whole log exactly once, in order, with no repeats', async () => {
    const { app } = build();
    const token = await login(app);
    await seedEntries(app, token, 5);

    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const res = await page(app, token, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...res.body.entries);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(6);
    expect(new Set(seen.map((e) => e.entryId)).size).toBe(6);
    const times = seen.map((e) => Date.parse(e.timestamp));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('reports no cursor on the final page', async () => {
    const { app } = build();
    const token = await login(app);
    const res = await page(app, token, '?limit=50');

    expect(res.body.entries).toHaveLength(1);
    expect(res.body.nextCursor).toBeNull();
  });

  // The reason this is keyset and not offset. Entries land at the head of the
  // log between page fetches; an offset window would slide and re-show rows
  // the reader already saw, or skip one entirely.
  it('does not repeat or skip a row when new entries arrive mid-walk', async () => {
    const { app } = build();
    const token = await login(app);
    await seedEntries(app, token, 3); // 4 entries total

    const first = await page(app, token, '?limit=2');
    // Three brand-new entries push into the head of the log.
    await seedEntries(app, token, 3);
    const second = await page(app, token, `?limit=2&cursor=${first.body.nextCursor}`);

    const ids = [...first.body.entries, ...second.body.entries].map((e) => e.entryId);
    expect(new Set(ids).size).toBe(4);
    // The second page continues from where the first stopped: it holds the
    // two entries that were always next, not rows shifted down by the writes.
    expect(second.body.entries).toHaveLength(2);
  });

  it('never pages into another user\'s log, whatever the cursor says', async () => {
    const { app } = build();
    const ownerToken = await login(app);
    await seedEntries(app, ownerToken, 3);
    const otherToken = await login(app, 'other@example.com');

    const owners = await page(app, ownerToken, '?limit=2');
    // The intruder replays a cursor from a position inside the owner's log.
    const res = await page(app, otherToken, `?limit=50&cursor=${owners.body.nextCursor}`);

    expect(res.status).toBe(200);
    expect(res.body.entries.every((e) => e.userId === 'user-99')).toBe(true);
  });

  it.each([
    ['a limit above the cap', '?limit=201'],
    ['a zero limit', '?limit=0'],
    ['a non-numeric limit', '?limit=all'],
    ['a malformed cursor', '?cursor=not-a-cursor'],
    ['an empty cursor', '?cursor='],
  ])('answers 400 for %s', async (_name, query) => {
    const { app } = build();
    const token = await login(app);

    const res = await page(app, token, query);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });
});
