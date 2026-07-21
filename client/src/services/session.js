// Session lifecycle glue (PRD 0012, Decision 3): the single place a session
// ends, plus the proactive auto-lock timer. Keeping this out of api-client
// avoids an import cycle (api-client -> session -> token-store).

import * as store from './token-store';
import * as vaultKeyStore from './vault-key-store';

// The app registers a real redirect (React Router navigate) via
// setRedirectHandler; the default no-op keeps unit tests and non-router
// contexts safe.
let redirect = () => {};
let timerId = null;

export function setRedirectHandler(fn) {
  redirect = typeof fn === 'function' ? fn : () => {};
}

// Fail-safe: any path that ends a session clears the token first, so a dead
// token is never left attached to later requests, then sends the user to
// login. Idempotent — safe to call from both the 401 handler and the timer.
export function endSession() {
  cancelAutoLock();
  store.clear();
  // PRD 0019: clear the derived vault key here too, so a 401-triggered
  // session end and the auto-lock timer (this function's other two callers)
  // both actually lock the vault, not just end the session token — re-
  // entering the master password is required to derive a usable key again.
  vaultKeyStore.clear();
  redirect();
}

// Proactive lock (business rule 5, made visible): arm a timer for the exact
// expiry so an idle user is locked at the deadline, not only on their next
// request. Re-armed every time the sliding session refreshes the expiry.
export function scheduleAutoLock() {
  cancelAutoLock();
  const exp = store.getExpiresAt();
  if (!exp) {
    return;
  }
  const ms = exp.getTime() - Date.now();
  if (ms <= 0) {
    endSession();
    return;
  }
  timerId = setTimeout(endSession, ms);
}

export function cancelAutoLock() {
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
}
