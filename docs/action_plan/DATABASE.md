# SecureVault — Database Backend

Complete database deliverables for the SecureVault (SPMS) backend: schema DDL,
foreign keys, constraints, the least-privilege app user, seed data, referential-
integrity verification, and the full application query catalogue.

- **Engine:** MySQL 8 (InnoDB, `utf8mb4`)
- **Schema:** `securevault`
- **Source of truth:** Milestone 4 — System Design, Part II
- **App user:** `spms_app` (runtime DML only)

## Deliverables

| Deliverable                     | Purpose                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| **Schema DDL**                  | `CREATE TABLE` DDL — 11 tables, PKs, FKs (`ON DELETE CASCADE` / `RESTRICT`), constraints |
| **App User & Privileges**       | App DB user + least-privilege grants (INSERT/SELECT-only on the audit log)               |
| **Seed Data**                   | Test users + sample vault data (plain SQL, placeholder ciphertext)                       |
| **Referential-Integrity Check** | Delete a test user, confirm no orphan rows                                               |
| **Application Query Catalogue** | Full application DML query catalogue (parameterized)                                     |

## Execution order

Run the SQL statements directly in your MySQL client (as the admin/migration user) in the following order:

1. **Schema DDL** (Section 1)
2. **App user & privileges** (Section 2)
3. **Seed data** (Section 3) (development environments only)
4. **Referential-integrity check** (Section 4)

## The 11 tables

| #   | Table                     | PK                     | Notes                               |
| --- | ------------------------- | ---------------------- | ----------------------------------- |
| 1   | `USERS`                   | `user_id`              | unique email, lockout fields        |
| 2   | `VAULTS`                  | `vault_id`             | 1:1 with USERS                      |
| 3   | `VAULT_ITEMS`             | `item_id`              | supertype (class-table inheritance) |
| 4   | `CREDENTIALS`             | `item_id`              | subtype; encrypted password         |
| 5   | `SECURE_DOCUMENTS`        | `item_id`              | subtype; encrypted blob             |
| 6   | `TWO_FACTOR_CONFIGS`      | `tfa_id`               | encrypted 2FA secret                |
| 7   | `SESSIONS`                | `session_id`           | SHA-256 token hash                  |
| 8   | `AUDIT_ENTRIES`           | `entry_id`             | append-only                         |
| 9   | `PASSWORD_HEALTH_REPORTS` | `report_id`            |                                     |
| 10  | `REPORT_FINDINGS`         | `(report_id, item_id)` | junction (M:N)                      |
| 11  | `SECURITY_ALERTS`         | `alert_id`             |                                     |

**Secret storage:** credential passwords, document blobs, and 2FA secrets are
stored as AES-256-GCM ciphertext, each with its own 12-byte IV and 16-byte auth
tag. Master passwords are bcrypt/Argon2id hashes; session tokens are SHA-256
hashes. No plaintext secrets are ever stored.

---

## 1. Schema DDL

