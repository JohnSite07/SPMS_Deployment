# Teardown

Full environment teardown, run once after grading is complete. Order matters — follow the steps in sequence, don't skip ahead.

Related: [ADR 0002 — Terraform state bootstrap and partial backend configuration](../decisions/0002-terraform-state-bootstrap-and-partial-backend.md) · [ADR 0003 — Two service accounts and keyless Workload Identity Federation](../decisions/0003-two-service-accounts-and-keyless-wif.md) · [GCP one-time bootstrap](../deployment/gcp-setup.md) · [Cost check](cost-check.md) · [Stop/start Cloud SQL](stop-start-cloud-sql.md)

Everywhere below, `<PROJECT_ID>` and `<STATE_BUCKET>` are placeholders — real values live only in untracked `terraform/terraform.tfvars` / `terraform/backend.hcl` (see [gcp-setup.md](../deployment/gcp-setup.md)). `<STATE_BUCKET>` is `<PROJECT_ID>-tfstate`.

## 1. Terraform destroy

Everything provisioned through Terraform (VPC, Private Services Access, Cloud SQL, document bucket, secrets, and anything later PRDs add — Cloud Run, Artifact Registry, IAM/WIF) is destroyed in one pass:

```bash
terraform -chdir=terraform destroy
```

Review the destroy plan before confirming — it should list every resource in the estate and nothing outside it (the state bucket is never in this list; see step 2).

**Known failure mode — Private Services Access peering:** the `google_service_networking_connection` (PSA) resource can fail to release while Cloud SQL still holds the peering connection open, even though Terraform's dependency graph destroys the SQL instance before the network module. If `destroy` errors out on the PSA connection:

```bash
terraform -chdir=terraform destroy   # re-run; the SQL instance is already gone, so the peering releases cleanly this time
```

Re-running destroy is expected here, not a sign of a broken environment — do not attempt to delete the peering connection by hand.

**Known follow-up — WIF pool soft-delete:** `terraform destroy` deletes the Workload Identity Pool (`terraform/modules/iam/`, see [ADR 0003](../decisions/0003-two-service-accounts-and-keyless-wif.md)), but GCP soft-deletes WIF pools for ~30 days rather than removing them immediately. Re-applying within that window with the same `wif_pool_id` will fail because the ID is still reserved by the soft-deleted pool. If that happens, restore it first, then re-apply (which will pick the pool back up as an existing resource):

```bash
gcloud iam workload-identity-pools undelete <POOL_ID> --location=global --project=<PROJECT_ID>
```

## 2. Delete the bootstrap state bucket (last, manual)

The Terraform state bucket is the one resource outside Terraform's lifecycle (per [ADR 0002](../decisions/0002-terraform-state-bootstrap-and-partial-backend.md)) — it must exist before `terraform init` can run, so `terraform destroy` never touches it. Delete it by hand, and only **after** destroy has succeeded:

```bash
gcloud storage rm -r gs://<STATE_BUCKET> --project=<PROJECT_ID>
```

Do this last. Deleting it before or during step 1 would strand Terraform's state mid-destroy, leaving no record of what was (or wasn't) removed.

## 3. Verify $0

```bash
# Billing account status for the project
gcloud billing projects describe <PROJECT_ID>

# Budget page: confirm no further alerts fire — visually check Billing > Budgets & alerts in the console
# (the budget resource itself was destroyed in step 1, so this is a last look, not an ongoing check)

# Nothing billable left standing anywhere in the project
gcloud asset search-all-resources --scope=projects/<PROJECT_ID>
```

Expect the asset search to return empty (or only non-billable metadata resources). If it lists anything unexpected, investigate before considering teardown complete — see [cost-check.md](cost-check.md) for the same command used as a spend-spike check.

## 4. Optional: delete the whole project

The nuclear guarantee — removes the project itself, including anything created outside Terraform (e.g. IAM grants made by hand, API enablement) that steps 1–3 wouldn't otherwise catch:

```bash
gcloud projects delete <PROJECT_ID>
```

This is irreversible after GCP's project-deletion grace period expires. Only do this once grading is fully done and no further work is planned against this project.
