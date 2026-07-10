const request = require('supertest');
const auditEntryModule = require('../src/models/audit-entry');
const auditLogModule = require('../src/services/audit-log');
const { createAuditEntry, restoreAuditEntry, ACTIONS, ACTION_VALUES } = auditEntryModule;
const { createAuditLog } = auditLogModule;
const { createFakeDatabase } = require('./helpers/fake-database');
const { testApp, seedUser, seedAdmin, PASSWORD, TWO_FACTOR_CODE } = require('./helpers/test-app');

// Business rule 7: the audit log is append-only. Elsewhere that rule is tested
// one surface at a time. Here it is tested as the single claim it actually
// makes — *no* code path can change an entry that already exists — by
// enumerating the paths rather than picking the ones that came to mind.
//
// Three layers, because "no code path" has three meanings:
//   1. the object      — no mutation primitive in the language moves a field
//   2. the service     — nothing in src/ exposes a writer other than append
//   3. the HTTP surface — no method, route, identity or payload changes a row

const FIXED_MILLIS = 1_700_000_000_000;
const anEntry = (overrides = {}) =>
  createAuditEntry({
    userId: 'user-42',
    action: ACTIONS.CREDENTIAL_ADDED,
    ipAddress: '203.0.113.5',
    clock: () => FIXED_MILLIS,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// 1. The object
// ---------------------------------------------------------------------------

describe('no language primitive can mutate an entry', () => {
  // Every own data property, discovered rather than listed, so a field added
  // to the model later is covered without anyone remembering to add it here.
  const FIELDS = Object.keys(anEntry()).filter((k) => k !== 'toJSON');

  it('covers every field the model actually has', () => {
    expect(FIELDS).toEqual([
      'entryId',
      'userId',
      'action',
      'ipAddress',
      'targetUserId',
      'actorUserId',
      'timestamp',
    ]);
  });

  // Reflect.* reports refusal by returning false in every mode. Bare
  // assignment throws only under strict mode, and these are sloppy-mode
  // CommonJS files — so the returned boolean, not a thrown error, is the
  // mode-independent proof that the write was refused.
  const REFUSALS = [
    ['Reflect.set', (entry, field) => Reflect.set(entry, field, 'attacker')],
    ['Reflect.deleteProperty', (entry, field) => Reflect.deleteProperty(entry, field)],
    [
      'Reflect.defineProperty',
      (entry, field) => Reflect.defineProperty(entry, field, { value: 'attacker' }),
    ],
  ];

  describe.each(REFUSALS)('%s', (_name, attempt) => {
    it.each(FIELDS)('is refused on %s, leaving the entry unchanged', (field) => {
      const entry = anEntry();
      const before = entry.toJSON();

      expect(attempt(entry, field)).toBe(false);
      expect(entry.toJSON()).toEqual(before);
    });
  });

  it.each(FIELDS)('bare assignment to %s does not take effect', (field) => {
    const entry = anEntry();
    const before = entry.toJSON();

    try {
      entry[field] = 'attacker';
      delete entry[field];
    } catch {
      // Strict-mode callers get a TypeError; sloppy-mode ones get a no-op.
    }

    expect(entry.toJSON()).toEqual(before);
  });

  it('refuses a brand-new field', () => {
    const entry = anEntry();
    expect(Reflect.set(entry, 'plaintextPassword', 'hunter2')).toBe(false);
    expect(Reflect.defineProperty(entry, 'plaintextPassword', { value: 'x' })).toBe(false);
    expect(entry.plaintextPassword).toBeUndefined();
  });

  it('refuses a prototype swap, which would shadow nothing but could add', () => {
    const entry = anEntry();
    expect(Reflect.setPrototypeOf(entry, { forged: true })).toBe(false);
    expect(() => Object.setPrototypeOf(entry, { forged: true })).toThrow(TypeError);
    expect(entry.forged).toBeUndefined();
  });

  // Object.assign uses [[Set]] with throw-on-failure, so it throws regardless
  // of the caller's strictness — the one bulk-write that cannot fail quietly.
  it('refuses Object.assign', () => {
    const entry = anEntry();
    expect(() => Object.assign(entry, { action: ACTIONS.LOGIN_SUCCEEDED })).toThrow(TypeError);
    expect(entry.action).toBe(ACTIONS.CREDENTIAL_ADDED);
  });

  it('is frozen, non-extensible, and every field is non-configurable', () => {
    const entry = anEntry();
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isExtensible(entry)).toBe(false);

    for (const field of FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, field);
      expect(descriptor.configurable).toBe(false);
      // `timestamp` is an accessor; the rest are data properties.
      expect(descriptor.writable ?? false).toBe(false);
    }
  });

  // Object.freeze does not reach a Date's internal slot. Handing out a copy
  // per read is what makes the timestamp unrewritable; the getter itself is
  // non-configurable, so it cannot be swapped for one that lies.
  it('refuses to have its timestamp rewritten, through the Date or the getter', () => {
    const entry = anEntry();

    entry.timestamp.setFullYear(1999);
    expect(Reflect.defineProperty(entry, 'timestamp', { get: () => new Date(0) })).toBe(false);

    expect(entry.timestamp).toEqual(new Date(FIXED_MILLIS));
  });

  // toJSON must hand out a copy, or a caller who serialises an entry could
  // edit the entry by editing what they got back.
  it('hands out a detached copy from toJSON', () => {
    const entry = anEntry();
    const json = entry.toJSON();

    json.action = 'credential.exfiltrated';
    json.userId = 'attacker';

    expect(entry.action).toBe(ACTIONS.CREDENTIAL_ADDED);
    expect(entry.toJSON().action).toBe(ACTIONS.CREDENTIAL_ADDED);
  });

  it('is not mutated by mutating an entry restored from it', () => {
    const original = anEntry();
    const restored = restoreAuditEntry(original.toJSON());

    try {
      restored.action = 'credential.exfiltrated';
    } catch {
      /* frozen */
    }
    expect(original.toJSON()).toEqual(restored.toJSON());
  });

  it('keeps the action vocabulary itself frozen', () => {
    expect(Object.isFrozen(ACTIONS)).toBe(true);
    expect(Object.isFrozen(ACTION_VALUES)).toBe(true);
    expect(Reflect.set(ACTIONS, 'FORGED', 'forged')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The service surface
// ---------------------------------------------------------------------------

describe('nothing in src exposes a writer other than append', () => {
  it('the model exports no mutator', () => {
    expect(Object.keys(auditEntryModule).sort()).toEqual([
      'ACTIONS',
      'ACTION_VALUES',
      'createAuditEntry',
      'restoreAuditEntry',
    ]);
  });

  it('the audit log exposes exactly three methods, none of them a mutator', () => {
    const audit = createAuditLog({ append: async () => {} });
    expect(Object.keys(audit).sort()).toEqual(['forRequest', 'forSystem', 'logAction']);
    expect(Object.keys(auditLogModule).sort()).toEqual(['ACTIONS', 'createAuditLog']);
  });

  // The store is handed the real entry, not a copy. It must not be able to
  // edit what it was told to persist.
  it('hands the store an entry it cannot mutate', async () => {
    let captured;
    const audit = createAuditLog({
      append: async (entry) => {
        captured = entry;
      },
      clock: () => FIXED_MILLIS,
    });

    await audit.logAction({
      userId: 'user-42',
      action: ACTIONS.CREDENTIAL_ADDED,
      ipAddress: '203.0.113.5',
    });

    expect(Reflect.set(captured, 'action', 'forged')).toBe(false);
    expect(Object.isFrozen(captured)).toBe(true);
  });

  // An append-only log where the writer picks the primary key is not
  // append-only: reusing an id is an overwrite in any store that upserts.
  it('will not let a caller choose an entryId, so no append can overwrite a row', async () => {
    const appended = [];
    const audit = createAuditLog({ append: async (entry) => appended.push(entry) });

    await audit.logAction({
      userId: 'user-42',
      action: ACTIONS.CREDENTIAL_ADDED,
      ipAddress: '203.0.113.5',
      entryId: 'existing-entry',
      timestamp: new Date(0),
    });

    expect(appended[0].entryId).not.toBe('existing-entry');
    expect(appended[0].timestamp).not.toEqual(new Date(0));
  });

  it('mints a distinct id on every append, so ids never collide', async () => {
    const ids = new Set();
    const audit = createAuditLog({ append: async (entry) => ids.add(entry.entryId) });

    for (let i = 0; i < 200; i += 1) {
      await audit.logAction({
        userId: 'user-42',
        action: ACTIONS.CREDENTIAL_ADDED,
        ipAddress: '203.0.113.5',
      });
    }
    expect(ids.size).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 3. The HTTP surface
// ---------------------------------------------------------------------------

describe('no request can mutate an entry that already exists', () => {
  let errorSpy;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  const login = async (app, email) => {
    const res = await request(app)
      .post('/api/session')
      .send({ email, password: PASSWORD, code: TWO_FACTOR_CODE });
    return res.body.token;
  };

  // Built through JSON.parse, not an object literal: `{ __proto__: {...} }` in
  // source sets the prototype, whereas the parsed form creates an own key
  // named "__proto__" — which is what a real attacker sends over the wire.
  const mutatingBody = (entryId) =>
    `{"entryId":${JSON.stringify(entryId)},
      "userId":"attacker",
      "action":"credential.exfiltrated",
      "timestamp":"1970-01-01T00:00:00.000Z",
      "ipAddress":"198.51.100.1",
      "targetUserId":"user-99",
      "actorUserId":"admin-1",
      "__proto__":{"action":"polluted"},
      "constructor":{"prototype":{"action":"polluted"}}}`;

  const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

  it('survives every method, on every route, as every identity', async () => {
    const db = createFakeDatabase({ users: [seedUser(), seedAdmin()] });
    const { app } = testApp({ db });

    // Seed a log with entries of several shapes, including an admin's
    // cross-user read (which is the only entry carrying associations).
    const ownerToken = await login(app, 'owner@example.com');
    const created = await request(app)
      .post('/api/credentials')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Bank', encryptedPassword: 'AES256:x' });
    const itemId = created.body.itemId;
    await request(app).get(`/api/credentials/${itemId}`).set('Authorization', `Bearer ${ownerToken}`);
    await request(app).get('/api/admin/audit/user-42').set('Authorization', `Bearer ${await login(app, 'admin@example.com')}`);

    expect(db.state.entries.length).toBeGreaterThanOrEqual(5);
    const targetEntryId = db.state.entries[0].entryId;

    const paths = [
      '/',
      '/health',
      '/api/session',
      '/api/credentials',
      `/api/credentials/${itemId}`,
      '/api/audit',
      `/api/audit/${targetEntryId}`,
      '/api/admin/audit/user-42',
      `/api/admin/audit/user-42/${targetEntryId}`,
    ];

    // The invariant, stated exactly: an entry seen before a request must
    // serialise identically after it. New entries may appear — appends are the
    // point — but nothing already written may change.
    const known = new Map(db.state.entries.map((e) => [e.entryId, JSON.stringify(e.toJSON())]));
    const checkNothingChanged = (label) => {
      for (const entry of db.state.entries) {
        const now = JSON.stringify(entry.toJSON());
        if (known.has(entry.entryId)) {
          expect({ label, json: now }).toEqual({ label, json: known.get(entry.entryId) });
        } else {
          known.set(entry.entryId, now);
        }
      }
    };

    let attempts = 0;
    for (const identity of ['anonymous', 'owner', 'admin']) {
      for (const path of paths) {
        for (const method of METHODS) {
          // Fresh token each time: DELETE /api/session revokes the one it was
          // called with, and an expired identity would stop exercising routes.
          let token = null;
          if (identity === 'owner') token = await login(app, 'owner@example.com');
          if (identity === 'admin') token = await login(app, 'admin@example.com');

          const req = request(app)[method](path).set('Content-Type', 'application/json');
          if (token) req.set('Authorization', `Bearer ${token}`);
          if (!['get', 'head', 'options'].includes(method)) req.send(mutatingBody(targetEntryId));

          const res = await req;
          expect(res.status).toBeLessThan(600);

          attempts += 1;
          checkNothingChanged(`${identity} ${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(attempts).toBe(3 * paths.length * METHODS.length);

    // The seeded entries specifically, by identity rather than by position.
    const seededStillIntact = db.state.entries.find((e) => e.entryId === targetEntryId);
    expect(seededStillIntact.userId).not.toBe('attacker');
    expect(seededStillIntact.action).not.toBe('credential.exfiltrated');

    // Nothing leaked onto Object.prototype along the way, which would have
    // given every entry a field the model never validated.
    expect({}.action).toBeUndefined();
    expect({}.entryId).toBeUndefined();
    expect(Object.prototype.action).toBeUndefined();
  }, 60_000);

  // The only writer is `append`, and it is only ever called with a fresh
  // entry. If a route could re-append an existing id, a store that upserts
  // would silently overwrite the row.
  it('never appends an entryId that already exists', async () => {
    const db = createFakeDatabase({ users: [seedUser(), seedAdmin()] });
    const { app } = testApp({ db });

    const token = await login(app, 'owner@example.com');
    const created = await request(app)
      .post('/api/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Bank', encryptedPassword: 'AES256:x' });
    await request(app)
      .patch(`/api/credentials/${created.body.itemId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Renamed' });
    await request(app)
      .delete(`/api/credentials/${created.body.itemId}`)
      .set('Authorization', `Bearer ${token}`);
    await request(app).delete('/api/session').set('Authorization', `Bearer ${token}`);

    const appendedIds = db.append.mock.calls.map(([entry]) => entry.entryId);
    expect(new Set(appendedIds).size).toBe(appendedIds.length);
  });
});
