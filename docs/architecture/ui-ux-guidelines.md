# UI/UX Guidelines

Distilled reference for SecureVault's interface design, so screen-building work has a stable, linkable source instead of re-reading the source PDF each time.

> **Authoritative source:** [`docs/milestones/SecureVault_Milestone4_System_Design.pdf`](../milestones/SecureVault_Milestone4_System_Design.pdf), Part I §2 ("User Interface / User Experience Design"). This page is a **distillation** for quick reference — where it diverges from the PDF, the PDF wins. The **wireframe images** (Figures 9–14) exist only in the PDF; this page does not reproduce them, only the design decisions and use-case mapping around them.

## The ten design principles (§2.1)

The interface follows standard usability heuristics, extended with a secure-by-default principle for vault data. Each principle maps to a concrete decision applied across the wireframes:

| Principle | Application in SecureVault |
| --- | --- |
| Visibility of system status | A persistent auto-lock countdown and encrypting/loading indicators keep the user aware of system state. |
| Match to the real world | Plain vocabulary ("vault", "credential", "document") instead of technical jargon. |
| User control and freedom | A reveal toggle on every password, a Cancel action on every form, and Back navigation from each screen. |
| Consistency and standards | A shared header, button styles, and iconography across all screens — see [ADR 0011](../decisions/0011-design-system-baseline.md), the design-system baseline that implements this. |
| Error prevention | Field validation before save, a live strength meter, and stated file type/size limits stop errors before they happen. |
| Recognition over recall | Inline colour-coded health status, search, and a single headline score remove the need to remember details. |
| Flexibility and efficiency | Flat bottom navigation and an inline generator keep every core task within three clicks. |
| Aesthetic and minimalist design | Each screen shows only the fields its task requires. |
| Help users recover from errors | Non-security errors explain the exact cause and fix — e.g. a rejected file states the size limit. |
| Secure by default (domain-specific) | Secrets are masked by default; copied rather than displayed, with the clipboard cleared after 30 seconds (§4 refinement); irreversible actions require confirmation. |

## Navigation map (§2.2)

After the two-step login, the **Vault Dashboard** is the hub: every core task is one tap away and returns there. Two transitions are security-driven:

- The password **generator opens from the credential form** (not a standalone destination).
- **Inactivity beyond ten minutes — or logout —** returns to login.

## Login & 2FA flow (§2.3)

The most security-critical interaction, including failures:

1. A valid master password advances to the second factor.
2. An invalid password or code **increments the attempt counter**.
3. The **fifth failure locks the account for fifteen minutes** (matches the business rule in [functional-requirements.md](../requirements/functional-requirements.md) and CLAUDE.md).
4. Only after **both factors pass** does the system create a session, unlock the vault, and log the event.

## The six screens (§2.4)

Together the six wireframes cover all five use cases (UC-01–UC-05) plus the dashboard's navigation-hub role. See [functional-requirements.md](../requirements/functional-requirements.md) for the use cases themselves.

| Screen | Use case | Notes |
| --- | --- | --- |
| Login & Two-Factor Verification | UC-01 Log In | Realizes the login/2FA flow above, including the lockout path. |
| Vault Dashboard | Navigation hub | Credential list; every core task is one tap away, per the navigation map. |
| Add / Edit Credential | UC-02 Add Credential | Inline password generator + live strength meter. |
| View Credential | UC-03 Retrieve Credential | Reveal toggle, copy-to-clipboard (30-second auto-clear), delete confirmation. |
| Secure Documents | UC-04 Store Sensitive Document | States file type/size limits up front (error prevention). |
| Password Health | UC-05 Analyze Password Health & Notify | Report + risk alerts; single headline score, colour-coded status. |

## How this drives implementation

These guidelines are what [ADR 0011](../decisions/0011-design-system-baseline.md) (the react-bootstrap + SASS design-system baseline) exists to serve, and what future screen-building PRDs should check their work against — the design-system baseline gives consistent primitives, but matching a specific wireframe's layout and satisfying all ten principles is a per-screen responsibility. For pixel-level layout, callouts, and the wireframe images themselves, read the PDF directly; this page only tracks the decisions and mappings.

## Related

- [ADR 0011 — Design-system baseline](../decisions/0011-design-system-baseline.md) — react-bootstrap + SASS token file, the component/styling layer these guidelines drive.
- [ADR 0009 — Frontend stack and serving model](../decisions/0009-frontend-stack-and-serving-model.md) — the SPA these screens are built into.
- [requirements/functional-requirements.md](../requirements/functional-requirements.md) — UC-01–UC-05, the use cases each screen realizes.
- [architecture/system-design-summary.md](system-design-summary.md) — the wider Part I/II/IV summary this page's source section (Part I §2) sits inside.
- [docs/milestones/SecureVault_Milestone4_System_Design.pdf](../milestones/SecureVault_Milestone4_System_Design.pdf) — the authoritative source (Part I §2, pages 18–25).
