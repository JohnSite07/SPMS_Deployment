# 0012 — Two-factor enrollment as a separate public, pre-session surface

- **Status:** Accepted
- **Date:** 2026-07-21
- **Deciders:** Anju Babu (with Claude), via [PRD 0017](../action_plan/0017-two-factor-enrollment.md)

## Context

UC-01's precondition is "registered account; 2FA set up." `session-issuer.js`'s `verifyTwoFactorCode` correctly refuses login for any user without an *enabled* `TWO_FACTOR_CONFIGS` row — but nothing in the app let a user reach that precondition themselves; the only path was a human hand-writing AES-GCM ciphertext into the row via Cloud SQL Studio (see [PRD 0017](../action_plan/0017-two-factor-enrollment.md)).

`POST /api/session`'s anti-enumeration design (`session.js`'s `deny()`) deliberately answers the same generic 401 for an unknown email, a wrong password, and a missing/disabled 2FA config — collapsing all three into one indistinguishable failure is the whole point: it stops an attacker from using the login endpoint to learn *which* accounts exist or *which* have 2FA configured. Any self-service enrollment design has to add a path to `TWO_FACTOR_CONFIGS` without reopening that oracle.

## Decision

Enrollment is two new public, pre-session routes — `POST /api/2fa/enroll` and `POST /api/2fa/confirm` — reached only when a user deliberately follows a "set up 2FA" link, **never surfaced from a failed login**. `POST /api/session`'s behavior and error message are untouched: a login attempt against an account with no enabled 2FA still gets the same generic 401 as every other failure, with no hint that the fix is "go enroll."

Both new routes are treated as exactly as much of a password-guessing surface as `POST /api/session`, and get identical treatment:

- The same generic `401 { error: 'invalid_credentials' }` shape (`deny()`), re-verifying the master password before anything else.
- The same lockout accounting (`users.recordFailedAttempt` / `resetFailedAttempts`) — a wrong `/enroll` or `/confirm` attempt counts toward the same five-failure, fifteen-minute lockout a wrong login attempt does.
- One exception, deliberately: `/enroll` answers `409 two_factor_already_enabled` when the config is already enabled. This is safe to reveal only because it is gated behind a correct password proof — an anonymous caller learns nothing, only someone who already knows the master password.

A `TWO_FACTOR_CONFIGS` row written by `/enroll` always starts `enabled = FALSE` (pending) — usable by nothing else in the app, including login, until `/confirm` proves a live TOTP code against it and flips it to `TRUE` in the same transaction as the `TWO_FACTOR_ENABLED` audit entry. `/confirm` completes login immediately on success (issues a token via the same path `POST /api/session` uses), rather than sending the user back to prove it again — both factors were just genuinely verified, so re-asking would be theatre, not security.

## Alternatives considered

- **Surface "no 2FA configured" from `POST /api/session`'s error response**, pointing the user straight at enrollment. Rejected: this is exactly the anti-enumeration oracle `deny()` exists to close — an attacker could use it to learn which accounts exist and which have 2FA enabled, independent of guessing the password.
- **Admin/hand-seeded enrollment only** (the status quo before this PRD). Rejected as the gap this PRD exists to close — not self-service, and a standing operational burden (a human writing ciphertext by hand for every account).
- **Confirm sends the user back to the login screen instead of logging them in.** Considered and set aside (see PRD 0017's Open questions) — both factors were already proven in the confirm call itself; re-prompting adds no security, only friction.
- **Combine enroll+confirm into one endpoint** (submit a code alongside the password on first call). Rejected: a user needs to see the secret to program their authenticator app before they can produce a valid code — the two-step shape is a hard requirement of TOTP, not a design choice.

## Consequences

- The app now has **two** public, unauthenticated, password-verifying surfaces instead of one. Both must be kept in lockstep on lockout accounting and error shape — a future change to login's anti-brute-force behavior that doesn't also touch `two-factor.js` would create a mismatch attackers could exploit to tell the routes apart.
- `TWO_FACTOR_CONFIGS` gains a real pending-vs-enabled lifecycle (not just a boolean toggle by an operator): a pending row is inert everywhere else in the app (login refuses it exactly as it refused a missing row), so there is no weaker, half-protected state to defend separately. See [DATABASE.md §5](../action_plan/DATABASE.md#5-application-query-catalogue) for the upsert/enable queries this introduces.
- Enrollment secrets share the same `AES_ENCRYPTION_KEY` and `crypto.js` encrypt/decrypt path as an already-enabled secret — no separate, weaker-protected "draft" storage was introduced.
- Disabling or re-enrolling an already-enabled 2FA config, and admin-initiated enrollment, remain out of scope (both are authenticated-session flows, not this public pre-login surface) — a future PRD extending those must decide separately whether they reuse this pattern or a different one, since the user already holds a session at that point and the anti-enumeration concern above no longer applies.

## Related

- [PRD 0017 — Two-Factor Enrollment](../action_plan/0017-two-factor-enrollment.md)
- [`app/src/routes/two-factor.js`](../../app/src/routes/two-factor.js) — the routes and their anti-enumeration comments
- [`app/src/routes/session.js:49-53`](../../app/src/routes/session.js#L49-L53) — the `deny()` pattern being preserved
- [`app/src/services/session-issuer.js:134-143`](../../app/src/services/session-issuer.js#L134-L143) — `verifyTwoFactorCode`'s enforcement, unchanged
- [ADR 0006 — Append-only audit log enforcement](0006-append-only-audit-log-enforcement.md) — the same transactional-integrity concern (enable + its audit entry must commit together) applied here
