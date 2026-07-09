# Developer Handover Guide

Everything the Developer team needs to start implementing SecureVault: quick start, ownership, endpoints, database access, credentials, the environment contract, how to ship, test-plan support, open decisions, and cost etiquette.

**This is the committed, placeholder-valued copy** — it contains no real project ID, service URL, instance connection name, or any secret value, per the [documentation rule](../../.claude/rules/documentation.md). A filled-in copy with the real project ID, service URL, and instance connection name (still with **no** secret values) is generated at handover time and sent privately outside git — see [PRD 0006](../action_plan/0006-developer-handover.md). If you don't have that copy, ask DevOps; do not guess at the placeholders below.

## Credentials policy — read this first

**There is no shared password file, credentials spreadsheet, or `.env` handed around.** Every credential (DB password, JWT key, AES key, SMTP creds) lives in Secret Manager. Each developer fetches values **under their own Google identity**, granted individually and revocably (see [ADR 0003](../decisions/0003-two-service-accounts-and-keyless-wif.md) for why runtime, pipeline, and human access are all deliberately separated). If you're tempted to ask "can someone just send me the DB password" — the answer is `gcloud secrets versions access latest --secret=db-password`, run with your own `gcloud auth login`. See [All credentials](#all-credentials) below.

## Quick start

```bash
git clone <REPO_URL>
cd SPMS_Deployment/app
npm install
npm test
npm run lint
npm run dev
```