```sql
-- =============================================================================
-- SecureVault relational schema  (MySQL 8, InnoDB, utf8mb4)
-- Source of truth: Milestone 4 — System Design, Part II (Data Definition Language)
--
-- Naming convention:
--   Tables       UPPER_SNAKE_CASE, plural        (USERS, VAULT_ITEMS)
--   Columns      lower_snake_case                (user_id, master_password_hash)
--   Primary key  <entity>_id                     (user_id)
--   Constraints  PK_ / FK_ / UQ_ / CK_
--   Indexes      IX_<table>_<cols>
--
-- Security invariants encoded below:
--   * Master password: salted hash only (Argon2id/bcrypt), never plaintext.
--   * Credential passwords, document blobs, 2FA secrets: AES-256-GCM ciphertext,
--     each with its own 12-byte IV (nonce) and 16-byte auth tag.
--   * Session tokens: SHA-256 hash only, raw token never stored.
--
-- Tables are created parent-before-child so the foreign keys resolve.
-- =============================================================================

-- In production the `securevault` schema is already provisioned by Terraform and
-- you connect straight into it (DB_NAME=securevault). So DO NOT create/switch
-- databases there — just run the CREATE TABLE statements against `securevault`.
--
-- For a LOCAL scratch database (via the Cloud SQL Auth Proxy or a local MySQL),
-- uncomment the two lines below.
--
-- CREATE DATABASE IF NOT EXISTS securevault
--   CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- USE securevault;

-- -----------------------------------------------------------------------------
-- 1. USERS
-- -----------------------------------------------------------------------------
CREATE TABLE USERS (
  user_id              INT          NOT NULL AUTO_INCREMENT,
  email                VARCHAR(255) NOT NULL,               -- login identifier
  master_password_hash VARCHAR(255) NOT NULL,               -- Argon2id/bcrypt (salt embedded)
  failed_attempts      INT          NOT NULL DEFAULT 0,      -- brute-force counter
  is_locked            BOOLEAN      NOT NULL DEFAULT FALSE,
  lockout_until        DATETIME     NULL,                    -- drives the 15-min auto-unlock
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT PK_USERS           PRIMARY KEY (user_id),
  CONSTRAINT UQ_USERS_EMAIL     UNIQUE (email),
  CONSTRAINT CK_USERS_EMAIL_LEN CHECK (CHAR_LENGTH(email) BETWEEN 5 AND 255),
  CONSTRAINT CK_USERS_EMAIL_FMT CHECK (email LIKE '%_@_%.__%'),          -- basic shape: local@domain.tld
  CONSTRAINT CK_USERS_PWDHASH   CHECK (CHAR_LENGTH(master_password_hash) >= 20),  -- a real Argon2id/bcrypt hash, not a short/plain value
  CONSTRAINT CK_USERS_ATTEMPTS  CHECK (failed_attempts >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 2. VAULTS  (1:1 with USERS)
-- -----------------------------------------------------------------------------
CREATE TABLE VAULTS (
  vault_id          INT     NOT NULL AUTO_INCREMENT,
  user_id           INT     NOT NULL,
  auto_lock_minutes INT     NOT NULL DEFAULT 10,
  is_locked         BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT PK_VAULTS         PRIMARY KEY (vault_id),
  CONSTRAINT UQ_VAULTS_USER    UNIQUE (user_id),             -- enforces 1:1
  CONSTRAINT FK_VAULTS_USERS   FOREIGN KEY (user_id)
       REFERENCES USERS(user_id) ON DELETE CASCADE,
  CONSTRAINT CK_VAULTS_LOCKMIN CHECK (auto_lock_minutes > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 3. VAULT_ITEMS  (supertype; class-table inheritance)
-- -----------------------------------------------------------------------------
CREATE TABLE VAULT_ITEMS (
  item_id    INT          NOT NULL AUTO_INCREMENT,
  vault_id   INT          NOT NULL,
  item_type  ENUM('CREDENTIAL','DOCUMENT') NOT NULL,         -- discriminator
  title      VARCHAR(255) NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT PK_VAULT_ITEMS        PRIMARY KEY (item_id),
  CONSTRAINT FK_VAULT_ITEMS_VAULTS FOREIGN KEY (vault_id)
       REFERENCES VAULTS(vault_id) ON DELETE CASCADE,
  CONSTRAINT CK_VAULT_ITEMS_TITLE  CHECK (CHAR_LENGTH(TRIM(title)) >= 1)  -- title must not be blank
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 4. CREDENTIALS  (subtype, shared PK with VAULT_ITEMS)
-- -----------------------------------------------------------------------------
CREATE TABLE CREDENTIALS (
  item_id            INT            NOT NULL,
  url                VARCHAR(512)   NULL,
  username           VARCHAR(255)   NULL,
  encrypted_password VARBINARY(512) NOT NULL,               -- AES-256-GCM ciphertext
  password_iv        VARBINARY(12)  NOT NULL,               -- GCM nonce
  password_tag       VARBINARY(16)  NOT NULL,               -- GCM auth tag
  last_changed       DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT PK_CREDENTIALS       PRIMARY KEY (item_id),
  CONSTRAINT FK_CREDENTIALS_ITEMS FOREIGN KEY (item_id)
       REFERENCES VAULT_ITEMS(item_id) ON DELETE CASCADE,
  CONSTRAINT CK_CREDENTIALS_CIPHER CHECK (OCTET_LENGTH(encrypted_password) >= 1),
  CONSTRAINT CK_CREDENTIALS_IV     CHECK (OCTET_LENGTH(password_iv)  = 12),  -- GCM nonce is exactly 12 bytes
  CONSTRAINT CK_CREDENTIALS_TAG    CHECK (OCTET_LENGTH(password_tag) = 16),  -- GCM auth tag is exactly 16 bytes
  CONSTRAINT CK_CREDENTIALS_URLLEN CHECK (url IS NULL OR CHAR_LENGTH(url) <= 512)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 5. SECURE_DOCUMENTS  (subtype, shared PK with VAULT_ITEMS)
-- -----------------------------------------------------------------------------
CREATE TABLE SECURE_DOCUMENTS (
  item_id        INT           NOT NULL,
  file_name      VARCHAR(255)  NOT NULL,
  file_type      VARCHAR(50)   NOT NULL,
  file_size_kb   INT           NOT NULL,
  encrypted_blob LONGBLOB      NOT NULL,                    -- AES-256-GCM ciphertext
  file_iv        VARBINARY(12) NOT NULL,                    -- GCM nonce
  file_tag       VARBINARY(16) NOT NULL,                    -- GCM auth tag
  CONSTRAINT PK_SECURE_DOCUMENTS       PRIMARY KEY (item_id),
  CONSTRAINT FK_SECURE_DOCUMENTS_ITEMS FOREIGN KEY (item_id)
       REFERENCES VAULT_ITEMS(item_id) ON DELETE CASCADE,
  CONSTRAINT CK_SECURE_DOCUMENTS_SIZE  CHECK (file_size_kb BETWEEN 1 AND 10240),  -- 10 MB rule
  CONSTRAINT CK_SECURE_DOCUMENTS_TYPE  CHECK (file_type IN
       ('application/pdf','image/png','image/jpeg')),
  CONSTRAINT CK_SECURE_DOCUMENTS_NAME  CHECK (CHAR_LENGTH(TRIM(file_name)) >= 1),
  CONSTRAINT CK_SECURE_DOCUMENTS_BLOB  CHECK (OCTET_LENGTH(encrypted_blob) >= 1),
  CONSTRAINT CK_SECURE_DOCUMENTS_IV    CHECK (OCTET_LENGTH(file_iv)  = 12),  -- GCM nonce
  CONSTRAINT CK_SECURE_DOCUMENTS_TAG   CHECK (OCTET_LENGTH(file_tag) = 16)   -- GCM auth tag
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 6. TWO_FACTOR_CONFIGS  (0..1 per user)
-- -----------------------------------------------------------------------------
CREATE TABLE TWO_FACTOR_CONFIGS (
  tfa_id     INT            NOT NULL AUTO_INCREMENT,
  user_id    INT            NOT NULL,
  method     ENUM('TOTP','EMAIL') NOT NULL,
  secret_enc VARBINARY(255) NOT NULL,                       -- encrypted 2FA secret
  secret_iv  VARBINARY(12)  NOT NULL,                       -- GCM nonce
  secret_tag VARBINARY(16)  NOT NULL,                       -- GCM auth tag
  enabled    BOOLEAN        NOT NULL DEFAULT FALSE,
  CONSTRAINT PK_TWO_FACTOR_CONFIGS PRIMARY KEY (tfa_id),
  CONSTRAINT UQ_TFA_USER           UNIQUE (user_id),
  CONSTRAINT FK_TFA_USERS          FOREIGN KEY (user_id)
       REFERENCES USERS(user_id) ON DELETE CASCADE,
  CONSTRAINT CK_TFA_SECRET         CHECK (OCTET_LENGTH(secret_enc) >= 1),
  CONSTRAINT CK_TFA_IV             CHECK (OCTET_LENGTH(secret_iv)  = 12),  -- GCM nonce
  CONSTRAINT CK_TFA_TAG            CHECK (OCTET_LENGTH(secret_tag) = 16)   -- GCM auth tag
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 7. SESSIONS
-- -----------------------------------------------------------------------------
CREATE TABLE SESSIONS (
  session_id INT           NOT NULL AUTO_INCREMENT,
  user_id    INT           NOT NULL,
  token_hash VARBINARY(32) NOT NULL,                        -- SHA-256 of token; raw token never stored
  started_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME      NOT NULL,                        -- drives idle auto-lock
  CONSTRAINT PK_SESSIONS        PRIMARY KEY (session_id),
  CONSTRAINT FK_SESSIONS_USERS  FOREIGN KEY (user_id)
       REFERENCES USERS(user_id) ON DELETE CASCADE,
  CONSTRAINT CK_SESSIONS_TOKEN  CHECK (OCTET_LENGTH(token_hash) = 32),  -- SHA-256 is exactly 32 bytes
  CONSTRAINT CK_SESSIONS_EXPIRY CHECK (expires_at > started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE UNIQUE INDEX IX_SESSIONS_TOKEN_HASH ON SESSIONS(token_hash);
CREATE INDEX        IX_SESSIONS_EXPIRES    ON SESSIONS(expires_at);

-- -----------------------------------------------------------------------------
-- 8. AUDIT_ENTRIES  (append-only)
--    Append-only is enforced operationally: grant the app role only
--    INSERT/SELECT on this table (no UPDATE/DELETE).
-- -----------------------------------------------------------------------------
CREATE TABLE AUDIT_ENTRIES (
  entry_id       INT          NOT NULL AUTO_INCREMENT,
  user_id        INT          NOT NULL,
  action         VARCHAR(100) NOT NULL,
  event_time     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3), -- renamed off reserved word "timestamp"
  ip_address     VARCHAR(45)  NULL,                                -- IPv6-capable
  target_user_id INT          NULL,
  actor_user_id  INT          NULL,
  CONSTRAINT PK_AUDIT_ENTRIES PRIMARY KEY (entry_id),
  CONSTRAINT FK_AUDIT_USERS   FOREIGN KEY (user_id)
       REFERENCES USERS(user_id) ON DELETE RESTRICT,
  CONSTRAINT FK_AUDIT_TARGET  FOREIGN KEY (target_user_id)
       REFERENCES USERS(user_id) ON DELETE RESTRICT,
  CONSTRAINT FK_AUDIT_ACTOR   FOREIGN KEY (actor_user_id)
       REFERENCES USERS(user_id) ON DELETE RESTRICT,
  CONSTRAINT CK_AUDIT_ACTION  CHECK (CHAR_LENGTH(TRIM(action)) >= 1),
  CONSTRAINT CK_AUDIT_IP      CHECK (ip_address IS NULL OR CHAR_LENGTH(ip_address) BETWEEN 3 AND 45),
  CONSTRAINT CK_AUDIT_ASSOC   CHECK (
    (action =  'audit_log.read' AND (target_user_id IS NULL) <> (actor_user_id IS NULL))
    OR (action <> 'audit_log.read' AND target_user_id IS NULL AND actor_user_id IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX IX_AUDIT_USER_TIME ON AUDIT_ENTRIES(user_id, event_time);

-- -----------------------------------------------------------------------------
-- 9. PASSWORD_HEALTH_REPORTS
-- -----------------------------------------------------------------------------
CREATE TABLE PASSWORD_HEALTH_REPORTS (
  report_id     INT      NOT NULL AUTO_INCREMENT,
  vault_id      INT      NOT NULL,
  generated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  overall_score INT      NOT NULL,
  CONSTRAINT PK_PHR        PRIMARY KEY (report_id),
  CONSTRAINT FK_PHR_VAULTS FOREIGN KEY (vault_id)
       REFERENCES VAULTS(vault_id) ON DELETE CASCADE,
  CONSTRAINT CK_PHR_SCORE  CHECK (overall_score BETWEEN 0 AND 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 10. REPORT_FINDINGS  (junction, composite PK — resolves report<->credential M:N)
-- -----------------------------------------------------------------------------
CREATE TABLE REPORT_FINDINGS (
  report_id INT NOT NULL,
  item_id   INT NOT NULL,
  status    ENUM('WEAK','REUSED','OK') NOT NULL,
  CONSTRAINT PK_REPORT_FINDINGS PRIMARY KEY (report_id, item_id),
  CONSTRAINT FK_RF_REPORTS      FOREIGN KEY (report_id)
       REFERENCES PASSWORD_HEALTH_REPORTS(report_id) ON DELETE CASCADE,
  CONSTRAINT FK_RF_CREDENTIALS  FOREIGN KEY (item_id)
       REFERENCES CREDENTIALS(item_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 11. SECURITY_ALERTS
-- -----------------------------------------------------------------------------
CREATE TABLE SECURITY_ALERTS (
  alert_id   INT          NOT NULL AUTO_INCREMENT,
  report_id  INT          NOT NULL,
  type       ENUM('WEAK','REUSED') NOT NULL,
  message    VARCHAR(255) NOT NULL,
  is_read    BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT PK_SECURITY_ALERTS PRIMARY KEY (alert_id),
  CONSTRAINT FK_ALERTS_REPORTS  FOREIGN KEY (report_id)
       REFERENCES PASSWORD_HEALTH_REPORTS(report_id) ON DELETE CASCADE,
  CONSTRAINT CK_ALERTS_MESSAGE  CHECK (CHAR_LENGTH(TRIM(message)) >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## 2. App user & privileges

Least-privilege runtime user. **Append-only audit log:** `INSERT` + `SELECT`
only on `AUDIT_ENTRIES`; full DML on the other 10 tables.

```sql
-- ---- LOCAL ONLY: create the user (SKIP on Cloud SQL — Terraform owns it) ----
CREATE USER IF NOT EXISTS 'spms_app'@'%' IDENTIFIED BY 'CHANGE_ME_LOCAL_ONLY';

