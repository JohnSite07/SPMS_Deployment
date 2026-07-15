# 0016 — SMTP Provisioning for Password-Reset Email (DevOps hand-off)

Provision the outbound-email path so the password-reset flow (PRD [0015](0015-password-reset-flow.md)) can actually send its reset links. This is a **DevOps-executed** change — it touches `terraform/` and Secret Manager, both DevOps-owned. The application code is already deploy-safe and needs **no** change: it auto-enables the reset routes the moment this config is present.

| | |
| --- | --- |
| **Status** | Draft (awaiting DevOps) |
| **Date** | 2026-07-13 |
| **Author** | Developer team (feature: Login & Reset), for the DevOps team |

## User story

As the DevOps engineer, I want to wire a real SMTP provider and the reset-link base URL into the Cloud Run service, so that the already-shipped password-reset feature can send single-use reset links to users instead of returning `503`.

## Background — why this is a clean, low-risk change

The reset feature (PRD 0015) is merged/deployable with a **deploy-safe lazy config**: [`app/src/config/password-reset-config.js`](../../app/src/config/password-reset-config.js) validates the SMTP config **on first use, not at startup**. So today the service boots normally and `/api/password-reset/*` simply answers **`503`** ("service_unavailable") because the config is incomplete. Once the four env values below are present, the routes go live **with no code change or redeploy of application logic** — only the infra change and a new revision.

The app requires five values ([`REQUIRED_VARS`](../../app/src/config/password-reset-config.js)): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `APP_BASE_URL`. Current state:

| Value | Type | Status today |
| --- | --- | --- |
| `SMTP_USERNAME` | secret-ref | **Placeholder** in `smtp-username` (`PLACEHOLDER-set-real-value-via-rotation`) |
| `SMTP_PASSWORD` | secret-ref | **Placeholder** in `smtp-password` (same) |
| `SMTP_HOST` | plain env | **Not injected** |
| `SMTP_PORT` | plain env | **Not injected** |
| `APP_BASE_URL` | plain env | **Not injected** |

## Scope

**In scope (DevOps):**
- **Choose a transactional SMTP provider** that fits the $300-budget posture (free tier is ample — reset email is low-volume). E.g. a provider offering a free tier of a few hundred emails/day.
- **Rotate the two SMTP secrets** (`smtp-username`, `smtp-password`) to the provider's real credentials, via the [secret-rotation runbook](../runbooks/secret-rotation.md) (add a new version; no code change).
- **Add three plain env vars** to the Cloud Run service in `terraform/modules/app/` (+ root wiring): `SMTP_HOST`, `SMTP_PORT` (e.g. `587`), and `APP_BASE_URL` (the real HTTPS service URL, supplied privately at apply time per the docs policy — it is not committed to git).
- **Deploy a new revision** (`terraform apply` + the normal CD deploy) so the container picks up the new env vars and the rotated secret versions (secrets resolve at instance start, not continuously).
- **Verify** the routes are enabled and a real email is delivered end-to-end.

**Out of scope:**
- **Application code** — none changes. The lazy config, routes, `EmailService` (nodemailer), and token store already exist (PRD 0015).
- **The DB migrations** (`0002_reconcile_*` from PRD 0014, `0003_password_reset_tokens` from PRD 0015) — a *separate* DB-admin task, but note it's a **hard dependency for the flow to fully work** (see Dependencies). SMTP alone makes `/request` send an email; the `/confirm` step needs the reset-token table.
- **Custom domain / SPF·DKIM tuning** beyond what the provider requires for basic deliverability — a follow-up if reset emails land in spam.

## Success criteria

- [ ] `smtp-username` and `smtp-password` each have a new, **non-placeholder** latest version (`gcloud secrets versions list …`).
- [ ] The running Cloud Run service exposes `SMTP_HOST`, `SMTP_PORT`, and `APP_BASE_URL` (`gcloud run services describe spms --format=…`).
- [ ] Container logs show **no** `password reset disabled: …` warning at startup (the config now loads).
- [ ] `POST https://<service-url>/api/password-reset/request` with a test email returns **`200 { ok: true }`** (not `503`).
- [ ] A **real reset email is delivered** to a test inbox, and its link points at `https://<service-url>/reset-password?token=…`.
- [ ] End-to-end (once the DB migrations are also applied): clicking the link and submitting a new password logs the user in with the new password.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| SMTP provider account | External (new) | **$0** — free transactional tier |
| `smtp-username` / `smtp-password` | Secret Manager (existing) — rotate versions | $0 |
| `SMTP_HOST` / `SMTP_PORT` / `APP_BASE_URL` env | `terraform/modules/app/main.tf` (+ variables, root wiring) — DevOps-owned | $0 (plain env; no new GCP resource) |
| New Cloud Run revision | Existing service — redeploy | $0 (scale-to-zero unchanged) |

