// Self-service account creation (PRD 0018) — mirrors auth-service.js /
// two-factor-service.js: a thin wrapper over api-client.js. No session token
// is ever involved here (see app/src/routes/register.js's header comment: a
// freshly registered account has no 2FA yet, so there is nothing to
// authenticate into until PRD 0017's enroll/confirm flow completes) — this
// module never touches the token store.

import { post } from './api-client';

// POST /api/register — returns { userId } on success (201). Errors (400
// invalid_request, 400 weak_password, 409 email_already_registered) propagate
// as ApiError (see api-client.js) for the caller to branch on; this function
// does no interpretation of its own.
export async function registerAccount({ email, password } = {}) {
  return post('/register', { email, password });
}
