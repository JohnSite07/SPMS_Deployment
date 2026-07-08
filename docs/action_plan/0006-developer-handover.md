# 0006 — Developer Team Handover Package

Grant the Developer team access and deliver a single handover document with everything they need to start coding: quick start, endpoints, credential access, contracts, and open decisions.

| | |
| --- | --- |
| **Status** | In Progress (2026-07-08 — blocked on developer emails/GitHub usernames) |
| **Date** | 2026-07-08 |
| **Author** | DevOps (main session) |

## User story

As the Developer team, we want one document and working access on day one — endpoints, how to get credentials, how to run and ship code — so that we can start implementing SecureVault immediately without reverse-engineering the infrastructure.

## Scope

**In scope:**
- **IAM for humans** (Terraform, `modules/iam/`): a per-developer grant set — `roles/secretmanager.secretAccessor` (per-secret), `roles/cloudsql.client`, `roles/artifactregistry.reader`, `roles/run.viewer`, `roles/logging.viewer` — driven by a `developer_emails` variable. GitHub: add developers as repo collaborators (write).
- **Handover document** — two forms:
  - `docs/guides/developer-handover.md` (committed): complete but **placeholder-valued** (no real project IDs/URLs per docs rule).
  - A **filled-in copy generated at handover time** (gitignored, e.g. `Temp/developer-handover-filled.md`) with the real project ID, service URL, and instance connection name — sent to the team privately. **No secret values in either copy** — credentials are fetched by each developer with their own identity.
- **Handover doc contents:**
  1. *Quick start*: clone → `cd app && npm install && npm test && npm run dev`; repo layout; who owns what (this repo hosts their `app/` code; `terraform/` and `.github/` are DevOps-owned).
  2. *Endpoints*: Cloud Run service URL (public HTTPS entry + `/healthz`), candidate-revision URL pattern for pre-release testing.
  3. *Database access*: private IP design (no public endpoint — by design, not an oversight); connect via **Cloud SQL Auth Proxy** with exact commands (`gcloud sql instances describe` for the connection name, proxy invocation, `mysql` client string); DB name/user; password via `gcloud secrets versions access latest --secret=db-password`.
  4. *All credentials*: table of the 6 secrets — name, purpose, fetch command; rotation = add a new version (no redeploy). SMTP placeholders flagged: replace when provider chosen.
  5. *Env contract*: the exact env var names Cloud Run injects (from PRD 0004) that `app/` must read; `PORT` behaviour; documents bucket name env var.
  6. *Ship process*: PR → CI (lint, Jest, terraform checks) → merge → CD deploys candidate → smoke → traffic. What a red CI means; how to see deploy logs (`gh run`, Cloud Logging links); manual rollback = DevOps runbook.
  7. *Test-plan support*: what Part IV testers need from infra (HTTPS endpoint ✓, DB inspection access via proxy for TC-SEC-*), and the demo-window `min-instances=1` option for cold-start-free demos.
  8. *Open decisions they own*: blob storage (bucket vs LONGBLOB), encryption boundary, frontend stack — linked to [system-design-summary.md](../architecture/system-design-summary.md).
  9. *Cost etiquette*: Cloud SQL is ~$10/mo and stoppable — stop/start runbook link; don't add always-on resources; budget alerts exist.
- **Verification dry run**: one Developer-team member follows the doc cold — clone to running local app + successful secret fetch + DB connection via proxy — with no help beyond the doc.

**Out of scope:**
- Writing any application/schema code beyond the 0005 skeleton.
- SMTP provider setup (their choice; we rotate the secret when told).
- Ongoing support model beyond the runbooks.

## Success criteria

