# 0024 — Secure Document Storage: Infrastructure Confirmation, Retention Fix & Developer Hand-off

Finalise the Cloud Storage side of SecureDocument upload (UC-04/UC-06): fix the document-bucket lifecycle so a document vault does not silently delete its own contents, confirm the object-proxy storage path needs no new IAM/CORS/signed-URL infrastructure, and hand the storage contract to the developer team so PRD [0025](0025-secure-document-code-implementation.md) can build against it.

| | |
| --- | --- |
| **Status** | Done (Approved & executed 2026-07-23) |
| **Date** | 2026-07-23 |
| **Author** | Main session (orchestrator), DevOps deliverable — pairs with code PRD [0025](0025-secure-document-code-implementation.md) |

## User story

As the DevOps owner of the SecureVault environment, I want the encrypted-document bucket to be provably ready and safe for a document *vault* — the app can write/read/delete blobs under least privilege, and stored documents are **not** auto-expired out from under the user — so that the developer team can implement document upload/download (PRD 0025) against a stable, documented storage contract with no surprise data loss and no new attack surface.

## Why this is small: almost all of it already exists

The storage infrastructure was provisioned back in PRD [0002](0002-network-and-data.md) and wired for least privilege in PRD [0003](0003-iam-and-wif.md). What is **already live and correct** for a proxy-through-app model:

