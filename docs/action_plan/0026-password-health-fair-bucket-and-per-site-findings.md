# 0026 — Password health: Fair bucket, per-site findings, reuse-rule reconciliation

Split the health report's single "Strong" bucket into an honest Weak/Fair/Strong scale that matches the strength meter, label each at-risk finding with its site (URL) and a caution icon per the Figure 14 wireframe, and record — without yet building — the deferred "reused in the last 30 days" half of business rule 9.

| | |
| --- | --- |
| **Status** | Draft |
| **Date** | 2026-07-22 |
| **Author** | Anjuuuzzz |

## User story

As a SecureVault user reviewing my password health, I want each at-risk item named by its site with a clear caution marker, and I want the "Strong" count to mean genuinely strong (not merely "not weak"), so that the report tells me *which* logins to fix and doesn't overstate how healthy my vault is.

## Background — what is wrong today

- **The "Strong" count lies by a threshold.** [PasswordHealth.jsx](../../client/src/pages/PasswordHealth.jsx#L148) labels `status === 'OK'` as "Strong", but the analyzer assigns `OK` to anything scoring `>= WEAK_THRESHOLD` (40) and unique — while the strength meter on the Add/Edit form reserves "Strong" for `>= STRONG_THRESHOLD` (70). A 40–69 "Fair" password is counted as "Strong" on the health page. Same word, two bars.
- **Findings name a number, not a site.** The wireframe (Figure 14, `SecureVault_Milestone4_Design.pdf`) shows `bank.example — reused password` with a ⚠ caution sign. The build renders `Credential #<itemId>` — [PasswordHealth.jsx:177](../../client/src/pages/PasswordHealth.jsx#L177) — because the persisted finding carries only `itemId` + `status`.
- **Business rule 9 is half-implemented.** [functional-requirements.md:74](../../docs/requirements/functional-requirements.md#L74): *"flagged when it repeats another entry **or one used in the last 30 days**."* Only the cross-vault "repeats another entry" half exists ([vault-health-analyzer.js:49](../../client/src/services/vault-health-analyzer.js#L49)). The temporal half needs password history, which does not exist in the domain model or schema.

## Scope

**In scope:**
- Add a **FAIR** status to the health scale. Analyzer emits `WEAK` (<40), `FAIR` (40–69), `OK`/"Strong" (≥70), `REUSED`, using the thresholds already exported by `password-strength.js`. Reuse still wins over strength (unchanged precedence).
- Migration **0004**: add `FAIR` to `REPORT_FINDINGS.status`'s ENUM. This is the only schema change.
- **Per-site findings**: `getLatestReport` joins `CREDENTIALS` so each finding carries its `url`; the GET response and UI show `⚠ <url> — <weak|reused> password`, matching the wireframe.
- Health page shows a **four-bucket breakdown** (Strong / Fair / Weak / Reused). "Items needing attention" continues to list only WEAK and REUSED (Fair is acceptable, not a risk), each now with its URL and a caution icon.
- Tests updated/added across analyzer, port, route, and page.
- **Document** the deferred 30-day reuse rule as a tracked gap (a stub follow-up PRD entry + a note in the requirements traceability), so the spec-vs-code deviation is recorded, not silent.

**Out of scope:**
- **The "reused in the last 30 days" temporal rule** — deferred by decision. It requires a password-history store (prior encrypted values + timestamps), client-side decrypt-and-compare, and a retention policy. That is its own PRD (schema + crypto + domain model) and is not built here.
- **Changing the headline `overallScore` formula.** It stays `round(100 × (not-weak, not-reused) / total)` — Fair items still count as healthy for the headline number. Only the *breakdown labelling* changes. (Called out under Open questions.)
- **Renaming the DB value `OK` → `STRONG`.** Kept as `OK` to avoid a data-migration of existing rows; the UI label "Strong" is unchanged. Reports regenerate on every vault load, so no stale-row backfill is needed.
- Any change to `SECURITY_ALERTS` — Fair raises no alert, so its `ENUM('WEAK','REUSED')` is untouched.
- Anything under `terraform/` or `.github/` (DevOps-owned).

## Success criteria

- [ ] `SHOW CREATE TABLE REPORT_FINDINGS` shows `status ENUM('WEAK','FAIR','OK','REUSED')`.
- [ ] Analyzer unit test: a password scoring 40–69 and unique yields `status: 'FAIR'`; ≥70 yields `OK`; boundaries (39/40, 69/70) covered.
- [ ] `GET /api/password-health` returns each finding with a `url` field.
- [ ] `POST /api/password-health` accepts `FAIR` as a valid status (no 400).
- [ ] Health page renders four counters (Strong/Fair/Weak/Reused) and each attention row shows the site URL with a ⚠ caution icon; Fair items do **not** appear in "Items needing attention".
- [ ] `npm test` + `npm run lint` (app) and `npm test` + `npm run lint` + `npm run build` (client) all pass.
- [ ] `docs/action_plan/README.md` lists a deferred follow-up for the 30-day temporal reuse rule.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `app/db/migrations/0004_report_findings_fair_status.sql` | New migration (ALTER ENUM) | None — schema only, no new GCP resource |
| `app/src/ports/password-health.js` | Edit — join CREDENTIALS for `url` in `getLatestReport`; `mapFinding` adds `url` | None |
| `app/src/routes/password-health.js` | Edit — add `FAIR` to `VALID_STATUSES` | None |
| `client/src/services/vault-health-analyzer.js` | Edit — emit `FAIR`; import `STRONG_THRESHOLD` | None |
| `client/src/pages/PasswordHealth.jsx` | Edit — 4 buckets, per-site URL + ⚠ | None |
| `app/tests/*`, `client/src/**/__tests__/*` | Edit/new tests | None |
| `docs/requirements/functional-requirements.md` (traceability note) + `docs/action_plan/README.md` | Docs | None |

References:
- Wireframe: `docs/milestones/SecureVault_Milestone4_Design.pdf` Figure 14 (UC-05).
- Business rules 8–9: [functional-requirements.md:73-74](../../docs/requirements/functional-requirements.md#L73).
- Schema catalogue: [DATABASE.md](DATABASE.md) §10 `REPORT_FINDINGS`.
- Prior health PRD: [0022](0022-password-health-and-dashboard.md).

## Scripts / commands

```bash
# 1. Migration — run ONCE by an ADMIN/migration user against `securevault`
#    (Cloud SQL Studio or Auth Proxy as admin), same as 0002/0003. spms_app
#    has no ALTER and must NOT run the DDL.
#    File: app/db/migrations/0004_report_findings_fair_status.sql
#      ALTER TABLE REPORT_FINDINGS
#        MODIFY COLUMN status ENUM('WEAK','FAIR','OK','REUSED') NOT NULL;
#      -- (optional, cosmetic; rows self-heal on next report) reclassify:
#      -- existing 'OK' rows keep meaning "not weak, not reused"; no backfill.

# 2. App + client checks (no billable commands)
cd app    && npm run lint && npm test
cd client && npm run lint && npm test && npm run build
```

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| Migration + backend (port, route) | `app-engineer` | Write 0004 migration; join `url` into `getLatestReport`; accept `FAIR` in the route; backend tests | Migration file + green `app` suite |
| Client (analyzer, page) | `app-engineer` | Emit `FAIR`; render 4 buckets + per-site URL + ⚠; client tests | Green `client` suite + build |
| Review | `infra-reviewer` | Confirm no schema/grant/secret drift, no zero-knowledge regression (url is plaintext metadata, not a secret) | Verdict |
| Docs | `documentation-keeper` | Deferred-rule note in requirements traceability + README follow-up line | Updated docs |

Steps may be done in the main session instead of agents; this table records intent, not a hard delegation.

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| ENUM has FAIR | `SHOW CREATE TABLE REPORT_FINDINGS` after migration | `status ENUM('WEAK','FAIR','OK','REUSED')` |
| Analyzer emits FAIR | `npx jest`/`vitest` analyzer test with scores 39/40/69/70 | 40 and 69 → FAIR; 70 → OK; 39 → WEAK |
| GET returns url | Port test on `getLatestReport` with a seeded finding | finding has `url` |
| Route accepts FAIR | Route test POSTing a FAIR finding | 201, not 400 |
| UI: buckets + per-site + caution | `PasswordHealth.test.jsx` | 4 counters; attention row shows url + ⚠; Fair absent from attention |
| Green gates | `npm test`/`lint`/`build` both packages | all pass |
| Deferred rule recorded | Inspect README + requirements note | follow-up line present |

## Additional considerations

- **Security posture / zero-knowledge:** `url` is already stored **plaintext** in `CREDENTIALS` (only `encryptedPassword` is ciphertext), so surfacing it in the health response discloses nothing the server didn't already hold. **Verify this during execution** (`SHOW CREATE TABLE CREDENTIALS` / confirm `url` is not an encrypted column) before writing the join — if `url` turned out to be ciphertext, fall back to the client mapping `itemId → title` from its already-decrypted vault list instead. No plaintext password touches this path.
- **Rollback / teardown:** the ENUM add is backward-compatible (existing WEAK/REUSED/OK rows stay valid); rollback is `MODIFY COLUMN status ENUM('WEAK','REUSED','OK')` after ensuring no FAIR rows remain. Under `terraform destroy` the whole Cloud SQL instance goes, so this dies with it — no bespoke teardown.
- **Open questions:**
  - Should Fair count toward the headline `overallScore`, or drag it down partially? This PRD keeps Fair as "healthy" for the headline (score unchanged) and only splits the label. Flag if you want Fair to reduce the score.
  - Keep DB value `OK` (display "Strong") vs rename to `STRONG`? PRD keeps `OK` to avoid a data migration.
- **Dependencies:** the migration is a manual DB step (admin), not run by CI/CD — the app changes assume it has been applied. Deploy order: migration first, then the code (the route only *accepts* FAIR after both; old code ignores the new enum value harmlessly since it never emits it).

## Outcome

_Filled in after execution._
