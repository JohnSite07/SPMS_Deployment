# 0004 — Application Runtime: Artifact Registry, Secrets, Cloud Run

Provision the compute path: the image repository, the remaining application secrets, and the Cloud Run service wired to the VPC, the DB, and Secret Manager.

| | |
| --- | --- |
| **Status** | Done (2026-07-08) |
| **Date** | 2026-07-08 |
| **Author** | DevOps (main session) |

## User story

As the DevOps team, I want the Cloud Run service, Artifact Registry, and all runtime secrets provisioned, so that a container image pushed by the pipeline can immediately run with its configuration injected — no manual wiring left between code and cloud.

## Scope

**In scope:**
- `modules/app/`: Artifact Registry repo (Docker format, regional, cleanup policy keeping last ~10 images); `google_cloud_run_v2_service` — 1 vCPU / 512 MiB, `min_instance_count = 0`, `max_instance_count = 2` (a `demo_min_instances` variable, default 0, is the only sanctioned way to warm it), **Direct VPC egress** into the 0002 subnet (`PRIVATE_RANGES_ONLY`), runs as the runtime SA, public ingress (the app is a public web app), secrets mounted as env vars by reference, port/env contract documented for the Developer team.
- `modules/secrets/` (completing the ~6): `jwt-signing-key` and `aes-encryption-key` (generated via `random_password`/`random_bytes`, stored as versions); `smtp-username` / `smtp-password` (created with **placeholder versions** — real values pending the Developer team's SMTP provider choice; rotation is add-a-version, no redeploy).
- Initial deploy uses Google's public **hello container** (`us-docker.pkg.dev/cloudrun/container/hello`) as image, with `lifecycle { ignore_changes = [template[0].containers[0].image] }` so CD's SHA-tagged deploys don't fight Terraform.
- DB connection env by reference: private IP + port from 0002 outputs, creds from Secret Manager.

**Out of scope:**
- Workflows, GitHub variables, real app image — PRD 0005.
- The app's actual code/schema — Developer team.
- Custom domain mapping (default `run.app` URL is the endpoint; revisit only if asked).

## Success criteria

- [ ] Plan/apply clean, 0 destroys.
- [ ] Service URL returns HTTP 200 (hello container) over HTTPS.
- [ ] Service env shows secrets **by reference** (`secretKeyRef`), never literal values; runtime SA is the service identity.
- [ ] Scale-to-zero observed: instance count drops to 0 after idle (~15 min).
- [ ] All 6 secrets exist; JWT/AES have real generated versions; SMTP has placeholder versions flagged for rotation.
- [ ] `infra-reviewer`: no blockers (min-instances, egress mode, secret handling).

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| Artifact Registry repo | `google_artifact_registry_repository` + cleanup policy | ~$0.10/mo (<2 GB) |
| Cloud Run service | `google_cloud_run_v2_service` (min 0 / max 2) | $0–3/mo (free tier covers demo traffic) |
| 4 more secrets (+2 from 0002 = 6) | `google_secret_manager_secret(_version)` | <$1/mo total |

References: [architecture/overview.md](../architecture/overview.md) · Cloud Run Direct VPC egress docs · `docs/deployment/README.md` open items (a Vite frontend changes the image build, **not** this runtime config).

## Scripts / commands

```bash
terraform -chdir=terraform fmt -check -recursive && terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=tfplan
terraform -chdir=terraform apply tfplan     # BILLABLE (cents); after approval

# verification
SERVICE_URL=$(gcloud run services describe spms --region=us-central1 --format="value(status.url)")
curl -s -o /dev/null -w "%{http_code}\n" "$SERVICE_URL"      # expect 200
gcloud run services describe spms --region=us-central1 --format=yaml | grep -A2 secretKeyRef
gcloud secrets list --filter="name~spms" --format="table(name)"
```

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| Write app + secrets modules | `terraform-engineer` | Scope above; fmt/validate; plan summary | Code + plan |
| Pre-apply review | `infra-reviewer` | Focus: min-instances=0, egress `PRIVATE_RANGES_ONLY`, per-secret IAM from 0003 lines up, ignore_changes on image | Verdict |
| Apply + verify | main session | Apply after approval; curl + describe checks | Live runtime |
| Docs | `documentation-keeper` | Runbook: **secret rotation** (add-a-version); document the env/port contract the app must honour (feeds PRD 0006 handover) | Runbook + doc |

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| Service up | `curl` service URL | 200 over HTTPS |
| Secrets by reference | service describe | `secretKeyRef` entries; no literals |
| Right identity | service describe | runtime SA email |
| Scale to zero | monitoring after idle | 0 instances |
| Secrets complete | `gcloud secrets list` | 6 secrets; SMTP flagged placeholder |
| Review pass | `infra-reviewer` | no blockers |

## Additional considerations

- **Security posture:** completes the runtime zero-knowledge boundary — infra stores ciphertext (DB/bucket), keys live in Secret Manager, injected only into the runtime SA's service. The AES key here is the *server-side* application key; if the Developer team later chooses client-side encryption (open item 2), the key simply goes unused — no infra change.
- **Env contract (handover-critical):** the app must read `PORT` (Cloud Run sets it), `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`, `JWT_SIGNING_KEY`, `AES_ENCRYPTION_KEY`, `SMTP_USERNAME`/`SMTP_PASSWORD`, `DOCUMENTS_BUCKET`. Exact names fixed in this PRD's execution and recorded for PRD 0006.
- **Rollback / teardown:** everything destroys cleanly; AR cleanup policy prevents image-storage creep.
- **Open questions:** SMTP provider (Developer team / external) — placeholders until then.
- **Dependencies:** PRDs 0002 (subnet, DB outputs, db secrets) and 0003 (runtime SA, per-secret IAM) Done.

## Outcome

Executed 2026-07-08. 17 resources applied (0 changes/destroys to the prior 21); infra-reviewer pre-apply verdict: safe, zero blockers. Verified post-apply: service URL live over HTTPS (200 from the hello container), all five sensitive env vars injected via `secretKeyRef` (never literal), service identity is the runtime SA, all six secrets exist, `allUsers` invoker is the only public grant in the estate. Deviations/notes:

1. **Env contract as built** (handover-critical, for PRD 0006): plain — `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DOCUMENTS_BUCKET`; secret-ref — `DB_PASSWORD`, `JWT_SIGNING_KEY`, `AES_ENCRYPTION_KEY`, `SMTP_USERNAME`, `SMTP_PASSWORD`; `PORT` injected by Cloud Run.
2. **`AES_ENCRYPTION_KEY` is base64-encoded 32 raw bytes** (`random_bytes`) — the app must base64-decode before use (reviewer note; must appear in the handover doc).
3. **SMTP secrets hold literal placeholders** (`PLACEHOLDER-set-real-value-via-rotation`) pending the Developer team's provider choice; rotation = `gcloud secrets versions add`.
4. **AR cleanup policy** is the required KEEP(10)/DELETE(ANY) pair. **`ignore_changes` on the container image** keeps Terraform from fighting CD's SHA deploys.
5. Scale-to-zero not yet observed (requires ~15 min idle); expected per `min_instance_count = 0` — will be confirmed incidentally during PRD 0005's E2E run.
