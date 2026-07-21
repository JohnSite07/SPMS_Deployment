# 0015 — Password Reset Flow (forgot-password request + reset confirm)

> **Superseded by [PRD 0020](0020-totp-based-password-reset.md) (2026-07-21).** The emailed-token flow this PRD shipped never worked in the deployed environment — PRD 0016 (SMTP provisioning) never landed, so `/request`/`/confirm` ran permanently in their "disabled mode" (`503`). PRD 0020 replaces both endpoints with a single `POST /api/password-reset` verified against the user's existing TOTP 2FA code instead, removing the SMTP dependency entirely. Kept here, unedited below, as the historical record of what was built and why — see PRD 0020 for the current design and this project's "never delete, supersede instead" convention.

Let a user who has forgotten their master password reset it through a single-use, time-limited email link — implemented as a **re-hash only** operation, because the vault is encrypted with the server-held AES key and never with the master password.

| | |
| --- | --- |
| **Status** | Superseded by [0020](0020-totp-based-password-reset.md) |
| **Date** | 2026-07-13 |
| **Author** | Main session (orchestrator), on behalf of @Anjuuuzzz |

## User story

As a SecureVault user who has forgotten my master password, I want to request a reset link by email and set a new master password, so that I can regain access to my account without losing my vault — and without anyone being able to reset it on my behalf.

This is the **reset half** of the "Login Page & Reset Password" ticket. The login half (the `Login.jsx` UI + wiring to the existing atomic `POST /api/session`) is built directly, since its backend (bcrypt verify, 2FA, lockout, generic error, login audit) already shipped in PRD [0009](0009-storage-layer-and-auth-wiring.md). The reset flow is separated here because it adds **new backend routes, a reset-token store, and a first `EmailService`** — a classic attack surface that warrants a reviewed plan before execution ([`action-plan.md`](../../.claude/rules/action-plan.md)).

## Key decision (settled 2026-07-13): reset is re-hash only

The vault is encrypted with the **server-held `AES_ENCRYPTION_KEY`** (Secret Manager; the milestone `CryptoService` model), *not* a key derived from the master password. The master password is used **only** for login verification (business rule 1: hashed, never stored). Therefore a reset **does not re-encrypt anything** — it validates the reset token, hashes the new password, and updates `master_password_hash`. No re-key, no recovery key, no data loss. Subtask 8's "re-key/re-encrypt logic" is intentionally **not** built: it does not apply under this model.

## Scope

**In scope:**

- **`POST /api/password-reset/request` `{ email }`** (public) — mint a single-use, time-limited reset token; store only its **SHA-256 hash** + `expires_at`; email a link via `EmailService`. **Always returns the same generic `200`** regardless of whether the email exists (no account enumeration). No timing oracle: do the same work (or a constant-time-ish equivalent) for unknown emails.
- **`POST /api/password-reset/confirm` `{ token, newPassword }`** (public) — look up the token by its hash; reject if missing, expired, or already used; enforce the **master-password rules (≥12 chars, mixed character types)**; bcrypt-hash and `UPDATE USERS.master_password_hash`; mark the token **used** (single-use); **revoke all of the user's sessions**; write a **`MASTER_PASSWORD_CHANGED`** audit entry — all in one transaction.
- **`app/src/services/email-service.js`** — a narrow `EmailService.sendEmail(...)` wrapping SMTP (nodemailer), reading `SMTP_USERNAME` / `SMTP_PASSWORD` (already injected) plus new `SMTP_HOST` / `SMTP_PORT` config. Fail-fast config loader like [`config/env.js`](../../app/src/config/env.js). Sends only a link — never the password or token in a way that persists server-side beyond the hash.
- **A `PASSWORD_RESET_TOKENS` table** (schema addition via a 0014-style migration): `user_id` FK, `token_hash`, `expires_at`, `used_at NULL`. Never stores the raw token.
- **Frontend** (per [`.claude/rules/frontend.md`](../../.claude/rules/frontend.md)): a **Forgot Password** page (email form → generic "if that email exists, a link was sent") and a **Reset Password** page (reads the token from the URL, new-password + confirm fields with the strength/rule hints, submits to `confirm`). Wire the Login page's placeholder "Forgot password?" link to it. New `password-reset` service methods through `api-client.js`.
- **Audit** on successful reset (`MASTER_PASSWORD_CHANGED`) — subtask 9's reset half.
- **Tests** — backend unit/route tests (token single-use, expiry, enumeration-safe request, password-rule enforcement, session revocation, audit write) and frontend Vitest tests for both forms.

