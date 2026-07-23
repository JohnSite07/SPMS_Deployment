// First real consumer of the API client (PRD 0012): the login/logout flow that
// opens and ends a session. Screens call these; they never touch the token
// store or fetch directly.

import { post, get, del } from './api-client';
import * as store from './token-store';
import * as vaultKeyStore from './vault-key-store';
import { cancelAutoLock } from './session';
import { deriveVaultKey } from './vault-crypto';

// UC-01. Returns { token, sessionId } on success (see app/src/routes/session.js).
// The login response is a public route, so it carries no sliding-session
// headers — we make one authenticated GET /api/session afterwards, whose
// response DOES carry X-Session-Expires-At, so the api-client arms the
// auto-lock timer. A failure there doesn't undo the login: the timer simply
// arms on the next authenticated request instead.
export async function login({ email, password, code, deviceToken } = {}) {
  const { token, sessionId } = await post('/session', { email, password, code, deviceToken });
  // Store the token before the follow-up GET so that call is authenticated.
  store.setToken(token);
  try {
    await get('/session');
  } catch {
    // Token is valid; the auto-lock arms on the next authenticated call.
  }
  // PRD 0019: derive the vault's AES-256-GCM key from the master password
  // while it's still in scope, and hold it in vault-key-store.js for the rest
  // of the session. Done after the token is already stored so a failure here
  // (extremely unlikely — Web Crypto unavailable/misconfigured) never turns a
  // successful login into a failed one; Credentials.jsx detects a missing
  // vault key and tells the user to log out and back in rather than guessing.
  try {
    const vaultKey = await deriveVaultKey(password, email);
    vaultKeyStore.setVaultKey(vaultKey);
  } catch {
    // See above: login has already succeeded, so this is not fatal here.
  }
  return { sessionId };
}

// UC-01 logout. Best-effort server revoke, but the local token is cleared
// regardless so the client never keeps a token it believes is dead.
export async function logout() {
  try {
    await del('/session');
  } catch {
    // Best-effort: the server may be unreachable, but the user is logging out
    // either way — we still clear locally rather than surface the failure.
  } finally {
    cancelAutoLock();
    store.clear();
    // logout() does not route through session.js's endSession() (it also
    // does its own redirect-free cleanup here), so the vault key needs its
    // own clear() call too — see the note in session.js's endSession().
    vaultKeyStore.clear();
  }
}

export function isAuthenticated() {
  return store.hasToken();
}
