# 0009 — Frontend stack and serving model: React/Vite served by Cloud Run, not a CDN bucket

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** htuazon (with Claude)

## Context

The Milestone 4 System Design (Part IV, §8.1) references a React/Vite frontend that wasn't described anywhere else in this repo — flagged as an open item in [deployment/README.md](../deployment/README.md#open-items-pending-developer-team-confirmation). [PRD 0010](../action_plan/0010-react-frontend-scaffold.md) stood up that frontend as a scaffold: a Vite-tooled React 18 SPA under `client/`, with a React Router v6 route table covering the five core use-case screens (`/login`, `/`, `/credentials`, `/documents`, `/health`) plus a 404 catch-all. The scaffold has no application logic — it's structure and routing only — but two decisions had to be made to write it at all: which router mode, and how the built bundle eventually gets served in production. Both carry forward into the CD pipeline and the Express app, so they're recorded here rather than left implicit in the PRD.

The controlling constraint is CLAUDE.md's budget rule: "Don't add always-on resources... without a reason tied to the design," under a $300 GCP free-trial credit that must return to zero on `terraform destroy`.

## Decision

**Stack:** React 18, built with Vite, routed with React Router v6 in `BrowserRouter` mode (clean paths — `/credentials`, not `/#/credentials`).

**Serving model — Option A: the existing Express app on Cloud Run serves the built static bundle.** The CD pipeline will run `npm run build` in `client/` and copy the resulting `client/dist/` into the same Docker image the Express API already ships in, ahead of the existing build step. At runtime, Express serves `dist/` as static assets and falls back to `dist/index.html` for any client-side route, all from the same Cloud Run service and origin as the API.

Rejected alternative: a Cloud Storage bucket + Cloud CDN in front of it.

## Alternatives considered

- **Cloud Storage bucket + Cloud CDN (or an external HTTP(S) Load Balancer)** — the conventional way to serve a static SPA cheaply at scale. Rejected here because a global external HTTP(S) load balancer is an always-on resource with its own baseline hourly cost regardless of traffic — it does not scale to zero the way Cloud Run does, and it introduces a second serving surface (a new origin) that Cloud Run doesn't need. It also reintroduces CORS between the SPA origin and the API origin, which same-origin serving avoids entirely. Against a $300 total budget over a ~2-month window, adding a resource with a non-zero idle cost for no capability the project needs is not justified.
- **Hash-based routing (`HashRouter`)** — sidesteps the server-fallback problem entirely (every route is a fragment, so the server only ever sees `/`), at the cost of ugly URLs (`/#/credentials`) that don't match the clean-path examples in the Milestone 4 design. Rejected in favour of `BrowserRouter` + an explicit server-side fallback, accepting the added serving requirement below as the cost of clean URLs.

## Consequences

- **The Express serving code (not yet written) MUST add an SPA fallback** that returns `client/dist/index.html` for any request that is not an `/api/*` route and not a real static asset — otherwise a reload or bookmark on a client-side route (e.g. `/credentials`) 404s at the server, since no such file exists on disk. That fallback route must be registered **after** the API router and after `express.static`, or it will swallow API calls and asset requests instead of falling through to them:

  ```js
  // in app/ — the serving follow-up, not yet implemented
  app.use('/api', apiRouter)                  // 1. API routes first
  app.use(express.static('client/dist'))      // 2. real static assets (index.html, JS, CSS)
  app.get('*', (req, res) =>                   // 3. SPA fallback LAST — any other path → index.html
    res.sendFile(path.join(__dirname, '../client/dist/index.html')))
  ```

- **The CD pipeline gains a build step**: `npm run build` in `client/`, with `client/dist/` copied into the Docker build context ahead of the existing image build, so the shipped image contains both the API and the compiled SPA. This is a follow-up to [`cd.yml`](../../.github/workflows/cd.yml), not yet implemented — see the [deployment README](../deployment/README.md#open-items-pending-developer-team-confirmation).
- Same-origin serving means no CORS configuration is needed between the SPA and the API — one fewer moving part in both the app code and the docs.
- No new GCP resource is introduced by this decision; Cloud Run continues to be the only compute resource serving traffic, preserving scale-to-zero and keeping `terraform destroy` a clean teardown.
- Only the scaffold (routing/structure) exists as of this ADR. The Express static + fallback route and the CD build stage described above are explicitly out of scope of [PRD 0010](../action_plan/0010-react-frontend-scaffold.md) and are tracked as follow-up work (app-engineer for the Express route, pipeline-engineer for the CD stage).

## Related

- [PRD 0010 — React frontend scaffold](../action_plan/0010-react-frontend-scaffold.md) — the scaffold this ADR's decisions were made for.
- [deployment/README.md](../deployment/README.md#open-items-pending-developer-team-confirmation) — the pipeline follow-up this ADR unblocks.
