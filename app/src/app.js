const path = require('path');
const fs = require('fs');
const express = require('express');
const { createAuthMiddleware } = require('./middleware/authenticate');
const { errorHandler } = require('./middleware/error-handler');
const { createCredentialRoutes } = require('./routes/credentials');
const { createSessionRoutes } = require('./routes/session');
const { createAuditRoutes } = require('./routes/audit');
const { createAdminAuditRoutes } = require('./routes/admin-audit');
const { createPasswordResetRoutes } = require('./routes/password-reset');
const { createTwoFactorRoutes } = require('./routes/two-factor');

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
 * @param resetTokens   the password-reset-store port (see routes/
 *                      password-reset.js) — hash-only, single-use tokens.
 * @param email         a createEmailService() instance — the reset link's
 *                      only delivery path. Optional: null/absent when SMTP
 *                      is not yet provisioned (server.js's own non-fatal
 *                      catch around loadPasswordResetConfig()), in which case
 *                      routes/password-reset.js mounts its "disabled mode"
 *                      (both endpoints answer 503) instead of throwing.
 * @param hashPassword  services/password-hasher.js's hashPassword, used to
 *                      turn a reset's newPassword into a stored hash.
 * @param appBaseUrl    base URL the password-reset link is built against.
 *                      Optional for the same reason as `email` above.
 * @param resetTokenTtlMinutes  reset-token lifetime; defaults to routes/
 *                      password-reset.js's own default (30) when omitted.
 * @param clock         injectable, () => Date.now() — used ONLY for the
 *                      password-reset routes' expiry math, not for `audit`
 *                      (whose clock, if any, is already baked into the
 *                      `audit` instance passed in above). Real deployments
 *                      never override this: ports/password-reset-store.js's
 *                      consume() compares a stored expires_at against
 *                      MySQL's own NOW() (real wall-clock time), so an
 *                      offset fake clock here would desync from the DB and
 *                      make every token look expired (or never expire). Only
 *                      tests should pass one.
 */
function createApp({
  tokenService,
  issuer,
  audit,
  users,
  sessions,
  credentials,
  auditReader,
  resetTokens,
  email,
  hashPassword,
  appBaseUrl,
  resetTokenTtlMinutes,
  clock,
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

  // Health endpoint: used by the CD pipeline's smoke test against the
  // candidate revision before traffic is shifted. Keep it dependency-free
  // (no DB call) so a cold start always answers. Registered ahead of the SPA
  // fallback below so that catch-all can never shadow it.
  // NOTE: the path must NOT be /healthz — Google Front End reserves that
  // path on run.app domains and returns its own 404 before the request
  // reaches the container (found live in the first CD run).
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'securevault' });
  });

  // --- Frontend (Option A, ADR 0009): serve the built React SPA ------------
  // Mounted BEFORE the auth middleware on purpose: the app shell and its
  // hashed assets are public (they hold no secrets — vault data is fetched
  // over /api with a bearer token, and stays encrypted at rest), and a
  // browser reload/deep-link on a client-side route (/credentials, …) must
  // return index.html rather than be caught by default-deny auth and 401.
  //
  // Conditional on the build being present: in tests and backend-only dev the
  // dist folder is absent, so nothing here mounts and the auth posture below
  // is exactly as before. In the container the multi-stage Dockerfile copies
  // the build to ../client/dist (relative to this file); CLIENT_DIST_PATH can
  // override the location for local end-to-end checks.
  const clientDist = process.env.CLIENT_DIST_PATH || path.join(__dirname, '..', 'client', 'dist');
  if (fs.existsSync(path.join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist));
    // SPA fallback: a GET that isn't under /api and matched no static file
    // gets the app shell. /api is excluded so API 404s stay JSON (not a 200
    // HTML page) and no data route is ever answered by this public handler.
    // The match is anchored and case-insensitive to mirror Express's own
    // case-insensitive routing: `/API/credentials` reaches the real
    // (auth-protected) router, so the fallback must not answer it either, and
    // bare `/api` is excluded too.
    const API_PREFIX = /^\/api(\/|$)/i;
    app.use((req, res, next) => {
      if (req.method !== 'GET' || API_PREFIX.test(req.path)) {
        return next();
      }
      return res.sendFile(path.join(clientDist, 'index.html'));
    });
  }
  // -------------------------------------------------------------------------

  // Mounted before every route below, not attached per-route: any /api route
  // added below requires a valid bearer token unless its method+path is named
  // in the middleware's public allowlist. See middleware/authenticate.js.
  // (Static assets and the SPA shell were already served above, ahead of this,
  // so they never reach default-deny.)
  app.use(createAuthMiddleware({ tokenService, sessions }));

  // POST here is public — it is the request that creates the session every
  // other route requires. DELETE here is not. See PUBLIC_PATHS.
  app.use('/api/session', createSessionRoutes({ users, sessions, issuer, audit }));

  // Both routes here are public too (PUBLIC_PATHS), for the same reason
  // POST /api/session is: a user with no second factor configured yet holds
  // no session token either, so enrollment has to be reachable before one
  // exists. PRD 0017.
  app.use('/api/2fa', createTwoFactorRoutes({ users, issuer, audit, sessions }));

  app.use('/api/credentials', createCredentialRoutes({ store: credentials, audit }));

  // Both routes here are public too (PUBLIC_PATHS): a forgotten master
  // password is by definition a request made with no session. Re-hash only —
  // see routes/password-reset.js's header comment. `email`/`appBaseUrl` may
  // both be absent (SMTP not yet provisioned) — the factory below then
  // mounts its own "disabled mode" (503 on both routes) rather than
  // throwing, so this app still boots and every other route above and below
  // still serves.
  app.use(
    '/api/password-reset',
    createPasswordResetRoutes({
      users,
      resetTokens,
      sessions,
      audit,
      email,
      hashPassword,
      appBaseUrl,
      ttlMinutes: resetTokenTtlMinutes,
      clock,
    })
  );

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