References:
- App contract: [`app/src/config/password-reset-config.js`](../../app/src/config/password-reset-config.js) (the five required vars + `RESET_TOKEN_TTL_MINUTES`, default 30).
- Feature: PRD [0015](0015-password-reset-flow.md); reset routes [`app/src/routes/password-reset.js`](../../app/src/routes/password-reset.js); email service [`app/src/services/email-service.js`](../../app/src/services/email-service.js).
- Secret rotation: [runbooks/secret-rotation.md](../runbooks/secret-rotation.md). Env contract: [developer-handover](../guides/developer-handover.md#env-contract), [terraform/modules/app/main.tf](../../terraform/modules/app/main.tf).

## Scripts / commands (DevOps runs)

```bash
# 1. Rotate the SMTP secrets to the provider's real credentials (see runbook).
printf '%s' "<provider-smtp-username>" | gcloud secrets versions add smtp-username --data-file=-
printf '%s' "<provider-smtp-password>" | gcloud secrets versions add smtp-password --data-file=-

# 2. Add the three plain env vars in terraform/modules/app (main.tf + variables.tf)
#    and wire them from root; supply the real APP_BASE_URL via private tfvars
#    (NOT committed — per the docs policy on real service URLs). Example env block:
#       env { name = "SMTP_HOST"    value = var.smtp_host }
#       env { name = "SMTP_PORT"    value = var.smtp_port }        # e.g. "587"
#       env { name = "APP_BASE_URL" value = var.app_base_url }     # the real https run.app URL
terraform fmt && terraform validate
terraform plan     # expect: 3 env additions on the Cloud Run service, 0 destroys
terraform apply    # deploys a new revision

# 3. Verify
gcloud run services describe spms --region=us-central1 \
  --format="value(spec.template.spec.containers[0].env)"      # SMTP_HOST/PORT/APP_BASE_URL present
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://<service-url>/api/password-reset/request \
  -H 'Content-Type: application/json' -d '{"email":"you@test"}'   # expect 200, not 503
```

## Planned agents / owners

This PRD is **handed to DevOps**; the Developer team owns only this plan and the (already-merged) app code.

| Step | Owner | Task |
| --- | --- | --- |
| Provider choice | Developer + DevOps | Pick the transactional SMTP provider (budget-safe free tier) |
| Secret rotation | DevOps | Rotate `smtp-username` / `smtp-password` per the runbook |
| Terraform env vars | DevOps (`terraform-engineer`) | Add `SMTP_HOST`/`SMTP_PORT`/`APP_BASE_URL`; `fmt`/`validate`/`plan`/`apply` |
| Verify | DevOps | Confirm success criteria; send a test email |
| DB migrations (dependency) | DB admin / DevOps | Apply `0002` (PRD 0014) + `0003` (PRD 0015) so `/confirm` works |

## Testing / verification plan

| Success criterion | Verification | Expected |
| --- | --- | --- |
| Secrets rotated | `gcloud secrets versions list smtp-username` | new non-placeholder version |
| Env present | `gcloud run services describe …` | `SMTP_HOST`/`SMTP_PORT`/`APP_BASE_URL` set |
| Config loads | Cloud Logging at startup | no `password reset disabled` warning |
| Routes enabled | `POST /api/password-reset/request` | `200 { ok: true }` |
| Email delivered | Check test inbox | reset link to `/reset-password?token=…` |
| Full flow | click link → set new password → login (needs DB migrations) | login with new password succeeds |

## Additional considerations

- **Security.** SMTP credentials stay **secrets** (`smtp-username`/`smtp-password` in Secret Manager) — never plain env, never committed. `SMTP_HOST`/`SMTP_PORT`/`APP_BASE_URL` are non-secret config. Use **TLS SMTP** (STARTTLS on 587, or 465) so credentials and mail aren't sent in the clear. The app already: mints high-entropy single-use tokens, stores only their SHA-256 hash, never logs the token, and revokes sessions on reset — none of that depends on this change.
- **Deliverability.** For reset mail to reach inboxes (not spam), the provider will likely want SPF/DKIM records; follow the provider's onboarding. This is a follow-up if the first test lands in spam, not a blocker for the mechanism.
- **Rollback.** Fully graceful and reversible: remove the three env vars (`terraform apply`) and the app's lazy config sends `/api/password-reset/*` back to `503` automatically — login and every other route are unaffected, and no data is touched. Secret versions can be disabled/rolled back per the runbook.
- **Dependencies.**
  - **`APP_BASE_URL` real value** is the private, uncommitted service URL (docs policy) — supply it via private tfvars at apply time, same as project ID / instance connection name.
  - **DB migrations are required for the full flow.** SMTP enables `/request` (email out). `/confirm` reads/writes `PASSWORD_RESET_TOKENS` and `USERS.master_password_hash`, so migrations `0002` (PRD 0014) and `0003` (PRD 0015) must be applied to the live DB for reset to complete end-to-end. Coordinate the two so a user isn't emailed a link that then errors on submit.
  - Because the app is deploy-safe, this SMTP work and the DB migration can be scheduled independently — but **enable `/request` only once `/confirm` can succeed**, to avoid dead reset links.

## Outcome

_Filled in by DevOps after execution: provider chosen, env/secret values set (names only), verification output, and any deliverability follow-ups._
