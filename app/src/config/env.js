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

module.exports = {
  loadJwtConfig,
  MIN_SIGNING_KEY_LENGTH,
  DEFAULT_AUTO_LOCK_MINUTES,
  DEFAULT_TTL_SECONDS,
  DEFAULT_ABSOLUTE_SESSION_SECONDS,
};