-- ---- Reset to a known state (strips any broad default grants) ---------------
REVOKE IF EXISTS ALL PRIVILEGES ON securevault.* FROM 'spms_app'@'%';

-- ---- Full DML on the application tables (everything except the audit log) ---
GRANT SELECT, INSERT, UPDATE, DELETE ON securevault.USERS                   TO 'spms_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON securevault.VAULTS                  TO 'spms_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON securevault.VAULT_ITEMS             TO 'spms_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON securevault.CREDENTIALS             TO 'spms_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON securevault.SECURE_DOCUMENTS        TO 'spms_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON securevault.TWO_FACTOR_CONFIGS      TO 'spms_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON securevault.SESSIONS                TO 'spms_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON securevault.PASSWORD_HEALTH_REPORTS TO 'spms_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON securevault.REPORT_FINDINGS         TO 'spms_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON securevault.SECURITY_ALERTS         TO 'spms_app'@'%';

-- ---- Append-only audit log: INSERT + SELECT ONLY ---------------------------
GRANT SELECT, INSERT ON securevault.AUDIT_ENTRIES TO 'spms_app'@'%';

FLUSH PRIVILEGES;
-- Verify: SHOW GRANTS FOR 'spms_app'@'%';
```

> **Note:** on Cloud SQL the `spms_app` user already exists (Terraform-managed,
> password in Secret Manager) — skip the `CREATE USER` line there and run only
> the `REVOKE`/`GRANT` section. Hand-run grants do not survive a re-provision;
> the durable fix is to capture this policy in Terraform.

---

## 3. Seed data

Test logins: `alice@example.com` / `Password123!`, `bob@example.com` /
`Passphrase456!`, `carol@example.com` / `Locked789!` (locked). Password hashes
are **real bcrypt**; the encrypted columns are byte-valid **placeholder**
ciphertext.

```sql
START TRANSACTION;

