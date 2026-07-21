const { getPool, transaction: sharedTransaction } = require('../db/pool');

// The `passwordHealth` port routes/password-health.js reads/writes through.
// PRD 0022 (UC-05). Method shapes follow ports/credentials.js and
// ports/vaults.js exactly: parameterized queries only, `transaction:
// sharedTransaction` reused rather than a second transaction helper invented
// here, and business rule 6 ("only their own vault") enforced in this file,
// not only in the route.
//
// --- The trust boundary this port sits on (PRD 0022) ------------------------
//
// Since PRD 0019 the server never holds vault plaintext, so it cannot compute
// "is this password weak" or "is this password reused" itself -- that
// analysis runs client-side, where the vault key already lives, and the
// client reports only its *conclusions* (a WEAK/REUSED/OK label per item, an
// overall score). Those labels are not secrets and are exactly what
// PASSWORD_HEALTH_REPORTS/REPORT_FINDINGS/SECURITY_ALERTS already model.
//
// This port cannot verify a label is honest -- it has no plaintext to check
// one against -- and does not try to. What it CAN and MUST verify is that
// every itemId a client reports a finding for actually belongs to the
// caller's own vault: a client (or attacker holding a stolen bearer token)
// claiming a finding about someone else's itemId is a business-rule-6
// violation, not an unverifiable label, and addFindings() below rejects it
// outright rather than silently dropping just that row.

class ItemOwnershipError extends Error {
  // `itemIds` is for the caller (the route decides what, if anything, to
  // reveal); `code` is for programmatic dispatch, same shape as
  // session-issuer.js's AuthenticationError.
  constructor(itemIds, message = "one or more itemIds do not belong to the caller's vault") {
    super(message);
    this.name = 'ItemOwnershipError';
    this.code = 'ITEM_NOT_OWNED';
    this.itemIds = itemIds;
  }
}

function mapFinding(row) {
  return { itemId: String(row.item_id), status: row.status };
}

function mapAlert(row) {
  return {
    alertId: String(row.alert_id),
    type: row.type,
    message: row.message,
    isRead: !!row.is_read,
    createdAt: row.created_at,
  };
}

// Same join shape as ports/credentials.js's OWNED_ITEM_QUERY: VAULT_ITEMS
// joined to CREDENTIALS (a finding only ever names a credential -- REPORT_
// FINDINGS.item_id's FK targets CREDENTIALS(item_id), per DATABASE.md),
// filtered on vault_id. `vaultId` alone is enough to scope this to the caller
// because it was itself just resolved from `VAULTS WHERE user_id = ?` (VAULTS
// is 1:1 with USERS, UQ_VAULTS_USER) -- there is no second user who could
// share it.
function buildOwnedItemsQuery(itemIds) {
  const placeholders = itemIds.map(() => '?').join(', ');
  return `
    SELECT vi.item_id
      FROM VAULT_ITEMS vi
      JOIN CREDENTIALS c ON c.item_id = vi.item_id
     WHERE vi.vault_id = ? AND vi.item_id IN (${placeholders})
  `;
}

/**
 * @param pool         mysql2 pool; defaults to the shared one.
 * @param transaction  defaults to db/pool.js's transaction(fn) — the same
 *                     helper every other port uses, so a report, its findings
 *                     and its alerts commit together with the audit entry
 *                     the route writes, or not at all.
 */
