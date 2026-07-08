# Stop / start Cloud SQL

The #1 cost lever for this project: Cloud SQL compute (`spms-mysql`, `db-f1-micro`) accrues roughly **$0.33/day while running**. Stop it between work sessions; start it before you need the app to reach the database.

Related: [Cost check](cost-check.md) · [Teardown](teardown.md) · [ADR — platform and tooling](../decisions/0001-platform-and-tooling.md) · instance defined in [terraform/modules/data/variables.tf](../../terraform/modules/data/variables.tf) (`instance_name` default `spms-mysql`).

Everywhere below, `<PROJECT_ID>` is a placeholder — the real value lives only in untracked `terraform/terraform.tfvars` (see [gcp-setup.md](../deployment/gcp-setup.md)).

## When to use

- End of a dev/demo session: stop it so idle time doesn't bill.
- Before a dev/demo session, or before running the app / integration tests against a live DB: start it and wait for it to report `RUNNABLE`.
- Do **not** stop it mid-deploy — the CD pipeline's smoke test needs a live DB connection.

## Check current state

```bash
gcloud sql instances describe spms-mysql --project=<PROJECT_ID> \
  --format="value(state,settings.activationPolicy)"
```

- `RUNNABLE` / `ALWAYS` — instance is up and billing for compute.
- `STOPPED` / `NEVER` — instance is stopped, not billing for compute.

## Stop

```bash
gcloud sql instances patch spms-mysql --project=<PROJECT_ID> \
  --activation-policy=NEVER
```

Confirm with the state check above — expect `STOPPED` / `NEVER` within a minute or two.

## Start

```bash
gcloud sql instances patch spms-mysql --project=<PROJECT_ID> \
  --activation-policy=ALWAYS
```

Startup takes a minute or two. Poll the state check until it reports `RUNNABLE` before pointing the app at it — connections attempted while it's still transitioning will fail.

## What stopping does and doesn't save

- **Saves:** the compute charge for the running instance (~$0.33/day) — this is the bulk of the project's ongoing spend per [PRD 0002](../action_plan/0002-network-and-data.md).
- **Does not save:** the 10 GB SSD disk and automated backups (7 daily backups + binary-log PITR, per [terraform/modules/data/main.tf](../../terraform/modules/data/main.tf)) keep billing at their own (much smaller, pennies-scale) rate whether the instance is running or stopped. Only `terraform destroy` (see [teardown.md](teardown.md)) removes those.

## Impact while stopped

- The private IP is unreachable — Cloud Run cannot open a DB connection. Any request path that touches the database returns a 5xx from the app; static/non-DB paths (if any) are unaffected.
- Terraform is unaware of activation policy drift: it doesn't manage stop/start state, so `terraform plan` should show no diff from stopping/starting via `gcloud`. Don't "fix" this by running `terraform apply` — that's not what changed.
