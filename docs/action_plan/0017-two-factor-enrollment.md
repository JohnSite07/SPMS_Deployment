# 0017 — Two-Factor Enrollment (TOTP setup + confirm)

Let a user who has no second factor configured yet turn one on themselves — generate a TOTP secret, confirm it with a live code, and be logged straight in — closing the gap where `TWO_FACTOR_CONFIGS` currently has to be seeded by hand for any account to ever pass login.

| | |
| --- | --- |
| **Status** | Done |
| **Date** | 2026-07-21 |
| **Author** | Main session (orchestrator), on behalf of @Anjuuuzzz |

## User story

As a SecureVault user whose account has no 2FA configured, I want to set up an authenticator app myself (scan/enter a secret, confirm it with a code), so that I can complete UC-01's "2FA set up" precondition and actually log in — without a developer hand-writing rows into `TWO_FACTOR_CONFIGS` via Cloud SQL Studio.

## Why this exists (bug this closes)

Traced while testing the seed data in `DATABASE.md`: `session-issuer.js`'s `verifyTwoFactorCode` throws `TWO_FACTOR_NOT_ENABLED` whenever `twoFactorConfig` is missing or `enabled = FALSE` — deliberately, per its own comment ("a user without an enabled second factor does not skip this step — they cannot log in at all"). That is correct enforcement of UC-01's precondition, but nothing in the app lets a user *reach* that precondition. Today the only path is a human writing AES-GCM ciphertext into the DB directly. This PRD builds the missing self-service path.

## Scope

**In scope:**

