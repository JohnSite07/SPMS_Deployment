const { getPool, transaction: sharedTransaction } = require('../db/pool');

// The `credentials` port routes/credentials.js reads/writes through.
// Method-for-method identical to fake-database.js's `credentials` object.
// Class-table inheritance per DATABASE.md: VAULT_ITEMS (supertype: title,
// timestamps) + CREDENTIALS (subtype: url/username/ciphertext), joined
// through VAULTS to reach `user_id` — VAULT_ITEMS itself carries no owner
// column, only `vault_id`.
//
// Every read/write below joins all the way to VAULTS.user_id and filters on
// it. Business rule 6 ("only their own vault") lives in this file, not only
// in the route: an itemId is never trusted alone, exactly as
// fake-database.js's own comment on `get()` says.

// --- Reconciliation gap: encryptedPassword vs. encrypted_password/password_iv/password_tag ---
//
// The app is zero-knowledge and client-side encrypted (see routes/
// credentials.js's header comment): the route hands this adapter ONE opaque
// ciphertext string per credential (`encryptedPassword`) and the server
// never has a separate IV or auth tag to store — whatever AES-GCM framing
// the client used lives inside that single blob, which the server cannot
// parse and must not try to.
//
// DATABASE.md's CREDENTIALS table instead models a server-side-encrypted
// design: `encrypted_password VARBINARY(512) NOT NULL`, `password_iv
// VARBINARY(12) NOT NULL` (exact-length CHECK), `password_tag VARBINARY(16)
// NOT NULL` (exact-length CHECK) — three columns for a value the app only
// ever has one of. This was flagged as unresolved in PRD 0009 rather than
// invented around: the two placeholder buffers below exist ONLY to satisfy
// the NOT NULL + exact-length CHECK constraints on columns this application
// does not use. They carry no cryptographic meaning, are never derived from
// `encryptedPassword`, and are never read back (mapRow() never returns
// them). The opaque ciphertext itself goes into `encrypted_password` alone.
//
// Recommended fix (out of this PRD's scope — a schema change under a future
// 0014-style migration): drop `password_iv`/`password_tag` from CREDENTIALS
// and keep a single opaque `encrypted_password` column, matching how the app
// actually encrypts. See this PRD's final report for the same note.
const UNUSED_IV_PLACEHOLDER = Buffer.alloc(12);
const UNUSED_TAG_PLACEHOLDER = Buffer.alloc(16);

