# 0006 — Enforcing the append-only audit log in application code

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** Anju Babu (with Claude)

## Context

Business rule 7 states that the audit log is append-only and cannot be edited by users; the M3 domain model adds that "the schema and access layer must forbid update/delete." Neither says *where* that is enforced, and the phrase "append-only" is ambiguous in an important way: it can mean "users may append but not edit", or "the log is written only as a side effect of doing something".

The distinction matters. A user who can `POST` an entry can record an action they never took. That corrupts the log as thoroughly as editing one, and is the easier attack — no existing entry has to be found first.

An audit trail is also only as good as its atomicity. A credential stored without its entry is an unlogged action; an entry for a credential whose transaction rolled back is a lie. Both corrupt the log, in opposite directions.

## Decision

Append-only is enforced at four layers, each of which stands alone:

1. **The entry object.** `createAuditEntry()` returns a frozen object with no setters. `timestamp` is exposed through a getter returning a fresh `Date` per read, because `Object.freeze` does not reach a `Date`'s internal slot — a stored `Date` could be rewritten in place by anyone holding the entry. The writer cannot choose `entryId` or `timestamp`: an append-only log whose writer picks the primary key is an upsert, and one whose writer picks the clock can backdate an action to before the breach it caused.
2. **The service.** `services/audit-log.js` exposes `logAction`, `forRequest`, `forSystem` — and no update, delete, or bulk write. It is the only writer. It never swallows an append failure and never retries.
3. **The API.** `/api/audit` and `/api/admin/audit` answer **405 Method Not Allowed** with an `Allow: GET, HEAD, OPTIONS` header to `POST`, `PUT`, `PATCH` and `DELETE` — including `POST`, per the reading above. `OPTIONS` still answers 204 so CORS preflight works for a read-only client.
4. **Atomicity.** `logAction` takes an opaque `context`, forwarded to the store's `append`, so a route hands down the transaction its own write is running in. The credential and its entry commit together or neither does. If the entry cannot be written, the action does not stand: the credential is not created, the edit does not land, the deleted credential survives, the logout leaves the session live.

For reads, ordering gives the same guarantee without a transaction: the entry is written *before* the plaintext-bearing response is sent, so an access that cannot be logged is not disclosed.

**405, not 403.** 403 means "you are not allowed to do this", which implies a sufficiently privileged caller would be — and there is none. 405 means the method does not exist on this resource for anyone, which is the guarantee business rule 7 actually makes. (Contrast `middleware/require-role.js`, where an owner at an admin route correctly gets 403: that route exists, and a different caller *would* be let through.)

## Alternatives considered

- **Enforce only in the database** (`GRANT INSERT, SELECT` on `AUDIT_ENTRIES`, no `UPDATE`/`DELETE`) — necessary but not sufficient on its own: it gives no defence against the application appending a forged entry, and it fails late, as a database error rather than a 405. It remains outstanding work (see Consequences).
- **Allow `POST /api/audit` for clients that want to record their own events** — rejected: a forged entry is at least as damaging as an edited one.
- **Best-effort audit writes (log the failure, let the action succeed)** — rejected. An unlogged action is worse than a failed one. The five-failure lockout counts entries, so a suppressible audit write is an unlimited brute-force budget.
- **A free-form `details` bag on the entry** — rejected. It is where plaintext credentials eventually land, in a system built so the server never holds them.

## Consequences

- Every route that writes to the vault now depends on the audit store being reachable. An audit outage is an outage: writes fail with 500 rather than proceeding unlogged. This is intended.
- An un-`await`ed `logAction()` is the one remaining footgun: its rejection becomes an `unhandledRejection`, which kills the container on Node ≥ 20 — but only *after* the route has already answered 200. Every route wraps handlers in `asyncRoute()` so this cannot happen silently; the trap is documented at the top of `services/audit-log.js` and pinned by a test.
- `tests/audit-immutability.test.js` asserts the whole claim rather than one surface at a time: every language mutation primitive against every discovered field, the module surfaces, and an exhaustive sweep of 7 HTTP methods × 9 routes × 3 identities (189 requests) carrying payloads that name a real `entryId` and attempt prototype pollution. The invariant is that an entry seen before a request serialises identically after it.
- **Outstanding:** the database-level grant is not yet applied. Until `AUDIT_ENTRIES` is `INSERT`/`SELECT`-only for the app user, code that bypasses these modules can still rewrite history. Flagged as a Developer-team schema concern in [PRD 0002](../action_plan/0002-network-and-data.md) and carried forward in [PRD 0008](../action_plan/0008-audit-log-and-vault-routes.md).