-- ---- Idempotent reset: remove prior seed (delete restricted child rows first) ------
DELETE FROM AUDIT_ENTRIES WHERE user_id IN (1, 2, 3) OR target_user_id IN (1, 2, 3) OR actor_user_id IN (1, 2, 3);
DELETE FROM USERS WHERE user_id IN (1, 2, 3);

-- ---- 1. USERS --------------------------------------------------------------
INSERT INTO USERS (user_id, email, master_password_hash, failed_attempts, is_locked, lockout_until) VALUES
  (1, 'alice@example.com', '$2b$12$dil3xhU5ncE9NosiNaOgFe.Iez.FDMJJAHoW4AZo4o12owBCsGm56', 0, FALSE, NULL),
  (2, 'bob@example.com',   '$2b$12$rL7z2SOgmr/TudIBPxYqQeWW1VkQvWHcIwLnFuOPCHtqS5pbPqX8C', 0, FALSE, NULL),
  (3, 'carol@example.com', '$2b$12$SbbjA28WKb9S9BdxHzrah.JVDOdjaoJR3MCr23pfWMpMoPbxmjmrS', 5, TRUE,  NOW() + INTERVAL 15 MINUTE);

-- ---- 2. VAULTS (1:1 with USERS) -------------------------------------------
INSERT INTO VAULTS (vault_id, user_id, auto_lock_minutes, is_locked) VALUES
  (1, 1, 10, FALSE),
  (2, 2,  5, FALSE),
  (3, 3, 15, TRUE);