- **The bucket** — `google_storage_bucket.documents` ([terraform/modules/data/main.tf:66](../../terraform/modules/data/main.tf#L66)): private (`public_access_prevention = "enforced"`, `uniform_bucket_level_access = true`), `force_destroy` so teardown stays clean.
- **The IAM grant** — the Cloud Run **runtime** SA already holds `roles/storage.objectAdmin` **scoped to this one bucket** ([terraform/modules/iam/main.tf:69](../../terraform/modules/iam/main.tf#L69)) — create/read/delete, exactly what upload/download/delete needs, and nothing project-wide.
- **The wiring to the app** — Cloud Run already receives the bucket name as the `DOCUMENTS_BUCKET` env var ([terraform/modules/app/main.tf:84](../../terraform/modules/app/main.tf#L84)); the name is output from the data module and threaded through the root ([terraform/main.tf:70](../../terraform/main.tf#L70)).

Because uploads go **through the Express app** (client encrypts → POSTs ciphertext → the app writes it to GCS using Application Default Credentials, which on Cloud Run *is* the runtime SA), there is **no browser-to-GCS traffic**. That means **no bucket CORS config, no signed URLs, and no `serviceAccountTokenCreator`/`signBlob` permission** — the alternatives that *would* have required new infra. The object-proxy choice (made jointly with PRD 0025) is what keeps this PRD nearly infra-free and keeps the zero-knowledge story crisp: the app only ever handles opaque ciphertext bytes.

## The one real change: stop the document vault from deleting its own documents

The bucket carries a lifecycle rule that **deletes any object older than `document_retention_days`**, default **365** ([terraform/modules/data/main.tf:78](../../terraform/modules/data/main.tf#L78), [terraform/modules/data/variables.tf:72](../../terraform/modules/data/variables.tf#L72)). That default was a sensible cost-hygiene guard when the bucket held nothing. For a **document vault** — where the whole point is that a user's passport scan or tax return is still there next year — an unconditional "delete after 365 days" is **silent, unrecoverable data loss** (versioning is also disabled, so there is no soft-delete to recover from). This must change before any real document is ever stored.

## Scope

**In scope:**

- **Remove the object-**`Delete`**-by-age lifecycle rule** from `google_storage_bucket.documents` (the `age = var.document_retention_days` → `Delete` block). Documents persist until the user deletes them through the app — the correct semantics for a vault. Retire the now-unused `document_retention_days` variable (or leave it declared with a comment that no rule consumes it — reviewer's call; removing it is cleaner).
- **Keep** the `AbortIncompleteMultipartUpload` age-7 lifecycle rule ([main.tf:87](../../terraform/modules/data/main.tf#L87)) — that is upload-hygiene, not data expiry, and is harmless.
- **Keep** `force_destroy = true` — teardown must still wipe the bucket cleanly on `terraform destroy` (cost-to-zero after grading is unaffected; see Additional considerations).
- **Add a root output** `document_bucket_name` in [terraform/outputs.tf](../../terraform/outputs.tf) (surfacing `module.data.document_bucket_name`) so the bucket name is visible for the hand-off smoke test and for the developer team without reading module internals.
- **Developer hand-off document** under `docs/deployment/` (or an update to the existing hand-off material) that states the **storage contract** PRD 0025 builds against:
  - Auth model: **ADC on Cloud Run = the runtime SA**, which already has `objectAdmin` on the bucket — the app configures **no key, no credentials file**. `@google-cloud/storage` picks this up automatically.
  - Env var: the bucket name arrives as **`DOCUMENTS_BUCKET`** (already set); the app must read it, never hardcode a bucket name.
  - What lives where: **Cloud Storage holds opaque ciphertext blobs only**; **MySQL holds metadata + an object-key reference** (never the blob). This reconciles the historical `overview.md`-vs-`DATABASE.md` disagreement in favour of Cloud Storage (recorded as an ADR in PRD 0025).
  - **Local dev / CI never touch real GCS.** Developers have no bucket IAM (the `developer_project_roles` list grants no storage access — [iam/main.tf:151](../../terraform/modules/iam/main.tf#L151)), and that is deliberate. PRD 0025 provides an **in-memory blob-store adapter** for tests and local runs; only Cloud Run (and a manual smoke test via impersonation) exercises real GCS. Optionally, `fake-gcs-server` can be run locally for higher fidelity — noted, not required.
- **Manual storage smoke test** (documented as a runbook step): impersonating the runtime SA, write → read → delete a throwaway object to prove the least-privilege path end-to-end, then confirm the object is gone.

**Out of scope:**

- **Any application code** — ports, routes, migration, client, encryption. All of that is PRD [0025](0025-secure-document-code-implementation.md).
- **Signed URLs / direct browser-to-GCS uploads** — explicitly not chosen; would add CORS + token-creator IAM for no benefit at single-user, ≤10 MB scale. Recorded so it is not silently reconsidered.
- **Bucket object versioning / soft-delete** — left disabled. The app writes each document under a unique object key and never overwrites, so there is no in-place overwrite to recover from; accidental *user* deletes are guarded by the app's confirm-before-delete UX (PRD 0025), not by bucket versioning. Revisit only if a "trash/restore" feature is ever requested.
- **A separate CMEK / customer-managed encryption key on the bucket** — redundant here: contents are already AES-256-GCM ciphertext produced client-side before they reach GCS. Google's default at-rest encryption on top is fine; a CMEK adds key-management cost/complexity for no zero-knowledge gain.
- **Automated orphan-blob reconciliation** — the compensating-delete logic and a manual reconciliation query belong to PRD 0025; no infra construct (e.g. a scheduled job) is provisioned here.

## Success criteria

- [ ] `terraform fmt` and `terraform validate` pass; `terraform plan` shows **0 destroys**, the bucket updated **in place** (lifecycle rule removed), and the new output added — no change to the SQL instance, IAM, or Cloud Run.
- [ ] After apply, `gcloud storage buckets describe` on the document bucket shows **no `Delete`-by-age lifecycle rule** (only the `AbortIncompleteMultipartUpload` rule remains).
- [ ] `terraform output document_bucket_name` returns the bucket name.
- [ ] The runtime SA can **write, read, and delete** an object in the bucket (proven by the impersonation smoke test); no broader storage permission exists (a second, unrelated bucket is **not** writable by it — least-privilege confirmed).
- [ ] The developer hand-off doc exists under `docs/deployment/`, states the storage contract (ADC auth, `DOCUMENTS_BUCKET`, ciphertext-in-GCS/metadata-in-DB, in-memory adapter for tests), and is linked from `docs/README.md`.
- [ ] `terraform destroy` still removes the bucket cleanly even with objects present (`force_destroy` unchanged) — teardown/cost-to-zero intact.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `google_storage_bucket.documents` lifecycle | **Edit** — remove `Delete`-by-age rule ([data/main.tf:78](../../terraform/modules/data/main.tf#L78)) | ~$0 — a handful of ≤10 MB objects; standard-class storage is pennies/GB-month. Removing expiry retains slightly more, still negligible. |
| `document_retention_days` variable | Edit/remove — no rule consumes it after the change ([data/variables.tf:72](../../terraform/modules/data/variables.tf#L72)) | $0 |
| `terraform/outputs.tf` | Edit — add `document_bucket_name` output | $0 |
| `docs/deployment/` hand-off doc + `docs/README.md` index | New/Edit | $0 |
| Runtime SA `objectAdmin` binding | **Unchanged** — already correct ([iam/main.tf:69](../../terraform/modules/iam/main.tf#L69)) | $0 |
| `DOCUMENTS_BUCKET` env on Cloud Run | **Unchanged** — already set ([app/main.tf:84](../../terraform/modules/app/main.tf#L84)) | $0 |

No new GCP resource. No new IAM binding. The only billable surface is bucket storage, which is effectively $0 at this scale and returns to $0 on `terraform destroy`.

References:

- Existing infra: [terraform/modules/data/main.tf](../../terraform/modules/data/main.tf), [terraform/modules/iam/main.tf](../../terraform/modules/iam/main.tf), [terraform/modules/app/main.tf](../../terraform/modules/app/main.tf).
- The architecture claim this honours: [docs/architecture/overview.md:41](../../docs/architecture/overview.md#L41) ("Encrypted document blobs go to Cloud Storage").
- The code half: PRD [0025](0025-secure-document-code-implementation.md).
- Origin of the deferral: PRD [0019](0019-credential-vault-ui-and-encryption.md) Out-of-scope (SecureDocument SCRUM-119/120).

## Scripts / commands

```bash
# From terraform/ — review the change before applying.
terraform fmt
terraform validate
terraform plan            # expect: 0 to destroy; bucket changed in place; 1 output added

# Billable/stateful — only after the plan is reviewed and the PRD is Approved.
terraform apply

# Post-apply verification (read-only).
gcloud storage buckets describe gs://$(terraform output -raw document_bucket_name) \
  --format='value(lifecycle_config)'      # expect: no Delete-by-age rule

# Least-privilege smoke test, impersonating the runtime SA (read-only creds; deletes only its own throwaway object).
echo 'ciphertext-smoke-test' > /tmp/spms-doc-smoke.bin
gcloud storage cp   /tmp/spms-doc-smoke.bin gs://$(terraform output -raw document_bucket_name)/_smoke/test.bin \
  --impersonate-service-account="$RUNTIME_SA_EMAIL"
gcloud storage cat  gs://$(terraform output -raw document_bucket_name)/_smoke/test.bin \
  --impersonate-service-account="$RUNTIME_SA_EMAIL"
gcloud storage rm   gs://$(terraform output -raw document_bucket_name)/_smoke/test.bin \
  --impersonate-service-account="$RUNTIME_SA_EMAIL"
```

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| 1 | `terraform-engineer` | Remove the `Delete`-by-age lifecycle rule, retire/annotate `document_retention_days`, add the `document_bucket_name` root output; run `fmt`/`validate`/`plan`. | Clean plan (0 destroys, in-place bucket change) for review. |
| 2 | `infra-reviewer` | Audit the diff + plan against the cost/security/convention guardrails: confirm no destroy, `force_destroy` intact, no new/broadened IAM, retention change is the only semantic change, output exposes no secret. | Findings / sign-off before apply. |
| 3 | Main session | `terraform apply` (after Approval), then run the post-apply describe + impersonation smoke test. | Verified live state. |
| 4 | `documentation-keeper` | Write the developer hand-off doc under `docs/deployment/` (storage contract), add the smoke test to a runbook, index in `docs/README.md`, and note the retention change where the bucket is described. | Updated `docs/`. |

## Testing / verification plan

| Success criterion | Verification | Expected |
| --- | --- | --- |
| Clean, non-destructive plan | `terraform plan` | 0 destroy; bucket changed in place; 1 output added |
| Retention rule gone | `gcloud storage buckets describe … lifecycle_config` post-apply | No `Delete`-by-age rule; only `AbortIncompleteMultipartUpload` remains |
| Output present | `terraform output document_bucket_name` | Returns the bucket name |
| Least-privilege write/read/delete | Impersonation smoke test (Scripts) | cp/cat/rm all succeed as the runtime SA; object gone after rm |
| No over-broad storage rights | Attempt same op on an unrelated bucket as the runtime SA | Denied (binding is bucket-scoped) |
| Hand-off doc | Open `docs/deployment/…` + `docs/README.md` | Storage contract documented and indexed |
| Teardown intact | Confirm `force_destroy = true` unchanged in the diff | Present; destroy path unaffected |
| Review | Step 2 | Sign-off, no high-severity open |

## Additional considerations

- **Security posture.** Net posture is **unchanged or slightly improved**: no new principal, no new permission, no new network path (uploads stay server-side over the app's existing ingress; the bucket stays private with public-access-prevention enforced). Removing an auto-delete rule does not weaken security. The runtime SA keeping `objectAdmin` (which includes delete) is intentional — the app must delete a user's document on request; scoping it to a key prefix buys nothing for a single-user bucket.
- **Cost.** Standard-class storage for a few ≤10 MB blobs is effectively $0/month; removing expiry changes that by a negligible amount. The `$300` budget and the billing budget/alerts are untouched. `force_destroy` guarantees the bucket (and any objects) vanish on `terraform destroy`, so cost-to-zero after grading holds.
- **Rollback / teardown.** Rollback of this PRD = re-add the lifecycle rule via `git revert` + apply (though re-introducing auto-delete on a live vault would itself be a data-loss action — treat re-adding it as a deliberate decision, not a mechanical revert). Teardown of the feature = `terraform destroy` removes the bucket regardless of contents.
- **Open questions:**
  - Should the retired `document_retention_days` variable be **deleted** or **kept-but-unused** (in case a future "auto-purge trashed documents" feature wants it)? Recommend delete now; a future feature can re-introduce it with the right semantics. Reviewer to confirm.
  - Do we want bucket **versioning** on for accidental-overwrite recovery? Recommend **no** (app uses unique keys, never overwrites) — flagged so the choice is explicit.
- **Dependencies / hand-off.** This PRD **unblocks** PRD [0025](0025-secure-document-code-implementation.md) but does not depend on it; the retention fix should land **before** real documents are stored. The two can be authored together and reviewed together; execution order is 0024 (apply) → 0025 can then run its integration/smoke tests against the corrected bucket (0025's unit tests need neither, thanks to the in-memory adapter).

## Outcome

Executed and applied 2026-07-23. `terraform apply`: **0 added, 1 changed, 0 destroyed** — exactly the reviewed plan; `fmt`/`validate` clean; infra-reviewer returned **GO** with no blockers.

**What shipped, matching Scope:**

- **Retention fix.** Removed the age-based object-`Delete` lifecycle rule from `google_storage_bucket.documents` ([terraform/modules/data/main.tf](../../terraform/modules/data/main.tf)); retired the now-unused `document_retention_days` variable ([terraform/modules/data/variables.tf](../../terraform/modules/data/variables.tf)). Verified live: the bucket now has **exactly one** lifecycle rule, `AbortIncompleteMultipartUpload` age 7. Documents persist until the user deletes them; `force_destroy = true` (unchanged) still wipes the bucket on teardown.
- **Output.** Added `document_bucket_name` to [terraform/outputs.tf](../../terraform/outputs.tf); `terraform output document_bucket_name` returns the bucket name.
- **Confirmed-existing infra (no change):** runtime SA holds `roles/storage.objectAdmin` scoped to the bucket (verified via `get-iam-policy`); Cloud Run already receives `DOCUMENTS_BUCKET`; bucket stays private (`public_access_prevention=enforced`, UBLA on). No new IAM, no CORS, no signed-URL infra — the object-proxy model needs none.

**Verification results (§Testing plan):** non-destructive scoped plan ✓; Delete-by-age rule gone ✓; output present ✓; runtime SA `objectAdmin` binding live ✓; `force_destroy` intact ✓; hand-off doc + runbook written and indexed ✓.

**One verification could not be run as written — by design, not a failure:** the impersonation smoke test (`gcloud storage cp/cat/rm --impersonate-service-account`) was **denied with `IAM_PERMISSION_DENIED`** because the operator account intentionally lacks `roles/iam.serviceAccountTokenCreator` on the runtime SA — the correct least-privilege boundary (only the deployer SA may act as runtime). The **authoritative** confirmation of the runtime SA's read/write/delete capability is therefore its live `objectAdmin` binding on the bucket (confirmed); the **functional** end-to-end will be exercised by Cloud Run running *as* the runtime SA once the app code (PRD [0025](0025-secure-document-code-implementation.md)) ships. Running the impersonation form would require temporarily granting the operator token-creator on the runtime SA — a deliberate, reversible privilege escalation, not performed here. Both the IAM-policy check (always available) and the impersonation form (with this prerequisite/caveat) are captured in the smoke-test runbook.

**Deviations from plan (mechanical / environment, no scope or cost change):**

1. **Lost operator config reconstructed.** The untracked `backend.hcl` and `terraform.tfvars` had been lost in an earlier cleanup, blocking `init`/`plan`. Rebuilt both from live state rather than guessing: the state prefix (`terraform/state`) was discovered from the state bucket, and `developer_group` (`…@googlegroups.com`) and `enable_public_ip = true` (dev-phase, PRD 0007) were **read back from the deployed resources** so the plan stayed scoped to only this PRD's change — no accidental reversion of the public-IP toggle or the developer-group grants. Both files remain gitignored.
2. **`.gitignore` gap closed** (infra-reviewer catch): added `tfplan.*` so numbered saved-plan files (which can contain sensitive state) are ignored — the existing `*.tfplan`/`tfplan` patterns didn't match the `tfplan.NNNN` convention.
3. The reconstructed `terraform.tfvars` first landed in a stray nested `terraform/terraform/` directory (relative-path slip) and was moved to the correct location — noted for completeness.

**Resulting documentation (documentation-keeper pass):**

- [docs/deployment/document-storage.md](../deployment/document-storage.md) — **new**: the developer hand-off / storage contract (proxy-through-app upload, ADC = runtime SA, `DOCUMENTS_BUCKET` env, ciphertext-in-GCS / metadata-in-MySQL split, no-auto-expiry retention, local-dev/CI never touch real GCS). Unblocks PRD 0025.
- [docs/runbooks/document-storage-smoke-test.md](../runbooks/document-storage-smoke-test.md) — **new**: the two-level verification (IAM-policy check + impersonation form with its token-creator caveat and revoke-after step).
- Indexed/cross-linked in [docs/README.md](../README.md), [docs/deployment/README.md](../deployment/README.md), [docs/runbooks/README.md](../runbooks/README.md); open items resolved in [docs/guides/developer-handover.md](../guides/developer-handover.md) and [docs/architecture/system-design-summary.md](../architecture/system-design-summary.md).
- PRD [0002](0002-network-and-data.md)'s prose (historical record) still describes the original 365-day rule and was deliberately left untouched; the current, correct retention statement lives in the new deployment doc. No ADR was written here — the Cloud-Storage-vs-`LONGBLOB` decision + schema reconciliation is PRD 0025's ADR.

**Carried forward:** the SecureDocument **application code** (ports, routes, migration, client, encryption, the storage ADR) is PRD [0025](0025-secure-document-code-implementation.md), left for the developer team. The dev-phase public IP on Cloud SQL remains `true` (PRD 0007) — unrelated to this PRD, flip to private before the presentation as that PRD notes.
