const { createApp } = require('./app');
const { loadJwtConfig } = require('./config/env');
const { createUnimplementedPorts } = require('./config/unimplemented-ports');
const { createAuditLog } = require('./services/audit-log');
const { createSessionIssuer } = require('./services/session-issuer');

// Cloud Run injects PORT; 8080 is its conventional default and works locally.
const port = Number(process.env.PORT) || 8080;

// Validate the env contract before binding the port. A revision missing its
// secrets should fail its startup probe and never receive traffic, rather
// than serve /health happily and 500 on the first login.
try {
  loadJwtConfig();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`startup aborted: ${err.message}`);
  process.exit(1);
}

// Storage is not wired yet, so every port throws on use. /health and / are
// public and touch none of them; every other route answers 500 rather than
// pretending. See config/unimplemented-ports.js.
const ports = createUnimplementedPorts();

// `append` throws, so nothing can be logged, so nothing that must be logged
// can succeed. That is the intended posture for a skeleton, not a bug.
const audit = createAuditLog({
  append: () => {
    throw new Error('audit append is not implemented: no storage layer is wired yet');
  },
});

// NOTE: onDeviceSeen is called *synchronously* by issueSessionToken and its
// return value is discarded. Do not bind it directly to audit.logAction: the
// returned promise would never be awaited, so a failed sighting write would
// let the login succeed and then surface as an unhandledRejection — the exact
// outcome session-issuer.js's own comment says must not happen. Recording a
// device sighting properly needs issueSessionToken to become async.
const issuer = createSessionIssuer({
  verifyPassword: () => {
    throw new Error('verifyPassword is not implemented');
  },
  verifyTwoFactorCode: () => {
    throw new Error('verifyTwoFactorCode is not implemented');
  },
  onDeviceSeen: () => {
    throw new Error('onDeviceSeen is not implemented');
  },
});

createApp({ ...ports, audit, issuer }).listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`securevault listening on ${port}`);
});
