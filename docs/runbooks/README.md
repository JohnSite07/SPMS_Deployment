# Runbooks

Step-by-step operational procedures, written to be followed under time pressure. Each runbook states its trigger, prerequisites, numbered steps, and how to verify success.

Available now:
- [Stop / start Cloud SQL](stop-start-cloud-sql.md) between work sessions to save credit.
- [Teardown](teardown.md) the environment (`terraform destroy`) after grading.
- [Cost check](cost-check.md) against the $300 budget.
- [Roll back a Cloud Run revision](rollback.md) — manual traffic re-pointing, and re-running a failed CD run.
- [Rotate a secret](secret-rotation.md) — add a Secret Manager version and get running instances to pick it up.
- [Enable / flip back Cloud SQL public IP](db-public-access.md) — the temporary dev-phase toggle from [ADR 0005](../decisions/0005-temporary-public-ip-cloud-sql-dev-phase.md); flipping back to private is a required pre-presentation step.
- [Document storage smoke test](document-storage-smoke-test.md) — verify the runtime SA can write/read/delete in the document bucket (IAM-policy check + impersonation smoke test).