-- ---- 3. VAULT_ITEMS (supertype) -------------------------------------------
INSERT INTO VAULT_ITEMS (item_id, vault_id, item_type, title) VALUES
  (1, 1, 'CREDENTIAL', 'GitHub'),
  (2, 1, 'CREDENTIAL', 'Gmail'),
  (3, 1, 'DOCUMENT',   'Passport Scan'),
  (4, 2, 'CREDENTIAL', 'AWS Console'),
  (5, 2, 'DOCUMENT',   'Tax Return 2024'),
  (6, 3, 'CREDENTIAL', 'Bank Login');

-- ---- 4. CREDENTIALS (subtype; placeholder GCM ciphertext) -----------------
INSERT INTO CREDENTIALS (item_id, url, username, encrypted_password, password_iv, password_tag) VALUES
  (1, 'https://github.com', 'alice-dev',  0xAABBCCDDEEFF00112233, 0x0102030405060708090A0B0C, 0x101112131415161718191A1B1C1D1E1F),
  (2, 'https://mail.google.com', 'alice@example.com', 0xBBCCDDEEFF0011223344, 0x0202030405060708090A0B0C, 0x201112131415161718191A1B1C1D1E1F),
  (4, 'https://console.aws.amazon.com', 'bob-ops', 0xCCDDEEFF001122334455, 0x0302030405060708090A0B0C, 0x301112131415161718191A1B1C1D1E1F),
  (6, 'https://mybank.example.com', 'carol', 0xDDEEFF00112233445566, 0x0402030405060708090A0B0C, 0x401112131415161718191A1B1C1D1E1F);

-- ---- 5. SECURE_DOCUMENTS (subtype; placeholder GCM ciphertext) ------------
INSERT INTO SECURE_DOCUMENTS (item_id, file_name, file_type, file_size_kb, encrypted_blob, file_iv, file_tag) VALUES
  (3, 'passport.pdf',     'application/pdf', 842,  0xEEFF00112233445566778899, 0x0502030405060708090A0B0C, 0x501112131415161718191A1B1C1D1E1F),
  (5, 'tax-return-2024.pdf', 'application/pdf', 2048, 0xFF00112233445566778899AA, 0x0602030405060708090A0B0C, 0x601112131415161718191A1B1C1D1E1F);

-- ---- 6. TWO_FACTOR_CONFIGS -------------------------------------------------
INSERT INTO TWO_FACTOR_CONFIGS (tfa_id, user_id, method, secret_enc, secret_iv, secret_tag, enabled) VALUES
  (1, 1, 'TOTP',  0x1122334455667788, 0x0702030405060708090A0B0C, 0x701112131415161718191A1B1C1D1E1F, TRUE),
  (2, 2, 'EMAIL', 0x2233445566778899, 0x0802030405060708090A0B0C, 0x801112131415161718191A1B1C1D1E1F, FALSE);

-- ---- 7. SESSIONS -----------------------------------------------------------
INSERT INTO SESSIONS (session_id, user_id, token_hash, started_at, expires_at) VALUES
  (1, 1, 0x1111111111111111111111111111111111111111111111111111111111111111, NOW(), NOW() + INTERVAL 1 HOUR),
  (2, 2, 0x2222222222222222222222222222222222222222222222222222222222222222, NOW() - INTERVAL 2 DAY, NOW() - INTERVAL 47 HOUR);

-- ---- 8. AUDIT_ENTRIES (append-only) ---------------------------------------
INSERT INTO AUDIT_ENTRIES (user_id, action, ip_address, target_user_id, actor_user_id) VALUES
  (1, 'LOGIN_SUCCESS',      '203.0.113.10', NULL, NULL),
  (1, 'CREDENTIAL_CREATED', '203.0.113.10', NULL, NULL),
  (2, 'LOGIN_SUCCESS',      '198.51.100.22', NULL, NULL),
  (3, 'LOGIN_FAILED',       '2001:db8::1',  NULL, NULL),
  (3, 'ACCOUNT_LOCKED',     '2001:db8::1',  NULL, NULL),
  (1, 'audit_log.read',     '203.0.113.10', 2,    NULL);

