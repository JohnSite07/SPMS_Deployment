# AUDIT_ENTRIES — reconciled schema

The table that stores `AuditEntry` rows, reconciled against what the application code in [`app/src/models/audit-entry.js`](../../app/src/models/audit-entry.js) actually writes. The schema itself is **Developer-team-owned** (M4 System Design, Part II); this document exists because the audit *code* diverged from the M3 four-field model, and the two must be made to agree before the audit log can be trusted. Read it alongside [ADR 0006](../decisions/0006-append-only-audit-log-enforcement.md) (append-only enforcement) and [ADR 0008](../decisions/0008-in-app-admin-role.md) (the admin read that needs the association columns).

> **Source of truth.** Where this document and the deployed schema disagree, neither is automatically right: the code fixes what the app writes, the DDL fixes what the DB accepts, and a mismatch between them is a bug in whichever was changed last. The intent below is what makes the two consistent.

## Target DDL

```sql
CREATE TABLE AUDIT_ENTRIES (
  entry_id       CHAR(36)     NOT NULL,            -- app-minted UUID, not AUTO_INCREMENT
  user_id        INT          NOT NULL,            -- whose log this row lives in
  action         VARCHAR(100) NOT NULL,            -- closed vocabulary; see ACTIONS
  event_time     DATETIME(3)  NOT NULL,            -- millisecond precision, app-stamped
  ip_address     VARCHAR(45)      NULL,            -- NULL = no request (timers, scans)
  target_user_id INT              NULL,            -- audit_log.read, admin's copy: whose history
  actor_user_id  INT              NULL,            -- audit_log.read, user's copy: who read it

  PRIMARY KEY (entry_id),
  KEY IX_AUDIT_USER_TIME (user_id, event_time DESC, entry_id DESC),

  CONSTRAINT FK_AUDIT_USERS  FOREIGN KEY (user_id)        REFERENCES USERS(user_id) ON DELETE RESTRICT,
  CONSTRAINT FK_AUDIT_TARGET FOREIGN KEY (target_user_id) REFERENCES USERS(user_id) ON DELETE RESTRICT,
  CONSTRAINT FK_AUDIT_ACTOR  FOREIGN KEY (actor_user_id)  REFERENCES USERS(user_id) ON DELETE RESTRICT,

  CONSTRAINT CK_AUDIT_ACTION CHECK (CHAR_LENGTH(TRIM(action)) >= 1),
  CONSTRAINT CK_AUDIT_IP     CHECK (ip_address IS NULL OR CHAR_LENGTH(ip_address) BETWEEN 2 AND 45),

  -- Exactly one association, and only on an audit_log.read.
  CONSTRAINT CK_AUDIT_ASSOC CHECK (
    (action =  'audit_log.read' AND (target_user_id IS NULL) <> (actor_user_id IS NULL))
    OR
    (action <> 'audit_log.read' AND target_user_id IS NULL AND actor_user_id IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The enforcement. The app user may add rows and read them, nothing else.
GRANT SELECT, INSERT ON securevault.AUDIT_ENTRIES TO 'spms_app'@'%';
-- deliberately no UPDATE, no DELETE
```

## Deltas from the first-created table

The table as first created ( `entry_id INT AUTO_INCREMENT`, five columns, `event_time DATETIME`, `ON DELETE CASCADE` ) does not match what the code writes. Four changes, ranked by severity:

### 1. `ON DELETE CASCADE` → `ON DELETE RESTRICT` (critical)

`CASCADE` means deleting a `USERS` row auto-deletes that user's audit trail — a one-statement erasure of the evidence, which is exactly what business rule 7 forbids. Worse, it **defeats the grant-based enforcement**: a cascade delete is performed by the storage engine, *not* subject to the app user's privileges, so a user with only `INSERT`/`SELECT` on `AUDIT_ENTRIES` can still destroy audit rows by deleting a user. `RESTRICT` closes both holes.

This contradicts the M3 domain model, which *composes* `AuditLog` into `User` (composition implies cascade). The contradiction is deliberate and business rule 7 wins: an audit log exists precisely to outlive the thing it records. The corollary is an operational rule — **users are soft-deleted, never hard-deleted** (an `is_deleted` flag on `USERS`), so `RESTRICT` never blocks a legitimate deletion. `SET NULL` is not an option: `user_id` is `NOT NULL`, and an entry that forgets whose action it was is not an audit entry.

