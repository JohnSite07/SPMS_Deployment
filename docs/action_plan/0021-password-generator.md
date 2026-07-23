# 0021 — Password Generator

Add the `PasswordGenerator` the domain model already names but nothing implements: an inline "Generate strong password" control in the Add/Edit Credential form, per the wireframe and `ui-ux-guidelines.md`'s explicit rule that the generator is not a standalone screen.

| | |
| --- | --- |
| **Status** | Done |
| **Date** | 2026-07-21 |
| **Author** | Main session (orchestrator), on behalf of @Anjuuuzzz — scope drawn from the Milestone 4 wireframes (Figures 10-11, "Add/Edit Credential") |

## User story

As a user adding or editing a credential, I want a one-click way to generate a strong, random password (with a live strength indicator), so that I don't have to invent one myself and I'm nudged away from weak or reused choices.

## Scope

**In scope:**

- **`client/src/services/password-generator.js`** — new, pure client-side, no backend involvement (a generated password is just typed-in-then-encrypted like any other password value — `POST /api/credentials` doesn't change). Uses `crypto.getRandomValues` (not `Math.random` — cryptographically weak) for uniform random character selection. Configurable length (default 16, matching what a "strong" wireframe example implies) and character classes (uppercase/lowercase/numbers/symbols), guaranteeing at least one of each selected class is present (avoids the classic bug where a naive random generator can produce a 16-char password with zero digits).
- **`client/src/utils/password-strength.js`** — new, a graduated strength *score* (not the pass/fail boolean `password-rules.js`/`password-policy.js` already do for master passwords) — length + character-class variety scored into a 0-100-ish range or a small enum (Weak/Fair/Strong), driving the wireframe's live meter. This is a distinct concern from the master-password rule (business rule 2 is a hard gate for account passwords; this is a UX nudge for vault-item passwords, which have no hard minimum today) — do not conflate the two files.
- **`client/src/pages/Credentials.jsx`** — add a "Generate strong password" button to the Add/Edit form (inline, not a route/modal of its own — matches `ui-ux-guidelines.md`: "the generator opens from the credential form, not a standalone destination"), filling the password field and showing the live strength meter as the user types or after generating.
- Tests: `password-generator.js` (uses `crypto.getRandomValues`, respects length, guarantees requested character classes present, no two calls produce the same output), `password-strength.js` (scores obviously-weak vs. obviously-strong inputs sensibly), `Credentials.jsx` (clicking generate fills the field and shows a strength label).

**Out of scope:**

- Any backend change — a generated password is indistinguishable from a typed one once encrypted.
- The Password Health screen's use of a *different* strength/reuse concept (that's PRD 0022 — server-visible-label-based, computed client-side over the whole vault, not a live single-field meter).
- Enforcing a minimum strength before save — the wireframe shows guidance, not a hard block (unlike business rule 2's master-password gate); if you want a hard minimum for vault-item passwords too, that's a product decision for a follow-up, not assumed here.

## Success criteria

- [ ] Clicking "Generate strong password" fills the password field with a random string using `crypto.getRandomValues`, containing at least one character from each selected class.
- [ ] The strength meter updates live as the password field changes (typed or generated).
- [ ] `npm run lint` / `npm test` / `npm run build` (client) are green. No app/ changes in this PRD.

## Resources

| Resource / file | Type | Cost impact |
| --- | --- | --- |
| `client/src/services/password-generator.js` | New | $0 |
| `client/src/utils/password-strength.js` | New | $0 |
| `client/src/pages/Credentials.jsx` | Edit — add generate button + meter | $0 |
| Tests | New | $0 |

No new GCP resource, no new npm dependency, no backend change.

## Planned agents

| Step | Agent | Task | Hands off |
| --- | --- | --- | --- |
| 1 | `app-engineer` | `password-generator.js`, `password-strength.js`, wire into `Credentials.jsx`; tests. | Green `lint`/`test`/`build`. |
| 2 | `infra-reviewer` | Confirm `crypto.getRandomValues` (not `Math.random`), character-class guarantees hold, no weak fallback path. | Findings/sign-off. |
| 3 | `documentation-keeper` | PRD Outcome + index. | Updated `docs/`. |

## Outcome

Shipped as scoped, no deviations.

- **`client/src/services/password-generator.js`** — `generatePassword({ length, includeUppercase, includeLowercase, includeNumbers, includeSymbols })`, default length 16, all classes on by default. Uses `crypto.getRandomValues` with rejection sampling for both character selection and the final Fisher-Yates shuffle (never `Math.random`). Guarantees at least one character of each *selected* class by reserving one slot per class before filling the rest of the length from the combined alphabet and shuffling, so the guaranteed characters aren't predictably front-loaded. Throws if every class is disabled rather than silently falling back to some default alphabet.
- **`client/src/utils/password-strength.js`** — `scorePasswordStrength(password)` returns `{ score, label }`, `score` 0-100 (length contributes up to 40, capped at 10 chars; character-class variety contributes up to 60, 15 per class present). Exports `WEAK_THRESHOLD = 40` and `STRONG_THRESHOLD = 70` as named constants: `score < WEAK_THRESHOLD` → `'Weak'`, `< STRONG_THRESHOLD` → `'Fair'`, else `'Strong'`. **These two constants are exported specifically so PRD 0022's vault-wide weak/reused analysis can import and reuse them rather than inventing a second scale** — confirmed still the plan as of this writing (0022 is Draft, not yet built).
- **`client/src/pages/Credentials.jsx`** — "Generate strong password" button in both the Add and Edit credential forms (inline in the form, not a separate route/modal), each wired to its own `generatePassword()` call and its own live `scorePasswordStrength()` meter (`addPasswordStrength` / `editPasswordStrength`) that updates whether the field was typed or generated.
- Confirmed untouched, as scoped: `password-rules.js` / `password-policy.js` (the hard master-password gate, business rule 2) — no conflation between the two concerns.
- Tests: `client/src/services/__tests__/password-generator.test.js`, `client/src/utils/__tests__/password-strength.test.js`, plus `Credentials.jsx` coverage for the generate-and-fill-and-meter behaviour. 117 client tests passing; `npm run lint` / `npm run build` (client) green. No `app/` changes.
- Step 2 (`infra-reviewer`): clean sign-off, no findings, no fixes required (confirmed `crypto.getRandomValues` used throughout, character-class guarantees hold, no weak fallback path).
- No ADR recorded — see reasoning below.

### Why no ADR

Compared against ADR 0012-0015 (2FA enrollment as a separate anti-enumeration surface, duplicate-email disclosure as a deliberate exception, TOTP-based reset replacing an emailed link, vault-key derivation from the master password) — each of those records a security- or auth-boundary tradeoff with real alternatives considered and rejected. This PRD has no comparable decision: the generator is a client-side CSPRNG utility with one obviously-correct approach (`crypto.getRandomValues`, not `Math.random`), and the strength meter is a UX nudge explicitly designed to be a *non*-decision — it deliberately does not touch, gate, or reinterpret the existing hard master-password rule (business rule 2), it just scores a different, previously-unscored value for a progress bar. The one fact worth preserving for reuse (the `WEAK_THRESHOLD`/`STRONG_THRESHOLD` constants and the reason they're exported) is recorded above and in the code comment in `password-strength.js`, which is sufficient — there's no reversible-tradeoff or attacker-facing surface here that a future reader would need an ADR to reconstruct.
