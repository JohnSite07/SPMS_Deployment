# Runbooks

Step-by-step operational procedures, written to be followed under time pressure. Each runbook states its trigger, prerequisites, numbered steps, and how to verify success.

Anticipated runbooks as the system is built:
- Tear down the environment (`terraform destroy`) after grading.
- Stop / start Cloud SQL between work sessions to save credit.
- Rotate a secret (add a new Secret Manager version, no redeploy).
- Roll back a Cloud Run revision (re-point traffic).
- Check spend against the $300 budget.
