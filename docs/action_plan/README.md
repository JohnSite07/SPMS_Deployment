# Action Plans (PRDs)

Plans of record written **before** executing substantial work — provisioning, pipeline stages, migrations, teardown. The governing rule (required sections, naming, approval gate) is [`.claude/rules/action-plan.md`](../../.claude/rules/action-plan.md); start new PRDs from [`_template.md`](_template.md).

A PRD must be **Approved** by the user before execution starts. Once executed, its status is set to `Done` and an Outcome note records what actually happened; the durable results live in the regular docs taxonomy (ADRs, deployment docs, runbooks).

## Index

| PRD | Title | Status |
| --- | --- | --- |
| [0001](0001-terraform-foundation.md) | Terraform Foundation & GCP Bootstrap | Draft |
