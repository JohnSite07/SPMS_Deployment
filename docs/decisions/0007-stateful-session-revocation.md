# 0007 — Stateful session revocation for logout

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** Anju Babu (with Claude)

## Context

Session tokens are stateless JWTs. `token-service.js` already carried a `jti` claim "so a token can be tied to a revocable session row on logout or vault lock" — but no session store existed, so nothing was revocable.

That leaves "log out" meaning only *the client discards its token*. A token captured before logout keeps working until its idle window lapses (up to 10 minutes, business rule 5) or the 12-hour absolute cap. The user is told their session ended; it did not.

M3 defines no logout use case, so this decision has no requirement behind it to appeal to.

## Decision

Introduce a `sessions` port with `isRevoked(sessionId)`, checked by the auth middleware on **every** authenticated request. `DELETE /api/session` revokes the row and records a `session.ended` entry, both in one transaction. The token dies immediately, including the renewed sliding-window token the middleware handed out on the same request.

Three supporting rules, each of which closes a hole the naive version leaves open:

- **A token with no `jti` is refused.** It names no session, so logout could never revoke it — it would outlive every logout for its full idle window. Nothing the login route mints lacks one.
- **A session the store has never seen is treated as revoked**, not as fine. Otherwise a token naming a session whose row was rolled back (a login whose audit write failed) would be honoured until expiry, punching a hole in revocation exactly the size of a failed login transaction.
- **A session store that throws produces a 500, not a pass-through.** The revocation check is awaited before the route runs and before the sliding-window headers are set; its error goes to `next(err)`. An unreachable session store must not become an authentication bypass.

`sessions` is a required argument to `createAuthMiddleware()`, with no default. A stub answering `false` would let a caller who forgot to wire the store keep serving revoked tokens, and the failure would be invisible.

## Alternatives considered

- **Advisory logout** — write the `session.ended` entry, return 204, revoke nothing. Cheap and honest only if documented as such, but it means "log out" does not end the session. Rejected: a password manager is exactly the application where a stolen token must stop working when the user says stop.
- **Short-lived tokens with no revocation** — reduces but does not remove the window, and the idle window is already pinned to the 10-minute auto-lock by business rule 5.
- **A denylist of revoked `jti`s in memory** — does not survive a Cloud Run scale-to-zero, and revocation that forgets is not revocation.

## Consequences

- Every authenticated request now costs one session-store lookup. On Cloud SQL over the private VPC path this is the request's second round trip. If it becomes a cost or latency problem, the mitigation is a short-TTL cache — bounded by the fact that a cached "not revoked" answer re-opens the window it exists to close.
- Logout is not idempotent in the audit log: it writes one `session.ended` entry per successful call, and a second call with the same (now revoked) token is a 401 that writes nothing.
- If the logout cannot be logged, the session stays live and the caller gets a 500. Reporting a successful logout that did not happen is the worse failure.
- The `sessions` port is unimplemented (`config/unimplemented-ports.js` throws on every method). The deployment skeleton still serves `/health`; every authenticated route answers 500 rather than pretending.
