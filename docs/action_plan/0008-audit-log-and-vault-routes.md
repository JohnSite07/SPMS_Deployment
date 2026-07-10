# 0008 — Audit Log, Vault Routes, and Admin History View

Implements the append-only audit log and the application routes that write to it.

| | |
| --- | --- |
| **Status** | Done (retrospective — see note) |
| **Date** | 2026-07-09 |
| **Author** | Anju Babu (with Claude) |

> **Retrospective PRD.** [`.claude/rules/action-plan.md`](../../.claude/rules/action-plan.md) requires a PRD to be written and approved *before* execution starts. This work was executed first, as a sequence of directed changes in a single session, and this document was written afterwards to close the gap. It is recorded here rather than backdated. The two architectural forks encountered mid-flight (the admin role; how to audit an admin's read) *were* put to the user before implementation, and are captured in [ADR 0008](../decisions/0008-in-app-admin-role.md). No GCP resource was created and no billable command was run.

## User story

As a SecureVault user, I want every action against my vault recorded in a log that nobody — not me, not an administrator, not the application — can edit or delete, so that I can trust what it says. As a System Administrator, I want to read a user's history, so that I can investigate an incident.

## Scope

**In scope:**
- The `AuditEntry` domain model and its append-only guarantees.
- A reusable `logAction()` writer, transaction-aware.
- Vault routes that call it: login, add, view, edit, delete, logout.
- Append-only enforcement at the API layer (405 on all mutating methods).
- The user-facing activity view with keyset pagination.
- The administrator's view of any user's history, itself audited.
- Stateful session revocation, since logout had nothing to revoke ([ADR 0007](../decisions/0007-stateful-session-revocation.md)).

**Out of scope:**
- **All persistence.** No MySQL schema, no SQL, no migrations. Every store is an injected port; `config/unimplemented-ports.js` throws on use so the skeleton still serves `/health`.
- **All cryptography.** The client sends `encryptedPassword` as ciphertext; the server stores what it is given. No AES code was written.
- Documents (`SecureDocument`), password health, the generator, 2FA implementation — stubs only where a route needed one.
- Any Terraform, GCP, or pipeline change.

## Success criteria

- [x] `npm test` passes (423 tests, 14 suites).
- [x] `npm run lint` exits 0.
- [x] `node src/server.js` boots and `GET /health` returns 200 with no storage wired.
- [x] No HTTP method, route, identity, or payload can alter an entry that already exists.
- [x] A vault write whose audit entry fails leaves no trace of the write.
- [x] An admin's read of a user's history appears in that user's own activity view.
- [x] An owner receives 403, not data, at an admin route.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `app/src/models/audit-entry.js` | New — domain model | None (no infra) |
| `app/src/services/audit-log.js` | New — the only writer | None |
| `app/src/routes/{credentials,session,audit,admin-audit,pagination}.js` | New — HTTP surface | None |
| `app/src/middleware/require-role.js` | New — 403 for non-admins | None |
| `app/src/config/unimplemented-ports.js` | New — fail-loud stubs | None |
| `app/src/{app,server}.js`, `middleware/authenticate.js`, `services/token-service.js` | Modified | None |
| `app/tests/**` (8 new files, 2 modified) | Tests | None |
| `AUDIT_ENTRIES` table | **Not created** — Developer-team schema work | Within existing Cloud SQL instance |

References: [ADR 0006](../decisions/0006-append-only-audit-log-enforcement.md) · [ADR 0007](../decisions/0007-stateful-session-revocation.md) · [ADR 0008](../decisions/0008-in-app-admin-role.md) · [domain-model.md](../architecture/domain-model.md) · business rules 1, 4, 5, 6, 7 in [functional-requirements.md](../requirements/functional-requirements.md).

## Scripts / commands

```bash
# Nothing billable, nothing destructive. No gcloud, no terraform.
cd app
npm test          # 423 tests
npm run lint      # eslint, exits 0
JWT_SIGNING_KEY=<64 chars> node src/server.js   # boots; /health -> 200
```

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| All implementation | main session | Model, service, routes, middleware, tests | — |
| Documentation | main session | This PRD, ADRs 0006–0008, domain-model update | — |

> The `documentation-keeper` agent is the designated owner of `docs/` per [`documentation.md`](../../.claude/rules/documentation.md), but was not available in this session's agent registry; the main session wrote these docs directly. A `documentation-keeper` audit pass over ADRs 0006–0008 and the domain-model edit is the natural follow-up.

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| Test suite passes | `npm test` | 423 passed, 14 suites |
| Lint clean | `npm run lint` | exit 0 |
| Skeleton still deploys | `node src/server.js`; `curl /health` | `200 {"status":"ok"}` |
| No path mutates an entry | `tests/audit-immutability.test.js` | 44 tests; sweep of 7 methods × 9 routes × 3 identities = 189 requests |
| Unlogged action does not stand | `credential-routes.test.js`, `session-routes.test.js` | write rolls back; 500 returned |
| Admin read is visible to the user | `admin-audit-routes.test.js` | `audit_log.read` with `actorUserId` in the user's `/api/audit` |
| Owner blocked from admin routes | `admin-audit-routes.test.js` | 403 `{"error":"forbidden"}` |

The immutability sweep was itself falsified before being trusted: a mutation was injected mid-run (a stored row replaced with one whose `userId` was `"attacker"`), the test failed and named the offending request, and the injection was reverted.

## Additional considerations

- **Security posture — improved:** append-only enforced at four layers; session revocation now real; ownership checks pushed down into the store signatures (`business rule 6`); failed logins counted toward the lockout.
- **Security posture — regressed:** admitting `ROLES.ADMIN` removed a defence in depth. See [ADR 0008](../decisions/0008-in-app-admin-role.md), Consequences. Recommended hardening: a separate admin token audience.
- **Rollback / teardown:** application code only. No GCP resource was created, so `terraform destroy` is unaffected. Reverting is a `git revert` of the commit.
- **Open questions / follow-up work:**
  1. **`trust proxy` is unset** (`app/src/app.js`, `TODO(audit)`). `req.ip` is the socket peer — under Cloud Run the Google front end, locally `::ffff:127.0.0.1`. **Every `ipAddress` currently recorded is the proxy's, not the client's.** Do *not* fix with `trust proxy: true`: that takes the client-supplied left-most `X-Forwarded-For` entry, letting an attacker choose what the audit log says about them. The correct hop count must be confirmed against a deployed revision.
  2. **Database-level append-only is not applied.** `GRANT INSERT, SELECT` (no `UPDATE`, no `DELETE`) on `AUDIT_ENTRIES` for the app user. Until then, code bypassing these modules can rewrite history.
  3. **Device sightings are not audited.** `issueSessionToken()` calls `onDeviceSeen` synchronously and discards its return value; binding it to the async writer would produce an unawaited promise. Fixing it means making that method `async`.
  4. **M3 owes three use cases:** `credential.updated`, `credential.deleted`, `session.ended` are implemented but appear in no use case or event in the requirements.
  5. Admin page-reads write one entry pair per page into the read user's activity view.
- **Dependencies:** the Developer team owns the MySQL schema behind every port defined here, and the AES-256 encryption the routes assume has already happened client-side.

## Outcome

Delivered as scoped, with two mid-flight architectural forks escalated to the user rather than decided unilaterally: whether to introduce an in-app `admin` role (chosen: yes, in-app), and how to audit an admin's read (chosen: two entries, one in each log). Both are recorded in ADR 0008.

Three deviations from the original request, each surfaced at the time:

1. "Call `logAction()` from login/add/view/edit/delete/logout" required *building* those flows — none existed. They were built over injected ports rather than by inventing a storage layer.
2. "Enforce append-only" was interpreted as the **audit log**, not credentials; credential edit and delete remain, having been explicitly requested one step earlier.
3. The admin view could not be built without adding a role that three security tests relied on being absent. Those tests were retargeted, and the cost is recorded in ADR 0008.

423 tests, 14 suites, lint clean, skeleton boots.
