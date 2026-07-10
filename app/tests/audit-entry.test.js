const {
  createAuditEntry,
  restoreAuditEntry,
  ACTIONS,
  ACTION_VALUES,
} = require('../src/models/audit-entry');

const FIXED_MILLIS = 1_700_000_000_000;
const fixedClock = () => FIXED_MILLIS;

function newEntry(overrides = {}) {
  return createAuditEntry({
    userId: 'user-42',
    action: ACTIONS.CREDENTIAL_ADDED,
    ipAddress: '203.0.113.5',
    clock: fixedClock,
    ...overrides,
  });
}

describe('createAuditEntry', () => {
  it('records the five fields of the domain model', () => {
    const entry = newEntry();

    expect(entry.entryId).toEqual(expect.any(String));
    expect(entry.userId).toBe('user-42');
    expect(entry.action).toBe(ACTIONS.CREDENTIAL_ADDED);
    expect(entry.timestamp).toEqual(new Date(FIXED_MILLIS));
    expect(entry.ipAddress).toBe('203.0.113.5');
  });

  it('mints a distinct id per entry, even for identical actions', () => {
    expect(newEntry().entryId).not.toBe(newEntry().entryId);
  });

  it('stamps the time from the injected clock, not the caller', () => {
    const entry = createAuditEntry({
      userId: 'user-42',
      action: ACTIONS.LOGIN_SUCCEEDED,
      ipAddress: '203.0.113.5',
      clock: fixedClock,
      // A caller trying to backdate the action past the breach it caused.
      entryId: 'chosen-id',
      timestamp: new Date(0),
    });

    expect(entry.entryId).not.toBe('chosen-id');
    expect(entry.timestamp).toEqual(new Date(FIXED_MILLIS));
  });

  it('coerces a numeric userId to a string', () => {
    expect(newEntry({ userId: 42 }).userId).toBe('42');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['an object', { userId: 'user-42' }],
  ])('rejects %s as a userId', (_name, userId) => {
    expect(() => newEntry({ userId })).toThrow(TypeError);
  });

  it.each([
    ['an unknown action', 'credential.exfiltrated'],
    ['a use-case name rather than a value', 'CREDENTIAL_ADDED'],
    ['undefined', undefined],
    ['a number', 7],
  ])('rejects %s', (_name, action) => {
    expect(() => newEntry({ action })).toThrow(TypeError);
  });

  it('accepts every ordinary action in the vocabulary', () => {
    for (const action of ACTION_VALUES.filter((a) => a !== ACTIONS.AUDIT_LOG_READ)) {
      expect(() => newEntry({ action })).not.toThrow();
    }
  });
});

// An admin's read of a user's history is recorded twice: once in the admin's
// log (targetUserId — whose history) and once in the user's (actorUserId —
// who read it). Which field is set says which copy this is.
describe('audit_log.read associations', () => {
  const read = (associates) => newEntry({ action: ACTIONS.AUDIT_LOG_READ, ...associates });

  it("records the admin's copy, naming whose history was read", () => {
    const entry = read({ targetUserId: 'user-99' });
    expect(entry.targetUserId).toBe('user-99');
    expect(entry.actorUserId).toBeNull();
  });

  it("records the read user's copy, naming who read it", () => {
    const entry = read({ actorUserId: 'admin-1' });
    expect(entry.actorUserId).toBe('admin-1');
    expect(entry.targetUserId).toBeNull();
  });

  it('coerces a numeric association to a string', () => {
    expect(read({ targetUserId: 7 }).targetUserId).toBe('7');
  });

  // Neither: a record that some history was read, by someone, of someone.
  // Both: an entry claiming to live in two logs at once.
  it.each([
    ['neither association', {}],
    ['both associations', { targetUserId: 'user-99', actorUserId: 'admin-1' }],
    ['an empty targetUserId', { targetUserId: '' }],
    ['an object as an association', { actorUserId: {} }],
  ])('rejects %s', (_name, associates) => {
    expect(() => read(associates)).toThrow(TypeError);
  });

  // An association riding along on an unrelated action would be validated by
  // nothing and read by nobody.
  it.each([
    ['targetUserId', { targetUserId: 'user-99' }],
    ['actorUserId', { actorUserId: 'admin-1' }],
  ])('rejects %s on an ordinary action', (_name, associates) => {
    expect(() => newEntry({ action: ACTIONS.LOGIN_SUCCEEDED, ...associates })).toThrow(TypeError);
  });

  it('omits both fields from toJSON on an ordinary action', () => {
    expect(Object.keys(newEntry({ action: ACTIONS.LOGIN_SUCCEEDED }).toJSON())).toEqual([
      'entryId',
      'userId',
      'action',
      'timestamp',
      'ipAddress',
    ]);
  });

  it('serialises only the association that is set', () => {
    expect(read({ targetUserId: 'user-99' }).toJSON()).toMatchObject({ targetUserId: 'user-99' });
    expect(read({ targetUserId: 'user-99' }).toJSON().actorUserId).toBeUndefined();
  });

  it('round-trips through restoreAuditEntry', () => {
    const original = read({ actorUserId: 'admin-1' });
    expect(restoreAuditEntry(original.toJSON()).toJSON()).toEqual(original.toJSON());
  });

  it('refuses to restore a persisted row carrying both associations', () => {
    expect(() =>
      restoreAuditEntry({
        entryId: 'entry-1',
        userId: 'user-42',
        action: ACTIONS.AUDIT_LOG_READ,
        timestamp: new Date(FIXED_MILLIS),
        ipAddress: '203.0.113.5',
        targetUserId: 'user-99',
        actorUserId: 'admin-1',
      })
    ).toThrow(TypeError);
  });
});

