# System Design Summary — Developer-Team Scope (Parts I, II, IV)

Awareness summary of the application-side parts of the Milestone 4 System Design (`docs/milestones/SecureVault_Milestone4_System_Design.pdf`), so the DevOps team has context without reading the full 66-page document.

## Ownership split

The M4 System Design document has four parts. This repo (`SPMS_Deployment`) and this docs tree own only **Part III — System Architecture & Security: Cloud Deployment & DevOps** (provisioning and deployment). Part III matches the existing deployment spec already reflected in [architecture/overview.md](overview.md), [deployment/](../deployment/), and [decisions/0001](../decisions/0001-platform-and-tooling.md) — no changes were needed there.

**Parts I, II, and IV belong to the Developer team**: application coding (Part I), database schema design (Part II), and executing the test plan (Part IV). This DevOps team does not own or maintain that content; the summaries below exist only so infrastructure work stays informed of the application shape it is hosting.

## Part I — Software Design & UI/UX (Developer team)

- **Layered architecture**: presentation → business logic (domain classes) → data access, matching the three-layer pattern.
- **Controllers**: `AuthController`, `VaultController`, `HealthController` receive requests and orchestrate the domain classes (MVC-style).
- **DAOs**: `UserDAO`, `VaultItemDAO`, `AuditDAO` isolate all SQL from the domain classes.
- **CryptoService**: a single facade for AES-256 encryption and password hashing — the code-level enforcement point for the zero-knowledge boundary described in [overview.md](overview.md#zero-knowledge-posture-the-central-design-constraint).
- **Session**: a stateless, signed, time-limited token backing the 10-minute auto-lock.
- Five use-case sequence diagrams realize UC-01–UC-05 (Log In, Add Credential, Retrieve Credential, Store Sensitive Document, Analyze Password Health & Notify) using these classes.
- UI/UX: a navigation map hubbed on the Vault Dashboard, a login + 2FA flow (including the 5-failure/15-minute lockout path), and six wireframes (Login/2FA, Vault Dashboard, Add/Edit Credential, View Credential, Secure Documents, Password Health).
- This extends the 14-class domain model in [domain-model.md](domain-model.md) with design-only classes (controllers, DAOs, CryptoService) — the domain classes and business rules themselves are unchanged.

## Part II — Database Architecture (Developer team)

- MySQL 8, InnoDB, `utf8mb4`. Naming: tables `UPPER_SNAKE_CASE` plural, columns `lower_snake_case`, constraints `PK_`/`FK_`/`UQ_`/`CK_`, indexes `IX_`.
- **11 tables**: `USERS`, `VAULTS`, `VAULT_ITEMS`, `CREDENTIALS`, `SECURE_DOCUMENTS`, `TWO_FACTOR_CONFIGS`, `SESSIONS`, `AUDIT_ENTRIES`, `PASSWORD_HEALTH_REPORTS`, `REPORT_FINDINGS`, `SECURITY_ALERTS`.
- **Class-table inheritance** for `VaultItem`: a `VAULT_ITEMS` supertype table plus `CREDENTIALS` and `SECURE_DOCUMENTS` subtype tables sharing the same primary key, with `item_type` as discriminator.
- Every encrypted field (`encrypted_password`, `encrypted_blob`, 2FA `secret_enc`) is stored as AES-256-GCM ciphertext with its own IV and authentication-tag columns; master password is a salted hash only; session tokens are stored as SHA-256 hashes, never raw.
- `AUDIT_ENTRIES` is enforced append-only at the DB-role level (app role granted only `INSERT`/`SELECT`).
- Full DDL lives in the milestone PDF (Part II, §4); this repo does not currently define or manage the application schema — that is Developer-team-owned code, applied to whatever Cloud SQL instance DevOps provisions.

## Part IV — System Test Plan (Developer team)

- IEEE-829 format, identifier `TP-SecureVault-STP-V1.0`.
- **48 test cases** across modules: `TC-AUTH-*`, `TC-VAULT-*`, `TC-PWGEN-*`, `TC-HEALTH-*`, `TC-DOC-*`, `TC-AUDIT-*`, `TC-SEC-*`, `TC-UI-*`.
- **Testing window**: July 1–25, 2026 (four weeks), scheduled in weekly cycles (environment setup → Auth/Session → Vault/Generator/Health/Documents → Encryption/Security/UI → triage & closure).
- **Tooling**: Bugzilla (defect tracking), Postman (API testing), Chrome DevTools (network/TLS/timing), MySQL Workbench (DB inspection), GitHub (test-artifact version control).
- **Environment**: Chrome desktop only (non-Chrome browsers explicitly out of scope this cycle); Node.js 20+, MySQL 8+.
- Known blockers called out in the plan itself: `TC-AUTH-09`/`TC-AUTH-10` (2FA) pending the TOTP sprint; `TC-DOC-*` (Secure Documents) pending UC-04 implementation.
- This is executed entirely by the Developer/QA side; DevOps involvement is limited to keeping the deployed environment (HTTPS endpoint, Cloud SQL Studio access for `TC-SEC-*` DB inspection — see [ADR 0004](../decisions/0004-human-db-access-cloud-sql-studio.md)) available during the window.

## Open cross-team items / known inconsistencies

These three items were found reading the full PDF against the rest of this repo's docs. **All three are Developer-team decisions** — they are listed here as open items for awareness, not as resolved decisions.

1. **Document blob storage conflict.** Part II's DDL stores document ciphertext as `SECURE_DOCUMENTS.encrypted_blob LONGBLOB` inside Cloud SQL, while Part III and this repo's own docs ([overview.md](overview.md)) describe encrypted document blobs going to a Cloud Storage bucket. Owner: Developer team. **DevOps-side implication:** no change either way — the Cloud Storage buckets are provisioned regardless, since the state bucket is required for Terraform remote state and the document bucket stays available for the Developer team to use if they choose the Cloud Storage path.

2. **Server-side vs. client-side encryption contradiction.** Parts I–III design a server-side `CryptoService` that reads the AES key from Secret Manager and encrypts/decrypts on the server. Part IV's "Features to be Tested" and several test cases (`TC-VAULT-03`, `TC-DOC-05`, `TC-SEC-04`) instead assert client-side / end-to-end encryption (e.g. "all data must be encrypted client-side before storage"; "reviewed... for any master password or [plaintext]... zero-knowledge architecture"). Owner: Developer team. **DevOps-side implication:** none — Secret Manager, Cloud Run, and the rest of the provisioned stack are unaffected regardless of which encryption boundary the Developer team ultimately implements.

3. **React/Vite frontend.** Part IV §8.1 states the deployed application under test has a "frontend (React/Vite), backend (Node.js/Express), and database (MySQL)" — a frontend framework not mentioned anywhere else in the repo docs or Parts I–III. Owner: Developer team. **DevOps-side implication:** possible pipeline change — if confirmed, the CD build step (`docker buildx build`, see [deployment/README.md](../deployment/README.md)) may need an added Vite build stage ahead of the container build. Not yet reflected in any workflow; treat as pending until the Developer team confirms the frontend stack.

## Cross-links

- [architecture/overview.md](overview.md) — this repo's owned Part III shape (unaffected by the above).
- [architecture/domain-model.md](domain-model.md) — the Milestone 3 domain model that Part I's design classes and Part II's schema both derive from.
- [requirements/functional-requirements.md](../requirements/functional-requirements.md) — the use cases (UC-01–UC-05) that Part I's sequence diagrams and Part IV's test cases both trace back to.
- [docs/milestones/SecureVault_Milestone4_System_Design.pdf](../milestones/SecureVault_Milestone4_System_Design.pdf) — full source document (66 pages, four parts).
- [docs/deployment/README.md](../deployment/README.md) — pending pipeline note tied to item 3 above.
