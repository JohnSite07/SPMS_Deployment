// A tiny, hand-rolled stand-in for a mysql2 pool/connection, scoped to
// exactly the queries src/ports/documents.js issues. This is NOT a general
// SQL engine -- it pattern-matches the handful of fixed query shapes that
// module uses (VAULTS lookup, VAULT_ITEMS/SECURE_DOCUMENTS insert, the
// class-table-inheritance join, and the ownership-filtered delete) and
// answers them the way MySQL would for a schema this small.
//
// Why this exists instead of just using tests/helpers/fake-database.js's
// `documents` fake: that fake stands in for the whole port (it never calls
// createDocumentsPort() at all -- see its own comment), which is the right
// tool for route-level tests. This one instead drives the REAL port module,
// so the join-based ownership queries and the add() compensating-delete
// path are exercised as actual SQL text against actual bound parameters, not
// re-implemented a second time by a mock.

function normalize(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * @param failOn  a substring of a query's normalized SQL text; the first
 *                execute() call whose SQL contains it rejects with a
 *                'simulated DB failure' Error instead of running -- the
 *                hook a compensating-delete test uses to fail "mid-add".
 */
function createFakeDocumentsConnection({ failOn } = {}) {
  let vaultSeq = 1;
  let itemSeq = 100;
  const vaultIdByUser = new Map();
  const userIdByVault = new Map();
  const items = new Map(); // itemId -> { vaultId, title, createdAt, updatedAt }
  const docs = new Map(); // itemId -> { fileName, fileType, fileSizeKb, objectKey }

  function seedVault(userId) {
    const vaultId = vaultSeq;
    vaultSeq += 1;
    vaultIdByUser.set(userId, vaultId);
    userIdByVault.set(vaultId, userId);
    return vaultId;
  }

  function ownedRow(itemId, userId) {
    const item = items.get(itemId);
    const doc = docs.get(itemId);
    if (!item || !doc) {
      return null;
    }
    if (userIdByVault.get(item.vaultId) !== userId) {
      return null;
    }
    return {
      item_id: itemId,
      user_id: userId,
      title: item.title,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
      file_name: doc.fileName,
      file_type: doc.fileType,
      file_size_kb: doc.fileSizeKb,
      object_key: doc.objectKey,
    };
  }

  async function execute(sql, params = []) {
    const q = normalize(sql);

    if (failOn && q.includes(failOn)) {
      throw new Error('simulated DB failure');
    }

    if (q === 'SELECT vault_id FROM VAULTS WHERE user_id = ?') {
      const [userId] = params;
      const vaultId = vaultIdByUser.get(userId);
      return [vaultId ? [{ vault_id: vaultId }] : []];
    }

    if (q.startsWith('INSERT INTO VAULT_ITEMS')) {
      const [vaultId, title] = params;
      const itemId = itemSeq;
      itemSeq += 1;
      const now = new Date();
      items.set(itemId, { vaultId, title, createdAt: now, updatedAt: now });
      return [{ insertId: itemId }];
    }

    if (q.startsWith('INSERT INTO SECURE_DOCUMENTS')) {
      const [itemId, fileName, fileType, fileSizeKb, objectKey] = params;
      docs.set(Number(itemId), { fileName, fileType, fileSizeKb, objectKey });
      return [{ affectedRows: 1 }];
    }

    if (q.includes('WHERE vi.item_id = ? AND v.user_id = ?') && q.startsWith('SELECT')) {
      const [itemId, userId] = params;
      const row = ownedRow(Number(itemId), userId);
      return [row ? [row] : []];
    }

    if (q.startsWith('SELECT') && q.includes('WHERE v.user_id = ?') && q.includes('ORDER BY')) {
      const [userId] = params;
      const rows = [...items.keys()]
        .map((itemId) => ownedRow(itemId, userId))
        .filter(Boolean)
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
      return [rows];
    }

    if (q.startsWith('DELETE vi FROM VAULT_ITEMS')) {
      const [itemId, userId] = params;
      const row = ownedRow(Number(itemId), userId);
      if (!row) {
        return [{ affectedRows: 0 }];
      }
      items.delete(Number(itemId));
      docs.delete(Number(itemId));
      return [{ affectedRows: 1 }];
    }

    throw new Error(`fake documents connection: unhandled query: ${q}`);
  }

  return { execute, seedVault };
}

module.exports = { createFakeDocumentsConnection };
