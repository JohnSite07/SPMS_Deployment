// Handoff between the two login steps (Login.jsx → TwoFactorVerify.jsx).
//
// The backend verifies the master password and the TOTP code *together* in a
// single POST /api/session (app/src/routes/session.js) — there is no
// password-only endpoint to call from step 1. So step 1 collects email +
// master password, parks them here, and step 2 submits all three at once.
//
// Same storage posture as token-store.js and vault-key-store.js: module state
// only, never localStorage/sessionStorage/cookies (frontend rule 4). It is
// deliberately NOT passed through React Router's navigate(state) — router
// state is serialized into the browser's session history entry, which would
// persist the master password across reloads and put it somewhere a script
// (or a devtools poke at history.state) can read it back.
//
// Lifetime: set by step 1, read by step 2, and cleared on a successful login,
// on returning to step 1, and whenever step 1 mounts fresh. An abandoned tab
// sitting on step 2 keeps it until then — the same window in which
// vault-key-store already holds a live derived key, so this adds no new class
// of exposure.

let pending = null; // { email, password } | null

export function setPendingLogin({ email, password } = {}) {
  if (!email || !password) {
    return;
  }
  pending = { email, password };
}

export function getPendingLogin() {
  return pending;
}

export function hasPendingLogin() {
  return pending !== null;
}

export function clearPendingLogin() {
  pending = null;
}
