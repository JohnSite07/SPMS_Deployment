# 0023 — Two-Step Login: Separate Master-Password and 2FA Screens

Split the single-page UC-01 login into two screens — `/login` (email + master password) and `/login/2fa` (six-digit code) — with an in-memory handoff between them.

| | |
| --- | --- |
| **Status** | Done (retrospective) |
| **Date** | 2026-07-22 |
| **Author** | Abdullah |

> **Approval-gate departure.** Like [0008](0008-audit-log-and-vault-routes.md), this PRD was written *after* execution rather than before. The work is client-only React: it creates no GCP resource, runs no billable command, and changes no infrastructure, so the cost/security-review purpose of the pre-execution gate did not apply. Recorded here so the frontend work stays traceable alongside PRDs [0019](0019-credential-vault-ui-and-encryption.md)–[0022](0022-password-health-and-dashboard.md).

## User story

As a SecureVault user logging in, I want to confirm my master password first and *then* be taken to a dedicated two-factor screen, so that the login follows the two-step flow I expect from a password manager instead of asking for all three values on one crowded form.

## Scope

**In scope:**

- `client/src/pages/Login.jsx` reduced to step 1: email + master password + **Unlock**.
- New `client/src/pages/TwoFactorVerify.jsx` — step 2 at `/login/2fa`: six-digit code + **Verify code**, and the one call to `auth-service.login()`.
- New `client/src/services/pending-login.js` — in-memory store carrying `{ email, password }` from step 1 to step 2.
- New route `login/2fa` under `PublicLayout` in `client/src/App.jsx`.
- Guard on step 2: no handoff in memory (deep link, refresh) → `<Navigate to="/login" replace />`.
- Vitest coverage: rewritten `Login.test.jsx`, new `TwoFactorVerify.test.jsx`, new `pending-login.test.js`.

**Out of scope:**

- **Any backend change.** `POST /api/session` keeps verifying password and code together and keeps returning one generic 401 (`app/src/routes/session.js`, `app/src/services/session-issuer.js`). No password-only verification endpoint is added — see *Additional considerations*.
- Changing the lockout rule (5 failures → 15 minutes), which stays entirely server-side.
- The 2FA *enrollment* screen (`/2fa-setup`, PRD [0017](0017-two-factor-enrollment.md)) — untouched; step 2 just links to it.
- "Remember this device" / `deviceToken`, which `auth-service.login()` accepts but no screen sends.
- Visual redesign beyond the layout the split requires; the react-bootstrap card and `theme.scss` tokens are unchanged.

## Success criteria

- [x] `/login` renders email + master password and **no** code field; `/login/2fa` renders the code field and **no** password field.
- [x] Clicking **Unlock** navigates to `/login/2fa` and makes no network request.
- [x] **Verify code** calls `auth-service.login()` exactly once with `{ email, password, code }` — the same single-request contract as before the split.
- [x] A failed login shows one generic message ("Invalid email, password, or code.") on step 2 and leaks no field-specific detail, error code, or lockout state.
- [x] Visiting `/login/2fa` with no step-1 handoff redirects to `/login` instead of showing an unusable code form.
- [x] The master password never reaches `localStorage`, `sessionStorage`, cookies, or router/history state.
- [x] `npm run lint`, `npm test`, and `npm run build` all pass in `client/`.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `client/src/pages/Login.jsx` | Modified React page | None |
| `client/src/pages/TwoFactorVerify.jsx` | New React page | None |
| `client/src/services/pending-login.js` | New client service (module state) | None |
| `client/src/App.jsx` | Modified route table | None |
| `client/src/pages/__tests__/Login.test.jsx` | Rewritten Vitest suite | None |
| `client/src/pages/__tests__/TwoFactorVerify.test.jsx` | New Vitest suite | None |
| `client/src/services/__tests__/pending-login.test.js` | New Vitest suite | None |

**Total cost impact: none.** No GCP resource is created, resized, or deleted. The change ships inside the existing Cloud Run image on the next `cd.yml` run; the bundle grows by a fraction of a kilobyte (`dist/assets/index-*.js` ≈ 262 kB, unchanged to the tenth of a kB).

References:

- [docs/architecture/ui-ux-guidelines.md](../architecture/ui-ux-guidelines.md) — "Login & 2FA flow" §2.3: *"A valid master password advances to the second factor."*
- [docs/requirements/functional-requirements.md](../requirements/functional-requirements.md) — UC-01 Log In, including the anti-enumeration exceptions and the 5-failure lockout.
- [`.claude/rules/frontend.md`](../../.claude/rules/frontend.md) — rules 1 (react-bootstrap), 3 (api-client only), 4 (in-memory tokens), 6 (secure-by-default UI).
- ADR [0010](../decisions/0010-in-memory-session-token-storage.md) — the in-memory storage posture `pending-login.js` follows.
- PRD [0017](0017-two-factor-enrollment.md) — TOTP enrollment, the precondition step 2 depends on.

## Scripts / commands

```bash
cd client
npm install          # client/node_modules was absent on this machine
npm test             # Vitest — full client suite
npm run lint         # ESLint, incl. the no-fetch / no-web-storage gates
npm run build        # Vite production build
```

