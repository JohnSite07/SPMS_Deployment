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

Execution order: 0001 → 0002 → 0003 → 0004 → 0005 → 0006 (0002 and 0003 are independent of each other; the rest are sequential). Each PRD is executed only after user approval, and each ends with an infra-reviewer pass and its documentation deliverables.

0008 is the first **application-code** PRD rather than an infrastructure one, and the first written *after* execution rather than before — a documented departure from the approval gate, noted at the top of the PRD itself. It creates no GCP resource and runs no billable command.
