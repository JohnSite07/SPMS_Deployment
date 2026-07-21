# 0013 — Duplicate-email disclosure on registration as a deliberate anti-enumeration exception

- **Status:** Accepted
- **Date:** 2026-07-21
- **Deciders:** Anju Babu (with Claude), via [PRD 0018](../action_plan/0018-welcome-and-registration.md)

## Context

Every existing password-guessing surface in this codebase — `POST /api/session` ([session.js:49-53](../../app/src/routes/session.js#L49-L53)'s `deny()`), `POST /api/2fa/enroll`/`confirm` ([ADR 0012](0012-two-factor-enrollment-separate-public-surface.md)), and `POST /api/password-reset/*` — deliberately answers with the same generic failure regardless of whether the email exists, so an anonymous caller can never learn which addresses have an account. This is a strong, consistently applied pattern.

PRD 0018 added `POST /api/register`, the first endpoint whose entire purpose is *claiming* a new identity rather than proving one. A literal application of the existing pattern would have it silently "succeed" (or return a generic error) when the submitted email already has an account — but that produces a confusing signup UX (the visitor never learns why nothing happened) for no matching security benefit: registering against a real email discloses nothing an attacker doesn't already possess (the email address itself), unlike a login/2FA oracle which turns "is this email registered" into new information extracted one request at a time.

## Decision

`POST /api/register` answers an already-registered email with `409 { error: 'email_already_registered' }` — a real, honest state — rather than the generic-failure shape used by every other public, credential-verifying route in this codebase. This is intentional and applies **only** to this route.

The check happens before any password-strength validation or write, so a duplicate-email request creates nothing and costs nothing beyond the lookup ([register.js](../../app/src/routes/register.js)).

## Alternatives considered

- **Generic failure, matching login/2FA/password-reset's posture** (e.g. always `202`-style "check your email" or a non-specific error). Rejected: registration is not an authentication oracle — there is no password being tested against a real account, so the anti-enumeration rationale that justifies `deny()` elsewhere doesn't transfer. A generic response here would only make the signup form confusing, with no attacker capability removed.
- **Silently succeed and email the existing owner** ("someone tried to register your address"). Rejected as out of scope: `services/email-service.js` isn't wired into registration in PRD 0018 (see that PRD's Out of scope on email verification), and this would add a second undelivered notification path for no immediate requirement.

## Consequences

- `POST /api/register` is the one public route in this codebase that reveals account existence by design. Any future change that generalizes error-handling middleware or response shapes across public routes must explicitly exclude or account for this route, or it will silently re-introduce/remove the intended behavior.
- The 409 is gated on nothing but a plain `SELECT ... WHERE email = ?` — no password proof is required to trigger it, unlike `/2fa/enroll`'s `409 two_factor_already_enabled` (ADR 0012), which is only reachable after a correct password. This is acceptable here because the fact being disclosed (an email is registered) is the same fact the visitor is trying to establish by registering, not a fact about someone else's credentials.
- If SecureVault ever adds email verification (flagged as a reasonable follow-up in PRD 0018's Out of scope) or moves toward a more sensitive/multi-tenant posture, this decision should be revisited — those contexts have a stronger case for not confirming address existence pre-verification.

## Related

- [PRD 0018 — Welcome/Landing Page & Self-Service Account Registration](../action_plan/0018-welcome-and-registration.md)
- [ADR 0012 — Two-factor enrollment as a separate public, pre-session surface](0012-two-factor-enrollment-separate-public-surface.md) — the parallel precedent of a reasoned, narrow exception to this codebase's anti-enumeration default.
- [`app/src/routes/register.js`](../../app/src/routes/register.js) — the route and its header comment reasoning through this exact call.
- [`app/src/routes/session.js:49-53`](../../app/src/routes/session.js#L49-L53) — the `deny()` pattern this route deliberately does not use.