function mapRow(row) {
  if (!row) {
    return null;
  }
  return {
    itemId: String(row.item_id),
    userId: String(row.user_id),
    title: row.title,
    url: row.url ?? null,
    username: row.username ?? null,
    // The client's ciphertext is opaque text (e.g. base64); stored as
    // VARBINARY, so the driver hands it back as a Buffer of those same
    // bytes. Decoding as utf8 recovers exactly the string the route was
    // given — never anything the server itself encrypted or decrypted.
    encryptedPassword: Buffer.isBuffer(row.encrypted_password)
      ? row.encrypted_password.toString('utf8')
      : row.encrypted_password,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const OWNED_ITEM_QUERY = `
  SELECT vi.item_id, v.user_id, vi.title, vi.created_at, vi.updated_at,
         c.url, c.username, c.encrypted_password
    FROM VAULT_ITEMS vi
    JOIN CREDENTIALS c ON c.item_id = vi.item_id
    JOIN VAULTS v ON v.vault_id = vi.vault_id
   WHERE vi.item_id = ? AND v.user_id = ?
`;

async function fetchOwned(conn, { userId, itemId }) {
  const [rows] = await conn.execute(OWNED_ITEM_QUERY, [itemId, userId]);
  return mapRow(rows[0]);
}

// Same join shape as OWNED_ITEM_QUERY, minus the single-item_id filter, for
// the whole-vault listing PRD 0019 adds. Ordered newest-updated-first,
// matching DATABASE.md's VAULT_ITEMS listing pattern (`ORDER BY updated_at
// DESC`) rather than the CREDENTIALS-specific catalogue entry that instead
// alphabetises by title -- newest-first is what a vault list UI wants (most
// recently touched items surface first) and is what this PRD calls for.
const OWNED_ITEMS_QUERY = `
  SELECT vi.item_id, v.user_id, vi.title, vi.created_at, vi.updated_at,
         c.url, c.username, c.encrypted_password
    FROM VAULT_ITEMS vi
    JOIN CREDENTIALS c ON c.item_id = vi.item_id
    JOIN VAULTS v ON v.vault_id = vi.vault_id
   WHERE v.user_id = ?
   ORDER BY vi.updated_at DESC
`;

function createCredentialsPort({ pool = getPool(), transaction = sharedTransaction } = {}) {
  return {
    transaction,

    // UC-02. Resolves the caller's vault (1:1 with USERS — see DATABASE.md),
    // inserts the VAULT_ITEMS supertype row, then the CREDENTIALS subtype
    // row sharing its item_id, all on the caller's transaction connection so
    // a credential that commits without its audit entry is impossible.
    async add(tx, { userId, title, url, username, encryptedPassword }) {
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

      const [itemResult] = await tx.execute(
        "INSERT INTO VAULT_ITEMS (vault_id, item_type, title) VALUES (?, 'CREDENTIAL', ?)",
        [vault.vault_id, title]
      );
      const itemId = itemResult.insertId;

      await tx.execute(
        `INSERT INTO CREDENTIALS (item_id, url, username, encrypted_password, password_iv, password_tag)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          itemId,
          url ?? null,
          username ?? null,
          encryptedPassword,
          UNUSED_IV_PLACEHOLDER,
          UNUSED_TAG_PLACEHOLDER,
        ]
      );

      return fetchOwned(tx, { userId, itemId });
    },

    // UC-03. No transaction: nothing is written, so there is nothing to roll
    // back, and the route's own ordering (log the access, then respond) is
    // what gives the atomicity guarantee here, not this method.
    async get({ userId, itemId }) {
      return fetchOwned(pool, { userId, itemId });
    },

    // The whole-vault listing PRD 0019 adds, for the vault list UI. Same "no
    // transaction" rationale as get() above: nothing is written, so there is
    // nothing to roll back. Every row is still filtered through VAULTS.user_id
    // (business rule 6) -- a listing that trusted a caller-supplied vault id
    // instead would let one user page through another user's items.
    async list({ userId }) {
      const [rows] = await pool.execute(OWNED_ITEMS_QUERY, [userId]);
      return rows.map(mapRow);
    },

    async update(tx, { userId, itemId, patch }) {
      const [ownedRows] = await tx.execute(
        `SELECT vi.item_id
           FROM VAULT_ITEMS vi
           JOIN VAULTS v ON v.vault_id = vi.vault_id
          WHERE vi.item_id = ? AND v.user_id = ?
          FOR UPDATE`,
        [itemId, userId]
      );
      if (!ownedRows[0]) {
        return null;
      }

      if (patch.title !== undefined) {
        await tx.execute('UPDATE VAULT_ITEMS SET title = ? WHERE item_id = ?', [
          patch.title,
          itemId,
        ]);
      }

      const setClauses = [];
      const values = [];
      if (patch.url !== undefined) {
        setClauses.push('url = ?');
        values.push(patch.url);
      }
      if (patch.username !== undefined) {
        setClauses.push('username = ?');
        values.push(patch.username);
      }
      if (patch.encryptedPassword !== undefined) {
        setClauses.push('encrypted_password = ?', 'last_changed = CURRENT_TIMESTAMP');
        values.push(patch.encryptedPassword);
      }
      if (setClauses.length > 0) {
        values.push(itemId);
        await tx.execute(`UPDATE CREDENTIALS SET ${setClauses.join(', ')} WHERE item_id = ?`, values);
      }

      return fetchOwned(tx, { userId, itemId });
    },

    // Deletes the VAULT_ITEMS row directly, filtered through VAULTS so a
    // stranger's itemId matches nothing; CREDENTIALS' FK_CREDENTIALS_ITEMS
    // (ON DELETE CASCADE) removes the subtype row as a consequence, matching
    // DATABASE.md's documented delete pattern.
    async remove(tx, { userId, itemId }) {
      const [result] = await tx.execute(
        `DELETE vi FROM VAULT_ITEMS vi
           JOIN VAULTS v ON v.vault_id = vi.vault_id
          WHERE vi.item_id = ? AND v.user_id = ?`,
        [itemId, userId]
      );
      return result.affectedRows > 0;
    },
  };
}

module.exports = { createCredentialsPort, UNUSED_IV_PLACEHOLDER, UNUSED_TAG_PLACEHOLDER };
