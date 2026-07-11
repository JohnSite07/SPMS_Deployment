# 0013 — Design System Baseline (react-bootstrap + SASS theme)

Stands up the frontend's visual foundation — react-bootstrap plus a single SASS theme file of design tokens — loaded app-wide, with **no components or screens built**. Later screen PRDs then import ready-made components that already match the theme.

| | |
| --- | --- |
| **Status** | Done |
| **Date** | 2026-07-10 |
| **Author** | htuazon (with Claude) |

> **Written before execution**, per [`.claude/rules/action-plan.md`](../../.claude/rules/action-plan.md) — the approval gate applies. Developer-team-owned **frontend work**, building on the scaffold ([0010](0010-react-frontend-scaffold.md)) / serving ([0011](0011-frontend-serving-and-cd-integration.md)) / API layer ([0012](0012-frontend-api-client-foundation.md)). **Client code only** — no `app/`, no Terraform, no GCP resource, nothing billable. Driven by the milestone UI/UX spec (System Design PDF, Part I §2), which mandates "a shared header, button styles, and iconography across all screens" — exactly what a themed component library provides.

## User story

As a Developer about to build SecureVault's screens, I want one standardized design baseline — a component library plus a single place that defines our colours/radius/fonts — already loaded app-wide, so that every screen I build is visually consistent by default (milestone principle "Consistency and standards") without me hand-crafting or re-styling buttons, forms, and tables.

## Scope

**In scope:**
- Add **`react-bootstrap`** (JS components) + **`bootstrap`** (CSS/SASS source) as dependencies, and **`sass`** as a dev dependency so Vite can compile the theme.
- **One design-token file** — `client/src/styles/theme.scss` — that sets a small set of Bootstrap SASS variables (the tokens: e.g. `$primary`, `$border-radius`, `$font-family-sans-serif`) **before** `@import "bootstrap/scss/bootstrap";`. This single, editable file *is* the standardized token layer.
- Load it **once, app-wide** via a single `import './styles/theme.scss';` in [client/src/main.jsx](../../client/src/main.jsx).
- Verify the theme compiles and Bootstrap's styles are present in the production build, and the existing app still builds/lints/tests clean.

**Out of scope:**
- **Any component or screen** — no `Button`/`Form`/`Table`/`Modal` usages, no converting `Layout` or the placeholder pages. react-bootstrap components are imported per-use **when screens are built** (later PRDs); nothing is "scaffolded" for them here.
- **Implementing the wireframes** (System Design §2.4) or the navigation map — those are the screen PRDs.
- **Custom/bespoke components**, an icon set, or a full token system beyond the handful of Bootstrap variable overrides.
- **CSS trimming/tree-shaking of Bootstrap** — the simplest full `@import` is used; selective imports are a later optimisation if bundle size ever matters.
- Any `app/` change.

## Success criteria

- [ ] `npm install` (react-bootstrap, bootstrap; dev: sass) completes clean.
- [ ] `client/src/styles/theme.scss` compiles (Vite/sass) with the token overrides applied; `npm run build` exits 0.
- [ ] The production build's CSS contains Bootstrap output (e.g. a `.btn` / `.container` rule is present in `dist/assets/*.css`).
- [ ] `main.jsx` imports the theme exactly once; running the app shows Bootstrap's baseline (reset/typography) applied to the existing placeholder pages — observable proof the theme loaded, with no page edited.
- [ ] Changing a token (e.g. `$primary`) in `theme.scss` and rebuilding changes the compiled CSS — proving it's a real, single-source token layer.
- [ ] `npm run lint` exits 0 and the existing client tests (15, from [0012](0012-frontend-api-client-foundation.md)) still pass.
- [ ] No component or screen file was added or converted; `Layout` and the six pages are byte-unchanged.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `client/package.json` | Modified — add `react-bootstrap`, `bootstrap`; dev `sass` | None |
| `client/src/styles/theme.scss` | New — token overrides + Bootstrap import | None |
| `client/src/main.jsx` | Modified — one `import './styles/theme.scss'` line | None |
| Bundle CSS | Grows by Bootstrap's compiled CSS (~25–30 KB gzip) | None (static asset served by Cloud Run; no new resource) |
| react-bootstrap JS | Tree-shaken per-component; ~0 until a screen imports one | None |

References: **System Design PDF, Part I §2 (UI/UX)** — the driver; distilled into `docs/architecture/ui-ux-guidelines.md` by this PRD's doc step · [ADR (react-bootstrap choice)](../decisions/) — written by this PRD · business rule/principle "Consistency and standards" · [react-bootstrap](https://react-bootstrap.github.io/) · [Bootstrap SASS customization](https://getbootstrap.com/docs/5.3/customize/sass/) · [Vite + SASS](https://vite.dev/guide/features#css-pre-processors).

## Scripts / commands

```bash
cd client
npm install react-bootstrap bootstrap
npm install -D sass
# author client/src/styles/theme.scss (token overrides + @import bootstrap)
# add `import './styles/theme.scss';` to client/src/main.jsx

npm run lint      # exit 0
npm test          # existing 15 tests still pass
npm run build     # exit 0; dist CSS now contains Bootstrap
grep -l "\.btn" dist/assets/*.css   # confirm Bootstrap compiled in
```

