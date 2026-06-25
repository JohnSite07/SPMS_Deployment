# 0001 — Cloud platform, compute, IaC, and CI/CD

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Secure Vault Group (Deployment & DevOps lead: Jean Luc Sita Mbuya)

## Context

SecureVault must be deployed live for an academic milestone under two hard constraints: stay within the **$300 GCP free-trial credit** over a ~2-month window, and preserve a **zero-knowledge, least-privilege** security posture. The team needs a reproducible, fully disposable environment that can be stood up and torn down on demand, with minimal operational overhead. This ADR records the foundational platform and tooling decisions captured in the Milestone 4 design.

## Decision

- **Cloud platform:** Google Cloud Platform.
- **Compute:** Cloud Run (serverless containers, scale-to-zero).
- **Database:** Cloud SQL for MySQL (shared-core `db-f1-micro`, private IP).
- **Infrastructure as Code:** Terraform, modular, with versioned/locked GCS remote state.
- **CI/CD:** GitHub Actions, split CI (PR) and CD (push to `main`) workflows.
- **Pipeline auth:** Workload Identity Federation (keyless OIDC) — no stored service-account keys.

## Alternatives considered

- **AWS / Azure** — no free credit available to the team; GCP's credit and first-class Terraform support won.
- **GKE or a plain VM for compute** — GKE is overkill and carries always-on cost; a VM means manual ops and no scale-to-zero. Cloud Run runs the container directly and costs nothing while idle.
- **Self-managed MySQL on a VM** — adds patching/backup burden with no benefit at this scale vs. managed Cloud SQL.
- **Hand-run `gcloud` scripts** — not reproducible; rejected in favour of declarative Terraform.
- **Cloud Build** — would split tooling off GitHub; Actions keeps code and pipeline together with native OIDC.
- **Long-lived SA JSON keys in repo secrets** — the highest-risk CI/CD credential; replaced by short-lived WIF tokens.

## Consequences

- The environment is reproducible and disposable: one `terraform destroy` returns spend to zero after grading.
- Cloud SQL is the dominant cost line (~$9–10/mo) and has no SLA on the shared-core tier — acceptable for a demo, would be upgraded for production. It can be stopped between sessions to reduce spend.
- Cloud Run cold starts add brief first-request latency after idle; mitigated by temporarily setting `min-instances=1` during a live demo.
- Keyless auth removes the leaked-key risk but requires correct WIF pool/provider and service-account trust configuration (documented under `docs/deployment/`).
