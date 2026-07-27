// Client-side document encryption (PRD 0025, UC-04) — the binary counterpart
// to vault-crypto.js's string-oriented encryptField/decryptField, built for
// the Secure Document Vault. This is the only place a document's plaintext
// bytes are ever produced or consumed: document-service.js hands this module
// a File to encrypt before upload, and raw downloaded ciphertext bytes to
// decrypt after download — the server (routes/documents.js) only ever sees
// the opaque encrypted Blob in between.
//
// Reuses the in-memory vault key from vault-key-store.js exactly like
// Credentials.jsx does, rather than requiring every caller to thread the key
// through — there is nothing document-specific about how the key is derived
// or held, only about what it encrypts here.

import { encryptBytes, decryptBytes } from './vault-crypto';
import * as vaultKeyStore from './vault-key-store';

// Thrown when no vault key is available in this session (e.g. a hard
// refresh, which never leaves a usable key behind by design — see
// vault-key-store.js). Documents.jsx handles this the same way
// Credentials.jsx handles hasVaultKey() being false: tell the user to log in
// again rather than crashing on crypto.subtle.encrypt/decrypt(undefined, ...).
export class MissingVaultKeyError extends Error {
  constructor() {
    super('No vault key is available in this session.');
    this.name = 'MissingVaultKeyError';
  }
}

function requireVaultKey() {
  const key = vaultKeyStore.getVaultKey();
  if (!key) {
    throw new MissingVaultKeyError();
  }
  return key;
}

// Encrypts a File's raw bytes client-side, before document-service.js ever
// builds the upload request — the plaintext file never leaves this function.
// Returns an opaque Blob (IV + ciphertext + GCM tag, vault-crypto.js's
// packing scheme) suitable as the `ciphertext` multipart part; the server
// only ever stores/streams this back, never parses it.
export async function encryptFile(file) {
  const key = requireVaultKey();
  const arrayBuffer = await file.arrayBuffer();
  const encryptedBytes = await encryptBytes(key, arrayBuffer);
  return new Blob([encryptedBytes]);
}

// Reverse of encryptFile: decrypts downloaded ciphertext bytes back to the
// original file's bytes and wraps them in a Blob typed with the original
// MIME type, so the browser can present/save the result correctly. A GCM
// auth failure (wrong key, or tampered/corrupted ciphertext) is deliberately
// not caught here — it propagates to the caller rather than yielding a
// silently-corrupted "file", the same fail-closed guarantee decryptField
// gives the credential vault.
export async function decryptToBlob(bytes, mimeType) {
  const key = requireVaultKey();
  const plaintext = await decryptBytes(key, bytes);
  return new Blob([plaintext], { type: mimeType });
}
