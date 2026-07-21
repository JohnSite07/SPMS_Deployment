# 0016 — Password health analysis runs client-side; the server stores conclusions, not evidence

- **Status:** Accepted
- **Date:** 2026-07-21
- **Deciders:** Anju Babu (with Claude), via [PRD 0022](../action_plan/0022-password-health-and-dashboard.md)

## Context

UC-05 ("Analyze Password Health & Notify") requires checking stored passwords for weak strength and reuse, and surfacing the result as a score, per-item findings, and alerts. `PASSWORD_HEALTH_REPORTS`/`REPORT_FINDINGS`/`SECURITY_ALERTS` have existed in the schema since [PRD 0014](../action_plan/0014-database-schema-implementation.md), unused — the tables were provisioned before anything wrote to them.

Since [PRD 0019](../action_plan/0019-credential-vault-ui-and-encryption.md) and [ADR 0015](0015-vault-key-derivation-from-master-password.md), the server only ever holds a credential's `encryptedPassword` as opaque AES-256-GCM ciphertext; it has no key and cannot decrypt it. "Is this password weak" and "is this password reused elsewhere in the vault" both require comparing or scoring *plaintext* values. A server-side implementation of UC-05 is therefore not a design option to weigh against alternatives — it is architecturally impossible under this project's zero-knowledge posture without breaking that posture. This ADR records the design that follows from that constraint, and the trust boundary it necessarily creates.

## Decision

**The analysis runs entirely client-side, and the server persists only the client's already-computed conclusions.**

- **`client/src/services/vault-health-analyzer.js`** (`analyzeVault(decryptedItems)`) is a pure function: given the vault items already decrypted in the browser (the vault key already lives in `vault-key-store.js`; see ADR 0015), it classifies each item's password as `WEAK`, `REUSED`, or `OK`, and computes an overall score. It calls `password-strength.js`'s existing scorer ([PRD 0021](../action_plan/0021-password-generator.md)) rather than building a second classifier.
  - **Weak-vs-reused precedence:** a password can be both weak and reused, but `REPORT_FINDINGS.status` is a single enum per item, not a set. **`REUSED` takes precedence over `WEAK`.** Rationale: a password shared across two or more vault items multiplies the blast radius of a single leak — every item it protects is exposed at once — which is the more actionable/severe signal than "this one item's password is easy to guess."
  - **Reused, scoped down:** "reused" means identical (exact-match) to another password currently in the same vault — **not** the stricter reading of business rule 9 ("repeats another entry **or one used in the last 30 days**"). There is no password-history table; adding one is a schema change and a decision of its own, not assumed here. See "Known gap" below.
  - **Score formula:** `overallScore = round(100 * okCount / totalCount)`, where `okCount` excludes anything flagged `WEAK` or `REUSED`. 100 means every item is strong and unique; 0 means every item is weak and/or reused. Documented here, in the code header, and in the PRD Outcome because "the" score is otherwise an arbitrary number someone will ask about.
  - **Empty vault (0 items):** a defined edge case, not a divide-by-zero or a misleading 100 — `analyzeVault([])` returns `{ overallScore: null, findings: [] }`. `Credentials.jsx` reads this as "nothing to submit"; `PasswordHealth.jsx` shows its own empty state driven by the persisted `GET` (`{ report: null }`), not by this `null` directly.
- **`POST /api/password-health`** (`app/src/routes/password-health.js` + `app/src/ports/password-health.js`) accepts `{ overallScore, findings: [{ itemId, status }] }` and persists a `PASSWORD_HEALTH_REPORTS` row, its `REPORT_FINDINGS` rows, and a `SECURITY_ALERTS` row per `WEAK`/`REUSED` finding, in one transaction, plus a `HEALTH_REPORT_GENERATED` audit entry. The alert `message` is built server-side from the status label alone (`alertMessageFor()`) — never from client-supplied free text.
- **`GET /api/password-health`** returns the latest report, its findings, and its unread alerts, so the Health screen and the Dashboard's row badges render without recomputing.

### The trust boundary this creates

**The server cannot independently verify a client's self-reported findings.** It has no plaintext to compare a `WEAK`/`REUSED`/`OK` label against, so it cannot tell an honest finding from a fabricated one. This is the same boundary every zero-knowledge password manager with a health-check feature accepts: the server is a dumb store for results the client computed about its own data.

What the server **can and does** verify — and treats as a hard requirement, not best-effort — is that every `itemId` a finding names actually belongs to the caller's own vault (business rule 6). `ports/password-health.js`'s `addFindings()` checks every submitted `itemId` against `VAULT_ITEMS`/`CREDENTIALS` scoped to the caller's `vaultId` before writing anything, and throws `ItemOwnershipError` — mapped to a `404` by the route, matching the anti-enumeration posture `routes/credentials.js` already applies — if any `itemId` isn't the caller's own. Nothing is partially persisted: the whole transaction rolls back. A stolen bearer token can make its own vault's report say anything; it cannot make a report about someone else's items.

