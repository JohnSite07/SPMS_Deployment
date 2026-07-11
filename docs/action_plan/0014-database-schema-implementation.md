# 0014 — Database Schema Capture & Reconciliation Migration

Bring the SecureVault schema — currently hand-applied to Cloud SQL through the console and un-version-controlled — into the repo as checked-in SQL, and apply an **in-place ALTER migration** that reconciles the three tables that disagree with the application code, so the storage adapters in PRD [0009](0009-storage-layer-and-auth-wiring.md) build on a schema that matches the backend.

| | |
| --- | --- |
| **Status** | Draft |
| **Date** | 2026-07-11 |
| **Author** | Main session (orchestrator), on behalf of @Anjuuuzzz |

## User story

As the SecureVault operator, I want the live database schema captured as version-controlled SQL and reconciled with what the app actually writes, so that the schema is reproducible from the repo and the storage layer (PRD 0009) connects to tables that match the backend — instead of a schema that exists only inside a console session nobody can reproduce.

The `securevault` database on `spms-mysql` **already has all 11 tables** — but they were created **by hand in Cloud SQL Studio**, not from any script. There is **no `.sql` file, no migration, no `db/` folder** in the repo, and Terraform provisions only the empty database + app user ([terraform/modules/data/main.tf:50-61](../../terraform/modules/data/main.tf#L50-L61)). So the schema is *applied but not reproducible*, and — confirmed by `SHOW CREATE TABLE` — the live tables are the **un-reconciled** DATABASE.md shape: none of the three fixes the code needs (from PRD [0008](0008-audit-log-and-vault-routes.md)) are present, and there is already seed data (`USERS AUTO_INCREMENT=3`). This PRD captures what exists and migrates it into agreement with the code.

## Scope

**In scope:**

- **Capture the current live schema** into a checked-in baseline (`app/db/migrations/0001_baseline.sql`) — the exact `SHOW CREATE TABLE` shape as applied today — so the repo has a reproducible starting point and the migration's "before" state is recorded.
- **A reconciling migration** (`app/db/migrations/0002_reconcile_audit_sessions_users.sql`) — **in-place `ALTER`s, preserving the seed rows** (approach chosen 2026-07-11; see *Reconciliation* below). `entry_id` **stays `INT AUTO_INCREMENT`** — consistent with the other 10 `INT`-PK tables the adapter already coerces:
  - `USERS` — `ADD COLUMN is_deleted TINYINT(1) NOT NULL DEFAULT 0` (soft-delete; the corollary of the audit FK becoming `RESTRICT`).
  - `SESSIONS` — `DROP INDEX IX_SESSIONS_TOKEN_HASH`, `DROP CHECK CK_SESSIONS_TOKEN`, `DROP COLUMN token_hash` (revocation is `sessionId`/`jti`-based — ADR [0007](../decisions/0007-stateful-session-revocation.md); the app never stores a token hash).
  - `AUDIT_ENTRIES` — `ADD COLUMN target_user_id INT NULL` + `actor_user_id INT NULL`; add `FK_AUDIT_TARGET` / `FK_AUDIT_ACTOR` (`ON DELETE RESTRICT`); swap `FK_AUDIT_USERS` from `ON DELETE CASCADE` to `ON DELETE RESTRICT`; add `CK_AUDIT_ASSOC`; `MODIFY event_time DATETIME(3)`. **`entry_id` unchanged** (kept `INT`).
- **`grants.sql`** — least-privilege `spms_app`: full DML on the 10 tables, **`INSERT`/`SELECT`-only on `AUDIT_ENTRIES`** (the append-only guarantee, ADR [0006](../decisions/0006-append-only-audit-log-enforcement.md)).
- **A `migrate.js` runner** (`mysql2`) that applies the `migrations/` files **in order, tracking applied versions** in a `schema_migrations` table so a re-run is a no-op — the lightweight versioned-migration layout, chosen because tables now exist and future changes must be incremental `ALTER`s, not create-scripts.
- **`seed.sql` + `seed.js`** — dev data (`seed.js` = real AES-256-GCM + bcrypt via `mysql2`, per DATABASE.md's appendix), plus **`verify_integrity.sql`** adjusted for the `RESTRICT` + soft-delete model.
- **Apply the migration + grants to the live Cloud SQL instance** (dev phase), via Cloud SQL Studio (console) or the Auth Proxy under PRD [0007](0007-temporary-public-db-access.md) access.
- **Verify** the reconciled shape (`SHOW CREATE TABLE`) and the exact grant (`SHOW GRANTS`).

**Out of scope:**

- **The MySQL adapters and crypto callbacks** — PRD [0009](0009-storage-layer-and-auth-wiring.md), which *depends on* this PRD. `queries.sql` is reference material for those adapters, not applied DDL.
- **Changing `entry_id` to `CHAR(36)`** — considered and declined (keeps consistency with the other `INT`-PK tables; see *Reconciliation §Audit id*).
- **Automating migration in CD for the private (post-0007) posture** — a one-shot Cloud Run Job with Direct VPC egress is the target mechanism; follow-up.
- **Moving grants into Terraform** — Cloud SQL's provider does not manage table-level grants; `migrate`/`grants.sql` re-application is the mechanism, re-run after any re-provision. Follow-up.
- **Application features** — 2FA enrolment, health scans, document upload, generator. Later PRDs.
- **No new GCP resource, no tier change.** The instance and its tables already exist; this PRD only alters tables + applies grants.

## Success criteria

- [ ] `app/db/migrations/0001_baseline.sql`, `0002_reconcile_*.sql`, `grants.sql`, `seed.sql`, `seed.js`, `verify_integrity.sql`, and `migrate.js` are checked into the repo.
- [ ] `migrate.js` is re-runnable: a second `npm run migrate` applies nothing (all versions already in `schema_migrations`) and exits 0.
- [ ] After migration, `SHOW CREATE TABLE AUDIT_ENTRIES` shows `target_user_id` + `actor_user_id`, `event_time DATETIME(3)`, `FK_AUDIT_USERS`/`FK_AUDIT_TARGET`/`FK_AUDIT_ACTOR` all `ON DELETE RESTRICT`, and `CK_AUDIT_ASSOC` — with `entry_id` still `INT AUTO_INCREMENT`.
- [ ] `SHOW CREATE TABLE SESSIONS` has **no** `token_hash`; `SHOW CREATE TABLE USERS` has `is_deleted`.
- [ ] `SHOW GRANTS FOR 'spms_app'@'%'` shows `SELECT, INSERT` on `AUDIT_ENTRIES` (no `UPDATE`/`DELETE`) and full DML on the other 10 tables — nothing more.
- [ ] The pre-existing seed rows survive the migration (`SELECT COUNT(*) FROM USERS` unchanged before/after) — proving it was a non-destructive `ALTER`, not a rebuild.
- [ ] `CK_AUDIT_ASSOC` bites: an `INSERT` into `AUDIT_ENTRIES` with a non-`audit_log.read` action but a non-null `target_user_id` is rejected (negative check).
- [ ] `verify_integrity.sql` reports 0 orphan rows under the soft-delete/`RESTRICT` model.
- [ ] `seed.js`-produced ciphertext decrypts with `AES_ENCRYPTION_KEY` (crypto round-trips end-to-end).

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `app/db/migrations/0001_baseline.sql` | New — captured current live DDL | $0 |
| `app/db/migrations/0002_reconcile_audit_sessions_users.sql` | New — the reconciling `ALTER`s | $0 |
| `app/db/grants.sql` | New — least-privilege append-only grants | $0 |
| `app/db/migrate.js` | New — versioned `mysql2` runner (`schema_migrations`) | $0 |
| `app/db/seed.sql` · `seed.js` · `verify_integrity.sql` | New — seed + integrity check | $0 |
| `app/package.json` | Edit — `mysql2`, `bcryptjs`; `migrate`/`seed` scripts | $0 |
| Cloud SQL `securevault` on `spms-mysql` | **Existing** ([0002](0002-network-and-data.md)) — tables altered, grants applied | $0 (no new resource, no tier change) |

Altering existing tables adds no resource and no always-on cost.

References:
- Live shape confirmed via `SHOW CREATE TABLE` (un-reconciled DATABASE.md version).
- Reconciled audit target: [audit-entries-schema.md](../architecture/audit-entries-schema.md) (note the `INT` fallback at its §"Deltas 2").
- Append-only: ADR [0006](../decisions/0006-append-only-audit-log-enforcement.md); sessions: ADR [0007](../decisions/0007-stateful-session-revocation.md); admin read: ADR [0008](../decisions/0008-in-app-admin-role.md).
- Schema source (design): [DATABASE.md](DATABASE.md); reachability: PRD [0007](0007-temporary-public-db-access.md).

## Scripts / commands

Applying the migration **mutates the live Cloud SQL database** — named explicitly per the action-plan rule. None is billable; none creates a resource.

```bash
# --- Local: validate against a throwaway MySQL (Docker/local) first ----------
cd app
npm install mysql2 bcryptjs
DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=securevault DB_USER=root DB_PASSWORD=... \
  npm run migrate          # applies 0001_baseline then 0002_reconcile
npm run migrate            # run AGAIN — must apply nothing (version-tracked no-op)
DB_USER=... AES_ENCRYPTION_KEY=<base64-32-bytes> npm run seed
mysql ... < db/verify_integrity.sql   # every orphan count = 0

# --- Apply to the live Cloud SQL (dev phase) --------------------------------
# Simplest: paste 0002_reconcile_*.sql + grants.sql into Cloud SQL Studio and run.
# Or via the Auth Proxy from a client, as a migration/admin identity (NOT spms_app):
./cloud-sql-proxy spms-securevault:us-central1:spms-mysql --port 3306 &
DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=securevault DB_USER=<admin> \
DB_PASSWORD="$(gcloud secrets versions access latest --secret=db-password)" \
  npm run migrate          # <-- MUTATES Cloud SQL: ALTERs the 3 tables, records versions
mysql ... -e "SHOW GRANTS FOR 'spms_app'@'%';"   # verify append-only grant
```

> DDL + `GRANT` run as an **admin/migration** identity; `spms_app` has no `CREATE`/`GRANT`. `gcloud secrets … access` is read-only. No secret is written to any `db/` file.

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| 1 | `app-engineer` | Capture `0001_baseline.sql` from the live `SHOW CREATE TABLE`; author `0002_reconcile_*.sql` (in-place `ALTER`s, `entry_id` stays `INT`); write `migrate.js` (version-tracked) + `grants.sql` + `seed.js`/`seed.sql` + `verify_integrity.sql`; validate against a throwaway MySQL incl. the re-run no-op, seed-count-unchanged, and `CK_AUDIT_ASSOC` negative check. | Checked-in `app/db/*`; a local run log showing the ALTERs applied, re-run no-op, 0 orphans, seed decrypt OK. |
| 2 | Main session (operator) | Apply `0002_reconcile_*.sql` + `grants.sql` to live Cloud SQL (Studio or Auth Proxy); run `SHOW CREATE TABLE` / `SHOW GRANTS` verification. Done in-session (mutates live DB, must be watched). | Verification output confirming reconciled shape + exact grant. |
| 3 | `infra-reviewer` | Read-only audit: grants least-privilege + append-only; `ALTER`s match the reconciled target; runner applies DDL as admin not `spms_app`; no secret in files/logs; migration idempotent. | Findings + sign-off. |
| 4 | `documentation-keeper` | Add a **runbook** (apply/verify migration, re-apply grants after re-provision); annotate [audit-entries-schema.md](../architecture/audit-entries-schema.md) that the team chose the **`INT` fallback** for `entry_id`; write `sessions-schema.md`; re-home/cross-link DATABASE.md; set this PRD's Outcome + status and the README index. | Updated `docs/`, cross-linked. |

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| Files checked in | `ls app/db/ app/db/migrations/` + review | baseline, reconcile, grants, migrate, seed, verify present |
| Re-runnable / idempotent | `npm run migrate` twice | 2nd run applies nothing, exits 0 |
| Audit table reconciled | `SHOW CREATE TABLE AUDIT_ENTRIES` | assoc cols, `RESTRICT` ×3, `CK_AUDIT_ASSOC`, `DATETIME(3)`, `entry_id` still `INT` |
| SESSIONS/USERS deltas | `SHOW CREATE TABLE SESSIONS` / `USERS` | no `token_hash`; `is_deleted` present |
| Non-destructive | `SELECT COUNT(*) FROM USERS` before/after | unchanged (seed rows survive) |
| Least-privilege append-only | `SHOW GRANTS FOR 'spms_app'@'%'` | `SELECT,INSERT` on `AUDIT_ENTRIES`; full DML elsewhere; nothing more |
| Association constraint bites | `INSERT` a `login.succeeded` row with `target_user_id` set | rejected by `CK_AUDIT_ASSOC` |
| Referential integrity | `mysql < verify_integrity.sql` | every orphan count = 0 |
| Crypto round-trips | `seed.js` decrypt-check | seeded ciphertext decrypts to known plaintext |
| Review pass | Step 3 | Sign-off, no unresolved high-severity finding |

## Additional considerations

- **Reconciliation — the three conflicts and their resolutions.** Each is grounded in an already-accepted decision, so this PRD transcribes rather than decides:
  1. **`AUDIT_ENTRIES` FKs `CASCADE` → `RESTRICT`, plus association columns** — the accepted target ([audit-entries-schema.md](../architecture/audit-entries-schema.md), ADR 0006/0008). `CASCADE` lets a user deletion erase the audit trail *bypassing the append-only grant* (a cascade runs with engine privilege); `RESTRICT` closes that. `target_user_id`/`actor_user_id` + `CK_AUDIT_ASSOC` are required or the admin history read's INSERT fails.
  2. **Audit id — kept `INT` (decided 2026-07-11).** The doc *prefers* `CHAR(36)` only to avoid discarding the app-minted UUID, but keeping `INT AUTO_INCREMENT` is the documented fallback and is **more consistent with the backend**: `user_id`, `vault_id`, `item_id`, `session_id` are all `INT` PKs the 0009 adapter already coerces to strings, so the audit table behaves like every other table rather than being special-cased. Append-only is unaffected — the caller still cannot choose the id (ADR 0006). **Consequence for 0009:** the audit `append` adapter omits `entry_id` on `INSERT` (DB assigns) and `String()`s it on read (`restoreAuditEntry` needs a non-empty string).
  3. **`USERS.is_deleted` + `SESSIONS` drop `token_hash`** — soft-delete makes `RESTRICT` non-blocking for legitimate deletions; dropping `token_hash` aligns to ADR 0007's `sessionId`-based revocation (the app never stores a token hash, and creates the session row before the JWT exists so `NOT NULL` was unsatisfiable).

- **Why ALTER, not DROP + recreate.** Chosen to (a) preserve the existing seed rows and (b) practise the incremental-migration discipline the schema now requires — the tables already exist, so this is the first real versioned migration, and `migrate.js` + `schema_migrations` sets up the pattern the Developer team continues. `entry_id` staying `INT` is what keeps the `AUDIT_ENTRIES` change a set of clean non-destructive `ALTER`s (no populated-PK type change).

- **Migration mechanics — gotchas confirmed against the live tables.** Two things the `0002_reconcile` author must get right (verified against the current `SHOW CREATE TABLE` output):
  - **Swap `FK_AUDIT_USERS` (`CASCADE → RESTRICT`) in its *own* statement, not folded into the column ALTER.** Dropping and re-adding a foreign key of the **same name** inside a single `ALTER TABLE` can fail in MySQL (duplicate-constraint-name, errno 121). Do it as two statements:
    ```sql
    ALTER TABLE AUDIT_ENTRIES DROP FOREIGN KEY FK_AUDIT_USERS;
    ALTER TABLE AUDIT_ENTRIES
      ADD CONSTRAINT FK_AUDIT_USERS FOREIGN KEY (user_id) REFERENCES USERS(user_id) ON DELETE RESTRICT;
    ```
    The `AUDIT_ENTRIES` column/precision/association changes (`ADD target_user_id`/`actor_user_id`, `MODIFY event_time DATETIME(3)`, the two new FKs, `CK_AUDIT_ASSOC`) can share one statement — they apply cleanly to the existing seed rows (new columns default `NULL`, so `CK_AUDIT_ASSOC`'s non-`audit_log.read` branch and the nullable FKs all validate).
  - **The existing seed rows use a stale action vocabulary.** The hand-seeded `AUDIT_ENTRIES` rows carry `LOGIN_SUCCESS`, `CREDENTIAL_CREATED`, … whereas the app's closed vocabulary is dotted (`login.succeeded`, `credential.added`; see `ACTIONS` in [audit-entry.js](../../app/src/models/audit-entry.js)). The migration applies fine regardless (`CK_AUDIT_ASSOC` only special-cases `audit_log.read`), but `restoreAuditEntry()` would **reject** those rows on read in 0009. `seed.js` therefore **re-seeds with the real `ACTIONS` values** — the reseed is what makes the existing data readable, not the ALTER.

- **Security posture.** The point of this PRD is the **append-only grant** + `FK … RESTRICT` — together they make business rule 7 a *database* guarantee, not just an app convention (ADR 0006 flagged the missing grant as outstanding). DDL/grants run as an **admin identity**; `spms_app` never holds `CREATE`/`GRANT`. No secret value lands in any `db/` file (`seed.sql` = placeholder ciphertext; `seed.js` reads keys from env). Seed data is **dev-only**.

- **Rollback / teardown.** `ALTER`s are reversible (a `down` step, or restore from an automated Cloud SQL backup); the environment is disposable, so `terraform destroy` drops the instance regardless. `migrate.js` is re-runnable, so recovering a re-provisioned instance is re-running it (after re-capturing a baseline, since a fresh Terraform DB is empty — the baseline then becomes create-tables rather than a capture; noted for the follow-up CD automation).

- **Sequencing.** Prerequisite for [0009](0009-storage-layer-and-auth-wiring.md) despite the higher number (creation order, never renumbered). Execute **0014 → 0009**. Resolves 0009's three Open Questions — including the ID-impedance one, now settled toward uniform `INT` coercion.

- **Dependencies / open questions.**
  - The apply needs DB reachability — Cloud SQL Studio (console) works now; the Auth Proxy path needs `roles/cloudsql.client`. PRD [0007](0007-temporary-public-db-access.md) public access must be flipped back to private before presentation regardless.
  - Confirm the **admin/migration DB identity** for DDL (not `spms_app`).
  - DATABASE.md sits under `docs/action_plan/` but is a design/reference doc, not a PRD — re-homing is a `documentation-keeper` cleanup, noted not blocking.

## Outcome

_Filled in after execution: applied shape, `SHOW GRANTS` summary, seed-count-unchanged confirmation, deviations, links to the new runbook / `sessions-schema.md`._
