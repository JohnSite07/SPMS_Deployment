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

The most security-critical interaction, including failures. [PRD 0023](../action_plan/0023-two-step-login-screens.md) realizes this as **two screens** with an in-memory handoff between them, rather than one combined form — see [Login.jsx](../../client/src/pages/Login.jsx) and [TwoFactorVerify.jsx](../../client/src/pages/TwoFactorVerify.jsx):

1. **Step 1 — `/login`**: email + master password. Submitting does **not** call the server (there is no password-only verification endpoint — see the reconciliation note below); it parks `{ email, password }` in [`pending-login.js`](../../client/src/services/pending-login.js) — module state only, never router state or web storage, matching [ADR 0010](../decisions/0010-in-memory-session-token-storage.md)'s posture for the session token — and advances to step 2 unconditionally.
2. **Step 2 — `/login/2fa`**: the 6-digit code. Submitting makes the single `POST /api/session` call with email + password + code together.
3. An invalid password, an invalid code, an unknown email, or a locked account all produce the **same generic failure**, shown once on step 2 (the `deny()` pattern in `app/src/routes/session.js`), and each **increments the attempt counter**.
4. The **fifth failure locks the account for fifteen minutes** (matches the business rule in [functional-requirements.md](../requirements/functional-requirements.md) and CLAUDE.md) — enforced entirely server-side, independent of which step the user is looking at.
5. Only after **both factors pass** does the system create a session, unlock the vault, and log the event.
6. Reaching `/login/2fa` directly — a deep link or a refresh, where the in-memory handoff does not survive — redirects back to `/login` instead of showing an unusable code form.

**Reconciling with the PDF wireframe:** the source design (Figure 9) shows master password and 2FA code as fields on one screen, and this page's original wording ("a valid master password advances to the second factor") described that as a single validation step. The two-screen client keeps the *flow* — password first, then code — but not a validation boundary in between: `Login.jsx` has no way to check the password itself (no password-only endpoint exists, and adding one would reopen the account-enumeration oracle the generic 401 closes — see PRD 0023's *Additional considerations*), so it advances unconditionally and the actual pass/fail check happens once, on step 2's submit, against both factors together.

## The six screens (§2.4)

The six wireframes in the PDF cover all five use cases (UC-01–UC-05) plus the dashboard's navigation-hub role; the client implements the first wireframe (Login & 2FA) as **two screens/routes** (step 1 and step 2 above), so the table below has seven rows. See [functional-requirements.md](../requirements/functional-requirements.md) for the use cases themselves, and [`client/src/App.jsx`](../../client/src/App.jsx) for the route table.

| Screen | Use case | Route | Notes |
| --- | --- | --- | --- |
| Master Password (login step 1) | UC-01 Log In | `/login` | Email + master password; advances unconditionally — see the reconciliation note above. |
| Two-Factor Verification (login step 2) | UC-01 Log In | `/login/2fa` | 6-digit code; the single `POST /api/session` call; one generic failure message; redirects to `/login` if reached without a step-1 handoff. |
| Vault Dashboard | Navigation hub | `/` | Credential list; every core task is one tap away, per the navigation map. |
| Add / Edit Credential | UC-02 Add Credential | `/` (modal) | Inline password generator + live strength meter. |
| View Credential | UC-03 Retrieve Credential | `/` (modal) | Reveal toggle, copy-to-clipboard (30-second auto-clear), delete confirmation. |
| Secure Documents | UC-04 Store Sensitive Document | `/documents` | States file type/size limits up front (error prevention). |
| Password Health | UC-05 Analyze Password Health & Notify | `/health` | Report + risk alerts; single headline score, colour-coded status. |

## How this drives implementation

These guidelines are what [ADR 0011](../decisions/0011-design-system-baseline.md) (the react-bootstrap + SASS design-system baseline) exists to serve, and what future screen-building PRDs should check their work against — the design-system baseline gives consistent primitives, but matching a specific wireframe's layout and satisfying all ten principles is a per-screen responsibility. For pixel-level layout, callouts, and the wireframe images themselves, read the PDF directly; this page only tracks the decisions and mappings.

## Related

- [ADR 0011 — Design-system baseline](../decisions/0011-design-system-baseline.md) — react-bootstrap + SASS token file, the component/styling layer these guidelines drive.
- [ADR 0009 — Frontend stack and serving model](../decisions/0009-frontend-stack-and-serving-model.md) — the SPA these screens are built into.
- [ADR 0010 — In-memory session-token storage](../decisions/0010-in-memory-session-token-storage.md) — the storage posture `pending-login.js` follows for the step 1 → step 2 handoff.
- [PRD 0023 — Two-step login screens](../action_plan/0023-two-step-login-screens.md) — the split of UC-01's login into `/login` and `/login/2fa`, and the full rationale for step 1 making no network call.
- [requirements/functional-requirements.md](../requirements/functional-requirements.md) — UC-01–UC-05, the use cases each screen realizes.
- [architecture/system-design-summary.md](system-design-summary.md) — the wider Part I/II/IV summary this page's source section (Part I §2) sits inside.
- [docs/milestones/SecureVault_Milestone4_System_Design.pdf](../milestones/SecureVault_Milestone4_System_Design.pdf) — the authoritative source (Part I §2, pages 18–25).
