# 0020 — TOTP-Based Password Reset (replaces the email-link flow)

Replace PRD 0015's emailed-token reset with a single-step flow that verifies identity using the user's already-enrolled 2FA authenticator code instead — because real SMTP was never actually provisioned (PRD 0016 is still "awaiting DevOps"), so the shipped email-link flow cannot send a real email today.

| | |
| --- | --- |
| **Status** | Done |
| **Date** | 2026-07-21 |
| **Author** | Main session (orchestrator), on behalf of @Anjuuuzzz |

## User story

As a SecureVault user who has forgotten my master password, I want to reset it using the same authenticator app I already use for 2FA, so that I can regain access without depending on an email inbox or SMTP provisioning that doesn't actually exist yet.

## Why this replaces PRD 0015 rather than sitting alongside it

PRD 0015 shipped a real, tested email-link reset flow — but `docs/action_plan/0016-smtp-provisioning-for-password-reset.md` is still `Draft (awaiting DevOps)`, and `secret-rotation.md` confirms `smtp-username`/`smtp-password` are still literal placeholder values. `routes/password-reset.js` already has a documented "disabled mode" for exactly this situation: both endpoints answer `503` and do nothing. **The shipped feature has never worked in the deployed environment and can't until SMTP exists.** Rather than wait on that (a DevOps/infra dependency outside this project's app-layer control), this PRD swaps the verification mechanism for one that needs no external service at all: the TOTP secret every user already sets up via PRD 0017.

This is a replacement, not an addition — the email-link flow is removed, not kept as a fallback.

## Scope

**In scope:**

- **`POST /api/password-reset` `{ email, code, newPassword }`** (public, replaces both `/request` and `/confirm` — there's nothing to "request" anymore, since a TOTP code is always already available from the user's own authenticator app, no server round-trip needed to mint or send anything):
  - Looks up the user by email; unknown email → the same generic denial as login/2FA (`{ error: 'invalid_credentials' }`), no distinction from any other failure below.
  - If the user has no *enabled* 2FA config, same generic denial (a user who never completed 2FA enrollment could never log in either — this isn't a new gap, it's the same precondition chain PRD 0017 already established).
  - Verifies `code` against the decrypted secret using the **existing, unmodified** `services/two-factor-verifier.js`'s `verifyTwoFactorCode` — reused directly, no new TOTP-checking code.
  - **A wrong code counts toward the same 5-failure/15-minute lockout** every other code-guessing surface in this app already uses (`users.recordFailedAttempt`/`resetFailedAttempts`) — this is genuinely load-bearing here: without it, this endpoint would be a rate-unlimited oracle for brute-forcing a 6-digit TOTP code, which the login and `/2fa/confirm` routes are already careful never to be.
  - Enforces business rule 2 on `newPassword` via the **existing, unmodified** `services/password-policy.js`.
  - On success, exactly PRD 0015's proven downstream behavior, unchanged: hash the new password, `UPDATE USERS.master_password_hash`, `sessions.revokeAllForUser`, write `MASTER_PASSWORD_CHANGED`, all in one transaction; reset the failed-attempt counter.
  - No email is sent. No token is minted, hashed, or stored.
- **`app/src/routes/password-reset.js`** — rewritten (not extended): drop the `/request`/`/confirm` pair, `EmailService`/`appBaseUrl`/"disabled mode" plumbing, and the token-hashing helpers; replace with the single route above.
- **`app/src/ports/password-reset-store.js` and the `PASSWORD_RESET_TOKENS` table** — the port stops being used by this route. The table itself is left in place (schema changes are a separate, deliberate discipline in this project — see `.claude/rules/action-plan.md`); this PRD only stops writing to it. Flagged under Additional considerations as a follow-up cleanup, not done here.
- **`app/src/config/password-reset-config.js` / `server.js`'s "disabled mode" wiring** — simplified: this route no longer depends on `loadPasswordResetConfig()`, `email`, or `appBaseUrl` at all, so `server.js`'s non-fatal SMTP-config try/catch and the whole disabled-mode concept for this router goes away. **This unblocks password reset from PRD 0016 entirely** — it no longer needs SMTP provisioned, ever, to function.
- **`client/src/pages/ForgotPassword.jsx`** — rewritten as the sole reset screen (same route, `/forgot-password`, so `Login.jsx`'s existing link needs no change): one form, collecting email + current 2FA code + new master password + confirm, single submit — same single-shot philosophy `Login.jsx` already uses ("no password-first round trip"). Client-side strength feedback reuses the existing shared `utils/password-rules.js` (PRD 0018/0015's shared module, unchanged).
- **`client/src/pages/ResetPassword.jsx` and its route (`/reset-password`) — removed.** There's no token-bearing link to land on anymore.
- **`client/src/services/password-reset.js`** — rewritten: one function calling the one new endpoint, replacing `requestReset`/`confirmReset`.
- Tests: rewrite `app/tests/password-reset-routes.test.js` for the new single-route behavior (happy path, unknown email, no-2FA account, wrong code + lockout accounting, weak password, session revocation, audit entry, atomicity); remove/retire the SMTP-disabled-mode tests and `email-service.test.js`'s coverage of the reset path specifically (the service itself can stay for future use — see below); update/replace the `ForgotPassword.jsx`/`ResetPassword.jsx` Vitest suites accordingly.

