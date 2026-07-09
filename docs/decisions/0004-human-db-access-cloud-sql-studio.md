# 0004 — Human database access: Cloud SQL Studio, not a network path

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** Secure Vault Group (Deployment & DevOps lead: Jean Luc Sita Mbuya)

## Context

The Cloud SQL instance is private-IP-only (see [architecture/overview.md](../architecture/overview.md) and [ADR 0001](0001-platform-and-tooling.md)) — Cloud Run reaches it over the VPC via Direct VPC egress, and the M4 deployment boundary states the DB is never publicly exposed. [PRD 0006](../action_plan/0006-developer-handover.md) originally planned human access via the Cloud SQL Auth Proxy, following the standard pattern documented by Google.

A developer dry run of that plan failed. The Auth Proxy **authenticates** a connection; it does not create network reachability. It dials either the instance's public IP (which does not exist on this instance, by design) or, with `--private-ip`, the instance's VPC-internal address — which a laptop outside the VPC cannot route to regardless of how well-authenticated it is. The live failure was:

```
instance does not have IP of type "PUBLIC"
```

This is a structural mismatch, not a misconfiguration: no amount of ADC/IAM setup makes the proxy work against a private-only instance from an unrouted network. A real decision was needed on how humans (not the running app) inspect the cloud database.

## Decision

**The instance stays private-IP-only.** Human inspection of the cloud database happens through **Cloud SQL Studio** in the GCP console — a console-served SQL editor that reaches private instances without requiring the caller's network to route to the VPC. Access is gated by `roles/cloudsql.studioUser`, granted to the developer Google Group (`developer_group` var) alongside the existing developer role set, plus the DB credentials themselves (fetched from Secret Manager as usual). This has already been applied in [terraform/modules/iam/main.tf](../../terraform/modules/iam/main.tf) (`developer_project_roles`), which carries a forward-reference comment to this ADR.

**Day-to-day development runs against a local MySQL instance** (e.g. Docker, `mysql:8.0` to match the cloud instance's major version — see the MySQL 8.0-not-8.4 substitution noted in [action_plan/0002-network-and-data.md's Outcome](../action_plan/0002-network-and-data.md#outcome) and [guides/developer-handover.md](../guides/developer-handover.md)), with the app's own DDL applied locally. The deployed app on Cloud Run is unaffected either way — it still reaches the real instance over the VPC via Direct VPC egress, and the env-var contract (`DB_HOST`, `DB_PORT`, etc.) is unchanged.

## Alternatives considered

- **Public IP with zero authorized networks.** This is Google's conventional development pattern (the proxy dials a public endpoint but the connection is still IAM/TLS-gated, so an empty authorized-networks list keeps it closed to the raw internet). In practice access control is IAM-only, not network-only. Rejected: it satisfies the *practical* security bar but violates the *letter* of the stated deployment boundary this milestone is graded on — "the DB is never publicly exposed" — and that boundary is explicit in the M4 design and this repo's architecture docs. Not worth the grading and posture risk for a convenience the alternative below also provides.
- **Bastion host / VPN into the VPC.** Would let the Auth Proxy's `--private-ip` mode work as designed. Rejected: an always-on (or at least regularly-provisioned) compute resource and its own IAM/SSH surface is real ongoing cost and operational burden, directly against the project's cheap-and-disposable, scale-to-zero posture (see `CLAUDE.md`) — disproportionate for a single-operator academic project's occasional inspection needs.

## Consequences

- **No laptop can open a raw MySQL client/driver connection to the cloud instance, ever, under this design.** Anything that needs a real wire-level connection — the running application, ad hoc scripting against live data, a future migration tool — must run inside the VPC (Cloud Run, or a future Cloud Run Job/Cloud Build step), not on a developer machine.
- Human cloud-DB inspection (including `TC-SEC-*` ciphertext-at-rest checks from the M4 test plan) goes through Cloud SQL Studio, which is a console UI, not a `mysql` CLI session — query history and result export work differently than a local client. See [guides/developer-handover.md](../guides/developer-handover.md#database-access) for the exact steps.
- Local development is now the default day-to-day workflow, not a fallback: developers run their own MySQL locally and apply the schema themselves, matching the cloud instance's major version (8.0) to avoid version-specific DDL surprises.
- The Auth Proxy instructions and the `--private-ip` variant are no longer part of any supported workflow for this instance; the historical proxy-based plan in [PRD 0006](../action_plan/0006-developer-handover.md) reflects the pre-dry-run intent and is left as-is (an executed PRD's record of what was planned and found), superseded in practice by this ADR.
- If a future need requires scripted/automated access to the live instance from outside the VPC (not just human console inspection), it will need its own decision — the options above (public IP, bastion/VPN) remain available to reconsider then, with their trade-offs unchanged.

> **Update — 2026-07-09:** exactly that need materialized (CLI/AI-assisted dev work and CI-run migrations). [ADR 0005](0005-temporary-public-ip-cloud-sql-dev-phase.md) temporarily overrides the private-only decision above for the development phase, via a reversible toggle, gated by empty authorized networks so it stays IAM-proxy-only. This ADR is not superseded — it is the state ADR 0005 reverses back to before the graded presentation.

## Related

- [architecture/overview.md](../architecture/overview.md) — private-IP-only DB, Direct VPC egress.
- [guides/developer-handover.md](../guides/developer-handover.md#database-access) — the operational how-to this decision drives.
- [terraform/modules/iam/main.tf](../../terraform/modules/iam/main.tf) — `roles/cloudsql.studioUser` grant, forward-referencing this ADR.
- [action_plan/0006-developer-handover.md](../action_plan/0006-developer-handover.md) — the original (pre-dry-run) handover PRD this ADR supersedes in practice.
- [ADR 0005](0005-temporary-public-ip-cloud-sql-dev-phase.md) — the temporary, reversible dev-phase override of this decision.
