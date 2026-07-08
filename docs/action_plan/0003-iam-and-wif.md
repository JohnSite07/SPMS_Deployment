# 0003 — Identity: Service Accounts & Workload Identity Federation

Create the two least-privilege service accounts (runtime vs. deployer) and the keyless WIF trust between GitHub Actions and GCP.

| | |
| --- | --- |
| **Status** | Done (2026-07-08) |
| **Date** | 2026-07-08 |
| **Author** | DevOps (main session) |

## User story

As the DevOps team, I want separate, least-privilege identities for the pipeline and the runtime, with the pipeline authenticating via short-lived OIDC tokens instead of stored keys, so that a compromise of either identity or of the GitHub repo cannot cascade.

## Scope

**In scope (`modules/iam/`):**
- **Runtime SA** (`spms-runtime@…`): `roles/cloudsql.client`; `roles/secretmanager.secretAccessor` granted **per-secret** (not project-wide); `roles/storage.objectAdmin` **on the document bucket only**; `roles/logging.logWriter`, `roles/monitoring.metricWriter`.
- **Deployer SA** (`spms-deployer@…`): scoped roles to build, apply, and deploy — `roles/run.admin`, `roles/artifactregistry.writer`, `roles/cloudsql.admin`, `roles/compute.networkAdmin`, `roles/secretmanager.admin`, `roles/storage.admin`, `roles/serviceusage.serviceUsageAdmin`, `roles/iam.serviceAccountAdmin` + `roles/resourcemanager.projectIamAdmin` (it runs `terraform apply` for the whole estate), and `roles/iam.serviceAccountUser` **on the runtime SA only** (to deploy Cloud Run revisions as it).
- **WIF**: `google_iam_workload_identity_pool` + GitHub OIDC provider with an **attribute condition pinned to this repository** (`assertion.repository == "<OWNER>/SPMS_Deployment"`); `roles/iam.workloadIdentityUser` binding letting only that repo's workflows impersonate the deployer SA.
- Terraform outputs for the three GitHub variables: project ID, WIF provider resource name, deployer SA email.

**Out of scope:**
- The GitHub side (setting Actions variables, workflows) — PRD 0005.
- Developer-team human IAM grants — PRD 0006.
- Any SA keys — never created, by design.

## Success criteria

- [ ] Plan/apply clean, 0 destroys; both SAs exist; **zero** `google_service_account_key` resources in the codebase.
- [ ] Runtime SA has no project-wide `roles/editor|owner`; secret access is per-secret; bucket access is bucket-scoped.
- [ ] WIF provider condition rejects tokens from any other repository.
- [ ] Impersonation smoke test: a token exchange from a test workflow (or `gcloud iam workload-identity-pools ... describe`) resolves; deployer SA usable only via WIF or an org admin.
- [ ] `infra-reviewer`: no blockers (over-broad roles are its explicit lens).

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| 2 × SA | `google_service_account` | $0 |
| Role bindings | `google_project_iam_member` (scoped), per-secret/per-bucket IAM members | $0 |
| WIF pool + provider | `google_iam_workload_identity_pool(_provider)` | $0 |

References: CLAUDE.md (keyless auth section) · google-github-actions/auth docs · [deployment/README.md](../deployment/README.md).

## Scripts / commands

```bash
terraform -chdir=terraform fmt -check -recursive && terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=tfplan
terraform -chdir=terraform apply tfplan    # $0 cost; after approval

# verification
gcloud iam service-accounts list --filter="email~spms-"
gcloud iam workload-identity-pools providers describe github --location=global --workload-identity-pool=spms-pool
terraform -chdir=terraform output   # the 3 GitHub-variable values (non-sensitive)
```

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| Write iam module | `terraform-engineer` | SAs, scoped bindings, WIF pool/provider + condition, outputs | Code + plan |
| Pre-apply review | `infra-reviewer` | Focus: role breadth, missing repo condition, any key resource | Verdict |
| Apply + verify | main session | Apply after approval; verification commands | Live identities |
| Docs | `documentation-keeper` | ADR: keyless WIF + two-SA split; document the deployer role list and why each role is needed | ADR + deployment doc |

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| No keys anywhere | grep codebase for `service_account_key`; console check | zero results / zero keys |
| Scoped runtime SA | `gcloud projects get-iam-policy` filtered on runtime SA | only the listed roles |
| Repo-pinned WIF | provider describe → attribute condition | matches this repo exactly |
| Outputs correct | `terraform output` | 3 values, non-sensitive |
| Review pass | `infra-reviewer` | no blockers |

## Additional considerations

- **Security posture:** the deployer's role list is the widest in the project because it must apply all Terraform. That is the accepted trade-off of pipeline-applied IaC; it is mitigated by the repo-pinned WIF condition and (in PRD 0005) branch protection on `main`. Document this reasoning in the ADR.
- **Rollback / teardown:** all IAM resources destroy cleanly; WIF pools are soft-deleted (30-day purge) — re-creation with the same ID within that window needs `gcloud ... undelete`; note in teardown runbook.
- **Open questions:** confirm the GitHub org/owner string for the WIF condition (`JohnSite07/SPMS_Deployment` per current remote).
- **Dependencies:** PRD 0001 Done. Independent of 0002 (can run in parallel if desired, but sequential keeps review load small).

## Outcome

Executed 2026-07-08. 21 resources applied cleanly (0 changes/destroys to the existing estate); infra-reviewer verdict pre-apply: safe, zero blockers — it verified the full role inventory against this PRD line-by-line, confirmed the WIF `attribute_condition` uses strict string equality on the repository, the `workloadIdentityUser` binding is a repository-scoped `principalSet` (not pool-wide), and zero `google_service_account_key` resources exist. Post-apply checks: both SAs live; provider condition reads exactly as designed; only Google `SYSTEM_MANAGED` keys on the deployer (no user-managed keys). The three root outputs for PRD 0005's GitHub variables are live (`gcp_project_id`, `wif_provider`, `deployer_sa_email`). No deviations from plan. ADR: [0003 — two service accounts and keyless WIF](../decisions/0003-two-service-accounts-and-keyless-wif.md); WIF soft-delete note added to the teardown runbook.
