const { getPool, transaction: sharedTransaction } = require('../db/pool');
const { restoreAuditEntry } = require('../models/audit-entry');

// Two factory functions, deliberately not one object: `createAuditReaderPort`
// (list/get/transaction) can read but never append, and `createAuditAppend`
// (the function below it) can append but never read. app.js wires them to
// different collaborators (`auditReader` vs `audit`) for exactly this
// reason — no single object in the process holds both halves of the
// append-only log.
//
// Schema target: 0014's reconciled AUDIT_ENTRIES — `entry_id INT
// AUTO_INCREMENT` (kept, not migrated to CHAR(36) — see that PRD's
// "Audit id" decision), `target_user_id`/`actor_user_id`, `event_time
// DATETIME(3)`, all three FKs `ON DELETE RESTRICT`.

function mapRow(row) {
  return {
    entryId: String(row.entry_id),
    userId: String(row.user_id),
    action: row.action,
    timestamp: row.event_time,
    ipAddress: row.ip_address ?? null,
    targetUserId: row.target_user_id === null || row.target_user_id === undefined
      ? null
      : String(row.target_user_id),
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined
      ? null
      : String(row.actor_user_id),
  };
}

// Rows are pushed back through restoreAuditEntry().toJSON() — never handed
// out as a raw SELECT result — so a row tampered with at rest (a hand-edited
// action, an out-of-vocabulary value) fails to rehydrate instead of being
// served as a well-formed entry. This mirrors what routes/audit.js's own
// `present()` does to fake-database.js's rows; doing it here too means both
// adapters satisfy the same contract even before the route re-validates.
function present(row) {
  return restoreAuditEntry(mapRow(row)).toJSON();
}

const SELECT_COLUMNS =
  'entry_id, user_id, action, event_time, ip_address, target_user_id, actor_user_id';

function createAuditReaderPort({ pool = getPool(), transaction = sharedTransaction } = {}) {
  return {
    transaction,

    // Newest first, keyset-paginated on (event_time, entry_id) — the same
    // total order fake-database.js's `newestFirst`/`strictlyOlder` implement
    // in memory. `after` is `{ timestampMillis, entryId }` from
    // routes/pagination.js's decodeCursor(); `entryId` here is the numeric
    // `entry_id` as a string (0014 kept it INT), so it is cast back to a
    // number for the comparison.
    async list({ userId, limit, after = null }) {
      const params = [userId];
      let whereAfter = '';
      if (after) {
        whereAfter = ' AND (event_time < ? OR (event_time = ? AND entry_id < ?))';
        const cursorTime = new Date(after.timestampMillis);
        params.push(cursorTime, cursorTime, Number(after.entryId));
      }
      params.push(limit);

      const [rows] = await pool.execute(
        `SELECT ${SELECT_COLUMNS}
           FROM AUDIT_ENTRIES
          WHERE user_id = ?${whereAfter}
          ORDER BY event_time DESC, entry_id DESC
          LIMIT ?`,
        params
      );

      return rows.map(present);
    },

    async get({ userId, entryId }) {
      const [rows] = await pool.execute(
        `SELECT ${SELECT_COLUMNS} FROM AUDIT_ENTRIES WHERE entry_id = ? AND user_id = ?`,
        [entryId, userId]
      );
      return rows[0] ? present(rows[0]) : null;
    },
  };
}

// The audit log's only writer (services/audit-log.js's `append`). Takes the
// frozen AuditEntry `logAction()` built and the opaque `context` a route
// handed down — the transaction connection its own write is running in, so
// this INSERT commits with the row it describes or not at all. `context` is
// undefined for a write with nothing to join (there is none on the request
// path today; every route supplies its transaction), in which case this
// falls back to a bare pool connection.
//
// entry_id is never in the INSERT list: 0014 kept it INT AUTO_INCREMENT, so
// the DB assigns it — the writer still cannot choose or overwrite an id
// (ADR 0006's guarantee), just via AUTO_INCREMENT rather than the app's
// minted UUID.
function createAuditAppend({ pool = getPool() } = {}) {
  return async function append(entry, context) {
    const conn = context ?? pool;
    await conn.execute(
      `INSERT INTO AUDIT_ENTRIES (user_id, action, event_time, ip_address, target_user_id, actor_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.userId, entry.action, entry.timestamp, entry.ipAddress, entry.targetUserId, entry.actorUserId]
    );
  };
}

module.exports = { createAuditReaderPort, createAuditAppend };
