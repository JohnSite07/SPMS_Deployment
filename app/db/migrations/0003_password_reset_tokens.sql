-- =============================================================================
-- 0003_password_reset_tokens.sql
-- PRD 0015 — password reset flow: single-use, time-limited reset tokens.
--
-- Run ONCE, as an ADMIN/migration user (Cloud SQL Studio, or the Auth Proxy as
-- the built-in admin) against the `securevault` database, after 0002. The app
-- user (`spms_app`) has no ALTER/GRANT and must NOT run this section's DDL —
-- it only needs the DML grant at the bottom.
--
-- Key decision (PRD 0015): reset is re-hash only. The vault is encrypted with
-- the server-held AES_ENCRYPTION_KEY, not the master password, so this table
-- exists purely to prove "the person who clicked the link controls the
-- mailbox" — it is never joined against vault data and never triggers a
-- re-encryption.
--
-- Only the token's SHA-256 hash is ever stored (32 bytes) — never the raw
-- token (ports/password-reset-store.js never receives or logs it either).
-- `used_at` makes the token single-use: it is set exactly once, atomically,
-- by consume()'s UPDATE ... WHERE used_at IS NULL AND expires_at > NOW(),
-- which is also what closes the race between two concurrent uses of the same
-- link.
-- =============================================================================

CREATE TABLE PASSWORD_RESET_TOKENS (
  token_id   INT           NOT NULL AUTO_INCREMENT,
  user_id    INT           NOT NULL,
  token_hash VARBINARY(32) NOT NULL,               -- SHA-256 of the raw token; raw token is never stored
  expires_at DATETIME      NOT NULL,
  used_at    DATETIME      NULL,                   -- set once, on consume() -> single-use
  created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT PK_PASSWORD_RESET_TOKENS PRIMARY KEY (token_id),
  CONSTRAINT UQ_PRT_TOKEN_HASH UNIQUE (token_hash),
  CONSTRAINT FK_PRT_USERS FOREIGN KEY (user_id)
       REFERENCES USERS(user_id) ON DELETE CASCADE,
  CONSTRAINT CK_PRT_TOKEN_HASH_LEN CHECK (OCTET_LENGTH(token_hash) = 32),  -- SHA-256 digest is exactly 32 bytes
  CONSTRAINT CK_PRT_EXPIRY CHECK (expires_at > created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every consume() and every request() lookup filters by token_hash (the
-- unique index above already covers that); this index is for a future
-- "list/cleanup a user's outstanding tokens" sweep, not on the request path
-- today.
CREATE INDEX IX_PRT_USER ON PASSWORD_RESET_TOKENS(user_id);

-- -----------------------------------------------------------------------------
-- App user grant: full DML, same as every other non-audit table (DATABASE.md
-- section 2). This table is never joined into the append-only audit log and
-- carries no secret beyond the hash, so it does not need AUDIT_ENTRIES'
-- restricted grant.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON securevault.PASSWORD_RESET_TOKENS TO 'spms_app'@'%';
FLUSH PRIVILEGES;

-- -----------------------------------------------------------------------------
-- Verify (run after the above):
--   SHOW CREATE TABLE PASSWORD_RESET_TOKENS;  -- FK to USERS, UQ on token_hash, 32-byte CHECK
--   SHOW GRANTS FOR 'spms_app'@'%';           -- SELECT,INSERT,UPDATE,DELETE on PASSWORD_RESET_TOKENS
-- =============================================================================