Nothing billable or destructive. No `terraform` and no `gcloud` command is involved.

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| Implementation | *(main session)* | Split the screens, add `pending-login.js` and the route, write the three test suites | Working code + green gates |
| Verification | *(main session)* | `npm test` / `lint` / `build` | Pass/fail evidence for §Testing |
| Documentation | `documentation-keeper` | Update `docs/architecture/ui-ux-guidelines.md` with the two-screen flow and the route table | Follow-up (see Open questions) |

No `terraform-engineer`, `pipeline-engineer`, or `infra-reviewer` pass: nothing under `terraform/` or `.github/workflows/` changes.

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| Step 1 shows no code field | `Login.test.jsx` — "renders email and master password inputs and an Unlock button, and no 2FA code field" | Pass |
| Step 2 shows no password field | `TwoFactorVerify.test.jsx` — "renders the code input and Verify button, and no email/password fields" | Pass |
| Unlock routes forward, no request | `Login.test.jsx` — "parks the credentials in memory and redirects to the 2FA step on Unlock" | `navigate('/login/2fa')`, store populated |
| Single `login()` call with all three values | `TwoFactorVerify.test.jsx` — "submits the parked email and password together with the code in one login call" | `login` called once with `{email, password, code}` |
| One generic error, no leak | `TwoFactorVerify.test.jsx` — "shows a single generic error on failure and leaks no field-specific detail" | Alert text exactly `Invalid email, password, or code.`; no `invalid_credentials` / "locked" in the DOM |
| Step 1 is not an enumeration oracle | `Login.test.jsx` — "advances without validating, so step 1 leaks no signal about the account" | No alert; advances anyway |
| Deep link / refresh guard | `TwoFactorVerify.test.jsx` — "redirects to step 1 when reached with no handoff" | Code field absent, `login` never called |
| Handoff cleared at the right moments | `TwoFactorVerify.test.jsx` (success, Back) + `Login.test.jsx` (mount) + `pending-login.test.js` | Store `null` after success, after Back, and on step-1 mount |
| No web storage | ESLint `client-checks` gates + `pending-login.test.js` | Lint clean; value dies with module state |
| Gates green | `npm test`, `npm run lint`, `npm run build` | 159 tests passed / 25 files; ESLint clean; Vite build OK |

**Result (2026-07-22):** all of the above ran green — 25 test files, 159 tests passed; `eslint .` clean; `vite build` succeeded in ~10 s.

## Additional considerations

- **Why step 1 makes no network call.** The backend offers no password-only verification endpoint, and adding one would be a security regression, not a feature: it would answer "is this password right for this email?" *before* the second factor, which is precisely the account-enumeration oracle UC-01's single generic 401 exists to close, and it would let an attacker grind passwords without ever needing a TOTP code. So **Unlock** advances unconditionally and every failure — unknown email, wrong password, wrong code, locked account — surfaces once, identically, on step 2. The UX cost is that a mistyped password is only reported after the code is entered; the user can go **Back to sign in** to correct it. This is a deliberate trade of one extra step against keeping the anti-enumeration property intact.

- **Security posture — where the master password lives between steps.** `pending-login.js` holds `{ email, password }` in module state only. React Router's `navigate(path, { state })` was **rejected** for this: router state is serialized into the browser's session-history entry, which persists across reloads and is readable via `history.state`, putting the master password somewhere an injected script can retrieve it. Module state matches `token-store.js` and `vault-key-store.js` (ADR [0010](../decisions/0010-in-memory-session-token-storage.md)) and dies with the tab. It is cleared on successful login, on **Back to sign in**, and whenever `/login` mounts. A tab abandoned *on* step 2 keeps it until one of those — the same window in which `vault-key-store` already holds a live derived key, so no new class of exposure is introduced. Clearing on unmount was considered and rejected because `React.StrictMode` (`client/src/main.jsx`) double-invokes mount/unmount in development and would wipe the handoff before step 2 could read it.

- **Rollback / teardown.** Pure application code: `git revert` of the commit restores the single-screen login, and the next `cd.yml` run ships it. Nothing to `terraform destroy`; no data migration, no DB change, no secret change. The `/login/2fa` route simply stops existing and falls through to the SPA 404.

- **Open questions.** `docs/architecture/ui-ux-guidelines.md` still describes the login as one of "the six screens" without naming the two routes; a `documentation-keeper` pass should record the split. No ADR is warranted — this realizes the flow §2.3 already specifies rather than deciding something new.

- **Dependencies.** None outside `client/`. The Developer-team backend contract (`POST /api/session`) is unchanged, so no coordination is required.

## Outcome

Executed 2026-07-22 in the main session. Delivered exactly the scope above with no deviations: `Login.jsx` reduced to step 1, `TwoFactorVerify.jsx` added at `/login/2fa`, `pending-login.js` added as the in-memory handoff, the route registered under `PublicLayout`, and three Vitest suites written or rewritten. All success criteria verified green (159 tests / 25 files, ESLint clean, Vite build OK).

Two mechanical notes: `client/node_modules` was absent on the execution machine, so `npm install` ran first; and the "Step 2 · Two-factor verification" heading that previously sat mid-form on the single page is now that screen's own section label, with step 1 gaining a matching "Step 1 · Master password" label.

Follow-up: `documentation-keeper` to fold the two-screen flow and its routes into [docs/architecture/ui-ux-guidelines.md](../architecture/ui-ux-guidelines.md).