**Out of scope:**

- **Deleting `services/email-service.js` itself or the SMTP secrets.** The email primitive may still be useful later (the domain model's `SecurityAlert` is documented as relying on an `EmailService`) — this PRD only stops using it for password reset specifically, and doesn't touch PRD 0016's own status.
- **Dropping the `PASSWORD_RESET_TOKENS` table** — a schema change is its own deliberate step (see above), not bundled into an app-behavior PRD.
- **Any change to `/2fa/enroll`, `/2fa/confirm`, or normal login** — this reuses `two-factor-verifier.js` as a pure function call, exactly as `routes/two-factor.js` already does; neither file changes.
- **The PRD 0019 vault-key/password-reset conflict** (if 0019 ships): resetting the master password still orphans vault ciphertext encrypted under the old derived key, exactly as flagged there — this PRD doesn't make that better or worse, it only changes *how* a reset is authorized, not what a reset does to `master_password_hash` or its downstream effects. Cross-referenced, not re-solved here.

## Success criteria

- [ ] `POST /api/password-reset` with a correct email, a correct current TOTP code, and a strong new password succeeds: password updated, all sessions revoked, `MASTER_PASSWORD_CHANGED` audited, and the user can log in with the new password (and still cannot with the old one).
- [ ] Unknown email, no-2FA account, and wrong code all produce the identical generic denial — no enumeration signal distinguishes any of them.
- [ ] 5 wrong-code attempts against this endpoint lock the account for 15 minutes, same as login/2FA — verified explicitly, since this is the endpoint's core brute-force protection.
- [ ] A weak `newPassword` is rejected before anything is touched.
- [ ] No email is sent by this flow; the route has no dependency on SMTP config, `email`, or `appBaseUrl` — verified by constructing the route with none of those and confirming it still works.
- [ ] `/reset-password` is no longer a registered client route; `/forgot-password` alone handles the full flow.
- [ ] `npm test` / `npm run lint` (app) and `npm run lint` / `npm test` / `npm run build` (client) are green.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `app/src/routes/password-reset.js` | Rewrite | $0 |
| `app/src/server.js` | Edit — drop the SMTP-config disabled-mode wiring for this route | $0 |
| `client/src/pages/ForgotPassword.jsx` | Rewrite | $0 |
| `client/src/pages/ResetPassword.jsx` | Removed | $0 |
| `client/src/App.jsx` | Edit — remove the `reset-password` route | $0 |
| `client/src/services/password-reset.js` | Rewrite | $0 |
| Tests (app + client) | Rewritten/removed | $0 |
| `PASSWORD_RESET_TOKENS` table, `ports/password-reset-store.js` | **Unchanged, just unused** — no migration in this PRD | $0 |
| `services/email-service.js` | **Unchanged** — kept for future use, just unwired from this flow | $0 |

No new GCP resource, no new npm dependency, no schema change.

References:
- What this replaces: `docs/action_plan/0015-password-reset-flow.md`.
- Why: `docs/action_plan/0016-smtp-provisioning-for-password-reset.md` (still awaiting DevOps), `docs/runbooks/secret-rotation.md` (SMTP secrets confirmed placeholder).
- Reused unchanged: `app/src/services/two-factor-verifier.js`, `app/src/services/password-policy.js`.
- Lockout precedent this must match: `app/src/routes/two-factor.js`'s `/enroll`/`/confirm` code-guessing protection.
- The vault-key cross-reference: `docs/action_plan/0019-credential-vault-ui-and-encryption.md`'s flagged password-reset consequence.

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
| 1 | `app-engineer` | Backend: rewrite `routes/password-reset.js`, simplify `server.js`'s wiring, drop the SMTP disabled-mode path for this route; tests. | Green `npm test`/`lint`. |
| 2 | `app-engineer` | Frontend: rewrite `ForgotPassword.jsx`, remove `ResetPassword.jsx` + its route, rewrite `password-reset.js` client service; Vitest tests. | Green `lint`/`test`/`build`. |
| 3 | `infra-reviewer` | Security pass: lockout accounting is real and correctly wired, anti-enumeration holds across all three failure modes, no leftover SMTP dependency, atomicity preserved, no regression to `/2fa/*` or login. | Findings/sign-off. |
| 4 | `documentation-keeper` | Mark PRD 0015 as superseded (not deleted — supersede per doc conventions), update PRD 0016's status/framing now that reset no longer depends on it, PRD 0020 Outcome + index, ADR if warranted for the mechanism swap. | Updated `docs/`. |

## Testing / verification plan

| Success criterion | Verification | Expected |
| --- | --- | --- |
| Happy path | Correct email + current code + strong password | Password changes; old password + old sessions both fail afterward |
| Enumeration | Unknown email / no-2FA account / wrong code | All three produce the identical response |
| Lockout | 5 wrong codes | Account locked 15 min, matching login/2FA |
| Weak password | Strong-password check fails | Rejected, nothing touched |
| No SMTP dependency | Construct route with `email`/`appBaseUrl` omitted | Still functions normally (contrast with old "disabled mode") |
| Routing | Visit `/reset-password` | No longer a registered route |
| Gates green | app + client `lint`/`test`/`build` | Pass |
| Review | Step 3 | Sign-off, no high-severity open |

## Additional considerations

- **Security posture.** The core risk this design introduces is treated as the headline item, not an afterthought: without real lockout accounting, this becomes an unlimited-attempts TOTP brute-force surface. It must share the exact same `recordFailedAttempt`/`resetFailedAttempts` mechanism login and `/2fa/confirm` use — this is a hard requirement for the reviewer to verify, not a nice-to-have.
- **Rollback / teardown.** App code only, no schema change either direction. Rollback = `git revert`, which restores PRD 0015's email flow exactly as it was (still non-functional without real SMTP, but that was already true before this PRD).
- **Open questions:**
  - Whether to formally mark PRD 0015 `Superseded` (keeping it as a historical record per this project's ADR-style "never delete, supersede instead" convention) — proposed, left to `documentation-keeper`'s judgment on exact wording.
  - Whether `PASSWORD_RESET_TOKENS` should eventually be dropped via a real migration — not decided here, just flagged as now-genuinely-dead schema.
- **Dependencies:** none new. Removes a dependency (SMTP/PRD 0016) rather than adding one.

## Outcome

Shipped as planned, in full. `POST /api/password-reset { email, code, newPassword }` replaced both of PRD 0015's endpoints; `two-factor-verifier.js` and `password-policy.js` were reused unmodified. `server.js`/`app.js` no longer wire SMTP config, `EmailService`, or the reset-token store into this route; `PUBLIC_PATHS` now has a single reset entry. `config/password-reset-config.js` and its test were deleted after confirming zero remaining callers. `services/email-service.js` was deliberately left in place, unwired from this route — kept for potential future use (the domain model's `SecurityAlert`).

Frontend: `ForgotPassword.jsx` is now the sole reset screen (same `/forgot-password` route); `ResetPassword.jsx`, its `/reset-password` route, and its test file were removed entirely; `client/src/services/password-reset.js` collapsed to one `resetPassword()` call.

Full test coverage both sides: app 536 tests (535 pass, 1 pre-existing skip), client lint/test/build all green.

**Deviation from plan (caught in review, not a scope change):** the first implementation of the route had no `user.isLocked` check before verifying the TOTP code. Every other code-guessing surface in this app (`session-issuer.js`'s login path) refuses up front when an account is already locked; this route didn't, which would have let repeated wrong-code attempts against an already-locked account keep re-extending the 15-minute lockout window indefinitely — an availability/DoS-adjacent gap, not a data-disclosure one, but still a real regression from the parity this PRD's own "Security posture" section demanded. Fixed by adding the identical up-front `isLocked` refusal `session-issuer.js` uses, before any code verification runs at all ([`app/src/routes/password-reset.js:86-88`](../../app/src/routes/password-reset.js#L86-L88)).

This fix has a side effect worth recording explicitly: it also means a **correct** code presented against an already-locked account is refused too (whereas, without the fix, a correct code would have succeeded and cleared the lock early). The implementer and reviewer both judged the broader closure — "locked means locked, full stop, regardless of what credential you present" — more consistent with how the rest of the app treats lockout than a narrower fix that only closed the wrong-code case. This is documented in the route's own code comments and covered by two new tests (locked account + wrong code, locked account + correct code — both denied, neither clears the lock). Reviewer signed off clean on the re-check with no other findings.

No changes to scope, cost, or the security posture originally proposed — the lockout-parity requirement was already the PRD's headline risk; this is that requirement being enforced correctly, not a new one appearing.

Resulting doc updates: [ADR 0014](../decisions/0014-totp-based-password-reset.md) (the mechanism swap + the isLocked-parity decision), PRD [0015](0015-password-reset-flow.md) marked Superseded, PRD [0016](0016-smtp-provisioning-for-password-reset.md) reframed (no longer blocking password reset), `services/email-service.js`'s header comment corrected (stale reference to the deleted `config/password-reset-config.js`).
