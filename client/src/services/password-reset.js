// UC — forgotten master password reset (PRD 0020, replacing PRD 0015's
// emailed-token flow). Identity is proven with the user's already-enrolled
// 2FA authenticator code instead of an emailed link, so there is nothing to
// "request" — a single call carries the email, the current TOTP code, and
// the new master password, and either succeeds (204) or fails with a generic
// 401 (unknown email / no enabled 2FA / wrong code, indistinguishable by
// design) or a 400 weak_password. Neither this module nor the caller ever
// authenticates the browser via this flow: a reset only lets the user log in
// again afterwards via the existing Login screen, so token-store is never
// touched here.

import { post } from './api-client';

export async function resetPassword({ email, code, newPassword } = {}) {
  return post('/password-reset', { email, code, newPassword });
}
