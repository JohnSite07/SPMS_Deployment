const express = require('express');
const { ACTIONS } = require('../models/audit-entry');
const { AuthenticationError } = require('../services/session-issuer');
const { asyncRoute } = require('./credentials');

// UC-01 (log in) and the logout flow the requirements never wrote down.
//
// The two-factor ordering is not enforced here — it is enforced by the shape
// of session-issuer.js, which will not mint a token without a proof this
// route cannot fabricate. This module's job is the audit trail and the
// session row.

// An AuthenticationError's `code` is for the log; its `message` is what the
// client may see. Both factors fail identically to the client (see the
// comment on AuthenticationError), so the mapping below must never leak the
// code into the response.
const ACTION_FOR_FAILURE = Object.freeze({
  ACCOUNT_LOCKED: ACTIONS.ACCOUNT_LOCKED,
});

function auditActionFor(err) {
  return ACTION_FOR_FAILURE[err.code] ?? ACTIONS.LOGIN_FAILED;
}

/**
 * @param users     { findByEmail(email), recordFailedAttempt(userId),
 *                    resetFailedAttempts(userId) }
 * @param sessions  { transaction(fn), start(tx, { userId }) -> { sessionId },
 *                    revoke(tx, sessionId), isRevoked(sessionId) }
 * @param issuer    a createSessionIssuer() instance.
 * @param audit     a createAuditLog() instance.
 */
function createSessionRoutes({ users, sessions, issuer, audit } = {}) {
  if (!users || typeof users.findByEmail !== 'function') {
    throw new TypeError('users is required');
  }
  if (!sessions || typeof sessions.transaction !== 'function') {
    throw new TypeError('sessions is required');
  }
  if (!issuer || typeof issuer.verifyMasterPassword !== 'function') {
    throw new TypeError('issuer is required');
  }
  if (!audit || typeof audit.forRequest !== 'function') {
    throw new TypeError('audit is required');
  }

  const router = express.Router();

  // Every failure below answers with exactly this. The client cannot tell an
  // unknown email from a wrong password from a wrong 2FA code from a locked
  // account — otherwise the login route enumerates users, and the lockout
  // that protects an account announces which accounts are worth attacking.
  const deny = (res) => res.status(401).json({ error: 'invalid_credentials' });

  // POST is public (see PUBLIC_PATHS in middleware/authenticate.js) — it is
  // the request that creates the session it would otherwise need.
  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const { email, password, code, deviceToken } = req.body ?? {};

      const user = await users.findByEmail(email);

      // An unknown email produces no audit entry, and this is a deliberate
      // gap rather than an oversight. An AuditEntry requires a userId, and
      // the domain model composes the AuditLog into a User: there is no log
      // for a user who does not exist, and no id to attribute the attempt to.
      // Failed logins against *real* accounts are recorded below, which is
      // what the lockout rule needs. Attempts against invented addresses
      // belong in request logs, not in a user's audit trail.
      if (!user) {
        return deny(res);
      }

      let proof;
      try {
        proof = await issuer.verifyMasterPassword({ user, password });
        proof = await issuer.verifyTwoFactorCode({ proof, user, code });
      } catch (err) {
        if (!(err instanceof AuthenticationError)) {
          throw err;
        }

        // Awaited before the 401 is sent. A failed login that cannot be
        // recorded must not be reported to the client as a mere failure: the
        // five-failure lockout in business rule 1 counts entries, and an
        // attacker who could make the write fail could brute-force forever.
        await audit.forRequest(req).logAction({
          userId: user.userId,
          action: auditActionFor(err),
        });

        // The issuer refuses a locked account before touching the hash, so
        // this never extends an existing lockout window.
        if (err.code === 'INVALID_CREDENTIALS' || err.code === 'INVALID_TWO_FACTOR') {
          await users.recordFailedAttempt(user.userId);
        }

        return deny(res);
      }

      const { token, session } = await sessions.transaction(async (tx) => {
        const started = await sessions.start(tx, { userId: user.userId });

        // The device sighting is written by the issuer's onDeviceSeen hook,
        // which the app wires to this same audit log. It runs inside this
        // transaction only if the hook was bound to it; see app.js.
        const issued = await issuer.issueSessionToken({
          proof,
          sessionId: started.sessionId,
          deviceToken,
        });

        await audit.forRequest(req).logAction({
          userId: user.userId,
          action: ACTIONS.LOGIN_SUCCEEDED,
          context: tx,
        });

        return { token: issued.token, session: started, device: issued.device };
      });

      await users.resetFailedAttempts(user.userId);

      return res.status(201).json({ token, sessionId: session.sessionId });
    })
  );

  // Authenticated: the middleware has already proven this token names a live,
  // unrevoked session, so a caller can only end a session it holds.
  router.delete(
    '/',
    asyncRoute(async (req, res) => {
      await sessions.transaction(async (tx) => {
        await sessions.revoke(tx, req.auth.sessionId);
        await audit
          .forRequest(req)
          .logAction({ action: ACTIONS.SESSION_ENDED, context: tx });
      });

      return res.status(204).end();
    })
  );

  // Unchanged from the skeleton: reports the session the caller already has.
  router.get('/', (req, res) => {
    res.status(200).json({
      userId: req.auth.userId,
      role: req.auth.role,
      sessionId: req.auth.sessionId,
      expiresAt: req.auth.expiresAt.toISOString(),
    });
  });

  return router;
}

module.exports = { createSessionRoutes };
