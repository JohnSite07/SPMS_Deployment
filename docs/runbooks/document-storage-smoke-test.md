# Document storage smoke test

Verify that the runtime service account can actually write, read, and delete objects in the document bucket — the least-privilege path the SecureDocument feature depends on. Two levels of verification: an **IAM-policy check** (always available, no special access needed) and an **impersonation smoke test** (functional, but requires a temporary, reversible privilege grant). Storage contract this verifies: [deployment/document-storage.md](../deployment/document-storage.md).

Everywhere below, `<bucket>` is `$(terraform -chdir=terraform output -raw document_bucket_name)` and `$RUNTIME_SA_EMAIL` is the runtime service account's email (from `terraform -chdir=terraform output` in the `iam` module, or ask DevOps — not printed here per the no-secrets/no-SA-email-literal convention).

## When to use

- After any change to the document bucket or its IAM binding (e.g. a future PRD touching `terraform/modules/data/` or `terraform/modules/iam/`).
- Before the Developer team starts building against the storage contract (PRD 0025), as a one-time confirmation the infra side is live.
- As a periodic sanity check if document upload/download starts failing in production and infra is suspected.

## Level 1 — IAM policy check (always available)

This is the **authoritative** confirmation that the runtime SA can read/write/delete: its IAM binding on the bucket. No special access is needed beyond standard operator/DevOps `gcloud` access.

```bash
gcloud storage buckets get-iam-policy gs://<bucket>
```

Expect a binding with:
- `role: roles/storage.objectAdmin`
- `members: ["serviceAccount:<runtime SA email>"]`

Cross-check against the Terraform source of truth: [terraform/modules/iam/main.tf](../../terraform/modules/iam/main.tf) (`google_storage_bucket_iam_member.runtime_bucket_object_admin`). If the policy matches what's declared in code, the runtime SA's access is correct — this check alone is sufficient for most verification purposes.

## Level 2 — Impersonation smoke test (functional, requires a temporary grant)

This exercises the actual write → read → delete path as the runtime SA, from the operator's own machine.

### Prerequisite — and the caveat we hit live

**The human operator account (and developer accounts) intentionally lack `roles/iam.serviceAccountTokenCreator` on the runtime SA** — this is the correct least-privilege posture, not a bug (see [terraform/modules/iam/main.tf](../../terraform/modules/iam/main.tf) — no such binding exists for developer or human-operator principals). Running the commands below **without** that role will fail with `IAM_PERMISSION_DENIED`. That failure is expected and does not indicate a broken environment.

To run this smoke test, an operator must **temporarily** grant themselves token-creator on the runtime SA:

```bash
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA_EMAIL" \
  --member="user:<your-email>" \
  --role="roles/iam.serviceAccountTokenCreator"
```

This is a **deliberate, reversible choice — not required for normal verification** (Level 1 above covers most needs) and is itself a privilege escalation to weigh before doing it. Only grant it when you specifically need to exercise the functional path, and remove it again immediately after (see step 4 below).

### Steps

1. Write, read, and delete a throwaway object, impersonating the runtime SA:
   ```bash
   echo 'ciphertext-smoke-test' > /tmp/spms-doc-smoke.bin

   gcloud storage cp /tmp/spms-doc-smoke.bin gs://<bucket>/_smoke/test.bin \
     --impersonate-service-account="$RUNTIME_SA_EMAIL"

   gcloud storage cat gs://<bucket>/_smoke/test.bin \
     --impersonate-service-account="$RUNTIME_SA_EMAIL"

   gcloud storage rm gs://<bucket>/_smoke/test.bin \
     --impersonate-service-account="$RUNTIME_SA_EMAIL"
   ```
   Expect all three to succeed; `cat` echoes back `ciphertext-smoke-test`.

2. Confirm least privilege — the same identity must **not** be able to write to an unrelated bucket:
   ```bash
   gcloud storage cp /tmp/spms-doc-smoke.bin gs://<some-other-bucket>/test.bin \
     --impersonate-service-account="$RUNTIME_SA_EMAIL"
   ```
   Expect this to be **denied**. If it succeeds, the runtime SA has broader-than-intended storage access — stop and investigate.

3. Clean up the local temp file:
   ```bash
   rm /tmp/spms-doc-smoke.bin
   ```

4. **Revoke the temporary grant** from the prerequisite step — do not leave it in place:
   ```bash
   gcloud iam service-accounts remove-iam-policy-binding "$RUNTIME_SA_EMAIL" \
     --member="user:<your-email>" \
     --role="roles/iam.serviceAccountTokenCreator"
   ```

## What this does and doesn't prove

- **Proves**: the runtime SA's bucket-scoped `objectAdmin` grant genuinely permits create/read/delete, and doesn't extend to other buckets.
- **Doesn't prove**: the application code path (upload endpoint, encryption, DB metadata write) works — that's an integration/end-to-end concern for [PRD 0025](../action_plan/0025-secure-document-code-implementation.md), exercised by Cloud Run running **as** the runtime SA once the app code ships, not by this runbook.

## Related

- [deployment/document-storage.md](../deployment/document-storage.md) — the storage contract this verifies.
- [PRD 0024](../action_plan/0024-secure-document-storage-infra-and-handoff.md) — where this smoke test was first run.
- [terraform/modules/iam/main.tf](../../terraform/modules/iam/main.tf) — the IAM bindings this checks against.
- [runbooks/secret-rotation.md](secret-rotation.md) — a similarly-shaped "verify the live behaviour, not just the declared config" runbook.