function createPasswordHealthPort({ pool = getPool(), transaction = sharedTransaction } = {}) {
  return {
    transaction,

    // Resolves the caller's userId -> vaultId, same query shape
    // ports/credentials.js's add() already uses inline ("SELECT vault_id FROM
    // VAULTS WHERE user_id = ?") -- reused here rather than duplicated with a
    // different spelling. `conn` defaults to the pool for read paths (GET,
    // no transaction) and is passed explicitly as `tx` on the write path, so
    // the lookup runs on whichever connection the caller is already using.
    async getVaultIdForUser(userId, conn = pool) {
      const [rows] = await conn.execute('SELECT vault_id FROM VAULTS WHERE user_id = ?', [
        userId,
      ]);
      const vault = rows[0];
      if (!vault) {
        // Every USERS row gets a VAULTS row at registration (1:1); reaching
        // this means that invariant was violated upstream, not a normal
        // "not found" the route should translate to 404 -- same reasoning as
        // ports/credentials.js's add().
        throw new Error(`no vault provisioned for user ${userId}`);
      }
      return vault.vault_id;
    },

    async createReport(tx, { vaultId, overallScore }) {
      const [result] = await tx.execute(
        'INSERT INTO PASSWORD_HEALTH_REPORTS (vault_id, overall_score) VALUES (?, ?)',
        [vaultId, overallScore]
      );
      return result.insertId;
    },

    // Business rule 6, enforced here rather than trusted from the route: every
    // itemId is checked against `vaultId` before anything is inserted. A
    // mismatch throws ItemOwnershipError instead of silently dropping just
    // that row -- a client claiming a finding about an itemId that isn't its
    // own is either a bug or an attack, and either way the whole submission
    // must fail, not partially succeed.
    //
    // One multi-row INSERT rather than one round-trip per finding, per
    // DATABASE.md's own catalogue comment ("build the VALUES list in app
    // code").
    async addFindings(tx, { vaultId, reportId, findings }) {
      if (!Array.isArray(findings) || findings.length === 0) {
        return;
      }

      const itemIds = findings.map((finding) => finding.itemId);
      const [ownedRows] = await tx.execute(buildOwnedItemsQuery(itemIds), [vaultId, ...itemIds]);
      const ownedIds = new Set(ownedRows.map((row) => String(row.item_id)));
      const notOwned = itemIds.filter((itemId) => !ownedIds.has(String(itemId)));
      if (notOwned.length > 0) {
        throw new ItemOwnershipError(notOwned);
      }

      const values = [];
      const rowPlaceholders = findings.map((finding) => {
        values.push(reportId, finding.itemId, finding.status);
        return '(?, ?, ?)';
      });
      await tx.execute(
        `INSERT INTO REPORT_FINDINGS (report_id, item_id, status) VALUES ${rowPlaceholders.join(
          ', '
        )}`,
        values
      );
    },

    // Same bulk-insert shape as addFindings. Callers must only ever pass
    // WEAK/REUSED alerts (SECURITY_ALERTS.type has no OK member) -- the route
    // is what filters findings down to those before calling this.
    async addAlerts(tx, { reportId, alerts }) {
      if (!Array.isArray(alerts) || alerts.length === 0) {
        return;
      }

      const values = [];
      const rowPlaceholders = alerts.map((alert) => {
        values.push(reportId, alert.type, alert.message);
        return '(?, ?, ?)';
      });
      await tx.execute(
        `INSERT INTO SECURITY_ALERTS (report_id, type, message) VALUES ${rowPlaceholders.join(
          ', '
        )}`,
        values
      );
    },

    // No transaction: nothing is written, so there is nothing to roll back —
    // same rationale as ports/credentials.js's get()/list(). Returns null
    // (not an error) for a vault that has never been analyzed: that is a
    // legitimate state, not a 404/500, per PRD 0022.
    async getLatestReport({ vaultId }) {
      const [reportRows] = await pool.execute(
        `SELECT report_id, vault_id, generated_at, overall_score
           FROM PASSWORD_HEALTH_REPORTS
          WHERE vault_id = ?
          ORDER BY generated_at DESC
          LIMIT 1`,
        [vaultId]
      );
      const report = reportRows[0];
      if (!report) {
        return null;
      }

      const [findingRows] = await pool.execute(
        'SELECT item_id, status FROM REPORT_FINDINGS WHERE report_id = ?',
        [report.report_id]
      );
      // Unread only, matching DATABASE.md's catalogue query for this table
      // ("Unread alerts for a user's vault") -- a read alert has already been
      // shown to the owner and isn't part of "what's new" any more.
      const [alertRows] = await pool.execute(
        `SELECT alert_id, type, message, is_read, created_at
           FROM SECURITY_ALERTS
          WHERE report_id = ? AND is_read = FALSE
          ORDER BY created_at DESC`,
        [report.report_id]
      );

      return {
        reportId: String(report.report_id),
        vaultId: String(report.vault_id),
        overallScore: report.overall_score,
        generatedAt: report.generated_at,
        findings: findingRows.map(mapFinding),
        alerts: alertRows.map(mapAlert),
      };
    },
  };
}

module.exports = { createPasswordHealthPort, ItemOwnershipError };
