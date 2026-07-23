const { authenticator } = require('otplib');
const { encrypt, decrypt } = require('./crypto');

// PRD 0017 — the missing half of two-factor-verifier.js: generating a fresh
// TOTP seed and packaging it for TWO_FACTOR_CONFIGS, rather than verifying an
// existing one. Deliberately narrow: no new crypto primitive (encrypt/decrypt
// are re-exported from services/crypto.js, not reimplemented) and no new
// TOTP library (otplib is already a dependency, used the same way
// two-factor-verifier.js uses it).

const ISSUER = 'SecureVault';

// A fresh base32 TOTP seed. Returned to the caller exactly once (the /enroll
// response) — after that, the only copy that exists is the AES-256-GCM
// ciphertext this module also helps produce.
function generateSecret() {
  return authenticator.generateSecret();
}

// The otpauth:// URI an authenticator app scans/imports. `email` identifies
// the account within SecureVault the same way it does everywhere else in
// this module (there is no separate "account label" concept).
function buildOtpauthUri(email, secret) {
  return authenticator.keyuri(email, ISSUER, secret);
}

module.exports = {
  generateSecret,
  buildOtpauthUri,
  // Re-exported, not duplicated: routes/two-factor.js encrypts the freshly
  // generated secret and decrypts a pending one through these, the same
  // functions two-factor-verifier.js uses for the enabled case.
  encrypt,
  decrypt,
};
