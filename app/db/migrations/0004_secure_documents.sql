-- =============================================================================
-- 0004_secure_documents.sql
-- PRD 0025 — Secure Document Vault (UC-04/UC-06): SECURE_DOCUMENTS as
-- metadata + object_key, ciphertext lives in Cloud Storage (PRD 0024), not in
-- this table.
--
-- Run ONCE, as an ADMIN/migration user (Cloud SQL Studio, or the Auth Proxy as
-- the built-in admin) against the `securevault` database, after 0002/0003.
-- The app user (`spms_app`) has no ALTER/GRANT and must NOT run this
-- section's DDL — it only needs the DML grant at the bottom.
--
-- Key decision (PRD 0025): this SUPERSEDES DATABASE.md's SECURE_DOCUMENTS
-- design (`encrypted_blob LONGBLOB`, `file_iv`, `file_tag`), which assumed
-- in-database blob storage. The reconciled shape below is metadata + a
-- unique `object_key` referencing the ciphertext object in the documents
-- bucket (PRD 0024). Client-side AES-256-GCM packs IV + ciphertext + auth tag
-- into ONE opaque blob per file (exactly as CREDENTIALS.encrypted_password
-- packs one opaque ciphertext string per field, per PRD 0009's reconciliation
-- note in src/ports/credentials.js) — so there is no separate file_iv/
-- file_tag column here, and no placeholder-column debt to carry forward.
--
-- VAULT_ITEMS (supertype, class-table inheritance) already exists — created
-- by the baseline schema script (DATABASE.md), not by an earlier numbered
-- migration in this directory. This migration only adds the DOCUMENT
-- subtype table; VAULT_ITEMS.item_type already includes 'DOCUMENT' in its
-- ENUM.
-- =============================================================================

CREATE TABLE SECURE_DOCUMENTS (
  item_id      INT           NOT NULL,                          -- shared PK with VAULT_ITEMS
  file_name    VARCHAR(255)  NOT NULL,
  file_type    VARCHAR(50)   NOT NULL,
  file_size_kb INT           NOT NULL,                           -- ORIGINAL plaintext size, not the ciphertext's
  object_key   VARCHAR(255)  NOT NULL,                           -- opaque key into the documents bucket (PRD 0024); never parsed for ownership
  CONSTRAINT PK_SECURE_DOCUMENTS       PRIMARY KEY (item_id),
  CONSTRAINT FK_SECURE_DOCUMENTS_ITEMS FOREIGN KEY (item_id)
       REFERENCES VAULT_ITEMS(item_id) ON DELETE CASCADE,
  CONSTRAINT UQ_SECURE_DOCUMENTS_OBJECT_KEY UNIQUE (object_key),
  CONSTRAINT CK_SECURE_DOCUMENTS_NAME CHECK (CHAR_LENGTH(TRIM(file_name)) >= 1),
  CONSTRAINT CK_SECURE_DOCUMENTS_TYPE CHECK (file_type IN
       ('application/pdf', 'image/png', 'image/jpeg')),
  CONSTRAINT CK_SECURE_DOCUMENTS_SIZE CHECK (file_size_kb BETWEEN 1 AND 10240)  -- 10 MB business rule
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- App user grant: full DML, same shape as every other non-audit table
-- (DATABASE.md section 2 / migration 0003's own grant).
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON securevault.SECURE_DOCUMENTS TO 'spms_app'@'%';
FLUSH PRIVILEGES;

-- -----------------------------------------------------------------------------
-- Verify (run after the above):
--   SHOW CREATE TABLE SECURE_DOCUMENTS;  -- FK to VAULT_ITEMS, UQ on object_key, the three CHECKs
--   SHOW GRANTS FOR 'spms_app'@'%';      -- SELECT,INSERT,UPDATE,DELETE on SECURE_DOCUMENTS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Down migration (reversible). Only ever run by the same admin/migration
-- user, and only if no documents have been uploaded — dropping this table
-- orphans any objects already sitting in the documents bucket (PRD 0024),
-- which this migration does not attempt to clean up.
-- -----------------------------------------------------------------------------
-- REVOKE SELECT, INSERT, UPDATE, DELETE ON securevault.SECURE_DOCUMENTS FROM 'spms_app'@'%';
-- DROP TABLE SECURE_DOCUMENTS;
