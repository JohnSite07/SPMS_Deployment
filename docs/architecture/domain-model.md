# Domain Model

The object model that realises SecureVault's requirements. Source: Milestone 3, Part C (UML 2.5). This is the blueprint for the application's data model and core classes — when `app/` is built, the schema and domain types should follow this. Visibility: `–` private, `+` public.

## Classes

| Class | Purpose / key data |
| --- | --- |
| **User** | Account owner. `–userId`, `–email`, `–masterPasswordHash`, `–failedAttempts`, `–isLocked`. `+register()`, `+login()`, `+changeMasterPassword()`. |
| **Vault** | The user's encrypted container (one per user). `–vaultId`, `–autoLockMinutes`, `–isLocked`. `+lock()`, `+unlock()`, `+search()`. |
| **VaultItem** «abstract» | Base type for anything stored. `–itemId`, `–title`, `–createdAt`, `–updatedAt`. |
| **Credential** | A stored login (subtype of VaultItem). `–url`, `–username`, `–encryptedPassword`, `–lastChanged`. |
| **SecureDocument** | An encrypted sensitive file (subtype of VaultItem). `–fileName`, `–fileType`, `–fileSizeKB`, `–encryptedBlob`. |
| **TwoFactorConfig** | A user's second-factor method and secret. `–method {TOTP, Email}`, `–secret`, `–enabled`. `+verifyCode()`. |
| **Session** | An active, time-limited login session. `–sessionId`, `–token`, `–startedAt`, `–expiresAt`. |
| **AuditLog** | Append-only record of a user's actions. `–logId`. |
| **AuditEntry** | A single logged action. `–entryId`, `–userId`, `–action`, `–timestamp`, `–ipAddress`, and the two nullable association fields `–targetUserId` / `–actorUserId`. Implemented in [`app/src/models/audit-entry.js`](../../app/src/models/audit-entry.js); see the deviations noted below. |
| **PasswordHealthReport** | Result of scanning a vault. `–reportId`, `–generatedAt`, `–overallScore`. `+analyze()`. |
| **SecurityAlert** | A weak/reused-password notification. `–alertId`, `–type {Weak, Reused}`, `–message`, `–isRead`. |
| **PasswordGenerator** | Builds strong passwords to chosen rules. `–length`, `–includeSymbols`, `–includeNumbers`. `+generate()`. |
| **AuthenticationService** «external» | Third-party service that validates 2FA tokens. `+validateToken()`. |
| **EmailService** «external» | Third-party service that delivers verification/reset/alert emails. `+sendEmail()`. |

## Relationships

- **Inheritance** — `Credential` and `SecureDocument` are types of `VaultItem` and share its common fields.
- **Composition** (part cannot exist without its whole) — a `User` owns exactly one `Vault` and one `AuditLog`; a `Vault` is made up of its `VaultItem`s; an `AuditLog` is made up of its `AuditEntry`s.
- **Aggregation** — a `PasswordHealthReport` groups the `Credential`s it evaluates, but those exist independently of any report.
- **Associations** — a `User` has one optional `TwoFactorConfig`, opens many `Session`s, and uses the `PasswordGenerator`; a `Vault` is evaluated by many `PasswordHealthReport`s; a report raises many `SecurityAlert`s.
- **Dependencies** — `TwoFactorConfig` relies on the external `AuthenticationService` to validate tokens; `SecurityAlert` relies on the external `EmailService` to deliver messages.

## Implementation notes

