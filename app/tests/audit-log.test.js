const { createAuditLog, ACTIONS } = require('../src/services/audit-log');

const FIXED_MILLIS = 1_700_000_000_000;
const fixedClock = () => FIXED_MILLIS;

// A stand-in for the persistence layer: records what it was handed, and can
// be told to fail the way a dropped Cloud SQL connection would.
function fakeStore({ failWith } = {}) {
  const appended = [];
  const append = jest.fn(async (entry) => {
    if (failWith) {
      throw failWith;
    }
    appended.push(entry);
  });
  return { append, appended };
}

function auditLog(store = fakeStore()) {
  return { audit: createAuditLog({ append: store.append, clock: fixedClock }), store };
}

describe('createAuditLog', () => {
  it('requires an append function', () => {
    expect(() => createAuditLog()).toThrow(TypeError);
    expect(() => createAuditLog({})).toThrow(TypeError);
    expect(() => createAuditLog({ append: 'not-a-function' })).toThrow(TypeError);
  });

  // The surface is the guarantee: no update, no delete, no bulk write.
  it('exposes no way to alter or remove an entry', () => {
    const { audit } = auditLog();
    expect(Object.keys(audit).sort()).toEqual(['forRequest', 'forSystem', 'logAction']);
  });
});

describe('logAction', () => {
  it('appends exactly one entry carrying the five fields', async () => {
    const { audit, store } = auditLog();

    const entry = await audit.logAction({
      userId: 'user-42',
      action: ACTIONS.CREDENTIAL_ADDED,
      ipAddress: '203.0.113.5',
    });

    expect(store.append).toHaveBeenCalledTimes(1);
    expect(store.appended).toEqual([entry]);
    expect(entry.toJSON()).toEqual({
      entryId: expect.any(String),
      userId: 'user-42',
      action: 'credential.added',
      timestamp: new Date(FIXED_MILLIS).toISOString(),
      ipAddress: '203.0.113.5',
    });
  });

  it('resolves with the entry so a caller can assert on what was written', async () => {
    const { audit } = auditLog();
    const entry = await audit.logAction({
      userId: 'user-42',
      action: ACTIONS.LOGIN_SUCCEEDED,
      ipAddress: '203.0.113.5',
    });

    expect(Object.isFrozen(entry)).toBe(true);
  });

  it('hands the store an entry it cannot mutate', async () => {
    const store = fakeStore();
    const { audit } = auditLog(store);

    await audit.logAction({
      userId: 'user-42',
      action: ACTIONS.LOGIN_SUCCEEDED,
      ipAddress: '203.0.113.5',
    });

    const [entry] = store.appended;
    entry.timestamp.setFullYear(1999);
    expect(entry.timestamp).toEqual(new Date(FIXED_MILLIS));
  });

  // The whole point of the module. An append failure must reach the caller,
  // so the action it describes is not reported as having happened.
  it('propagates an append failure instead of swallowing it', async () => {
    const failWith = new Error('cloud sql connection lost');
    const { audit } = auditLog(fakeStore({ failWith }));

    await expect(
      audit.logAction({
        userId: 'user-42',
        action: ACTIONS.CREDENTIAL_ADDED,
        ipAddress: '203.0.113.5',
      })
    ).rejects.toThrow('cloud sql connection lost');
  });

  it('does not retry a failed append', async () => {
    const store = fakeStore({ failWith: new Error('cloud sql connection lost') });
    const { audit } = auditLog(store);

    await expect(
      audit.logAction({
        userId: 'user-42',
        action: ACTIONS.LOGIN_SUCCEEDED,
        ipAddress: '203.0.113.5',
      })
    ).rejects.toThrow();

    expect(store.append).toHaveBeenCalledTimes(1);
  });

  // Validation is pure; storage is not. A malformed action must never open a
  // transaction, whatever the store would have done with it.
  it.each([
    ['an unknown action', { action: 'credential.exfiltrated' }],
    ['a missing action', { action: undefined }],
    ['a missing userId', { userId: undefined }],
    ['an empty userId', { userId: '' }],
    ['a malformed ipAddress', { ipAddress: 'not-an-ip' }],
    ['a missing ipAddress', { ipAddress: undefined }],
  ])('rejects %s without touching the store', async (_name, overrides) => {
    const store = fakeStore();
    const { audit } = auditLog(store);

    await expect(
      audit.logAction({
        userId: 'user-42',
        action: ACTIONS.CREDENTIAL_ADDED,
        ipAddress: '203.0.113.5',
        ...overrides,
      })
    ).rejects.toThrow(TypeError);

    expect(store.append).not.toHaveBeenCalled();
  });

  it('rejects logAction called with no arguments at all', async () => {
    const { audit } = auditLog();
    await expect(audit.logAction()).rejects.toThrow(TypeError);
  });

  it('lets the caller choose a null address for an action with no request', async () => {
    const { audit } = auditLog();
    const entry = await audit.logAction({
      userId: 'user-42',
      action: ACTIONS.VAULT_LOCKED,
      ipAddress: null,
    });

    expect(entry.ipAddress).toBeNull();
  });
});

