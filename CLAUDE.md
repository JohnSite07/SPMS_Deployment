# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

This repository is being built from scratch. As of now there is no application or infrastructure code — only docs and the source milestone documents under [docs/milestones/](docs/milestones/). Those milestones are the authoritative blueprint; the distilled, working specs live under [docs/](docs/). Everything below is the **target** state being built toward, not yet-existing code; verify a path/command exists before relying on it.

The two specs that matter most when implementing:
- **Application spec** → [docs/requirements/](docs/requirements/) (use cases, business rules, NFRs) and [docs/architecture/domain-model.md](docs/architecture/domain-model.md) (the 14-class object model). Source: Milestone 3.
- **Deployment spec** → [docs/architecture/overview.md](docs/architecture/overview.md) and this file. Source: Milestone 4 (`docs/milestones/SecureVault_Milestone4_Deployment.docx`).

## What this is

SecureVault (SPMS — Secure Password Management System) is a web-based, zero-knowledge password manager: a single user stores, generates, and manages credentials and sensitive documents in an encrypted vault (AES-256 at rest, TLS in transit, 2FA). It is a containerised Node.js/Express app over MySQL, deployed to Google Cloud Platform. This repo (`SPMS_Deployment`) is the **deployment & DevOps deliverable** and also the home for building the app: it holds the application source, the Terraform that provisions every cloud resource, and the GitHub Actions pipelines that ship it.

This is a Seneca PRG800 academic project (the deployment work is Milestone 4; the app is specified by Milestones 1–3). Two hard constraints shape every decision:
- **Stay inside the $300 GCP free-trial credit** over a ~2-month window. Favour scale-to-zero and shared-core tiers; a single `terraform destroy` must return all spend to zero after grading.
- **Zero-knowledge / least-privilege posture.** Encryption is applied at the application layer and at rest — infrastructure never handles plaintext vault contents.

## Target repository layout

```
SPMS_Deployment/
├── .github/workflows/
│   ├── ci.yml          # lint, test, terraform plan — runs on PRs
│   └── cd.yml          # build, push, apply, deploy — runs on push to main
├── app/                # Node.js / Express source + Dockerfile
├── terraform/
│   ├── main.tf         # wires modules together
│   ├── variables.tf
│   ├── outputs.tf
│   ├── backend.tf      # GCS remote state backend
│   └── modules/
│       ├── network/    # VPC + Direct VPC egress
│       ├── iam/        # service accounts + Workload Identity Federation
│       ├── data/       # Cloud SQL + Cloud Storage
│       ├── app/        # Cloud Run + Artifact Registry
│       └── secrets/    # Secret Manager
├── docs/               # structured documentation (see Documentation below)
│   ├── architecture/   # overview + domain model
│   ├── requirements/   # functional + non-functional (app spec)
│   ├── decisions/      # ADRs
│   ├── deployment/ · runbooks/ · guides/
│   └── milestones/     # source PRG800 deliverables M1–M4 (authoritative)
└── README.md
```

## Architecture (big picture)

Three zones: **GitHub** (code + CI/CD), the **GCP project** (all runtime resources), and **external actors/services** (users, 2FA, SMTP).

- **Compute:** Cloud Run (`google_cloud_run_v2_service`), 1 vCPU / 512 MiB, `min=0` / `max=2`. Terminates HTTPS via a Google-managed cert; scales to zero when idle.
- **Database:** Cloud SQL for MySQL 8.4, `db-f1-micro`, 10 GB SSD, **private IP only** — never publicly exposed, reached from Cloud Run over the VPC via **Direct VPC egress** (deliberately not a Serverless VPC connector, to avoid an always-on cost). This is the largest cost line; it can be stopped between sessions.
- **Storage:** two Cloud Storage buckets — one versioned bucket for Terraform remote state, one for encrypted document blobs (lifecycle rules expire old objects).
- **Secrets:** Secret Manager holds DB creds, JWT key, AES key, SMTP creds (~6 secrets), injected into Cloud Run at start-up under its own service account. Secrets never live in source, the Docker image, or committed env files. Rotate by adding a new secret version — no code redeploy needed.
- **Images:** Artifact Registry (Docker format, single regional repo). **Images are tagged by git commit SHA** so every revision traces to an exact commit.
- **Identity:** separate least-privilege service accounts for pipeline vs. runtime — compromise of one does not grant the other's access. The pipeline stores **no service-account key**; it uses Workload Identity Federation (see below).
- **Observability:** Cloud Logging/Monitoring + a Terraform-managed `google_billing_budget` with alerts at 50/90/100% of $300.

