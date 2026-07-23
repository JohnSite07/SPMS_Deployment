// Vault credential CRUD (PRD 0019/0008/0009) — mirrors auth-service.js /
// registration-service.js: a thin wrapper over api-client.js, no crypto and
// no state here. Every field this module sends or receives that represents a
// stored password is already ciphertext — encryption/decryption happens in
// vault-crypto.js, one layer up, in Credentials.jsx. This file never sees a
// master password or plaintext credential.

import { get, post, patch, del } from './api-client';

// GET /api/credentials — PRD 0019's new list route. Returns every item in
// the caller's own vault (business rule 6, enforced server-side), still
// ciphertext, newest-updated-first. No audit entry is written for a list
// call (see routes/credentials.js's header comment on why).
export async function listCredentials() {
  return get('/credentials');
}

// GET /api/credentials/:itemId — the single-item read that IS audit-logged
// (CREDENTIAL_RETRIEVED, UC-03) because the caller named one specific item.
// Used when opening the View screen for a specific credential, rather than
// re-using the list's cached copy, so a deliberate "view this credential"
// action is the one that actually gets witnessed by the append-only log.
export async function getCredential(itemId) {
  return get(`/credentials/${itemId}`);
}

// POST /api/credentials — UC-02. `encryptedPassword` must already be
// ciphertext (see vault-crypto.js's encryptField) by the time it reaches here.
export async function addCredential({ title, url, username, encryptedPassword } = {}) {
  return post('/credentials', { title, url, username, encryptedPassword });
}

// PATCH /api/credentials/:itemId — the edit flow. `patchFields` should only
// include the fields that actually changed; in particular, omit
// encryptedPassword entirely rather than sending a re-encryption of the
// unchanged plaintext (see Credentials.jsx's edit form).
export async function updateCredential(itemId, patchFields) {
  return patch(`/credentials/${itemId}`, patchFields);
}

// DELETE /api/credentials/:itemId — irreversible; the caller (Credentials.jsx)
// is responsible for confirming with the user first. Returns null (204).
export async function deleteCredential(itemId) {
  return del(`/credentials/${itemId}`);
}
