const express = require('express');
const { createAuthMiddleware } = require('./middleware/authenticate');
const { errorHandler } = require('./middleware/error-handler');
const { createCredentialRoutes } = require('./routes/credentials');
const { createSessionRoutes } = require('./routes/session');
const { createAuditRoutes } = require('./routes/audit');
const { createAdminAuditRoutes } = require('./routes/admin-audit');

// App factory, separated from server.js so tests can mount it without binding
// a port. Every collaborator is injected: this module wires ports together
// and owns no storage, no crypto, and no schema.

/**
 * @param tokenService  createTokenService() instance.
 * @param issuer        createSessionIssuer() instance. Its onDeviceSeen hook
 *                      should be bound to the same audit log passed below, so
 *                      a device sighting lands in the log the login writes to.
 * @param audit         createAuditLog() instance — the only writer.
 * @param users         user port (see routes/session.js).
 * @param sessions      session port; also supplies isRevoked() to the auth
 *                      middleware, which is what makes logout mean something.
 * @param credentials   credential port (see routes/credentials.js).
 * @param auditReader   audit read port (see routes/audit.js). Separate from
 *                      `audit` on purpose: one object can append and cannot
 *                      read, the other can read and cannot append. Neither
 *                      can update or delete, and no object in the process
 *                      holds both halves.
 */
function createApp({
  tokenService,
  issuer,
  audit,
  users,
  sessions,
  credentials,
  auditReader,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // TODO(audit): `trust proxy` is unset, so `req.ip` is the socket peer —
  // under Cloud Run that is the Google front end (locally: ::ffff:127.0.0.1),
  // never the client. Every entry services/audit-log.js writes would record
  // the same useless address.
  //
  // Do not "fix" this with `trust proxy: true`. That takes the left-most
  // X-Forwarded-For entry, which the client supplies, letting an attacker
  // choose what the audit log says about them. The correct value is the
  // number of proxies actually in front of the container, which has to be
  // confirmed against a deployed revision (log X-Forwarded-For and count the
  // hops) rather than assumed — direct *.run.app and an external HTTPS load
  // balancer do not agree.

  // Mounted before every route, not attached per-route: any route added below
  // requires a valid bearer token unless its method+path is named in the
  // middleware's public allowlist. See middleware/authenticate.js.
  app.use(createAuthMiddleware({ tokenService, sessions }));

  // Health endpoint: used by the CD pipeline's smoke test against the
  // candidate revision before traffic is shifted. Keep it dependency-free
  // (no DB call) so a cold start always answers.
  // NOTE: the path must NOT be /healthz — Google Front End reserves that
  // path on run.app domains and returns its own 404 before the request
  // reaches the container (found live in the first CD run).
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'securevault' });
  });

  app.get('/', (req, res) => {
    res.status(200).send('SecureVault deployment skeleton - application under construction.');
  });

  // POST here is public — it is the request that creates the session every
  // other route requires. DELETE here is not. See PUBLIC_PATHS.
  app.use('/api/session', createSessionRoutes({ users, sessions, issuer, audit }));
  app.use('/api/credentials', createCredentialRoutes({ store: credentials, audit }));

  // The owner's activity view: their own log, and only ever their own.
  app.use('/api/audit', createAuditRoutes({ store: auditReader }));

  // The administrator's view of any user's history. Guarded by requireRole
  // inside the router, and mounted under a distinct prefix so an owner never
  // reaches it by varying a path parameter on the route above.
  app.use(
    '/api/admin/audit',
    createAdminAuditRoutes({
      store: auditReader,
      users,
      audit,
      transaction: auditReader.transaction,
    })
  );

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
