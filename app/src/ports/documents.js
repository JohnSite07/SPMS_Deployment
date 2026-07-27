const crypto = require('crypto');
const { getPool, transaction: sharedTransaction } = require('../db/pool');

// The `documents` port routes/documents.js reads/writes through (PRD 0025,
// UC-04/UC-06). Same class-table-inheritance shape as ports/credentials.js:
// VAULT_ITEMS (supertype: title, timestamps) + SECURE_DOCUMENTS (subtype:
// file_name/file_type/file_size_kb/object_key), joined through VAULTS to
// reach `user_id` — VAULT_ITEMS itself carries no owner column, only
// `vault_id`. Every read/write below joins all the way to VAULTS.user_id and
// filters on it (business rule 6); an itemId is never trusted alone.
//
// The one thing this port has that credentials.js doesn't: the ciphertext
// itself is not a column here. It is an opaque blob in Cloud Storage (PRD
// 0024), addressed by the random `object_key` this module mints and stores
// — never derived from, or used to derive, anything about the owner. Two
// systems (MySQL + the blob store) means one MySQL transaction can no longer
// give this port the atomicity credentials.js gets for free; see add()'s and
// remove()'s comments for how each direction of that gap is closed.

function mapMetadata(row) {
  if (!row) {
    return null;
  }
  return {
    itemId: String(row.item_id),
    userId: String(row.user_id),
    fileName: row.file_name,
    fileType: row.file_type,
    fileSizeKb: row.file_size_kb,
    objectKey: row.object_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const OWNED_DOC_QUERY = `
  SELECT vi.item_id, v.user_id, vi.title, vi.created_at, vi.updated_at,
         d.file_name, d.file_type, d.file_size_kb, d.object_key
    FROM VAULT_ITEMS vi
    JOIN SECURE_DOCUMENTS d ON d.item_id = vi.item_id
    JOIN VAULTS v ON v.vault_id = vi.vault_id
   WHERE vi.item_id = ? AND v.user_id = ?
`;

// Same join shape as OWNED_DOC_QUERY, minus the single-item_id filter, for
// the whole-vault document listing (PRD 0025). Newest-updated-first, mirroring
// ports/credentials.js's own OWNED_ITEMS_QUERY ordering.
const OWNED_DOCS_QUERY = `
  SELECT vi.item_id, v.user_id, vi.title, vi.created_at, vi.updated_at,
         d.file_name, d.file_type, d.file_size_kb, d.object_key
    FROM VAULT_ITEMS vi
    JOIN SECURE_DOCUMENTS d ON d.item_id = vi.item_id
    JOIN VAULTS v ON v.vault_id = vi.vault_id
   WHERE v.user_id = ?
   ORDER BY vi.updated_at DESC
`;

async function fetchOwned(conn, { userId, itemId }) {
  const [rows] = await conn.execute(OWNED_DOC_QUERY, [itemId, userId]);
  return mapMetadata(rows[0]);
}

/**
 * @param pool       a mysql2 pool (or pool-shaped test double); reads that
 *                   need no transaction go through this.
 * @param transaction db/pool.js's transaction(fn) (or a test double of the
 *                   same shape) — every write below runs on the connection
 *                   it hands in.
 * @param blobStore  ports/blob-store.js's interface: put/get/remove keyed by
 *                   `object_key`. Required — there is deliberately no
 *                   default and no "unimplemented" fallback (see
 *                   blob-store.js's header): a documents port built with no
 *                   blob store wired must fail at construction, not silently
 *                   store metadata for a blob that was never written.
 */
function createDocumentsPort({
  pool = getPool(),
  transaction = sharedTransaction,
  blobStore,
} = {}) {
  if (!blobStore || typeof blobStore.put !== 'function') {
    throw new TypeError('blobStore is required (see ports/blob-store.js)');
  }

  return {
    transaction,

    // UC-04. Two systems, one call: the ciphertext goes to the blob store
    // FIRST, then the VAULT_ITEMS/SECURE_DOCUMENTS rows go in on the
    // caller's transaction connection (per routes/documents.js, sharing the
    // same tx as the DOCUMENT_STORED audit entry — a document that commits
    // without its entry would be unlogged, exactly as for a credential).
    //
    // Blob-first is deliberate: only once the object exists can a failed
    // insert be compensated for by deleting it again. If either INSERT
    // throws, the just-written object is removed here before the error
    // propagates, so a rolled-back DB write never leaves an orphaned blob
    // behind it (PRD 0025's "two-system consistency", add order). A failure
    // in a step *after* this method returns (e.g. the audit entry itself)
    // is the caller's responsibility to compensate for — see
    // routes/documents.js's POST handler, which wraps the whole
    // `store.transaction(...)` call for exactly that reason.
    async add(tx, { userId, fileName, fileType, fileSizeKb, ciphertext }) {
      const [vaultRows] = await tx.execute('SELECT vault_id FROM VAULTS WHERE user_id = ?', [
        userId,
      ]);
      const vault = vaultRows[0];
      if (!vault) {
        // Every USERS row gets a VAULTS row at registration (1:1,
        // DATABASE.md UQ_VAULTS_USER); reaching this means that invariant
        // was violated upstream, not a normal "not found" the route should
        // translate to 404.
        throw new Error(`no vault provisioned for user ${userId}`);
      }

      const objectKey = crypto.randomUUID();
      await blobStore.put(objectKey, ciphertext);

      try {
        const [itemResult] = await tx.execute(
          "INSERT INTO VAULT_ITEMS (vault_id, item_type, title) VALUES (?, 'DOCUMENT', ?)",
          [vault.vault_id, fileName]
        );
        const itemId = itemResult.insertId;

        await tx.execute(
          `INSERT INTO SECURE_DOCUMENTS (item_id, file_name, file_type, file_size_kb, object_key)
           VALUES (?, ?, ?, ?, ?)`,
          [itemId, fileName, fileType, fileSizeKb, objectKey]
        );

        return fetchOwned(tx, { userId, itemId });
      } catch (err) {
        // Compensating delete. Best-effort: a failure removing the orphan
        // must never mask the original error that caused it — the caller
        // (routes/documents.js) still rolls back and 500s either way.
        await blobStore.remove(objectKey).catch(() => {});
        throw err;
      }
    },

    // Metadata only — never fetches the blob. Filtered through VAULTS.user_id
    // (business rule 6), same as ports/credentials.js's list().
    async list({ userId }) {
      const [rows] = await pool.execute(OWNED_DOCS_QUERY, [userId]);
      return rows.map(mapMetadata);
    },

    // Metadata + the ciphertext stream. No transaction: nothing is written,
    // so there is nothing to roll back, and the route's own ordering (log
    // the access, then respond) is what gives the atomicity guarantee, same
    // as ports/credentials.js's get().
    async get({ userId, itemId }) {
      const metadata = await fetchOwned(pool, { userId, itemId });
      if (!metadata) {
        return null;
      }
      const stream = await blobStore.get(metadata.objectKey);
      return { ...metadata, stream };
    },

    // UC-04 delete direction: DB rows first, on the caller's transaction
    // (again sharing it with the DOCUMENT_DELETED audit entry), GCS object
    // after — deliberately the opposite order from add(). A dangling blob
    // (GCS delete fails after the DB commit) is cheap and invisible to the
    // user; a dangling row pointing at a missing blob is the failure mode
    // that matters, so the row must be gone before anything touches the
    // object. Returns the `object_key` the caller deletes once this
    // transaction has actually committed (routes/documents.js) — never
    // deleted from here, before that commit is certain.
    async remove(tx, { userId, itemId }) {
      const owned = await fetchOwned(tx, { userId, itemId });
      if (!owned) {
        return null;
      }

      const [result] = await tx.execute(
        `DELETE vi FROM VAULT_ITEMS vi
           JOIN VAULTS v ON v.vault_id = vi.vault_id
          WHERE vi.item_id = ? AND v.user_id = ?`,
        [itemId, userId]
      );
      if (result.affectedRows === 0) {
        return null;
      }
      return { objectKey: owned.objectKey };
    },

    // Thin pass-through so routes/documents.js never holds `blobStore`
    // directly — it only ever addresses the blob store through this port,
    // for the post-commit delete (remove()) and the route's own
    // compensating delete on a failed add().
    async removeBlob(objectKey) {
      return blobStore.remove(objectKey);
    },
  };
}

module.exports = { createDocumentsPort };
