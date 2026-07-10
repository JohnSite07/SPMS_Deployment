const { createAuditEntry, ACTIONS } = require('../models/audit-entry');

// The write path for the append-only audit log (business rule 7). Every
// AuditEntry the system records passes through logAction() — there is one
// door in, and no door out. This module deliberately exposes no update, no
// delete, and no bulk-write: the surface is the guarantee.
//
// Persistence is injected as `append`, not required here, for two reasons.
// The obvious one is testability. The load-bearing one is transactions: an
// entry for "credential added" must commit with the credential or not at
// all, so the caller binds `append` to whatever connection is running its
// transaction. A logger that owned its own connection could commit an entry
// for a write that later rolled back, or lose the entry for one that didn't.

// --- Failure policy -----------------------------------------------------
//
// logAction() never swallows an append failure, and never retries. It is the
// same rule session-issuer.js applies to onDeviceSeen (see its comment above
// the call): an unlogged action is worse than a failed one, so if the entry
// cannot be written, the action must not be reported as having happened.
//
// The corollary is a trap, and it is worth being explicit about because the
// failure is invisible in review: **await every logAction() before sending a
// response.** A fire-and-forget call whose append rejects produces an
// unhandledRejection, which on Node >= 20 tears the container down — but
// only after the route has already answered 200. The client is told the
// action succeeded and no entry exists. `await` is what turns that into a
// 500 with no entry, which is the honest outcome.

// `req.ip` is only the client's address when Express has been told how many
// proxies sit in front of it. With no `trust proxy` setting it is the socket
// peer — under Cloud Run that is the Google front end, so every entry would
// record the same useless address. With `trust proxy: true` it is the
// left-most X-Forwarded-For entry, which the *client* supplies and can
// therefore forge, letting an attacker choose what the audit log says about
// them. Neither default is acceptable for an audit trail, so this module
// reads `req.ip` and leaves the hop count to app configuration, where it
// belongs. See the note in app.js.
//
// Returns `undefined`, never `null`, when there is no address to be had.
// `null` is the entry model's word for "no request caused this action", and a
// request whose `req.ip` is missing is a misconfiguration, not a timer. The
// distinction is what stops a broken proxy setup from quietly filling the log
// with entries that disclaim any origin.
function requestIpAddress(req) {
  const ip = req && req.ip;
  return typeof ip === 'string' && ip !== '' ? ip : undefined;
}

/**
 * @param append  (entry, context) => Promise<void> | void — persists one
 *                AuditEntry. It receives a frozen entry and the opaque
 *                `context` its caller passed to logAction; its return value
 *                is ignored, only whether it settles matters.
 * @param clock   injectable, matching the services alongside this one.
 */
function createAuditLog({ append, clock = () => Date.now() } = {}) {
  if (typeof append !== 'function') {
    throw new TypeError('append is required');
  }

  /**
   * Records one action. Resolves with the entry that was written, so a caller
   * can assert on it; rejects if the entry is malformed or cannot be stored.
   *
   * @param userId     the acting user.
   * @param action     one of ACTIONS.
   * @param ipAddress  the request's source address, or null for an action no
   *                   request caused (the auto-lock timer, a scheduled scan).
   * @param context    opaque, forwarded to `append` untouched. This is how a
   *                   caller hands down the transaction its own write is
   *                   running in, so the entry and the thing it describes
   *                   commit together or not at all. Without it a route can
   *                   only choose between a credential stored with no entry
   *                   and an entry for a credential that rolled back — both
   *                   corrupt the log, in opposite directions.
   */
  async function logAction({
    userId,
    action,
    ipAddress,
    targetUserId,
    actorUserId,
    context,
  } = {}) {
    // Built before the append, not inside it. Validation is pure and cheap;
    // doing it first means a malformed action never opens a transaction, and
    // an invalid entry can never reach storage even if `append` is careless.
    const entry = createAuditEntry({
      userId,
      action,
      ipAddress,
      targetUserId,
      actorUserId,
      clock,
    });

    await append(entry, context);

    return entry;
  }

  return {
    logAction,

    /**
     * Binds an Express request's identity and address once, so routes call
     * `audit.logAction({ action })` and cannot forget — or quietly disagree
     * about — who did the thing and from where.
     *
     * `userId` falls back to the authenticated identity the auth middleware
     * froze onto `req.auth`, but stays overridable: a failed login has an
     * action to record and no `req.auth` to read it from.
     */
    forRequest(req) {
      const ipAddress = requestIpAddress(req);
      const authenticatedUserId = req && req.auth ? req.auth.userId : undefined;

      return {
        logAction: ({
          userId = authenticatedUserId,
          action,
          targetUserId,
          actorUserId,
          context,
        } = {}) => logAction({ userId, action, ipAddress, targetUserId, actorUserId, context }),
      };
    },

    /**
     * For actions with no request behind them — the 10-minute auto-lock
     * (event 7) and scheduled health scans. The null address is passed
     * explicitly rather than omitted, so a route that simply forgot to supply
     * an IP still fails loudly instead of masquerading as a system action.
     */
    forSystem() {
      return {
        logAction: ({ userId, action, context } = {}) =>
          logAction({ userId, action, ipAddress: null, context }),
      };
    },
  };
}

module.exports = { createAuditLog, ACTIONS };
