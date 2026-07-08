# Deployment

The CI/CD pipeline, environment setup, and release process: GitHub Actions workflows, Workload Identity Federation configuration, branch gating, the no-traffic → smoke-test → shift-traffic deploy strategy, and rollback.

Document setup steps and process flow. Reference GitHub Actions *variable names* (e.g. `GCP_PROJECT_ID`, `WIF_PROVIDER`, `DEPLOYER_SA`) — never real values, project IDs, or service-account emails.

- [gcp-setup.md](gcp-setup.md) — one-time GCP project bootstrap: billing link, ADC quota project, API enablement, Terraform state bucket, `terraform init` pattern.

## Open items (pending Developer-team confirmation)

Not decisions — flagged here so they aren't missed once confirmed. See [architecture/system-design-summary.md](../architecture/system-design-summary.md#open-cross-team-items--known-inconsistencies) for full context.

- **Possible frontend build stage.** The Milestone 4 System Design PDF (Part IV, §8.1) references a React/Vite frontend that isn't described anywhere else in this repo. If confirmed, the CD pipeline's build stage will need a Vite build step ahead of the Docker image build. No workflow changes made yet.
- **Document storage path.** Whether encrypted document blobs are written to the Cloud Storage document bucket (as this repo's architecture docs describe) or to a `LONGBLOB` column in Cloud SQL (as the Milestone 4 database design specifies) is a Developer-team decision. It does not change what DevOps provisions — the document bucket stays provisioned either way.
