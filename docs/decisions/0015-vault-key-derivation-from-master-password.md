# 0015 — Vault-key derivation: direct KDF from the master password, email-derived salt

- **Status:** Accepted
- **Date:** 2026-07-21
- **Deciders:** Anju Babu (with Claude), via [PRD 0019](../action_plan/0019-credential-vault-ui-and-encryption.md)

## Context

Every prior PRD deferred the actual client-side encryption that "zero-knowledge" in [docs/architecture/overview.md](../architecture/overview.md) claims. `app/src/routes/credentials.js` and `app/src/ports/credentials.js` (PRD 0008) already accept, store, and return a credential's `encryptedPassword` as an opaque string — but nothing on the client had ever produced that string. The server was, and remains, incapable of decrypting it: it stores whatever ciphertext it is handed and nothing else. PRD 0019 built the piece that was missing: the key derivation and AES encryption that makes that opacity real instead of assumed.

Two design questions had to be settled before any code was written, because both are effectively permanent once real vault data exists under them:

1. **Where does the AES key come from, and what happens to old ciphertext when the master password changes?**
2. **Where does the PBKDF2 salt come from, without a schema change?**

This ADR records both decisions, the parameters chosen, and the consequences accepted — the kind of durable, hard-to-reverse call this project has ADR'd before ([0012](0012-two-factor-enrollment-separate-public-surface.md), [0013](0013-duplicate-email-disclosure-on-registration.md), [0014](0014-totp-based-password-reset.md)).

## Decision

**The vault's AES-256-GCM key is derived directly from the master password via PBKDF2, every time it's needed, and never stored.** `client/src/services/vault-crypto.js`'s `deriveVaultKey(masterPassword, email)`:

- **KDF:** PBKDF2-HMAC-**SHA-256**, Web Crypto API (`crypto.subtle`), **600,000 iterations** — OWASP's current Password Storage Cheat Sheet guidance for this specific hash width. This number is a moving target, not a permanent constant: it should be revisited whenever OWASP revises its PBKDF2-SHA-256 recommendation, the same way this PRD's own review caught the first implementation citing the wrong row of that table (see Consequences).
- **Salt:** SHA-256 of the lowercased, trimmed account email — deterministic and recomputable from a value the app already has at login, so no new database column, no per-user random salt to generate/store/back up. Not a full replacement for a random salt (see Alternatives), but sufficient to defeat a precomputed rainbow-table attack across unrelated SecureVault accounts, since two different emails always diverge.
- **Key:** a **non-extractable** `AES-256-GCM` `CryptoKey` (`extractable: false` on `deriveKey`). Encrypt/decrypt work normally; `crypto.subtle.exportKey` on this key object always fails.
- **Field encryption:** `encryptField`/`decryptField` produce/consume one opaque base64 string per field — a random 12-byte IV followed by WebCrypto's combined ciphertext+auth-tag — matching exactly what `routes/credentials.js` already documented as its expectation for `encryptedPassword`.

This is a **direct KDF** design: the AES key is re-derived from the master password at every unlock and is never itself stored or wrapped. The alternative — a random vault key generated once, encrypted ("wrapped") by a KDF-derived key, so a password change just re-wraps one key instead of re-encrypting every item — was considered and explicitly not chosen (see Alternatives). Direct KDF keeps the feature 100% app-layer: no new table, no new column, no key-wrapping logic, no infrastructure. Its cost is the accepted consequence below.

### Accepted consequence: password reset orphans existing vault data

[PRD 0015](../action_plan/0015-password-reset-flow.md)'s reset flow (now [PRD 0020](../action_plan/0020-totp-based-password-reset.md)'s TOTP-based replacement, see [ADR 0014](0014-totp-based-password-reset.md)) was built as **re-hash only** — it changes `USERS.master_password_hash` and nothing else, under the assumption, true until PRD 0019, that vault contents never depended on the master password. That assumption is now false: the AES key is `PBKDF2(masterPassword, salt)`, so changing the password changes the key, and nothing re-encrypts previously-saved ciphertext with the new one. **Resetting the master password permanently makes every credential saved before the reset undecryptable.**