## Alternatives considered

- **Server-side analysis.** Never seriously on the table: it requires the server to hold plaintext passwords at some point, which is the definition of not zero-knowledge and directly contradicts ADR 0015 and `docs/architecture/overview.md`'s claim. Rejected outright, not weighed as a live trade-off.
- **A hybrid where the server re-derives a keyed hash of each password to compare for reuse without seeing plaintext** (e.g. the client sends `HMAC(password, per-vault-secret)` instead of plaintext, and the server compares hashes for equality). Considered and rejected for this PRD's scope: it still requires a new secret distribution/storage design (where does the HMAC key live, and is it itself a new zero-knowledge exception), buys only the reuse check (not weakness scoring, which still needs plaintext), and adds real complexity for a feature whose entire value is a UX nudge, not a security control. Noted here in case a future PRD wants to reduce the trust boundary above rather than accept it; not attempted.
- **A real password-history table for the exact 30-day reading of business rule 9.** Rejected for this PRD: no such table exists, and adding one is a schema change and migration, not something to fold quietly into a client-side-analysis decision. The current-vault-only definition is the accepted scope; see "Known gap" below.

## Consequences

- **UC-05's health report is only ever as honest as the client that submitted it.** This is accepted, not a defect — see "The trust boundary this creates" above. Anyone touching `vault-health-analyzer.js`, `password-health.js` (route or port), or the findings/alerts shape should re-read this ADR first, the same way ADR 0015 asks of anyone touching `vault-crypto.js`.
- **Business rule 9's "or one used in the last 30 days" is a known, currently-unimplemented gap, not a silent one.** `analyzeVault()` only ever compares passwords currently in the vault; a password identical to one the user deleted or changed away from 10 days ago is not flagged. Closing this gap needs a password-history table (previous ciphertext or hashes, with their own retention/deletion rules) and is future work, not a defect in this PRD's shipped behaviour.
- **The weak-vs-reused precedence rule is a modelling choice, not a mathematical necessity**, because `REPORT_FINDINGS.status` is a single-value enum. If a future change wants both facts visible per item (e.g. "weak and reused"), that requires either a schema change (a set-valued status, or splitting `REPORT_FINDINGS` into per-check rows) or a UI-only overlay — either is out of this ADR's scope, flagged for whoever revisits it.
- **The score formula is a simple ratio, not a weighted-risk model.** A vault with one `REUSED` item out of two scores the same as one `WEAK` item out of two (both 50). If that turns out to under- or over-weight one failure mode relative to the other, the fix is a documented formula change here and in `vault-health-analyzer.js`'s header comment, not a silent tweak.
- **The duplicate-`itemId` fix is a request-validation refinement, not a design change.** `routes/password-health.js`'s `isValidFindings()` rejects a request naming the same `itemId` twice with a `400` before the transaction opens; without it, the same case would have reached `REPORT_FINDINGS`' composite primary key `(report_id, item_id)` and failed there as a MySQL duplicate-key error mid-transaction — safe (the whole transaction rolls back, nothing persists) but a `500` instead of the `400` a malformed request deserves. Found and corrected in the PRD's security review; recorded here because it is exactly the kind of validation boundary this ADR's ownership check also sits on.

## Related

- [PRD 0022 — Password Health Analysis (UC-05) + Vault Dashboard Redesign](../action_plan/0022-password-health-and-dashboard.md) — the PRD this ADR was written for.
- [ADR 0015 — Vault-key derivation](0015-vault-key-derivation-from-master-password.md) — the zero-knowledge implementation this ADR's constraint follows from; comparable weight, same "load-bearing, re-read before touching" status.
- [`client/src/services/vault-health-analyzer.js`](../../client/src/services/vault-health-analyzer.js) — `analyzeVault()`, including the precedence/formula/empty-vault comments this ADR is drawn from.
- [`app/src/ports/password-health.js`](../../app/src/ports/password-health.js) — the ownership-verification query and its header comment on the trust boundary.
- [`app/src/routes/password-health.js`](../../app/src/routes/password-health.js) — request validation, including the duplicate-`itemId` check.
- [`docs/architecture/domain-model.md`](../architecture/domain-model.md) — `PasswordHealthReport`/`SecurityAlert`, now implemented; see its implementation notes.
- [`docs/requirements/functional-requirements.md`](../requirements/functional-requirements.md) — UC-05 and business rule 9, whose "30 days" clause this ADR scopes down for the reasons above.
- [`docs/architecture/overview.md`](../architecture/overview.md) — the "zero-knowledge" claim this decision keeps intact.
