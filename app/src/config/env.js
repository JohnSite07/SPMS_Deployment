// Environment contract loader. Cloud Run injects every value here from
// Secret Manager at container start (see terraform/modules/app/main.tf);
// nothing is read from a .env file, and no default is invented for a
// secret — a missing secret must stop the process, not fall back.

// Terraform generates a 64-character key (terraform/modules/secrets/
// variables.tf: jwt_signing_key_length). 32 is the floor at which HS256
// stops being trivially brute-forcible; anything shorter means the env
// var holds a truncated or placeholder value, not the real secret.
const MIN_SIGNING_KEY_LENGTH = 32;

// Session tokens expire with the vault's idle auto-lock so a leaked token
// cannot outlive the session it belongs to. Vault.autoLockMinutes is the
// domain field that owns this number and defaults to 10 (business rule 5,
// domain-model.md); a vault configured with a different value should pass
// its own ttlSeconds to createTokenService.
const DEFAULT_AUTO_LOCK_MINUTES = 10;
const DEFAULT_TTL_SECONDS = DEFAULT_AUTO_LOCK_MINUTES * 60;

// The idle window slides forward on every request, so a continuously active
// session would otherwise never end. This is the ceiling on a single login,
// active or not: after it, the user re-authenticates with password + 2FA.
const DEFAULT_ABSOLUTE_SESSION_SECONDS = 12 * 60 * 60;

const ISSUER = 'securevault';
const AUDIENCE = 'securevault-app';

function loadJwtConfig(env = process.env) {
  const signingKey = env.JWT_SIGNING_KEY;

  if (!signingKey) {
    throw new Error(
      'JWT_SIGNING_KEY is not set. Cloud Run injects it from the ' +
        'jwt-signing-key secret; locally, export it from Secret Manager: ' +
        'export JWT_SIGNING_KEY="$(gcloud secrets versions access latest --secret=jwt-signing-key)"'
    );
  }

  if (signingKey.length < MIN_SIGNING_KEY_LENGTH) {
    // Length only — never the value, which would put the key in the logs.
    throw new Error(
      `JWT_SIGNING_KEY is ${signingKey.length} characters; at least ${MIN_SIGNING_KEY_LENGTH} are required.`
    );
  }

  return {
    signingKey,
    issuer: ISSUER,
    audience: AUDIENCE,
    ttlSeconds: DEFAULT_TTL_SECONDS,
    absoluteMaxSeconds: DEFAULT_ABSOLUTE_SESSION_SECONDS,
  };
}

// --- Proxy hop count ----------------------------------------------------
//
// How many reverse proxies sit between the client and this container. Express
// needs it to resolve `req.ip`, which is what services/audit-log.js records on
// every entry — so a wrong value here silently corrupts the audit trail rather
// than breaking anything visibly.
//
// This is a number and never a boolean, which is the whole reason it is parsed
// here instead of read inline. `trust proxy: true` makes Express take the
// LEFT-most X-Forwarded-For entry; that end of the list is whatever the client
// sent, so an attacker sets their own audit-log address by sending a header. A
// hop count instead counts in from the RIGHT — the end the infrastructure
// appends and a client cannot reach past. With the correct count, a forged
// prefix is simply skipped: a client sending `XFF: evil` arrives as
// `evil, <real>` and hop count 1 still resolves to `<real>`.
//
// That robustness is exactly why the count has to be *correct* rather than
// plausible. Too high and Express walks left past the infrastructure's entries
// into the client-supplied ones, which is the forgeable case again. So an
// unset value does not guess: it means "no proxy", `req.ip` stays the socket
// peer, and the audit log records a useless-but-honest address instead of a
// confidently wrong one.
const TRUST_PROXY_ENV_VAR = 'TRUST_PROXY_HOPS';

// Not a real limit on topology — a typo catcher. Nothing in this deployment
// has ten proxies in front of it, so a value that large is a mistyped port or
// a pasted timeout, and it would push `req.ip` into the forgeable end of the
// list on every request.
const MAX_TRUST_PROXY_HOPS = 10;

/**
 * Returns the number of proxy hops to trust; 0 when unset (no proxy).
 *
 * Throws on anything that is not a non-negative integer within range —
 * including `true`/`false`, which Express itself accepts and which are the
 * specific values that make the audit log forgeable.
 */
function loadTrustProxyHops(env = process.env) {
  const raw = env[TRUST_PROXY_ENV_VAR];

  if (raw === undefined || raw === '') {
    return 0;
  }

  const normalized = String(raw).trim();

  if (/^(true|false)$/i.test(normalized)) {
    throw new Error(
      `${TRUST_PROXY_ENV_VAR} must be a hop count, not "${normalized}". ` +
        'Express treats `true` as "trust every proxy", which takes the ' +
        'client-supplied end of X-Forwarded-For and lets a caller forge the ' +
        'address recorded in the audit log. Count the hops in front of this ' +
        'container instead (log X-Forwarded-For on a deployed revision).'
    );
  }

  // Rejects "1.5", "2px", "0x2", " " and Number()'s other courtesies, any of
  // which would otherwise reach app.set() as NaN and disable trust silently.
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `${TRUST_PROXY_ENV_VAR} must be a non-negative integer; got "${raw}".`
    );
  }

  const hops = Number(normalized);

  if (hops > MAX_TRUST_PROXY_HOPS) {
    throw new Error(
      `${TRUST_PROXY_ENV_VAR} is ${hops}, above the maximum of ${MAX_TRUST_PROXY_HOPS}. ` +
        'A count that high walks past the proxy-supplied entries of ' +
        'X-Forwarded-For into the client-supplied ones, which is the forgery ' +
        'this setting exists to prevent.'
    );
  }

  return hops;
}

module.exports = {
  loadJwtConfig,
  loadTrustProxyHops,
  MIN_SIGNING_KEY_LENGTH,
  MAX_TRUST_PROXY_HOPS,
  TRUST_PROXY_ENV_VAR,
  DEFAULT_AUTO_LOCK_MINUTES,
  DEFAULT_TTL_SECONDS,
  DEFAULT_ABSOLUTE_SESSION_SECONDS,
};
