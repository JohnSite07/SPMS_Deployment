# Action Plans (PRDs)

Plans of record written **before** executing substantial work — provisioning, pipeline stages, migrations, teardown. The governing rule (required sections, naming, approval gate) is [`.claude/rules/action-plan.md`](../../.claude/rules/action-plan.md); start new PRDs from [`_template.md`](_template.md).

A PRD must be **Approved** by the user before execution starts. Once executed, its status is set to `Done` and an Outcome note records what actually happened; the durable results live in the regular docs taxonomy (ADRs, deployment docs, runbooks).

## Index

| PRD | Title | Status |
| --- | --- | --- |
| [0001](0001-terraform-foundation.md) | Terraform Foundation & GCP Bootstrap | Done |
| [0002](0002-network-and-data.md) | Network & Data Layer (VPC, Cloud SQL, document bucket) | Draft |
| [0003](0003-iam-and-wif.md) | Identity: Service Accounts & Workload Identity Federation | Draft |
| [0004](0004-app-runtime.md) | Application Runtime: Artifact Registry, Secrets, Cloud Run | Draft |
| [0005](0005-cicd-pipeline.md) | CI/CD Pipeline & App Skeleton | Draft |
| [0006](0006-developer-handover.md) | Developer Team Handover Package | Draft |

Execution order: 0001 → 0002 → 0003 → 0004 → 0005 → 0006 (0002 and 0003 are independent of each other; the rest are sequential). Each PRD is executed only after user approval, and each ends with an infra-reviewer pass and its documentation deliverables.
