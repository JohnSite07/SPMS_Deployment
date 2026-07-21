# 0019 — Credential Vault: Client-Side Encryption + List/Add/View/Edit/Delete UI

Build the actual zero-knowledge encryption layer (deferred by every prior PRD) and the credential vault screens on top of it: list, add, view/reveal/copy, edit, delete — the app-layer half of UC-02/UC-03, no new infrastructure.

| | |
| --- | --- |
| **Status** | Draft (awaiting approval) |
| **Date** | 2026-07-21 |
| **Author** | Main session (orchestrator), on behalf of @Anjuuuzzz — scope drawn from Jira SCRUM-50 (subtasks SCRUM-113–118, 121) |

## User story

As a logged-in SecureVault user, I want to see my saved logins, add a new one, view/copy a password, edit an entry, and delete one — with my passwords encrypted on my own device before they ever leave it — so that even a full compromise of the database never exposes my actual passwords.

## Why this exists, and the one thing that makes it different from every PRD so far

`app/src/routes/credentials.js` and `app/src/ports/credentials.js` **already work** — add/get/update/delete, ownership checks, audit logging, all shipped (PRD 0008/0009). But PRD 0009 explicitly scoped out **"client-side AES-256 vault encryption"** as future work, and nothing has touched it since. The server has only ever been handed an opaque ciphertext string it stores blindly; nothing on the client has ever produced one. `Credentials.jsx` is a one-line placeholder. This PRD builds the missing piece: the actual key derivation and encryption that makes "zero-knowledge" real, plus the UI on top of it.

## ⚠️ Read this before approving: an irreversible consequence of the key model you chose

You picked **direct KDF from the master password** (AES key = PBKDF2(master password, salt), re-derived at every unlock, never stored) over the alternative (a random vault key, wrapped by a KDF-derived key, letting a password change just re-wrap one key). That's the right call for keeping this app-layer-only with no new infra — but it has one real, unavoidable consequence:

**Resetting the master password (PRD 0015's existing `/forgot-password` flow) will permanently make every previously-saved credential undecryptable.** The derived AES key changes when the password does, and nothing re-encrypts old ciphertext with the new key (that reset flow was explicitly designed as "re-hash only," under the assumption — true until now — that vault contents don't depend on the master password at all). This PRD does not fix that; it just makes the consequence real for the first time, because before this PRD there was no vault ciphertext for a reset to orphan.

