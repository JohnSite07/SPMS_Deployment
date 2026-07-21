const crypto = require('crypto');
const net = require('net');

// A single logged action (domain-model.md, AuditEntry). The audit log is
// append-only (business rule 7), which this module enforces at the type level
// rather than leaving to the access layer: an entry has no setters, is frozen
// on construction, and hands out a fresh Date on every read of `timestamp`.
//
// The frozen-Date detail is not pedantry. `Object.freeze(new Date())` does
// *not* stop `entry.timestamp.setFullYear(1999)` — Date's value lives in an
// internal slot, not a property, so freeze sails straight past it. Returning
// a copy per read is the only way the timestamp of a written entry cannot be
// rewritten by whoever holds a reference to it.
//
// There is deliberately no free-form `details`/`metadata` bag. An audit log
// that accepts arbitrary caller data is where plaintext passwords and
// decrypted blobs eventually end up, and the whole system is built so the
// server never holds those. If an action needs more context, add a named,
// typed, reviewed field here.

// Closed vocabulary, in the same spirit as ROLES in token-service.js: an
// unrecognised action is rejected when the entry is minted, rather than
// reaching the log as a typo that no query will ever match. Every value below
// traces to a use case or business rule in docs/requirements/.
const ACTIONS = Object.freeze({
  LOGIN_SUCCEEDED: 'login.succeeded', // UC-01
  LOGIN_FAILED: 'login.failed', // UC-01 exception
  ACCOUNT_LOCKED: 'account.locked', // UC-01, 5 failures -> 15 min
  MASTER_PASSWORD_CHANGED: 'master_password.changed', // User.changeMasterPassword()
  DEVICE_RECOGNIZED: 'device.recognized', // session-issuer onDeviceSeen
  DEVICE_UNRECOGNIZED: 'device.unrecognized', // business rule 4
  SESSION_ENDED: 'session.ended', // logout; see the note below
  VAULT_UNLOCKED: 'vault.unlocked', // UC-01 post-condition
  VAULT_LOCKED: 'vault.locked', // event 7, temporal (no request, no IP)
  CREDENTIAL_ADDED: 'credential.added', // UC-02
  CREDENTIAL_RETRIEVED: 'credential.retrieved', // UC-03
  CREDENTIAL_UPDATED: 'credential.updated', // see the note below
  CREDENTIAL_DELETED: 'credential.deleted', // see the note below
  DOCUMENT_STORED: 'document.stored', // UC-04
  DOCUMENT_RETRIEVED: 'document.retrieved', // UC-06 / event 6
  PASSWORD_GENERATED: 'password.generated', // event 4
  HEALTH_REPORT_GENERATED: 'health_report.generated', // UC-05
  AUDIT_LOG_READ: 'audit_log.read', // an admin read a user's history
  TWO_FACTOR_ENABLED: 'two_factor.enabled', // PRD 0017, 2FA self-enrollment
  ACCOUNT_CREATED: 'account.created', // PRD 0018, self-service registration
});

const ACTION_VALUES = Object.freeze(Object.values(ACTIONS));

// `session.ended`, `credential.updated` and `credential.deleted` have no use
// case behind them. functional-requirements.md lists nine events and defines
// UC-01..UC-05; editing a credential, deleting one, and logging out appear in
// none of them. They are recorded here because the flows exist in the route
// layer and an append-only log that cannot describe a deletion is not an
// audit trail — the destructive actions are precisely the ones it exists to
// witness. The requirements owe these three a use case; until then, treat
// this comment as the specification.

// Express behind Cloud Run reports IPv4 peers as IPv4-mapped IPv6
// (`::ffff:203.0.113.5`), and `net.isIP` classifies that as v6. Left alone,
// one host would accumulate audit rows under two different spellings and a
// "show me everything from this IP" query would silently miss half of them.
const IPV4_MAPPED_PREFIX = '::ffff:';

