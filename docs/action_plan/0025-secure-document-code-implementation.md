# 0025 — Secure Document Vault: Client-Side Encryption + Upload/List/Download/Delete (UC-04/UC-06)

Build the SecureDocument half of the vault: encrypt a file on the user's device, store the ciphertext blob in Cloud Storage with metadata in MySQL, and give the user upload / list / download / delete — the application code that PRD [0024](0024-secure-document-storage-infra-and-handoff.md) prepares the infrastructure for. This is the SCRUM-119/120 work deferred by PRD [0019](0019-credential-vault-ui-and-encryption.md).

| | |
| --- | --- |
| **Status** | Done |
| **Date** | 2026-07-23 |
| **Author** | Main session (orchestrator) — code deliverable, prepared for the developer team to execute; pairs with infra PRD [0024](0024-secure-document-storage-infra-and-handoff.md) |

## User story

As a logged-in SecureVault user, I want to upload a sensitive file (a passport scan, a tax return), see my stored documents, download one back, and delete one — with the file encrypted on my own device before it ever leaves it — so that even a full compromise of the database *and* the storage bucket never exposes the actual contents of my documents.

## Why this exists and what makes it different from the credential vault

The credential vault (PRD [0019](0019-credential-vault-ui-and-encryption.md)) established the whole pattern this PRD reuses: an in-memory vault key derived from the master password ([ADR 0015](../decisions/0015-vault-key-derivation-from-master-password.md)), client-side AES-256-GCM, an opaque ciphertext the server stores blindly, a class-table-inheritance `VAULT_ITEMS` + subtype row, ownership by `VAULTS.user_id`, and audit-logged CRUD. **Documents are the same pattern with two differences:**

1. **The ciphertext is a binary blob, not a short string, and it lives in Cloud Storage — not the database.** The DB row holds only metadata (`file_name`, `file_type`, `file_size_kb`) plus an **object-key reference** to the blob in GCS. This is the storage-location decision we made deliberately (Cloud Storage over a MySQL `LONGBLOB`) — cheaper, keeps the `db-f1-micro` instance small, and uses infra that already exists.
2. **Two systems must stay consistent.** A credential write is one DB transaction. A document write is a GCS object *and* a DB row — so this PRD owns the compensating-delete / orphan-reconciliation logic that a single transaction gave the credential vault for free.

## Storage-location decision (the thing to sign off on)

**Chosen: Cloud Storage for the blob, MySQL for metadata + object key.** This supersedes `DATABASE.md`'s `SECURE_DOCUMENTS.encrypted_blob LONGBLOB` design (and its `file_iv`/`file_tag` columns), which assumed in-DB storage. The reconciliation:

- `SECURE_DOCUMENTS` becomes: `item_id` (PK/FK→`VAULT_ITEMS`), `file_name`, `file_type`, `file_size_kb`, **`object_key`** (unique) — **no `encrypted_blob`, no `file_iv`, no `file_tag`.** Encryption is client-side and produces **one opaque blob per file** (IV + ciphertext + GCM tag packed together), exactly as the credential vault packs one opaque string per field — so the separate IV/tag columns the old design carried are not used here, and we do **not** inherit the `password_iv`/`password_tag` placeholder-column debt from PRD 0009/0014. We design the fresh table right.
- **Consequence, same class as the credential vault's:** a master-password reset re-derives the vault key and makes previously-stored document ciphertext undecryptable — identical to the accepted consequence in [ADR 0015](../decisions/0015-vault-key-derivation-from-master-password.md). No new sign-off beyond acknowledging it also now covers documents.

This decision, and the schema reconciliation, get an **ADR** (see Planned agents).

## Scope

**In scope:**

**Backend (`app/`):**