**Out of scope:**

- **Any vault re-encryption / recovery-key mechanism** — not applicable under the server-side-AES decision above.
- **The login page itself** — built directly, not in this PRD.
- **Rate limiting / CAPTCHA** on the request endpoint — recommended follow-up (noted under Security); this PRD ships enumeration-safety and single-use/short-expiry tokens, not abuse throttling.
- **Admin-initiated resets, SMS/other channels, "change password while logged in"** (that is `User.changeMasterPassword()` — a separate authenticated flow).
- **Reconciling the 0009 credential store to a real server-side `CryptoService`** — surfaced by this decision, but its own follow-up.

## Success criteria

- [ ] `POST /api/password-reset/request` returns the **same `200` body** for a known and an unknown email (verified by test) — no enumeration.
- [ ] A valid, unexpired, unused token at `/confirm` sets the new hash: the user can then log in with the new password and **cannot** with the old one.
- [ ] A token that is **expired**, **already used**, or **unknown** is rejected with a generic error and changes nothing.
- [ ] `/confirm` rejects a `newPassword` under 12 chars or lacking mixed character types (business rule 2).
- [ ] After a successful reset, the user's **prior sessions are revoked** (an old token gets `401`).
- [ ] A **`MASTER_PASSWORD_CHANGED`** audit entry is written on success, and the reset is atomic (if the audit append fails, the password is not changed).
- [ ] The raw reset token is **never** stored (only its hash) and never logged — confirmed by review + grep.
- [ ] `PASSWORD_RESET_TOKENS` exists with `token_hash`, `expires_at`, `used_at`, and an FK to `USERS`.
- [ ] `npm test` / `npm run lint` (app) and `npm run lint` / `npm test` / `npm run build` (client) are green.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `app/src/routes/password-reset.js` | New — request + confirm routes | $0 |
| `app/src/services/email-service.js` | New — SMTP `sendEmail` (nodemailer) | $0 |
| `app/src/config/*` | Edit — add `SMTP_HOST`/`SMTP_PORT` + reset-token TTL config | $0 |
| `app/src/ports/password-reset-store.js` (or extend users port) | New — token create/consume, hash-only | $0 |
| `app/db/migrations/0003_password_reset_tokens.sql` | New — `PASSWORD_RESET_TOKENS` table | $0 |
| `client/src/pages/ForgotPassword.jsx` · `ResetPassword.jsx` | New — the two forms | $0 |
| `client/src/services/password-reset.js` | New — service methods via api-client | $0 |
| `app/package.json` | Edit — add `nodemailer` | $0 |
| Tests (app + client) | New | $0 |
| Cloud SQL `securevault` | **Existing** — one small table added | $0 (no new resource) |
| SMTP provider | **External** — creds already in Secret Manager (`smtp-username`/`smtp-password`) | $0 (free-tier transactional email) |

No new GCP resource. `nodemailer` is the only new runtime dep.

References:
- Master-password rules & audit: [functional-requirements.md](../requirements/functional-requirements.md) (rules 1, 2, 7), [audit-entry.js](../../app/src/models/audit-entry.js) (`MASTER_PASSWORD_CHANGED`).
- Session revocation model: ADR [0007](../decisions/0007-stateful-session-revocation.md).
- Append-only audit: ADR [0006](../decisions/0006-append-only-audit-log-enforcement.md).
- Migration pattern: [0014](0014-database-schema-implementation.md) + [DATABASE.md](DATABASE.md).
- SMTP secrets wiring: [terraform/modules/app/main.tf](../../terraform/modules/app/main.tf) (`SMTP_USERNAME`/`SMTP_PASSWORD`).

## Scripts / commands

No billable command. Local only.

