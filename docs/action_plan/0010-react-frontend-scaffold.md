# 0010 — React Frontend Scaffold (Vite)

Stands up an empty-but-runnable React SPA under `client/` — Vite tooling, the root HTML, the `main.jsx` entrypoint, the `App` component, and a React Router route table of placeholder pages — with no application logic yet.

| | |
| --- | --- |
| **Status** | Done |
| **Date** | 2026-07-10 |
| **Author** | htuazon (with Claude) |

> **Written before execution**, per [`.claude/rules/action-plan.md`](../../.claude/rules/action-plan.md) — the approval gate applies. This is **Developer-team-owned application work** (the frontend the Milestone 4 System Design PDF Part IV §8.1 references, flagged as an open item in [deployment/README.md](../deployment/README.md#L14)). It creates **no GCP resource** and runs **no billable command**. It is deliberately a *scaffold*: structure and routing only, so later PRDs can fill in auth, API calls, and screens against a stable skeleton.

## User story

As a Developer building SecureVault's UI, I want a runnable Vite + React + React Router skeleton with the page routes already stubbed out, so that feature work drops into a known structure instead of each contributor bootstrapping their own — and so the pipeline team has a real `client/` build to wire a CD stage against.

## Scope

**In scope:**
- A new `client/` directory holding a Vite-tooled React 18 SPA, kept separate from the Express API under `app/` (the two are independent builds).
- `client/index.html` — the single root HTML document with a `<div id="root">` mount node and a `<script type="module" src="/src/main.jsx">`.
- `client/src/main.jsx` — the entrypoint: `ReactDOM.createRoot(...).render(...)` mounting `<App/>` inside a single `<BrowserRouter>`.
- `client/src/App.jsx` — the root component holding the `<Routes>` table (React Router v6, `react-router-dom`).
- A route per core use-case screen, each a **placeholder page component** under `client/src/pages/` that renders only its name/heading (no logic, no data):
  - `/login` → `Login` (UC-01)
  - `/` → `Dashboard` (vault landing)
  - `/credentials` → `Credentials` (UC-02 / UC-03)
  - `/documents` → `Documents` (UC-04)
  - `/health` → `PasswordHealth` (UC-05)
  - `*` → `NotFound` (404 catch-all)
- A minimal shared layout (nav links between the routes) so the routing is visibly exercised — plain semantic HTML, no design system.
- `client/vite.config.js` with `@vitejs/plugin-react`, `client/package.json` (scripts: `dev`, `build`, `preview`, `lint`), a flat-config `client/eslint.config.js` mirroring [app/eslint.config.js](../../app/eslint.config.js), and `client/.gitignore` (`node_modules/`, `dist/`).

**Out of scope:**
- **Any real behaviour** — no auth guards, no login form logic, no API client, no fetch to the Express backend, no token handling, no state management (Redux/Zustand/Context). Pages are inert placeholders.
- **Styling / design system** — no Tailwind, no component library, no theming. Bare markup only; visual design is a later PRD.
- **Serving / hosting implementation** — the *model* is now decided (**Option A: Cloud Run / Express serves the static bundle** — see Additional considerations), but wiring it up (Express static middleware + the SPA `index.html` fallback, and the CD step that copies `dist/` into the image) is **out of scope for this scaffold**. This PRD only produces a `dist/`; the serving work is a follow-up (app-engineer for the Express static route, pipeline-engineer for the build stage).
- **CD pipeline integration** — adding the Vite build ahead of the Docker build is a pipeline-engineer follow-up ([deployment/README.md](../deployment/README.md#L14)); no workflow is edited here.
- **Client-side AES / zero-knowledge crypto** — the eventual in-browser encryption boundary is significant and gets its own PRD; not touched by a scaffold.
- Any change to `app/`, `terraform/`, or `.github/workflows/`.

## Success criteria

- [ ] `cd client && npm install` completes with no errors.
- [ ] `npm run build` produces a `client/dist/` with a hashed JS bundle and an `index.html` (exit 0).
- [ ] `npm run dev` serves the app; the root URL renders the `Dashboard` placeholder.
- [ ] Navigating to `/login`, `/credentials`, `/documents`, `/health` each renders that page's placeholder; an unknown path renders `NotFound`.
- [ ] `npm run lint` exits 0.
- [ ] `client/index.html` contains `<div id="root">` and loads `/src/main.jsx` as a module; `main.jsx` mounts `<App/>` in exactly one `<BrowserRouter>`.
- [ ] No secrets, API URLs, or credentials appear anywhere in `client/` (config comes from the environment later, per 12-factor).

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `client/index.html` | New — root HTML mount | None |
| `client/src/main.jsx` | New — React entrypoint + `BrowserRouter` | None |
| `client/src/App.jsx` | New — `<Routes>` table | None |
| `client/src/pages/{Login,Dashboard,Credentials,Documents,PasswordHealth,NotFound}.jsx` | New — placeholder pages | None |
| `client/src/components/Layout.jsx` (nav shell) | New — minimal layout | None |
| `client/vite.config.js`, `client/package.json`, `client/eslint.config.js`, `client/.gitignore` | New — tooling | None |
| npm deps: `react`, `react-dom`, `react-router-dom`; dev: `vite`, `@vitejs/plugin-react`, `eslint`, `@eslint/js`, `eslint-plugin-react` | Frontend deps | None (build artefact only; no runtime GCP resource) |

References: [functional-requirements.md](../requirements/functional-requirements.md) (UC-01…UC-05 → the routes) · [deployment/README.md](../deployment/README.md#L14) (frontend build open item) · [architecture/overview.md](../architecture/overview.md) · [app/eslint.config.js](../../app/eslint.config.js) (lint config to mirror) · [Vite guide](https://vite.dev/guide/) · [React Router v6](https://reactrouter.com/en/main).

## Scripts / commands

```bash
# from repo root — scaffold the client (non-billable, all local)
mkdir client
cd client

# tooling + libraries
npm install react react-dom react-router-dom
npm install -D vite @vitejs/plugin-react eslint @eslint/js eslint-plugin-react

# author index.html, vite.config.js, src/main.jsx, src/App.jsx,
# src/pages/*.jsx, src/components/Layout.jsx, eslint.config.js, .gitignore
# (written by the app-engineer agent — see below)

npm run lint      # eslint, exit 0
npm run build     # produces client/dist/ — exit 0
npm run dev       # local dev server for manual route check (Ctrl-C to stop)
```

> Nothing billable or destructive. No GCP call, no Terraform, no Docker, no deploy. Output is a static `dist/` that goes nowhere until the serving/CD follow-ups are decided.

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| Scaffold | app-engineer | Create `client/` — Vite config, `index.html`, `main.jsx`, `App.jsx`, placeholder pages, router table, lint config; run `install`/`lint`/`build` | Runnable skeleton + build/lint results |
| Review | infra-reviewer | Light pass: no secrets/URLs committed, deps pinned sanely, `.gitignore` excludes `dist/` + `node_modules/`, structure matches plan | Findings |
| Documentation | documentation-keeper | ADR recording the frontend stack choice (Vite + React Router); update [deployment/README.md](../deployment/README.md#L14) open item; note the serving/CD-integration follow-ups | ADR + updated docs |

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| Install clean | `npm install` in `client/` | exit 0, no errors |
| Build works | `npm run build` | `client/dist/index.html` + hashed JS bundle; exit 0 |
| Dev server + root route | `npm run dev`, open root URL | `Dashboard` placeholder renders |
| All routes resolve | visit `/login`, `/credentials`, `/documents`, `/health` | each renders its own placeholder |
| 404 catch-all | visit an unknown path | `NotFound` renders |
| Lint clean | `npm run lint` | exit 0 |
| Entrypoint shape | inspect `index.html` + `main.jsx` | `#root` mount; single `<BrowserRouter>` wrapping `<App/>` |
| No leaked secrets | `grep -ri` for secrets/URLs in `client/` | nothing found |

## Additional considerations

- **Security posture:** a scaffold holds no secrets and touches no vault data, so the zero-knowledge boundary is unaffected *for now*. The load-bearing future constraint — that the eventual in-browser client is where AES-256 vault encryption happens so the server never sees plaintext — is explicitly **out of scope** and must not be quietly stubbed in a way that implies otherwise. Config (API base URL, etc.) will come from Vite env vars at build/runtime later, never hardcoded.
- **Rollback / teardown:** pure application code in a brand-new directory. No GCP resource, so `terraform destroy` is unaffected. Rollback is `git revert` / delete `client/`.
- **Decided:**
  1. **Serving model — Option A: Cloud Run / Express serves the SPA.** The built `dist/` is served by the existing Express container (static middleware) rather than a Cloud Storage bucket + CDN. Chosen for the budget rule: a bucket+CDN needs an always-on global HTTP(S) load balancer, which violates the "nothing always-on / scale-to-zero" constraint in CLAUDE.md, whereas Cloud Run already scales to zero and adds no new resource. Same-origin also means no CORS config. Implementation (Express static route + CD copy of `dist/` into the image) is a follow-up, not part of this scaffold; it should be recorded in an ADR by documentation-keeper.
  2. **Router mode — `BrowserRouter`.** Clean paths (`/credentials`, not `/#/credentials`). Because Option A serves via Express, the follow-up serving work **must** add an SPA fallback so a reload/bookmark on a client route (which hits the *server* for a path that has no file on disk) doesn't 404. This scaffold uses `BrowserRouter`; the fallback is a hard requirement of the serving follow-up, wired in this order:

     ```js
     // in app/ — the serving follow-up, NOT this scaffold PRD
     app.use('/api', apiRouter)                 // 1. API routes first
     app.use(express.static('client/dist'))     // 2. real static assets (index.html, JS, CSS)
     app.get('*', (req, res) =>                  // 3. SPA fallback LAST — any other path → index.html
       res.sendFile(path.join(__dirname, '../client/dist/index.html')))
     ```

     Order is load-bearing: the `*` fallback must come **after** `/api` and `express.static`, or it swallows API calls and asset requests too.
- **Open questions:**
  1. Route set is the five core use-case screens plus 404; admin/audit-history and 2FA-enrolment screens are added when those flows are built.
- **Dependencies:** unblocks the **serving follow-up** now settled by the decisions above — an app-engineer change adding Express static middleware + the SPA `index.html` fallback in `app/`, and a pipeline-engineer CD step that runs `npm run build` and copies `client/dist/` into the Docker image ahead of the existing build. Both are separate PRDs/tasks, not this one. This scaffold itself depends on nothing and can run independently of the in-flight backend PRDs ([0009](0009-storage-layer-and-auth-wiring.md) et al.).

## Outcome

Executed 2026-07-10. The `client/` scaffold was created exactly to plan: `index.html` (with `#root` + `/src/main.jsx` module script), `src/main.jsx` (single `<BrowserRouter>` wrapping `<App/>` in `StrictMode`), `src/App.jsx` (the six-route table under a shared `Layout`), `src/components/Layout.jsx` (bare nav shell), the six inert placeholder pages under `src/pages/`, plus `vite.config.js`, `package.json`, a React-aware flat `eslint.config.js` mirroring `app/`, and `.gitignore` (`node_modules/`, `dist/`).

**Verification (all machine-checkable success criteria met):**
- `npm install` — 264 packages, no errors.
- `npm run lint` — exit 0, no findings.
- `npm run build` — exit 0; produced `dist/index.html` + hashed `dist/assets/index-*.js` (40 modules).
- No secrets/URLs in `client/`; `dist/` and `node_modules/` confirmed git-ignored.
- The **dev-server route walk-through** (`/login`, `/credentials`, `/documents`, `/health`, unknown→404) is the one criterion left as a **manual check** — `npm run dev` is a blocking server and was not run in the automated pass. Build + lint + code inspection cover the rest.

**Deviations / notes:**
- **Executed in the main session, not the `app-engineer` agent.** That agent's definition file was created earlier this session but agents register at session start, so it wasn't yet loadable; the scaffold was written directly instead. Mechanical deviation only — no scope/cost/security change. (The `infra-reviewer` and `documentation-keeper` steps ran as planned via their agents.)
- **Known non-blocking advisory:** `npm audit` flags the esbuild/vite **dev-server** issue (GHSA-67mh-4wv8-2f99) — dev-only, no production/runtime exposure; fixing needs a Vite 8 breaking upgrade. Accepted for a scaffold.
- infra-reviewer verdict: **clean / safe to commit** (no secrets, correct ignores, sane pinned deps, structure matches plan).

**Produced:** [ADR 0009 — Frontend Stack & Serving Model](../decisions/0009-frontend-stack-and-serving-model.md) (records the Vite + React Router `BrowserRouter` stack and the Option A Cloud Run/Express serving decision with the SPA-fallback consequence); [deployment/README.md](../deployment/README.md) open item updated from "possible" to confirmed, with the remaining pipeline follow-up described.

**Follow-ups (separate PRDs/tasks, out of scope here):** the Express static + SPA-fallback route in `app/` and the `cd.yml` Vite build stage (both named in ADR 0009 and the deployment README); frontend feature work (auth, API client, screens); client-side AES/zero-knowledge crypto.