describe('ipAddress', () => {
  it('accepts IPv4 and IPv6', () => {
    expect(newEntry({ ipAddress: '203.0.113.5' }).ipAddress).toBe('203.0.113.5');
    expect(newEntry({ ipAddress: '2001:db8::1' }).ipAddress).toBe('2001:db8::1');
  });

  // Cloud Run hands Express IPv4 peers in mapped form. Both spellings must
  // land in the log as one address, or per-IP queries miss half the rows.
  it('unwraps an IPv4-mapped IPv6 address to its IPv4 form', () => {
    expect(newEntry({ ipAddress: '::ffff:203.0.113.5' }).ipAddress).toBe('203.0.113.5');
    expect(newEntry({ ipAddress: '::FFFF:203.0.113.5' }).ipAddress).toBe('203.0.113.5');
  });

  it('leaves a mapped address that is not IPv4 as an IPv6 address', () => {
    expect(newEntry({ ipAddress: '::ffff:0:1' }).ipAddress).toBe('::ffff:0:1');
  });

  it('lower-cases IPv6 so one host groups under one spelling', () => {
    expect(newEntry({ ipAddress: '2001:DB8::1' }).ipAddress).toBe('2001:db8::1');
  });

  // Timer-driven actions (the 10-minute auto-lock, scheduled scans) have no
  // request behind them.
  it('accepts an explicit null for a system-originated action', () => {
    const entry = newEntry({ action: ACTIONS.VAULT_LOCKED, ipAddress: null });
    expect(entry.ipAddress).toBeNull();
  });

  // The distinction that matters: null is a statement, undefined is a bug.
  it('rejects a missing ipAddress rather than treating it as null', () => {
    expect(() => createAuditEntry({ userId: 'user-42', action: ACTIONS.VAULT_LOCKED })).toThrow(
      TypeError
    );
  });

  it('rejects createAuditEntry called with no arguments at all', () => {
    expect(() => createAuditEntry()).toThrow(TypeError);
  });

  it.each([
    ['a hostname', 'vault.example.com'],
    ['an empty string', ''],
    ['a number', 3232235777],
    ['an octet out of range', '203.0.113.256'],
    ['a trailing space', '203.0.113.5 '],
    ['an address with a port', '203.0.113.5:443'],
    ['a CIDR range', '203.0.113.0/24'],
    ['garbage', 'not-an-ip'],
  ])('rejects %s', (_name, ipAddress) => {
    expect(() => newEntry({ ipAddress })).toThrow(TypeError);
  });
});

// Business rule 7. The entry is the last line of defence: whatever the access
// layer allows, a written entry cannot be altered by a holder of the object.
describe('append-only immutability', () => {
  // Asserted as "the value did not change", not as "the write threw". A
  // frozen object only throws on write under strict mode; these files are
  // sloppy-mode CommonJS, where the same write is a silent no-op. The entry
  // being unaltered is the property that holds either way, and it is the one
  // business rule 7 actually asks for.
  it('does not let a caller overwrite or delete any field', () => {
    const entry = newEntry();
    const before = entry.toJSON();

    try {
      entry.action = ACTIONS.LOGIN_SUCCEEDED;
      entry.entryId = 'rewritten';
      entry.ipAddress = '198.51.100.1';
      entry.userId = 'user-99';
      delete entry.userId;
    } catch {
      // Strict-mode callers get a TypeError; sloppy-mode ones get a no-op.
    }

    expect(entry.toJSON()).toEqual(before);
  });

  it('does not let a caller add a field that was never in the model', () => {
    const entry = newEntry();

    try {
      entry.plaintextPassword = 'hunter2';
    } catch {
      // As above.
    }

    expect(entry.plaintextPassword).toBeUndefined();
    expect(Object.keys(entry.toJSON())).toEqual([
      'entryId',
      'userId',
      'action',
      'timestamp',
      'ipAddress',
    ]);
  });

  // Object.freeze does NOT protect a Date: its value lives in an internal
  // slot, so `setFullYear` on a frozen Date mutates it happily. Handing out a
  // copy per read is what actually makes the timestamp unrewritable.
  it('does not let a caller mutate the timestamp through the Date it returns', () => {
    const entry = newEntry();

    entry.timestamp.setFullYear(1999);

    expect(entry.timestamp).toEqual(new Date(FIXED_MILLIS));
  });

  it('returns a fresh Date on each read', () => {
    const entry = newEntry();
    expect(entry.timestamp).not.toBe(entry.timestamp);
    expect(entry.timestamp).toEqual(entry.timestamp);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(newEntry())).toBe(true);
  });
});

