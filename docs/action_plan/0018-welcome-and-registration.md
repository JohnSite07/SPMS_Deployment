# 0018 — Welcome/Landing Page & Self-Service Account Registration

Give SecureVault an actual front door: a public welcome page (logo, feature summary, Sign In / Sign Up) and a real `POST /api/register` so a new user can create their own account instead of a developer hand-writing rows into `USERS`/`VAULTS`.

| | |
| --- | --- |
| **Status** | Done |
| **Date** | 2026-07-21 |
| **Author** | Main session (orchestrator), on behalf of @Anjuuuzzz |

## User story

As a first-time visitor, I want a welcome page that shows me what SecureVault does before I commit, with clear Sign In / Sign Up options, and as a new user I want to actually create my own account, so that I'm not dependent on a developer seeding my row directly into the database.

## Why this exists

Confirmed while building PRD 0017: the app has no self-service way to create an account — `app/src/routes/` has no `register`/`users` POST route. Every account in this system today exists because someone ran `INSERT INTO USERS ...` by hand in Cloud SQL Studio. `services/password-policy.js`'s own header comment already flags this gap ("every caller that mints a new master password — today the password-reset confirm route, later registration"). This PRD closes it, and pairs naturally with PRD 0017: a freshly registered account has no `TWO_FACTOR_CONFIGS` row, so it lands directly in the existing 2FA-enrollment flow to become usable.

## Scope

**In scope:**

- **`client/src/components/Logo.jsx`** — new small SVG component recreating the official milestone branding (`docs/milestones/SecureVault_Milestone4_Design.pdf`, cover page): a shield/banner shape with a keyhole cutout, paired with the "SecureVault" wordmark and, where space allows, the "Secure Password Management System" tagline. Colored via `fill="currentColor"` inside a `text-primary`-classed wrapper (the same Bootstrap utility class already used for the wordmark on every other screen) so it tracks the theme token in `theme.scss` rather than a hardcoded hex — no binary is extracted from the PDF; this is an original, small SVG redrawn to match it. Used on `Welcome.jsx`; other screens keep their current plain-text wordmark (out of scope to retrofit everywhere in this PRD — see below).
- **`client/src/pages/Welcome.jsx`** — new public page at route `/welcome`. Content:
  - The new `Logo.jsx` component as the hero mark.
  - A short feature summary drawn from real, shipped/spec'd functionality only (not marketing copy): encrypted vault (AES-256 at rest, TLS in transit), two-factor authentication, built-in password generator + weak/reuse health checks, secure document storage (PDF/image ≤10MB), 10-minute auto-lock, append-only audit log.
  - Two buttons: **"Sign In"** → `/login`, **"Sign Up"** → `/signup`.