-- ---- 9. PASSWORD_HEALTH_REPORTS -------------------------------------------
INSERT INTO PASSWORD_HEALTH_REPORTS (report_id, vault_id, overall_score) VALUES
  (1, 1, 72),
  (2, 2, 90);

-- ---- 10. REPORT_FINDINGS (junction -> CREDENTIALS) ------------------------
INSERT INTO REPORT_FINDINGS (report_id, item_id, status) VALUES
  (1, 1, 'REUSED'),   -- GitHub
  (1, 2, 'OK'),       -- Gmail
  (2, 4, 'WEAK');     -- AWS Console

-- ---- 11. SECURITY_ALERTS ---------------------------------------------------
INSERT INTO SECURITY_ALERTS (report_id, type, message, is_read) VALUES
  (1, 'REUSED', 'Your GitHub password is reused on another site.', FALSE),
  (2, 'WEAK',   'Your AWS Console password is weak.',              FALSE);

COMMIT;
```

---

## 4. Referential-integrity check

Deletes a test user inside a transaction, confirms the cascade left **no orphan
rows**, then rolls back. Every `orphans` count in the result must be `0`.

```sql
START TRANSACTION;

-- Delete one seeded test user (most FKs are ON DELETE CASCADE, audit log is ON DELETE RESTRICT).
-- Delete audit entries first because of ON DELETE RESTRICT
DELETE FROM AUDIT_ENTRIES WHERE user_id = 1 OR target_user_id = 1 OR actor_user_id = 1;
DELETE FROM USERS WHERE email = 'alice@example.com';

-- Every count below MUST be 0 — a non-zero value means an orphaned row.
SELECT 'vaults'       AS table_name, COUNT(*) AS orphans FROM VAULTS              WHERE user_id   NOT IN (SELECT user_id   FROM USERS)
UNION ALL SELECT 'vault_items', COUNT(*) FROM VAULT_ITEMS          WHERE vault_id  NOT IN (SELECT vault_id  FROM VAULTS)
UNION ALL SELECT 'credentials', COUNT(*) FROM CREDENTIALS          WHERE item_id   NOT IN (SELECT item_id   FROM VAULT_ITEMS)
UNION ALL SELECT 'documents',   COUNT(*) FROM SECURE_DOCUMENTS     WHERE item_id   NOT IN (SELECT item_id   FROM VAULT_ITEMS)
UNION ALL SELECT 'two_factor',  COUNT(*) FROM TWO_FACTOR_CONFIGS   WHERE user_id   NOT IN (SELECT user_id   FROM USERS)
UNION ALL SELECT 'sessions',    COUNT(*) FROM SESSIONS             WHERE user_id   NOT IN (SELECT user_id   FROM USERS)
UNION ALL SELECT 'audit',       COUNT(*) FROM AUDIT_ENTRIES        WHERE user_id   NOT IN (SELECT user_id   FROM USERS)
UNION ALL SELECT 'audit_target', COUNT(*) FROM AUDIT_ENTRIES       WHERE target_user_id IS NOT NULL AND target_user_id NOT IN (SELECT user_id FROM USERS)
UNION ALL SELECT 'audit_actor',  COUNT(*) FROM AUDIT_ENTRIES       WHERE actor_user_id  IS NOT NULL AND actor_user_id  NOT IN (SELECT user_id FROM USERS)
UNION ALL SELECT 'reports',     COUNT(*) FROM PASSWORD_HEALTH_REPORTS WHERE vault_id NOT IN (SELECT vault_id FROM VAULTS)
UNION ALL SELECT 'findings',    COUNT(*) FROM REPORT_FINDINGS      WHERE report_id NOT IN (SELECT report_id FROM PASSWORD_HEALTH_REPORTS)
UNION ALL SELECT 'alerts',      COUNT(*) FROM SECURITY_ALERTS      WHERE report_id NOT IN (SELECT report_id FROM PASSWORD_HEALTH_REPORTS);

-- Undo the delete so the seed data stays intact.
ROLLBACK;
```

---

## 5. Application query catalogue

Parameterized DML (`?` placeholders, `mysql2` style) for every table.

```sql
-- ===== 1. USERS =============================================================
-- Register
INSERT INTO USERS (email, master_password_hash) VALUES (?, ?);
-- Login lookup
SELECT user_id, email, master_password_hash, failed_attempts, is_locked, lockout_until, created_at
  FROM USERS WHERE email = ?;
-- Fetch by id
SELECT user_id, email, failed_attempts, is_locked, lockout_until, created_at
  FROM USERS WHERE user_id = ?;
-- Failed-login handling (brute-force / 15-min lockout)
UPDATE USERS SET failed_attempts = failed_attempts + 1 WHERE user_id = ?;
UPDATE USERS SET is_locked = TRUE, lockout_until = ? WHERE user_id = ?;   -- lockout_until = NOW()+15min
UPDATE USERS SET failed_attempts = 0, is_locked = FALSE, lockout_until = NULL WHERE user_id = ?;  -- successful login / unlock
-- Change master password
UPDATE USERS SET master_password_hash = ? WHERE user_id = ?;
-- Delete (cascades to vault, items, sessions, 2FA; restricted if audit entries reference this user)
DELETE FROM USERS WHERE user_id = ?;