```bash
# app/
npm install nodemailer
npm run lint && npm test

# client/
npm run lint && npm test && npm run build

# Apply the reset-token table (once, as an admin, like 0014):
#   mysql ... securevault < app/db/migrations/0003_password_reset_tokens.sql
```

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| 1 | `app-engineer` | Backend: `password-reset.js` routes, `email-service.js`, the token store (hash-only, single-use), config additions, and the `0003` migration; wire into `server.js`/`app.js`; tests. | Green `npm test`/`lint`; migration file. |
| 2 | `app-engineer` | Frontend: `ForgotPassword.jsx` + `ResetPassword.jsx` + `password-reset` service; wire the Login "Forgot password?" link; Vitest tests; per frontend rules. | Green `lint`/`test`/`build`. |
| 3 | `infra-reviewer` | Security pass: enumeration-safety, token hashed/single-use/short-TTL, constant-time compare, session revocation, atomic audit, no secret/token logged, parameterized SQL. | Findings/sign-off. |
| 4 | `documentation-keeper` | ADR for the reset design (server-side-AES ⇒ re-hash only), a runbook note, update DATABASE.md/schema docs for `PASSWORD_RESET_TOKENS`, PRD Outcome + index. | Updated `docs/`. |

## Testing / verification plan

| Success criterion | Verification | Expected |
| --- | --- | --- |
| No enumeration | Request with known vs unknown email | Identical `200` body |
| Happy path | Confirm with valid token, then login | New pw works; old pw `401` |
| Bad token | Confirm with expired/used/unknown token | Generic error; no change |
| Password rules | Confirm with weak `newPassword` | Rejected (≥12 + mixed types) |
| Session revocation | Old session token after reset | `401` |
| Audit + atomicity | Successful reset; forced audit-append failure | `MASTER_PASSWORD_CHANGED` present; on failure, hash unchanged |
| Token at rest | Inspect store + grep logs | Only hash stored; token never logged |
| Gates green | app + client `lint`/`test`/`build` | Pass |
| Review | Step 3 | Sign-off, no high-severity open |

## Additional considerations

- **Security posture.** Reset is the canonical account-takeover vector, so: tokens are **high-entropy, hashed at rest (SHA-256), single-use, short-lived** (e.g. 30 min); the request endpoint is **enumeration-safe** (same response + no timing oracle for unknown emails); token lookup uses a constant-time comparison on the hash; a successful reset **revokes all existing sessions** so a thief mid-session is kicked; the new password is bcrypt-hashed and must pass business rule 2; and **no raw token or password is ever logged**. Rate-limiting is a recommended follow-up, not shipped here.
- **Rollback / teardown.** App code + one additive table. Rollback = `git revert`; the table drops with `terraform destroy`. Reverting removes the routes; login is unaffected.
- **Dependencies / open questions.**
  - **SMTP host/port config is missing.** Terraform injects `SMTP_USERNAME`/`SMTP_PASSWORD` but not `SMTP_HOST`/`SMTP_PORT` — those must be added (plain env in the app module, or a small secret) and a transactional SMTP provider chosen. Needs a one-line infra addition (terraform-engineer) before email actually sends; unit tests mock the transport.
  - **Schema addition** (`PASSWORD_RESET_TOKENS`) must be applied to the live DB (0014-style migration, admin identity), and captured in DATABASE.md.
  - **Enumeration vs. UX:** the generic "if that email exists…" response is deliberate; product should confirm they accept that a user mistyping their email gets no error.

## Outcome

Shipped as planned: `/request`/`/confirm`, `email-service.js`, the hash-only token store, and the `PASSWORD_RESET_TOKENS` migration were built and tested. The flow was never functional end-to-end in the deployed environment, because PRD 0016 (SMTP provisioning) was never completed — the routes ran in the documented "disabled mode" (`503`) from merge onward. On 2026-07-21, PRD [0020](0020-totp-based-password-reset.md) replaced this flow entirely with a TOTP-verified single endpoint that has no SMTP dependency; see PRD 0020 and [ADR 0014](../decisions/0014-totp-based-password-reset.md) for the replacement design and rationale. This PRD's code (`password-reset.js`'s old routes, `ResetPassword.jsx`, `password-reset-config.js`) has since been removed or rewritten; `services/email-service.js` and the `PASSWORD_RESET_TOKENS` table remain in place, unused by this flow (see PRD 0020's Out of scope).
