# 0008 — An in-app `admin` role for the audit-history view

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** Anju Babu (with Claude)

## Context

[functional-requirements.md](../requirements/functional-requirements.md) lists a **System Administrator** actor who "deploys and maintains the app; consumes audit logs and health reports." The requirement to view a user's audit history therefore has a spec behind it.

The implementation did not. `token-service.js` defined exactly one role, `owner`, and stated the invariant plainly: "SecureVault has exactly one actor: a User composes one Vault, with no sharing or delegation." There was no admin `User`, no admin login, and no admin flag.

Worse, `'admin'` was the literal string three existing security tests used as their example of a **forged, unknown role**, asserting that a token bearing it is rejected. Admitting the role would turn those tests green for the wrong reason.

The architecture also suggests the spec's administrator is a GCP operator reading Cloud Logging, not an application account.

## Decision

Add `ROLES.ADMIN` and an in-app admin view: `GET /api/admin/audit/:userId`, paginated with the same keyset cursor as the user-facing activity view, guarded by `requireRole(ADMIN)` (403 for owners). Admin-ness is a property of the user row; `session-issuer.js` reads `user.role`.

Every admin read is recorded **twice, in one transaction**:

- in the admin's own log, carrying `targetUserId` — whose history was read;
- in the read user's log, carrying `actorUserId` — who read it.

The second entry is the one that earns its keep: an administrator cannot page through someone's history without that person seeing it in their own `/api/audit` activity view. If either entry cannot be written, nothing is disclosed (500).

The three escalation tests were retargeted from `'admin'` to `'superuser'`, so they continue to test escalation against a role that is genuinely unknown.

## Alternatives considered

- **Operator-side only** (no app role; admin reads via Cloud Logging or a read-only SQL grant) — matches the deployed architecture and the single-actor model, adds zero attack surface, and keeps the escalation tests intact. Set aside because an in-app view was wanted.
- **A separate admin token audience** (`securevault-admin`, as `device-service.js` does for device tokens), minted out-of-band and never by `POST /api/session`. An owner token could then never be presented at an admin route even if its role claim were forged — role forgery alone would be insufficient. Set aside as heavier; **it remains the recommended hardening** (see Consequences).
- **Not auditing admin reads** — rejected outright. A privileged cross-user read that leaves no trace is surveillance.
- **Auditing them without naming the target** — rejected: an entry recording that *some* history was read, of *someone*, is not a record.

## Consequences

- **A defence in depth is gone.** Until now a token whose `role` claim said `admin` was refused *even with a valid signature*, because no such role existed. The signature is now the only thing between an owner and an admin. A test forges the role claim on a genuine owner token and asserts 401, so the remaining check is pinned — but it is the only one.
- **Whoever can write the `users` table can mint an admin.** There is no separate provisioning path, no distinct second factor, and no separate audience. This is the single largest risk introduced by this ADR, and the reason the separate-audience alternative above should be revisited before production use.
- `sign()` must never take a role from request input. It does not — the role comes from the user row, via a proof the route cannot fabricate — and this must remain true.
- An admin walking a long history writes **one entry pair per page**, so a 40-page walk puts 40 rows into that user's activity view. Collapsing a walk into one entry would need a notion of "read session" the model does not have.
- Admins gain **no** access to vault contents. An `AuditEntry` has never carried any, and `Credential.encryptedPassword` is ciphertext the server cannot decrypt. The zero-knowledge posture survives this ADR intact — which is true only because the entry model refused a free-form details bag ([ADR 0006](0006-append-only-audit-log-enforcement.md)).
- Append-only holds for admins too: `PATCH`/`DELETE` on the admin routes answer 405. More reach, still no ability to rewrite history.
