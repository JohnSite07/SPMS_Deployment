const express = require('express');
const { restoreAuditEntry, ACTIONS } = require('../models/audit-entry');
const { ROLES } = require('../services/token-service');
const { requireRole } = require('../middleware/require-role');
const { asyncRoute } = require('./credentials');
const { refuseMutation } = require('./audit');
const { parseLimit, decodeCursor, readPage, PaginationError } = require('./pagination');

// The System Administrator's view of a user's history
// (functional-requirements.md, Actors: "consumes audit logs").
//
// What an admin can see here is action names, timestamps and IP addresses.
// Not vault contents: an AuditEntry has never carried any, by construction,
// and `Credential.encryptedPassword` is ciphertext the server cannot decrypt
// anyway. The zero-knowledge posture survives this route intact — which is
// only true because the entry model refused a free-form details bag.
//
// "Full history" is still paginated. An unbounded dump of a long-lived log is
// a memory and latency problem, and a keyset cursor walks the whole thing
// without the offset-window bugs described in pagination.js.

function createAdminAuditRoutes({ store, users, audit, transaction } = {}) {
  if (!store || typeof store.list !== 'function') {
    throw new TypeError('store is required');
  }
  if (!users || typeof users.findById !== 'function') {
    throw new TypeError('users is required');
  }
  if (!audit || typeof audit.forRequest !== 'function') {
    throw new TypeError('audit is required');
  }
  if (typeof transaction !== 'function') {
    throw new TypeError('transaction is required');
  }

  const router = express.Router();

  // Before every handler below, so a route added here later is admin-only by
  // default rather than by remembering.
  router.use(requireRole(ROLES.ADMIN));

  /**
   * Records the read twice, in one transaction:
   *   - in the admin's log, naming whose history was read (targetUserId)
   *   - in the read user's log, naming who read it (actorUserId)
   *
   * The second is the one that matters to the person being watched: it shows
   * up in their own /api/audit activity view, so an administrator cannot page
   * through someone's history without that person being able to see it
   * happened. Both entries commit together or neither does.
   *
   * Reading one's *own* history through this route writes a single entry. The
   * pair would otherwise be two rows in one log saying an admin read their own
   * history and that their own history was read by them.
   */
  async function recordRead(req, targetUserId) {
    const adminUserId = req.auth.userId;

    await transaction(async (tx) => {
      await audit.forRequest(req).logAction({
        action: ACTIONS.AUDIT_LOG_READ,
        targetUserId,
        context: tx,
      });

      if (targetUserId !== adminUserId) {
        await audit.forRequest(req).logAction({
          userId: targetUserId,
          action: ACTIONS.AUDIT_LOG_READ,
          actorUserId: adminUserId,
          context: tx,
        });
      }
    });
  }

  router.get(
    '/:userId',
    asyncRoute(async (req, res) => {
      let limit;
      let after;
      try {
        limit = parseLimit(req.query.limit);
        after = req.query.cursor === undefined ? null : decodeCursor(req.query.cursor);
      } catch (err) {
        if (err instanceof PaginationError) {
          return res.status(400).json({ error: 'invalid_request', error_description: err.message });
        }
        throw err;
      }

      // The domain composes an AuditLog into a User. A read of a log that
      // belongs to nobody cannot be recorded — the second entry would be
      // attributed to a user who does not exist — so refuse before reading
      // rather than write a half-recorded access.
      const target = await users.findById(req.params.userId);
      if (!target) {
        return res.status(404).json({ error: 'not_found' });
      }

      const page = await readPage({
        limit,
        after,
        fetch: (take, from) => store.list({ userId: target.userId, limit: take, after: from }),
        restore: restoreAuditEntry,
      });

      // Awaited before the history is disclosed, and deliberately not caught.
      // A privileged cross-user read that cannot be recorded does not happen:
      // 500 with nothing disclosed, rather than 200 with no trace of who saw
      // what. This is the same rule the credential read applies to plaintext.
      await recordRead(req, target.userId);

      return res.status(200).json({
        entries: page.entries.map((entry) => entry.toJSON()),
        nextCursor: page.nextCursor,
      });
    })
  );

  // Append-only holds here too. An admin has more reach than an owner, and
  // still cannot edit or delete an entry — that is what "append-only" means.
  router.all('/:userId', refuseMutation);
  router.all('/', refuseMutation);

  return router;
}

module.exports = { createAdminAuditRoutes };
