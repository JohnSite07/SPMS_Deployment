const express = require('express');
const { ACTIONS } = require('../models/audit-entry');
const { AuthenticationError } = require('../services/session-issuer');
const { generateSecret, buildOtpauthUri, encrypt } = require('../services/two-factor-enrollment');
const { asyncRoute } = require('./credentials');

// PRD 0017 — the self-service half of UC-01's "2FA set up" precondition.
// session-issuer.js's verifyTwoFactorCode correctly refuses login for any
// user without an *enabled* TWO_FACTOR_CONFIGS row (see its own comment) —
// deliberately, since that precondition is the point. Nothing before this
// module let a user reach that precondition themselves; a human had to write
// AES-GCM ciphertext into the row by hand. These two routes are the missing
// path, and they open no shortcut around the precondition they close: a row
// this module writes starts `enabled = FALSE` and only ever flips to TRUE
// after a live TOTP code proves the user actually holds the secret.
//
// Both routes are exactly as much of a password-guessing surface as
// POST /api/session, so they get the identical treatment: the same generic
// 401 shape (unknown email and wrong password are indistinguishable), and
// the same lockout accounting (users.recordFailedAttempt /
// resetFailedAttempts) — a wrong /enroll or /confirm attempt counts toward
// the same five-failure, fifteen-minute lockout a wrong login attempt does.

/**
 * @param users    { findByEmail(email), recordFailedAttempt(userId),
 *                   resetFailedAttempts(userId),
 *                   upsertPendingTwoFactorConfig(userId, encryptedSecret),
 *                   enableTwoFactorConfig(tx, userId) }
 * @param issuer   a createSessionIssuer() instance — reused unchanged so
 *                 confirming enrollment finishes through the exact same
 *                 proof-minting path POST /api/session uses.
 * @param audit    a createAuditLog() instance.
 * @param sessions { transaction(fn), start(tx, { userId }) -> { sessionId } }
 */
