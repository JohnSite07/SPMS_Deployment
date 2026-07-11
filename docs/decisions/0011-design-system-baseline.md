# 0011 — Design-system baseline: react-bootstrap + a single SASS token file

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** htuazon (with Claude)

## Context

SecureVault's SPA (`client/`, [ADR 0009](0009-frontend-stack-and-serving-model.md)) is about to grow six screens across two more PRDs. The milestone UI/UX spec (System Design PDF, Part I §2.1 — "Design Principles Applied") explicitly names **"Consistency and standards"** as one of the ten interface principles and states its concrete application: *"A shared header, button styles, and iconography are used across all screens."* Building six screens by hand-styling each one risks exactly the inconsistency this principle rules out, and there was no existing UI component or styling layer in `client/` to build on.

This is a small academic project on a fixed deadline ([PRG800](../milestones/README.md)), so the chosen path also has to be the simplest one that satisfies the principle — not the most sophisticated one.

## Decision

Use **react-bootstrap** (Bootstrap 5's React component bindings) as the SPA's component library, themed by a single **SASS token file**, `client/src/styles/theme.scss`. That file sets a small set of Bootstrap SASS variable overrides (e.g. `$primary`, `$border-radius`, `$font-family-sans-serif`) before `@import "bootstrap/scss/bootstrap"`, compiled by Vite's built-in SASS support, and is loaded exactly once, app-wide, from [`client/src/main.jsx`](../../client/src/main.jsx).

No components are hand-built. Screens (built in later PRDs, per [PRD 0013](../action_plan/0013-design-system-baseline.md)) import react-bootstrap components (`Button`, `Form`, `Modal`, etc.) per-use as each screen is written; nothing is pre-scaffolded for them.

## Alternatives considered

- **shadcn/ui** — a modern, copy-in component set with a real design-token system. Rejected: it is built on Tailwind CSS and a different composition model (Radix primitives + owned component source), which means adopting a second styling paradigm and a new mental model on top of the Vite/React setup already in place, for a project with no styling investment yet to protect. More setup than the timeline justifies.
- **Hand-rolled design tokens + hand-built components in SASS** — maximum control over exactly what ships. Rejected: it reinvents buttons, forms, modals, and layout primitives that a mature component library already provides, for no requirement this project has that a library can't meet. Most work, least leverage.
- **Plain precompiled Bootstrap CSS (no SASS layer)** — works and is simpler to wire (one `import 'bootstrap/dist/css/bootstrap.min.css'` line). Rejected in favour of the SASS route because it gives no single-source place to override tokens — every deviation from Bootstrap's defaults would mean overriding compiled CSS after the fact rather than setting a variable once, undermining the "single place that defines our colours/radius/fonts" goal the design-system baseline exists to satisfy.

## Consequences

- **Consistency by default.** Every screen that imports a react-bootstrap component automatically matches the shared header/button/iconography look the principle requires, without each screen owning its own styling decisions.
- **Bundle cost.** Bootstrap's compiled CSS adds roughly 25–30 KB gzip to the SPA's static bundle. This is a static asset Cloud Run already serves — no new GCP resource, no meaningful cost against the $300 budget ([PRD 0013](../action_plan/0013-design-system-baseline.md), Resources table). react-bootstrap's JS is tree-shaken per component, so it costs nothing until a screen actually imports something.
- **A generic "Bootstrap look."** Accepted for this project — the milestone principle asks for consistency, not a bespoke visual identity, and a generic-but-consistent UI is a better outcome under this timeline than a bespoke-but-uneven one.
- **Selective SASS imports remain an option later.** `theme.scss` currently does a full `@import "bootstrap/scss/bootstrap"`; swapping to Bootstrap's partial/selective imports to trim unused CSS is a non-breaking optimization if bundle size ever becomes a concern — out of scope for this decision ([PRD 0013](../action_plan/0013-design-system-baseline.md), Out of scope).
- **Screens must still follow the wireframes and principles**, not just the component library. The token layer gives consistent primitives; it does not by itself guarantee a screen matches its wireframe (System Design §2.4) or every one of the ten principles (§2.1) — see [ui-ux-guidelines.md](../architecture/ui-ux-guidelines.md), which screen-building PRDs should treat as the checklist.
- No infrastructure, Terraform, or `app/` change — this is client-only, consistent with [PRD 0013](../action_plan/0013-design-system-baseline.md)'s scope.

## Related

- [PRD 0013 — Design system baseline](../action_plan/0013-design-system-baseline.md) — the plan this ADR was written under.
- [ADR 0009 — Frontend stack and serving model](0009-frontend-stack-and-serving-model.md) — the React/Vite/Express-served SPA this design system is layered onto.
- [ADR 0010 — In-memory session-token storage](0010-in-memory-session-token-storage.md) — the other SPA-layer decision recorded alongside this one; unrelated concern (token storage vs. styling), same client.
- [architecture/ui-ux-guidelines.md](../architecture/ui-ux-guidelines.md) — the distilled principles, navigation map, login/2FA flow, and six-screen inventory this design system exists to serve.
- [`client/src/styles/theme.scss`](../../client/src/styles/theme.scss) — the implementation.
