# 0011 — Frontend Serving & CD Integration

Makes the React scaffold ([PRD 0010](0010-react-frontend-scaffold.md)) actually reachable: the Express app serves the built SPA (Option A, [ADR 0009](../decisions/0009-frontend-stack-and-serving-model.md)), the Docker image bundles `client/dist`, and the CI/CD workflows build and gate the frontend — with the deploy's no-traffic → smoke → shift rollback property left intact.

| | |
| --- | --- |
| **Status** | Done |
| **Date** | 2026-07-10 |
| **Author** | htuazon (with Claude) |

> **Written before execution**, per [`.claude/rules/action-plan.md`](../../.claude/rules/action-plan.md) — the approval gate applies. Direct follow-up to [0010](0010-react-frontend-scaffold.md); implements the serving + CD work that [ADR 0009](../decisions/0009-frontend-stack-and-serving-model.md) and [deployment/README.md](../deployment/README.md) name as outstanding. Touches `app/` and `.github/workflows/` only — **no Terraform, no new GCP resource.** The billable deploy is the **existing** CD pipeline, triggered the normal way (merge to `main`); this PRD does not run `gcloud`/`terraform` out of band.

## User story

As a SecureVault user, I want to open the app's URL and get the real React UI (and have a page reload on `/credentials` still work), so that the frontend is actually served by our deployment instead of only building locally — while the pipeline still gates and safely rolls back every change.

## Scope

**In scope:**
- **Express static serving + SPA fallback** in [app/src/app.js](../../app/src/app.js), wired in the security-correct order (see Additional considerations for why order is load-bearing):
  1. `express.json()`
  2. `GET /health` (unchanged — dependency-free, CD smoke target)
  3. `express.static('client/dist')` — serves `index.html` at `/` and the hashed assets, **before** auth so the shell/assets are public
  4. **SPA fallback** — for `GET` requests that are **not** under `/api` and match no static file, return `client/dist/index.html`, also **before** the auth middleware
  5. `createAuthMiddleware(...)` and all `/api/*` routes (**unchanged** — data stays behind the bearer token)
  6. `errorHandler`
- **Remove the placeholder** `app.get('/', …)` skeleton string and reconcile `PUBLIC_PATHS` (the `/` entry becomes moot once static serves it ahead of auth).
- **Multi-stage Dockerfile** ([app/Dockerfile](../../app/Dockerfile)): a `client-build` stage (`npm ci && npm run build` in `client/`) whose `dist/` is copied into the runtime image alongside `src/`. Build context moves from `app` to the **repo root** so the Dockerfile can see both `app/` and `client/`; add/adjust `.dockerignore` accordingly.
- **`cd.yml`**: change the build step `context: app` → `context: .` (repo root); image stays SHA-tagged; no other stage changed. The build happens inside Docker (multi-stage), so no separate `npm` step is added to the deploy job.
- **`ci.yml`**: add client gating on PRs — `npm ci` + `npm run lint` + `npm run build` in `client/` — so a broken frontend fails CI before merge, mirroring the existing app lint/test gates.
- Local end-to-end verification: `docker build` at repo root, run the container, confirm the SPA loads, deep-links work, `/health` and `/api` behave.

