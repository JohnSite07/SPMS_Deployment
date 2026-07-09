# 0007 — Temporary Public DB Access for the Development Phase

Give the Cloud SQL instance a public IP (proxy-only, IAM-gated) so developers get command-line/tooling access during development, via a reversible toggle that returns the instance to private before the final presentation.

| | |
| --- | --- |
| **Status** | Approved (2026-07-09 — user directed) |
| **Date** | 2026-07-09 |
| **Author** | DevOps (main session) |

## User story

As the Developer team, we want command-line access to the Cloud SQL database during development (so we can use a `mysql` client and AI tools like Claude Code against it, and run schema migrations from CI), and as the project owner I want that access removed before the graded presentation so the final state honours the "database is never publicly exposed" design.

## Scope

**In scope:**
- `enable_public_ip` boolean toggle (default `false`) on the Cloud SQL instance: `ipv4_enabled = var.enable_public_ip`, private_network unchanged (both IPs coexist).
- **No authorized networks** (empty) — the only access to the public IP is the IAM-authenticated Cloud SQL Auth Proxy; direct `mysql -h <ip>` is refused. This is the security gate.
- Set the toggle `true` in untracked tfvars for the development phase; apply.
- Verify the change is an **in-place update** (no instance recreate, no data loss).
- ADR recording the temporary deviation and the flip-back commitment; a runbook for flipping back; handover-guide DB section updated for the now-live proxy CLI flow (marked temporary).

**Out of scope:**
- Changing `ssl_mode` / requiring SSL (would impose an SSL requirement on the app's private-path connection — Developer-team code, not wired yet).
- Migration tooling itself (Developer-team; the public IP merely *unblocks* running migrations from CI — a separate PRD if we wire it).
- Any authorized-network allowlisting or 0.0.0.0/0 (explicitly forbidden — breaks the proxy-only gate).
- The developer IAM already has `cloudsql.client` + `serviceusage.serviceUsageConsumer` (PRD 0006), which is exactly what the proxy needs — no new IAM.

## Success criteria

- [ ] Plan with default (`false`) = **No changes**; plan with `true` = **in-place update (`~`), 0 destroy** on `google_sql_database_instance.mysql`.
- [ ] After apply: instance reports **both** a PRIVATE and a PUBLIC IP; `authorized_networks` empty; state `RUNNABLE`.
- [ ] Data intact: `securevault` database and `spms_app` user still present.
- [ ] Auth Proxy connects from a laptop (proven from the main session with owner ADC) and a `SELECT` succeeds; direct `mysql -h <public-ip>` is refused.
- [ ] `infra-reviewer`: no blockers (specifically confirms empty authorized networks + in-place update).
- [ ] Flip-back is a one-variable change, documented in a runbook.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `enable_public_ip` var + `ipv4_enabled` toggle | `google_sql_database_instance` update | ~a few cents/day for the public IPv4 while enabled |

References: [ADR 0004](../decisions/0004-human-db-access-cloud-sql-studio.md) (the private-only decision this temporarily and deliberately overrides) · Cloud SQL public IP + Auth Proxy docs.

## Scripts / commands

```bash
# verify non-destructive BEFORE applying
terraform -chdir=terraform plan                          # default false -> No changes
terraform -chdir=terraform plan -var enable_public_ip=true   # must be ~ in-place, 0 destroy

# enable for dev phase (set in untracked terraform.tfvars: enable_public_ip = true)
terraform -chdir=terraform apply

# verify
gcloud sql instances describe spms-mysql --format="json(ipAddresses,settings.ipConfiguration)"

# --- FLIP BACK before presentation ---
# set enable_public_ip = false in tfvars (or remove the line), then:
terraform -chdir=terraform apply    # in-place update, removes the public IP, data intact
```

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| Toggle + wiring | `terraform-engineer` | Variable, `ipv4_enabled` toggle, verify in-place plan | Code + plan proof |
| Review | `infra-reviewer` | Empty authorized networks, in-place update, no ssl surprise | Verdict |
| Apply + verify | main session | Enable in tfvars, apply, verify IPs + data + proxy CLI | Live public (proxy-only) |
| Docs | `documentation-keeper` | ADR (temporary deviation + flip-back commitment), flip-back runbook, handover DB section | ADR + runbook + guide |

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| Non-destructive | `plan -var enable_public_ip=true` | `~` in-place, 0 destroy |
| Both IPs present | `gcloud sql instances describe` after apply | PRIVATE + PUBLIC entries |
| Gate intact | inspect `ipConfiguration.authorizedNetworks` | empty/absent |
| Data intact | list databases/users via Studio or proxy | `securevault` + `spms_app` present |
| Proxy CLI works | run Auth Proxy + `SELECT 1` (owner ADC, from main session) | connects, returns |
| Direct refused | `mysql -h <public-ip>` without proxy | connection refused |
| Reviewer | `infra-reviewer` | no blockers |

## Additional considerations

- **Security posture:** the public IP is *not* public access — empty authorized networks means only IAM-authenticated proxy connections get in, identical trust model to the private path plus a network door the proxy can use. Still, this departs from the **letter** of the milestone's "never publicly exposed"; the ADR records it as a deliberate, time-boxed dev-phase measure with a committed flip-back.
- **Flip-back is the whole point:** before the presentation, `enable_public_ip = false` + apply returns the instance to private-only. Reversible, in-place, no data loss. The runbook makes this a checklist item so it isn't forgotten at grading time.
- **Unblocks CI migrations:** with the public IP, the GitHub Actions runner can reach Cloud SQL via the proxy — relevant to the open migration-path question, though wiring that is separate work.
- **Dependencies:** PRDs 0002 (instance) and 0006 (developer proxy IAM) done.

## Outcome

Executed 2026-07-09. `enable_public_ip` toggle added (default false); set true in untracked tfvars; applied as an **in-place update** (`0 add, 1 change, 0 destroy` — instance never recreated, no data loss). infra-reviewer verdict pre-apply: safe, empty-authorized-networks gate confirmed. Verified post-apply: instance has both a PRIMARY (public) and PRIVATE IP, `authorizedNetworks` absent, state RUNNABLE, `securevault` DB and `spms_app` user intact. **Proxy path proven**: the Cloud SQL Auth Proxy connected over the new public IP and reached MySQL (previously impossible against the private-only instance). Committed code keeps the default `false`, so the repo's default state stays private; the live "on" state lives only in untracked tfvars. ADR 0005, flip-back runbook, and the handover DB section delivered.

**Follow-up finding (separate from this PRD, needs a decision):** the proxy connection could not authenticate as `spms_app` with the `db-password` secret. Diagnosis: the Terraform-managed `google_sql_user.app` was created with **`host = null`** (blank host), while a developer created a separate **`spms_app@%`** with an unknown password out-of-band (plus a personal `kulsum` user). A proxy/connector connection presents as a remote host and matches `@%`, not the blank-host account — so the app user as provisioned likely cannot authenticate over the proxy **or from Cloud Run**. This is a latent data-module bug (app user should be `host = "%"`), entangled with the dev-created user; fixing it means a user replace that collides with the dev-created `spms_app@%`, so it requires coordination with the developer before overwriting/removing their user. Tracked for a follow-up fix.
