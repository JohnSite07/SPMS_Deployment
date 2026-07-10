# CI/CD Pipeline

The two GitHub Actions workflows as built, what gates a merge, and how a release ships. Source of truth: [.github/workflows/ci.yml](../../.github/workflows/ci.yml) and [.github/workflows/cd.yml](../../.github/workflows/cd.yml). Built and proven end-to-end in [PRD 0005](../action_plan/0005-cicd-pipeline.md) — its Outcome section is the run log this page distils.

Related: [gcp-setup.md](gcp-setup.md) · [ADR 0003 — two service accounts and keyless WIF](../decisions/0003-two-service-accounts-and-keyless-wif.md) · [runbooks/rollback.md](../runbooks/rollback.md) · [runbooks/secret-rotation.md](../runbooks/secret-rotation.md).

## CI — `ci.yml`, on pull request

Three independent jobs. `App checks` and `Terraform checks` are required status checks on `main`; `Client checks` is a newer job that runs on every PR but is **not yet added** to the required-checks list — see [Branch protection](#branch-protection) below.

| Job (display name) | GCP access | Steps |
| --- | --- | --- |
| `App checks (lint + test)` | None | checkout → `npm ci` → `npm run lint` → `npm test`, all in `app/` |
| `Client checks (lint + build)` | None | checkout → `npm ci` → `npm run lint` → `npm run build`, all in `client/` — see [ADR 0009](../decisions/0009-frontend-stack-and-serving-model.md) and [PRD 0011](../action_plan/0011-frontend-serving-and-cd-integration.md) |
| `Terraform checks (fmt/validate/plan)` | WIF, read-only intent | checkout → `terraform fmt -check -recursive` → authenticate (WIF) → `terraform init` → `terraform validate` → `terraform plan` |

The app and client jobs never touch GCP — they can run for any contributor, including forks, with no credentials at all.

The Terraform job only ever runs `plan`, never `apply`. Its WIF authentication and the `plan` step itself are both gated by:

```yaml
if: github.event.pull_request.head.repo.full_name == github.repository
```

Fork PRs skip both steps — a fork's workflow run has no way to obtain an OIDC token this repo's Workload Identity Pool would accept (the pool's `attribute_condition` pins to this exact repository, per [ADR 0003](../decisions/0003-two-service-accounts-and-keyless-wif.md)), so the job degrades gracefully to fmt-check-only rather than failing on an auth error.

## CD — `cd.yml`, on push to `main`

Single job, `deploy`, gated by `concurrency: { group: production, cancel-in-progress: false }` so deploys queue rather than race each other against the same Cloud Run service.

**Trigger filter:** `paths-ignore: [docs/**, **.md]` — a docs-only push does not burn a build/push/deploy cycle. See [Quirks](#quirks-that-cost-us-time) for why this filter must **not** be mirrored onto `ci.yml`.

Stages, in order:

1. **Authenticate (WIF)** — exchange the run's OIDC token to impersonate the deployer SA. This is the only workflow that authenticates to GCP with write intent.
2. **Build and push** — `docker buildx` builds the image and pushes it to Artifact Registry tagged `${{ github.sha }}` only. No `:latest` tag is ever pushed, so every running revision traces back to an exact commit. The Dockerfile ([app/Dockerfile](../../app/Dockerfile)) is multi-stage: a `client-build` stage runs `npm ci && npm run build` in `client/`, whose `dist/` is copied into the runtime image alongside the Express app. Because the build now needs to see both `app/` and `client/`, the build context is the **repo root** (`context: .`, `file: app/Dockerfile`), not `app/` as before — see [ADR 0009](../decisions/0009-frontend-stack-and-serving-model.md) and [PRD 0011](../action_plan/0011-frontend-serving-and-cd-integration.md).
3. **`terraform apply -auto-approve`** — reconciles the whole estate (not just the app). The Cloud Run resource's `lifecycle.ignore_changes` on `template[0].containers[0].image` (see [terraform/modules/app/main.tf](../../terraform/modules/app/main.tf)) means this step never fights the SHA-tagged deploy in step 4.
4. **Deploy candidate, no traffic** — `gcloud run deploy spms --image <sha> --no-traffic --tag candidate`. The new revision exists and is reachable at its own tagged URL, but serves 0% of production traffic.
5. **Resolve the candidate URL** from `gcloud run services describe --format=json`, filtering `status.traffic[]` for `tag == candidate`.
6. **Smoke test the candidate directly** — `GET <candidate-url>/health`, up to 5 attempts with a 10s delay between them. Any non-200 after all attempts fails the job.
7. **Shift traffic** — only reached if step 6 exited 0. `gcloud run services update-traffic spms --to-latest` moves 100% of traffic onto the new revision.
8. **Post-shift verify** — one more `GET <service-url>/health` against the now-live traffic split, so a shift that somehow serves a stale revision still fails the run visibly.

**The rollback property is structural, not a script:** if step 6 fails, the job exits before step 7 ever runs, so 100% of traffic is still on the last good revision. The deploy is a no-op from the user's perspective — this was proven by a real incident on the first CD run (see PRD 0005 Outcome), not a staged drill.

## Branch protection

`main` requires CI jobs to pass before merge. The required-check **contexts are the jobs' display names** — `App checks (lint + test)` and `Terraform checks (fmt/validate/plan)` — not their YAML job IDs (`app-checks`, `terraform-checks`). See [Quirks](#quirks-that-cost-us-time).

> **Follow-up (not yet applied):** [PRD 0011](../action_plan/0011-frontend-serving-and-cd-integration.md) added a third `ci.yml` job, `Client checks (lint + build)` (job id `client-checks`), gating the `client/` build the same way `App checks` gates `app/`. It runs on every PR today but has **not** been added to `main`'s required-status-checks list, so a PR can currently merge with a broken client build. Add `Client checks (lint + build)` (the display name, per the quirk above) to the required checks to close this gap.

`enforce_admins` is currently **`false`** — a deliberate, documented bootstrap carve-out for a single-operator academic project, not an oversight. It should be revisited (set `true`) once more than one person can push directly, and is called out again in [ADR 0003](../decisions/0003-two-service-accounts-and-keyless-wif.md#consequences).

## GitHub Actions variables

Six **variables** (never secrets — none of these are credentials) drive both workflows:

| Variable | Used by | Purpose |
| --- | --- | --- |
| `GCP_PROJECT_ID` | CI, CD | Project to authenticate into and target with `terraform apply` |
| `WIF_PROVIDER` | CI, CD | Workload Identity Pool provider resource name for the `google-github-actions/auth` action |
| `DEPLOYER_SA` | CI, CD | Deployer service account email to impersonate via WIF |
| `BILLING_ACCOUNT_ID` | CD | Needed by `terraform apply` (the billing budget resource lives on the billing account, not the project) |
| `DEVELOPER_GROUP` | CI (`plan`), CD (`apply`) | Google Group address granted developer IAM roles (`TF_VAR_developer_group`) — a group, never a personal email, since these logs are public. Empty until set. |
| `ENABLE_PUBLIC_IP` | CI (`plan`), CD (`apply`) | Temporary dev-phase Cloud SQL public-IP toggle (`TF_VAR_enable_public_ip`, [ADR 0005](../decisions/0005-temporary-public-ip-cloud-sql-dev-phase.md)). Wired as `${{ vars.ENABLE_PUBLIC_IP \|\| 'false' }}` so an unset variable safely parses as `false` (private). This is the durable control surface — a tfvars-only setting is reverted by the next CD apply; see [runbooks/db-public-access.md](../runbooks/db-public-access.md). |

All six are non-sensitive identifiers, consistent with the keyless design in [ADR 0003](../decisions/0003-two-service-accounts-and-keyless-wif.md) — no repo secret exists for either service account.

## Quirks that cost us time

Recorded so they are never re-debugged. Full incident detail in [PRD 0005's Outcome](../action_plan/0005-cicd-pipeline.md#outcome).

1. **`/healthz` is unusable on `run.app` domains.** Google Front End reserves that path and returns its own 404 before the request reaches the container — regardless of what the app defines. The health endpoint is **`/health`**, in the app ([app/src/app.js](../../app/src/app.js)) and in both workflow smoke checks. This surfaced as a real CD failure (smoke test failed 5×, traffic correctly stayed on the previous revision) before being understood as a platform quirk rather than an app bug.
2. **Required-check contexts must be job *display names*, not job IDs.** GitHub's branch-protection API matches on the `name:` string a job renders in the checks UI. Using the YAML job keys (`app-checks`, `terraform-checks`) as the protection contexts silently blocks every merge, because no check ever reports under those names.
3. **`ci.yml` must never get a `paths-ignore`/`paths` filter while its jobs are required checks.** `cd.yml` skips docs-only pushes safely because nothing else depends on it running. If `ci.yml` skipped docs-only changes the same way, GitHub would never see the required checks report for a docs-only PR, and that PR would be permanently unmergeable — a path-filtered required check is a stuck-forever trap, not a no-op.
4. **The deployer SA needed two grants beyond the original design**, discovered by the first two `terraform plan` runs on the pipeline's proving PR: `roles/iam.workloadIdentityPoolAdmin` (project-level) and `roles/billing.costsManager` (on the billing account itself — budget resources live there, project-level roles don't reach them). Both are now in [terraform/modules/iam/](../../terraform/modules/iam/); the Cloud Billing API is the 13th enabled API (see [gcp-setup.md](gcp-setup.md)).