**Out of scope:**
- **Any frontend feature or crypto** — pages stay the 0010 placeholders. Auth UI, API client, per-screen behaviour, and client-side AES/zero-knowledge encryption are later PRDs.
- **The `trust proxy` / audit `ipAddress` fix** (the standing TODO in [app.js](../../app/src/app.js#L42)) — unrelated, still deferred.
- **Terraform / Cloud Run resource changes** — none. The service, image repo, and traffic model already exist ([0004](0004-app-runtime.md)); `lifecycle.ignore_changes` on the image already prevents `terraform apply` from fighting the deploy.
- **Running the production deploy from this PRD.** Execution produces validated code + workflow changes on a branch; deployment is the normal merge-to-`main` CD run, left to the user.
- HTTPS/cert, custom domain, CDN — Option A is Cloud-Run-native TLS on the `run.app` URL; nothing to add.

## Success criteria

- [ ] `docker build -t spms-local .` (repo-root context) succeeds and the resulting image contains `client/dist/index.html`.
- [ ] Running the container: `GET /` returns **200** with the SPA HTML (the `<div id="root">` document), not the old skeleton string.
- [ ] `GET /credentials` (a client-only route, deep-link/reload) returns **200** with the same `index.html` — **not 401 and not 404** (proves the fallback sits ahead of auth and excludes nothing it shouldn't).
- [ ] Hashed asset requests (e.g. `GET /assets/index-*.js`) return **200** with `Content-Type: application/javascript`.
- [ ] `GET /health` still returns **200** `{"status":"ok",…}` (CD smoke test unbroken).
- [ ] `GET /api/credentials` **without** a token still returns **401** (auth still protects data); `POST /api/session` is still reachable (not shadowed by the fallback).
- [ ] A request to an unknown API path (`GET /api/nope`) does **not** return `index.html` — the fallback excludes `/api`.
- [ ] `cd.yml` builds with `context: .`, image still tagged `:${{ github.sha }}` (never `:latest`); the no-traffic → smoke → shift-traffic sequence is unchanged.
- [ ] `ci.yml` fails a PR if `client/` lint or build fails.
- [ ] `npm test` for `app/` still passes (serving change didn't break the route/auth tests).

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `app/src/app.js` | Modified — static + SPA fallback before auth; drop `/` placeholder | None |
| `app/Dockerfile` | Modified — multi-stage; add client build; copy `dist/` | None (image ~+165 KB gzip 54 KB) |
| `app/.dockerignore` / new root `.dockerignore` | Modified/new — context is now repo root; exclude `node_modules`, `dist`, `.git`, docs, terraform | None (smaller/cleaner build context) |
| `.github/workflows/cd.yml` | Modified — build `context: .` | None (same image, same deploy) |
| `.github/workflows/ci.yml` | Modified — add `client/` lint+build gate | None (CI minutes only) |
| `app/tests/*` | Possibly extended — a serving/fallback + auth-still-protects test | None |
| Cloud Run service `spms`, Artifact Registry repo | **Existing** — reused as-is | Within existing budget — no new resource |

References: [ADR 0009](../decisions/0009-frontend-stack-and-serving-model.md) (serving decision + fallback consequence) · [PRD 0010](0010-react-frontend-scaffold.md) · [deployment/README.md](../deployment/README.md) · [app/src/app.js](../../app/src/app.js) · [app/src/middleware/authenticate.js](../../app/src/middleware/authenticate.js) (default-deny `PUBLIC_PATHS`) · [cd.yml](../../.github/workflows/cd.yml) · [functional-requirements.md](../requirements/functional-requirements.md).

## Scripts / commands

```bash
# --- local, non-billable verification (repo root) ---
cd client && npm run build && cd ..        # produces client/dist (also done inside Docker)
docker build -t spms-local .               # multi-stage: builds client + app image
docker run --rm -p 8080:8080 \
  -e JWT_SIGNING_KEY=<64+ chars> spms-local &   # boot the container locally

curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/               # expect 200 (SPA)
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/credentials    # expect 200 (fallback)
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/health         # expect 200 (JSON)
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/api/credentials # expect 401 (auth)
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/api/nope        # NOT index.html

cd app && npm test && npm run lint         # app suite + lint stay green
cd ../client && npm run lint && npm run build   # client gate (mirrors new ci.yml step)

# --- deploy is NOT run here ---
# Merging this branch to main triggers the existing cd.yml, which runs the
# billable build/apply/deploy with its own no-traffic → smoke → shift guard.
# That merge is the user's action, not this PRD's.
```

> Nothing billable or destructive runs during execution. `docker build`/`run` are local. The only billable path is the existing CD pipeline, invoked by merging to `main` — named here but performed by the user.

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| Serving code | app-engineer (or main session if the agent isn't loaded — as in [0010](0010-react-frontend-scaffold.md#Outcome)) | `app.js` static + SPA-fallback before auth; drop `/` placeholder; reconcile `PUBLIC_PATHS`; a test proving deep-link works AND `/api` still 401s | Wired `app.js` + green `npm test` |
| Image | app-engineer / main session | Multi-stage Dockerfile; root `.dockerignore`; local `docker build`+run smoke | Working local image |
| Workflows | pipeline-engineer | `cd.yml` context → `.`; `ci.yml` client lint+build gate; validate YAML/actionlint | Updated workflows |
| Review | infra-reviewer | Security pass: fallback excludes `/api` and can't expose data; auth still default-deny; SHA-tag + rollback sequence intact; no secrets in image/context | Findings + go/no-go |
| Documentation | documentation-keeper | Update [deployment/README.md](../deployment/README.md) (open item → done); note serving/build in the pipeline doc; close the ADR 0009 follow-up | Updated docs |

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| Image bundles the SPA | `docker build` then inspect / run | `client/dist/index.html` present in image |
| SPA served at root | `curl /` on the container | 200, SPA HTML with `#root` |
| Deep-link / reload works | `curl /credentials` | 200, `index.html` (fallback, before auth) |
| Assets served | `curl /assets/index-*.js` | 200, JS content-type |
| Smoke target intact | `curl /health` | 200 JSON |
| Data still protected | `curl /api/credentials` (no token) | 401 |
| Fallback excludes API | `curl /api/nope` | not `index.html` (404/JSON) |
| Login still reachable | `POST /api/session` path exists | not shadowed by fallback |
| App tests green | `cd app && npm test` | pass |
| CI gates frontend | break `client/` lint on a PR branch | `ci.yml` fails |
| Deploy shape unchanged | read `cd.yml` diff | only `context` changed; SHA tag + no-traffic/smoke/shift intact |

The core proof is the pair **`/credentials` → 200** *and* **`/api/credentials` → 401** from the same running image: it demonstrates the SPA shell is public while data stays behind the token — the exact boundary the mount order has to get right.

## Additional considerations

- **Security posture (the load-bearing part):** the auth middleware ([authenticate.js](../../app/src/middleware/authenticate.js)) is **global default-deny** with a small `PUBLIC_PATHS` allowlist. Static serving and the SPA fallback therefore mount **before** it — otherwise a reload on `/credentials` is caught by auth and 401s instead of returning the shell. The trade this makes is deliberate and safe: the **shell and static assets are public** (they contain no secrets — the vault is fetched over `/api` with a token, and zero-knowledge crypto keeps contents encrypted), while **every `/api/*` data route stays behind the bearer token**. Two failure modes the reviewer must rule out: (1) the fallback accidentally matching `/api/*` (would turn API 404s into a 200 HTML page and could mask/expose route behaviour) — it must exclude `/api`; (2) the fallback or static coming *after* auth (would break deep-linking). Both are asserted in the tests above.
- **Rollback / teardown:** app + workflow code only; no GCP resource created, so `terraform destroy` is unaffected. Revert is `git revert`. At runtime the existing no-traffic → smoke → shift guard still applies — if the new image fails `/health`, traffic never leaves the last good revision. A larger image is the only runtime delta and it scales to zero as before.
- **Decided:**
  1. **Multi-stage Dockerfile with repo-root build context**, over a "build in CI then copy into `app/`" approach — it's self-contained (identical build locally and in CI), keeps the image reproducible from a single `docker build`, and avoids an extra ordering-sensitive workflow step. Cost: `cd.yml` context changes and `.dockerignore` must exclude the now-visible `node_modules`, `terraform/`, `docs/`, `.git`.
  2. **Deploy is the normal merge-to-`main` pipeline run**, not an out-of-band command in this PRD — consistent with the keyless-WIF, branch-gated design; keeps "nothing billable runs that the PRD didn't name" true (the pipeline is the named, existing billable path).
- **Open questions:**
  1. `.dockerignore` scope with the wider context — confirm the client `node_modules` and `dist` are excluded so the `client-build` stage rebuilds cleanly rather than copying a stale host `dist`.
  2. Whether to add a dedicated Jest test for the fallback/auth boundary in `app/tests/` (recommended) vs. rely on local `curl` checks — the reviewer will call it.
- **Dependencies:** unblocks all frontend feature PRDs (they now deploy through a working path). Independent of the in-flight backend storage PRD ([0009](0009-storage-layer-and-auth-wiring.md)); the serving change doesn't touch the data layer.

## Outcome

Executed 2026-07-10, to plan.

**Serving ([app/src/app.js](../../app/src/app.js)):** `express.static(clientDist)` + an SPA `index.html` fallback mounted **ahead of** the auth middleware; `/health` moved above them so the catch-all can't shadow it; the old `app.get('/', …)` skeleton removed. Serving is conditional on the build being present (`fs.existsSync`, `CLIENT_DIST_PATH` override), so tests and backend-only dev keep default-deny. `PUBLIC_PATHS` reconciled (dropped the now-moot `/`; kept `/health` as defence-in-depth) in [authenticate.js](../../app/src/middleware/authenticate.js).

**Image:** [app/Dockerfile](../../app/Dockerfile) is now multi-stage — a `client-build` stage runs `npm run build`, and only `client/dist` is copied into the runtime image (Vite/devDeps discarded; still `USER node`). Build context moved to the repo root via a new root [.dockerignore](../../.dockerignore); the now-inert `app/.dockerignore` was removed.

**Workflows (pipeline-engineer):** `cd.yml` build step → `context: .`, `file: app/Dockerfile` (only change; SHA-tag + no-traffic→smoke→shift intact). `ci.yml` gained a `client-checks` job (npm ci + lint + build for `client/`).

**Verification:**
- App suite **431/431 pass** (added [tests/spa-serving.test.js](../../app/tests/spa-serving.test.js): shell public, deep-link fallback, assets, `/health` JSON, `/api` still 401, `/api` exclusion incl. edge cases; updated `authenticate.test.js`); both lint suites exit 0 (`beforeAll`/`afterAll` added to the app eslint test globals).
- **Docker build could not be run locally — Docker is not installed in this environment.** Instead the serving path was proven by running Express directly with Node against the real `client/dist` (`CLIENT_DIST_PATH`): `/`→200 shell, `/credentials`→200 shell, `/assets/*.js`→200 `application/javascript`, `/health`→200 JSON, `/api/credentials`→**401**, `/api/nope`→401 JSON, `POST /api/session`→500 (reaches the router, not shadowed). The container build itself is validated by CI on first PR/push.

**Deviations:**
- **Executed mostly in the main session** (serving code, Dockerfile, tests) rather than the `app-engineer` agent — same reason as [0010](0010-react-frontend-scaffold.md#Outcome) (agent not loadable mid-session). Workflows, review, and docs ran via their agents.
- **infra-reviewer found one real bug and it was fixed before Done:** the first fallback predicate `startsWith('/api/')` let bare `/api` and case-varied `/API/credentials` return the public shell instead of 401 (no data exposure — the fallback only serves static HTML — but a contract violation). Fixed to an anchored, case-insensitive match `/^\/api(\/|$)/i` with regression tests; re-verified live (`/API/credentials`→401, `/api`→401). Re-review items (PUBLIC_PATHS, deployment README) also closed.
- **Docker verification downgraded to a Node run** (see above) due to no local Docker.

**Produced / updated docs (documentation-keeper):** [deployment/README.md](../deployment/README.md) (open item → implemented), [deployment/pipeline.md](../deployment/pipeline.md) (CI `client-checks` job, CD multi-stage build, branch-protection callout), [architecture/system-design-summary.md](../architecture/system-design-summary.md) and [guides/developer-handover.md](../guides/developer-handover.md) (frontend open items marked resolved). [CLAUDE.md](../../CLAUDE.md) updated (layout, Compute, CI/CD, Application stack).

**Open follow-ups (not blocking Done):**
1. **Branch protection:** the new `Client checks (lint + build)` job runs on PRs but is **not yet a required status check** on `main` — a broken client build can currently still merge. Add it to the required checks (repo admin action; flagged in pipeline.md).
2. **Deploy:** not performed here by design — merging this branch to `main` triggers the existing CD pipeline (the named billable path).
3. Frontend feature work + client-side AES/zero-knowledge crypto remain later PRDs; `client/` pages are still 0010 placeholders.