describe('toJSON', () => {
  it('serialises the five fields with an ISO-8601 UTC timestamp', () => {
    expect(newEntry().toJSON()).toEqual({
      entryId: expect.any(String),
      userId: 'user-42',
      action: 'credential.added',
      timestamp: new Date(FIXED_MILLIS).toISOString(),
      ipAddress: '203.0.113.5',
    });
  });

  it('carries a null ipAddress through as null', () => {
    expect(newEntry({ ipAddress: null }).toJSON().ipAddress).toBeNull();
  });

  it('is what JSON.stringify emits', () => {
    const entry = newEntry();
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry.toJSON());
  });
});

describe('restoreAuditEntry', () => {
  it('round-trips an entry through its serialised form', () => {
    const original = newEntry();
    const restored = restoreAuditEntry(original.toJSON());

    expect(restored.toJSON()).toEqual(original.toJSON());
    expect(restored.timestamp).toEqual(original.timestamp);
  });

  it('preserves the persisted id and timestamp rather than minting new ones', () => {
    const restored = restoreAuditEntry({
      entryId: 'entry-1',
      userId: 'user-42',
      action: ACTIONS.LOGIN_SUCCEEDED,
      timestamp: new Date(FIXED_MILLIS),
      ipAddress: '203.0.113.5',
    });

    expect(restored.entryId).toBe('entry-1');
    expect(restored.timestamp).toEqual(new Date(FIXED_MILLIS));
  });

  it('accepts a Date, epoch milliseconds, or an ISO string', () => {
    const iso = new Date(FIXED_MILLIS).toISOString();

    for (const timestamp of [new Date(FIXED_MILLIS), FIXED_MILLIS, iso]) {
      const restored = restoreAuditEntry({
        entryId: 'entry-1',
        userId: 'user-42',
        action: ACTIONS.LOGIN_SUCCEEDED,
        timestamp,
        ipAddress: '203.0.113.5',
      });
      expect(restored.timestamp).toEqual(new Date(FIXED_MILLIS));
    }
  });

  // A row that lost its timestamp must not rehydrate as a plausible 1970
  // entry: `new Date(null)` is the epoch and `new Date(true)` is 1ms past it.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['true', true],
    ['an unparseable string', 'yesterday'],
    ['an invalid Date', new Date('nonsense')],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('rejects %s as a timestamp instead of defaulting to the epoch', (_name, timestamp) => {
    expect(() =>
      restoreAuditEntry({
        entryId: 'entry-1',
        userId: 'user-42',
        action: ACTIONS.LOGIN_SUCCEEDED,
        timestamp,
        ipAddress: '203.0.113.5',
      })
    ).toThrow(TypeError);
  });

  // Validating on the way out, not just on the way in: a row tampered with at
  // rest must not rehydrate into a well-formed entry.
  it.each([
    ['a missing entryId', { entryId: undefined }],
    ['an empty entryId', { entryId: '' }],
    ['an unknown action', { action: 'credential.exfiltrated' }],
    ['a missing userId', { userId: null }],
    ['a malformed ipAddress', { ipAddress: 'not-an-ip' }],
    ['a missing ipAddress', { ipAddress: undefined }],
  ])('rejects a persisted row with %s', (_name, overrides) => {
    expect(() =>
      restoreAuditEntry({
        entryId: 'entry-1',
        userId: 'user-42',
        action: ACTIONS.LOGIN_SUCCEEDED,
        timestamp: new Date(FIXED_MILLIS),
        ipAddress: '203.0.113.5',
        ...overrides,
      })
    ).toThrow(TypeError);
  });

  it('rejects restoreAuditEntry called with no arguments at all', () => {
    expect(() => restoreAuditEntry()).toThrow(TypeError);
  });

  it('returns an entry as immutable as a freshly minted one', () => {
    const restored = restoreAuditEntry(newEntry().toJSON());

    expect(Object.isFrozen(restored)).toBe(true);
    restored.timestamp.setFullYear(1999);
    expect(restored.timestamp).toEqual(new Date(FIXED_MILLIS));
  });
});
