# Roll back a Cloud Run revision

Manual rollback for the `spms` Cloud Run service, plus how to re-run a failed CD pipeline run. Read this together with [deployment/pipeline.md](../deployment/pipeline.md), which describes the automatic protection that usually makes this runbook unnecessary.

Everywhere below, `<PROJECT_ID>` is a placeholder — see [gcp-setup.md](../deployment/gcp-setup.md).

## Automatic protection (read this first)

CD deploys every new revision with `--no-traffic --tag=candidate`, smoke-tests it directly, and shifts traffic only if that smoke test passes (see [deployment/pipeline.md](../deployment/pipeline.md#cd--cdyml-on-push-to-main)). **If the smoke test fails, the job fails and 100% of traffic never leaves the last good revision** — most "bad deploys" are already a no-op before this runbook is needed. Reach for manual rollback only when a revision passed its smoke test but misbehaves afterward (e.g. a bug the health check doesn't exercise).

## 1. List revisions

```bash
gcloud run revisions list --service=spms --region=us-central1 --project=<PROJECT_ID>
```

Identify the last-known-good revision name (Cloud Run revision names are `spms-00042-abc`-style, newest first by default) and, if you need to confirm what shipped, cross-reference its image tag (the commit SHA) against `git log`.

## 2. Re-point traffic

```bash
gcloud run services update-traffic spms --region=us-central1 --project=<PROJECT_ID> \
  --to-revisions=<REVISION_NAME>=100
```

This moves 100% of traffic to `<REVISION_NAME>` immediately — no rebuild, no redeploy. The bad revision still exists (Cloud Run revisions are immutable and not deleted by a traffic shift) so it remains available for debugging or for shifting back.

## 3. Verify

```bash
SERVICE_URL=$(gcloud run services describe spms --region=us-central1 --project=<PROJECT_ID> \
  --format="value(status.url)")
curl -s -o /dev/null -w "%{http_code}\n" "$SERVICE_URL/health"    # expect 200
```

Also confirm the traffic split itself:

```bash
gcloud run services describe spms --region=us-central1 --project=<PROJECT_ID> \
  --format="value(status.traffic)"
```

## Re-running a failed CD run

If CD failed for a reason unrelated to the code (a transient GCP API error, a flaky smoke-test attempt) rather than a genuine regression, re-run it instead of pushing an empty commit:

```bash
gh run list --workflow=cd.yml --limit=5
gh run rerun <RUN_ID>                 # re-run all jobs
gh run rerun <RUN_ID> --failed        # re-run only the failed job(s)
```

Because `cd.yml` runs `concurrency: { group: production, cancel-in-progress: false }`, a re-run queues normally rather than racing any other in-flight deploy of `spms`.

If the failure was a genuine code or infrastructure regression, fix it and push a new commit — don't re-run the same broken build.

## Related

- [deployment/pipeline.md](../deployment/pipeline.md) — full pipeline stages and the no-traffic/smoke-test/shift design.
- [runbooks/secret-rotation.md](secret-rotation.md) — if the bad revision needs a secret fixed, not just a traffic shift.
- [terraform/modules/app/main.tf](../../terraform/modules/app/main.tf) — the Cloud Run resource; note `lifecycle.ignore_changes` on the container image, which is why a `terraform apply` never undoes a manual or CD-driven traffic/image change.