**This needs your explicit sign-off, not just a note.** Options, none built here:
- Accept it for now (recommended for this PRD's scope) — document it, and treat "fix password-reset re-encryption" as its own future PRD once there's real data at stake worth protecting.
- Block this PRD until reset is fixed alongside it (bigger scope, delays shipping the vault at all).

## Scope

**In scope:**

- **`client/src/services/vault-crypto.js`** — new. `deriveVaultKey(masterPassword, email)`: PBKDF2-SHA-256 (Web Crypto API, `crypto.subtle`, ≥210,000 iterations per current OWASP guidance) → non-extractable AES-256-GCM `CryptoKey`. Salt is derived deterministically from the lowercased, trimmed email (e.g. SHA-256 of it) — **not** a new DB column, so this stays 100% app-layer with zero schema/infra change, at the cost of: if this app ever supports changing a user's email, that would break decryption too (same class of issue as the password-reset one above, flagged once here rather than twice). `encryptField(key, plaintext)` / `decryptField(key, opaque)` — one opaque base64 string per field (IV + ciphertext + GCM tag together), matching exactly what `routes/credentials.js`'s header comment already says the server expects.
- **`client/src/services/vault-key-store.js`** — new, in-memory only, same shape/discipline as `token-store.js` (ADR 0010): holds the derived `CryptoKey`, never persisted, cleared via `clear()`.
- **Wiring the key into the session lifecycle** (the actual design work, not just two new files):
  - `auth-service.js`'s `login()` — after a successful `POST /api/session`, derive the vault key from the password it already has in scope (right before that variable would otherwise fall out of scope/GC) and store it via `vault-key-store.js`. The password's lifetime in memory is not meaningfully extended beyond what already happens today — it already sits in a JS variable for the duration of the login call.
  - `two-factor-service.js`'s `confirmTwoFactor()` — same treatment: confirming 2FA also completes a login (PRD 0017), so it's an equally valid place a vault key needs deriving.
  - `services/session.js`'s `endSession()` — the single existing choke point for logout, 401-triggered session end, and the auto-lock timer — also clears `vault-key-store.js`. This is what makes business rule 5 ("auto-lock") actually lock the *vault*, not just end the session token: after auto-lock, the derived key is gone from memory and re-entering the master password is required to see anything again.
- **`GET /api/credentials`** (new route on the existing `routes/credentials.js` router) + a new `list({ userId })` method on `ports/credentials.js` — the one missing backend piece, small and additive (existing tables, existing ownership pattern, no schema change): returns every `VAULT_ITEMS`/`CREDENTIALS` row for the caller's vault, still ciphertext (the server never decrypts), ordered newest-updated-first (matching `DATABASE.md`'s already-documented listing query pattern).
- **`client/src/pages/Credentials.jsx`** — full build, replacing the placeholder:
  - **List** (SCRUM-113): fetches `GET /api/credentials`, decrypts each item's password field client-side with the in-memory vault key for display purposes only where needed (the list view itself shows title/url/username — only the reveal action in the view/edit screens actually decrypts the password), react-bootstrap `ListGroup`/`Table`, a search/filter input (design principle "Recognition over recall" from `ui-ux-guidelines.md`).
  - **Add Credential** (SCRUM-114/115): a form (title, URL, username, password) in a react-bootstrap `Modal` or dedicated section — encrypts the password client-side via `vault-crypto.js` before `POST /api/credentials`. **No password generator in this PRD** — not one of the listed Jira subtasks; the field accepts typed/pasted input only. Flagged under Out of scope below.
  - **View** (SCRUM-116): masked password by default, a reveal toggle (decrypts on demand), and copy-to-clipboard with the existing 30-second-clear pattern already built in `TwoFactorSetup.jsx` (reused, not reinvented) — matches frontend rule 6 and the `ui-ux-guidelines.md` "secure by default" principle exactly.
  - **Edit** (SCRUM-117): re-encrypts the password field on save if changed (via `PATCH /api/credentials/:itemId`, already built); other fields (title/url/username) patch through unchanged.
  - **Delete** (SCRUM-118): a confirmation `Modal` before `DELETE /api/credentials/:itemId` (already built) — matches the "confirm irreversible actions" principle already established elsewhere (2FA setup's clipboard handling, etc.).
- **Audit logging (SCRUM-121): already done.** `routes/credentials.js` already writes `CREDENTIAL_ADDED`/`CREDENTIAL_RETRIEVED`/`CREDENTIAL_UPDATED`/`CREDENTIAL_DELETED` for every one of these actions (shipped in PRD 0008). No new backend work for this subtask — noted so it isn't accidentally duplicated.
- Tests both sides: `vault-crypto.js` (derive/encrypt/decrypt round-trip, wrong password fails to decrypt correctly rather than silently returning garbage — GCM auth failure), the list endpoint/port method, and Vitest coverage for `Credentials.jsx`'s four flows.

**Out of scope:**

- **`SecureDocument`/document upload (SCRUM-119/120).** Needs new backend (no port/route exists at all today), a new npm dependency (`@google-cloud/storage`), and reconciling a real disagreement between `docs/architecture/overview.md` ("encrypted blobs go to Cloud Storage") and `DATABASE.md`'s `SECURE_DOCUMENTS.encrypted_blob` column (implies DB storage) — explicitly the kind of infra-adjacent work you asked to defer. Tracked as a separate future PRD.
- **Password generator UI** — not a listed Jira subtask for this ticket; UC-04's own use case, a natural follow-up once this PRD ships, not bundled in here.
- **Password health/reuse analysis (UC-05)** — separate epic entirely.
- **Fixing password-reset to re-encrypt the vault** — see the flagged consequence above. Explicitly not solved here.
- **A wrapped/rotatable vault key architecture** — the alternative you didn't choose; noted here so it isn't silently reconsidered later without you weighing in again.
- **Changing `Dashboard.jsx`** beyond what it already is (still a placeholder) — the six-screen spec's "Vault Dashboard" nav-hub role is satisfied by the existing `Layout.jsx` bottom-nav tabs; this PRD's list view lives at `/credentials` as already routed.

## Success criteria

- [ ] `deriveVaultKey` produces the same key for the same (password, email) pair every time, and a different key for a wrong password (verified: decrypting with a wrong-password-derived key throws a GCM auth error, never returns garbage).
- [ ] Logging in (both `POST /api/session` and PRD 0017's `/2fa/confirm` path) leaves a usable vault key in `vault-key-store.js`; logging out, an auto-lock firing, or a 401-triggered session end all clear it.
- [ ] `GET /api/credentials` returns only the caller's own items (business rule 6), still ciphertext.
- [ ] Adding a credential encrypts the password client-side before it's ever sent — verified by inspecting the actual network request body in a test (never plaintext on the wire).
- [ ] The list, add, view (mask/reveal/copy-with-clear), edit, and delete flows all work end-to-end against the real backend routes.
- [ ] Deleting requires an explicit confirmation step.
- [ ] `npm test` / `npm run lint` (app) and `npm run lint` / `npm test` / `npm run build` (client) are green.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `client/src/services/vault-crypto.js` | New — KDF + AES-256-GCM via Web Crypto | $0 |
| `client/src/services/vault-key-store.js` | New — in-memory key store | $0 |
| `client/src/services/auth-service.js` | Edit — derive/store vault key on login | $0 |
| `client/src/services/two-factor-service.js` | Edit — same, on 2FA-confirm login | $0 |
| `client/src/services/session.js` | Edit — clear vault key in `endSession()` | $0 |
| `app/src/routes/credentials.js` | Edit — add `GET /` (list) | $0 |
| `app/src/ports/credentials.js` | Edit — add `list({ userId })` | $0 |
| `client/src/pages/Credentials.jsx` | Rewrite — full list/add/view/edit/delete UI | $0 |
| Tests (app + client) | New | $0 |
| Cloud SQL `securevault` | **Existing** — no schema change | $0 |

No new GCP resource. No new npm dependency (Web Crypto API is a browser built-in, not an npm package).

References:
- The deferred-work origin: `docs/action_plan/0009-storage-layer-and-auth-wiring.md`'s Out-of-scope list.
- Existing backend to build on: `app/src/routes/credentials.js`, `app/src/ports/credentials.js` (both already shipped, PRD 0008).
- In-memory-only precedent: ADR 0010 (`token-store.js`).
- Copy-with-clear precedent already built: `client/src/pages/TwoFactorSetup.jsx`'s clipboard handling.
- The reset/vault-key conflict: `docs/action_plan/0015-password-reset-flow.md`'s "Key decision: reset is re-hash only."
- Wireframes: `docs/architecture/ui-ux-guidelines.md`'s "Add/Edit Credential" and "View Credential" screens (Figures 11–12 in the milestone PDF).

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
| 1 | `app-engineer` | Backend: `GET /api/credentials` list route + port method; tests. | Green `npm test`/`lint`. |
| 2 | `app-engineer` | Frontend: `vault-crypto.js`, `vault-key-store.js`, the three session-lifecycle wiring points, full `Credentials.jsx` rebuild; Vitest tests. | Green `lint`/`test`/`build`. |
| 3 | `infra-reviewer` | Security pass: KDF parameters (iteration count, salt derivation) are sound, key never persisted/exported, plaintext never sent to the server or logged, ownership checks on the new list query, clipboard clear behaves like the existing precedent, wrong-password-derived key fails closed rather than silently corrupting/returning garbage. | Findings/sign-off. |
| 4 | `documentation-keeper` | ADR for the key-derivation design (direct KDF from master password, email-derived salt, and the accepted password-reset consequence) — this is exactly the kind of durable, hard-to-reverse decision this project has ADR'd before (0012, 0013). PRD Outcome + index. | Updated `docs/`. |

## Testing / verification plan

| Success criterion | Verification | Expected |
| --- | --- | --- |
| Correct/wrong-password key derivation | Derive with right vs. wrong password, attempt decrypt | Right succeeds; wrong throws (GCM auth failure), never garbage plaintext |
| Key lifecycle | Login → key present; logout/auto-lock/401 → key cleared | Matches at each transition |
| List ownership | `GET /api/credentials` as two different users | Each sees only their own items |
| No plaintext on the wire | Inspect the `POST`/`PATCH` request body in a test | Only ciphertext present |
| Full CRUD flow | Add → list → view/reveal/copy → edit → delete | Each step works against real routes |
| Delete confirmation | Attempt delete | Blocked without confirming |
| Gates green | app + client `lint`/`test`/`build` | Pass |
| Review | Step 3 | Sign-off, no high-severity open |

## Additional considerations

- **Security posture.** This is the first PRD where the master password's plaintext matters beyond a single login round-trip — it's the seed for every credential's encryption key. The derived key must never be `extractable` from `crypto.subtle`, never logged, never sent anywhere, and cleared on every session-ending path (not just explicit logout). The KDF iteration count is a real, reviewable parameter (too low weakens against an offline attacker who steals the DB; too high slows every unlock) — flagged for the reviewer to sanity-check against current guidance, not treated as settled by this PRD alone.
- **Rollback / teardown.** App code only, no schema change. Rollback = `git revert` — existing ciphertext already in the DB from any interim use would become undecryptable after a revert+later-re-forward-deploy cycle only if the KDF parameters themselves changed between versions; reverting to before this PRD existed removes the feature but doesn't touch stored ciphertext either way.
- **Open questions:**
  - **The password-reset consequence flagged above** — needs your explicit acceptance before this ships, not just a read-through.
  - Whether the email-derived salt (no schema change) is an acceptable permanent choice, or whether a future PRD should add a real per-user random salt column — flagged as a known, deliberate simplification for this PRD's "no infra/schema change" constraint.
- **Dependencies:** none new — reuses the already-shipped `routes/credentials.js`/`ports/credentials.js`, `token-store.js`'s in-memory pattern, and `TwoFactorSetup.jsx`'s clipboard-clear precedent.

## Outcome

_Filled in after execution: what shipped, deviations, links to any resulting doc updates._