`npm run dev` runs the app locally on `PORT` (default `8080` if unset — Cloud Run sets it in production, you don't need to). The local run has no database connection configured out of the box; see [Database access](#database-access) to point it at Cloud SQL through the proxy.

## Ownership split

| Path | Owner | Notes |
| --- | --- | --- |
| `app/` | **Developer team**, from this handover onward | Build the real application here, replacing the pipeline-verification skeleton (`src/server.js`, `src/app.js`) with the actual SecureVault code per [requirements/](../requirements/) and [architecture/domain-model.md](../architecture/domain-model.md). Keep `npm test`, `npm run lint`, and the `Dockerfile` contracts green — CI depends on them. |
| `terraform/`, `.github/` | **DevOps**, stays | Infrastructure and pipeline changes go through DevOps. If your feature needs a new secret, a new bucket, a schema-adjacent resource, or a workflow change, open the conversation with DevOps rather than editing these directly. |
| `docs/` | **Shared**, taxonomy owned by DevOps | See [documentation.md](../../.claude/rules/documentation.md). Update the relevant doc in the same PR that changes behaviour. |

## Endpoints

| Endpoint | URL pattern | Purpose |
| --- | --- | --- |
| Production service | `<SERVICE_URL>` | Public HTTPS entry point, 100% of live traffic |
| Health check | `<SERVICE_URL>/health` | Used by the CD pipeline's smoke test; keep it dependency-free (no DB call) so it always answers, even during a cold start |
| Pre-release candidate | `https://candidate---<SERVICE_URL_HOST>` — Cloud Run prefixes the tag and three dashes onto the service's hostname (e.g. if the service URL is `https://spms-<hash>-uc.a.run.app`, the candidate is `https://candidate---spms-<hash>-uc.a.run.app`) | Every CD run deploys here first, with 0% production traffic, before the smoke test passes and traffic shifts. Useful for checking a revision before/without it becoming live — ask DevOps for the exact resolved URL of a given run, or read it from the CD run's logs (`Resolve candidate URL` step) |

> **`/healthz` is reserved and will 404 — do not use it.** Google Front End reserves that exact path on all `run.app` domains and returns its own 404 before the request reaches your container, regardless of what routes you define. The health endpoint is **`/health`** (no `z`). This is a platform quirk discovered the hard way during pipeline setup (see [deployment/pipeline.md](../deployment/pipeline.md#quirks-that-cost-us-time)) — if you rename or remove the current `/health` route, the CD smoke test will fail and the deploy will correctly refuse to ship (see [deployment/pipeline.md](../deployment/pipeline.md)), but you'll lose a deploy cycle finding out why.

## Database access

**The database has no public IP — by design, not an oversight.** Cloud SQL for MySQL is reachable only over the VPC (Cloud Run reaches it via Direct VPC egress; see [architecture/overview.md](../architecture/overview.md)). The supported way for a human to reach it is the **Cloud SQL Auth Proxy**, which tunnels an authenticated, encrypted connection without ever exposing the instance publicly.

```bash
# 1. One-time: create Application Default Credentials (ADC) as yourself.
#    `gcloud auth login` is NOT enough — the proxy (and any locally-run app
#    code using Google client libraries) reads ADC, not the gcloud CLI login.
#    Without ADC the proxy falls back to the GCE metadata server, which does
#    not exist on your laptop, and dies with
#    "credentials: invalid token JSON from metadata: EOF".
gcloud auth application-default login
gcloud auth application-default set-quota-project <PROJECT_ID>

# 2. Look up the instance connection name (project:region:instance)
gcloud sql instances describe <INSTANCE> --format="value(connectionName)"
# → <INSTANCE_CONNECTION_NAME>

# 3. Start the proxy (download from https://cloud.google.com/sql/docs/mysql/sql-proxy if you don't have it)
cloud-sql-proxy <INSTANCE_CONNECTION_NAME> --port 3306
#    (alternative if you'd rather not create ADC: add --gcloud-auth to make
#     the proxy borrow the gcloud CLI's active login instead)

# 4. In another terminal, fetch the app DB password under your own identity
gcloud secrets versions access latest --secret=db-password

# 5. Connect
mysql -h 127.0.0.1 -P 3306 -u <DB_USER> -p
```

`<INSTANCE>` is the Cloud SQL instance name (Terraform default: `spms-mysql`, see [terraform/modules/data/variables.tf](../../terraform/modules/data/variables.tf)). `<DB_USER>` is the app login username, itself fetchable via `gcloud secrets versions access latest --secret=db-user`. The schema name is `securevault` by default (same file).

The proxy authenticates using your own `gcloud` identity against IAM (`roles/cloudsql.client` **plus** `roles/serviceusage.serviceUsageConsumer` — human callers need the latter to use the SQL Admin API under their own credentials, or the proxy fails with a 403 "Caller does not have required permission to use project"; see [terraform/modules/iam/main.tf](../../terraform/modules/iam/main.tf) `developer_project_roles`). If the proxy or the `mysql` client refuses to connect, confirm your Google account is a member of the developers Google Group — ask DevOps to add you if not. Freshly granted IAM takes a few minutes to propagate.

## All credentials

Six secrets exist in Secret Manager, all fetched the same way: `gcloud secrets versions access latest --secret=<NAME>`, under your own identity (granted per-secret — never project-wide, see [ADR 0003](../decisions/0003-two-service-accounts-and-keyless-wif.md)).

| Secret ID | Purpose | Notes |
| --- | --- | --- |
| `db-user` | Cloud SQL application login username | |
| `db-password` | Cloud SQL application login password | Terraform-generated |
| `jwt-signing-key` | Signs/verifies session tokens | |
| `aes-encryption-key` | Server-side AES-256 application encryption key | 32 raw bytes, **base64-encoded** in the secret — see [Env contract](#env-contract) below |
| `smtp-username` | SMTP auth for outbound email | **Currently a literal placeholder** (`PLACEHOLDER-set-real-value-via-rotation`) — not wired to a real provider yet |
| `smtp-password` | SMTP auth for outbound email | Same placeholder status as above |

**SMTP is not yet usable.** Both SMTP secrets hold a placeholder string, not real credentials, pending the Developer team's choice of provider. Tell DevOps once you've picked one and they'll rotate both secrets (add a new version — no redeploy needed, see [runbooks/secret-rotation.md](../runbooks/secret-rotation.md)).

Rotation in general (e.g. after a suspected leak, or once SMTP is chosen) is DevOps's job via [runbooks/secret-rotation.md](../runbooks/secret-rotation.md) — you don't need write access to rotate, only read access to consume.

## Env contract

This is the exact set of environment variables Cloud Run injects into the running container — read these, don't invent new names for the same concept. Fixed in [PRD 0004](../action_plan/0004-app-runtime.md) and implemented in [terraform/modules/app/main.tf](../../terraform/modules/app/main.tf).

**Plain env vars:**
- `DB_HOST` — Cloud SQL private IP
- `DB_PORT` — `3306`
- `DB_NAME` — schema name (`securevault`)
- `DB_USER` — app login username
- `DOCUMENTS_BUCKET` — Cloud Storage bucket name for encrypted document blobs

**Secret-ref env vars** (resolved by Cloud Run from Secret Manager, never literal values in the service spec):
- `DB_PASSWORD`
- `JWT_SIGNING_KEY`
- `AES_ENCRYPTION_KEY`
- `SMTP_USERNAME`
- `SMTP_PASSWORD`

**`PORT`** is injected automatically by Cloud Run — read it (`process.env.PORT`), don't hardcode a port, and don't set it yourself in Terraform or the Dockerfile.

> **`AES_ENCRYPTION_KEY` is base64-encoded 32 raw bytes.** The secret value is a base64 string; your app must **base64-decode it before use** as an AES-256 key. Using the base64 string directly as key material will silently produce a wrong-length (and wrong) key — this was flagged explicitly during infra review and must not be missed.

Secret-backed env vars resolve to their `latest` version **at container instance start**, not continuously — see [runbooks/secret-rotation.md](../runbooks/secret-rotation.md) if you rotate one and need running instances to pick it up.

## Ship process

1. Open a PR against `main`.
2. CI runs two required checks: **`App checks (lint + test)`** (ESLint + Jest, no GCP access) and **`Terraform checks (fmt/validate/plan)`** (only relevant if your PR touches `terraform/`; runs `plan` only, never `apply`). Both must go green before merge — see [deployment/pipeline.md](../deployment/pipeline.md).
3. A red CI check means your branch has a lint error, a failing test, or (rarely, if you touched `terraform/`) a Terraform formatting/validation/plan problem — the workflow logs (`gh run view <RUN_ID> --log` or the PR's Checks tab) show exactly which.
4. Merge is **squash merge** (repo default) once checks are green.
5. Push to `main` triggers CD automatically: build → push image (tagged by commit SHA) → `terraform apply` → deploy the new revision with no traffic → smoke-test `/health` → shift traffic only if the smoke test passes. Watch it with `gh run watch`, or read logs in Cloud Logging.
6. **Docs-only pushes to `main` (changes only under `docs/` or `*.md`) do not trigger CD** — deliberate, so documentation edits don't burn a build/deploy cycle. If your PR mixes doc and code changes, CD still runs (the filter only skips pushes that touch *nothing* else).
7. If a deploy needs to be undone after it shipped, that's DevOps's [runbooks/rollback.md](../runbooks/rollback.md) — you don't need infrastructure access to request one, just to flag the bad revision.

## Test-plan support

For Part IV test execution (the M4 System Test Plan, Developer/QA-owned — see [architecture/system-design-summary.md](../architecture/system-design-summary.md#part-iv--system-test-plan-developer-team)):

- **HTTPS endpoint**: `<SERVICE_URL>` is live for the full testing window; DevOps keeps it available.
- **`TC-SEC-*` DB inspection**: connect via the Cloud SQL Auth Proxy exactly as in [Database access](#database-access) above — no separate access path exists or is needed.
- **Cold-start-free demos**: Cloud Run scales to zero by default (`min_instance_count = 0`), which means the first request after idle time pays a cold-start latency. For a demo window where that's undesirable, DevOps can temporarily set the `demo_min_instances` Terraform variable to `1` (see [terraform/modules/app/variables.tf](../../terraform/modules/app/variables.tf)) — ask ahead of time; it is a deliberate, temporary override, never the default, because it keeps an instance billing continuously.

## Open decisions they own

These are Developer-team decisions, not resolved by DevOps — full context in [architecture/system-design-summary.md](../architecture/system-design-summary.md#open-cross-team-items--known-inconsistencies):

1. **Document blob storage** — Cloud Storage bucket (already provisioned, `DOCUMENTS_BUCKET` env var ready) vs. `SECURE_DOCUMENTS.encrypted_blob LONGBLOB` in Cloud SQL (as the M4 database design specifies). No infra change either way; the bucket stays provisioned regardless.
2. **Encryption boundary** — server-side (`CryptoService` reading `AES_ENCRYPTION_KEY` from Secret Manager, as Parts I–III describe) vs. client-side/end-to-end (as Part IV's test cases assert). No infra change either way; if you go client-side, the server-side AES key simply goes unused.
3. **Frontend stack** — Part IV references a React/Vite frontend not described elsewhere. If confirmed, tell DevOps: the CD build stage will need a Vite build step ahead of the Docker image build, which is not in `cd.yml` today.

**Also flag for awareness, not a decision for you to make:** the Cloud SQL instance runs **MySQL 8.0, not 8.4** (edition `ENTERPRISE`, tier `db-f1-micro`). MySQL 8.4 requires the Enterprise **Plus** edition, whose smallest tiers cost hundreds of dollars a month — incompatible with the project's $300 budget. This was a deliberate substitution during infrastructure provisioning (see [PRD 0002's Outcome](../action_plan/0002-network-and-data.md#outcome)) and should not affect your Part II schema, which targets MySQL 8 generically — but if you rely on a MySQL 8.4-only feature, it will not be available.

## Cost etiquette

This project runs inside a fixed $300 free-trial credit over a fixed window. A few habits keep it inside budget:

- **Cloud SQL costs ~$0.33/day while running** — the single largest ongoing cost line. Stop it when you're not actively using it (evenings, weekends, between test sessions) via [runbooks/stop-start-cloud-sql.md](../runbooks/stop-start-cloud-sql.md). It does **not** need to run continuously for local development unless you're actively hitting the DB.
- **Billing alerts already exist** at 50/90/100% of the $300 budget (a Terraform-managed `google_billing_budget`) — if you get paged by one, don't panic-delete resources; check [runbooks/cost-check.md](../runbooks/cost-check.md) first.
- **Don't add always-on resources** without discussing with DevOps first — no idle VPC connectors, no `min_instance_count > 0` left on permanently (see [Test-plan support](#test-plan-support) above for the sanctioned temporary exception), no larger DB tier "just in case."
- When you're done with the project entirely, DevOps runs [runbooks/teardown.md](../runbooks/teardown.md) — a single `terraform destroy` returns spend to $0.

## Related

- [architecture/overview.md](../architecture/overview.md) — full runtime topology.
- [architecture/domain-model.md](../architecture/domain-model.md) — the 14-class object model your code implements.
- [requirements/functional-requirements.md](../requirements/functional-requirements.md) · [requirements/non-functional-requirements.md](../requirements/non-functional-requirements.md) — the application spec.
- [decisions/0003-two-service-accounts-and-keyless-wif.md](../decisions/0003-two-service-accounts-and-keyless-wif.md) — why access is split the way it is.
- [deployment/pipeline.md](../deployment/pipeline.md) · [runbooks/](../runbooks/) — everything referenced above, in full.
