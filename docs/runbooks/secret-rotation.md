# Rotate a secret

Rotation = add a new Secret Manager version. No code change, no redeploy required by design. Source of truth for the secrets themselves: [terraform/modules/secrets/main.tf](../../terraform/modules/secrets/main.tf) (creation) and [terraform/modules/app/main.tf](../../terraform/modules/app/main.tf) (how Cloud Run consumes them).

Everywhere below, `<PROJECT_ID>` is a placeholder — see [gcp-setup.md](../deployment/gcp-setup.md).

## The 6 secrets

| Secret ID | Purpose | Consumed as |
| --- | --- | --- |
| `db-user` | Cloud SQL application login username | env `DB_USER` |
| `db-password` | Cloud SQL application login password (Terraform-generated) | env `DB_PASSWORD` |
| `jwt-signing-key` | Signs/verifies session tokens | env `JWT_SIGNING_KEY` |
| `aes-encryption-key` | Server-side AES-256 application encryption key (32 raw bytes, base64-encoded) | env `AES_ENCRYPTION_KEY` |
| `smtp-username` | SMTP auth for outbound email (verification, reset, alerts) | env `SMTP_USERNAME` |
| `smtp-password` | SMTP auth for outbound email | env `SMTP_PASSWORD` |

**`smtp-username` and `smtp-password` currently hold literal placeholder values** (`PLACEHOLDER-set-real-value-via-rotation`, set in [terraform/modules/secrets/variables.tf](../../terraform/modules/secrets/variables.tf)) — they are not yet wired to a real provider. Rotate them the moment the Developer team picks an SMTP provider; until then, any email-sending feature will fail auth against a real SMTP host.

## Rotate

```bash
echo -n "<NEW_VALUE>" | gcloud secrets versions add <SECRET_ID> \
  --project=<PROJECT_ID> --data-file=-
```

Example — rotating the SMTP password once a real provider is chosen:

```bash
echo -n "the-real-smtp-password" | gcloud secrets versions add smtp-password \
  --project=<PROJECT_ID> --data-file=-
```

This adds a new version and marks it the latest **enabled** version; older versions are retained (disable or destroy them separately if you need to invalidate a leaked value immediately — see `gcloud secrets versions disable`).

## When the running service picks it up

Cloud Run's `secretKeyRef` env vars resolve to `version = "latest"` (see [terraform/modules/app/main.tf](../../terraform/modules/app/main.tf)), but **secret-backed env vars are resolved once, at container instance start** — not re-read for the lifetime of a running instance. Adding a new secret version does **not** change what an already-running instance sees.

To make a running service pick up the new version, do one of:

- **Do nothing and wait** — the next CD deploy (any push to `main`) creates a new revision, which starts fresh instances that resolve `latest` at start-up.
- **Force new instances now**, without a code change:
  ```bash
  gcloud run services update spms --region=us-central1 --project=<PROJECT_ID> \
    --update-labels=rotated-at=$(date +%s)
  ```
  This is a no-op change to the service spec that still forces a new revision, so its instances start fresh and resolve `latest` for every secret.

Verify by checking which secret versions the current revision resolved (Cloud Run doesn't expose this directly — the practical check is application behaviour, e.g. a successful login after a `jwt-signing-key` rotation, or querying `gcloud secrets versions list <SECRET_ID>` and confirming the timestamp of the version now marked enabled/latest).

## Related

- [PRD 0004 outcome](../action_plan/0004-app-runtime.md#outcome) — where all 6 secrets were provisioned and the env contract fixed.
- [guides/developer-handover.md](../guides/developer-handover.md) — how a developer fetches a secret value under their own identity (never a shared credentials file).
- [runbooks/rollback.md](rollback.md) — if a rotation breaks the running service, this is how to get back to a known-good revision (note: rolling back the Cloud Run revision does **not** roll back the secret version — rotate again with the previous value if needed).
