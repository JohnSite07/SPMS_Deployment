# 0017 — Secure document ciphertext lives in Cloud Storage; MySQL holds metadata + `object_key` only

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Main session (orchestrator), via [PRD 0024](../action_plan/0024-secure-document-storage-infra-and-handoff.md) (infra) and [PRD 0025](../action_plan/0025-secure-document-code-implementation.md) (code)

## Context

The Milestone 4 System Design's Part II DDL (captured verbatim in [`DATABASE.md`](../action_plan/DATABASE.md)) defines `SECURE_DOCUMENTS` with an in-database `encrypted_blob LONGBLOB` column plus its own `file_iv`/`file_tag` columns — the same server-held-ciphertext shape as the original `CREDENTIALS` design. This repo's own [architecture/overview.md](../architecture/overview.md) (Part III, DevOps-owned) had already committed to a different shape: "encrypted document blobs go to Cloud Storage." [`system-design-summary.md`](../architecture/system-design-summary.md#open-cross-team-items--known-inconsistencies) flagged this as an open cross-team inconsistency (item 1) between Part II and Part III.

[PRD 0024](../action_plan/0024-secure-document-storage-infra-and-handoff.md) confirmed the Cloud Storage side (bucket, IAM, `DOCUMENTS_BUCKET` env var, proxy-through-app upload — see [deployment/document-storage.md](../deployment/document-storage.md)) was already provisioned and fixed its retention behaviour. [PRD 0025](../action_plan/0025-secure-document-code-implementation.md) then had to settle the schema and the storage-location decision before writing any code, because both are effectively permanent once real documents exist under them — the same class of decision as [ADR 0015](0015-vault-key-derivation-from-master-password.md) for the credential vault.

## Decision

**The encrypted document blob is stored as an object in Cloud Storage. MySQL's `SECURE_DOCUMENTS` table holds only metadata and an opaque `object_key` reference to that object — never the ciphertext itself.**

Rationale:

- **Cost.** A `LONGBLOB` column would grow `db-f1-micro`'s 10 GB SSD with every uploaded file; Cloud Storage is priced for exactly this shape of data and keeps the smallest Cloud SQL tier viable for the $300 budget.
- **Reuse.** The documents bucket, its `objectAdmin` IAM grant, and the `DOCUMENTS_BUCKET` env wiring already exist ([PRD 0024](../action_plan/0024-secure-document-storage-infra-and-handoff.md)) — no new GCP resource, no schema bloat.
- **Separation of concerns.** MySQL stays the ownership/metadata authority (joins through `VAULTS.user_id`, business rule 6); Cloud Storage is a dumb, opaque blob store that never sees a `userId` or `itemId` — see [`app/src/ports/blob-store.js`](../../app/src/ports/blob-store.js)'s header.

### Schema reconciliation vs. `DATABASE.md`

`SECURE_DOCUMENTS` (as created by [`app/db/migrations/0004_secure_documents.sql`](../../app/db/migrations/0004_secure_documents.sql)) is:

- `item_id` — `PK`, `FK → VAULT_ITEMS(item_id) ON DELETE CASCADE` (unchanged: still class-table inheritance, shared PK with the supertype).
- `file_name` — `NOT NULL`, ≥1 trimmed character.
- `file_type` — `CHECK IN ('application/pdf', 'image/png', 'image/jpeg')`.
- `file_size_kb` — `CHECK BETWEEN 1 AND 10240` (the 10 MB business rule; the **original plaintext** size, not the ciphertext's).
- `object_key` — `UNIQUE`, `NOT NULL`: an opaque `crypto.randomUUID()` addressing the object in the documents bucket. Never parsed for ownership or derived from anything about the user — ownership is enforced entirely by the DB join, never by the key's shape.

**Dropped, relative to `DATABASE.md`'s original design:** `encrypted_blob LONGBLOB`, `file_iv VARBINARY(12)`, `file_tag VARBINARY(16)`. Encryption is client-side ([`client/src/services/document-crypto.js`](../../client/src/services/document-crypto.js), extending [`vault-crypto.js`](../../client/src/services/vault-crypto.js)'s primitives to binary data) and produces **one opaque blob per file** — a random IV, the ciphertext, and the GCM auth tag packed together — exactly as the credential vault packs one opaque string per field (`encryptField`/`decryptField`). There is therefore nothing for separate `file_iv`/`file_tag` columns to hold, and this migration deliberately does not inherit the unused `password_iv`/`password_tag` placeholder-column debt the `CREDENTIALS` table carries (see [PRD 0009](../action_plan/0009-storage-layer-and-auth-wiring.md)'s reconciliation note, referenced in `ports/credentials.js`) — the fresh table is designed right from its first migration.

Grant: `SELECT, INSERT, UPDATE, DELETE` on `SECURE_DOCUMENTS` to `spms_app` — the same least-privilege DML shape as every other non-audit table (`DATABASE.md` §2), applied by the migration itself rather than a separate hand-run grant.

Source: [`app/db/migrations/0004_secure_documents.sql`](../../app/db/migrations/0004_secure_documents.sql). Code that reads/writes this shape: [`app/src/ports/documents.js`](../../app/src/ports/documents.js) (metadata, class-table inheritance), [`app/src/ports/blob-store.js`](../../app/src/ports/blob-store.js) (the blob, two adapters), [`app/src/routes/documents.js`](../../app/src/routes/documents.js) (`/api/documents` CRUD).

### Two-system consistency model

A credential write is one MySQL transaction. A document write spans **two systems** — a Cloud Storage object and a MySQL row — that no single transaction can cover. The chosen ordering, opposite on each side, deliberately trades "possible orphan blob" (cheap, invisible to the user) against "possible dangling row" (the failure mode that actually matters, since it points at a missing blob):

- **Add:** write the blob to Cloud Storage **first** (`blobStore.put`), then insert the `VAULT_ITEMS`/`SECURE_DOCUMENTS` rows in a transaction. If the transaction fails, `ports/documents.js`'s `add()` issues a **compensating delete** of the just-written object before the error propagates. `routes/documents.js`'s `POST` handler adds a second layer of the same guard around the *whole* transaction (including the audit-entry write), so a failure after `add()` returns still cannot leave an orphaned blob.
- **Delete:** delete the DB rows in a transaction **first** (`ports/documents.js`'s `remove()`, sharing the transaction with the `DOCUMENT_DELETED` audit entry), then delete the Cloud Storage object, best-effort, after the commit is certain (`routes/documents.js`'s `DELETE` handler). A GCS delete failure at this point is logged and does not fail the request — a dangling blob is acceptable and cheap; a dangling row pointing at a missing blob is not, so the row must be gone first.
- **Reconciliation** for whatever orphans do occur (a crash between steps, a GCS failure during delete) is a **documented manual maintenance query** — listing bucket objects with no owning `SECURE_DOCUMENTS.object_key` and vice versa — not an automated scheduled job. Deliberately out of scope: single-user, low-volume, and PRD 0024 already removed the lifecycle auto-delete rule that would otherwise fight any such job.

### Consequence: password reset still orphans document ciphertext

The vault key is derived directly from the master password ([ADR 0015](0015-vault-key-derivation-from-master-password.md)) and never stored or wrapped. Resetting the master password re-derives that key and does not re-encrypt anything already stored under the old one. This consequence was accepted for credentials in ADR 0015; it now extends unchanged to documents — a document uploaded before a password reset is undecryptable after it, identically to a pre-reset credential. No new sign-off was needed beyond acknowledging the scope now covers documents too.

### Auth and upload model (ambient facts this decision assumes)

- The app reaches Cloud Storage via **Application Default Credentials** — no key file. On Cloud Run, ADC *is* the runtime service account, already IAM-scoped to the documents bucket only (`roles/storage.objectAdmin`, per [PRD 0024](../action_plan/0024-secure-document-storage-infra-and-handoff.md)). See `createGcsBlobStore()` in [`app/src/ports/blob-store.js`](../../app/src/ports/blob-store.js).
- The bucket name is read from the **`DOCUMENTS_BUCKET`** environment variable — never hardcoded.
- Uploads are **multipart**, proxied through the Express app (`multer`, memory storage) — not signed-URL direct-to-GCS. This keeps the browser from ever talking to `storage.googleapis.com` directly, so no bucket CORS configuration or `serviceAccountTokenCreator`/`signBlob` permission is needed. See [deployment/document-storage.md](../deployment/document-storage.md) for the full storage contract this decision builds on.

## Alternatives considered

- **Keep `SECURE_DOCUMENTS.encrypted_blob LONGBLOB` in Cloud SQL** (the milestone's original Part II design). Rejected: grows the smallest viable Cloud SQL tier with every uploaded file, works against the $300-budget constraint that keeps `db-f1-micro` viable, and duplicates storage the documents bucket already provides for free at this scale.
- **Signed-URL direct-to-browser upload to Cloud Storage.** Considered jointly with PRD 0024 and rejected there: needs `serviceAccountTokenCreator`/`signBlob` IAM and bucket CORS configuration for no real benefit at single-user, ≤10 MB scale. Proxy-through-app was chosen instead, which is also what keeps the ciphertext-only guarantee simple to reason about (the app never has to trust a browser-originated GCS write).
- **Automated orphan-reconciliation job** (a scheduled Cloud Function/Cloud Run job auditing bucket-vs-DB consistency). Rejected for this scope: single-user, low-volume, and the manual query is sufficient; revisit if usage or user count ever grows enough to make manual reconciliation impractical.

## Consequences

- **This is now the storage-boundary counterpart to ADR 0015.** A future change to `ports/documents.js`, `ports/blob-store.js`, or the add/delete ordering above should be reviewed against this ADR, not just against the code it touches.
- **A DB backup restores metadata, not content.** Restoring `SECURE_DOCUMENTS` from a Cloud SQL backup without also having the referenced bucket objects yields rows with no blob behind them — the two systems must be reasoned about together for any backup/restore or migration procedure, not just for normal operation.
- **The manual reconciliation query is not yet a runbook.** It is specified in [PRD 0025](../action_plan/0025-secure-document-code-implementation.md#scope) as the accepted approach but has not been written up as a step-by-step `docs/runbooks/` procedure — flagged as a documentation gap, not a code one.
- **File names and types are plaintext metadata**, exactly as the credential vault stores `title`/`url`/`username` in plaintext — a known, consistent trade-off (file names can be sensitive) noted in PRD 0025 as a vault-wide question to revisit, not something this ADR resolves.

## Related

- [PRD 0024 — Secure Document Storage: Infrastructure Confirmation, Retention Fix & Developer Hand-off](../action_plan/0024-secure-document-storage-infra-and-handoff.md) — provisions and hands off the Cloud Storage side this decision assumes.
- [PRD 0025 — Secure Document Vault: Client-Side Encryption + Upload/List/Download/Delete](../action_plan/0025-secure-document-code-implementation.md) — the PRD this ADR was written for.
- [ADR 0015 — Vault-key derivation from the master password](0015-vault-key-derivation-from-master-password.md) — the key lifecycle and password-reset consequence this ADR extends to documents.
- [`docs/action_plan/DATABASE.md`](../action_plan/DATABASE.md) — the `SECURE_DOCUMENTS` schema and query catalogue, reconciled to this decision.
- [`docs/deployment/document-storage.md`](../deployment/document-storage.md) — the infrastructure-side storage contract (auth, env var, retention) this decision builds on.
- [`docs/architecture/system-design-summary.md`](../architecture/system-design-summary.md#open-cross-team-items--known-inconsistencies) — the cross-team inconsistency (item 1) this ADR resolves.
- [`app/src/ports/documents.js`](../../app/src/ports/documents.js), [`app/src/ports/blob-store.js`](../../app/src/ports/blob-store.js), [`app/src/routes/documents.js`](../../app/src/routes/documents.js), [`app/db/migrations/0004_secure_documents.sql`](../../app/db/migrations/0004_secure_documents.sql) — the implementation.
