# 0005 — Temporary public IP on Cloud SQL for the development phase

- **Status:** Accepted (temporary override — reversed before the graded presentation)
- **Date:** 2026-07-09
- **Deciders:** Secure Vault Group (Deployment & DevOps lead: Jean Luc Sita Mbuya)

## Context

[ADR 0004](0004-human-db-access-cloud-sql-studio.md) settled human database access on Cloud SQL Studio plus local MySQL, after a dry run proved the Cloud SQL Auth Proxy cannot reach a private-IP-only instance from a laptop outside the VPC. That decision holds for occasional console inspection, but the Developer team's day-to-day workflow needs more than that:

- CLI/AI-assisted development (running `mysql` directly, and AI tools such as Claude Code, against a live schema) needs a wire-level connection Cloud SQL Studio's console UI doesn't provide.
- CI-run schema migrations need the GitHub Actions runner to open a real connection to Cloud SQL, which a private-only instance cannot offer to a runner outside the VPC.

The Auth Proxy authenticates a connection; it does not by itself create network reachability. Against a private-only instance, `--private-ip` requires the caller to already be routed into the VPC, which neither a developer laptop nor a GitHub-hosted runner is. The instance needs a public IP for the proxy to dial — the open question is how to do that without genuinely exposing the database, given the M4 deployment boundary's "the DB is never publicly exposed" posture.

[PRD 0007](../action_plan/0007-temporary-public-db-access.md) is the plan of record this ADR documents the decision from; it has been executed as an in-place Terraform update, no data loss.

## Decision

**Enable a public IPv4 address on the Cloud SQL instance for the development phase only, gated by an empty `authorized_networks` list**, via the `enable_public_ip` Terraform variable (`terraform/variables.tf:35`, default `false`, wired through `terraform/main.tf:37` to `terraform/modules/data/main.tf:30`'s `ipv4_enabled`).

With a public IP and zero authorized networks, the instance is **proxy-only / IAM-authenticated, not genuinely exposed**: the Cloud SQL Auth Proxy dials the public endpoint and then must still authenticate via IAM before Cloud SQL will accept the connection, but a direct `mysql -h <public-ip>` is refused outright — there is no network entry for raw traffic. This is the same alternative ADR 0004 evaluated and rejected on the letter of the deployment boundary; it is adopted here explicitly as a **time-boxed dev-phase deviation**, not a reversal of that reasoning.

The private VPC path Cloud Run uses is unchanged — `private_network` stays wired unconditionally in `terraform/modules/data/main.tf:31`, so both IPs coexist and the app's env-var contract (`DB_HOST`, etc.) does not move. Toggling is a single boolean, set to `true` only in untracked `terraform/terraform.tfvars` (never in code, never committed), applied as an **in-place update** — confirmed no instance recreate, no data loss.

**This ADR does not supersede ADR 0004.** ADR 0004 remains the accepted design for human console access and the presentation-time end state; this ADR is a temporary, explicitly reversible override of it for the development window, reversed via the same toggle before the graded presentation (see [runbooks/db-public-access.md](../runbooks/db-public-access.md)).

## Alternatives considered

- **Keep private-only (do nothing).** Preserves the letter of ADR 0004 and the M4 boundary but blocks the actual need: no CLI/AI-assisted access to a live schema, and CI cannot reach the instance to run migrations. Rejected as unworkable for the development phase, not because the reasoning in ADR 0004 was wrong for its own scope (occasional human inspection).
- **Public IP with authorized networks (e.g. developers' home/office IPs, or `0.0.0.0/0`).** Would also unblock the proxy, but authorized networks gate on source IP, not identity — a genuinely open (or address-fragile, constantly-changing-IP) network door. This is real exposure, not the IAM-gated pattern this ADR relies on. Rejected outright, and the Terraform variable description and inline comments (`terraform/modules/data/main.tf:22-28`) explicitly warn against adding one.
- **Bastion host / VPN into the VPC.** Would let the Auth Proxy's `--private-ip` mode work as ADR 0004 originally intended, without any public IP at all. Rejected for the same reason ADR 0004 rejected it: an always-on (or regularly-provisioned) compute resource and its own IAM/SSH surface is ongoing cost and operational burden disproportionate to a single-operator academic project's dev-phase needs, and it wouldn't solve the CI-runner reachability problem either without its own network bridging.

## Consequences

- **Small, bounded cost:** a public IPv4 address on Cloud SQL bills at roughly a few cents/day while enabled — negligible against the $300 budget, but not zero, so it should not be left on indefinitely (see [runbooks/db-public-access.md](../runbooks/db-public-access.md)).
- **A required flip-back step before grading.** `enable_public_ip` must be set back to `false` (or the tfvars line removed) and applied before the graded presentation, returning the instance to private-only — the state ADR 0004 and the M4 design describe. This is tracked as a pre-presentation checklist item in [runbooks/db-public-access.md](../runbooks/db-public-access.md); missing it means presenting a deployment that doesn't match its own documented boundary.
- **The security posture during the dev phase is "IAM-gated, one network door for the proxy," not "open."** No `authorized_networks` entry exists, so raw TCP/mysql clients cannot reach the instance regardless of source IP; only Cloud SQL Auth Proxy sessions that first authenticate via IAM succeed. This is a materially different (and much narrower) exposure than a conventional public database, but it is a deviation from ADR 0004's "no laptop can open a raw connection, ever" consequence for the duration it's enabled.
- **Unblocks the open CI-migration question.** With the public IP live, a GitHub Actions runner can reach Cloud SQL via the proxy — wiring that into `ci.yml`/`cd.yml` is separate, not-yet-scoped work; this ADR only removes the network blocker.
- Cloud SQL Studio and local MySQL (ADR 0004's access paths) remain fully valid and are the paths that continue to work after the flip-back — this ADR adds a temporary third path, it doesn't replace the other two.

## Related

- [ADR 0004](0004-human-db-access-cloud-sql-studio.md) — the private-only decision this ADR temporarily overrides; see its Consequences section for what resumes once this ADR is reversed.
- [PRD 0007](../action_plan/0007-temporary-public-db-access.md) — the plan of record this decision was executed under (scope, success criteria, verification).
- [runbooks/db-public-access.md](../runbooks/db-public-access.md) — enable / flip-back operational steps, including the pre-presentation checklist.
- [guides/developer-handover.md](../guides/developer-handover.md#database-access) — updated developer-facing instructions for the now-available proxy CLI flow.
- `terraform/variables.tf:35`, `terraform/main.tf:37`, `terraform/modules/data/main.tf:22-32`, `terraform/modules/data/variables.tf:78-82` — the toggle in code.
