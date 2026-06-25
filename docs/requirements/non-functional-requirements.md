# Non-Functional Requirements

Quality attributes, constraints, and scope. Source: Milestone 3 §D and Milestone 2 (scope). These are measurable targets the design and implementation must meet.

## Quality attributes ("ilities")

| Quality | Requirement |
| --- | --- |
| Security | AES-256 at rest, TLS in transit, hashed master password, and 2FA. |
| Confidentiality | Zero-knowledge design; the server never sees plaintext passwords. |
| Integrity | Encryption and an append-only audit log prevent silent tampering. |
| Reliability | Errors handled gracefully with no loss of stored data. |
| Availability | Target **99% uptime** during use and demos. |
| Usability | Clean interface; core tasks in **three clicks or fewer**. |
| Performance | Vault unlock and search complete in **under two seconds**. |
| Maintainability | Modular, documented code under version control. |
| Scalability | Architecture supports future multi-user expansion without redesign. |
| Serviceability | Errors logged and surfaced to the administrator with clear diagnostics. |

## Constraints

- Built within the academic term, with limited team hours and mixed skill levels.
- Free, open-source tooling only: Node.js, Express, MySQL (M3 allowed "MySQL or MongoDB"; **MySQL was locked in at M4** — see [0001](../decisions/0001-platform-and-tooling.md)), GitHub.
- No specialized hardware for build, test, or demo.
- Web-based and **single-user in scope** — no enterprise or commercial deployment.

## Scope (Milestone 2 charter)

**In scope:** secure login & registration · password hashing & encryption · password vault storage · password generator · password strength analysis · secure file storage · 2FA · audit logging.

**Out of scope:** banking/payment processing · enterprise IAM · AI-based threat detection · browser-extension integration · third-party enterprise integrations · commercial deployment · real-time enterprise monitoring.

> The M4 deployment (Cloud Run, Cloud SQL, etc.) supports this single-user academic scope. "Scalability — supports future multi-user expansion" is a design quality, not a current deliverable; don't build multi-tenancy now, but don't foreclose it.

## Standards referenced

NIST SP 800-63B (digital identity / authentication), FIPS 197 (AES), ISO/IEC 27001 (information security management), UML 2.5 (modelling), OWASP Password Storage guidance.