Region is `us-central1` (Tier-1 pricing, free-tier eligible, same-region transfer free). All resources sit in one region to keep inter-service transfer free. Switching to `northamerica-northeast1` (Montreal) for Canadian data residency should be a one-variable change.

## Infrastructure: Terraform

Everything is provisioned through Terraform — nothing is clicked together in the console, which keeps the environment reproducible and destroyable. Code is split into small single-purpose modules under `terraform/modules/`; a thin root config wires them and selects the backend.

- **Remote state** lives in a dedicated **versioned GCS bucket** (`backend.tf`), not on a laptop. The GCS backend provides state locking (prevents concurrent pipeline runs from corrupting state); versioning allows rolling back a bad apply.
- Common commands (run from `terraform/`): `terraform init`, `terraform fmt`, `terraform validate`, `terraform plan`, `terraform apply`. **`terraform destroy` is the intended teardown** after grading — it is expected, not exceptional.

## CI/CD: GitHub Actions

Two workflows, gated by branch:

- **`ci.yml` (on pull request)** — must pass before merge: ESLint (lint) → `npm test` / Jest (unit + integration) → `terraform fmt`/`validate`/`plan`.
- **`cd.yml` (on push to `main`)** — authenticate (WIF) → `docker buildx` build tagged with `$GITHUB_SHA` → push to Artifact Registry → `terraform apply` → `gcloud run deploy` → smoke-test → shift traffic.

**Deployment strategy (revision-based, built-in rollback):** Cloud Run deploys are immutable revisions. The pipeline deploys the new revision **with no traffic** (`--no-traffic --tag=candidate`), smoke-tests its direct URL, and only then shifts 100% of traffic. If the smoke test fails, traffic stays on the last good revision — the deploy is a no-op. Rollback = re-point traffic at an earlier revision.

**Keyless auth (Workload Identity Federation):** the pipeline never stores a SA key. GitHub issues a short-lived OIDC token per run; GCP's WIF trusts it and lets the run impersonate the deployer service account for a few minutes. Only **non-sensitive identifiers** are stored as GitHub Actions *variables* (not secrets): `GCP_PROJECT_ID`, `WIF_PROVIDER`, `DEPLOYER_SA`. Do not introduce long-lived JSON keys into repo secrets — that is the exact risk this design eliminates.

## Application stack

Node.js + Express, MySQL, AES-256 encryption at rest, TLS in transit, two-factor authentication. The app must be container-first: it reads all config/secrets from the environment (populated from Secret Manager at runtime), connects to Cloud SQL over the private VPC path, and writes document blobs to Cloud Storage. App commands once `app/` exists: `npm install`, `npm test` (Jest — single test via `npm test -- <pattern>` or `npx jest <path> -t "<name>"`), `npm run lint` (ESLint), and a `Dockerfile` build.

**Build the app to its spec, not from scratch.** The data model and core classes follow [docs/architecture/domain-model.md](docs/architecture/domain-model.md); behaviour follows the use cases in [docs/requirements/functional-requirements.md](docs/requirements/functional-requirements.md). A few business rules are easy to get wrong and must be enforced in code: master password is **hashed-only, never stored** and **≥12 chars**; vault **auto-locks after 10 min**; **5 failed logins → 15-min lockout**; the **audit log is append-only**; uploads limited to **PDF/image ≤10 MB**; passwords flagged weak, or reused within **30 days**. Full list in the requirements doc.

## Documentation

All project documentation lives under `docs/` with a fixed taxonomy (architecture / requirements / decisions / deployment / runbooks / guides / milestones). The full rule is in [`.claude/rules/documentation.md`](.claude/rules/documentation.md) — read it before writing docs. Update docs in the same change that alters behaviour; record significant decisions as ADRs under `docs/decisions/`. The `docs/milestones/` binaries are source-of-truth deliverables — never edit them. Delegate documentation creation, restructuring, and audits to the `documentation-keeper` agent.

## Conventions & guardrails

- Keep the environment **cheap and disposable.** Don't add always-on resources (idle VPC connectors, `min-instances>0`, larger DB tiers) without a reason tied to the design — `min-instances=1` is acceptable only as a temporary demo-window setting to avoid cold starts.
- Keep the **DB private** (no public IP) and keep **pipeline and runtime service accounts separate and least-privilege**.
- Tag images by commit SHA; never deploy `:latest`.
