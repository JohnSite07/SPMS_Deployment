# 0009 — Storage Layer & Auth Wiring

Replaces the fail-loud port stubs with real MySQL-backed adapters and the two auth crypto callbacks, so login and the vault routes actually function against Cloud SQL.

| | |
| --- | --- |
| **Status** | Draft |
| **Date** | 2026-07-10 |
| **Author** | htuazon (with Claude) |

> **Written before execution**, per [`.claude/rules/action-plan.md`](../../.claude/rules/action-plan.md) — the approval gate applies. This is the counterpart to [0008](0008-audit-log-and-vault-routes.md): 0008 built the audit log and routes over *injected ports that throw*; this PRD implements those ports. It is **Developer-team-owned application work** (the MySQL schema and app data layer per [functional-requirements.md](../requirements/functional-requirements.md)), recorded here because it touches the deployed app and the existing Cloud SQL instance.

## User story

As a SecureVault user, I want to actually log in with my master password and 2FA and have my vault and audit history persist, so that the application does what it claims rather than returning 500 on every route that touches storage.

## Scope

**In scope:**
- A single MySQL connection module (connection pool over `mysql2`, reading the DB env contract already loaded in [config/env.js](../../app/src/config/env.js)) with one `transaction(fn)` helper shared by every port.
- Real adapters for the four ports [config/unimplemented-ports.js](../../app/src/config/unimplemented-ports.js) currently stubs: `users`, `sessions`, `credentials`, `auditReader` — matching the exact method signatures and behaviours of [tests/helpers/fake-database.js](../../app/tests/helpers/fake-database.js), which is the reference spec.
- The two auth crypto callbacks wired in [server.js](../../app/src/server.js): `verifyPassword` (**bcrypt** hash compare) and `verifyTwoFactorCode` (TOTP verification via **`otplib`** against `user.twoFactorConfig`).
- A real `audit.append` writing to `AUDIT_ENTRIES`.
- The device-sighting fix: make `issueSessionToken()` `async` so `onDeviceSeen` can be bound to the async audit writer without producing an unawaited promise (open item 3 in [0008](0008-audit-log-and-vault-routes.md#L100)).
- **A schema already exists**, so this PRD does **not** create tables. It verifies the existing `USERS`, `SESSIONS`, `CREDENTIALS`, and `AUDIT_ENTRIES` columns/shapes align with the port signatures in [tests/helpers/fake-database.js](../../app/tests/helpers/fake-database.js); any mismatch is reconciled (adapter mapping, or a small additive migration) and surfaces in the contract tests.
- The DB-level append-only grant: `GRANT INSERT, SELECT` (no `UPDATE`/`DELETE`) on `AUDIT_ENTRIES` for the app user (open item 2 in [0008](0008-audit-log-and-vault-routes.md#L99)).
- A port-contract test suite run against **both** the in-memory fake and a **dedicated `securevault_test` database on the real Cloud SQL instance** (isolated rows, set up and torn down by the suite), so the real adapters are proven to satisfy the same contract the routes are tested against without touching real vault data.

**Out of scope:**
- **Client-side AES-256 vault encryption.** Routes already assume ciphertext arrives; the server stores `encryptedPassword` as given. No crypto for vault *contents*.
- **`SecureDocument` / Cloud Storage blob paths**, password health, the generator — not required to make login and credential CRUD work.
- **2FA enrolment / secret provisioning.** This wires *verification* of an existing `twoFactorConfig`; how a user sets up 2FA is a separate flow.
- **The `trust proxy` / audit `ipAddress` fix** (open item 1 in [0008](0008-audit-log-and-vault-routes.md#L98)) — requires a deployed revision to confirm the hop count; tracked separately.
- Any Terraform module change. The Cloud SQL instance already exists (PRD [0002](0002-network-and-data.md)); this adds no GCP resource.

## Success criteria

- [ ] `POST /api/session` with valid email + master password + 2FA code returns `201 { token, sessionId }` against a live MySQL, and a `LOGIN_SUCCEEDED` row lands in `AUDIT_ENTRIES`.
- [ ] Wrong password returns `401 invalid_credentials`, writes a `LOGIN_FAILED` row, and increments `failed_attempts`; the 5th consecutive failure sets `is_locked` and further attempts are refused before the hash is touched.
- [ ] `DELETE /api/session` revokes the session; the next request with that token gets `401` (`Session ended`).
- [ ] A credential write whose audit entry fails leaves **no** credential row (transaction spans both tables and rolls back).
- [ ] `sessions.isRevoked` returns `true` for a session id the store has never seen (fail-closed), not `false`.
- [ ] `npm test` passes, including the new port-contract suite run against the `securevault_test` database on the real Cloud SQL instance.
- [ ] `npm run lint` exits 0.
- [ ] `UPDATE`/`DELETE` on `AUDIT_ENTRIES` as the app user is rejected by MySQL, not merely by application code.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `app/src/db/pool.js` (or similar) | New — mysql2 pool + `transaction()` | None (uses existing instance) |
| `app/src/ports/{users,sessions,credentials,audit-reader}.js` | New — real adapters | None |
| `app/src/services/password-hasher.js` (bcrypt), `two-factor-verifier.js` (otplib) | New — `verifyPassword`, `verifyTwoFactorCode` | None |
| `app/src/services/audit-log.js` | Modified — real `append` | None |
| `app/src/services/session-issuer.js` | Modified — `issueSessionToken` → async | None |
| `app/src/server.js` | Modified — wire real ports + callbacks | None |
| `app/src/config/unimplemented-ports.js` | Retained as fallback / removed from server boot | None |
| `app/tests/ports/*.contract.test.js` | New — contract suite (fake + real) | None |
| `USERS`, `SESSIONS`, `CREDENTIALS`, `AUDIT_ENTRIES` tables | **Existing** — verified against port signatures, not created | Within existing `db-f1-micro` — no new resource |
| New npm deps: `mysql2`, `bcrypt`, `otplib` | Runtime deps | None (image size only) |

References: [tests/helpers/fake-database.js](../../app/tests/helpers/fake-database.js) (contract spec) · [audit-entries-schema.md](../architecture/audit-entries-schema.md) · [domain-model.md](../architecture/domain-model.md) · [0008](0008-audit-log-and-vault-routes.md) · [ADR 0006](../decisions/0006-append-only-audit-log-enforcement.md) · [ADR 0007](../decisions/0007-stateful-session-revocation.md) · business rules 1, 4, 5, 6, 7 in [functional-requirements.md](../requirements/functional-requirements.md).

## Scripts / commands

```bash
cd app
npm install mysql2 bcrypt otplib      # runtime deps

# Schema already exists — no DDL. Verify alignment and apply the append-only
# grant over the dev-phase public IP (PRD 0007) or Cloud SQL Studio (ADR 0004).
# GRANT INSERT, SELECT ON securevault.AUDIT_ENTRIES TO '<app-user>'@'%';  # append-only at DB layer
# REVOKE UPDATE, DELETE ON securevault.AUDIT_ENTRIES FROM '<app-user>'@'%';

npm test          # unit + new port-contract suite (fake + real MySQL)
npm run lint      # eslint, exit 0
JWT_SIGNING_KEY=<64 chars> DB_* =<...> node src/server.js   # boots against live DB
```

> Nothing billable is created. `mysql`/DDL run against the **already-provisioned** instance. The dev-phase public IP must be flipped back before the presentation (see [db-public-access.md](../runbooks/db-public-access.md)).

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| Schema reconciliation | main session | Confirm existing tables vs. port signatures; author DDL only if absent | Column map to adapter step |
| Port + crypto implementation | main session (or a backend agent) | mysql2 pool, four adapters, two crypto callbacks, async `issueSessionToken` | Wired `server.js` |
| Contract tests | main session | Extract shared contract; run against fake + the `securevault_test` database | Green suite |
| Review | infra-reviewer | Security/atomicity pass: fail-closed revocation, transaction spanning, append-only grant | Findings |
| Documentation | documentation-keeper | ADR for hashing/TOTP choices; update handover; mark 0008 open items 2 & 3 closed | — |

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| Login works end-to-end | `POST /api/session` (valid) against the `securevault_test` database | `201 { token, sessionId }`; `LOGIN_SUCCEEDED` row present |
| Failed login + lockout | 5× wrong password | 5× `401`; `failed_attempts`→5; `is_locked`=1; `LOGIN_FAILED` rows |
| Logout revokes | `DELETE` then reuse token | `204`, then `401 Session ended` |
| Atomic rollback | contract test with `failAppendOn` | credential absent after failed append |
| Fail-closed revocation | `isRevoked('never-seen')` | `true` |
| Real adapters satisfy contract | `npm test` (contract suite vs real MySQL) | all pass |
| Lint clean | `npm run lint` | exit 0 |
| DB-level append-only | `UPDATE AUDIT_ENTRIES ...` as app user | MySQL error 1142 (denied) |

The contract suite is the core of this plan: the same assertions that pass against [fake-database.js](../../app/tests/helpers/fake-database.js) today must pass against the real adapters, which is what proves the wiring is behaviour-preserving rather than merely present.

## Additional considerations

- **Security posture:** the five load-bearing behaviours from the fake must survive the port to SQL — (1) `isRevoked` fails closed on unknown/rolled-back sessions; (2) `transaction()` is a real `BEGIN/COMMIT/ROLLBACK` spanning credential + audit tables; (3) lockout at 5 attempts lives in the store; (4) ownership (`WHERE user_id = ?`) is enforced in every credential query, not only the route; (5) keyset pagination uses `(timestamp, entry_id)` as a total order. Password hashing must be a real KDF (bcrypt/argon2), never a plain hash. TOTP verification must allow a small time-step window but reject replay per business rule intent.
- **Rollback / teardown:** application code + additive DDL. No GCP resource created, so `terraform destroy` is unaffected. Reverting app code is a `git revert`; dropping the tables is manual but the instance itself is untouched.
- **Decided:**
  1. **Schema already exists** — this PRD verifies alignment rather than creating tables; risk is column-name/shape mismatches, which the contract tests catch.
  2. **bcrypt** for the master-password KDF; **`otplib`** for TOTP verification.
  3. **The contract suite runs against the real Cloud SQL instance** (not a throwaway container), but in a **dedicated `securevault_test` database on that same instance** — same server and credentials, isolated rows, created and torn down by the suite so real vault data is never touched. Implications: the test runner needs DB credentials and a network path (the dev-phase public IP, [PRD 0007](0007-temporary-public-db-access.md)), so tests run only while public access is on; wiring this into `ci.yml` is a pipeline-PRD follow-up.
- **Dependencies:** the master-password hashes and `twoFactorConfig` rows the verifiers check must exist in `USERS` — i.e. a registration/enrolment flow (out of scope here) or seeded test rows. This closes 0008 open items **2** (DB append-only grant) and **3** (device-sighting audit); item **1** (`trust proxy`) remains deferred.

## Outcome

_Filled in after execution: what happened, deviations from plan, links to resulting ADRs/runbooks/docs._
