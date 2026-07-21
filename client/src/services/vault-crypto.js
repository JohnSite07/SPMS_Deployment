// Client-side vault encryption (PRD 0019) — the module that makes the
// "zero-knowledge" claim in docs/architecture/overview.md real. Every prior
// PRD deferred this: the server (app/src/routes/credentials.js) has only ever
// been handed an opaque ciphertext string it stores blindly. This is the
// first and only place that string is produced or consumed — decryption never
// happens anywhere but here, on the device, from a key the server never sees.
//
// Design (see docs/action_plan/0019-credential-vault-ui-and-encryption.md):
//
// - Key derivation is PBKDF2-SHA-256 straight from the master password, at
//   600,000 iterations (current OWASP minimum guidance for PBKDF2-HMAC-SHA256
//   — the OWASP Password Storage Cheat Sheet's 210,000 figure is the SHA-512
//   row of that same table, a different hash width with a different cost
//   curve; using it here would understate the iteration count this hash
//   actually needs).
//   The PRD chose this over a wrapped/rotatable random vault key to keep the
//   feature 100% app-layer, no new column, no new infra. The accepted,
//   documented cost of that choice: resetting the master password orphans
//   every previously-saved credential, because the derived key changes and
//   nothing re-encrypts old ciphertext. Not fixed here — see the PRD.
// - The PBKDF2 salt is SHA-256(lowercased, trimmed email) rather than a
//   random per-user column. This is what keeps the feature schema-free: the
//   salt is always recomputable from a value the app already has (the email
//   the user just typed to log in), so there is nothing new to store, back
//   up, or lose. The tradeoff (also accepted, also flagged in the PRD): the
//   same weakness class as the password-reset one above — changing a user's
//   email would break decryption too. There is no email-change feature today,
//   so this is a known simplification, not a live bug.
// - The derived AES-GCM key is created with `extractable: false`. This is
//   deliberate defense-in-depth: even if an attacker achieved arbitrary code
//   execution in this tab and could call crypto.subtle.exportKey on whatever
//   CryptoKey reference they got hold of, a non-extractable key refuses to
//   export its raw bytes. It changes nothing about deriveKey's normal use
//   (encrypt/decrypt still work) and costs nothing, so there is no reason to
//   ever flip this to true.
// - encryptField/decryptField produce and consume ONE opaque base64 string
//   per field: random 12-byte IV, followed by whatever AES-GCM emits
//   (ciphertext with its authentication tag already appended — WebCrypto
//   does not separate them). This matches exactly what routes/credentials.js
//   documents as its expectation: the server never parses this blob, it only
//   stores and returns it, so the framing only ever has to be internally
//   consistent between encryptField and decryptField in this one file.
// - decryptField lets a GCM authentication failure throw naturally (wrong
//   key, tampered ciphertext, or corrupted data all land here). It does not
//   catch and paper over that error: a caller that gets back garbage instead
//   of a clear failure could show a corrupted password to a user who then
//   unknowingly saves it back, or believe a masked field is safe when it is
//   silently wrong. Every call site decides for itself how to surface
//   "unable to decrypt" (see Credentials.jsx).

const PBKDF2_ITERATIONS = 600000;
const AES_KEY_LENGTH_BITS = 256;
const IV_LENGTH_BYTES = 12; // 96-bit IV, the standard/recommended size for AES-GCM.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Deterministic from the email alone (lowercased, trimmed) so the same
// account always derives the same salt with no lookup and no schema change.
async function deriveSaltFromEmail(email) {
  const normalized = (email ?? '').trim().toLowerCase();
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(normalized));
  return new Uint8Array(digest); // 32 bytes
}

// Derive the non-extractable AES-256-GCM vault key from the master password
// and the account email. Called once per login (auth-service.js /
// two-factor-service.js) and held only in vault-key-store.js until the
// session ends or auto-locks.
export async function deriveVaultKey(masterPassword, email) {
  const salt = await deriveSaltFromEmail(email);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(masterPassword ?? ''),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_LENGTH_BITS },
    false, // non-extractable — see the module comment above.
    ['encrypt', 'decrypt']
  );
}

// One opaque base64 string: iv (12 bytes) || ciphertext+tag. This is the
// exact shape routes/credentials.js's `encryptedPassword` field expects —
// an opaque blob it stores and returns unexamined.
export async function encryptField(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(plaintext ?? '')
  );

  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(combined);
}

// Reverse of encryptField. Deliberately does not catch: a GCM auth failure
// (wrong key or tampered/corrupted ciphertext) propagates to the caller
// rather than being swallowed into a false "success" with garbage bytes.
export async function decryptField(key, opaqueBase64) {
  const combined = base64ToBytes(opaqueBase64);
  const iv = combined.slice(0, IV_LENGTH_BYTES);
  const ciphertext = combined.slice(IV_LENGTH_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return textDecoder.decode(plaintext);
}
