# Functional Requirements

What SecureVault does, expressed as triggering events, use cases, and the business rules that govern them. Source: Milestone 3, Parts B & D.

## Actors

- **End User** — primary actor; stores, generates, and manages credentials and documents.
- **System Administrator** — deploys and maintains the app; consumes audit logs and health reports.
- **Authentication Service (2FA)** «external» — issues/validates second-factor tokens (e.g. TOTP/FIDO2).
- **Email Service** «external» — delivers verification, reset, and security-alert emails.

## Event analysis

| # | Type | Trigger | Use case | Result |
| --- | --- | --- | --- | --- |
| 1 | External | User submits login + 2FA code | Log In | Authenticated session opened |
| 2 | External | User saves a new credential | Add Credential | Credential encrypted and stored |
| 3 | External | User opens a stored credential | Retrieve Credential | Credential decrypted and shown |
| 4 | External | User requests a new password | Generate Password | Strong password returned |
| 5 | External | User uploads a sensitive document | Store Document | Document encrypted and stored |
| 6 | External | User opens a stored document | Retrieve Document | Document decrypted and shown |
| 7 | Temporal | Idle timeout reached | Lock Vault | Session ended, vault locked |
| 8 | State | A saved password is weak | Notify User (Weak) | Weak-password alert shown |
| 9 | State | A password repeats a recent one | Notify User (Reused) | Reuse alert shown |

## Use case relationships

- `Verify 2FA Code` **«extend»** `Log In` — runs only when 2FA is enabled.
- `Notify User` **«extend»** `Analyze Password Health` — fires only when a risk is found.
- `Add Credential` and `Store Document` **«include»** `Encrypt Data` — encryption is always part of saving.
- Saving actions **«include»** `Record Audit Entry`; retrieval **«include»** `Decrypt Data`.

## Core use cases

### UC-01 Log In
A registered user signs in with a master password and a second factor to open the encrypted vault.
- **Pre:** registered account; 2FA set up. **Post:** secure session started, vault unlocked, login logged.
- **Flow:** enter email + master password → system verifies hash → request 2FA code → validate → decrypt and show vault, record login.
- **Exceptions:** wrong password/code → access denied; **five failures → account locked 15 minutes**.

### UC-02 Add Credential
A user saves a new login (site, username, password) into the encrypted vault.
- **Pre:** logged in, vault unlocked. **Post:** credential encrypted, stored, written to audit log.
- **Exceptions:** required field empty → save blocked; encryption fails → entry not saved.

### UC-03 Retrieve Credential
A user opens a stored credential and views or copies the password.
- **Pre:** logged in; entry exists. **Post:** decrypted credential shown; access logged.
- **Exceptions:** entry not found → message; decryption fails → access denied.

### UC-04 Store Sensitive Document
A user uploads a sensitive document (e.g. ID scan, recovery codes); the system encrypts and stores it.
- **Pre:** logged in, vault unlocked. **Post:** document encrypted, stored, logged.
- **Exceptions:** wrong file type or oversized → upload blocked; encryption fails → file not saved.

### UC-05 Analyze Password Health & Notify
The system checks stored passwords for weak strength and recent reuse, and notifies the user of risks.
- **Trigger:** user opens the health report, a saved password changes, or a scheduled scan runs.
- **Pre:** logged in; vault has ≥1 entry. **Post:** health report shown; user alerted to weak/reused passwords.
- **Exceptions:** empty vault → report shows no entries.

## Business rules

These are hard constraints the implementation must enforce (M3 §D.2):

1. The master password is **never stored** — only its hash is kept.
2. The master password must be **≥ 12 characters** and mix character types.
3. All vault data is **encrypted at rest (AES-256)** and sent over **TLS**.
4. **2FA is required** when logging in from a new device.
5. The vault **auto-locks after 10 minutes** of inactivity.
6. A user can access **only their own vault**.
7. The **audit log is append-only** and cannot be edited by users.
8. A password is flagged **weak** if too short or low in character variety.
9. A password is flagged when it **repeats another entry or one used in the last 30 days**.
10. Stored documents are encrypted at rest the same way as passwords (AES-256).
11. Uploaded documents are limited by type and size — **PDF or image, up to 10 MB**.

> Note: rule 1 (store only the hash) governs login verification, while the zero-knowledge posture additionally requires that vault *contents* be encrypted such that the server never holds plaintext. See [architecture/overview.md](../architecture/overview.md).
