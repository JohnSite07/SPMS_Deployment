// Client-side, cryptographically-secure password generator (PRD 0021). A
// generated value is just a string typed into the same Add/Edit Credential
// form vault-crypto.js already encrypts before it ever reaches the API — see
// Credentials.jsx. Nothing here talks to the network or the vault key.
//
// Uses crypto.getRandomValues (the same Web Crypto global vault-crypto.js
// already relies on, declared in client/eslint.config.js's globals list) for
// every random choice in this module — both character selection and the
// final shuffle. Math.random() is never used: it is not a CSPRNG and is
// unsuitable for generating anything treated as a secret.
//
// Guarantee: at least one character from each *selected* class is present in
// the output. A naive "pick length random characters from the combined
// alphabet" approach can, by chance, omit an entire requested class (e.g. a
// 16-character password requested with digits enabled but landing on zero
// digits) — silently producing a weaker password than what was asked for.
// This is avoided by reserving one guaranteed slot per selected class,
// filling the remaining slots randomly from the full combined alphabet, and
// then Fisher-Yates shuffling the whole array (also with getRandomValues) so
// the guaranteed characters aren't predictably in the first N positions.

const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const NUMBERS = '0123456789';
// Avoid characters that are visually ambiguous or commonly cause quoting
// trouble when pasted into shells/URLs; still a healthy symbol set.
const SYMBOLS = '!@#$%^&*()-_=+[]{}';

const DEFAULT_LENGTH = 16;

// Picks a single uniformly-random character from `alphabet` using
// crypto.getRandomValues (rejection sampling to avoid modulo bias).
function randomChar(alphabet) {
  const maxUnbiased = Math.floor(256 / alphabet.length) * alphabet.length;
  const buffer = new Uint8Array(1);
  let value;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= maxUnbiased);
  return alphabet[value % alphabet.length];
}

// Fisher-Yates shuffle in place, using crypto.getRandomValues for every swap
// index — never Math.random.
function shuffle(chars) {
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const buffer = new Uint32Array(1);
    const maxUnbiased = Math.floor(0x100000000 / (i + 1)) * (i + 1);
    let value;
    do {
      crypto.getRandomValues(buffer);
      value = buffer[0];
    } while (value >= maxUnbiased);
    const j = value % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars;
}

// Generates a random password.
//
// Options:
// - length: total character count (default 16).
// - includeUppercase / includeLowercase / includeNumbers / includeSymbols:
//   which character classes to draw from (all default true).
//
// Throws if every class is disabled (there is nothing to generate from —
// silently falling back to some default alphabet would surprise a caller who
// explicitly asked for none of the four; the caller's UI should prevent this
// combination, e.g. by disabling the last remaining checked box).
export function generatePassword({
  length = DEFAULT_LENGTH,
  includeUppercase = true,
  includeLowercase = true,
  includeNumbers = true,
  includeSymbols = true,
} = {}) {
  const classes = [];
  if (includeUppercase) classes.push(UPPERCASE);
  if (includeLowercase) classes.push(LOWERCASE);
  if (includeNumbers) classes.push(NUMBERS);
  if (includeSymbols) classes.push(SYMBOLS);

  if (classes.length === 0) {
    throw new Error('generatePassword: at least one character class must be enabled.');
  }

  // Clamp to a sane floor: never generate fewer characters than there are
  // guaranteed classes, or the "one of each" guarantee would be impossible.
  const safeLength = Math.max(length, classes.length);

  const combinedAlphabet = classes.join('');
  const chars = [];

  // Guaranteed slot: one character from each selected class first.
  for (const alphabet of classes) {
    chars.push(randomChar(alphabet));
  }

  // Remaining slots filled randomly from the full combined alphabet.
  for (let i = chars.length; i < safeLength; i += 1) {
    chars.push(randomChar(combinedAlphabet));
  }

  return shuffle(chars).join('');
}
