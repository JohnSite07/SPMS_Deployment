# 0022 — Password Health Analysis (UC-05) + Vault Dashboard Redesign

Build the weak/reused password analysis engine (client-side — the server never sees plaintext) and use it to power both a real Password Health screen and per-item color-coded badges on a redesigned Vault Dashboard that merges the credential list into the dashboard itself, matching the wireframe.

| | |
| --- | --- |
| **Status** | Done |
| **Date** | 2026-07-21 |
| **Author** | Main session (orchestrator), on behalf of @Anjuuuzzz — scope drawn from the Milestone 4 wireframes (Figure 9 "Vault Dashboard", Figure 14 "Password Health") |

## User story

As a logged-in user, I want my vault dashboard to show me at a glance which of my saved passwords are weak or reused, and a dedicated health report with an overall score and specific fixes, so that I can improve my security posture without hunting for problems myself.

## ⚠️ The architecture question this PRD has to answer: analysis can't run on the server

`PASSWORD_HEALTH_REPORTS`/`REPORT_FINDINGS`/`SECURITY_ALERTS` already exist in the schema (PRD 0014), unused. But checking "is this password weak" or "is this password reused elsewhere in the vault" requires comparing actual plaintext values — and since PRD 0019, the server never holds plaintext, only opaque ciphertext it can't parse. **The analysis has to run client-side**, in the browser, using the already-in-memory vault key to decrypt every item, compare them, and compute a score — then the client tells the server the *results* (a WEAK/REUSED/OK label per item, an overall score), which are not secrets and are exactly what the schema already models.

**A real, inherent consequence of this, not a bug to fix:** the server has no way to independently verify a client's self-reported findings — it cannot decrypt anything to check. This is the same trust boundary every zero-knowledge password manager with a health-check feature accepts (the server is a dumb store for results the client computed about its own data). Flagging it here so it's a known, accepted property of the design, not a silent gap.

**Also settled, per your answer:** no email alerts (SMTP still isn't real, same reasoning as PRD 0020) — alerts are in-app only. And "reused within the last 30 days" (business rule 9's exact wording) is scoped down to "reused among your *current* vault items" — there's no password-history table, and adding one is a schema change and its own decision, not assumed here.

## Scope

**In scope:**

- **`client/src/services/vault-health-analyzer.js`** — new, pure client-side. Given the already-fetched, already-decrypted set of vault items (reuses `vault-crypto.js`'s `decryptField` and the vault key already in `vault-key-store.js` — no new decryption primitive):
  - **Weak**: reuses `password-strength.js`'s scoring from PRD 0021 (don't build a second classifier) — below a defined threshold (document the exact cutoff chosen, e.g. score < 40/100 or equivalent) counts as weak.
  - **Reused**: any password value that is identical (as plaintext, compared only in memory, never sent anywhere in that form) to another item's password in the same vault.
  - **Overall score**: a simple, documented formula — e.g. `round(100 * okCount / totalCount)` where `okCount` excludes anything flagged weak or reused. State the exact formula chosen in the code and PRD Outcome, since "the" score is otherwise arbitrary and someone will ask.
  - An empty vault (0 items) is a defined edge case — decide and document what score/state that shows (e.g. no report, a neutral "add your first credential" state) rather than a divide-by-zero or a misleading 100.