-- ===== 2. VAULTS ============================================================
INSERT INTO VAULTS (user_id, auto_lock_minutes, is_locked) VALUES (?, ?, TRUE);
SELECT vault_id, user_id, auto_lock_minutes, is_locked FROM VAULTS WHERE user_id = ?;
SELECT vault_id, user_id, auto_lock_minutes, is_locked FROM VAULTS WHERE vault_id = ?;
UPDATE VAULTS SET auto_lock_minutes = ? WHERE vault_id = ?;
UPDATE VAULTS SET is_locked = ? WHERE vault_id = ?;               -- lock / unlock
DELETE FROM VAULTS WHERE vault_id = ?;


-- ===== 3. VAULT_ITEMS (supertype) ==========================================
INSERT INTO VAULT_ITEMS (vault_id, item_type, title) VALUES (?, ?, ?);   -- item_type: 'CREDENTIAL' | 'DOCUMENT'
-- List all items in a vault (newest first)
SELECT item_id, vault_id, item_type, title, created_at, updated_at
  FROM VAULT_ITEMS WHERE vault_id = ? ORDER BY updated_at DESC;
-- List only one type
SELECT item_id, title, created_at, updated_at
  FROM VAULT_ITEMS WHERE vault_id = ? AND item_type = ? ORDER BY updated_at DESC;
SELECT item_id, vault_id, item_type, title, created_at, updated_at
  FROM VAULT_ITEMS WHERE item_id = ?;
UPDATE VAULT_ITEMS SET title = ? WHERE item_id = ?;               -- updated_at auto-bumps
DELETE FROM VAULT_ITEMS WHERE item_id = ?;                        -- cascades to subtype row


-- ===== 4. CREDENTIALS (subtype, shared PK) =================================
INSERT INTO CREDENTIALS (item_id, url, username, encrypted_password, password_iv, password_tag)
  VALUES (?, ?, ?, ?, ?, ?);
-- Read a single credential joined with its supertype
SELECT vi.item_id, vi.vault_id, vi.title, vi.created_at, vi.updated_at,
       c.url, c.username, c.encrypted_password, c.password_iv, c.password_tag, c.last_changed
  FROM VAULT_ITEMS vi JOIN CREDENTIALS c ON c.item_id = vi.item_id
 WHERE vi.item_id = ?;
-- List all credentials in a vault
SELECT vi.item_id, vi.title, c.url, c.username, c.last_changed
  FROM VAULT_ITEMS vi JOIN CREDENTIALS c ON c.item_id = vi.item_id
 WHERE vi.vault_id = ? ORDER BY vi.title;
-- Rotate the password (new ciphertext/iv/tag)
UPDATE CREDENTIALS
   SET encrypted_password = ?, password_iv = ?, password_tag = ?, last_changed = CURRENT_TIMESTAMP
 WHERE item_id = ?;
UPDATE CREDENTIALS SET url = ?, username = ? WHERE item_id = ?;
-- Delete: delete the VAULT_ITEMS row (cascades here). See transactional note.


-- ===== 5. SECURE_DOCUMENTS (subtype, shared PK) ============================
INSERT INTO SECURE_DOCUMENTS (item_id, file_name, file_type, file_size_kb, encrypted_blob, file_iv, file_tag)
  VALUES (?, ?, ?, ?, ?, ?, ?);
-- Metadata only (cheap listing — no blob)
SELECT vi.item_id, vi.title, d.file_name, d.file_type, d.file_size_kb
  FROM VAULT_ITEMS vi JOIN SECURE_DOCUMENTS d ON d.item_id = vi.item_id
 WHERE vi.vault_id = ? ORDER BY d.file_name;
-- Full row incl. encrypted blob (download)
SELECT d.file_name, d.file_type, d.file_size_kb, d.encrypted_blob, d.file_iv, d.file_tag
  FROM SECURE_DOCUMENTS d WHERE d.item_id = ?;
UPDATE SECURE_DOCUMENTS
   SET file_name = ?, file_type = ?, file_size_kb = ?, encrypted_blob = ?, file_iv = ?, file_tag = ?
 WHERE item_id = ?;


-- ===== 6. TWO_FACTOR_CONFIGS ===============================================
INSERT INTO TWO_FACTOR_CONFIGS (user_id, method, secret_enc, secret_iv, secret_tag, enabled)
  VALUES (?, ?, ?, ?, ?, FALSE);
SELECT tfa_id, user_id, method, secret_enc, secret_iv, secret_tag, enabled
  FROM TWO_FACTOR_CONFIGS WHERE user_id = ?;
UPDATE TWO_FACTOR_CONFIGS SET enabled = ? WHERE user_id = ?;      -- enable after first valid code
UPDATE TWO_FACTOR_CONFIGS SET method = ?, secret_enc = ?, secret_iv = ?, secret_tag = ?, enabled = FALSE
  WHERE user_id = ?;                                             -- re-enroll
DELETE FROM TWO_FACTOR_CONFIGS WHERE user_id = ?;


