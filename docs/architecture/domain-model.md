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
| **AuditEntry** | A single logged action. `–entryId`, `–action`, `–timestamp`, `–ipAddress`. |
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
- `AuditLog` / `AuditEntry` are **append-only** — the schema and access layer must forbid update/delete by users (business rule 7).
- `Vault.autoLockMinutes` defaults to the 10-minute auto-lock rule (business rule 5).

See [requirements/functional-requirements.md](../requirements/functional-requirements.md) for the use cases these classes serve and the full business-rule list.
