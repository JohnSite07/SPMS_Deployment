# 0014 — Password reset proves identity via TOTP, not an emailed link

- **Status:** Accepted
- **Date:** 2026-07-21
- **Deciders:** Anju Babu (with Claude), via [PRD 0020](../action_plan/0020-totp-based-password-reset.md)

## Context

PRD [0015](../action_plan/0015-password-reset-flow.md) shipped a conventional emailed single-use-token reset flow: `POST /api/password-reset/request` minted a high-entropy token (stored only as a SHA-256 hash), emailed a link via a new `EmailService`/SMTP integration, and `POST /api/password-reset/confirm` validated the token and re-hashed the master password. It was fully built and tested, but its entire premise — "prove identity by proving control of the registered email inbox" — depended on real outbound SMTP existing. PRD [0016](../action_plan/0016-smtp-provisioning-for-password-reset.md) (DevOps hand-off to provision that) was never actioned; `docs/runbooks/secret-rotation.md` confirms `smtp-username`/`smtp-password` are still literal placeholder values. `routes/password-reset.js`'s "disabled mode" — both endpoints answering `503` — was therefore the flow's permanent, live state in the deployed environment, not a transient bootstrap gap.

Every SecureVault user who can reach a reset flow at all already has enrolled 2FA (login's precondition, and self-service enrollment exists since PRD 0017/[ADR 0012](0012-two-factor-enrollment-separate-public-surface.md)). That means an alternative identity proof — a live TOTP code from the same authenticator app the user already uses to log in — was available with no new external dependency, no secret to provision, and no infrastructure to keep alive.

## Decision

Password reset proves identity with a **live TOTP code**, not an emailed token. `POST /api/password-reset/request` and `/confirm` are replaced by a single `POST /api/password-reset { email, code, newPassword }`, verified with the existing, unmodified `services/two-factor-verifier.js` — the same function `POST /api/session` and `/2fa/confirm` already use. This is a **replacement**, not an additional factor or a fallback: the emailed-link mechanism is removed, not kept alongside the new one (see PRD 0020's Scope).

Two design properties carry over unchanged from PRD 0015 and are treated as non-negotiable, not nice-to-haves:

- **Identical anti-enumeration posture.** An unknown email, an account with no *enabled* 2FA config, and a wrong TOTP code all produce the same generic `401 { error: 'invalid_credentials' }` — no failure mode leaks which case occurred, matching `session.js`'s `deny()` and `two-factor.js`'s enrollment routes.
- **Identical lockout accounting.** A wrong code counts toward the same five-failure/fifteen-minute lockout every other code-guessing surface in this app uses (`users.recordFailedAttempt`/`resetFailedAttempts`). Without this, the endpoint would be a rate-unlimited oracle for brute-forcing a 6-digit TOTP code — this is this design's core risk, and it is closed the same way login and `/2fa/confirm` already close it, not a new mechanism invented for this route.

A gap surfaced in security review that is folded into this same decision rather than treated as a separate footnote: the first implementation checked the TOTP code **before** checking `user.isLocked`, unlike `session-issuer.js`'s login path. Because a wrong code re-extends the lockout window (the property above), an unlocked-code-check ordering would have let repeated wrong-code attempts against an *already-locked* account keep pushing the 15-minute window out indefinitely — a standing availability gap once an account is locked. The fix adopted is the same rule `session-issuer.js` already applies to login: **a locked account is refused before any code is verified, full stop** — including a *correct* code. The narrower alternative (refuse only on a wrong code against a locked account, but let a correct code through and clear the lock early) was considered and rejected: it would make this route behave differently from login for the same account state, reopening exactly the kind of surface-to-surface inconsistency [ADR 0012](0012-two-factor-enrollment-separate-public-surface.md) already flagged as a standing risk across the app's password-guessing routes. "Locked means locked, regardless of which credential you present" is the simpler, more consistent rule, and now holds identically at every code-guessing surface in the app.

## Alternatives considered

- **Wait for PRD 0016 (real SMTP) and ship the email-link flow as-is.** Rejected as the reason this PRD exists: SMTP provisioning is a DevOps/infra dependency outside the app team's control, with no committed timeline, and the shipped flow could not function until it landed.
- **Keep the emailed-link flow as a fallback alongside a new TOTP option.** Rejected: two live reset mechanisms double the attack surface and the maintenance burden (two anti-enumeration paths to keep in lockstep, per the same risk noted in ADR 0012's Consequences) for no benefit — nothing in this app's threat model calls for two independent identity proofs on this one flow, and only one of them was ever going to work.
- **A recovery/backup code set (independent of TOTP), as some authenticator-based systems offer.** Not considered viable within this PRD's scope: it would be a new secret class to generate, store, and let users download/print, well beyond a mechanism swap — a candidate for a future PRD if TOTP-device loss turns out to be a real support burden, not a reason to delay this replacement.
- **Let a correct code against a locked account succeed and clear the lock** (the narrower fix for the isLocked gap). Rejected in favor of full parity with login's lockout behavior — see Decision above.

## Consequences

- Password reset now has **zero dependency on SMTP, PRD 0016, or `services/email-service.js`.** `EmailService` is confirmed unused by any route as of this PRD (grepped clean) but is deliberately left in the codebase — the domain model documents `SecurityAlert` as depending on an `EmailService`, so a future feature built to that spec would still need it. PRD 0016 itself is reframed, not abandoned: it remains a real, undone SMTP-provisioning task, just no longer one this flow blocks on (see PRD 0016's framing note).
- A user who loses access to their TOTP device (phone lost/wiped) now has **no self-service recovery path at all** — previously, email was the fallback if the authenticator was unavailable (in principle; it never worked in practice, see Context). This is a genuine trade-off, not a wash: it trades an unworkable-today mechanism for a real one, at the cost of a support case this app has no other design for. Flagged as an open gap for a future PRD (e.g. an admin-assisted or backup-code recovery path), not solved here.
- `PASSWORD_RESET_TOKENS` and `ports/password-reset-store.js` are now genuinely dead — no route writes to them. Dropping the table is intentionally left to a separate, deliberate migration PRD (schema changes are never bundled into an app-behavior PRD in this project), not implied by this decision.
- Every password-guessing surface in the app (`POST /api/session`, `/2fa/enroll`, `/2fa/confirm`, and now `/api/password-reset`) shares one lockout-and-denial contract. A future change to any one of them that doesn't audit the others for the same isLocked-before-verify ordering risks silently reopening the exact gap this PRD's review caught.

## Related

- [PRD 0020 — TOTP-Based Password Reset](../action_plan/0020-totp-based-password-reset.md)
- [PRD 0015 — Password Reset Flow](../action_plan/0015-password-reset-flow.md) (superseded)
- [PRD 0016 — SMTP Provisioning for Password-Reset Email](../action_plan/0016-smtp-provisioning-for-password-reset.md) (reframed; no longer blocking)
- [ADR 0012 — Two-factor enrollment as a separate public, pre-session surface](0012-two-factor-enrollment-separate-public-surface.md) — the precedent this PRD's lockout/anti-enumeration parity follows, and the "must be kept in lockstep" risk this decision's Consequences extends to a third route.
- [`app/src/routes/password-reset.js`](../../app/src/routes/password-reset.js) — the route, including the `isLocked` check and its reasoning in code comments.
- [`app/src/services/two-factor-verifier.js`](../../app/src/services/two-factor-verifier.js) — reused unmodified.
- [`app/src/services/session-issuer.js`](../../app/src/services/session-issuer.js) — the login-path `isLocked` precedent this route now matches exactly.
