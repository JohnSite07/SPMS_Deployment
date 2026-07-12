const { authenticator } = require('otplib');
const { decrypt } = require('./crypto');

// TOTP verification (UC-01's second factor) via otplib, wrapping
// session-issuer.js's `verifyTwoFactorCode(twoFactorConfig, code)` port.
//
// The seed never sits in the USERS/TWO_FACTOR_CONFIGS row as plaintext — it
// is AES-256-GCM ciphertext (services/crypto.js), decrypted here, used once,
// and discarded; it is never logged (nothing in this module calls
// console.*) and never returned to a caller.

// otplib defaults to a single 30s step with no window, i.e. a code is valid
// for exactly the step it was generated in. A ±1 step window absorbs clock
// drift between the phone's authenticator app and this process without
// opening the door to replay across many steps.
authenticator.options = { window: 1 };

/**
 * @param twoFactorConfig  { method, enabled, encryptedSecret: { ciphertext,
 *                          iv, tag } } — the shape ports/users.js attaches to
 *                          a User. `enabled`/absence are session-issuer.js's
 *                          job to check (UC-01's precondition); this module
 *                          only verifies a code against a config it is
 *                          actually given.
 * @param code              the digits the user submitted.
 * @returns {Promise<boolean>} never throws — a config this module cannot
 *          make sense of (missing secret, undecryptable ciphertext, garbage
 *          code) simply fails to verify, the same posture as
 *          password-hasher.js.
 */
async function verifyTwoFactorCode(twoFactorConfig, code) {
  if (!twoFactorConfig || !twoFactorConfig.enabled) {
    return false;
  }
  if (typeof code !== 'string' || code === '') {
    return false;
  }
  // EMAIL is a second TWO_FACTOR_CONFIGS.method the schema allows but this
  // PRD's scope is TOTP verification only (2FA enrolment/delivery is a
  // separate, later flow) — refuse rather than silently accept.
  if (twoFactorConfig.method !== 'TOTP') {
    return false;
  }
  if (!twoFactorConfig.encryptedSecret) {
    return false;
  }

  let secret;
  try {
    secret = decrypt(twoFactorConfig.encryptedSecret);
  } catch {
    return false;
  }

  try {
    return authenticator.check(code, secret);
  } catch {
    return false;
  }
}

module.exports = { verifyTwoFactorCode };
