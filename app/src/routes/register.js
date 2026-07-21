const express = require('express');
const { ACTIONS } = require('../models/audit-entry');
const { isStrongMasterPassword } = require('../services/password-policy');
const { asyncRoute } = require('./credentials');

// PRD 0018 — self-service account creation. Before this route, every USERS
// row (and its TWO_FACTOR_CONFIGS row) existed because a developer hand-wrote
// it into Cloud SQL Studio; this is the missing front door.
//
// A freshly created account has no TWO_FACTOR_CONFIGS row, and
// session-issuer.js correctly refuses login for any user without an
// *enabled* one (UC-01's precondition — see routes/two-factor.js's own
// header comment on the same point). This route mints no session token: the
// hand-off to PRD 0017's POST /api/2fa/enroll + /confirm is deliberate, not
// an oversight — there is nothing to authenticate into until 2FA is set up.
//
// Duplicate-email handling is a deliberate, explicitly flagged exception to
// this codebase's otherwise strict anti-enumeration posture (routes/
// session.js, routes/two-factor.js, and routes/password-reset.js all answer
// a generic failure so a caller can never learn whether an email is
// registered). Signup is about *claiming* an identity, not testing
// credentials against one that may already exist: telling a visitor "that
// email already has an account" is ordinary signup UX, and it discloses
// nothing an attacker doesn't already have to know (the email address
// itself) to act on. Do not generalize this 409 pattern onto any
// authenticated-guessing surface — everywhere else in this codebase, that
// posture is deliberate and this route is the one, reasoned exception.

/**
 * @param users         { findByEmail(email), transaction(fn),
 *                         createUser(tx, { email, passwordHash }) -> userId }
 * @param vaults        { create(tx, { userId }) }
 * @param audit         a createAuditLog() instance.
 * @param hashPassword  services/password-hasher.js's hashPassword (or a test
 *                      double with the same signature) — injected, the same
 *                      pattern routes/password-reset.js uses, rather than
 *                      required directly, so a caller can substitute a fake
 *                      one in tests without touching bcrypt.
 */
function createRegisterRoutes({ users, vaults, audit, hashPassword } = {}) {
  if (!users || typeof users.findByEmail !== 'function' || typeof users.transaction !== 'function') {
    throw new TypeError('users is required');
  }
  if (!vaults || typeof vaults.create !== 'function') {
    throw new TypeError('vaults is required');
  }
  if (!audit || typeof audit.forRequest !== 'function') {
    throw new TypeError('audit is required');
  }
  if (typeof hashPassword !== 'function') {
    throw new TypeError('hashPassword is required');
  }

  const router = express.Router();

  // Public (see PUBLIC_PATHS in middleware/authenticate.js) — a first-time
  // visitor by definition holds no session token; this is the request that
  // creates the account a session would otherwise be needed to prove.
  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const { email, password } = req.body ?? {};

      if (typeof email !== 'string' || email === '') {
        return res.status(400).json({ error: 'invalid_request' });
      }

      // The one deliberate, flagged exception to this file's neighbours'
      // generic-failure posture — see the header comment above.
      const existing = await users.findByEmail(email);
      if (existing) {
        return res.status(409).json({ error: 'email_already_registered' });
      }

      // Checked before anything is written — the same ordering routes/
      // password-reset.js's /confirm uses: a doomed request must not touch
      // storage. Business rule 2.
      if (!isStrongMasterPassword(password)) {
        return res.status(400).json({ error: 'weak_password' });
      }

      const passwordHash = await hashPassword(password);

      // One transaction for the whole outcome: the USERS row, its composed
      // VAULTS row, and the ACCOUNT_CREATED audit entry commit together or
      // not at all. domain-model.md composes exactly one Vault into a User,
      // so a User without a Vault is an invalid, half-built object — if the
      // vault insert (or the audit append) throws, the user insert rolls
      // back with it. No orphan USERS row, ever.
      const userId = await users.transaction(async (tx) => {
        const createdUserId = await users.createUser(tx, { email, passwordHash });
        await vaults.create(tx, { userId: createdUserId });

        await audit.forRequest(req).logAction({
          userId: createdUserId,
          action: ACTIONS.ACCOUNT_CREATED,
          context: tx,
        });

        return createdUserId;
      });

      // No session token minted here — see the header comment above. PRD
      // 0017's /2fa/enroll + /confirm is the very next step for this user.
      return res.status(201).json({ userId });
    })
  );

  return router;
}

module.exports = { createRegisterRoutes };
