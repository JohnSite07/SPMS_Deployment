# 0002 — Network & Data Layer

Provision the private network path and the stateful backbone: VPC, Cloud SQL (MySQL, private IP), the document bucket, and the database credentials secret.

| | |
| --- | --- |
| **Status** | Draft |
| **Date** | 2026-07-08 |
| **Author** | DevOps (main session) |

## User story

As the DevOps team, I want the VPC, a private-IP Cloud SQL instance, and the document bucket provisioned through Terraform, so that the application has its data layer ready — never publicly exposed — before any compute or pipeline work begins.

## Scope

**In scope:**
- `modules/network/`: custom-mode VPC, one regional subnet (for Cloud Run Direct VPC egress), Private Services Access (reserved `/16` range + `google_service_networking_connection`) for Cloud SQL private IP.
- `modules/data/`: Cloud SQL instance (MySQL 8.4, `db-f1-micro`, 10 GB SSD, **private IP only**, `ipv4_enabled = false`, automated daily backups + PITR), `google_sql_database` (app schema), `google_sql_user` (app login).
- Document bucket (`google_storage_bucket`, uniform access, lifecycle rule expiring noncurrent/old objects) — provisioned now per design; whether the app uses it vs. `LONGBLOB` is the Developer team's open decision.
- DB credentials into Secret Manager (`modules/secrets/`, first two secrets): `db-user`, `db-password` (password generated in Terraform via `random_password`, stored as a secret version, marked `sensitive` — never output in plans/logs).

**Out of scope:**
- Service accounts, IAM bindings, WIF — PRD 0003.
- Cloud Run, Artifact Registry, remaining secrets (JWT/AES/SMTP) — PRD 0004.
- Any firewall/LB work beyond what Cloud Run Direct VPC egress needs (none — Cloud Run has no inbound VPC presence).

## Success criteria

- [ ] `terraform plan`: adds only the resources above, **0 destroys**; `apply` completes.
- [ ] Cloud SQL instance reports `PRIVATE` IP only — no public address assigned.
- [ ] Connectivity: `gcloud sql instances describe` shows the PSA connection to the VPC; DB unreachable from the public internet.
- [ ] Document bucket exists with uniform access + lifecycle rule.
- [ ] `db-password` secret version exists; value never appears in plan output or state output.
- [ ] `infra-reviewer`: no blockers (checks private IP, tier, region, destroyability).

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| VPC + subnet + PSA range | `google_compute_network/_subnetwork/_global_address`, `google_service_networking_connection` | $0 (no connector, no NAT) |
| Cloud SQL instance | `google_sql_database_instance` (db-f1-micro, 10 GB) | **~$9–10/mo** — largest line; stoppable between sessions |
| DB + user | `google_sql_database`, `google_sql_user` | $0 |
| Document bucket | `google_storage_bucket` + lifecycle | ~$0.10/mo at demo scale |
| DB secrets (2) | `google_secret_manager_secret(_version)`, `random_password` | ~$0.12/mo |

References: [architecture/overview.md](../architecture/overview.md) (private path, Direct VPC egress rationale) · provider docs for `sql_database_instance` PSA prerequisites.

## Scripts / commands

```bash
terraform -chdir=terraform fmt -check -recursive && terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=tfplan     # review: expect ~10-12 adds, 0 destroys
terraform -chdir=terraform apply tfplan          # BILLABLE (~$10/mo starts); after approval; SQL creation takes ~10 min

# verification
gcloud sql instances describe spms-mysql --format="value(ipAddresses)"   # expect PRIVATE only
gcloud storage buckets describe gs://<PROJECT_ID>-spms-documents
```

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| Write network + data + secret resources | `terraform-engineer` | Modules per scope; fmt/validate; plan summary | Code + plan for review |
| Pre-apply review | `infra-reviewer` | Audit diff + plan (private IP, tier, lifecycle, no plaintext) | Verdict |
| Apply + verify | main session | Run apply after approval; run verification commands | Live data layer |
| Docs | `documentation-keeper` | Runbook: **stop/start Cloud SQL** (the #1 cost lever); update deployment docs | Runbook + docs |

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| Plan clean | read plan summary | expected adds, 0 destroys |
| Private IP only | `gcloud sql instances describe` | no `PRIMARY` public IP entry |
| Bucket + lifecycle | `gcloud storage buckets describe` | uniform access on; lifecycle rule present |
| Secret stored, not leaked | `gcloud secrets versions list db-password`; grep plan output | version exists; no plaintext anywhere |
| Backups on | instance describe | `backupConfiguration.enabled: true`, PITR on |
| Review pass | `infra-reviewer` | no blockers |

## Additional considerations

- **Security posture:** DB reachable only via VPC (PSA); app user is least-privilege on its schema (no admin grants; append-only enforcement for `AUDIT_ENTRIES` is a Developer-team schema concern noted in the handover).
- **Rollback / teardown:** all resources die under `terraform destroy`; `deletion_protection = false` on the SQL instance (deliberate — disposable environment). PSA connections can order-fail on destroy; note in teardown runbook.
- **Cost control:** from the moment of apply, ~$0.33/day accrues. The stop/start runbook (this PRD's doc deliverable) is mandatory before marking Done.
- **Open questions:** none beyond 0001's project inputs.
- **Dependencies:** PRD 0001 Done (APIs incl. `servicenetworking`, backend, budget alert active).

## Outcome

_Pending execution._