// `null` means the action had no request behind it — the 10-minute auto-lock
// (event 7) and scheduled health scans fire on a timer, from no address at
// all. That must be stated by the caller, never inferred from a missing
// argument, so a route that simply forgot to pass `req.ip` fails loudly
// instead of writing an anonymous entry.
function normalizeIpAddress(ipAddress) {
  if (ipAddress === null) {
    return null;
  }
  if (typeof ipAddress !== 'string' || ipAddress === '') {
    throw new TypeError(
      'ipAddress must be an IPv4/IPv6 string, or null for a system-originated action'
    );
  }

  if (ipAddress.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)) {
    const unwrapped = ipAddress.slice(IPV4_MAPPED_PREFIX.length);
    if (net.isIP(unwrapped) === 4) {
      return unwrapped;
    }
  }

  const family = net.isIP(ipAddress);
  if (family === 0) {
    throw new TypeError(`ipAddress "${ipAddress}" is not a valid IPv4 or IPv6 address`);
  }

  // Lower-cased so 2001:DB8::1 and 2001:db8::1 group together. Full RFC 5952
  // canonicalisation (zero-run collapsing) is left to the storage layer.
  return family === 6 ? ipAddress.toLowerCase() : ipAddress;
}

// An admin reading a user's history is a privileged cross-user access, and it
// is recorded twice: once in the admin's own log (`targetUserId` — whose
// history was read) and once in the read user's log (`actorUserId` — who read
// it). The first makes the admin accountable; the second means the user finds
// out, in their own activity view, without having to ask.
//
// Two separate fields rather than one, because they mean opposite things and
// which one is set says which copy of the record this is. An entry carrying
// both would be claiming to live in two logs at once, and one carrying
// neither would be an `audit_log.read` that names nobody — a record that some
// history was read, by someone, of someone. Exactly one, enforced here.
//
// They are still named, typed fields rather than the free-form details bag
// this model has refused from the start. The bag is where plaintext ends up;
// a reviewed field is not.
function normalizeAssociates({ action, targetUserId, actorUserId }) {
  const hasTarget = targetUserId !== undefined && targetUserId !== null;
  const hasActor = actorUserId !== undefined && actorUserId !== null;

  if (action !== ACTIONS.AUDIT_LOG_READ) {
    // Prevents an association quietly riding along on an unrelated action,
    // where nothing would ever read it and nothing would ever validate it.
    if (hasTarget || hasActor) {
      throw new TypeError(
        `targetUserId and actorUserId are only meaningful for "${ACTIONS.AUDIT_LOG_READ}"`
      );
    }
    return { targetUserId: null, actorUserId: null };
  }

  if (hasTarget === hasActor) {
    throw new TypeError(
      `"${ACTIONS.AUDIT_LOG_READ}" requires exactly one of targetUserId (the admin's copy) ` +
        "or actorUserId (the read user's copy)"
    );
  }

  return {
    targetUserId: hasTarget ? normalizeUserId(targetUserId) : null,
    actorUserId: hasActor ? normalizeUserId(actorUserId) : null,
  };
}

function normalizeUserId(userId) {
  if (typeof userId !== 'string' && typeof userId !== 'number') {
    throw new TypeError('userId is required');
  }

  const normalized = String(userId);
  if (normalized === '') {
    throw new TypeError('userId is required');
  }
  return normalized;
}

// Accepts a Date, epoch milliseconds, or an ISO-8601 string (what toJSON
// wrote). Every other type is rejected outright rather than handed to the
// Date constructor, which answers `new Date(null)` with the epoch and
// `new Date(true)` with one millisecond past it — a corrupted or truncated
// row would otherwise rehydrate as a plausible 1970 timestamp instead of
// failing.
function normalizeTimestamp(timestamp) {
  let millis;
  if (timestamp instanceof Date) {
    millis = timestamp.getTime();
  } else if (typeof timestamp === 'number') {
    millis = timestamp;
  } else if (typeof timestamp === 'string') {
    millis = new Date(timestamp).getTime();
  }

  if (!Number.isFinite(millis)) {
    throw new TypeError('timestamp must be a valid Date, epoch milliseconds, or ISO-8601 string');
  }
  return millis;
}

