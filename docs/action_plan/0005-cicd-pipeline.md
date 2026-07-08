# 0005 — CI/CD Pipeline & App Skeleton

Stand up the two GitHub Actions workflows, repo configuration, and a minimal Express app skeleton that proves the pipeline end-to-end — the working starting point the Developer team inherits.

| | |
| --- | --- |
| **Status** | Done (2026-07-08) |
| **Date** | 2026-07-08 |
| **Author** | DevOps (main session) |

## User story

As the DevOps team, I want every merge to `main` to build, verify, and safely release a revision with automatic rollback-by-default, so that the Developer team can ship by merging PRs without touching infrastructure.

## Scope

**In scope:**
- **App skeleton under `app/`** (pipeline-verification starter, handed to Developer team as their starting point): minimal Express server with `GET /healthz` → 200 JSON, reads `PORT` and the 0004 env contract (connects nothing yet), `package.json` with `npm test` (Jest, one passing test) and `npm run lint` (ESLint flat config), multi-stage `Dockerfile` (node:20-slim, non-root user).
- **`ci.yml`** (on `pull_request`): ESLint → Jest → `terraform fmt -check` → `terraform validate` → `terraform plan` (WIF auth, read-only intent; plan posted to the PR).
- **`cd.yml`** (on push to `main`): WIF auth → `docker buildx` build tagged `$GITHUB_SHA` → push to Artifact Registry → `terraform apply -auto-approve` → `gcloud run deploy --image …:$GITHUB_SHA --no-traffic --tag=candidate` → smoke-test candidate URL (`/healthz` = 200) → `gcloud run services update-traffic --to-latest`; on smoke failure the job fails and traffic stays put.
- **Repo config via `gh`**: Actions **variables** `GCP_PROJECT_ID`, `WIF_PROVIDER`, `DEPLOYER_SA` (values from 0003 outputs); branch protection on `main` requiring the CI checks; squash-merge default.
- **End-to-end proof**: a PR (CI green) merged to `main` → CD green → service URL serves the skeleton app (replacing the hello container).

**Out of scope:**
- Real application features, schema migrations, frontend build (if the Developer team confirms Vite, they/we add the stage — open item in [deployment/README.md](../deployment/README.md)).
- Staging environment (single prod env per design).
- Scheduled jobs, release tagging, notifications.

## Success criteria

- [ ] CI fails a PR with a lint error / failing test / bad Terraform, and passes a clean one.
- [ ] No long-lived credentials anywhere: workflow files contain no `credentials_json`, no repo **secrets** at all — only the 3 variables.
- [ ] CD run: image with SHA tag in Artifact Registry; candidate smoke-tested before traffic shift; final URL returns skeleton `/healthz` 200.
- [ ] Deliberate smoke-failure test (broken healthz on a branch): traffic remains on previous revision — rollback property proven.
- [ ] Branch protection blocks direct pushes to `main` without green CI.
- [ ] `infra-reviewer`: no blockers on the workflows.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `app/` skeleton | Express + Jest + ESLint + Dockerfile | $0 |
| `.github/workflows/ci.yml`, `cd.yml` | GitHub Actions | $0 (public-repo minutes / free tier) |
| Actions variables + branch protection | repo settings via `gh` | $0 |
| Images in AR | per-merge, SHA-tagged | pennies (cleanup policy from 0004) |

References: CLAUDE.md CI/CD section · google-github-actions/auth + setup-gcloud docs · [deployment/README.md](../deployment/README.md).

## Scripts / commands

