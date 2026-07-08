# 0001 — Terraform Foundation & GCP Bootstrap

Stand up the Terraform skeleton, remote state backend, required GCP APIs, and the billing budget — the base every later provisioning PRD builds on.

| | |
| --- | --- |
| **Status** | Done (2026-07-08) |
| **Date** | 2026-07-08 |
| **Author** | DevOps (main session) |

## User story

As the DevOps team, I want the Terraform project scaffold, a locked/versioned remote state backend, the required GCP APIs, and the $300 budget alert in place, so that every subsequent resource is provisioned reproducibly through code with cost guardrails active from day one.

## Scope

**In scope:**
- Create the GCP project prerequisites: set the active project, link billing, enable required APIs (`run`, `sqladmin`, `storage`, `secretmanager`, `artifactregistry`, `compute`, `iam`, `iamcredentials`, `sts`, `billingbudgets`, `cloudresourcemanager`, `serviceusage`, `servicenetworking` — the last needed by PRD 0002's private-IP Cloud SQL).
- One-time bootstrap of the **Terraform state bucket** via `gcloud` (versioned, uniform access) — the only resource not managed by Terraform, since the backend must exist before Terraform can run.
- Scaffold `terraform/` per the target layout: root (`main.tf`, `variables.tf`, `outputs.tf`, `backend.tf`, `versions.tf`) + empty single-purpose modules (`network/`, `iam/`, `data/`, `app/`, `secrets/`).
- Root variables: `project_id`, `region` (default `us-central1`), `billing_account_id` — values supplied via untracked `terraform.tfvars` (gitignored), never committed.
- First managed resource: `google_billing_budget` with 50/90/100% alerts on $300.
- `terraform init` against the GCS backend, `plan`, and — after user approval of the plan — `apply`.

**Out of scope (later PRDs):**
- Network module content (VPC, Direct VPC egress) and Cloud SQL — PRD 0002.
- Service accounts, WIF pool/provider, IAM bindings — PRD 0003.
- Artifact Registry, Cloud Run service, document bucket, Secret Manager secrets.
- GitHub Actions workflows (`ci.yml` / `cd.yml`) and repo variables.
- Any application code.

## Success criteria

- [ ] `terraform fmt -check -recursive` and `terraform validate` pass.
- [ ] `terraform init` succeeds against the GCS backend; state object exists in the versioned state bucket.
- [ ] `terraform plan` is clean (no errors, **0 destroys**); `apply` creates the billing budget only.
- [ ] All required APIs report enabled.
- [ ] Budget with 50/90/100% thresholds visible on the billing account.
- [ ] `infra-reviewer` verdict: safe to commit/apply, no blockers.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| State bucket (bootstrap, `gcloud`) | Cloud Storage, versioned | ~$0.02/mo (KB-scale state) |
| `google_billing_budget` | Billing budget + alerts | $0 |
| Enabled APIs | Service enablement | $0 (enabling is free) |
| `terraform/` scaffold (root + 5 modules) | Repo files | $0 |

References: CLAUDE.md target layout · [architecture/overview.md](../architecture/overview.md) · Terraform Google provider registry docs · `docs/milestones/SecureVault_Milestone4_Deployment.docx`

## Scripts / commands

```bash
# 1. Project context (user-supplied values; nothing committed)
gcloud config set project <PROJECT_ID>

# 2. Enable APIs (free)
gcloud services enable run.googleapis.com sqladmin.googleapis.com \
  storage.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com compute.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com servicenetworking.googleapis.com \
  billingbudgets.googleapis.com cloudresourcemanager.googleapis.com

# 3. Bootstrap state bucket (one-time, billable: ~cents)
gcloud storage buckets create gs://<PROJECT_ID>-tfstate \
  --location=us-central1 --uniform-bucket-level-access
gcloud storage buckets update gs://<PROJECT_ID>-tfstate --versioning

# 4. Terraform (billable step is apply — gated on plan approval)
terraform -chdir=terraform init
terraform -chdir=terraform fmt -check -recursive && terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=tfplan
terraform -chdir=terraform apply tfplan   # only after user approves the plan
```

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| Scaffold + budget resource | `terraform-engineer` | Write root config, versions/backend, module skeletons, `google_billing_budget`; run fmt/validate | Code ready for review |
| Pre-apply review | `infra-reviewer` | Audit scaffold + plan output against cost/security/convention guardrails | Verdict + findings |
| gcloud bootstrap, init/plan/apply | main session | Run the commands above (apply only after approval) | Live foundation |
| Docs | `documentation-keeper` | ADR for the state-bootstrap approach; start `docs/deployment/` GCP setup notes | Updated docs |

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| fmt/validate pass | run both commands | exit 0 |
| Backend live | `gcloud storage ls gs://<PROJECT_ID>-tfstate` after init | `default.tfstate` object present |
| Bucket versioned | `gcloud storage buckets describe gs://<PROJECT_ID>-tfstate` | `versioning: enabled` |
| Plan clean | read plan summary | `0 to destroy`; only budget added |
| APIs enabled | `gcloud services list --enabled` | all listed APIs present |
| Budget exists | `gcloud billing budgets list --billing-account=<ID>` | budget with 3 thresholds |
| Review pass | spawn `infra-reviewer` on the diff | no blockers |

## Additional considerations

- **Security posture:** local applies run under the user's own gcloud credentials (ADC) — no SA keys created at any point. From PRD 0004 (pipeline) onward, applies move to CD via WIF.
- **Rollback / teardown:** `terraform destroy` removes the budget (and everything later PRDs add). The bootstrap state bucket is deliberately outside Terraform; the teardown runbook must note deleting it manually last (`gcloud storage rm -r`). Cost if forgotten: ~$0.02/mo.
- **Open questions (user input needed before execution):**
  1. GCP project: does a free-trial project already exist, or create one? What project ID?
  2. Billing account ID (for the budget resource; supplied as a tfvars value, not committed).
  3. Confirm region `us-central1` (per design).
- **Dependencies:** gcloud is authenticated locally (verified 2026-07-08); no active project set yet. Terraform v1.15.5 and gh CLI available.

## Outcome

Executed 2026-07-08. All success criteria met: scaffold validated, state in the versioned GCS backend, plan/apply clean (1 add — the budget), APIs enabled, budget live with 50/90/100% thresholds, infra-reviewer pass. Deviations from plan:

1. **New dedicated project created** (no SPMS project existed). ID recorded in untracked `terraform/terraform.tfvars` and `backend.hcl` — not in the repo, per docs rule.
2. **Budget `projects` filter needed the project *number*, not ID** — caught by infra-reviewer pre-apply (plan alone would not have caught it); fixed with a `google_project` data source.
3. **Provider needed `user_project_override` + `billing_project`** — the Billing Budgets API rejects plain user ADC without a quota project.
4. **Billing account currency is CAD, not USD** — `currency_code` removed from the budget (defaults to account currency). Budget is **300 CAD**, which alerts *earlier* than 300 USD; acceptable-conservative.
5. **State bucket hardened** with `public_access_prevention=enforced` (reviewer defense-in-depth note; added to the bootstrap steps above in spirit).
6. **Backend uses partial config** (`backend.tf` empty; untracked `backend.hcl` supplies bucket) to keep project-derived names out of the public repo — CI/CD will pass the same values from Actions variables (PRD 0005).

Docs follow-ups delegated to documentation-keeper: ADR (state bootstrap + partial backend), `docs/deployment/` GCP setup notes.