- **`RequireAuth.jsx` redirect target changes from `/login` to `/welcome`.** An unauthenticated visit to any protected route (including bare `/`) now lands on the welcome page instead of jumping straight to the login form. Authenticated behavior at `/` (the Dashboard) is unchanged. `/login` remains directly reachable (still linked from Welcome, and still a valid URL on its own).
- **`client/src/pages/SignUp.jsx`** — new public page at `/signup`. Email + master password + confirm-password fields, with the same client-side strength feedback business rule 2 requires (≥12 chars, upper/lower/number/symbol — mirrors `services/password-policy.js`'s server-side check so the user isn't surprised by a rejection). On success, navigates to `/2fa-setup` with the email carried via router state (pre-fills step 1) so the new user immediately completes enrollment — reuses PRD 0017's flow rather than inventing a second "first login" path.
- **`POST /api/register` `{ email, password }`** (public, new `app/src/routes/register.js`):
  - Validates the email isn't already registered (see the deliberate posture call below).
  - Enforces business rule 2 via the **existing, unmodified** `services/password-policy.js`'s `isStrongMasterPassword`.
  - Hashes via the **existing, unmodified** `services/password-hasher.js`.
  - In one transaction: `INSERT INTO USERS (email, master_password_hash)` (exact query already anticipated in `DATABASE.md`'s catalogue) **and** `INSERT INTO VAULTS (user_id, auto_lock_minutes, is_locked)` with `auto_lock_minutes = 10` (business rule 5) — the domain model composes exactly one `Vault` into a `User`, so a `User` row without its `Vault` is an invalid, half-built object per that model.
  - Writes a new `ACTIONS.ACCOUNT_CREATED` audit entry (added to `models/audit-entry.js`'s closed vocabulary).
  - Responds `201 { userId }` on success (no session token — the account still needs 2FA enrollment before it can ever log in, so there is nothing to authenticate yet).
- **`ports/users.js` addition** — `createUser(tx, { email, passwordHash })` returning the new `userId`, plus whatever minimal vault-creation call is needed (check `ports/` for an existing vaults port before adding a new one — reuse if `ports/vaults.js` or similar already exists from earlier PRDs, add the minimal equivalent if not).
- **`middleware/authenticate.js`** — add `'POST /api/register'` to `PUBLIC_PATHS`.
- Tests both sides: registration happy path, duplicate email, weak password rejection, Vault row created alongside User, audit entry written, atomic failure (a failed Vault insert must not leave an orphan User row); frontend Vitest tests for `Welcome.jsx` and `SignUp.jsx` (including the `RequireAuth` redirect-target change).

**Duplicate-email handling — a deliberate posture call, flagged for explicit sign-off:**
Unlike login/2FA/password-reset (all deliberately generic to prevent enumeration), `/register` will answer a taken email with `409 { error: 'email_already_registered' }` — a real, honest state. Reasoning: signup is about *claiming* a new identity, not testing existing credentials; telling a visitor "that email already has an account" is standard, expected signup UX almost everywhere, and the alternative (silently pretending to succeed) makes for a confusing product with no corresponding security benefit (a signup attempt against a real email doesn't extend an attacker's knowledge the way a login/2FA oracle would — they'd need to already know the email address, which isn't secret). Flagging this explicitly because it's a genuine, deliberate exception to a strong pattern used everywhere else in this codebase.

**Out of scope:**

- **Email verification.** No confirmation email, no "verify your address" gate — the account is usable as soon as 2FA setup completes. `services/email-service.js` exists (from PRD 0015) but isn't wired into registration here. Flagged as a reasonable follow-up, not a blocker: this is a personal password manager, not a multi-tenant SaaS with billing/support tied to a verified address.
- **CAPTCHA / rate limiting** on `/register` beyond what already exists nowhere else either — same recommended-follow-up posture as PRDs 0015/0017.
- **Admin-created accounts, bulk import, or removing the manual-seed path** — unaffected; DATABASE.md's seed block still works exactly as before.
- **Any change to the six wireframe screens, existing Login/2FA behavior, or `Dashboard`'s authenticated `/` route.**
- **Retrofitting `Logo.jsx` onto every other screen.** Login/ForgotPassword/ResetPassword/TwoFactorSetup keep their current plain-text wordmark; only the new `Welcome.jsx` gets the full mark. A follow-up could roll it out everywhere for consistency, but that's a design-consistency pass, not this PRD's job.

## Success criteria

- [ ] `POST /api/register` with a valid new email + strong password returns `201`, creates exactly one `USERS` row and one composed `VAULTS` row (`auto_lock_minutes = 10`), and writes an `ACCOUNT_CREATED` audit entry.
- [ ] `POST /api/register` with an already-registered email returns `409 { error: 'email_already_registered' }` and creates nothing.
- [ ] `POST /api/register` with a password failing business rule 2 (short, or missing a character class) is rejected and creates nothing.
- [ ] A failure writing the `VAULTS` row (simulated) rolls back the `USERS` insert too — no orphan user without a vault.
- [ ] A fresh registration cannot log in via `POST /api/session` until 2FA is set up (confirms the intentional hand-off to PRD 0017's flow, not a regression).
- [ ] Visiting any protected route (including `/`) while unauthenticated lands on `/welcome`, not `/login` directly; `/login` is still directly reachable and still works.
- [ ] `Welcome.jsx`'s "Sign Up" and "Sign In" buttons route to `/signup` and `/login` respectively.
- [ ] Completing `SignUp.jsx` navigates to `/2fa-setup` with the email pre-filled.
- [ ] `npm test` / `npm run lint` (app) and `npm run lint` / `npm test` / `npm run build` (client) are green.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `app/src/routes/register.js` | New | $0 |
| `app/src/ports/users.js` | Edit — add `createUser` (+ vault creation, reusing an existing vaults port if one exists) | $0 |
| `app/src/models/audit-entry.js` | Edit — add `ACTIONS.ACCOUNT_CREATED` | $0 |
| `app/src/middleware/authenticate.js` | Edit — add `POST /api/register` to `PUBLIC_PATHS` | $0 |
| `app/src/app.js` | Edit — mount `/api/register` | $0 |
| `client/src/components/Logo.jsx` | New — SVG shield+keyhole mark, `currentColor`/`text-primary` | $0 |
| `client/src/pages/Welcome.jsx` | New | $0 |
| `client/src/pages/SignUp.jsx` | New | $0 |
| `client/src/services/registration-service.js` | New (through `api-client.js`) | $0 |
| `client/src/components/RequireAuth.jsx` | Edit — redirect target `/login` → `/welcome` | $0 |
| `client/src/App.jsx` | Edit — add `welcome`/`signup` routes | $0 |
| Tests (app + client) | New | $0 |
| Cloud SQL `securevault` | **Existing** — no schema change; `USERS`/`VAULTS` already exist | $0 |

No new GCP resource, no new npm dependency.

References:
- Anticipated by: `app/src/services/password-policy.js`'s own header comment.
- Query already catalogued: `docs/action_plan/DATABASE.md`'s `-- Register: INSERT INTO USERS (email, master_password_hash) VALUES (?, ?);`.
- Composition requirement: `docs/architecture/domain-model.md` — "a `User` owns exactly one `Vault`."
- Hand-off target: PRD [0017](0017-two-factor-enrollment.md) (`/2fa-setup`, `POST /api/2fa/enroll`/`confirm`).
- Auxiliary-page precedent: PRDs 0015 (`ForgotPassword`/`ResetPassword`) and 0017 (`TwoFactorSetup`) — pages outside the six wireframe screens.

## Scripts / commands

No billable command. Local only.

```bash
# app/
npm run lint && npm test

# client/
npm run lint && npm test && npm run build
```

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| 1 | `app-engineer` | Backend: `routes/register.js`, `ports/users.js` additions, `ACTIONS.ACCOUNT_CREATED`, `PUBLIC_PATHS` + `app.js` wiring, atomic User+Vault creation; tests. | Green `npm test`/`lint`. |
| 2 | `app-engineer` | Frontend: `Welcome.jsx`, `SignUp.jsx`, `registration-service.js`, `RequireAuth.jsx` redirect change, routes in `App.jsx`; Vitest tests; per frontend rules. | Green `lint`/`test`/`build`. |
| 3 | `infra-reviewer` | Security pass: duplicate-email posture is deliberate and doesn't leak more than intended, password-policy enforcement can't be bypassed, User+Vault atomicity, no plaintext password logged, parameterized SQL, `RequireAuth` change doesn't accidentally weaken the auth gate. | Findings/sign-off. |
| 4 | `documentation-keeper` | Update DATABASE.md's query catalogue (register + vault-creation queries), note the closed registration gap, PRD Outcome + index, note in `domain-model.md`'s implementation notes if warranted. | Updated `docs/`. |

## Testing / verification plan

| Success criterion | Verification | Expected |
| --- | --- | --- |
| Register happy path | `POST /register` new email + strong password | `201`; one `USERS` row, one `VAULTS` row (`auto_lock_minutes=10`), `ACCOUNT_CREATED` audit entry |
| Duplicate email | `POST /register` with a seeded email (e.g. alice's) | `409 email_already_registered`, nothing created |
| Weak password | `POST /register` with a short/simple password | Rejected, nothing created |
| Atomicity | Simulate a failed vault insert | User insert rolls back too — no orphan |
| Can't log in pre-2FA | `POST /api/session` right after registering | Same `TWO_FACTOR_NOT_ENABLED`-driven generic 401 as any account with no 2FA |
| Welcome routing | Unauthenticated visit to `/` | Lands on `/welcome`; `/login` still directly reachable |
| Welcome buttons | Click Sign Up / Sign In | Routes to `/signup` / `/login` |
| Signup → 2FA hand-off | Complete `SignUp.jsx` | Navigates to `/2fa-setup`, email pre-filled |
| Gates green | app + client `lint`/`test`/`build` | Pass |
| Review | Step 3 | Sign-off, no high-severity open |

## Additional considerations

- **Security posture.** `/register` is a new, fully public write endpoint hitting the database on every request — a real, if modest, abuse surface (mass account creation). No rate limiting/CAPTCHA is added here (see Out of scope), same deferred posture as prior PRDs' recommended follow-ups. The duplicate-email reveal is the one deliberate departure from this codebase's otherwise strict anti-enumeration stance — reasoned above, but worth your explicit confirmation since it's a real posture change, not a default.
- **Rollback / teardown.** App code only, no schema change (`USERS`/`VAULTS` already exist and are unchanged in shape). Rollback = `git revert`. The `RequireAuth` redirect-target change is a one-line revert if it turns out to be unwanted.
- **Open questions:**
  - Confirm the duplicate-email 409 behavior is acceptable (see above) — the alternative is a generic "check your email" style response matching password-reset's posture, at the cost of a confusing signup UX.
  - Confirm no email verification is acceptable for now (see Out of scope).
- **Dependencies:** none — reuses `password-policy.js`, `password-hasher.js`, the existing `USERS`/`VAULTS` schema, and PRD 0017's `/2fa-setup` flow as-is.

## Outcome

Shipped as planned. All success criteria (§4) met; security-reviewed by `infra-reviewer` (one warning-level finding, fixed and re-checked clean — see Deviation below). `npm test`/`lint` green on `app/` (551 tests, 550 passing, 1 pre-existing skip) and `lint`/`test`/`build` green on `client/` (14 test files, 67 tests).

**What shipped:**

- **Backend:** `app/src/routes/register.js` (new) — `POST /api/register`, mounted in `app/src/app.js`/`server.js`, added to `PUBLIC_PATHS` in `app/src/middleware/authenticate.js`. New `app/src/ports/vaults.js` (`create(tx, { userId })` — the first port to write a `VAULTS` row from an application code path, not a hand-seeded one). `ports/users.js` gained `transaction` (exposed for callers needing atomicity beyond `users`' own methods) and `createUser(tx, { email, passwordHash })`. `models/audit-entry.js` gained `ACTIONS.ACCOUNT_CREATED` (`'account.created'`). No schema change — `USERS`/`VAULTS` already existed.
- **Frontend:** `client/src/components/Logo.jsx` (new SVG shield+keyhole brand mark), `client/src/pages/Welcome.jsx` (new, `/welcome`), `client/src/pages/SignUp.jsx` (new, `/signup`), `client/src/services/registration-service.js` (new, through `api-client.js`), `client/src/utils/password-rules.js` (new — business-rule-2 check extracted from `ResetPassword.jsx` so both screens share one implementation rather than duplicating it). `RequireAuth.jsx`'s redirect target changed from `/login` to `/welcome`. `TwoFactorSetup.jsx` gained an optional email pre-fill via router state so `SignUp.jsx` can hand off cleanly into PRD 0017's enrollment flow.
- Full backend + frontend test coverage per the plan's testing table, including atomicity (failed vault insert rolls back the user insert — no orphan `USERS` row) and the duplicate-email/weak-password rejection paths.

**Deviation from plan (review finding, fixed before sign-off):** `infra-reviewer`'s first pass flagged one warning-level issue the PRD's design didn't specify carefully enough: the new `VAULTS` row was initially written with `is_locked = FALSE`, reasoned by the implementer from `DATABASE.md`'s illustrative seed data (alice/bob rows show `VAULTS.is_locked = FALSE` alongside `USERS.is_locked = FALSE`). The reviewer correctly identified that this conflates two unrelated columns that only happen to covary in those illustrative rows, not a documented rule:

- `USERS.is_locked` — account lockout from five failed login attempts (business rule 1).
- `VAULTS.is_locked` — the vault's own lock state (business rule 5's 10-minute auto-lock, and UC-01's "vault unlocked" post-condition of a successful login).

The schema's own declared default is `is_locked BOOLEAN NOT NULL DEFAULT TRUE` (`DATABASE.md`'s DDL), and semantically a vault that has never been unlocked by a real login should start locked — UC-01 treats unlock as a post-login action, not a starting state. Fixed: `ports/vaults.js`'s `create()` now inserts `is_locked = TRUE`. `infra-reviewer` signed off clean on the re-check, explicitly noting that `DATABASE.md`'s existing illustrative seed example (which already shows `is_locked = TRUE` for its `VAULTS` rows, at the schema-DDL default) was correct all along and needs no fix. This is a normal PRD-vs-implementation refinement — the PRD named the column but not its correct value — not a scope change.

**Resulting doc updates:**
- [DATABASE.md §5 (Application query catalogue)](DATABASE.md#5-application-query-catalogue) — the `USERS` register query was already catalogued in anticipation and is now confirmed to be the exact query the route issues (no change needed); added the concrete register-flow `VAULTS` insert (`auto_lock_minutes = 10, is_locked = TRUE`) alongside the existing generic parameterized form.
- [domain-model.md](../architecture/domain-model.md) — implementation note added clarifying `Vault.isLocked` and `User.isLocked` are unrelated columns/concepts, to head off the same conflation in future work.
- [ADR 0013 — Duplicate-email disclosure on registration as a deliberate anti-enumeration exception](../decisions/0013-duplicate-email-disclosure-on-registration.md) — records the `409 email_already_registered` posture call as a durable decision (parallel to how ADR 0012 recorded PRD 0017's enrollment-surface call).
- `docs/action_plan/README.md` index row set to `Done`.
- No change to `docs/architecture/ui-ux-guidelines.md` or `docs/requirements/functional-requirements.md` — see reasoning below.

**Confirmed, no change needed:**
- `ui-ux-guidelines.md` doesn't enumerate `ForgotPassword`/`ResetPassword` (PRD 0015) or `TwoFactorSetup` (PRD 0017) either — all three are auxiliary screens outside the six wireframes it documents. `Welcome`/`SignUp` follow the same precedent and are left unlisted for consistency.
- `functional-requirements.md` states UC-01's precondition generically ("registered account; 2FA set up") without describing how an account comes to exist — that's an implementation detail, not part of the spec. Same call PRD 0017 made for the 2FA half of the same precondition: the pointer belongs in `domain-model.md`'s implementation notes (added above), not in the requirements doc itself.
