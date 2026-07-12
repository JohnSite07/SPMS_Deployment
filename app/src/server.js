const { createApp } = require('./app');
const { loadJwtConfig } = require('./config/env');
const { loadDbConfig } = require('./db/pool');
const { createUsersPort } = require('./ports/users');
const { createSessionsPort } = require('./ports/sessions');
const { createCredentialsPort } = require('./ports/credentials');
const { createAuditReaderPort, createAuditAppend } = require('./ports/audit-reader');
const { verifyPassword } = require('./services/password-hasher');
const { verifyTwoFactorCode } = require('./services/two-factor-verifier');
const { createAuditLog, ACTIONS } = require('./services/audit-log');
const { createSessionIssuer } = require('./services/session-issuer');

// Cloud Run injects PORT; 8080 is its conventional default and works locally.
const port = Number(process.env.PORT) || 8080;

// Validate the env contract before binding the port. A revision missing its
// secrets should fail its startup probe and never receive traffic, rather
// than serve /health happily and 500 on the first login. Both the JWT
// signing key and the DB connection config are load-bearing for every
// authenticated route, so both are checked here, eagerly, before `listen()`.
try {
  loadJwtConfig();
  loadDbConfig();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`startup aborted: ${err.message}`);
  process.exit(1);
}

const users = createUsersPort();
const sessions = createSessionsPort();
const credentials = createCredentialsPort();
const auditReader = createAuditReaderPort();

// Separate from `auditReader` on purpose (see app.js's own comment on this):
// one object can append and cannot read, the other can read and cannot
// append.
const audit = createAuditLog({ append: createAuditAppend() });

// Bound to the same audit log every route writes through, and now safe to
// await: issueSessionToken() is async (see services/session-issuer.js), so a
// failed device-sighting write rejects the login's own promise chain instead
// of becoming an unawaited, fire-and-forget rejection. A new device is
// recorded as `device.unrecognized`, a known one as `device.recognized` —
// UC-01's post-condition is "login logged", and business rule 4 is "tell the
// user about a new device", so both outcomes are worth a row.
const issuer = createSessionIssuer({
  verifyPassword,
  verifyTwoFactorCode,
  onDeviceSeen: ({ userId, known }) =>
    audit.logAction({
      userId,
      action: known ? ACTIONS.DEVICE_RECOGNIZED : ACTIONS.DEVICE_UNRECOGNIZED,
      // No request object reaches this callback (session-issuer.js only
      // knows userId/deviceId/known/sessionId) and no transaction context is
      // threaded through it either: the device sighting is a courtesy
      // best-effort record alongside the login, not a write the login's own
      // atomicity depends on the way login.succeeded is. ipAddress is
      // therefore null, same as any action with no request behind it.
      ipAddress: null,
    }),
});

createApp({ users, sessions, credentials, auditReader, audit, issuer }).listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`securevault listening on ${port}`);
});