> Nothing billable or destructive. No GCP, Terraform, Docker, or deploy. Only local dependency install + a build.

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| Scaffold | app-engineer (or main session if agent unloaded, as in [0010](0010-react-frontend-scaffold.md#Outcome)–[0012](0012-frontend-api-client-foundation.md#Outcome)) | install deps, write `theme.scss`, wire the import, verify build/lint/tests | Green build with Bootstrap CSS present |
| Review | infra-reviewer | Light pass: no secrets, deps pinned sanely, bundle-size note, no screens/components snuck in, build reproducible | Findings |
| Documentation | documentation-keeper | **ADR** for react-bootstrap + SASS-theme choice (citing the milestone UI/UX spec, alternatives shadcn/DIY); **`docs/architecture/ui-ux-guidelines.md`** distilled from System Design §2; update indexes | ADR + UI/UX reference + docs |

## Testing / verification plan

| Success criterion | Verification step | Expected result |
| --- | --- | --- |
| Deps install | `npm install` | clean, no errors |
| Theme compiles + build | `npm run build` | exit 0 |
| Bootstrap present in bundle | `grep "\.btn" dist/assets/*.css` | match found |
| Loaded once, baseline applied | inspect `main.jsx`; run app | one theme import; reset/typography visible on existing pages |
| Real token layer | change `$primary`, rebuild, diff CSS | compiled colour changes |
| Nothing regressed | `npm run lint` + `npm test` | lint 0; 15 tests pass |
| No components/screens added | `git status` / diff | only package.json, theme.scss, main.jsx changed |

## Additional considerations

- **Security posture:** none touched — this is CSS + a component library, no auth/data/secret surface, no effect on the zero-knowledge boundary. It does not touch the API layer or the token store.
- **Cost / bundle:** the only runtime delta is ~25–30 KB gzip of Bootstrap CSS on the static bundle Cloud Run already serves — no new resource, no meaningful cost. react-bootstrap JS is per-component tree-shaken, so it adds nothing until a screen imports a component. Selective SASS imports can trim the CSS later if ever needed (out of scope).
- **Rollback / teardown:** three files; `git revert`. No GCP resource, so `terraform destroy` unaffected.
- **Decided (with the user):**
  1. **react-bootstrap over shadcn/ui or a hand-rolled SASS system** — simplest path to the milestone's mandated cross-screen consistency; shadcn needs Tailwind + a new mental model, DIY reinvents components. Recorded in the ADR.
  2. **SASS theme over precompiled CSS** — gives a real, single-source design-token layer (the explicit goal) for barely more setup (`sass` dev dep + one file).
- **Dependencies:** unblocks the screen PRDs, which must follow the **six wireframes** and **ten principles** in System Design §2 (captured in `docs/architecture/ui-ux-guidelines.md` by this PRD). Independent of backend work.
- **Note:** the milestone wireframe *images* (Figures 9–14) can't be rendered in the working environment; screen PRDs should have the actual PDF open for pixel layout, using the distilled guidelines doc for the principles/inventory.

## Outcome

Executed 2026-07-10, to plan, on the `feat/frontend-serving-and-scaffold` branch (stacked on 0010–0012).

**Built:** added `react-bootstrap` ^2.10.10 + `bootstrap` ^5.3.8 (deps) and `sass` ^1.101 (dev). Created [client/src/styles/theme.scss](../../client/src/styles/theme.scss) — the single design-token file: `@import bootstrap/scss/functions`, override `$primary` (#3b4a6b), `$border-radius`, `$font-family-sans-serif`, then `@import bootstrap/scss/bootstrap`. Wired one `import './styles/theme.scss'` in [main.jsx](../../client/src/main.jsx). Added a `css.preprocessorOptions.scss` block to [vite.config.js](../../client/vite.config.js) (`api: 'modern-compiler'`, `quietDeps`, `silenceDeprecations`) so Bootstrap's legacy-SASS deprecation noise doesn't clutter the build.

**Verification:** `npm run build` exit 0 with **zero warnings**; the compiled `dist/assets/*.css` contains Bootstrap (`.btn` present) and the token flowed through (`--bs-primary: #3b4a6b`, 34 occurrences of the brand hex — proves the single-source token layer works). CSS is 30.9 KB gzip. `npm run lint` exit 0; the 15 existing client tests still pass. `Layout.jsx` and all six pages are byte-unchanged — no component or screen built.

**Deviations:** executed in the main session (app-engineer unloadable mid-session, as in 0010–0012); review + docs via their agents. Two cosmetic build warnings surfaced during execution and were both fixed before Done — a stale `mixed-decls` silence entry (removed) and the Sass `legacy-js-api` warning (resolved with `api: 'modern-compiler'`). infra-reviewer verdict: **safe to commit**, no blockers.

**Produced:** [ADR 0011 — Design System Baseline](../decisions/0011-design-system-baseline.md) (react-bootstrap + SASS theme, alternatives shadcn/DIY, cites the milestone UI/UX spec) and [architecture/ui-ux-guidelines.md](../architecture/ui-ux-guidelines.md) (the ten principles, navigation map, login/2FA flow, and six-screen inventory distilled from System Design Part I §2, with the PDF flagged as authoritative). Indexes updated.

**Open follow-ups (not blocking):**
1. Screen PRDs (Login first) build the six wireframes using react-bootstrap components + these tokens, following [ui-ux-guidelines.md](../architecture/ui-ux-guidelines.md).
2. A stray untracked duplicate of the System Design PDF sits at the **repo root** (identical bytes to the canonical `docs/milestones/` copy) — worth deleting or `.gitignore`-ing; left untouched pending user confirmation.
3. Bootstrap CSS could be trimmed via selective SASS imports if bundle size ever matters (out of scope now).
