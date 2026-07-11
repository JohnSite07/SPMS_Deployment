# 0012 — Frontend API Client Foundation

Builds the client-side API service layer the whole SPA will use to talk to `/api`: a fetch wrapper, bearer-token + sliding-session handling, env/relative base URL, a central 401/expiry path, and a first auth service (`login`/`logout`) that proves it end-to-end.

| | |
| --- | --- |
| **Status** | Done |
| **Date** | 2026-07-10 |
| **Author** | htuazon (with Claude) |

> **Written before execution**, per [`.claude/rules/action-plan.md`](../../.claude/rules/action-plan.md) — the approval gate applies. Developer-team-owned **frontend application work**, building on the scaffold ([0010](0010-react-frontend-scaffold.md)) now that it is served ([0011](0011-frontend-serving-and-cd-integration.md)). **Client code only** — no `app/`, no Terraform, no GCP resource, nothing billable. It is the foundation every feature screen sits on, so it comes before them.

## User story

As a Developer building SecureVault's screens, I want one reusable API service that handles talking to `/api` — attaching the login token, keeping the sliding session alive, knowing the server's address, and reacting to an expired session — so that each feature screen just calls `credentialsService.list()` instead of re-solving auth and fetch plumbing (and getting it subtly wrong) every time.

## Scope

