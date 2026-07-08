# GCP one-time bootstrap

One-time procedure to prepare a GCP project for the SecureVault (SPMS) Terraform estate: project/billing setup, Application Default Credentials, required API enablement, and the Terraform remote-state bucket. Executed once per project as part of [PRD 0001](../action_plan/0001-terraform-foundation.md); see that PRD's Outcome section for the actual run log. Related decision: [ADR 0002 — Terraform state bootstrap and partial backend configuration](../decisions/0002-terraform-state-bootstrap-and-partial-backend.md).

Everywhere below, `<PROJECT_ID>` and `<BILLING_ACCOUNT_ID>` are placeholders. Real values are never committed — they live only in the untracked `terraform/terraform.tfvars` and `terraform/backend.hcl` (both gitignored, see [.gitignore](../../.gitignore)).

## 1. Project and billing

Create (or select) the GCP project and link it to the billing account that provides the $300 free-trial credit:

```bash
gcloud projects create <PROJECT_ID>          # skip if the project already exists
gcloud config set project <PROJECT_ID>
gcloud billing projects link <PROJECT_ID> --billing-account=<BILLING_ACCOUNT_ID>
```

## 2. Application Default Credentials quota project

Local `terraform apply` runs authenticate as the operator via Application Default Credentials (ADC) — no service-account key is created for this. Some APIs (notably Billing Budgets, see the gotcha below) reject ADC calls that don't carry a quota project, so set one explicitly:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project <PROJECT_ID>
```

## 3. Enable required APIs

Twelve APIs cover everything through PRD 0002 (private-IP Cloud SQL needs `servicenetworking`):

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  compute.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  servicenetworking.googleapis.com \
  billingbudgets.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project=<PROJECT_ID>
```

Verify: `gcloud services list --enabled --project=<PROJECT_ID>`.

## 4. Bootstrap the Terraform state bucket

The state bucket must exist before Terraform can run, so it is the one resource created by hand instead of by Terraform (see [ADR 0002](../decisions/0002-terraform-state-bootstrap-and-partial-backend.md) for why). It is versioned (state recovery), uniform-access (IAM-only), and hardened with enforced public-access prevention:

```bash
gcloud storage buckets create gs://<PROJECT_ID>-tfstate \
  --project=<PROJECT_ID> \
  --location=us-central1 \
  --uniform-bucket-level-access \
  --public-access-prevention

gcloud storage buckets update gs://<PROJECT_ID>-tfstate --versioning
```

This bucket is outside Terraform's lifecycle: `terraform destroy` will never remove it. It must be deleted manually, last, at full teardown — see `docs/runbooks/` (teardown runbook) once written.

## 5. terraform.tfvars and backend.hcl (untracked)

Create both files under `terraform/` — neither is committed (gitignored):

`terraform/terraform.tfvars`:
```hcl
project_id         = "<PROJECT_ID>"
billing_account_id = "<BILLING_ACCOUNT_ID>"
# region defaults to us-central1 — see terraform/variables.tf
```

`terraform/backend.hcl`:
```hcl
bucket = "<PROJECT_ID>-tfstate"
prefix = "state"
```

## 6. terraform init

`backend.tf` declares an empty partial `backend "gcs" {}` block (see [terraform/backend.tf](../../terraform/backend.tf)) — the bucket name is supplied at init time so no project-derived identifier is ever committed:

```bash
terraform -chdir=terraform init -backend-config=backend.hcl
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=tfplan
terraform -chdir=terraform apply tfplan
```

The CD pipeline (PRD 0005 onward) will run the equivalent `init` with `-backend-config` flags populated from GitHub Actions variables rather than a checked-in `backend.hcl`.

## Provider gotchas hit during execution

Recorded here so they are not re-debugged. See [terraform/main.tf](../../terraform/main.tf) for the resulting code.

1. **Billing Budgets API needs a quota project on both sides.** Plain user ADC is rejected. The provider block requires `user_project_override = true` plus `billing_project = var.project_id`, *and* ADC itself needs a quota project set (step 2 above) — one without the other still fails.
2. **`budget_filter.projects` takes the project *number*, not the project ID.** It expects `"projects/<NUMBER>"`. Look the number up via a `data "google_project"` source keyed on `project_id` rather than hardcoding it (a number can't be derived from the ID string).
3. **The budget amount is denominated in the billing account's own currency**, not USD. Do not set `currency_code` unless it matches the account's currency exactly — omitting it defaults to the account's currency and avoids a mismatch error. A "$300" budget on a non-USD account will alert at a different real-money threshold than 300 USD; note this when reading budget alerts.

## Verification

| Check | Command | Expected |
| --- | --- | --- |
| APIs enabled | `gcloud services list --enabled --project=<PROJECT_ID>` | all 12 APIs listed |
| State bucket exists, versioned | `gcloud storage buckets describe gs://<PROJECT_ID>-tfstate` | `versioning: enabled`, `publicAccessPrevention: enforced` |
| Backend initialized | `gcloud storage ls gs://<PROJECT_ID>-tfstate` | state object present after `terraform init`/`apply` |
| Budget live | `gcloud billing budgets list --billing-account=<BILLING_ACCOUNT_ID>` | budget with 3 thresholds (50/90/100%) |

## Related

- [ADR 0002 — Terraform state bootstrap and partial backend configuration](../decisions/0002-terraform-state-bootstrap-and-partial-backend.md)
- [PRD 0001 — Terraform Foundation & GCP Bootstrap](../action_plan/0001-terraform-foundation.md)
- [terraform/main.tf](../../terraform/main.tf) · [terraform/backend.tf](../../terraform/backend.tf) · [terraform/variables.tf](../../terraform/variables.tf)