// The single construction path. Both the mint and the restore entry points
// funnel through here, so a row read back from MySQL is validated by exactly
// the same rules that governed it on the way in — a log whose contents were
// tampered with at rest cannot be rehydrated into a well-formed entry.
function freezeEntry({ entryId, userId, action, timestampMillis, ipAddress, ...associates }) {
  if (typeof entryId !== 'string' || entryId === '') {
    throw new TypeError('entryId is required');
  }
  if (!ACTION_VALUES.includes(action)) {
    throw new TypeError(`unknown audit action "${action}"`);
  }

  const { targetUserId, actorUserId } = normalizeAssociates({ action, ...associates });

  return Object.freeze({
    entryId,
    userId: normalizeUserId(userId),
    action,
    ipAddress: normalizeIpAddress(ipAddress),
    targetUserId,
    actorUserId,

    // A getter, not a stored Date: see the note at the top of this file.
    get timestamp() {
      return new Date(timestampMillis);
    },

    // What the persistence layer writes and what ships to Cloud Logging.
    // ISO-8601 UTC, so ordering in the log is lexicographic and unambiguous.
    //
    // The two association fields are omitted when null, which is every entry
    // but an admin's audit-log read. An ordinary entry therefore serialises
    // as exactly the five fields of the domain model, and a reader never has
    // to wonder what a `targetUserId: null` on a login was supposed to mean.
    toJSON() {
      const json = {
        entryId: this.entryId,
        userId: this.userId,
        action: this.action,
        timestamp: new Date(timestampMillis).toISOString(),
        ipAddress: this.ipAddress,
      };
      if (this.targetUserId !== null) {
        json.targetUserId = this.targetUserId;
      }
      if (this.actorUserId !== null) {
        json.actorUserId = this.actorUserId;
      }
      return json;
    },
  });
}

/**
 * Mints a new entry. `entryId` and `timestamp` are assigned here, never taken
 * from the caller: an append-only log where the writer chooses its own
 * identifier can overwrite an existing row, and one where the writer chooses
 * its own timestamp can backdate an action to before the breach it caused.
 *
 * @param userId     the acting User; the AuditLog is composed into one User,
 *                   but each entry carries the id so a single row is
 *                   self-describing when it reaches Cloud Logging, and so
 *                   business rule 6 ("only their own vault") stays checkable
 *                   without a join back to the log's owner.
 * @param action     one of ACTIONS.
 * @param ipAddress  the request's source address, or null for an action with
 *                   no request behind it (timers, scheduled scans).
 * @param clock      injectable, matching the services in ../services/.
 */
function createAuditEntry({
  userId,
  action,
  ipAddress,
  targetUserId,
  actorUserId,
  clock = () => Date.now(),
} = {}) {
  if (ipAddress === undefined) {
    throw new TypeError('ipAddress is required (pass null for a system-originated action)');
  }

  return freezeEntry({
    entryId: crypto.randomUUID(),
    userId,
    action,
    timestampMillis: normalizeTimestamp(clock()),
    ipAddress,
    targetUserId,
    actorUserId,
  });
}

// Rebuilds an entry already written to the log — a persisted row, not a new
// action. Reading is the only other thing an append-only log does.
function restoreAuditEntry({
  entryId,
  userId,
  action,
  timestamp,
  ipAddress,
  targetUserId,
  actorUserId,
} = {}) {
  return freezeEntry({
    entryId,
    userId,
    action,
    timestampMillis: normalizeTimestamp(timestamp),
    ipAddress,
    targetUserId,
    actorUserId,
  });
}

module.exports = { createAuditEntry, restoreAuditEntry, ACTIONS, ACTION_VALUES };