describe('forRequest', () => {
  const req = (overrides = {}) => ({
    ip: '203.0.113.5',
    auth: Object.freeze({ userId: 'user-42', role: 'owner' }),
    ...overrides,
  });

  it('binds the authenticated identity and the source address', async () => {
    const { audit } = auditLog();

    const entry = await audit.forRequest(req()).logAction({ action: ACTIONS.CREDENTIAL_RETRIEVED });

    expect(entry.userId).toBe('user-42');
    expect(entry.ipAddress).toBe('203.0.113.5');
    expect(entry.action).toBe(ACTIONS.CREDENTIAL_RETRIEVED);
  });

  // Express hands us IPv4 peers in mapped form behind a proxy; the entry
  // model unwraps it so one host does not appear under two spellings.
  it('normalises an IPv4-mapped address supplied by Express', async () => {
    const { audit } = auditLog();
    const entry = await audit
      .forRequest(req({ ip: '::ffff:203.0.113.5' }))
      .logAction({ action: ACTIONS.LOGIN_SUCCEEDED });

    expect(entry.ipAddress).toBe('203.0.113.5');
  });

  // A failed login has an action to record and no req.auth to read it from.
  it('lets an unauthenticated caller name the user explicitly', async () => {
    const { audit } = auditLog();

    const entry = await audit
      .forRequest(req({ auth: undefined }))
      .logAction({ userId: 'user-42', action: ACTIONS.LOGIN_FAILED });

    expect(entry.userId).toBe('user-42');
    expect(entry.ipAddress).toBe('203.0.113.5');
  });

  it('rejects when there is no identity to attribute the action to', async () => {
    const { audit } = auditLog();

    await expect(
      audit.forRequest(req({ auth: undefined })).logAction({ action: ACTIONS.LOGIN_FAILED })
    ).rejects.toThrow(TypeError);
  });

  // A route must not be able to attribute its action to someone else.
  it('ignores an address the route tries to supply', async () => {
    const { audit } = auditLog();

    const entry = await audit
      .forRequest(req())
      .logAction({ action: ACTIONS.CREDENTIAL_ADDED, ipAddress: '198.51.100.1' });

    expect(entry.ipAddress).toBe('203.0.113.5');
  });

  // Better a rejected write than an entry that silently claims the action
  // came from nowhere. `forSystem()` is how a caller says "no request".
  it('rejects rather than inventing a null address when req.ip is absent', async () => {
    const { audit } = auditLog();

    await expect(
      audit.forRequest(req({ ip: undefined })).logAction({ action: ACTIONS.CREDENTIAL_ADDED })
    ).rejects.toThrow(TypeError);
  });

  it('propagates an append failure to the route', async () => {
    const { audit } = auditLog(fakeStore({ failWith: new Error('cloud sql connection lost') }));

    await expect(
      audit.forRequest(req()).logAction({ action: ACTIONS.CREDENTIAL_ADDED })
    ).rejects.toThrow('cloud sql connection lost');
  });
});

describe('forSystem', () => {
  it('records a timer-driven action with an explicit null address', async () => {
    const { audit, store } = auditLog();

    const entry = await audit.forSystem().logAction({
      userId: 'user-42',
      action: ACTIONS.VAULT_LOCKED,
    });

    expect(entry.ipAddress).toBeNull();
    expect(entry.action).toBe(ACTIONS.VAULT_LOCKED);
    expect(store.appended).toEqual([entry]);
  });

  it('still requires a user to attribute the action to', async () => {
    const { audit } = auditLog();
    await expect(audit.forSystem().logAction({ action: ACTIONS.VAULT_LOCKED })).rejects.toThrow(
      TypeError
    );
  });
});

// The trap documented at the top of audit-log.js, pinned as a test so nobody
// "fixes" logAction into swallowing failures to make the crash go away.
describe('an un-awaited logAction', () => {
  it('rejects, rather than resolving quietly, when the store fails', async () => {
    const { audit } = auditLog(fakeStore({ failWith: new Error('cloud sql connection lost') }));

    const promise = audit.logAction({
      userId: 'user-42',
      action: ACTIONS.CREDENTIAL_ADDED,
      ipAddress: '203.0.113.5',
    });

    // A route that forgets to await gets an unhandledRejection, which tears
    // the container down *after* it has already answered 200 — the entry is
    // missing and the client was told it succeeded. Awaiting turns that into
    // a 500 with no entry, which is the honest outcome.
    await expect(promise).rejects.toThrow('cloud sql connection lost');
  });
});