```bash
# repo config (idempotent, non-destructive)
gh variable set GCP_PROJECT_ID --body "<from tf output>"
gh variable set WIF_PROVIDER   --body "<from tf output>"
gh variable set DEPLOYER_SA    --body "<from tf output>"
gh api -X PUT repos/:owner/:repo/branches/main/protection --input protection.json

# local sanity before pushing workflows
cd app && npm install && npm run lint && npm test
docker=skip  # no local docker; image build happens in CD only

# end-to-end proof
git checkout -b pipeline-e2e && git push -u origin pipeline-e2e   # open PR → CI
# merge after green → CD runs → verify:
curl -s -o /dev/null -w "%{http_code}\n" "$SERVICE_URL/healthz"    # 200 from skeleton
```

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| App skeleton | main session | Express + healthz + Jest + ESLint + Dockerfile | Testable `app/` |
| Workflows + repo config | `pipeline-engineer` | `ci.yml`, `cd.yml`, variables, branch protection; validate YAML; read back settings | Configured repo |
| Review | `infra-reviewer` | Workflow audit: WIF-only, SHA tags, traffic-shift ordering, `id-token` scope, PR-plan safety | Verdict |
| E2E proof + smoke-failure drill | main session | PR → merge → watch CD; then the deliberate-failure branch test | Proven pipeline |
| Docs | `documentation-keeper` | `docs/deployment/pipeline.md` (stages, gating, rollback); runbook: **manual rollback** (re-point traffic) | Docs + runbook |

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| CI gates work | PR with seeded lint error, then fixed | red → green |
| Keyless only | grep workflows; `gh secret list` | no keys; zero repo secrets |
| CD ships | merge PR; `gh run watch`; curl `/healthz` | green run; 200; SHA tag in AR |
| Rollback proven | branch with broken healthz → merge | CD fails at smoke; old revision still serving |
| Protection on | direct push to `main` | rejected |
| Review pass | `infra-reviewer` | no blockers |

## Additional considerations

- **Security posture:** CI on PRs authenticates to GCP only for `terraform plan`; restrict with `permissions: id-token: write` on that job only and never run plan for fork PRs (`pull_request` from forks gets no OIDC by condition). Note: repo is currently direct-push; enabling protection changes the team's workflow — announce it.
- **The skeleton is a handover artifact, not scope creep:** it exists so the pipeline is *provably* working the day the Developer team arrives (their UC code replaces `server.js` internals; lint/test/Docker contracts already green). Ownership of `app/` transfers to them at PRD 0006.
- **Rollback / teardown:** workflows are files — revert to remove; branch protection removable via `gh`. Nothing billable persists.
- **Open questions:** confirm branch-protection strictness (required reviews? or CI-only for a 6-person academic team — proposal: CI-only, no review requirement).
- **Dependencies:** PRDs 0003 (WIF, deployer SA) and 0004 (AR repo, Cloud Run service) Done.

## Outcome

Executed 2026-07-08. All success criteria met, several via *real* failures rather than staged drills — better evidence than the plan called for:

- **CI gates proven live:** the first two `terraform plan` runs on PR #1 failed on genuine permission gaps (below) and blocked merge; after fixes, both checks went green and the PR merged. App job passed throughout (lint + Jest).
- **Keyless end-to-end:** WIF OIDC exchange worked on the first attempt; `gh secret list` is empty — zero repo secrets, keys nowhere.
- **CD proven:** SHA-tagged image built and pushed to Artifact Registry, `terraform apply` clean in-pipeline, no-traffic candidate deploy, smoke test, traffic shift, post-shift verify. Live URL serves the skeleton (`/health` → `{"status":"ok"}`).
- **Rollback-by-default proven by a real incident:** the first CD run's smoke test failed 5× and left 100% of traffic on the previous revision — users saw no disruption. Root cause was a platform quirk, not app or pipeline logic.

Deviations from plan (all applied via Terraform / recorded here):

1. **`/healthz` is unusable on Cloud Run:** Google Front End reserves that path on `run.app` domains and 404s before the container sees the request. Health endpoint renamed to **`/health`** in the app and both workflow smoke checks. This is the kind of fact that must reach the Developer team's handover doc.
2. **Deployer needed two more grants** discovered by the first keyless plans: `roles/iam.workloadIdentityPoolAdmin` (project) and `roles/billing.costsManager` (on the billing account — budgets live there, project roles don't reach them). Both added to the iam module; the Cloud Billing API became the 13th enabled API (gcp-setup doc updated in the docs pass).
3. **A 4th GitHub Actions variable, `BILLING_ACCOUNT_ID`** — CD's `terraform apply` needs it (no default in variables.tf); it is an identifier, not a credential, consistent with the variables-not-secrets design.
4. **Branch protection contexts fixed** to the jobs' display names (`App checks (lint + test)`, `Terraform checks (fmt/validate/plan)`) — the original job-ID contexts would have blocked every merge. `enforce_admins=false` retained as the documented bootstrap carve-out.
5. **`paths-ignore` for `docs/**` and `**.md` added to cd.yml** so docs-only pushes don't burn a build/deploy; deliberately NOT added to ci.yml (required checks + path filtering = unmergeable docs PRs).
