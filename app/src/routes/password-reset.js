const crypto = require('crypto');
const express = require('express');
const { ACTIONS } = require('../models/audit-entry');
const { isStrongMasterPassword } = require('../services/password-policy');
const { asyncRoute } = require('./credentials');

// The reset half of "forgotten master password" (PRD 0015). Re-hash only:
// the vault is encrypted with the server-held AES key, never with the master
// password, so a reset updates USERS.master_password_hash and nothing else —
// no re-encryption, no vault data touched.
//
// The raw token exists only for the lifetime of one request/response pair:
// minted here, emailed here, and never persisted or logged in that form.
// Everything this module stores or looks up afterward is its SHA-256 hash.

const RESET_TOKEN_BYTES = 32;
const DEFAULT_TTL_MINUTES = 30;

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function buildResetUrl(appBaseUrl, token) {
  return `${appBaseUrl.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
}

/**
 * @param users         { findByEmail(email), updateMasterPasswordHash(tx, { userId, hash }) }
 * @param resetTokens   the password-reset-store port: transaction(fn),
 *                      create(tx, { userId, tokenHash, expiresAt }),
 *                      consume(tx, { tokenHash }) -> { userId } | null.
 * @param sessions      { revokeAllForUser(tx, { userId }) }
 * @param audit         a createAuditLog() instance.
 * @param email         a createEmailService() instance.
 * @param hashPassword  services/password-hasher.js's hashPassword (or a
 *                      test double with the same signature).
 * @param clock         injectable, matching the services alongside this one.
 * @param ttlMinutes    reset-token lifetime.
 * @param appBaseUrl    base URL the reset link is built against (no
 *                      localhost fallback — see config/password-reset-config.js).
 *                      Absent when SMTP is not yet provisioned — see the
 *                      "disabled mode" note below.
 *
 * Disabled mode: `email` and `appBaseUrl` are the two collaborators that
 * only exist when config/password-reset-config.js's loadPasswordResetConfig()
 * succeeded (server.js calls it in its own non-fatal try/catch — SMTP creds
 * are not yet provisioned everywhere). `users`/`resetTokens`/`sessions`/
 * `audit`/`hashPassword` do not depend on that config and are always
 * supplied, so their absence still throws. When `email`/`appBaseUrl` are
 * absent, this factory does NOT throw: it returns a router whose two routes
 * always answer 503 with no side effects, so the rest of the app still
 * boots and serves. Restoring SMTP config and redeploying restores the flow
 * exactly as implemented below — nothing here changes shape when disabled.
 */
function createPasswordResetRoutes({
  users,
  resetTokens,
  sessions,
  audit,
  email,
  hashPassword,
  clock = () => Date.now(),
  ttlMinutes = DEFAULT_TTL_MINUTES,
  appBaseUrl,
} = {}) {
  if (!users || typeof users.findByEmail !== 'function') {
    throw new TypeError('users is required');
  }
  if (!resetTokens || typeof resetTokens.transaction !== 'function') {
    throw new TypeError('resetTokens is required');
  }
  if (!sessions || typeof sessions.revokeAllForUser !== 'function') {
    throw new TypeError('sessions is required');
  }
  if (!audit || typeof audit.forRequest !== 'function') {
    throw new TypeError('audit is required');
  }
  if (typeof hashPassword !== 'function') {
    throw new TypeError('hashPassword is required');
  }

  const enabled =
    Boolean(email) &&
    typeof email.sendPasswordResetEmail === 'function' &&
    typeof appBaseUrl === 'string' &&
    appBaseUrl !== '';

  const router = express.Router();

  if (!enabled) {
    // SMTP is not provisioned (yet): both endpoints stay public (no auth
    // required, same as the enabled routes below) but do no work at all —
    // no user lookup, no token minted or consumed, nothing appended to the
    // audit log. A generic 503 tells a caller "try later" without
    // distinguishing "SMTP not configured" from any other outage.
    router.post('/request', (req, res) => {
      res.status(503).json({ error: 'service_unavailable' });
    });
    router.post('/confirm', (req, res) => {
      res.status(503).json({ error: 'service_unavailable' });
    });
    return router;
  }

  // Identical for a known and an unknown email — the whole point (no account
  // enumeration). Declared once so both branches below answer with the exact
  // same object, never a copy that could drift.
  const ACK = Object.freeze({ ok: true });

  // Public (see PUBLIC_PATHS in middleware/authenticate.js) — a user who
  // forgot their master password by definition cannot hold a session token.
  router.post(
    '/request',
    asyncRoute(async (req, res) => {
      const { email: requestedEmail } = req.body ?? {};

      if (typeof requestedEmail === 'string' && requestedEmail !== '') {
        const user = await users.findByEmail(requestedEmail);

        // Same shape of gap as routes/session.js's login: only a real
        // account can receive a token, so only a real account does any work
        // here. The response below is identical either way.
        if (user) {
          const token = crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url');
          const tokenHash = hashToken(token);
          const expiresAt = new Date(clock() + ttlMinutes * 60 * 1000);

          await resetTokens.transaction(async (tx) => {
            await resetTokens.create(tx, { userId: user.userId, tokenHash, expiresAt });
          });

          // Sent after the token row is durable, and deliberately not inside
          // that transaction: the token existing does not depend on the
          // email successfully sending, and a slow/failed send must not roll
          // back a token the user might still receive via a retry.
          await email.sendPasswordResetEmail({
            to: user.email,
            resetUrl: buildResetUrl(appBaseUrl, token),
          });
        }
      }

      return res.status(200).json(ACK);
    })
  );

  router.post(
    '/confirm',
    asyncRoute(async (req, res) => {
      const { token, newPassword } = req.body ?? {};

      if (typeof token !== 'string' || token === '') {
        return res.status(400).json({ error: 'invalid_request' });
      }

      // Checked before the token is touched: a doomed request should not
      // consume a token the user could otherwise still use with a valid
      // password. Business rule 2.
      if (!isStrongMasterPassword(newPassword)) {
        return res.status(400).json({ error: 'weak_password' });
      }

      const tokenHash = hashToken(token);

      // One transaction for the whole outcome: an unexpired, unused token
      // consumed, the new hash written, every session revoked, and the
      // MASTER_PASSWORD_CHANGED entry appended, commit together or not at
      // all. If the audit append throws, nothing above it survives —
      // including the token's own consumption, so a legitimate retry is not
      // punished by an infrastructure failure it did not cause.
      const outcome = await resetTokens.transaction(async (tx) => {
        const consumed = await resetTokens.consume(tx, { tokenHash });
        if (!consumed) {
          return null;
        }

        const hash = await hashPassword(newPassword);
        await users.updateMasterPasswordHash(tx, { userId: consumed.userId, hash });
        await sessions.revokeAllForUser(tx, { userId: consumed.userId });

        await audit.forRequest(req).logAction({
          userId: consumed.userId,
          action: ACTIONS.MASTER_PASSWORD_CHANGED,
          context: tx,
        });

        return consumed;
      });

      // Missing, expired, and already-used all collapse to the same answer:
      // distinguishing them would tell a caller which of those three is true
      // for a token they may not legitimately hold.
      if (!outcome) {
        return res.status(400).json({ error: 'invalid_token' });
      }

      return res.status(204).end();
    })
  );

  return router;
}

module.exports = { createPasswordResetRoutes };