- **`POST /api/2fa/enroll` `{ email, password }`** (public, like `POST /api/session`) — re-verifies the master password (same `deny()` shape/message as login, same lockout accounting via `users.recordFailedAttempt`/`resetFailedAttempts` — this is still master-password-guessing surface and must be covered by business rule 1's lockout). On success:
  - If the user already has `twoFactorConfig.enabled === true`, answer `409 { error: 'two_factor_already_enabled' }` (safe to reveal — only reachable after the password was already proven correct, so it adds no enumeration channel).
  - Otherwise, generate a fresh TOTP secret (`otplib`), encrypt it with the existing `AES_ENCRYPTION_KEY` (`services/crypto.js`, unchanged), and upsert it into `TWO_FACTOR_CONFIGS` with **`enabled = FALSE`** (pending, not yet usable for login — `UQ_TFA_USER` makes this a clean upsert, no schema change). Respond `200` with `{ secret, otpauthUri }` — the plaintext secret is generated fresh here and returned exactly once; it is never logged and is never re-derivable from the DB afterward except by decrypting with the real key.
- **`POST /api/2fa/confirm` `{ email, password, code }`** (public) — re-verifies the master password the same way, loads the *pending* `TWO_FACTOR_CONFIGS` row (regardless of its current `enabled` value — this also lets a user re-confirm after a botched first attempt), decrypts it, and checks `code` with the existing `two-factor-verifier.js`. On a correct code: sets `enabled = TRUE`, writes a new `TWO_FACTOR_ENABLED` audit action, and — since both factors are now genuinely proven — completes login exactly like `POST /api/session` does (starts a session, issues a token, writes `LOGIN_SUCCEEDED`, returns `{ token, sessionId }`). A wrong code counts as a failed attempt (`recordFailedAttempt`), same lockout rule as a wrong login code.
- **`app/src/services/two-factor-enrollment.js`** — new, narrow: `generateSecret()` (otplib) + reuses `services/crypto.js`'s `encrypt`/`decrypt` unchanged. No new crypto primitive.
- **`ports/users.js` additions** — `upsertPendingTwoFactorConfig(userId, encryptedSecret)` and `enableTwoFactorConfig(userId)`, both parameterized, both operating on the existing `TWO_FACTOR_CONFIGS` table (no migration).
- **`ACTIONS.TWO_FACTOR_ENABLED`** added to `models/audit-entry.js`'s closed vocabulary.
- **Frontend** (per `.claude/rules/frontend.md`): a new `client/src/pages/TwoFactorSetup.jsx` page (same precedent as `ForgotPassword.jsx`/`ResetPassword.jsx` in PRD 0015 — a screen the six-wireframe spec doesn't enumerate but the flow requires), linked from `Login.jsx` ("Don't have 2FA set up? Set it up"). Two-step form: email+password → shows the secret as **copyable text** (matching the existing "copy rather than display" secure-by-default pattern — see Out of scope on QR) → code entry → on success, stores the returned token like `login()` does and navigates to `/`. New `client/src/services/two-factor-service.js` (`enroll`, `confirm`) through `api-client.js`, mirroring `auth-service.js`.
- **Tests** — backend unit/route tests (pending vs. enabled state, wrong password/code lockout accounting, re-confirm after a botched attempt, audit write, no secret ever logged) and frontend Vitest tests for the new page/service.

**Out of scope:**

- **QR code image rendering.** The setup screen shows the raw secret (copy-to-clipboard) and the `otpauth://` URI as text, not a scannable QR image — avoids adding a new client dependency for this PRD. A follow-up can add a `qrcode` npm package if a scannable image is wanted.
- **Disabling / re-enrolling 2FA once enabled**, and **admin-initiated enrollment** — both are separate, authenticated-session flows (`User` already has a session at that point), not this public pre-login surface.
- **EMAIL-method 2FA** — `two-factor-verifier.js` already refuses non-TOTP methods; this PRD doesn't touch that.
- **Rate limiting / CAPTCHA** on `/enroll` or `/confirm` beyond the existing 5-attempt lockout — same recommended-follow-up posture as PRD 0015.
- **Changing `POST /api/session`'s behavior or its generic error message in any way.** Deliberately not wired together: `/api/session` continues to answer `TWO_FACTOR_NOT_ENABLED` with the same generic 401 as every other failure. Enrollment is reached only by the user *choosing* the "set up 2FA" link, never inferred from a failed login — surfacing enrollment state from the login response would reopen the exact password-guessing oracle UC-01's anti-enumeration design (session.js's `deny()`) exists to close.

## Success criteria

- [x] `POST /api/2fa/enroll` with a correct password for a user with no 2FA row returns `200` with a `secret` + `otpauthUri`, and writes a `TWO_FACTOR_CONFIGS` row with `enabled = FALSE`.
- [x] `POST /api/2fa/enroll` for a user already `enabled = TRUE` returns `409` and does not overwrite the existing secret.
- [x] `POST /api/2fa/enroll` with a wrong password returns the same generic `401` shape as `/api/session`, and counts toward the 5-failure lockout (verified: 5 wrong attempts lock the account).
- [x] `POST /api/2fa/confirm` with the correct current code sets `enabled = TRUE`, writes `TWO_FACTOR_ENABLED` to the audit log, and returns a working session `{ token, sessionId }` — a subsequent authenticated `GET /api/session` with that token succeeds.
- [x] `POST /api/2fa/confirm` with a wrong code does not enable the row, counts as a failed attempt, and a 6th overall failure (mixed enroll+confirm attempts) locks the account per business rule 1.
- [x] After confirmation, `POST /api/session` with that email/password/code (a fresh code) logs in normally — the account now satisfies UC-01's precondition without any manual DB write.
- [x] The plaintext TOTP secret is never written to a log line anywhere in `app/` (verified by grep) and never persisted unencrypted.
- [x] `npm test` / `npm run lint` (app) and `npm run lint` / `npm test` / `npm run build` (client) are green.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `app/src/routes/two-factor.js` | New — `/enroll`, `/confirm` routes | $0 |
| `app/src/services/two-factor-enrollment.js` | New — secret generation, wraps existing `crypto.js` | $0 |
| `app/src/ports/users.js` | Edit — add `upsertPendingTwoFactorConfig`, `enableTwoFactorConfig` | $0 |
| `app/src/models/audit-entry.js` | Edit — add `ACTIONS.TWO_FACTOR_ENABLED` | $0 |
| `app/src/app.js` | Edit — mount `/api/2fa` | $0 |
| `app/src/middleware/authenticate.js` | Edit — add `POST /api/2fa/enroll`, `POST /api/2fa/confirm` to `PUBLIC_PATHS` | $0 |
| `client/src/pages/TwoFactorSetup.jsx` | New | $0 |
| `client/src/services/two-factor-service.js` | New | $0 |
| `client/src/pages/Login.jsx` | Edit — add the "set up 2FA" link | $0 |
| `client/src/App.jsx` | Edit — add the `/2fa-setup` route | $0 |
| Tests (app + client) | New | $0 |
| Cloud SQL `securevault` | **Existing** — no schema change (`UQ_TFA_USER` already supports the upsert) | $0 |

No new GCP resource, no new npm dependency (otplib and the crypto module are already in `app/`).

References:
- Precondition being closed: [functional-requirements.md:37](../requirements/functional-requirements.md#L37) (UC-01 "Pre: registered account; 2FA set up").
- Enforcement this respects unchanged: [session-issuer.js:134-143](../../app/src/services/session-issuer.js#L134-L143).
- Verification reused unchanged: [two-factor-verifier.js](../../app/src/services/two-factor-verifier.js), [crypto.js](../../app/src/services/crypto.js).
- Schema (no change needed): `TWO_FACTOR_CONFIGS`, `UQ_TFA_USER` — [DATABASE.md:186-201](DATABASE.md#L186-L201).
- Screen precedent for an auxiliary (non-wireframe) page: PRD [0015](0015-password-reset-flow.md)'s `ForgotPassword.jsx`/`ResetPassword.jsx`.
- Anti-enumeration pattern being preserved: [session.js:49-53](../../app/src/routes/session.js#L49-L53).

## Scripts / commands

No billable command. Local only.

```bash
# app/
npm run lint && npm test

# client/
npm run lint && npm test && npm run build
```

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| 1 | `app-engineer` | Backend: `routes/two-factor.js`, `services/two-factor-enrollment.js`, `ports/users.js` additions, `ACTIONS.TWO_FACTOR_ENABLED`, `PUBLIC_PATHS` + `app.js` wiring; tests. | Green `npm test`/`lint`. |
| 2 | `app-engineer` | Frontend: `TwoFactorSetup.jsx` + `two-factor-service.js`; Login link; route; Vitest tests; per frontend rules (react-bootstrap, `api-client.js`, in-memory token, copy-not-display for the secret). | Green `lint`/`test`/`build`. |
| 3 | `infra-reviewer` | Security pass: enroll/confirm are as enumeration-safe as login, lockout accounting applies to both new endpoints, pending vs. enabled state can't be forced open without the password, secret never logged, parameterized SQL, `/api/session` behavior genuinely untouched. | Findings/sign-off. |
| 4 | `documentation-keeper` | Update DATABASE.md's query catalogue (2FA enroll/enable queries), note the closed gap, PRD Outcome + index. | Updated `docs/`. |

## Testing / verification plan

| Success criterion | Verification | Expected |
| --- | --- | --- |
| Enroll happy path | `POST /enroll` correct password, no prior config | `200` + secret/URI; row `enabled=FALSE` |
| Already enabled | `POST /enroll` for an already-2FA'd user | `409`, existing row untouched |
| Enroll lockout | 5 wrong-password `/enroll` calls | Same lockout as login (account locked 15 min) |
| Confirm happy path | `POST /confirm` with the just-issued secret's current code | `enabled=TRUE`, audit entry, valid session token returned |
| Confirm wrong code | `POST /confirm` with a bad code | Not enabled, counted as failed attempt |
| End-to-end | Enroll → confirm → later `POST /api/session` with a fresh code | Normal login succeeds |
| No secret leakage | grep `app/` logs/tests for the plaintext secret | Never appears outside the one enroll response |
| `/api/session` unchanged | Existing `session-routes.test.js` suite | Still green, no behavior diff |
| Gates green | app + client `lint`/`test`/`build` | Pass |
| Review | Step 3 | Sign-off, no high-severity open |

## Additional considerations

- **Security posture.** This is a second public, unauthenticated, password-guessing surface (alongside `/api/session`), so it gets the same treatment: generic error shape, the existing 5-failure/15-minute lockout applies uniformly across login *and* enroll/confirm attempts (they all call the same `users.recordFailedAttempt`/`resetFailedAttempts`), and revealing "already enrolled" is gated behind a correct password so it adds no anonymous enumeration channel. The pending secret is encrypted at rest with the same `AES_ENCRYPTION_KEY` as the eventual enabled one — there is no separate, weaker-protected "draft" state.
- **Rollback / teardown.** App code only, no schema change. Rollback = `git revert`; nothing to unwind in the DB (a pending, never-confirmed row is inert — `verifyTwoFactorCode` already refuses anything with `enabled=false`).
- **Open questions:**
  - Should confirming 2FA log the user in immediately (this PRD's choice) or send them back to the login screen to "prove it for real"? Chosen: log in immediately, since both factors were just genuinely verified — re-asking would be theatre, not security.
  - QR image rendering was deliberately deferred (see Out of scope) — confirm that copy/paste text is acceptable for grading/demo purposes, or this PRD should be amended to add `qrcode` before implementation.
- **Dependencies:** none — reuses `otplib`, `crypto.js`, and the existing `TWO_FACTOR_CONFIGS` table as-is.

## Outcome

Shipped as planned, both routes, both ports methods, the audit action, and the frontend page — see "What shipped" below. All success criteria (§4) met; `npm test`/`lint` green on `app/` (542 tests, 541 passing, 1 pre-existing skip) and `lint`/`test`/`build` green on `client/`.

**What shipped:**

- `app/src/routes/two-factor.js` — `POST /api/2fa/enroll` and `POST /api/2fa/confirm`, mounted at `/api/2fa` in `app/src/app.js`, both added to `PUBLIC_PATHS` in `app/src/middleware/authenticate.js`.
- `app/src/services/two-factor-enrollment.js` — `generateSecret()`/`buildOtpauthUri()` via `otplib`, re-exports `encrypt`/`decrypt` from `services/crypto.js` unchanged.
- `app/src/ports/users.js` — `upsertPendingTwoFactorConfig(userId, { ciphertext, iv, tag })` (an `INSERT ... ON DUPLICATE KEY UPDATE` against `UQ_TFA_USER`, always leaves `enabled = FALSE`) and `enableTwoFactorConfig(tx, userId)` (the only place `enabled` flips to `TRUE`, transaction-scoped).
- `models/audit-entry.js` — `ACTIONS.TWO_FACTOR_ENABLED` (`'two_factor.enabled'`) added to the closed vocabulary.
- Frontend: `client/src/pages/TwoFactorSetup.jsx` (route `/2fa-setup`), `client/src/services/two-factor-service.js`, a link from `Login.jsx`, and the route wired in `App.jsx` — following the `ForgotPassword`/`ResetPassword` (PRD 0015) precedent for an auxiliary, non-wireframe screen.
- Full backend + frontend test coverage per the plan's testing table.

**Deviation from plan (review findings, both fixed before sign-off):** `infra-reviewer`'s first pass found two audit-integrity gaps the PRD's design didn't anticipate at the level of detail needed:

1. **Missing "already enabled" guard on `/confirm`.** The PRD's confirm flow (§ Scope) always wrote `TWO_FACTOR_ENABLED` on a correct code, but a user re-confirming an already-enabled config (explicitly allowed, per the PRD's own "lets a user re-confirm after a botched first attempt" language) would fabricate a fresh `TWO_FACTOR_ENABLED` entry for something that happened earlier — `TWO_FACTOR_ENABLED` is closed-vocabulary and is supposed to mean the action just occurred. Fixed: `/confirm` now checks `user.twoFactorConfig.enabled` *before* deciding whether to call `enableTwoFactorConfig`/write the audit entry (`alreadyEnabled` branch in `routes/two-factor.js`) — an already-enabled row falls straight through to a normal login with no duplicate entry.
2. **Atomicity gap between enabling 2FA and its audit entry.** The PRD named the audit write as a requirement but didn't spell out that it must be transactionally inseparable from `enableTwoFactorConfig` and the session-start block. Fixed: `enableTwoFactorConfig` now takes `tx` and commits inside the same `sessions.transaction(...)` as the `TWO_FACTOR_ENABLED` audit write and the login-completion block (session start, token issuance, `LOGIN_SUCCEEDED` entry) — a failure anywhere in that chain rolls back the whole thing rather than leaving `enabled = TRUE` with a missing or partial audit trail.

Both are refinements normal to PRD-vs-implementation gap-closing, not scope changes: the PRD already required "writes a new `TWO_FACTOR_ENABLED` audit action" and named the reused session-start path; the review sharpened *when* (only on the real transition) and *how atomically* that happens. `infra-reviewer` signed off clean on the re-check — no open findings.

**Resulting doc updates:**
- [DATABASE.md §5 (Application query catalogue, TWO_FACTOR_CONFIGS block)](DATABASE.md#5-application-query-catalogue) — added the upsert and enable queries.
- [ADR 0012 — Two-factor enrollment as a separate public pre-session surface](../decisions/0012-two-factor-enrollment-separate-public-surface.md) — records the anti-enumeration design call from Scope/Out-of-scope above as a durable decision.
- [domain-model.md](../architecture/domain-model.md) — pointer noting `TwoFactorConfig`'s pending/enabled lifecycle is now self-service, not only a seeded assumption.
- `docs/action_plan/README.md` index row set to `Done`.
