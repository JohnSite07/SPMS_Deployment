# Enable / flip back Cloud SQL public IP (dev-phase toggle)

Operational steps for the temporary, reversible public IP on the Cloud SQL instance — see [ADR 0005](../decisions/0005-temporary-public-ip-cloud-sql-dev-phase.md) for why this exists and [ADR 0004](../decisions/0004-human-db-access-cloud-sql-studio.md) for the private-only design it temporarily overrides. Source of truth for the toggle: `terraform/variables.tf:35` (`enable_public_ip`, default `false`), wired through `terraform/main.tf:37` to `terraform/modules/data/main.tf:30`.

Everywhere below, `<PROJECT_ID>` is a placeholder — the real value lives only in untracked `terraform/terraform.tfvars` (see [gcp-setup.md](../deployment/gcp-setup.md)).

## When to use

- **Enable**, during the development phase, when the Developer team needs a CLI/`mysql`-level connection to the live instance (AI-assisted tooling, ad hoc queries, or CI-run migrations) that Cloud SQL Studio's console UI can't provide.
- **Flip back to private, before the graded presentation** — this is the important half of this runbook and must not be skipped. Treat it as a pre-presentation checklist item, not an optional cleanup step.

Both directions are a single Terraform variable, applied as an **in-place update** — no instance recreate, no data loss, in either direction.

## Prerequisites

- Terraform is already initialized against this project's state (`terraform -chdir=terraform init`).
- You can run `terraform apply` against the project (standard operator/DevOps access — this is not something a developer without Terraform access should do themselves; developers only consume the resulting proxy access, see [guides/developer-handover.md](../guides/developer-handover.md#database-access)).

## Procedure 1 — Enable (dev phase)

1. In untracked `terraform/terraform.tfvars`, set:
   ```hcl
   enable_public_ip = true
   ```
2. Apply:
   ```bash
   terraform -chdir=terraform apply
   ```
   Expect a **single in-place update (`~`)** on `google_sql_database_instance.mysql` — no destroy, no replace. If the plan shows anything else (a destroy/recreate, an `authorized_networks` change, an `ssl_mode`/`require_ssl` change), stop and investigate before confirming — none of those are expected from this toggle.
3. Verify:
   ```bash
   gcloud sql instances describe spms-mysql --project=<PROJECT_ID> \
     --format="json(ipAddresses,settings.ipConfiguration)"
   ```
   Expect:
   - `ipAddresses` contains **two entries**: one `type: PRIMARY` (the new public IPv4) and one `type: PRIVATE` (unchanged).
   - `settings.ipConfiguration.ipv4Enabled` is `true`.
   - `settings.ipConfiguration.authorizedNetworks` is **absent or empty** — this is the gate. If it is non-empty, the instance is genuinely exposed, not proxy-only; stop and fix before treating the instance as safe to use (see [ADR 0005](../decisions/0005-temporary-public-ip-cloud-sql-dev-phase.md) — an authorized-networks entry was explicitly rejected as an alternative).

Once verified, tell the Developer team the proxy CLI flow is live — see the "Developer access model while public" section below and [guides/developer-handover.md](../guides/developer-handover.md#database-access) for the exact commands.

## Procedure 2 — Flip back to private (do this before the presentation)

**This is the step that matters most.** The dev-phase public IP is a deliberate, time-boxed deviation from ADR 0004 — it must be reversed before the graded presentation so the deployed state matches the documented "database is never publicly exposed" boundary.

1. In `terraform/terraform.tfvars`, set the variable back to its code default (or remove the line entirely — `false` is the default):
   ```hcl
   enable_public_ip = false
   ```
2. Apply:
   ```bash
   terraform -chdir=terraform apply
   ```
   Again expect a single **in-place update (`~`)**, no destroy, no replace, no data loss — Terraform removes the public IP and leaves the private IP, the database, and all data untouched.
3. Verify:
   ```bash
   gcloud sql instances describe spms-mysql --project=<PROJECT_ID> \
     --format="json(ipAddresses,settings.ipConfiguration)"
   ```
   Expect **only one entry** in `ipAddresses`, `type: PRIVATE`, and `settings.ipConfiguration.ipv4Enabled` is `false`.
4. Confirm data survived (e.g. via Cloud SQL Studio — see [ADR 0004](../decisions/0004-human-db-access-cloud-sql-studio.md)): the `securevault` database and `spms_app` user are still present.

### Pre-presentation checklist

- [ ] `enable_public_ip = false` (or removed) in `terraform/terraform.tfvars`
- [ ] `terraform apply` run, plan showed in-place update only
- [ ] `gcloud sql instances describe` shows a single `PRIVATE` IP, no `PRIMARY`/public entry
- [ ] Cloud SQL Studio confirms `securevault` database and `spms_app` user intact
- [ ] Developer team notified the CLI proxy flow is gone again — Cloud SQL Studio + local MySQL ([ADR 0004](../decisions/0004-human-db-access-cloud-sql-studio.md)) is the path for the presentation window

## Developer access model while public

While `enable_public_ip = true`, the supported path is the **Cloud SQL Auth Proxy under the developer's own `gcloud` identity** — not a raw `mysql -h <public-ip>` connection, which is refused (empty `authorized_networks`). Developers already have `roles/cloudsql.client` and `roles/serviceusage.serviceUsageConsumer` from the developers Google Group (see [PRD 0006](../action_plan/0006-developer-handover.md)), which is exactly what the proxy needs — no additional IAM grant is required for this. Full commands are in [guides/developer-handover.md](../guides/developer-handover.md#database-access).

## Related

- [ADR 0005](../decisions/0005-temporary-public-ip-cloud-sql-dev-phase.md) — why this toggle exists, its scope, and its consequences.
- [ADR 0004](../decisions/0004-human-db-access-cloud-sql-studio.md) — the private-only design this is a temporary override of, and the presentation-time end state.
- [PRD 0007](../action_plan/0007-temporary-public-db-access.md) — the plan of record this was executed under.
- [guides/developer-handover.md](../guides/developer-handover.md#database-access) — developer-facing proxy CLI instructions.
- [runbooks/stop-start-cloud-sql.md](stop-start-cloud-sql.md) — the instance's compute stop/start lever is unaffected by this toggle; both apply independently.
