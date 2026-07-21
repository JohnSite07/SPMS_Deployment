# Action Plans (PRDs)

Plans of record written **before** executing substantial work — provisioning, pipeline stages, migrations, teardown. The governing rule (required sections, naming, approval gate) is [`.claude/rules/action-plan.md`](../../.claude/rules/action-plan.md); start new PRDs from [`_template.md`](_template.md).

A PRD must be **Approved** by the user before execution starts. Once executed, its status is set to `Done` and an Outcome note records what actually happened; the durable results live in the regular docs taxonomy (ADRs, deployment docs, runbooks).

## Index

| PRD | Title | Status |
| --- | --- | --- |
| [0001](0001-terraform-foundation.md) | Terraform Foundation & GCP Bootstrap | Done |
| [0002](0002-network-and-data.md) | Network & Data Layer (VPC, Cloud SQL, document bucket) | Done |
| [0003](0003-iam-and-wif.md) | Identity: Service Accounts & Workload Identity Federation | Done |
| [0004](0004-app-runtime.md) | Application Runtime: Artifact Registry, Secrets, Cloud Run | Done |
| [0005](0005-cicd-pipeline.md) | CI/CD Pipeline & App Skeleton | Done |
| [0006](0006-developer-handover.md) | Developer Team Handover Package | In Progress (dry run underway) |
| [0007](0007-temporary-public-db-access.md) | Temporary Public DB Access (dev phase, reversible) | Done (flip back before presentation) |
| [0008](0008-audit-log-and-vault-routes.md) | Audit Log, Vault Routes, and Admin History View | Done (retrospective) |
| [0009](0009-storage-layer-and-auth-wiring.md) | Storage Layer & Auth Wiring (MySQL ports + crypto callbacks) | Draft (awaiting approval) |
| [0010](0010-react-frontend-scaffold.md) | React Frontend Scaffold (Vite + React Router) | Done |
| [0011](0011-frontend-serving-and-cd-integration.md) | Frontend Serving & CD Integration (Express static + SPA fallback, Docker/CI-CD) | Done |
| [0012](0012-frontend-api-client-foundation.md) | Frontend API Client Foundation (fetch wrapper, token handling, auth service) | Done |
| [0013](0013-design-system-baseline.md) | Design System Baseline (react-bootstrap + SASS theme) | Done |
| [0014](0014-database-schema-implementation.md) | Database Schema Capture & Reconciliation Migration (ALTER existing tables + grants) | Draft (awaiting approval) |
| [0015](0015-password-reset-flow.md) | Password Reset Flow (forgot-password request + reset confirm, re-hash only) | Superseded by [0020](0020-totp-based-password-reset.md) |
| [0016](0016-smtp-provisioning-for-password-reset.md) | SMTP Provisioning for Password-Reset Email (DevOps hand-off) | Draft — no longer blocking password reset (see PRD) |
| [0017](0017-two-factor-enrollment.md) | Two-Factor Enrollment (TOTP setup + confirm) | Done |
| [0018](0018-welcome-and-registration.md) | Welcome/Landing Page & Self-Service Account Registration | Done |
| [0019](0019-credential-vault-ui-and-encryption.md) | Credential Vault: Client-Side Encryption + List/Add/View/Edit/Delete UI | Done |
| [0020](0020-totp-based-password-reset.md) | TOTP-Based Password Reset (replaces the email-link flow) | Done |
| [0021](0021-password-generator.md) | Password Generator | Done |
| [0022](0022-password-health-and-dashboard.md) | Password Health Analysis (UC-05) + Vault Dashboard Redesign | Done |

Execution order: 0001 → 0002 → 0003 → 0004 → 0005 → 0006 (0002 and 0003 are independent of each other; the rest are sequential). Each PRD is executed only after user approval, and each ends with an infra-reviewer pass and its documentation deliverables.

PRD numbers are creation order and are never renumbered, so they do not always match execution order. In particular **0014 (database schema) is a prerequisite for 0009 (storage adapters + crypto)** — the schema must be reconciled and applied before 0009's adapters can integration-test. Execute **0014 → 0009**.

0008 is the first **application-code** PRD rather than an infrastructure one, and the first written *after* execution rather than before — a documented departure from the approval gate, noted at the top of the PRD itself. It creates no GCP resource and runs no billable command.