**In scope:**
- **Core fetch wrapper** (`client/src/services/api-client.js` or similar): `get/post/put/delete` helpers over the browser `fetch`, JSON in/out, and a typed `ApiError` (carrying HTTP status + the server's `{ error, error_description }`) instead of raw rejections.
- **Bearer-token handling:** attach `Authorization: Bearer <token>` to every request when a token is held.
- **Sliding-session refresh:** read the renewed `X-Session-Token` and `X-Session-Expires-At` headers the server returns on each authenticated response (see [authenticate.js](../../app/src/middleware/authenticate.js)) and update the held token, so an active user is never logged out mid-session (business rule 5).
- **Base URL config:** production is same-origin (Express serves the SPA, [ADR 0009](../decisions/0009-frontend-stack-and-serving-model.md)), so the default is the relative `/api`; local dev resolved via a Vite mechanism (see Decision 2).
- **Central session-expiry handling:** one place that recognises an auth failure (`401` with `Session expired` / `Session ended` / `Token expired`) and drives a single "clear token → redirect to `/login`" path, rather than each screen coping alone.
- **A minimal token store** whose storage mechanism is Decision 1.
- **Auth service** (`client/src/services/auth-service.js`): `login(email, password, code)` → `POST /api/session`; `logout()` → `DELETE /api/session`; wired to the token store. This is the first real consumer, included so the foundation is exercised, not built blind.
- **A client test runner** — the 0010 scaffold has none. Add **Vitest** + a small mocked-`fetch` suite covering token attach, header refresh, `ApiError` mapping, and the 401→redirect path. Add a `test` script to `client/package.json`.

**Out of scope:**
- **Any screen / UI / component** — no login form, no vault views. This builds what screens *call*, not the screens. (Later PRDs.)
- **Per-resource services beyond auth** — `credentialsService`, `documentsService`, etc. ship with their screens.
- **Client-side AES / zero-knowledge vault encryption** — separate PRD and separate security boundary; the API client moves ciphertext, it does not create it.
- **2FA enrolment**, password generator, health checks.
- **CI integration of the new client test job** — adding `npm test` for `client/` to `ci.yml` is a tiny pipeline follow-up once the runner exists; noted, not done here.
- Any `app/` change. The server contract already exists; this only consumes it.

## Success criteria

- [ ] A request made through the wrapper with a held token sends `Authorization: Bearer <token>`; with no token, it sends none (and public calls like login still work).
- [ ] When a response carries `X-Session-Token`, the stored token is replaced with it, and the **next** request uses the new value.
- [ ] A non-2xx response rejects with an `ApiError` exposing `status` and the server's `error_description` (not a raw/opaque error).
- [ ] A `401` whose description is `Session expired` / `Session ended` / `Token expired` triggers exactly one central "clear token + redirect to `/login`" path.
- [ ] `authService.login()` posts to `/api/session` and stores the returned token; `authService.logout()` calls `DELETE /api/session` and clears it.
- [ ] In production build the base URL resolves to relative `/api`; local dev reaches the backend per Decision 2.
- [ ] `npm test` (new Vitest suite) passes; `npm run lint` and `npm run build` stay green.
- [ ] No secret, token value, or hardcoded absolute API URL is committed in `client/`.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `client/src/services/api-client.js` | New — fetch wrapper + `ApiError` + token attach/refresh | None |
| `client/src/services/token-store.js` | New — holds the session token (mechanism = Decision 1) | None |
| `client/src/services/auth-service.js` | New — `login` / `logout` | None |
| `client/src/services/__tests__/*.test.js` | New — Vitest, mocked `fetch` | None |
| `client/vite.config.js` | Modified — dev proxy and/or env base URL (Decision 2) | None |
| `client/package.json` | Modified — add `vitest`, `test` script | None |
| React Router redirect hook-up (minimal) | Modified — central 401 path reaches the router | None |

References: [authenticate.js](../../app/src/middleware/authenticate.js) (bearer scheme, `X-Session-Token`/`X-Session-Expires-At`, 401 `error_description` values) · [session route contract](../../app/src/routes/session.js) · [ADR 0009](../decisions/0009-frontend-stack-and-serving-model.md) (same-origin serving) · business rules 1, 4, 5, 6 in [functional-requirements.md](../requirements/functional-requirements.md) · [PRD 0009](0009-storage-layer-and-auth-wiring.md) (backend that makes login return a real token) · [Vitest](https://vitest.dev/) · [Vite env & modes](https://vite.dev/guide/env-and-mode).

## Scripts / commands

```bash
cd client
npm install -D vitest            # client test runner (0010 added none)
# author the services, token store, tests; wire vite.config dev access

npm test          # new Vitest suite — mocked fetch, no backend needed
npm run lint      # eslint, exit 0
npm run build     # production build resolves base URL to relative /api, exit 0

# Optional real end-to-end (needs backend PRD 0009 wired + a running app):
# npm run dev  then log in through authService against a live /api/session
```

> Nothing billable or destructive. No GCP, no Terraform, no Docker, no deploy. Unit tests mock the network, so no backend is required to prove the foundation.

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| Build | app-engineer (or main session if agent unloaded, as in [0010](0010-react-frontend-scaffold.md#Outcome)/[0011](0011-frontend-serving-and-cd-integration.md#Outcome)) | fetch wrapper, token store, auth service, expiry path, Vitest setup + suite, vite dev access | Green tests + lint/build |
| Review | infra-reviewer | Security pass: token never logged/leaked; token-storage choice honoured; 401 path fail-safe (clears token); no hardcoded URL/secret | Findings |
| Documentation | documentation-keeper | ADR for the token-storage decision (Decision 1); update `client` guide/architecture note; flag the `ci.yml` client-test follow-up | ADR + docs |

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| Token attached | unit: call with a stored token, assert `Authorization` header | `Bearer <token>` present |
| No token → no header | unit: call with empty store | no `Authorization` header; request still made |
| Sliding refresh | unit: mock response with `X-Session-Token`, then a 2nd call | 2nd call uses the new token |
| Typed errors | unit: mock a 401 body | rejects with `ApiError{status:401, error_description}` |
| Central expiry path | unit: mock 401 `Session expired` | token cleared + redirect invoked once |
| Auth service | unit: `login()` / `logout()` | hit `/api/session` (POST/DELETE); store updated/cleared |
| Base URL | build + inspect | relative `/api`; dev reaches backend per Decision 2 |
| Clean | `npm test` / `npm run lint` / `npm run build` | all pass |

## Additional considerations

- **Security posture:** this layer handles the session token, so it must never `console.log` it, put it in a URL/query string, or persist it anywhere Decision 1 didn't sanction. The 401 path must be **fail-safe**: any auth failure clears the token (never leaves a dead token attached). Because production is same-origin, there is no CORS surface and no third-party host to leak to. Vault *contents* remain the crypto PRD's job — this layer only ever moves ciphertext + the session token.
- **Rollback / teardown:** new client-only files; no GCP resource, so `terraform destroy` unaffected. Rollback is `git revert`.
- **Decided (the three settled with the user before approval):**
  1. **Token storage — in-memory.** The token lives only in JS/React state; nothing is persisted to `sessionStorage`/`localStorage`, so a XSS bug has no stored token to exfiltrate. Accepted trade-off: a hard refresh or new tab requires re-login — acceptable given the 10-minute auto-lock and the zero-knowledge posture. Gets an **ADR** (the one security-relevant call of the three).
  2. **Local-dev base URL — Vite dev proxy.** `vite.config.js` proxies `/api` → `http://localhost:8080`; client code calls the **relative `/api`** in every environment (identical dev/prod, no `VITE_API_BASE_URL`, no CORS surface). Production is same-origin `/api` via the Express serving from [ADR 0009](../decisions/0009-frontend-stack-and-serving-model.md).
  3. **Expiry handling — 401-reactive backbone + proactive timer.** Any `401` (`Session expired`/`Session ended`/`Token expired`) clears the token and redirects to `/login` (server is source of truth); additionally a timer keyed on `X-Session-Expires-At` locks the UI exactly at the deadline even while idle, so the 10-minute auto-lock (business rule 5) is *visible*, not deferred to the next request.
- **Dependencies:** unblocks every feature-screen PRD (they consume this). Buildable and unit-testable **independently** (mocked fetch); only real end-to-end login needs backend [0009](0009-storage-layer-and-auth-wiring.md).

## Outcome

Executed 2026-07-10, to plan, on the `feat/frontend-serving-and-scaffold` branch (stacked on 0010/0011, since `client/` isn't on `main` yet).

**Built** under `client/src/services/`:
- `token-store.js` — in-memory token + expiry (Decision 1); `setToken`/`setExpiresAt` only update, `clear()` ends the session.
- `session.js` — `endSession()` (fail-safe: clear then redirect, idempotent), the `X-Session-Expires-At`-keyed auto-lock timer (Decision 3, proactive half), and `setRedirectHandler` so the services stay framework-agnostic.
- `api-client.js` — `request`/`get/post/put/del`, `ApiError` (status + `error`/`error_description`, never the token), bearer attach, sliding-refresh capture, and the central 401→`endSession` path (Decision 3, reactive half) matched to the server's exact descriptions (`Session expired`/`Session ended`/`Token expired`).
- `auth-service.js` — `login()` (POST `/api/session`, stores token, primes the timer via an authed GET), `logout()` (best-effort DELETE, always clears locally), `isAuthenticated()`.
- Base URL is the relative `/api` everywhere; `vite.config.js` gained the dev proxy → `localhost:8080` (Decision 2). `App.jsx` wires `setRedirectHandler` to React Router `navigate('/login')`.

**Test runner added:** the 0010 scaffold had none, so this added **Vitest** (`test` script + devDep) and a mocked-`fetch` suite (real `Response` objects) — **15 tests** covering token attach/no-attach, sliding refresh, `ApiError` mapping, the session-vs-non-session 401 branch, login/logout (incl. server-unreachable), and the auto-lock timer (fires at deadline, re-arms on refresh, past-expiry, logout cancels).

**Verification:** `npm test` 15/15, `npm run lint` exit 0 (added `fetch`/`Headers`/`Response`/`setTimeout`/`clearTimeout` browser globals to the client eslint config), `npm run build` exit 0.

**Deviations:**
- **Executed in the main session**, not the `app-engineer` agent (unloadable mid-session, as in [0010](0010-react-frontend-scaffold.md#Outcome)/[0011](0011-frontend-serving-and-cd-integration.md#Outcome)). Review and docs ran via their agents.
- **One design fix during execution:** `logout()` first let a network error propagate; changed to best-effort (swallow, still clear locally) to match the intent — caught by a test.
- infra-reviewer: **clean / safe to commit**, no blockers. Its notes: (a) approval-state housekeeping — this was executed on the user's "yes execute"; index now `Done`; (b) the services are **currently dead code** (tree-shaken from `dist`) until a screen imports them — expected, so the "build resolves to `/api`" criterion is proven by source + unit tests, to be re-confirmed once a screen wires in `auth-service`.

**Produced:** [ADR 0010 — In-Memory Session Token Storage](../decisions/0010-in-memory-session-token-storage.md); pointers added in [developer-handover.md](../guides/developer-handover.md) and the [docs decisions index](../README.md).

**Open follow-ups (not blocking):**
1. **CI:** add `client/`'s new `npm test` to `ci.yml`'s `client-checks` job (pipeline-engineer) so the service tests gate PRs.
2. Screens (Login first) that consume `auth-service`, then per-resource services (credentials/documents) on top of `api-client` — later PRDs.
3. Real end-to-end login needs backend [PRD 0009](0009-storage-layer-and-auth-wiring.md) wired; until then the layer is proven by mocked-`fetch` unit tests.
