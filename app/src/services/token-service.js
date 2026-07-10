const jwt = require('jsonwebtoken');
const { loadJwtConfig, DEFAULT_ABSOLUTE_SESSION_SECONDS } = require('../config/env');

// Pinned on both sides. Passing an explicit algorithms allowlist to verify()
// is what stops an attacker re-signing a token with alg:none or downgrading
// an RS256 token to HS256 using the public key as the HMAC secret.
const ALGORITHM = 'HS256';

// Two actors: the vault OWNER, and the System Administrator who consumes
// audit logs (functional-requirements.md, Actors). There is still no sharing
// or delegation between owners — an admin reads audit history and nothing
// else, and in particular no vault contents, which stay ciphertext the server
// cannot decrypt.
//
// The allowlist rejects an unrecognised role when minting *and* when
// verifying, rather than letting it reach a route that treats any non-empty
// string as authorised.
//
// Be aware of what admitting ADMIN costs. Until it was added, a token whose
// `role` claim said "admin" was refused *even with a valid signature*, because
// no such role existed. That second line of defence is now gone for this one
// value: the signature is the only thing between an owner and an admin. Two
// consequences follow, and both are load-bearing. `sign()` must never take a
// role from request input (it does not — see below). And whoever can write
// the users table can mint an admin, because session-issuer.js reads
// `user.role`. Widen this allowlist only with the same care.
const ROLES = Object.freeze({ OWNER: 'owner', ADMIN: 'admin' });
const ROLE_VALUES = Object.freeze(Object.values(ROLES));

// Raised when a session outlives its absolute cap. Distinct from
// jwt.TokenExpiredError, which means the *idle* window lapsed: one says
// "you have been away too long", the other "this login is simply too old".
// Both end in a 401, but only the first is the user's fault.
class SessionExpiredError extends Error {
  constructor(message = 'session exceeded its maximum lifetime') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

// --- Token payload contract -------------------------------------------
//
// On the wire, every field maps to a registered JWT claim (RFC 7519) rather
// than a custom name, so any standard library validates exp/iss/aud for us:
//
//   userId          -> sub   subject of the token
//   issuedAt        -> iat   set by jsonwebtoken at sign time
//   expiresAt       -> exp   iat + ttlSeconds, i.e. the idle deadline
//   sessionId       -> jti   Session.sessionId, so a token can be tied to a
//                            revocable session row on logout or vault lock
//   role            -> role  custom; no registered equivalent
//   sessionStartedAt-> sessionStartedAt  custom; Session.startedAt, epoch
//                            seconds. Survives every renewal, which is what
//                            makes the absolute cap unforgeable by simply
//                            using the session.
//
// `verify()` returns the decoded claims re-expressed in those domain names,
// so callers never touch three-letter claim abbreviations.

function createTokenService(config = loadJwtConfig()) {
  const {
    signingKey,
    issuer,
    audience,
    ttlSeconds,
    absoluteMaxSeconds = DEFAULT_ABSOLUTE_SESSION_SECONDS,
    clock = () => Date.now(),
  } = config;

  const nowSeconds = () => Math.floor(clock() / 1000);

  // The single place a token is produced. `sessionStartedAt` is carried
  // forward untouched from the login that began the session.
  function mint({ userId, role, sessionId, sessionStartedAt }) {
    const now = nowSeconds();
    const startedAt = sessionStartedAt ?? now;
    const remaining = absoluteMaxSeconds - (now - startedAt);

    if (remaining <= 0) {
      throw new SessionExpiredError();
    }

    // A renewed token must never outlive the cap. Without this clamp, a
    // session renewed at cap-minus-one-minute would hand out a token valid
    // for a further ten, quietly overshooting the ceiling.
    const effectiveTtl = Math.min(ttlSeconds, remaining);

    // `iat` is set from our clock rather than left to jsonwebtoken's own
    // Date.now(), and `expiresIn` is measured relative to it. Otherwise the
    // injected clock would govern the absolute cap while jsonwebtoken's real
    // clock governed idle expiry — two different notions of "now" in one
    // token, and an idle window that no test could drive.
    const token = jwt.sign({ role, sessionStartedAt: startedAt, iat: now }, signingKey, {
      algorithm: ALGORITHM,
      subject: String(userId),
      issuer,
      audience,
      expiresIn: effectiveTtl,
      ...(sessionId === undefined ? {} : { jwtid: String(sessionId) }),
    });

    return { token, expiresAt: new Date((now + effectiveTtl) * 1000) };
  }

  return {
    // Reserved claims are set from the signing options below, never from
    // caller input — there is deliberately no free-form claims bag, so a
    // route cannot mint a token carrying its own sub or exp.
    sign({ userId, role = ROLES.OWNER, sessionId } = {}) {
      if (userId === undefined || userId === null || userId === '') {
        throw new TypeError('userId is required to mint a session token');
      }
      if (!ROLE_VALUES.includes(role)) {
        throw new TypeError(`unknown role "${role}"`);
      }

      return mint({ userId, role, sessionId }).token;
    },

    // Slides the idle window forward, returning the new token and its idle
    // deadline. Takes the output of verify(), so it can only renew a session
    // that was just proven valid — there is no path from an unverified token
    // to a renewed one.
    renew(auth) {
      return mint({
        userId: auth.userId,
        role: auth.role,
        sessionId: auth.sessionId,
        sessionStartedAt: Math.floor(auth.sessionStartedAt.getTime() / 1000),
      });
    },

    // Throws jsonwebtoken's TokenExpiredError / JsonWebTokenError on a bad
    // token, or SessionExpiredError past the absolute cap; callers translate
    // these into a 401 rather than swallowing them.
    verify(token) {
      const claims = jwt.verify(token, signingKey, {
        algorithms: [ALGORITHM],
        issuer,
        audience,
        // Same clock that mints the token judges whether it has expired.
        clockTimestamp: nowSeconds(),
      });

      // jwt.verify only enforces `exp` when it is present: a token with no
      // exp claim verifies happily and never expires. Nothing we mint omits
      // it, so demand it explicitly rather than trusting that. Same for iat
      // and sub, whose absence would otherwise surface downstream as an
      // Invalid Date or an undefined userId.
      if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
        throw new jwt.JsonWebTokenError('missing exp or iat claim');
      }
      if (typeof claims.sub !== 'string' || claims.sub === '') {
        throw new jwt.JsonWebTokenError('missing sub claim');
      }
      // Without this the absolute cap is unenforceable: a token lacking the
      // claim would renew forever.
      if (typeof claims.sessionStartedAt !== 'number') {
        throw new jwt.JsonWebTokenError('missing sessionStartedAt claim');
      }

      // A signature only proves we minted the token, not that it still means
      // what we meant. A role retired from the allowlist must stop being
      // honoured by tokens already in the wild.
      if (!ROLE_VALUES.includes(claims.role)) {
        throw new jwt.JsonWebTokenError(`unknown role "${claims.role}"`);
      }

      // Checked on every request, not only at renewal: a token minted just
      // before the cap is reached must stop working once it passes.
      if (nowSeconds() - claims.sessionStartedAt >= absoluteMaxSeconds) {
        throw new SessionExpiredError();
      }

      return {
        userId: claims.sub,
        role: claims.role,
        sessionId: claims.jti,
        issuedAt: new Date(claims.iat * 1000),
        expiresAt: new Date(claims.exp * 1000),
        sessionStartedAt: new Date(claims.sessionStartedAt * 1000),
      };
    },
  };
}

module.exports = { createTokenService, ALGORITHM, ROLES, SessionExpiredError };
