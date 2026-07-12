const crypto = require('crypto');

// AES-256-GCM for the one secret the server itself holds: the encrypted TOTP
// seed in TWO_FACTOR_CONFIGS (secret_enc/secret_iv/secret_tag). This is
// deliberately NOT used for vault contents — credential passwords and
// documents are encrypted client-side under the zero-knowledge posture (see
// ports/credentials.js), and the server never holds a key that could decrypt
// them. This module exists only so services/two-factor-verifier.js can
// recover the TOTP seed to check a code against it.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM nonce, matches CK_TFA_IV / CK_CREDENTIALS_IV in DATABASE.md
const AUTH_TAG_LENGTH = 16; // matches CK_TFA_TAG
const KEY_LENGTH = 32; // AES-256

function loadKey(env = process.env) {
  const raw = env.AES_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'AES_ENCRYPTION_KEY is not set. Cloud Run injects it from the aes-encryption-key ' +
        'secret; locally, export a base64-encoded 32-byte key.'
    );
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH) {
    // Length only, never the value.
    throw new Error(
      `AES_ENCRYPTION_KEY must decode (base64) to ${KEY_LENGTH} bytes; got ${key.length}.`
    );
  }
  return key;
}

/**
 * @param plaintext  a UTF-8 string (e.g. a TOTP seed).
 * @param key        a 32-byte Buffer; defaults to AES_ENCRYPTION_KEY.
 * @returns {{ ciphertext: Buffer, iv: Buffer, tag: Buffer }}
 */
function encrypt(plaintext, { key = loadKey() } = {}) {
  if (typeof plaintext !== 'string' || plaintext === '') {
    throw new TypeError('plaintext is required');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return { ciphertext, iv, tag };
}

/**
 * @param sealed  { ciphertext, iv, tag } — each a Buffer (or a value
 *                Buffer.from() accepts, so a row read back as a driver
 *                Buffer or a base64 string both work).
 * @param key     a 32-byte Buffer; defaults to AES_ENCRYPTION_KEY.
 * @returns {string} the recovered plaintext.
 * @throws  if the ciphertext, IV, or key is wrong, or the auth tag does not
 *          match — GCM authenticates on decrypt, so tampering throws rather
 *          than silently returning garbage.
 */
function decrypt({ ciphertext, iv, tag }, { key = loadKey() } = {}) {
  if (!ciphertext || !iv || !tag) {
    throw new TypeError('ciphertext, iv, and tag are all required');
  }

  const ivBuffer = Buffer.isBuffer(iv) ? iv : Buffer.from(iv);
  const tagBuffer = Buffer.isBuffer(tag) ? tag : Buffer.from(tag);
  const cipherBuffer = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);

  if (ivBuffer.length !== IV_LENGTH) {
    throw new Error(`iv must be ${IV_LENGTH} bytes; got ${ivBuffer.length}`);
  }
  if (tagBuffer.length !== AUTH_TAG_LENGTH) {
    throw new Error(`tag must be ${AUTH_TAG_LENGTH} bytes; got ${tagBuffer.length}`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuffer);
  decipher.setAuthTag(tagBuffer);
  // Throws (bad auth tag / tampered ciphertext) rather than returning
  // anything, which is the whole point of an AEAD mode.
  const plaintext = Buffer.concat([decipher.update(cipherBuffer), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt, loadKey, ALGORITHM, IV_LENGTH, AUTH_TAG_LENGTH, KEY_LENGTH };