- **Migration `app/db/migrations/0004_secure_documents.sql`** — create `SECURE_DOCUMENTS` as metadata + `object_key` (per the reconciliation above): `item_id INT PK` / `FK → VAULT_ITEMS(item_id) ON DELETE CASCADE`, `file_name VARCHAR(255) NOT NULL` (≥1 trimmed char), `file_type VARCHAR(50)` `CHECK IN ('application/pdf','image/png','image/jpeg')`, `file_size_kb INT` `CHECK BETWEEN 1 AND 10240` (**10 MB business rule**), `object_key VARCHAR(255) NOT NULL UNIQUE`. Grant `SELECT, INSERT, UPDATE, DELETE` on the new table to `spms_app` (mirrors [DATABASE.md:314](DATABASE.md#L314)). Reconcile `DATABASE.md`'s `SECURE_DOCUMENTS` design and query catalogue to this shape in the same change.
- **`app/src/ports/blob-store.js`** — new. A tiny blob-store interface with two adapters: `createGcsBlobStore()` (real, `@google-cloud/storage`, bucket from `DOCUMENTS_BUCKET`, ADC auth — no key/credentials file, per the PRD 0024 contract) with `put(key, bytes)` / `get(key) → stream|bytes` / `remove(key)`; and `createInMemoryBlobStore()` (tests + local dev — the developer team never touches real GCS, per PRD 0024). Selected via config the same way the existing ports are wired ([app/src/config/unimplemented-ports.js](../../app/src/config/unimplemented-ports.js) pattern).
- **`app/src/ports/documents.js`** — new. Mirrors `ports/credentials.js` (class-table inheritance over `VAULT_ITEMS` + `SECURE_DOCUMENTS`, ownership through `VAULTS.user_id` = business rule 6). Methods: `transaction(fn)`, `add(tx, { userId, fileName, fileType, fileSizeKb, ciphertext })` (write blob → GCS, insert `VAULT_ITEMS` + `SECURE_DOCUMENTS` rows), `list({ userId })` (metadata only — **no blob fetch**), `get({ userId, itemId })` (metadata + the ciphertext stream from GCS), `remove(tx, { userId, itemId })` (delete rows + GCS object). Uses an **opaque random `object_key`** (e.g. a UUID) stored in the row — ownership is enforced by the DB join, never by parsing the key path.
- **`app/src/routes/documents.js`** — new router mounted at `/api/documents`, behind the same bearer auth as every other data route:
  - `POST /api/documents` — multipart upload (`multer`, memory storage, hard `limits.fileSize` at 10 MB + `file_type` allowlist), body carries already-encrypted ciphertext bytes + `fileName`/`fileType`/`fileSizeKb`; writes blob then metadata; audits `DOCUMENT_STORED`.
  - `GET /api/documents` — list metadata only; audits `DOCUMENTS_LISTED` (**new action** — same forensic reasoning as `CREDENTIALS_LISTED`: a stolen token could enumerate the whole vault in one call, which must leave a trail).
  - `GET /api/documents/:itemId` — stream the ciphertext blob back; audits `DOCUMENT_RETRIEVED`.
  - `DELETE /api/documents/:itemId` — delete after confirm; audits `DOCUMENT_DELETED` (**new action**).
- **`app/src/models/audit-entry.js`** — add `DOCUMENT_DELETED` (`document.deleted`) and `DOCUMENTS_LISTED` (`documents.listed`) to the `ACTIONS` vocabulary. (`DOCUMENT_STORED`/`DOCUMENT_RETRIEVED` already exist — [audit-entry.js:40](../../app/src/models/audit-entry.js#L40).) Additive to the closed vocabulary; no change to existing action meanings.
- **Wire the documents + blob-store ports** into `app/src/app.js` and out of the unimplemented set ([unimplemented-ports.js](../../app/src/config/unimplemented-ports.js)) — the app must fail loudly if the real ports aren't wired, exactly like today.
- **Two-system consistency (this PRD's distinctive work):**
  - **Add order:** write the GCS object **first**, then the DB rows in a transaction. If the DB transaction fails, issue a **compensating delete** of the just-written object so no orphan blob survives.
  - **Delete order:** delete the DB rows (transaction) **first**, then the GCS object. If the GCS delete fails after the DB commit, log it and rely on reconciliation (a dangling *blob* is invisible to the user and cheap; a dangling *row* pointing at a missing blob is the worse failure, so DB-first is deliberate).
  - **Reconciliation:** a documented **manual maintenance query/script** to list GCS objects with no owning DB row (and vice versa). Automating it (a scheduled job) is out of scope — single-user, low-volume, and PRD 0024 removed the lifecycle auto-delete that would otherwise fight it.

**Frontend (`client/`):**

- **`client/src/services/document-crypto.js`** — new. Encrypt/decrypt **binary** `File`/`ArrayBuffer` with the in-memory vault key from [vault-key-store.js](../../client/src/services/vault-key-store.js) (reuse the existing derived `CryptoKey`; extend the [vault-crypto.js](../../client/src/services/vault-crypto.js) primitives, which today handle strings, to handle raw bytes). AES-256-GCM over the file bytes → one opaque blob (IV + ciphertext + tag) for upload; reverse on download → `Blob` for save. Wrong-key decrypt fails closed (GCM auth error), never returns garbage — same guarantee as the credential vault.
- **`client/src/services/document-service.js`** — new. All calls through [api-client.js](../../client/src/services/api-client.js) (frontend rule 3 — never raw `fetch`). Multipart upload and binary download need a body type the JSON client doesn't cover today, so **extend `api-client.js`** with a multipart/binary-capable method rather than bypassing it.
- **`client/src/pages/Documents.jsx`** — new screen: **list** (react-bootstrap `Table`/`ListGroup`, file name/type/size, newest first), **upload** (file picker; client-side validate ≤10 MB + PDF/PNG/JPEG *before* encrypting; encrypt → upload), **download** (fetch ciphertext → decrypt → save), **delete** (confirmation `Modal` before `DELETE`). Secure-by-default (frontend rule 6): files are ciphertext at rest and on the wire; decrypt only on an explicit download action.
- **Routing/nav** — add the Documents screen to [Layout.jsx](../../client/src/pages/Layout.jsx)'s nav and the router (a `/documents` route, alongside the existing `/credentials`).
- **Tests both sides** — `document-crypto.js` round-trip + wrong-key-fails-closed; `ports/documents.js` and the route (ownership, 10 MB/type rejection, audit writes, compensating delete on simulated DB failure) against the in-memory blob store; Vitest for `Documents.jsx`'s four flows and for "ciphertext-only on the wire" (inspect the upload body).

**Out of scope:**

- **All infrastructure** — bucket, IAM, env var, retention. That is PRD [0024](0024-secure-document-storage-infra-and-handoff.md). This PRD assumes 0024's storage contract (ADC auth, `DOCUMENTS_BUCKET`, ciphertext-in-GCS).
- **Signed-URL / direct browser-to-GCS uploads** — not chosen (see 0024); uploads proxy through the app.
- **In-browser preview/thumbnails** of decrypted documents — download-and-open only for now; inline rendering is a follow-up.
- **Document versioning / edit-in-place of contents** — a document is upload-once/delete; "replace" = delete + re-upload. (Metadata rename could be a small follow-up.)
- **Fixing password-reset to re-encrypt the vault** — unchanged from PRD 0019; the reset-orphans-vault-data consequence now also covers documents, accepted, not fixed here.
- **Encrypting the file *name*/metadata** — `file_name`/`file_type`/`file_size_kb` are stored as plaintext metadata, exactly as the credential vault stores `title`/`url`/`username` in plaintext. Flagged as a known, consistent trade-off (file names can be sensitive) — revisit vault-wide, not per-feature.
- **Automated orphan reconciliation job** — manual query only (see above).

## Success criteria

- [ ] Uploading a file encrypts it client-side **before** it is sent — verified by inspecting the upload request body in a test (only ciphertext, never the original bytes, on the wire).
- [ ] The blob lands in Cloud Storage as ciphertext; the DB row holds metadata + `object_key` and **no blob**.
- [ ] `GET /api/documents` returns only the caller's own documents (business rule 6), metadata only.
- [ ] Download fetches the ciphertext and decrypts it client-side back to a byte-identical file; a wrong-key decrypt throws (GCM auth failure), never yields garbage.
- [ ] Files > 10 MB or of a non-PDF/PNG/JPEG type are rejected (client-side and server-side).
- [ ] Deleting requires an explicit confirmation, removes both the DB row and the GCS object, and audits `DOCUMENT_DELETED`.
- [ ] A simulated DB failure during add leaves **no orphan blob** in the store (compensating delete fires).
- [ ] Each action writes its audit entry (`DOCUMENT_STORED` / `DOCUMENTS_LISTED` / `DOCUMENT_RETRIEVED` / `DOCUMENT_DELETED`).
- [ ] `npm test` / `npm run lint` (app) and `npm run lint` / `npm test` / `npm run build` (client) are green; unit/integration tests use the **in-memory blob store** and never touch real GCS.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `app/db/migrations/0004_secure_documents.sql` | New — `SECURE_DOCUMENTS` (metadata + `object_key`) + grant | $0 (existing DB) |
| `app/src/ports/blob-store.js` | New — GCS + in-memory adapters | $0 |
| `app/src/ports/documents.js` | New — metadata port (class-table inheritance) | $0 |
| `app/src/routes/documents.js` | New — `/api/documents` CRUD | $0 |
| `app/src/models/audit-entry.js` | Edit — add 2 actions | $0 |
| `app/src/app.js`, `config/unimplemented-ports.js` | Edit — wire real ports | $0 |
| `@google-cloud/storage`, `multer` | New npm deps (app) | $0 (bundled in image) |
| `client/src/services/document-crypto.js` | New — binary AES-256-GCM | $0 |
| `client/src/services/document-service.js` | New — API calls | $0 |
| `client/src/services/api-client.js` | Edit — multipart/binary method | $0 |
| `client/src/pages/Documents.jsx`, `Layout.jsx`, router | New/Edit — UI + nav | $0 |
| Tests (app + client) | New | $0 |
| Cloud Storage bucket + runtime SA IAM | **Existing** (PRD 0024) — used, not created | ~$0 (a few ≤10 MB blobs) |

No new GCP resource. Storage cost is effectively $0 at this scale and returns to $0 on `terraform destroy`.

References:

- Pattern to mirror: [app/src/ports/credentials.js](../../app/src/ports/credentials.js), [app/src/routes/credentials.js](../../app/src/routes/credentials.js), [client/src/pages/Credentials.jsx](../../client/src/pages/Credentials.jsx).
- Vault key + crypto to reuse/extend: [ADR 0015](../decisions/0015-vault-key-derivation-from-master-password.md), [client/src/services/vault-crypto.js](../../client/src/services/vault-crypto.js), [vault-key-store.js](../../client/src/services/vault-key-store.js).
- Schema being reconciled: [DATABASE.md](DATABASE.md) `SECURE_DOCUMENTS` (§5) and its query catalogue.
- Storage contract + infra: PRD [0024](0024-secure-document-storage-infra-and-handoff.md).
- Wireframes: [docs/architecture/ui-ux-guidelines.md](../../docs/architecture/ui-ux-guidelines.md) (document screens).

## Scripts / commands

No billable command. Local only.

```bash
# app/
npm install            # adds @google-cloud/storage, multer
npm run lint && npm test

# client/
npm run lint && npm test && npm run build

# Apply the migration against the dev DB (per the established migration runbook / DATABASE.md).
# Tests do NOT need real GCS — the in-memory blob store covers them.
```

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| 1 | `app-engineer` | Backend: migration `0004`, `blob-store.js` (GCS + in-memory), `documents.js` port, `/api/documents` routes, audit actions, app wiring; two-system consistency (compensating delete); tests against the in-memory store. | Green app `lint`/`test`. |
| 2 | `app-engineer` | Frontend: `document-crypto.js` (binary), `document-service.js`, `api-client.js` multipart method, `Documents.jsx`, nav/route; Vitest for the four flows + ciphertext-on-wire. | Green client `lint`/`test`/`build`. |
| 3 | `infra-reviewer` | Security pass: plaintext never leaves the client or reaches a log; ADC auth (no key) and `DOCUMENTS_BUCKET` used, not hardcoded; ownership on list/get/delete; 10 MB/type enforced server-side (not just client); compensating delete leaves no orphan; wrong-key decrypt fails closed; audit coverage incl. the two new actions. | Findings / sign-off. |
| 4 | `documentation-keeper` | **ADR** for the document-storage decision (Cloud Storage blob + DB metadata/object-key, the schema reconciliation vs `DATABASE.md`, the two-system consistency model, and the password-reset consequence extended to documents). Reconcile `DATABASE.md`; update `overview.md`/`domain-model.md` pointers; PRD Outcome + index. | Updated `docs/`. |

## Testing / verification plan

| Success criterion | Verification | Expected |
| --- | --- | --- |
| Client-side encryption before send | Inspect upload request body in a test | Only ciphertext; original bytes never present |
| Blob in GCS, metadata in DB | Add a doc; inspect the DB row + blob store | Row has `object_key`, no blob; store has the ciphertext object |
| List ownership | `GET /api/documents` as two users | Each sees only their own; metadata only |
| Download round-trip + fail-closed | Download with right vs. wrong vault key | Right → byte-identical file; wrong → GCM auth error, never garbage |
| Size/type limits | Upload 11 MB / a `.exe` | Rejected client-side **and** server-side |
| Delete + confirm + audit | Delete a doc | Blocked without confirm; row + object both gone; `DOCUMENT_DELETED` written |
| No orphan on partial failure | Simulate DB failure mid-add | Compensating delete fires; blob store has no orphan |
| Audit coverage | Exercise all four routes | Four distinct actions logged, once each |
| Gates green (hermetic) | app + client `lint`/`test`/`build` with in-memory store | Pass; no real GCS touched |
| Review | Step 3 | Sign-off, no high-severity open |

## Additional considerations

- **Security posture / zero-knowledge.** The app handles only opaque ciphertext bytes — it never decrypts, and (as with credentials) there is no point at which document plaintext exists server-side, so none can reach a log or GCS. The derived vault key stays non-extractable and in-memory only ([ADR 0015](../decisions/0015-vault-key-derivation-from-master-password.md)); documents inherit the auto-lock/logout key-clearing already built. A DB **and** bucket compromise together still yields only ciphertext.
- **Memory footprint on Cloud Run.** `multer` memory storage buffers the ≤10 MB ciphertext in the 512 MiB container; fine at `max=2` and single-user. If this ever felt tight, stream multipart straight to GCS — noted, not needed now. (Contrast: this buffering pressure on the *`db-f1-micro`* is exactly what the Cloud Storage decision avoids.)
- **Two-system consistency** is the real engineering content here (a single DB transaction can't span GCS). The add-then-DB-with-compensating-delete and DB-then-GCS-delete orders, plus the manual reconciliation query, are specified above and must be covered by tests — the compensating-delete test is a success criterion, not optional.
- **Rollback / teardown.** App code + one additive migration. Rollback = `git revert`; the migration only *adds* a table (a down-migration drops `SECURE_DOCUMENTS`). Stored blobs die with the bucket on `terraform destroy` (PRD 0024, `force_destroy`). Reverting the code after real use would orphan any blobs already in the bucket — flagged, same class as any stateful revert.
- **Open questions:**
  - Confirm the **storage-location decision** and the `DATABASE.md` schema reconciliation (drop `encrypted_blob`/`file_iv`/`file_tag`, add `object_key`) before implementation starts.
  - Multipart upload vs. base64-in-JSON: recommend **multipart** (a 10 MB blob base64s to ~13 MB and doubles memory) — confirm.
- **Dependencies.** Assumes PRD [0024](0024-secure-document-storage-infra-and-handoff.md)'s storage contract; 0024's `apply` should land before 0025's integration/smoke tests run against real GCS, but 0025's unit/integration suite is hermetic (in-memory adapter) and can be built in parallel. Reuses the credential-vault key lifecycle, `api-client.js`, and the confirm-before-delete UX precedent.

## Outcome

Shipped as planned. Gates green: app `npm run lint` clean, `npm test` **625 passed / 1 skipped**; client `npm run lint` clean, `npm test` **188 passed**, `npm run build` OK. All tests hermetic — the in-memory blob store, never real GCS.

**Backend** — migration `app/db/migrations/0004_secure_documents.sql` (new `SECURE_DOCUMENTS`: metadata + `object_key`, per the reconciliation below); `app/src/ports/blob-store.js` (new: `createGcsBlobStore()` on Application Default Credentials, `createInMemoryBlobStore()` for tests/dev); `app/src/ports/documents.js` (new: class-table-inheritance metadata port, mirrors `ports/credentials.js`); `app/src/routes/documents.js` (new: `POST`/`GET`/`GET :itemId`/`DELETE` on `/api/documents`). Two new audit actions, `DOCUMENT_DELETED` and `DOCUMENTS_LISTED` (`DOCUMENT_STORED`/`DOCUMENT_RETRIEVED` already existed in the closed vocabulary, reused rather than duplicated). Wired into `app.js`/`server.js`. New deps: `@google-cloud/storage@^7`, `multer@^2`.

**Frontend** — `client/src/pages/Documents.jsx` (the Figure 13 screen: list/upload/download/delete), `client/src/services/document-crypto.js` (binary AES-256-GCM, extending `vault-crypto.js`'s primitives), `client/src/services/document-service.js` (all calls through `api-client.js`). `api-client.js` gained `postMultipart`/`getBinary` methods rather than any raw `fetch` bypass. `vault-crypto.js` gained binary `encryptBytes`/`decryptBytes` alongside its existing string `encryptField`/`decryptField`.

**Storage-location decision, recorded as an ADR:** [ADR 0017](../decisions/0017-secure-document-ciphertext-in-cloud-storage.md) — Cloud Storage for the ciphertext blob, MySQL for metadata + `object_key` only, superseding `DATABASE.md`'s original `encrypted_blob LONGBLOB`/`file_iv`/`file_tag` design. `DATABASE.md`'s `SECURE_DOCUMENTS` DDL, seed data, and query catalogue are reconciled to the shipped shape in the same change, with pointers back to the ADR. `docs/architecture/domain-model.md` and `docs/architecture/system-design-summary.md` updated to stop describing document upload as unbuilt / the storage boundary as open.

**Deviations from the plan, none scope/cost/security-changing:**
- **`multer@^2`, not the `^1.4.5-lts` line** — 2.x was current at implementation time and closes CVEs the 1.x line carries; no API-shape impact on this router.
- **`app/src/config/unimplemented-ports.js` left untouched** — verified unreferenced/stale scaffold rather than the real wiring point (the documents/blob-store ports are wired directly in `app.js`/`server.js`). Flagged as tech-debt: dead code, not edited here since editing unrelated dead code was out of this PRD's scope.
- **Two-layer compensating delete** — `ports/documents.js`'s `add()` compensates for a failed INSERT itself, and `routes/documents.js`'s `POST` handler adds a second, outer catch around the whole transaction (including the audit-entry write) so a later failure in the same call still can't orphan the blob. Slightly more defensive than the PRD's single-layer description; not a scope change.
- **`VAULT_ITEMS.title` is set to the uploaded `fileName`** — there is no separate document title field, matching the credential vault's use of `VAULT_ITEMS.title` for its own display name.
- **Upload auto-starts on file selection** — there is no separate "Add" step/form, because a document has no metadata to fill in beyond the file itself (name/type/size are read from the file). Selecting a file immediately encrypts and uploads it.
- **Empty files (0 KB) are rejected client-side** — `file_size_kb`'s `CHECK BETWEEN 1 AND 10240` requires at least 1, so a 0-byte file is refused before it is ever encrypted or sent, rather than surfacing as a confusing server-side 400.

**Security review (infra-reviewer, step 3): PASS-WITH-NITS.** All ten zero-knowledge / security properties verified with test evidence: no plaintext server-side (the app only moves opaque bytes; nothing decrypts server-side); the client encrypts before the multipart body is built (ciphertext-on-wire asserted); ADC-only GCS auth with the bucket from `DOCUMENTS_BUCKET` (no key file, no hardcoded bucket); ownership enforced by the `VAULTS.user_id` join on list/get/delete (cross-user access → 404, never an oracle); 10 MB + PDF/PNG/JPEG enforced server-side independent of the client; compensating delete leaves no orphan blob (tested at both the port and route layers); wrong-key/tampered decrypt fails closed (GCM auth error, never garbage); all four audit actions written once each, before disclosure; `object_key` is a random UUID never serialized to the client; no secrets committed and the `fetch`/web-storage bans still hold.

One **HIGH** finding was raised and **fixed in this PRD** before merge: the download route streamed the blob back with a bare `doc.stream.pipe(res)` and no `error` listener — with the real GCS adapter a mid-stream failure (network blip, or a row whose backing object is missing) would emit `'error'` outside `asyncRoute`'s promise chain and crash the whole Cloud Run instance rather than failing the one request. Fixed in `routes/documents.js` by piping under an `error` handler that fails only that request (`502 blob_unavailable` if no bytes have flowed, else aborts the response); regression test added in `tests/document-download-stream-error.test.js`. That fix also surfaced and corrected a latent bug — `res.json()` does not override an already-set `Content-Type`, so the error body would have shipped mislabelled as `application/octet-stream`; the error branch now resets it to JSON. App suite is **627 passed / 1 skipped** after these two additions.

The reviewer's remaining items are accepted follow-ups, not blockers: `file_size_kb` is client-reported metadata not cross-checked against the actual ciphertext length (bounded anyway by multer's byte cap; no current consumer of the invariant, single-user scale); and `asyncRoute` is imported from the sibling `routes/credentials.js` rather than a shared util (harmless; a `routes/util.js` extraction is a tidy-up for when a third route needs it). `file_type` remaining unverified client metadata (no magic-byte check) is the same accepted trade-off the PRD already scoped out.
