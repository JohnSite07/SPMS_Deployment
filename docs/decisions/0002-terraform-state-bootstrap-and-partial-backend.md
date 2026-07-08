# 0002 — Terraform state bootstrap and partial backend configuration

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** Secure Vault Group (Deployment & DevOps lead: Jean Luc Sita Mbuya)

## Context

Terraform needs a remote backend to exist before it can run `terraform init` — a chicken-and-egg problem, since Terraform normally provisions the resources it later manages. The state bucket also stores the plaintext plan/state representation of every resource Terraform touches, including project-derived identifiers, so how its name is supplied to config matters for a public repository. This decision was made and executed as part of [PRD 0001](../action_plan/0001-terraform-foundation.md).

## Decision

**(a) The state bucket is bootstrapped once, outside Terraform, via `gcloud`.** It is the single resource in the whole estate not managed by Terraform, because the GCS backend it provides must exist before any `terraform init` can target it. It is created with:
- **Versioning enabled** — allows recovering a prior state version after a bad write.
- **Uniform bucket-level access** — IAM-only access control, no legacy ACLs.
- **Public access prevention enforced** — defense-in-depth; state must never be reachable outside the project regardless of future IAM mistakes.

Because it sits outside Terraform's lifecycle, it is also the last thing deleted at teardown — see [runbooks/teardown.md](../runbooks/teardown.md) and the note in [PRD 0001's Additional considerations](../action_plan/0001-terraform-foundation.md#additional-considerations).

**(b) `backend.tf` declares an empty, partial `backend "gcs" {}` block** (see [terraform/backend.tf](../../terraform/backend.tf)). The real bucket name and prefix are never written into a tracked file. They are supplied at init time via an untracked `backend.hcl` (gitignored, see [.gitignore](../../.gitignore)):

```
terraform -chdir=terraform init -backend-config=backend.hcl
```

From CI/CD (PRD 0005 onward), the pipeline will supply the same two values via `-backend-config="bucket=..."` / `-backend-config="prefix=..."` flags sourced from GitHub Actions *variables*, not by checking in a `backend.hcl` equivalent.

## Alternatives considered

- **Committed backend config** (bucket/prefix hardcoded in `backend.tf`) — simplest, but the bucket name is project-derived (`<PROJECT_ID>-tfstate`) and would leak that identifier into a public repository. Rejected — conflicts with the project's "no real project IDs in the repo" guardrail.
- **Local state** — no bootstrap problem, but no locking (concurrent `apply` runs, whether local or from CI, could corrupt state) and the state file would be laptop-bound, undermining reproducibility and the CI/CD design. Rejected by design (see [ADR 0001](0001-platform-and-tooling.md)).

## Consequences

- Every `terraform init` (local or CI) must pass `-backend-config`; this is one extra required step documented in [docs/deployment/gcp-setup.md](../deployment/gcp-setup.md) and must be replicated correctly in the CD workflow (PRD 0005) or `init` will fail outright (safe failure — no partial/wrong backend, just an error).
- The state bucket is a manual bootstrap step and a manual teardown step — it will not disappear on `terraform destroy` and must be remembered and removed by an operator to fully zero out spend (cost if forgotten is negligible, ~$0.02/mo).
- No project-derived identifiers appear in tracked Terraform files; `backend.hcl` and `terraform.tfvars` carry all real values and are gitignored.
