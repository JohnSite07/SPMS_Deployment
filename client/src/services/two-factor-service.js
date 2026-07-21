// Self-service TOTP enrollment (PRD 0017) — the missing path that lets a user
// reach UC-01's "2FA set up" precondition themselves instead of a developer
// hand-writing a TWO_FACTOR_CONFIGS row. Mirrors auth-service.js: every call
// goes through api-client.js, and only confirm() ever touches the token
// store, because only confirm actually finishes a login (see
// app/src/routes/two-factor.js).

import { post, get } from './api-client';
import * as store from './token-store';

// POST /api/2fa/enroll — re-verifies the master password (same generic 401
// as login) and, for a user with no enabled 2FA yet, returns a freshly
// generated { secret, otpauthUri } exactly once. A 409 { error:
// 'two_factor_already_enabled' } means the account already has 2FA — that
// shape is safe to reveal (see the route's own comment) and is handled by
// the caller, not swallowed here.
export async function enrollTwoFactor({ email, password } = {}) {
  return post('/2fa/enroll', { email, password });
}

// POST /api/2fa/confirm — re-verifies the master password again, checks the
// live code against the pending secret, and on success finishes login the
// same way POST /api/session does: { token, sessionId }. Mirrors login() in
// auth-service.js exactly — store the token before the follow-up
// authenticated GET /session, since that response (unlike confirm's) carries
// the X-Session-Expires-At header the api-client needs to arm the
// auto-lock timer. A failure on that follow-up call doesn't undo the login:
// the timer simply arms on the next authenticated request instead.
export async function confirmTwoFactor({ email, password, code, deviceToken } = {}) {
  const { token, sessionId } = await post('/2fa/confirm', { email, password, code, deviceToken });
  store.setToken(token);
  try {
    await get('/session');
  } catch {
    // Token is valid; the auto-lock arms on the next authenticated call.
  }
  return { sessionId };
}
