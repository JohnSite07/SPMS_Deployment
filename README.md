# SecureVault (SPMS) — Secure Password Management System

A web-based, **zero-knowledge** password manager built for PRG800 (Seneca Polytechnic). A single user registers, stores, generates, and manages credentials and sensitive documents inside an encrypted vault — protected by **AES-256 encryption applied client-side**, TLS in transit, a hashed master password, and **TOTP two-factor authentication**. The app is a containerised Node.js/Express service that serves a React (Vite) single-page front end, backed by MySQL (Cloud SQL), and deployed to Google Cloud Platform entirely through Terraform and GitHub Actions.

> **Zero-knowledge:** vault contents are encrypted in the browser. The server only ever stores ciphertext and never holds plaintext secrets or the master password.

---

## Repository organization

```
SPMS_Deployment/
├── app/          # Node.js / Express backend (also serves the built SPA) + Dockerfile
├── client/       # React + Vite single-page front end
├── extension/    # Browser extension (autofill bridge to the vault)
├── terraform/    # Infrastructure-as-Code for every GCP resource
├── docs/         # Structured documentation (architecture, requirements, ADRs, PRDs, runbooks)
├── Handover/     # Developer hand-off package
├── .github/workflows/   # ci.yml (pull requests) and cd.yml (deploy on main)
└── CLAUDE.md     # Repository working guide / conventions
```

### `app/` — Backend (Express)

Container-first Express application; all config and secrets are read from the environment.

| Path | Responsibility |
| --- | --- |
| `src/app.js` | App factory — wires routes; serves the SPA ahead of the auth middleware |
| `src/server.js` | Process entry — loads/validates config, binds the port |
| `src/routes/` | HTTP endpoints: `session`, `register`, `two-factor`, `password-reset`, `credentials`, `documents`, `password-health`, `audit`, `admin-audit` |
| `src/services/` | Business logic: token, session-issuer, audit-log, crypto, password-hasher, two-factor-verifier, email, device |
| `src/middleware/` | `authenticate` (default-deny), `require-role`, `error-handler` |
| `src/models/` | Domain objects (e.g., audit-entry) |
| `src/ports/` | Data-access adapters over MySQL (the ORM-substitute layer) |
| `src/db/` | SQL migrations, grants, seed, and the migration runner |
| `src/config/` | Environment contract & validation |
| `tests/` | Jest + Supertest suites (29 files) |

### `client/` — Frontend (React + Vite)

React 18 SPA routed with React Router (`BrowserRouter`), served by the Express app in production.

| Path | Responsibility |
| --- | --- |
| `src/main.jsx` | Entry — mounts `<App/>` in one `<BrowserRouter>`; loads the design theme |
| `src/App.jsx` | Route table — public (login / 2FA / signup / reset) vs. auth-gated vault screens |
| `src/pages/` | Screens: Welcome, Login, TwoFactorVerify/Setup, SignUp, ForgotPassword, Credentials, Documents, PasswordHealth, Activity, NotFound |
| `src/components/` | Layout, PublicLayout, RequireAuth (route guard), ExtensionBridge |
| `src/services/` | api-client, auth, session, credentials, documents, client-side crypto, key-store, two-factor, registration, password-reset, health, generator |
| `src/utils/` | password-strength and helpers |
| `src/styles/theme.scss` | Single design-token file (Bootstrap SASS variables) |
| `src/**/__tests__/` | Vitest + Testing Library suites (28 files) |

**Frontend conventions** (`.claude/rules/frontend.md`, partly ESLint-enforced): components come from **react-bootstrap**; all API calls go through `src/services/api-client.js` (never raw `fetch`); the **session token is held in memory only** (never `localStorage`/`sessionStorage`); vault secrets are **encrypted client-side**.

### `terraform/` — Infrastructure as Code

Every cloud resource is provisioned as code (nothing is created by hand in the console), split into single-purpose modules: `network/` (VPC + Direct VPC egress), `iam/` (least-privilege service accounts + Workload Identity Federation), `data/` (Cloud SQL private-IP MySQL + Cloud Storage), `app/` (Cloud Run + Artifact Registry), `secrets/` (Secret Manager). The environment is scale-to-zero and fully removable with a single `terraform destroy`.

### `extension/` — Browser extension

A companion extension (`popup.html` / `popup.js` + content bridge) that connects to the vault via the in-app `ExtensionBridge` for in-browser autofill.

### `docs/` — Documentation

Fixed taxonomy: `architecture/` (overview, domain model, UI/UX), `requirements/` (functional & non-functional spec), `decisions/` (Architecture Decision Records), `action_plan/` (numbered Plans of Record / engineering backlog), `deployment/`, `runbooks/`, `guides/`, and `milestones/` (original PRG800 deliverables). Start at [`docs/README.md`](docs/README.md).

---

## Getting started (local development)

Prerequisites: Node.js ≥ 20 and npm.

```bash
# Backend
cd app
npm install
npm test            # Jest unit + integration tests
npm run lint        # ESLint
npm run dev         # run the API locally (reads config from the environment)

# Frontend (in a second terminal)
cd client
npm install
npm run dev         # Vite dev server (proxies /api to the local backend)
npm test            # Vitest
npm run build       # production build -> client/dist (served by Express)
```

Configuration comes from environment variables (populated from Secret Manager in the cloud). No secrets are committed to the repository.

---

## Testing

| Layer | Framework | Location |
| --- | --- | --- |
| Backend (API, services, crypto) | Jest + Supertest | `app/tests/` |
| Frontend (screens, services, crypto) | Vitest + Testing Library | `client/src/**/__tests__/` |
| Infrastructure | `terraform fmt / validate / plan` | `terraform/` |

The business rules — hashed-only master password (≥ 12 chars), 5-failure/15-minute lockout, 10-minute auto-lock, PDF/image ≤ 10 MB uploads, weak/reuse password flags, and an **append-only** audit log — are enforced in code and verified by these suites.

---

## CI/CD & branching

- **Branching:** feature branch → pull request → required CI checks → review → merge to `main` (protected).
- **`ci.yml`** (on pull request): *App checks* (ESLint + Jest), *Client checks* (ESLint + Vitest + build), *Terraform checks* (fmt/validate/plan).
- **`cd.yml`** (on push to `main`): keyless auth via **Workload Identity Federation** (no stored SA key) → Docker build tagged by commit SHA → `terraform apply` → **no-traffic candidate** deploy → **smoke test** → **traffic shift**, with automatic rollback if the smoke test fails.

---

## Documentation

- Architecture & design → [`docs/architecture/`](docs/architecture/)
- Requirements (the Milestone 3 spec) → [`docs/requirements/`](docs/requirements/)
- Decisions (ADRs) → [`docs/decisions/`](docs/decisions/)
- Plans of Record / engineering backlog → [`docs/action_plan/`](docs/action_plan/)
- Deployment & runbooks → [`docs/deployment/`](docs/deployment/), [`docs/runbooks/`](docs/runbooks/)
- Contributor conventions → [`CLAUDE.md`](CLAUDE.md)

## Project

PRG800 — Seneca Polytechnic · Secure Vault Group (Group 2). The product backlog is tracked on the team [Jira SCRUM board](https://prg800summer2026-2.atlassian.net/jira/software/projects/SCRUM/boards/1/backlog); the numbered Plans of Record under [`docs/action_plan/`](docs/action_plan/) are the complementary engineering work-breakdown.
