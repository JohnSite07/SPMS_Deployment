const { MIN_MASTER_PASSWORD_LENGTH } = require('./password-hasher');

// Business rule 2: the master password must be at least 12 characters and
// mix character types. password-hasher.js enforces only the length floor (it
// hashes whatever string it is handed); this module is the one place that
// enforces the "mixed types" half, so every caller that mints a new master
// password — today the password-reset confirm route, later registration —
// applies the same rule instead of each re-deriving it.
//
// "Mixed types" is read here as all four of upper, lower, number, and
// symbol, per this PRD's instructions. The requirements doc only says "mix
// character types" without naming a threshold; four-of-four is the stricter,
// unambiguous reading, flagged here rather than silently narrowed.

const HAS_UPPERCASE = /[A-Z]/;
const HAS_LOWERCASE = /[a-z]/;
const HAS_NUMBER = /[0-9]/;
const HAS_SYMBOL = /[^A-Za-z0-9]/;

function isStrongMasterPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_MASTER_PASSWORD_LENGTH) {
    return false;
  }
  return (
    HAS_UPPERCASE.test(password) &&
    HAS_LOWERCASE.test(password) &&
    HAS_NUMBER.test(password) &&
    HAS_SYMBOL.test(password)
  );
}

module.exports = { isStrongMasterPassword };
