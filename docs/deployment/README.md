# Deployment

The CI/CD pipeline, environment setup, and release process: GitHub Actions workflows, Workload Identity Federation configuration, branch gating, the no-traffic → smoke-test → shift-traffic deploy strategy, and rollback.

Document setup steps and process flow. Reference GitHub Actions *variable names* (`GCP_PROJECT_ID`, `WIF_PROVIDER`, `DEPLOYER_SA`, `BILLING_ACCOUNT_ID` — see [pipeline.md](pipeline.md#github-actions-variables)) — never real values, project IDs, or service-account emails.

- [gcp-setup.md](gcp-setup.md) — one-time GCP project bootstrap: billing link, ADC quota project, API enablement, Terraform state bucket, `terraform init` pattern.
- [pipeline.md](pipeline.md) — `ci.yml`/`cd.yml` as built: CI gates, the no-traffic/smoke-test/shift CD strategy, branch protection, GitHub Actions variables, and the quirks (`/health` vs `/healthz`, required-check display names, `paths-ignore` placement) hit building it.

## Open items (pending Developer-team confirmation)

Not decisions — flagged here so they aren't missed once confirmed. See [architecture/system-design-summary.md](../architecture/system-design-summary.md#open-cross-team-items--known-inconsistencies) for full context.

- ~~**Frontend build stage (pending implementation).**~~ **Done.** The Milestone 4 System Design PDF (Part IV, §8.1) references a React/Vite frontend; it exists under `client/` ([PRD 0010](../action_plan/0010-react-frontend-scaffold.md)) and is now built and served in production ([PRD 0011](../action_plan/0011-frontend-serving-and-cd-integration.md), implementing the serving model decided in [ADR 0009](../decisions/0009-frontend-stack-and-serving-model.md)):
  - The Express app serves the built SPA — `express.static('client/dist')` plus an SPA `index.html` fallback, both mounted **ahead of** the auth middleware so the shell and static assets are public while every `/api/*` route stays behind the bearer token. The fallback regex excludes `/api` (anchored, case-insensitive) so unknown API paths still 404 as JSON instead of returning the SPA shell. Serving is conditional on the build being present, with `CLIENT_DIST_PATH` as an env override for its location — see [app/src/app.js](../../app/src/app.js).
  - The Docker image is multi-stage: a `client-build` stage runs `npm ci && npm run build` in `client/` and its `dist/` is copied into the runtime image alongside `src/`. Because the Dockerfile now references both `app/` and `client/`, the build context is the **repo root**, not `app/` — `cd.yml`'s build step uses `context: .` with `file: app/Dockerfile` — see [app/Dockerfile](../../app/Dockerfile).
  - `ci.yml` gained a `client-checks` job (`npm ci` + lint + build in `client/`) that gates PRs the same way the existing app job does. See [pipeline.md](pipeline.md#ci--ciyml-on-pull-request) and the branch-protection follow-up noted there.
- **Document storage path.** Whether encrypted document blobs are written to the Cloud Storage document bucket (as this repo's architecture docs describe) or to a `LONGBLOB` column in Cloud SQL (as the Milestone 4 database design specifies) is a Developer-team decision. It does not change what DevOps provisions — the document bucket stays provisioned either way.