```sql
ALTER TABLE AUDIT_ENTRIES DROP FOREIGN KEY FK_AUDIT_USERS;
ALTER TABLE AUDIT_ENTRIES ADD  CONSTRAINT FK_AUDIT_USERS
  FOREIGN KEY (user_id) REFERENCES USERS(user_id) ON DELETE RESTRICT;
```

### 2. `entry_id INT AUTO_INCREMENT` → `CHAR(36)` (write-blocker)

`createAuditEntry()` mints `crypto.randomUUID()` — a 36-character string — as the primary key, so the writer chooses a collision-free id and cannot overwrite an existing row ([ADR 0006](../decisions/0006-append-only-audit-log-enforcement.md)). A UUID string will not go into an `INT`. Making the column `CHAR(36)` and storing the app's id keeps the code and the DB agreed on exactly one identifier.

> If the team instead keeps `INT AUTO_INCREMENT`, the store adapter **must** (a) omit `entry_id` on INSERT and let the DB assign it, and (b) `String()` the value on read, because `restoreAuditEntry()` requires a non-empty string. The app's minted UUID is then discarded — two ids where one would do. `CHAR(36)` is preferred.

### 3. Add `target_user_id` and `actor_user_id` (write-blocker for the admin view)

The admin history view records each read twice — `target_user_id` in the admin's log, `actor_user_id` in the read user's log ([ADR 0008](../decisions/0008-in-app-admin-role.md)). Without the columns, the read INSERT fails the moment an admin opens anyone's history. `CK_AUDIT_ASSOC` encodes the model's invariant: exactly one association, and only on an `audit_log.read`.

### 4. `event_time DATETIME` → `DATETIME(3)` (precision)

Plain `DATETIME` truncates to whole seconds. This does **not** corrupt keyset pagination — the cursor's `(event_time, entry_id)` tiebreak keeps a valid total order at any precision, and the cursor round-trips both fields from DB reads (see [`app/src/routes/pagination.js`](../../app/src/routes/pagination.js)). What it costs is sub-second forensic ordering and fidelity to the app's clock, which is millisecond-based and is the injected time source the test suite drives. Use `DATETIME(3)` and have the adapter **insert the app's timestamp** rather than relying on `DEFAULT CURRENT_TIMESTAMP` — two competing clocks (app vs DB default) is worse than one.

## Field mapping (code ↔ column)

| `AuditEntry` field (JSON) | Column | Notes |
| --- | --- | --- |
| `entryId` | `entry_id` | app-minted UUID |
| `userId` | `user_id` | app sends `String(userId)`; adapter coerces to `INT` in, `String()` out |
| `action` | `action` | closed vocabulary enforced in the app; DB checks non-empty only |
| `timestamp` | `event_time` | **name differs** — the adapter maps `timestamp` ↔ `event_time` |
| `ipAddress` | `ip_address` | `null` for system-originated actions |
| `targetUserId` / `actorUserId` | same | omitted from JSON when null |

Two deliberate asymmetries: the DB does **not** enforce the closed action vocabulary (the app is the authority; a DB `CHECK … IN (…)` would need a migration on every new action), and the DB stores `event_time` under a different name than the model's `timestamp` (the adapter is the single place that bridges them).

## Enforcement summary

Append-only is defended in layers (full rationale in [ADR 0006](../decisions/0006-append-only-audit-log-enforcement.md)); this table is the lowest one:

- **Grant:** `SELECT, INSERT` only — no `UPDATE`, no `DELETE`.
- **FK `RESTRICT`:** no cascade path can delete a row out from under the grant.
- **Optional belt-and-braces:** `BEFORE UPDATE` / `BEFORE DELETE` triggers that `SIGNAL SQLSTATE '45000'`. A DBA can drop a trigger, so this is defence in depth, not a guarantee — the grant is the guarantee.

Verify the grant with:

```sql
SHOW GRANTS FOR 'spms_app'@'%';   -- expect SELECT, INSERT on AUDIT_ENTRIES and nothing more
```
