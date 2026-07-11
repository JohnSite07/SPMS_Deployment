# 0010 — In-memory session-token storage in the SPA (no localStorage/sessionStorage/cookies)

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** htuazon (with Claude)

## Context

[PRD 0012](../action_plan/0012-frontend-api-client-foundation.md) built the client-side API service layer (`client/src/services/`) that every SPA screen uses to talk to `/api`. After `login()`, the SPA holds a bearer session token (and its expiry) that must be attached to every subsequent authenticated request. That token has to live somewhere in the browser between requests, and the choice of where is security-relevant, not just an implementation detail: SecureVault is a zero-knowledge password manager (CLAUDE.md), so the blast radius of a stolen session token — and the plausibility of an attacker being able to steal it in the first place — weighs heavily on the decision.

The realistic threat here is **XSS**: a script injected into the SPA (via a dependency, a rendering bug, or any other vector) runs with the same privileges as the app's own code and can read anything the app's own code can read.

## Decision

The session token and its expiry are held **only in in-memory module state** — `client/src/services/token-store.js`, a plain module-scoped `let token` / `let expiresAt` with `get`/`set`/`clear` functions, no persistence layer underneath it. Nothing is written to `localStorage`, `sessionStorage`, or a cookie. Losing the JS runtime (tab close, hard refresh, navigating away and back) loses the token — the user must log in again.

## Alternatives considered

- **`sessionStorage`** — scoped to the tab, cleared on tab close, would have survived a refresh (nicer UX). Rejected: it is a synchronous, always-readable JS API — any script running in the page (including an XSS payload) can call `sessionStorage.getItem(...)` and exfiltrate the token exactly as easily as reading a JS variable it wasn't given a reference to. It buys refresh-survival at the cost of turning every XSS bug into a session-hijack bug.
- **`localStorage`** — same readability problem as `sessionStorage`, plus it persists indefinitely across tabs and browser restarts, which widens the exposure window further (a stolen token stays valid — and stealable — long after the tab that leaked it is gone). Rejected for the same reason as `sessionStorage`, more so.
- **In-memory module state (chosen)** — an XSS payload running in the page *can* still reach the token while the page is live (it shares the JS heap), but there is no persisted copy to read after the fact, no storage API to enumerate, and nothing survives a reload — so the useful window for exfiltration is bounded to the live tab, not indefinite. This does not eliminate XSS risk; it removes the *persistence* of the credential, which is the part `sessionStorage`/`localStorage` add for free and which this project doesn't want.
- **A cookie (e.g. `httpOnly`)** was not adopted as the alternative here. An `httpOnly` cookie would in fact close the JS-readability gap entirely (unreachable from any script, XSS included), but it changes the request-shaping contract from `Authorization: Bearer <token>` to server-set cookies, CSRF-token handling, and `SameSite` policy — a bigger surface change to the existing session route (see [session route contract](../../app/src/routes/session.js)) than PRD 0012 scoped. Noted here as a stronger alternative worth a future ADR if the project revisits this; not chosen now because it wasn't the two options actually weighed in PRD 0012's decision (in-memory vs. Web Storage).

## Consequences

- **Re-login on refresh/new-tab is accepted UX friction**, not a bug. It's tolerable because the vault already auto-locks after 10 minutes of inactivity (business rule 5, CLAUDE.md) — the session was never meant to survive indefinitely, and losing it on reload is a small step beyond a behaviour the app already has.
- **No "remember me" / refresh-token / persistent-session feature exists**, and none is implied by this ADR. If the project wants one later, that is a *separate* decision (it would need to weigh a persistence mechanism against this same XSS-exposure trade-off) and gets its own ADR — it does not get retrofitted quietly into `token-store.js`.
- **The token must never be logged, put in a URL/query string, or included in a thrown error.** [`api-client.js`](../../client/src/services/api-client.js) attaches it only as an `Authorization: Bearer` header, calls the relative `/api` path (no query-string leakage), and `ApiError` carries only `status`/`error`/`error_description` — never the token value. This was verified by an infra-reviewer pass over the PRD 0012 build.
- **The 401 expiry path (`endSession()` in [`session.js`](../../client/src/services/session.js)) must stay fail-safe**: any auth failure clears the token from `token-store.js` rather than leaving a dead value attached to future requests. This is a direct consequence of the token having nowhere else to be cleared from — module state is the single source of truth, so clearing it is a single, always-reachable operation.
- Because the token isn't persisted, nothing here is affected by clearing browser storage, incognito mode, or multi-tab isolation — those are orthogonal to a bug that already only touched a Web Storage API this design doesn't use.

## Related

- [PRD 0012 — Frontend API client foundation](../action_plan/0012-frontend-api-client-foundation.md) — Decision 1 in that PRD's "Decided" section is this ADR. The PRD's other two decisions (Decision 2 — Vite dev proxy so the client always calls relative `/api`, no `VITE_API_BASE_URL`, no CORS surface; Decision 3 — 401-reactive session-end backbone plus a proactive `X-Session-Expires-At` auto-lock timer) are recorded there and don't warrant their own ADRs — they're implementation choices within an already-decided architecture, not new security- or cost-relevant trade-offs.
- [ADR 0009 — Frontend stack and serving model](0009-frontend-stack-and-serving-model.md) — same-origin serving (Express serves the built SPA on Cloud Run) is what makes the relative-`/api` + `Authorization`-header pattern possible without a CORS surface; this ADR's token-storage choice sits on top of that serving model.
- [`client/src/services/token-store.js`](../../client/src/services/token-store.js) — the implementation.
- [`client/src/services/api-client.js`](../../client/src/services/api-client.js) — where the token is attached/refreshed and where the 401 fail-safe path is triggered.
- [`client/src/services/session.js`](../../client/src/services/session.js) — `endSession()` and the proactive auto-lock timer.