- `masterPasswordHash` is the only credential-derived value persisted for the User — never the master password itself (business rule 1).
- `Credential.encryptedPassword` and `SecureDocument.encryptedBlob` are ciphertext at rest (AES-256). The data model must not provide a path that persists their plaintext.
- `AuditLog` / `AuditEntry` are **append-only** — the schema and access layer must forbid update/delete by users (business rule 7). How this is enforced in code is recorded in [ADR 0006](../decisions/0006-append-only-audit-log-enforcement.md).
- `Vault.autoLockMinutes` defaults to the 10-minute auto-lock rule (business rule 5). A freshly registered account's `Vault` row is created with `isLocked = TRUE` (`ports/vaults.js`'s `create()`, [PRD 0018](../action_plan/0018-welcome-and-registration.md)) — a vault nobody has ever logged into starts locked, matching UC-01's flow where "unlocked" is a post-login condition, never a starting state. **`Vault.isLocked` and `User.isLocked` are unrelated columns/concepts** — the former is the vault's own lock state (business rule 5), the latter is account lockout from five failed login attempts (business rule 1). `DATABASE.md`'s illustrative seed rows happen to show both `FALSE` for the same demo user, which is coincidence, not a rule the two columns must follow; PRD 0018's first implementation drew that (incorrect) inference and was corrected in review before merge.
- `TwoFactorConfig.enabled` starts `FALSE` (pending) and is only ever flipped to `TRUE` by a live TOTP code proving the holder has the secret — self-service enrollment (`POST /api/2fa/enroll` + `/confirm`) now lets a user satisfy UC-01's "2FA set up" precondition themselves, rather than it only being a seeded assumption. See [PRD 0017](../action_plan/0017-two-factor-enrollment.md) and [ADR 0012](../decisions/0012-two-factor-enrollment-separate-public-surface.md) (why enrollment is a separate public surface, not inferred from a failed login).

## AuditEntry: deviations from the M3 model

M3 gives `AuditEntry` four fields and derives the owning user from the `AuditLog` composition. The implementation adds three, each for a stated reason:

- **`userId`** — carried on the entry so a single row is self-describing when it reaches Cloud Logging, and so business rule 6 ("only their own vault") stays checkable without a join back to the log's owner.
- **`targetUserId` / `actorUserId`** — nullable, and meaningful only for the `audit_log.read` action introduced with the administrator's history view ([ADR 0008](../decisions/0008-in-app-admin-role.md)). An admin's read is recorded twice: once in the admin's log naming *whose* history was read (`targetUserId`), once in the read user's log naming *who* read it (`actorUserId`). Exactly one is set on any entry; an entry with both would claim to live in two logs, and one with neither would name nobody. Both are omitted from the serialised form when null, so an ordinary entry still serialises as exactly the five fields above.

`AuditEntry` deliberately has **no free-form `details`/`metadata` field.** An audit log that accepts arbitrary caller data is where plaintext passwords and decrypted blobs eventually land, and the zero-knowledge posture requires the server never hold those. Context that an action genuinely needs is added as a named, typed, reviewed field — as `targetUserId` and `actorUserId` were.

Two consequences of the model as built, both currently unresolved:

- **Device sightings are not audited.** `session-issuer.js` calls its `onDeviceSeen` hook synchronously and discards the return value, so it cannot be bound to the asynchronous audit writer without producing an unawaited promise. Recording them requires `issueSessionToken()` to become `async`.
- **A failed login against an unknown email writes no entry**, because an `AuditEntry` requires a `userId` and the `AuditLog` is composed into a `User`. Failed logins against real accounts *are* recorded, which is what the five-failure lockout counts.

The **`AUDIT_ENTRIES` table** that stores these entries (columns, types, the append-only grant, and the `ON DELETE RESTRICT` foreign key that keeps a deleted user's trail intact) is owned by the Developer team's schema; the reconciled shape and its rationale are captured alongside [ADR 0006](../decisions/0006-append-only-audit-log-enforcement.md).

See [requirements/functional-requirements.md](../requirements/functional-requirements.md) for the use cases these classes serve and the full business-rule list. Three implemented actions — `credential.updated`, `credential.deleted`, `session.ended` — have **no use case in M3**; the requirements owe them one (noted in [PRD 0008](../action_plan/0008-audit-log-and-vault-routes.md)).
