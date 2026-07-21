const express = require('express');
const { ACTIONS } = require('../models/audit-entry');
const { isStrongMasterPassword } = require('../services/password-policy');
const { verifyTwoFactorCode } = require('../services/two-factor-verifier');
const { asyncRoute } = require('./credentials');

// PRD 0020 — TOTP-based password reset, replacing PRD 0015's emailed-token
// flow entirely (not adding to it). PRD 0015's link could never actually be
// delivered: PRD 0016 (SMTP provisioning) never landed, so the "disabled
// mode" this module used to have was the live state of the deployed app.
// Rather than wait on that infra dependency, identity here is proven with
// the code from the 2FA authenticator app every user already set up via
// PRD 0017 — no email, no token, no SMTP dependency at all.
//
// The vault is encrypted with the server-held AES key, never with the master
// password (see the domain model), so a reset updates only
// USERS.master_password_hash and nothing else — no re-encryption, no vault
// data touched.
//
// This endpoint is exactly as much of a code-guessing surface as
// POST /api/session and POST /api/2fa/confirm, so it gets the identical
// treatment: the same generic 401 shape (an unknown email, an account with
// no *enabled* 2FA, and a wrong code are all indistinguishable to the
// caller) and the same lockout accounting (users.recordFailedAttempt /
// resetFailedAttempts) on a wrong code. That accounting is the load-bearing
// security property of this whole design — without it, this route is an
// unlimited-attempts TOTP brute-force oracle.
//
// verifyTwoFactorCode is called directly from services/two-factor-verifier.js
// here, not through session-issuer.js: this route is not minting a login
// proof, so there is no session-issuer proof/token flow to reuse — see
// routes/two-factor.js's own /enroll+/confirm for the login-adjacent case.

/**
 * @param users         { findByEmail(email), recordFailedAttempt(userId),
 *                        resetFailedAttempts(userId),
 *                        updateMasterPasswordHash(tx, { userId, hash }) }
 * @param sessions      { transaction(fn), revokeAllForUser(tx, { userId }) }
 * @param audit         a createAuditLog() instance.
 * @param hashPassword  services/password-hasher.js's hashPassword (or a test
 *                      double with the same signature).
 */
function createPasswordResetRoutes({ users, sessions, audit, hashPassword } = {}) {
  if (!users || typeof users.findByEmail !== 'function') {
    throw new TypeError('users is required');
  }
  if (!sessions || typeof sessions.transaction !== 'function') {
    throw new TypeError('sessions is required');
  }
  if (!audit || typeof audit.forRequest !== 'function') {
    throw new TypeError('audit is required');
  }
  if (typeof hashPassword !== 'function') {
    throw new TypeError('hashPassword is required');
  }

  const router = express.Router();

  // Identical to session.js's/two-factor.js's deny(): an unknown email, an
  // account with no enabled 2FA, and a wrong code must all be
  // indistinguishable to the caller — otherwise this route enumerates users
  // or discloses which accounts never finished 2FA enrollment.
  const deny = (res) => res.status(401).json({ error: 'invalid_credentials' });

  // Public (see PUBLIC_PATHS in middleware/authenticate.js) — a user who
  // forgot their master password by definition cannot hold a session token.
  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const { email, code, newPassword } = req.body ?? {};

      const user = await users.findByEmail(email);

      // Same gap as session.js/two-factor.js, for the same reason: an
      // AuditEntry needs a userId, and an unknown email has none to
      // attribute a failure to.
      if (!user) {
        return deny(res);
      }

      // Refuse before touching anything else: the same reasoning
      // session-issuer.js's verifyMasterPassword applies to a locked account
      // (see its own comment) — a locked account must not become a
      // TOTP-guessing oracle, and must not have its lockout window pushed
      // further into the future by yet another recorded failure.
      if (user.isLocked) {
        return deny(res);
      }

      // A user with no *enabled* 2FA config has no valid code-guessing
      // surface to protect (there is no secret to check a code against), so
      // there is nothing to record a failed attempt for either — matching
      // session-issuer.js's own TWO_FACTOR_NOT_ENABLED precondition, though
      // this route never calls session-issuer since it is not a login.
      if (!user.twoFactorConfig || !user.twoFactorConfig.enabled) {
        return deny(res);
      }

      const codeIsValid = await verifyTwoFactorCode(user.twoFactorConfig, code);
      if (!codeIsValid) {
        // The load-bearing security property of this whole design — see the
        // header comment above.
        await users.recordFailedAttempt(user.userId);
        return deny(res);
      }

      // Checked only now, after identity is proven via the TOTP code: a
      // caller who has not yet demonstrated they hold the second factor gets
      // no free validation of a password they haven't earned the right to
      // set, mirroring the ordering /2fa/confirm and /register already use
      // (prove identity/uniqueness first, validate the new input second).
      // Business rule 2.
      if (!isStrongMasterPassword(newPassword)) {
        return res.status(400).json({ error: 'weak_password' });
      }

      // One transaction for the whole outcome: the new hash, every session
      // revoked, and the MASTER_PASSWORD_CHANGED entry commit together or
      // not at all — the same atomicity PRD 0015's /confirm had.
      await sessions.transaction(async (tx) => {
        const hash = await hashPassword(newPassword);
        await users.updateMasterPasswordHash(tx, { userId: user.userId, hash });
        await sessions.revokeAllForUser(tx, { userId: user.userId });

        await audit.forRequest(req).logAction({
          userId: user.userId,
          action: ACTIONS.MASTER_PASSWORD_CHANGED,
          context: tx,
        });
      });

      // Deliberate: a successful reset always clears the failed-attempt
      // counter (and, had the account since re-crossed the lock threshold
      // between the isLocked check above and here, would clear that lock
      // too) — proving current possession of the enrolled TOTP secret is
      // treated as sufficient grounds to also clear stale failure state, the
      // same proof bar every other authenticated action in this app accepts.
      await users.resetFailedAttempts(user.userId);

      return res.status(204).end();
    })
  );

  return router;
}

module.exports = { createPasswordResetRoutes };