function createTwoFactorRoutes({ users, issuer, audit, sessions } = {}) {
  if (!users || typeof users.findByEmail !== 'function') {
    throw new TypeError('users is required');
  }
  if (!issuer || typeof issuer.verifyMasterPassword !== 'function') {
    throw new TypeError('issuer is required');
  }
  if (!audit || typeof audit.forRequest !== 'function') {
    throw new TypeError('audit is required');
  }
  if (!sessions || typeof sessions.transaction !== 'function') {
    throw new TypeError('sessions is required');
  }

  const router = express.Router();

  // Identical to session.js's deny(): the client must not be able to tell an
  // unknown email from a wrong password from a wrong code apart, here any
  // more than at login.
  const deny = (res) => res.status(401).json({ error: 'invalid_credentials' });

  // Re-verifies email+password the same way on both routes below, including
  // the lockout accounting. Returns the user and the (single-use) password
  // proof on success; sends the 401 and returns null on failure — the caller
  // just returns when this returns null.
  async function verifyPasswordOrDeny(req, res) {
    const { email, password } = req.body ?? {};
    const user = await users.findByEmail(email);

    // Same gap as session.js, for the same reason: an AuditEntry needs a
    // userId, and an unknown email has none to attribute a failure to.
    if (!user) {
      deny(res);
      return null;
    }

    try {
      const proof = await issuer.verifyMasterPassword({ user, password });
      return { user, proof };
    } catch (err) {
      if (!(err instanceof AuthenticationError)) {
        throw err;
      }

      // The issuer refuses a locked account before touching the hash (see
      // its own comment), so this must not extend an existing lockout
      // window — only a genuinely wrong password counts.
      if (err.code === 'INVALID_CREDENTIALS') {
        await users.recordFailedAttempt(user.userId);
      }

      deny(res);
      return null;
    }
  }

  // Public (see PUBLIC_PATHS in middleware/authenticate.js) — pre-session,
  // like POST /api/session.
  router.post(
    '/enroll',
    asyncRoute(async (req, res) => {
      const verified = await verifyPasswordOrDeny(req, res);
      if (!verified) {
        return undefined;
      }
      const { user } = verified;

      // Safe to reveal only because the password was already proven correct
      // above — it adds no anonymous enumeration channel.
      if (user.twoFactorConfig && user.twoFactorConfig.enabled) {
        return res.status(409).json({ error: 'two_factor_already_enabled' });
      }

      // Generated fresh and returned exactly once, in this response. The
      // only copy that survives afterward is the AES-256-GCM ciphertext
      // below — never logged (no console.* anywhere in this module), never
      // re-derivable except by decrypting with AES_ENCRYPTION_KEY.
      const secret = generateSecret();
      const { ciphertext, iv, tag } = encrypt(secret);

      await users.upsertPendingTwoFactorConfig(user.userId, { ciphertext, iv, tag });

      return res.status(200).json({
        secret,
        otpauthUri: buildOtpauthUri(user.email, secret),
      });
    })
  );

  // Public, same reason as /enroll.
  router.post(
    '/confirm',
    asyncRoute(async (req, res) => {
      const { code, deviceToken } = req.body ?? {};

      const verified = await verifyPasswordOrDeny(req, res);
      if (!verified) {
        return undefined;
      }
      const { user, proof } = verified;

      // Present regardless of `enabled` (ports/users.js's LEFT JOIN returns
      // the row either way) — this is what lets a botched first confirm be
      // retried without re-running /enroll. No config at all means there is
      // nothing to confirm; the response gives no hint whether that is
      // because enrollment was never started, the same anti-enumeration
      // posture as every other failure here.
      if (!user.twoFactorConfig) {
        deny(res);
        return undefined;
      }

      // session-issuer.js's verifyTwoFactorCode (and, beneath it, the real
      // two-factor-verifier.js) both refuse a config with `enabled: false` —
      // correctly, for login, where an unconfirmed secret must never
      // authenticate. This route's entire job is different: it is the one
      // place a still-pending secret's code IS allowed to be checked, because
      // checking it correctly is what's about to legitimately flip `enabled`
      // to true. A shallow, request-local view with `enabled: true` lets both
      // of those checks pass without loosening either file's real guarantee —
      // login itself never sees this view, only this route constructs it.
      const enabledView = {
        ...user,
        twoFactorConfig: { ...user.twoFactorConfig, enabled: true },
      };

      let twoFactorProof;
      try {
        twoFactorProof = await issuer.verifyTwoFactorCode({ proof, user: enabledView, code });
      } catch (err) {
        if (!(err instanceof AuthenticationError)) {
          throw err;
        }

        if (err.code === 'INVALID_TWO_FACTOR') {
          await users.recordFailedAttempt(user.userId);
        }

        deny(res);
        return undefined;
      }

      // Both factors are now genuinely proven. An account that was already
      // fully enabled reduces this to "you proved both factors, so log in" —
      // unlike /enroll's 409 (which refuses to touch an enrollment before any
      // secret has even been generated), there is no pending state here to
      // protect, and denying a user who just typed a correct current code
      // would only be confusing. So: enable + audit TWO_FACTOR_ENABLED only
      // for a row that is actually still pending; an already-enabled row is
      // left exactly as it was, and this falls straight through to a normal
      // login. Otherwise every re-confirm of an already-enabled account would
      // fabricate a fresh "2FA was just enabled" entry for something that
      // happened weeks ago — TWO_FACTOR_ENABLED is closed-vocabulary and is
      // supposed to mean exactly that this action just occurred.
      const alreadyEnabled = user.twoFactorConfig.enabled === true;

      // enable + its audit entry + the session start + its audit entry all
      // commit together or not at all. Splitting `enableTwoFactorConfig`
      // across a separate write from the transaction below would let
      // `enabled` become true and immediately usable by POST /api/session —
      // which checks only `enabled`, not whether an entry exists — while a
      // failed audit append left a permanent, silent gap in the log. Inside
      // one transaction, a failure anywhere rolls the whole thing back and
      // /confirm can simply be retried.
      const { token, session } = await sessions.transaction(async (tx) => {
        if (!alreadyEnabled) {
          await users.enableTwoFactorConfig(tx, user.userId);
          await audit.forRequest(req).logAction({
            userId: user.userId,
            action: ACTIONS.TWO_FACTOR_ENABLED,
            context: tx,
          });
        }

        // From here, identical to POST /api/session's success path: start a
        // session, mint the token from the two-factor proof just verified,
        // log the login, and hand back exactly the same shape.
        const started = await sessions.start(tx, { userId: user.userId });

        const issued = await issuer.issueSessionToken({
          proof: twoFactorProof,
          sessionId: started.sessionId,
          deviceToken,
        });

        await audit.forRequest(req).logAction({
          userId: user.userId,
          action: ACTIONS.LOGIN_SUCCEEDED,
          context: tx,
        });

        return { token: issued.token, session: started };
      });

      await users.resetFailedAttempts(user.userId);

      return res.status(201).json({ token, sessionId: session.sessionId });
    })
  );

  return router;
}

module.exports = { createTwoFactorRoutes };