-- ===== 7. SESSIONS =========================================================
INSERT INTO SESSIONS (user_id, token_hash, expires_at) VALUES (?, ?, ?);
-- Validate a presented token: app hashes the raw token (SHA-256) then looks it up
SELECT session_id, user_id, started_at, expires_at
  FROM SESSIONS WHERE token_hash = ? AND expires_at > NOW();
UPDATE SESSIONS SET expires_at = ? WHERE session_id = ?;         -- sliding idle-timeout renewal
DELETE FROM SESSIONS WHERE session_id = ?;                       -- logout
DELETE FROM SESSIONS WHERE user_id = ?;                          -- logout everywhere
DELETE FROM SESSIONS WHERE expires_at <= NOW();                  -- periodic expiry sweep


-- ===== 8. AUDIT_ENTRIES (append-only: INSERT + SELECT only) ================
INSERT INTO AUDIT_ENTRIES (user_id, action, ip_address, target_user_id, actor_user_id) VALUES (?, ?, ?, ?, ?);
SELECT entry_id, user_id, action, event_time, ip_address, target_user_id, actor_user_id
  FROM AUDIT_ENTRIES
 WHERE user_id = ? AND event_time BETWEEN ? AND ?
 ORDER BY event_time DESC;
SELECT entry_id, user_id, action, event_time, ip_address, target_user_id, actor_user_id
  FROM AUDIT_ENTRIES WHERE user_id = ? ORDER BY event_time DESC LIMIT ? OFFSET ?;
-- Fetch audit entries where a user is the actor or target (compliance searches)
SELECT entry_id, user_id, action, event_time, ip_address, target_user_id, actor_user_id
  FROM AUDIT_ENTRIES
 WHERE target_user_id = ? OR actor_user_id = ?
 ORDER BY event_time DESC;
-- (No UPDATE/DELETE — enforced by both design and grant.)


-- ===== 9. PASSWORD_HEALTH_REPORTS ==========================================
INSERT INTO PASSWORD_HEALTH_REPORTS (vault_id, overall_score) VALUES (?, ?);
-- Latest report for a vault
SELECT report_id, vault_id, generated_at, overall_score
  FROM PASSWORD_HEALTH_REPORTS WHERE vault_id = ? ORDER BY generated_at DESC LIMIT 1;
SELECT report_id, generated_at, overall_score
  FROM PASSWORD_HEALTH_REPORTS WHERE vault_id = ? ORDER BY generated_at DESC;
DELETE FROM PASSWORD_HEALTH_REPORTS WHERE report_id = ?;


-- ===== 10. REPORT_FINDINGS (junction, composite PK) ========================
INSERT INTO REPORT_FINDINGS (report_id, item_id, status) VALUES (?, ?, ?);
-- Bulk insert many findings for one report (build the VALUES list in app code)
-- INSERT INTO REPORT_FINDINGS (report_id, item_id, status) VALUES ?;   -- mysql2 bulk form
-- Findings for a report, joined to the credential title
SELECT rf.report_id, rf.item_id, rf.status, vi.title, c.url, c.username
  FROM REPORT_FINDINGS rf
  JOIN CREDENTIALS c  ON c.item_id  = rf.item_id
  JOIN VAULT_ITEMS vi ON vi.item_id = rf.item_id
 WHERE rf.report_id = ?;
UPDATE REPORT_FINDINGS SET status = ? WHERE report_id = ? AND item_id = ?;
DELETE FROM REPORT_FINDINGS WHERE report_id = ?;


-- ===== 11. SECURITY_ALERTS =================================================
INSERT INTO SECURITY_ALERTS (report_id, type, message) VALUES (?, ?, ?);
-- Unread alerts for a user's vault (join up to the vault owner)
SELECT sa.alert_id, sa.report_id, sa.type, sa.message, sa.is_read, sa.created_at
  FROM SECURITY_ALERTS sa
  JOIN PASSWORD_HEALTH_REPORTS phr ON phr.report_id = sa.report_id
  JOIN VAULTS v ON v.vault_id = phr.vault_id
 WHERE v.user_id = ? AND sa.is_read = FALSE
 ORDER BY sa.created_at DESC;
UPDATE SECURITY_ALERTS SET is_read = TRUE WHERE alert_id = ?;
UPDATE SECURITY_ALERTS SET is_read = TRUE WHERE report_id = ?;    -- mark all in a report read
DELETE FROM SECURITY_ALERTS WHERE alert_id = ?;
```

### Transactional patterns (class-table inheritance)

Credentials and documents span two tables — create them in one transaction:

```sql
-- Create a credential
START TRANSACTION;
INSERT INTO VAULT_ITEMS (vault_id, item_type, title) VALUES (?, 'CREDENTIAL', ?);
INSERT INTO CREDENTIALS (item_id, url, username, encrypted_password, password_iv, password_tag)
     VALUES (LAST_INSERT_ID(), ?, ?, ?, ?, ?);
COMMIT;

-- Create a document: same shape, item_type='DOCUMENT' then INSERT INTO SECURE_DOCUMENTS.
-- Delete either: DELETE FROM VAULT_ITEMS WHERE item_id = ?;  -- subtype row cascades.
```

---
