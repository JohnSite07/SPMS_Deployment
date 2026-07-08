# Cost check

Quick daily/weekly spend sanity check against the $300 free-trial credit. Takes under a minute.

Related: [Stop/start Cloud SQL](stop-start-cloud-sql.md) · [Teardown](teardown.md) · [terraform/main.tf](../../terraform/main.tf) (budget resource) · [PRD 0001 outcome](../action_plan/0001-terraform-foundation.md#outcome) (budget currency note)

Everywhere below, `<PROJECT_ID>` and `<BILLING_ACCOUNT_ID>` are placeholders — real values live only in untracked `terraform/terraform.tfvars` (see [gcp-setup.md](../deployment/gcp-setup.md)).

## Where to look

- **Console:** Billing > Reports, filtered to this project — gives a running daily/monthly breakdown by service.
- **Budget alerts:** Billing > Budgets & alerts — the Terraform-managed `google_billing_budget` (see [terraform/main.tf](../../terraform/main.tf)) fires at 50/90/100% of the budget amount.
- **CLI, quick project-level check:**

```bash
gcloud billing projects describe <PROJECT_ID>
gcloud billing budgets list --billing-account=<BILLING_ACCOUNT_ID>
```

## What normal looks like

- **Cloud SQL running:** ~$0.33/day (the dominant line — see [stop-start-cloud-sql.md](stop-start-cloud-sql.md)).
- **Cloud SQL stopped:** ~$0/day for compute; the 10 GB disk and backups still bill at a pennies-scale rate regardless of activation policy.
- Everything else in the estate (VPC/PSA, document bucket, Secret Manager secrets, state bucket) is $0–low-cents per month at demo scale — see the cost table in [PRD 0002](../action_plan/0002-network-and-data.md#resources).

## Budget alert thresholds

The budget is **300 units in the billing account's own currency** — not necessarily USD. This account's currency is CAD (recorded in [PRD 0001's outcome](../action_plan/0001-terraform-foundation.md#outcome)), so the budget alerts at 300 CAD, which is a lower real-money ceiling than 300 USD — conservative, not a bug. Alerts fire at:

- 50% of budget
- 90% of budget
- 100% of budget

Alerts land wherever the billing account's notification channels are configured (typically the billing admin's email) — this repo does not manage notification channels, only the threshold rules.

## If spend spikes, check these three things first

1. **Cloud SQL running when it shouldn't be** — run the state check in [stop-start-cloud-sql.md](stop-start-cloud-sql.md#check-current-state). Left running across sessions, this is the most common cause of unexpected spend.
2. **Cloud Run `min-instances` raised above 0** — `min-instances=1` keeps an instance always warm and always billing; per [CLAUDE.md](../../CLAUDE.md) conventions this should only ever be a deliberate, temporary demo-window setting, not a forgotten default.
3. **Resources created outside Terraform** — anything clicked together by hand in the console won't show up in `terraform plan`/`state`. Sweep for it:

```bash
gcloud asset search-all-resources --scope=projects/<PROJECT_ID>
```

Cross-check the result against what `terraform state list` (run from `terraform/`) says should exist; anything extra is drift to investigate and either import or delete.
