// UC — forgotten master password reset (PRD 0015). Both endpoints are public
// (no session token) and deliberately narrow: `request` never reveals whether
// the email exists (the backend always answers the same generic 200), and
// `confirm` carries only the opaque reset token from the URL plus the new
// password — never the account's current session/token state. Neither
// function touches token-store: a reset never authenticates the browser, it
// only lets the user log in again afterwards via the existing Login screen.

import { post } from './api-client';

export async function requestReset({ email } = {}) {
  return post('/password-reset/request', { email });
}

export async function confirmReset({ token, newPassword } = {}) {
  return post('/password-reset/confirm', { token, newPassword });
}
