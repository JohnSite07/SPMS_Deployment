# Frontend Rule

How the SecureVault client (`client/`) is built, so every contributor — human or AI agent — produces consistent, secure UI. These rules are **strictly followed**: the ones marked *[lint]* fail CI's `client-checks` job and cannot be merged; the rest are enforced by review and the `app-engineer` agent.

## Read before building any UI

- **Design & UX** → [docs/architecture/ui-ux-guidelines.md](../../docs/architecture/ui-ux-guidelines.md) (the ten principles, navigation map, login/2FA flow, and the six screens), distilled from the **authoritative** milestone spec `docs/milestones/SecureVault_Milestone4_System_Design.pdf` Part I §2 — whose wireframe *images* (Figures 9–14) live only in the PDF. Build the six screens to those wireframes.
- **Binding decisions** → ADR [0009](../../docs/decisions/0009-frontend-stack-and-serving-model.md) (React/Vite stack + Express serves the SPA), [0010](../../docs/decisions/0010-in-memory-session-token-storage.md) (in-memory token), [0011](../../docs/decisions/0011-design-system-baseline.md) (react-bootstrap + SASS tokens).

## Rules

1. **Components come from react-bootstrap.** Do not hand-roll buttons/forms/modals/tables or add a second UI library. Cross-screen consistency (principle "Consistency and standards") is the reason.
2. **Design tokens live in one place** — [client/src/styles/theme.scss](../../client/src/styles/theme.scss) (Bootstrap SASS variables). Do **not** hardcode hex colours or ad-hoc fonts/spacing in components; change a token in `theme.scss` instead. *(Enforced by review; a stylelint gate is the planned mechanical enforcement.)*
3. **All API calls go through** [client/src/services/api-client.js](../../client/src/services/api-client.js) (`get/post/put/del`) — never `fetch()` directly. *[lint]*
4. **The session token is in-memory only** ([token-store.js](../../client/src/services/token-store.js)). Never `localStorage`, `sessionStorage`, or cookies. *[lint]*
5. **Base URL is the relative `/api`** (same-origin, Express serves the SPA). No absolute backend URLs, no `VITE_API_BASE_URL`.
6. **Secure-by-default UI** (principle 10): mask secrets by default; copy rather than display, with a 30-second clipboard clear; confirm irreversible actions; make the 10-minute auto-lock visible.
7. **Tests + green gates.** Every service/behaviour gets a Vitest test; `npm run lint`, `npm test`, and `npm run build` must pass.

## Enforcement

- **ESLint** ([client/eslint.config.js](../../client/eslint.config.js)) bans raw `fetch` outside `api-client.js` and bans `localStorage`/`sessionStorage` — violations fail the PR's `client-checks` job.
- **Review** (`infra-reviewer`) and the **`app-engineer`** agent enforce the component, design-token, and wireframe rules that lint can't express.
