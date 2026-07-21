// In-memory vault key store (PRD 0019), same shape and discipline as
// token-store.js (ADR 0010): the derived AES-256-GCM CryptoKey lives only in
// module state, never serialized, never written to localStorage/
// sessionStorage, and never sent anywhere. Unlike the session token, this key
// cannot survive a page refresh even in principle — it isn't reconstructible
// without the master password, which the app never retains past the
// deriveVaultKey() call that consumes it (see auth-service.js /
// two-factor-service.js). A hard refresh always requires logging in again to
// get a usable vault key back, by design.

let vaultKey = null; // CryptoKey | null

export function getVaultKey() {
  return vaultKey;
}

export function hasVaultKey() {
  return vaultKey !== null;
}

// Only ever *sets* — a falsy argument is ignored, mirroring token-store.js's
// setToken(): use clear() to end the vault session, not this.
export function setVaultKey(key) {
  if (key) {
    vaultKey = key;
  }
}

export function clear() {
  vaultKey = null;
}