This was flagged to the user before approval, not discovered afterward, and the decision was made explicitly: **accept it for now** (this PRD's scope), and treat "make password reset re-encrypt the vault" as a distinct future PRD once there is real data at stake worth the added complexity. The alternative — block PRD 0019 until reset is fixed alongside it — was rejected as unnecessarily delaying a working, reviewed zero-knowledge layer over a consequence that only matters once real credentials exist to lose.

### Vault-key lifecycle

The derived key lives only in `client/src/services/vault-key-store.js` — in-memory module state, never persisted, same discipline as `token-store.js` ([ADR 0010](0010-in-memory-session-token-storage.md)):

- **Derived and stored** at the two points a login actually completes: `auth-service.js`'s `login()` (`POST /api/session`) and `two-factor-service.js`'s `confirmTwoFactor()` (`/2fa/confirm` completing a login, PRD 0017). Both derive from the master password while it is still in a local variable from that same call — its in-memory lifetime is not meaningfully extended beyond what already happened before this PRD.
- **Cleared** at every session-ending path: `auth-service.js`'s `logout()` and `services/session.js`'s `endSession()` (the shared choke point for a 401-triggered session end and the 10-minute auto-lock timer). These are two independent `clear()` calls, not one — `logout()` does not route through `endSession()` (a pre-existing structural fact this PRD's implementation surfaced and the reviewer confirmed is the only gap: those are the sole two places a session ends). Missing either would leave the vault key alive after the session token was supposed to be gone.
- This is what makes business rule 5 (10-minute auto-lock) actually lock the *vault*, not just expire the session token: once cleared, the AES key cannot be reconstructed without the master password again — there is no cached/wrapped form to fall back on, by design.

## Alternatives considered

- **A random vault key, wrapped by a KDF-derived key (rotatable-key design).** A per-vault random AES key generated once, encrypted at rest by a key derived from the master password; changing the password only re-wraps that one small key, leaving every item's ciphertext untouched. This is the standard design for exactly the problem direct KDF has (password-reset consequence). Rejected for PRD 0019's scope: it needs a new column (the wrapped key, plus its own IV/tag) and key-wrapping/unwrapping logic on every unlock — real, if small, new infrastructure and schema surface, which this PRD was explicitly scoped to avoid. Noted here so it is not silently reconsidered later without deliberately weighing in again; it is the natural fix for the accepted consequence above, whenever that becomes a priority.
- **A random per-user salt column instead of an email-derived salt.** Stronger in the general case (defeats an attacker who has both the salt and a rainbow table built specifically against this deployment), but needs a new `USERS` column and a migration. Rejected for the same "no schema change" scope constraint; flagged as a known, deliberate simplification, not a permanent architectural stance — a future PRD could add a real random salt column without touching the direct-KDF decision above.
- **Server-side encryption (the shape `DATABASE.md`'s `CREDENTIALS.password_iv`/`password_tag` columns actually imply).** Never seriously on the table: it would mean the server holds plaintext at some point, which is the definition of not zero-knowledge. Mentioned only because those columns exist unused in the schema — see `ports/credentials.js`'s own comment on them, and PRD 0009/0014's reconciliation-gap note, both unchanged by this decision.

## Consequences

- **The KDF iteration count is a parameter to revisit, not a constant to trust indefinitely.** This PRD's own first implementation cited "≥210,000 iterations" — OWASP's PBKDF2-**SHA-512** figure — while actually deriving with SHA-256, whose corresponding OWASP number is 600,000. That mismatch was caught in security review and corrected before sign-off (see [PRD 0019's Outcome](../action_plan/0019-credential-vault-ui-and-encryption.md#outcome)). The lesson generalizes: whoever next touches `vault-crypto.js` must re-check the iteration count against current OWASP guidance for the specific hash in use, not copy a number from memory.
- **Non-extractable key as defense-in-depth, not the primary control.** `extractable: false` means even a same-tab arbitrary-code-execution attacker who obtains a reference to the `CryptoKey` cannot export its raw bytes via `crypto.subtle.exportKey`. It does not protect against an attacker who can simply call `encrypt`/`decrypt` through the same reference, or one who compromises the master password itself. It costs nothing and closes off one exfiltration path, so there is no reason to ever set it `true`.
- **Losing the master password (recoverable only via reset) now has a real, permanent cost** it didn't have before this PRD: every credential saved under the old key becomes unreadable. This is the direct consequence of the direct-KDF choice, explicitly accepted above, and must be re-surfaced to the user in-product (a UX warning on the reset flow) as a follow-up — not yet built as of this ADR.
- **Changing a user's registered email would break decryption**, for the identical structural reason (the salt is derived from the email). There is no email-change feature today, so this is a known, currently-inert simplification, not a live bug — but any future PRD that adds email-change must account for it, exactly as it must account for the password-reset consequence.
- **This is now the load-bearing implementation of the "zero-knowledge" claim** in `docs/architecture/overview.md`. A future change to `vault-crypto.js`, `vault-key-store.js`, or the session-ending paths that clear it should be reviewed against this ADR, not just against the code it touches.

## Related

- [PRD 0019 — Credential Vault: Client-Side Encryption + List/Add/View/Edit/Delete UI](../action_plan/0019-credential-vault-ui-and-encryption.md) — the PRD this ADR was written for; its Outcome section records the two review-driven corrections (KDF iteration count, list-endpoint audit gap) folded into this design.
- [`client/src/services/vault-crypto.js`](../../client/src/services/vault-crypto.js) — `deriveVaultKey`/`encryptField`/`decryptField`, including the header comment this ADR's parameters are drawn from.
- [`client/src/services/vault-key-store.js`](../../client/src/services/vault-key-store.js) — the in-memory key store.
- [ADR 0010 — In-memory session-token storage](0010-in-memory-session-token-storage.md) — the precedent this key store's discipline mirrors.
- [PRD 0015](../action_plan/0015-password-reset-flow.md) / [ADR 0014](0014-totp-based-password-reset.md) — the reset flow whose "re-hash only" design is the source of the accepted password-reset consequence.
- [`docs/architecture/overview.md`](../architecture/overview.md) — the "zero-knowledge" claim this decision makes concrete.
- [`docs/action_plan/DATABASE.md`](../action_plan/DATABASE.md) — `ports/credentials.js`'s comment on the unused `password_iv`/`password_tag` placeholder columns, an unrelated but adjacent reconciliation gap this ADR does not resolve.
