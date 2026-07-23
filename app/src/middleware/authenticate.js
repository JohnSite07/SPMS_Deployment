const { createTokenService } = require('../services/token-service');

// Default-deny. This middleware is mounted ahead of every route, so a route
// added later is protected unless its path is added here on purpose. The
// inverse — remembering to attach `requireAuth` to each new protected route —
// fails open, and the failure is invisible until someone notices the route
// never asked for a token.
//
// `/health` is the CD smoke test's target, which must answer during a cold
// start with no credentials (see deployment/pipeline.md). It and the SPA
// shell (`/` and client-side routes) are served ahead of this middleware in
// app.js, so they never actually reach here — the `/health` entry is kept as
// defence-in-depth in case that ordering ever changes.
//
// An entry is either a bare path — public for every method — or a
// `"METHOD /path"` pair. Login needs the pair form: `POST /api/session` opens
// a session and cannot require one, while `DELETE /api/session` ends a
// session and must prove it owns the session it is ending. Listing the bare
// path would have made logout unauthenticated, letting anyone end anyone's
// session by guessing nothing at all.
// Password reset is public for the same reason login is: a user who forgot
// their master password by definition holds no session token, and this is
// the request that would otherwise need one to explain who it's for.
// POST-scoped, not a bare path, for the same reason logout isn't bare: there
// is no GET/DELETE on this router to accidentally expose. See PRD 0020 and
// routes/password-reset.js — identity is proven via the enrolled 2FA TOTP
// code, not an emailed token, so there is only the one route now.
//
// The 2FA enrollment pair is public for the same reason: a user with no
// second factor configured yet cannot hold a session token either (UC-01's
// precondition), so /enroll and /confirm are, like login, the requests that
// create the very thing a token would otherwise be needed to prove. See
// PRD 0017 and routes/two-factor.js.
//
// Registration is public for the same shape of reason as all the above: a
// first-time visitor holds no session by definition, and POST /api/register
// is the request that creates the account a token would otherwise be needed
// to prove. See PRD 0018 and routes/register.js.
const PUBLIC_PATHS = Object.freeze([
  '/health',
  'POST /api/session',
  'POST /api/password-reset',
  'POST /api/2fa/enroll',
  'POST /api/2fa/confirm',
  'POST /api/register',
]);

const METHOD_SCOPED_ENTRY = /^([A-Z]+)\s+(\/.*)$/;

function isPublic(publicPaths, req) {
  for (const entry of publicPaths) {
    const scoped = METHOD_SCOPED_ENTRY.exec(entry);
    if (scoped) {
      if (req.method === scoped[1] && req.path === scoped[2]) {
        return true;
      }
    } else if (req.path === entry) {
      return true;
    }
  }
  return false;
}

// RFC 6750 §2.1: exactly `Bearer <token>`, scheme matched case-insensitively.
const BEARER_SCHEME = /^Bearer\s+(\S+)$/i;

// The sliding session's contract with the client. Every authenticated
// response carries a token whose idle deadline is ten minutes from *now*;
// the client must replace the one it holds. A client that ignores these is
// logged out ten minutes after login however active it was.
const SESSION_TOKEN_HEADER = 'X-Session-Token';
const SESSION_EXPIRES_HEADER = 'X-Session-Expires-At';

function extractBearerToken(headerValue) {
  if (typeof headerValue !== 'string') {
    return null;
  }
  const match = BEARER_SCHEME.exec(headerValue.trim());
  return match ? match[1] : null;
}

// The description is always one of a few fixed strings — never an error
// message or anything derived from the request, which would let a caller
// write into a response header.
function denyAccess(res, error, description) {
  res
    .status(401)
    .set('WWW-Authenticate', `Bearer error="${error}", error_description="${description}"`)
    .json({ error, error_description: description });
}

// Idle lapse and cap exhaustion are distinguishable because they call for
// different client behaviour, and neither reveals anything about the token.
// Every other failure is one opaque message.
function describeFailure(err) {
  if (err.name === 'TokenExpiredError') {
    return 'Token expired';
  }
  if (err.name === 'SessionExpiredError') {
    return 'Session expired';
  }
  return 'Invalid token';
}

/**
 * @param sessions  { isRevoked(sessionId) => Promise<boolean> } — the session
 *                  store. Required, and deliberately not defaulted to a stub
 *                  that answers `false`: such a default would let a caller
 *                  who forgot to wire the store keep serving revoked tokens,
 *                  and the failure would be invisible. An app that cannot
 *                  check revocation should fail to start, not fail open.
 */
function createAuthMiddleware({
  tokenService = createTokenService(),
  sessions,
  publicPaths = PUBLIC_PATHS,
} = {}) {
  if (!sessions || typeof sessions.isRevoked !== 'function') {
    throw new TypeError('sessions.isRevoked is required');
  }

  return function authenticate(req, res, next) {
    if (isPublic(publicPaths, req)) {
      return next();
    }

    const token = extractBearerToken(req.get('authorization'));
    if (!token) {
      return denyAccess(res, 'invalid_request', 'Missing bearer token');
    }

    let claims;
    try {
      claims = tokenService.verify(token);
    } catch (err) {
      return denyAccess(res, 'invalid_token', describeFailure(err));
    }

    // A token with no `jti` names no session, so logout has nothing to revoke
    // and this check has nothing to look up — it would be valid until its own
    // expiry no matter how many times the user pressed "log out". Nothing the
    // login route mints lacks one. Refuse the rest rather than honour a
    // session token that revocation cannot reach.
    if (typeof claims.sessionId !== 'string' || claims.sessionId === '') {
      return denyAccess(res, 'invalid_token', 'Invalid token');
    }

    // Awaited before the route runs, and before the sliding-window headers
    // are set: a revoked session must not be handed a freshly renewed token
    // on its way out the door.
    return Promise.resolve(sessions.isRevoked(claims.sessionId))
      .then((revoked) => {
        if (revoked) {
          return denyAccess(res, 'invalid_token', 'Session ended');
        }

        // Frozen so a downstream handler cannot rewrite the authenticated
        // identity it was handed.
        req.auth = Object.freeze(claims);

        // Slide the idle window. This request *is* the activity that business
        // rule 5 measures, so the deadline moves before the route even runs.
        // renew() cannot push past the absolute cap, and verify() has already
        // rejected a session that reached it, so this cannot throw in
        // practice.
        const renewed = tokenService.renew(claims);
        res.set(SESSION_TOKEN_HEADER, renewed.token);
        res.set(SESSION_EXPIRES_HEADER, renewed.expiresAt.toISOString());
        // Browsers hide non-safelisted headers from cross-origin JS unless
        // they are named here.
        res.set(
          'Access-Control-Expose-Headers',
          `${SESSION_TOKEN_HEADER}, ${SESSION_EXPIRES_HEADER}`
        );

        return next();
      })
      // A store that is down must deny, via the 500 handler. Passing the
      // error to next() rather than calling next() plainly is what stops an
      // unreachable session store from becoming an authentication bypass.
      .catch(next);
  };
}

module.exports = {
  createAuthMiddleware,
  extractBearerToken,
  PUBLIC_PATHS,
  SESSION_TOKEN_HEADER,
  SESSION_EXPIRES_HEADER,
};
