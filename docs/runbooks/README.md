# Runbooks

Step-by-step operational procedures, written to be followed under time pressure. Each runbook states its trigger, prerequisites, numbered steps, and how to verify success.

Available now:
- [Stop / start Cloud SQL](stop-start-cloud-sql.md) between work sessions to save credit.
- [Teardown](teardown.md) the environment (`terraform destroy`) after grading.
- [Cost check](cost-check.md) against the $300 budget.

Anticipated as the system is built further:
- Rotate a secret (add a new Secret Manager version, no redeploy) — PRD 0004 onward.
- Roll back a Cloud Run revision (re-point traffic) — PRD 0005 onward.