- [ ] Each developer can: clone + run skeleton locally; fetch `db-password` with own identity; reach MySQL through the Auth Proxy; open the service URL.
- [ ] Committed guide contains **zero** real project IDs, URLs, emails, or secret values; filled copy exists only outside git.
- [ ] Dry run passes without out-of-band help (doc gaps found → fixed → re-run).
- [ ] `infra-reviewer` audit of the human IAM grants: least-privilege, per-secret scoping.
- [ ] Developer team confirms receipt + access in writing (email/issue).

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| Human IAM bindings | `google_project_iam_member` / per-secret members via `developer_emails` var | $0 |
| `docs/guides/developer-handover.md` | committed guide (placeholders) | $0 |
| Filled handover copy | gitignored file, sent privately | $0 |
| Repo collaborators | `gh api` | $0 |

References: PRD 0004 env contract · [runbooks/](../runbooks/) (stop/start SQL, rotation, rollback — produced by 0002/0004/0005) · Cloud SQL Auth Proxy docs.

## Scripts / commands

```bash
terraform -chdir=terraform plan -out=tfplan   # human IAM additions only
terraform -chdir=terraform apply tfplan        # $0; after approval
gh api -X PUT repos/:owner/:repo/collaborators/<username> -f permission=push

# dry-run core (what a developer runs, verbatim from the doc)
gcloud auth login && gcloud config set project <PROJECT_ID>
gcloud secrets versions access latest --secret=db-password
cloud-sql-proxy <INSTANCE_CONNECTION_NAME> --port 3306 &
mysql -h 127.0.0.1 -u <db_user> -p
```

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| Human IAM | `terraform-engineer` | `developer_emails` variable + scoped grants | Code + plan |
| IAM review | `infra-reviewer` | Least-privilege check on human grants | Verdict |
| Handover doc | `documentation-keeper` | Write the guide (placeholder form) from PRD 0002–0005 outcomes; wire into docs index | Committed guide |
| Filled copy + delivery | main session | Generate gitignored filled copy; send; collect confirmation | Delivered package |
| Dry run | Developer-team volunteer + main session | Cold-start walkthrough; log gaps | Validated doc |

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| Access works | dry run steps 1–4 | secret fetched; DB reached via proxy; URL loads |
| No leakage | grep committed guide for project ID/URL/emails | placeholders only |
| Doc sufficiency | dry run without help | completed, or gaps logged + fixed |
| IAM scoped | `infra-reviewer` + IAM policy read | per-secret, viewer-level, no editor/owner |
| Receipt | confirmation from Developer team | recorded in PRD Outcome |

## Additional considerations

- **Security posture:** developers get *read* paths (secrets, logs, DB client) — not deploy or IAM rights; shipping happens only through the pipeline. Personal gcloud identities mean access is revocable per person (remove from `developer_emails`, apply).
- **The "credentials file" question:** literal credentials are never written into a shared file — the handover doc teaches each developer to fetch secrets under their own audited identity. This is deliberate and should be stated in the doc's first section so nobody asks for a password spreadsheet.
- **Rollback / teardown:** human grants destroy with everything else; collaborator removal via `gh`.
- **Open questions:** the developers' Google account emails (needed for `developer_emails`); their GitHub usernames.
- **Dependencies:** PRDs 0002–0005 Done (the doc documents *live* values and *proven* processes, not intentions).

## Outcome

Partially executed 2026-07-08; remaining steps blocked on user input.

**Done:**
- Human-IAM Terraform in `modules/iam/`: `developer_emails` (default `[]`) drives per-developer project roles + per-secret accessor grants via `setproduct`; committed as a verified no-op (`terraform plan`: no changes). Supplying emails via tfvars + one apply activates access. Scope deviation, accepted: `template[0].revision` added to the app module's `ignore_changes` to clear drift created by CD's out-of-band revision naming — found while proving the no-op plan.
- Committed handover guide: [guides/developer-handover.md](../guides/developer-handover.md) (placeholder-valued, credentials policy stated up front).
- Filled private copy generated at `Temp/developer-handover-FILLED.md` (gitignored) with real project ID, service URL, instance connection name — no secret values.

**Blocked on user:** developers' Google emails (→ tfvars + apply) and GitHub usernames (→ repo collaborators); then the cold dry run + written confirmation, and this PRD flips to Done.