- **`POST /api/password-health`** `{ overallScore, findings: [{ itemId, status }] }` (authenticated) — new `app/src/routes/password-health.js` + `app/src/ports/password-health.js`: persists a new `PASSWORD_HEALTH_REPORTS` row + its `REPORT_FINDINGS` rows (one transaction), generates a `SECURITY_ALERTS` row for each WEAK/REUSED finding (no email — in-app only, per your answer), writes `ACTIONS.HEALTH_REPORT_GENERATED` (already in the closed vocabulary, unused until now — confirm and reuse, don't add a duplicate action). Validates `itemId`s belong to the caller's own vault (business rule 6) before accepting them — the server can't verify the *labels* are honest, but it can and must still verify the *items* are actually the caller's own.
- **`GET /api/password-health`** (authenticated) — returns the latest report + its findings + unread alerts for the caller's vault, for the Health screen and the Dashboard's badges to render without recomputing on every navigation (recomputation happens on a real vault-data change — see below).
- **`client/src/pages/PasswordHealth.jsx`** — full build, replacing the placeholder: an overall score display (a simple SVG/CSS ring, no chart library needed), a strong/weak/reused breakdown, and a list of alerts each with a "Fix now" link routing straight to that credential's edit view.
- **Vault Dashboard redesign** — the wireframe's "Vault Dashboard" *is* the credential list (search, auto-lock countdown already in `Layout.jsx`'s header, `+ Add`, per-item rows) — not a separate hub page pointing away to a `/credentials` screen. Consolidate: the index route (`/`) renders the vault list PRD 0019 already built in `Credentials.jsx`, with per-item rows now color-coded by that item's latest health finding (reused → a danger-tinted row, weak → a warning-tinted row, matching the wireframe, using theme tokens — `bg-danger-subtle`/`bg-warning-subtle` or equivalent, never hardcoded hex). Remove the now-redundant placeholder `Dashboard.jsx` and reconcile the `/credentials` vs `/` routing (implementer's call on the mechanical approach — redirect, alias, or single route — but the end state is: visiting `/` shows the full list with badges, matching Figure 9).
- **When analysis (re)runs**: after the vault list loads (on mount) and after any add/edit/delete that changes a password value — not on some other schedule. Keep it simple: the list screen, after fetching+decrypting for display purposes anyway (title/url/username don't need decryption, but computing badges does need the password field decrypted for every item), runs the analyzer and `POST`s the fresh result. This keeps badges current without inventing a background job or a "refresh" button as a hard requirement (a manual refresh affordance is a reasonable nice-to-have, not blocking).
- Tests: `vault-health-analyzer.js` (weak detection, reused detection across 2+ identical passwords, score formula, empty-vault edge case), the new backend route/port (ownership validation, atomicity, alert generation, audit entry), `PasswordHealth.jsx`, and the Dashboard/`Credentials.jsx` badge rendering.

**Out of scope:**

- **Email alerts** — settled above, in-app only.
- **A real password-history table for the true "30-day" reuse rule** — scoped down to current-vault-only reuse, flagged as a future schema-change PRD if the stricter rule is wanted later.
- **Secure Documents (UC-04)** — separate, deferred PRD per your answer; not touched here.
- **Marking alerts as read** beyond whatever minimal affordance naturally falls out of the UI (the schema has `is_read`, but a full read/unread management UI is not required by the wireframe and isn't built out here beyond what's needed to show the list).
- **Any server-side password strength/reuse verification** — architecturally impossible under zero-knowledge, not attempted; see the flagged trust-boundary note above.

## Success criteria

- [ ] Visiting `/` (the dashboard) shows the credential list with search, `+ Add`, and each row color-coded by its current health finding (reused/weak/neither) — matching Figure 9's layout.
- [ ] `PasswordHealth.jsx` shows an overall score, a strong/weak/reused breakdown, and per-finding "Fix now" links that navigate to the right credential.
- [ ] Two credentials sharing the same password are both flagged `REUSED`; a short/simple password is flagged `WEAK`; a strong, unique password is `OK`.
- [ ] The empty-vault case shows a defined, sensible state (not a crash, not a misleading 100 score).
- [ ] `POST /api/password-health` rejects `itemId`s that don't belong to the caller's vault (business rule 6), and persists report+findings+alerts atomically.
- [ ] `HEALTH_REPORT_GENERATED` is audited for each analysis submission.
- [ ] `npm test`/`npm run lint` (app) and `npm run lint`/`npm test`/`npm run build` (client) are green.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `app/src/routes/password-health.js` | New | $0 |
| `app/src/ports/password-health.js` | New | $0 |
| `client/src/services/vault-health-analyzer.js` | New | $0 |
| `client/src/services/password-health-service.js` | New (through `api-client.js`) | $0 |
| `client/src/pages/PasswordHealth.jsx` | Rewrite | $0 |
| `client/src/pages/Credentials.jsx` | Edit — per-item badges, becomes the index route's content | $0 |
| `client/src/pages/Dashboard.jsx` | Removed (folded into the above) | $0 |
| `client/src/App.jsx` | Edit — routing consolidation | $0 |
| Tests | New | $0 |
| `PASSWORD_HEALTH_REPORTS`/`REPORT_FINDINGS`/`SECURITY_ALERTS` | **Existing** — already in schema (PRD 0014), no migration needed | $0 |

No new GCP resource, no new npm dependency, no schema change. Depends on PRD 0021 (`password-strength.js`) shipping first or alongside — the health analyzer reuses its scoring rather than duplicating it.

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| 1 | `app-engineer` | Backend: `routes/password-health.js`, `ports/password-health.js`, ownership validation, atomicity, alert generation, audit entry; tests. | Green `npm test`/`lint`. |
| 2 | `app-engineer` | Frontend: `vault-health-analyzer.js`, `PasswordHealth.jsx`, Dashboard/`Credentials.jsx` consolidation + badges, routing cleanup; tests. | Green `lint`/`test`/`build`. |
| 3 | `infra-reviewer` | Security/consistency pass: ownership check on findings, atomicity, the accepted client-self-report trust boundary is documented not silently assumed, no plaintext logged anywhere in the analysis path, score formula and empty-vault case are sane. | Findings/sign-off. |
| 4 | `documentation-keeper` | ADR for the "analysis must run client-side" decision (comparable weight to ADR 0015) — PRD Outcome + index. | Updated `docs/`. |

## Outcome

Shipped as planned, with one review-driven refinement. Security review: clean sign-off on all ten checked points; one minor non-blocking note fixed and re-tested. Full suite green: app 558 tests / 557 pass / 1 pre-existing skip; client 22 test files / 139 tests; lint/build clean on both.

**Backend** — `app/src/ports/password-health.js` + `app/src/routes/password-health.js` (new). `POST /api/password-health` persists a report + its findings + `WEAK`/`REUSED` alerts in one transaction, validates every submitted `itemId` against the caller's own vault (business rule 6) via `ports/password-health.js`'s `addFindings()` before writing anything, and writes `ACTIONS.HEALTH_REPORT_GENERATED` (already in the closed vocabulary since PRD 0014, unused until now — reused, not duplicated). `GET /api/password-health` returns the latest report or `{ report: null }` for a never-analyzed vault. No schema change — `PASSWORD_HEALTH_REPORTS`/`REPORT_FINDINGS`/`SECURITY_ALERTS` already existed from PRD 0014.

**Frontend** — `client/src/services/vault-health-analyzer.js` (new: the actual weak/reused engine, running entirely client-side since the server never sees plaintext) and `client/src/services/password-health-service.js` (new: thin `GET`/`POST` wrapper). `client/src/pages/PasswordHealth.jsx` rebuilt: score ring, strong/weak/reused breakdown, per-finding "Fix now" links (deep-linking to `/` via router state, consumed once by `Credentials.jsx` then cleared). `Credentials.jsx` now decrypts every item's password on mount and after add/edit/delete, transiently and in-memory only, purely to compute per-row health badges (`bg-danger-subtle` for reused, `bg-warning-subtle` for weak, theme tokens only) and to submit the fresh report — never displayed, logged, or persisted beyond that computation.

**Key decisions** (full reasoning in [ADR 0016](../decisions/0016-client-side-password-health-analysis.md)):
- **Weak-vs-reused precedence:** `REUSED` wins over `WEAK` when a password is both, since `REPORT_FINDINGS.status` is a single enum per item and a shared password's leak blast-radius is the more severe signal.
- **Score formula:** `overallScore = round(100 * okCount / totalCount)`, `okCount` excluding anything `WEAK` or `REUSED`.
- **Empty vault:** a defined edge case, not a crash or a misleading 100 — `analyzeVault([])` returns `{ overallScore: null, findings: [] }`; `Credentials.jsx` treats that as "nothing to submit," `PasswordHealth.jsx` shows its own empty state from the persisted `GET`.
- **Reused is scoped to the current vault only**, not business rule 9's stricter "or one used in the last 30 days" reading — there is no password-history table, and adding one is future work, flagged as a known gap in ADR 0016, not a defect in this PRD.
- **Trust boundary:** the server cannot verify a client's self-reported WEAK/REUSED/OK labels (it has no plaintext to check them against) — it can and does verify that every referenced `itemId` genuinely belongs to the caller's vault. Accepted, not a gap.

**Dashboard/Credentials consolidation:** `client/src/pages/Dashboard.jsx` (placeholder) is deleted. The index route (`/`) now renders `Credentials.jsx` directly, consolidating the wireframe's "Vault Dashboard IS the credential list" design (Figure 9) rather than a separate hub pointing at a `/credentials` screen. The `/credentials` route was removed as redundant — nothing linked to it once `Layout.jsx`'s "Vault" tab pointed at `/`.

**Minor refinement from security review:** a request naming the same `itemId` twice in `findings` would otherwise reach `REPORT_FINDINGS`' composite PK `(report_id, item_id)` and fail there as a MySQL duplicate-key error mid-transaction — safe (full rollback, nothing persists) but a `500` rather than the `400` a malformed request deserves. `routes/password-health.js`'s `isValidFindings()` now rejects a duplicate `itemId` before the transaction opens; fixed and re-tested, not a scope or security-posture change.

**Documentation:** [ADR 0016](../decisions/0016-client-side-password-health-analysis.md) records the "analysis must run client-side" decision at the weight of ADR 0015. `docs/architecture/domain-model.md`'s `PasswordHealthReport`/`SecurityAlert` entries got a brief implementation-note pointer. `docs/architecture/ui-ux-guidelines.md`'s "Vault Dashboard" row already described the consolidated behaviour (credential list, every core task one tap away) before this PRD shipped it — no correction needed. `docs/requirements/functional-requirements.md`'s UC-05 exception ("empty vault → report shows no entries") still holds as written; the scoped-down reuse definition is recorded in ADR 0016 only, consistent with this doc's existing restraint (only one inline spec/implementation note exists in the whole file, for a more fundamental point) rather than annotating every business rule with an implementation caveat.

**Confirmed, not acted on:** `app/tests/ports/contract-suite.js` (the fake-vs-real-MySQL parity suite) still has no `vaults` or `passwordHealth` describe block — a pre-existing gap pattern (it also predates this PRD for `vaults`), left as-is per the flagged note; not fixed in this pass.
