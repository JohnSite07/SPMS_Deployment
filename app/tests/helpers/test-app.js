const { createApp } = require('../../src/app');
const { createAuditLog } = require('../../src/services/audit-log');
const { createSessionIssuer } = require('../../src/services/session-issuer');
const { createDeviceService } = require('../../src/services/device-service');
const { createFakeDatabase } = require('./fake-database');
const { testTokenService, TEST_KEY } = require('./test-token-service');

const PASSWORD = 'correct-horse-battery-staple';
const TWO_FACTOR_CODE = '123456';

const seedUser = (overrides = {}) => ({
  userId: 'user-42',
  email: 'owner@example.com',
  masterPasswordHash: `hash:${PASSWORD}`,
  twoFactorConfig: { enabled: true, method: 'TOTP', secret: 's' },
  ...overrides,
});

// session-issuer reads `user.role`, so admin-ness is a property of the user
// row and nothing else. Whoever can write that table can mint an admin — the
// consequence called out in token-service.js.
const seedAdmin = (overrides = {}) =>
  seedUser({
    userId: 'admin-1',
    email: 'admin@example.com',
    role: 'admin',
    ...overrides,
  });

// Stand-ins for bcrypt/argon2 and the external AuthenticationService. Both are
// the Developer team's to supply; the routes only care that they answer.
const verifyPassword = async (hash, password) => hash === `hash:${password}`;
const verifyTwoFactorCode = async (config, code) => code === TWO_FACTOR_CODE;

// A stand-in for services/password-hasher.js's real (bcrypt) hashPassword,
// in the same `hash:${password}` shape verifyPassword above expects. This is
// what lets a password-reset test log in with the new password afterward
// through the exact same login() helper every other test file uses: the
// fake store's updateMasterPasswordHash writes this shape, and verifyPassword
// reads it back.
const fakeHashPassword = async (password) => `hash:${password}`;

// Entries written in the same millisecond are ordered by entryId, which is a
// random uuid — a total order, but not insertion order. Tests that assert
// "newest first" must therefore write entries at distinct times, or they are
// asserting on uuid sort order and will flake. Real MySQL has the same
// property; the fix belongs in the test, not in the ordering.
function monotonicClock(startMillis = 1_700_000_000_000) {
  let now = startMillis;
  return () => {
    now += 1;
    return now;
  };
}

/**
 * Mounts the real app over the fake database. `onDeviceSeen` is a synchronous
 * no-op on purpose: issueSessionToken calls it without awaiting, so binding it
 * to the audit log would produce an unawaited promise. See the note in
 * server.js.
 */
function testApp({
  db = createFakeDatabase({ users: [seedUser()] }),
  sessions,
  clock = monotonicClock(),
} = {}) {
  const tokenService = testTokenService();
  const audit = createAuditLog({ append: db.append, clock });

  // Injected, not defaulted: createSessionIssuer would otherwise build a
  // device service that reads JWT_SIGNING_KEY from the real environment.
  const deviceService = createDeviceService({ signingKey: TEST_KEY, issuer: 'securevault' });

  const issuer = createSessionIssuer({
    tokenService,
    deviceService,
    verifyPassword,
    verifyTwoFactorCode,
    onDeviceSeen: () => {},
  });

  const app = createApp({
    tokenService,
    issuer,
    audit,
    users: db.users,
    vaults: db.vaults,
    sessions: sessions ?? db.sessions,
    credentials: db.credentials,
    passwordHealth: db.passwordHealth,
    auditReader: db.auditReader,
    hashPassword: fakeHashPassword,
  });

  return { app, db, tokenService, audit };
}

// For the middleware's own tests, which mint tokens directly rather than
// logging in: every session is live and none is revoked.
const permissiveSessions = {
  transaction: async (fn) => fn({}),
  start: async () => ({ sessionId: 'sess-7' }),
  revoke: async () => {},
  revokeAllForUser: async () => {},
  isRevoked: async () => false,
};

module.exports = {
  testApp,
  permissiveSessions,
  monotonicClock,
  seedUser,
  seedAdmin,
  verifyPassword,
  verifyTwoFactorCode,
  fakeHashPassword,
  PASSWORD,
  TWO_FACTOR_CODE,
};
