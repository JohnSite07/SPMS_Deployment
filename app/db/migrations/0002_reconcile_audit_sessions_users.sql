-- =============================================================================
-- 0002_reconcile_audit_sessions_users.sql
-- PRD 0014 — reconcile the live schema with the application code (PRD 0008/0009).
--
-- Run ONCE, as an ADMIN/migration user (Cloud SQL Studio, or the Auth Proxy as
-- the built-in admin) against the `securevault` database. The app user
-- (`spms_app`) deliberately has no ALTER/GRANT and must NOT run this.
--
-- Idempotency: these are one-shot ALTERs against the un-reconciled baseline
-- (see 0001_baseline). Re-running will error ("column exists" / "can't drop").
-- A versioned runner (migrate.js + schema_migrations) is the durable mechanism;
-- until then, run this exactly once.
--
-- Safe against existing seed rows: new columns default correctly, CK_AUDIT_ASSOC
-- passes on pre-existing non-`audit_log.read` rows, and RESTRICT only changes
-- future DELETE behaviour. entry_id stays INT AUTO_INCREMENT (decided 2026-07-11;
-- the adapter omits it on INSERT and String()s it on read).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) USERS — add the soft-delete flag.
--    Corollary of AUDIT_ENTRIES' FK becoming RESTRICT: users are never
--    hard-deleted, so a delete can never be blocked by an audit reference.
-- -----------------------------------------------------------------------------
ALTER TABLE USERS
  ADD COLUMN is_deleted TINYINT(1) NOT NULL DEFAULT 0 AFTER lockout_until;

-- -----------------------------------------------------------------------------
-- 2) SESSIONS — drop the unused token-hash model.
--    Revocation is stateful by session_id (the JWT's jti): a row absent or
--    expired counts as revoked. The app never stores a token hash, and it
--    creates the session row before the JWT exists, so token_hash NOT NULL was
--    both unused and unsatisfiable. (ADR 0007.)
-- -----------------------------------------------------------------------------
ALTER TABLE SESSIONS
  DROP CHECK  CK_SESSIONS_TOKEN,          -- length check on token_hash
  DROP INDEX  IX_SESSIONS_TOKEN_HASH,     -- unique index on token_hash
  DROP COLUMN token_hash;

-- -----------------------------------------------------------------------------
-- 3) AUDIT_ENTRIES — association columns, millisecond precision, assoc check.
--    The admin audit-log-read records a read twice (target_user_id in the
--    admin's log, actor_user_id in the read user's log); without the columns
--    that INSERT fails. CK_AUDIT_ASSOC encodes "exactly one association, and
--    only on an audit_log.read". (audit-entries-schema.md, ADR 0006/0008.)
-- -----------------------------------------------------------------------------
ALTER TABLE AUDIT_ENTRIES
  ADD COLUMN target_user_id INT NULL AFTER ip_address,
  ADD COLUMN actor_user_id  INT NULL AFTER target_user_id,
  MODIFY COLUMN event_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD CONSTRAINT FK_AUDIT_TARGET FOREIGN KEY (target_user_id) REFERENCES USERS(user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT FK_AUDIT_ACTOR  FOREIGN KEY (actor_user_id)  REFERENCES USERS(user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT CK_AUDIT_ASSOC CHECK (
    (action =  'audit_log.read' AND (target_user_id IS NULL) <> (actor_user_id IS NULL))
    OR (action <> 'audit_log.read' AND target_user_id IS NULL AND actor_user_id IS NULL)
  );

-- 3b) Swap FK_AUDIT_USERS from CASCADE to RESTRICT — its OWN statement.
--     CASCADE lets a user deletion erase the audit trail, bypassing the
--     append-only grant (a cascade runs with engine privilege). RESTRICT closes
--     that. Kept separate because dropping + re-adding a same-named FK inside a
--     single ALTER can fail with MySQL errno 121 (duplicate constraint name).
ALTER TABLE AUDIT_ENTRIES DROP FOREIGN KEY FK_AUDIT_USERS;
ALTER TABLE AUDIT_ENTRIES
  ADD CONSTRAINT FK_AUDIT_USERS FOREIGN KEY (user_id) REFERENCES USERS(user_id) ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 4) (DEV ONLY, OPTIONAL) Clear stale seed audit rows.
--    The hand-seeded rows use a stale action vocabulary ('LOGIN_SUCCESS', …);
--    the app's closed vocabulary is dotted ('login.succeeded', …), so
--    restoreAuditEntry() rejects the old rows when /api/audit reads them.
--    Uncomment to clear them (or reseed with app-correct actions via seed.js).
--    Left commented so this migration never destroys data by default.
-- -----------------------------------------------------------------------------
-- DELETE FROM AUDIT_ENTRIES;

-- -----------------------------------------------------------------------------
-- 5) Append-only grant on AUDIT_ENTRIES (business rule 7).
--    INSERT + SELECT only — no UPDATE/DELETE — so the log cannot be edited even
--    by the application. Confirm the app user name first
--    (SELECT User, Host FROM mysql.user;) and adjust if it is not spms_app.
--    May instead live in a dedicated grants.sql.
-- -----------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON securevault.AUDIT_ENTRIES FROM 'spms_app'@'%';
GRANT  SELECT, INSERT ON securevault.AUDIT_ENTRIES TO   'spms_app'@'%';
FLUSH PRIVILEGES;

-- -----------------------------------------------------------------------------
-- Verify (run after the above):
--   SHOW CREATE TABLE AUDIT_ENTRIES;  -- target/actor cols, RESTRICT x3, CK_AUDIT_ASSOC, DATETIME(3)
--   SHOW CREATE TABLE SESSIONS;       -- no token_hash
--   SHOW CREATE TABLE USERS;          -- is_deleted present
--   SHOW GRANTS FOR 'spms_app'@'%';   -- SELECT,INSERT on AUDIT_ENTRIES, nothing more on it
-- =============================================================================
