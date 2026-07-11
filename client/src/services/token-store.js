// In-memory session token store (PRD 0012, Decision 1). The token and its
// expiry live only in module state — never in localStorage/sessionStorage —
// so an injected script has no persisted credential to exfiltrate, and a hard
// refresh or new tab deliberately requires logging in again. Acceptable given
// the 10-minute auto-lock and the zero-knowledge posture; see ADR for 0012.

let token = null;
let expiresAt = null; // Date | null

export function getToken() {
  return token;
}

export function getExpiresAt() {
  return expiresAt;
}

export function hasToken() {
  return token !== null;
}

// setToken/setExpiresAt only ever *update* — a falsy argument is ignored, so a
// missing refresh header can't accidentally wipe a live token. Use clear() to
// end the session; these will not do it.
export function setToken(next) {
  if (next) {
    token = next;
  }
}

export function setExpiresAt(iso) {
  if (iso) {
    expiresAt = new Date(iso);
  }
}

export function clear() {
  token = null;
  expiresAt = null;
}
