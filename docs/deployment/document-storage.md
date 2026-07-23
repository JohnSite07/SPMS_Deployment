# Document storage — the storage contract

The Cloud Storage side of encrypted document upload (UC-04/UC-06): what infrastructure already exists, the auth/env contract the app code builds against, and the retention semantics — so the Developer team can implement upload/download ([PRD 0025](../action_plan/0025-secure-document-code-implementation.md)) without guessing. Source of truth for what actually shipped: [PRD 0024](../action_plan/0024-secure-document-storage-infra-and-handoff.md).

## What's already provisioned (no new infra needed)

| Piece | State | Reference |
| --- | --- | --- |
| Bucket | `google_storage_bucket.documents` — private (`public_access_prevention = "enforced"`, `uniform_bucket_level_access = true`), `force_destroy = true` for clean teardown | [terraform/modules/data/main.tf](../../terraform/modules/data/main.tf) |
| Runtime IAM | Cloud Run runtime service account already holds `roles/storage.objectAdmin`, scoped to this one bucket only | [terraform/modules/iam/main.tf](../../terraform/modules/iam/main.tf) |
| Env wiring | Cloud Run already receives the bucket name as `DOCUMENTS_BUCKET` | [terraform/modules/app/main.tf](../../terraform/modules/app/main.tf) |
| Root output | `document_bucket_name` (surfaces `module.data.document_bucket_name`) | [terraform/outputs.tf](../../terraform/outputs.tf) |

Nothing above changed in PRD 0024 except the addition of the root output. The storage layer was provisioned back in [PRD 0002](../action_plan/0002-network-and-data.md) and wired for least privilege in [PRD 0003](../action_plan/0003-iam-and-wif.md).

## The upload model: proxy-through-app

Uploads go **through the Express app**, not the browser directly:

1. The client encrypts a file (AES-256, client-side) and POSTs the ciphertext to Express.
2. The app writes the ciphertext blob to Cloud Storage **server-side**, using the runtime service account.

There is no browser-to-GCS traffic. That is a deliberate choice (made jointly with PRD 0025), and it is why this is infrastructure-light:

- **No bucket CORS configuration** — the browser never talks to `storage.googleapis.com` directly.
- **No signed URLs** — signed URLs were considered and explicitly **not** chosen; they'd add `serviceAccountTokenCreator`/`signBlob` permission and CORS config for no benefit at single-user, ≤10 MB scale.
- **No new IAM** — the existing bucket-scoped `objectAdmin` grant on the runtime SA covers create/read/delete, exactly what upload/download/delete need.

## Auth model: Application Default Credentials

On Cloud Run, Application Default Credentials (ADC) **is** the runtime service account. The app configures **no key and no credentials file** — the `@google-cloud/storage` client library picks up ADC automatically from the Cloud Run environment. Do not:

- write a service-account key to the image or repo,
- pass explicit credentials to the Storage client constructor,
- assume any auth step beyond instantiating the client.

## Env var: `DOCUMENTS_BUCKET`

The app must read the bucket name from the **`DOCUMENTS_BUCKET`** environment variable — never hardcode a bucket name in code, tests, or docs. It's already set on the Cloud Run service ([terraform/modules/app/main.tf](../../terraform/modules/app/main.tf)) and documented in the env contract in [guides/developer-handover.md](../guides/developer-handover.md#env-contract).

## Data split: ciphertext in GCS, metadata in MySQL

**Cloud Storage holds opaque ciphertext blobs only. MySQL holds metadata and an object-key reference — never the blob.** This reconciles the historical disagreement between this repo's [architecture/overview.md](../architecture/overview.md) (Cloud Storage) and the Milestone 4 database design's `SECURE_DOCUMENTS.encrypted_blob LONGBLOB` column (Cloud SQL) — see [architecture/system-design-summary.md](../architecture/system-design-summary.md#open-cross-team-items--known-inconsistencies) item 1 — in favour of Cloud Storage.

The full schema and code-level decision (object-key format, the `SECURE_DOCUMENTS` row shape, the storage-boundary ADR) is [PRD 0025](../action_plan/0025-secure-document-code-implementation.md)'s job — this doc only fixes the infrastructure contract PRD 0025 builds against.

## Retention: documents persist until the user deletes them

The bucket carries **no age-based delete lifecycle rule**. An earlier default (`document_retention_days`, 365 days) would have auto-deleted every object a year after upload — silent, unrecoverable data loss for a document vault (versioning is off, so there is no soft-delete to fall back on). [PRD 0024](../action_plan/0024-secure-document-storage-infra-and-handoff.md) removed that rule; the `document_retention_days` Terraform variable was retired along with it.

**Current behaviour: a document lives in the bucket until the user deletes it through the app, or until `terraform destroy` tears the whole environment down** (`force_destroy = true` still wipes the bucket cleanly regardless of contents — teardown/cost-to-zero is unaffected). The only remaining lifecycle rule is `AbortIncompleteMultipartUpload` at age 7 days, which is upload hygiene (reaping abandoned multipart uploads), not data expiry.

> If you find older docs or notes describing a 365-day auto-expiry on the document bucket, that description is stale as of PRD 0024 — this page is the current statement.

## Local dev / CI: no real GCS

Developers have **no bucket IAM by design** — the `developer_project_roles` list in [terraform/modules/iam/main.tf](../../terraform/modules/iam/main.tf) grants no storage access. That's deliberate, matching the rest of the credentials policy in [guides/developer-handover.md](../guides/developer-handover.md#credentials-policy--read-this-first): local dev and CI should never need a real bucket.

- **Tests and local runs**: PRD 0025 provides an in-memory blob-store adapter so unit/integration tests are hermetic and need no GCP credentials at all.
- **Optional higher fidelity**: [`fake-gcs-server`](https://github.com/fsouza/fake-gcs-server) can be run locally to emulate the GCS API more closely — optional, not required.
- **Only Cloud Run exercises real GCS** in normal operation, running as the runtime service account. The one exception is the manual verification path below.

## Verifying the storage path works

See [runbooks/document-storage-smoke-test.md](../runbooks/document-storage-smoke-test.md) — the IAM-policy check (always available) and the impersonation smoke test (requires a temporary, reversible IAM grant).

## Related

- [PRD 0024](../action_plan/0024-secure-document-storage-infra-and-handoff.md) — the infra PRD this doc is the hand-off for.
- [PRD 0025](../action_plan/0025-secure-document-code-implementation.md) — the code implementation this contract unblocks.
- [architecture/overview.md](../architecture/overview.md) — runtime topology, including "Encrypted document blobs go to Cloud Storage."
- [guides/developer-handover.md](../guides/developer-handover.md#env-contract) — the full env-var contract, including `DOCUMENTS_BUCKET`.
- [runbooks/document-storage-smoke-test.md](../runbooks/document-storage-smoke-test.md) — verification runbook.
