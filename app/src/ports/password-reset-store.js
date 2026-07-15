const { getPool, transaction: sharedTransaction } = require('../db/pool');

// The `resetTokens` port routes/password-reset.js reads/writes through.
// Hash-only, single-use, per PRD 0015: PASSWORD_RESET_TOKENS never stores
// the raw token (routes/password-reset.js hashes it with SHA-256 before this
// module ever sees it), and `consume()` is the single door through which a
// token becomes unusable a second time.

/**
 * @param pool         mysql2 pool; defaults to the shared one.
 * @param transaction  defaults to db/pool.js's transaction(fn) — the same
 *                      helper every other port uses, so a token consumption,
 *                      a password-hash update, and a session revocation can
 *                      share one connection and commit or roll back together.
 */
function createPasswordResetStore({ pool = getPool(), transaction = sharedTransaction } = {}) {
  return {
    transaction,

    /**
     * @param tx          the transaction connection from `transaction(fn)`.
     * @param userId      the account the token was minted for.
     * @param tokenHash   a 32-byte Buffer — SHA-256 of the raw token. Never
     *                    the raw token itself.
     * @param expiresAt   a Date; PASSWORD_RESET_TOKENS.CK_PRT_EXPIRY requires
     *                    it to be after `created_at` (the DB default `NOW()`).
     */
    async create(tx, { userId, tokenHash, expiresAt }) {
      const conn = tx ?? pool;
      await conn.execute(
        'INSERT INTO PASSWORD_RESET_TOKENS (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
        [userId, tokenHash, expiresAt]
      );
    },

    /**
     * Atomically marks a token used and returns who it belonged to — or
     * returns null if it never existed, already expired, or was already
     * used. The single-use guarantee lives entirely in the UPDATE's WHERE
     * clause: only one concurrent call can match an unused, unexpired row,
     * so two simultaneous /confirm requests for the same token cannot both
     * succeed.
     *
     * @param tx         the transaction connection.
     * @param tokenHash  a 32-byte Buffer — SHA-256 of the raw token.
     * @returns {Promise<{ userId: string } | null>}
     */
    async consume(tx, { tokenHash }) {
      const conn = tx ?? pool;
      const [result] = await conn.execute(
        `UPDATE PASSWORD_RESET_TOKENS
            SET used_at = NOW()
          WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()`,
        [tokenHash]
      );
      if (result.affectedRows === 0) {
        return null;
      }

      const [rows] = await conn.execute(
        'SELECT user_id FROM PASSWORD_RESET_TOKENS WHERE token_hash = ?',
        [tokenHash]
      );
      const row = rows[0];
      return row ? { userId: String(row.user_id) } : null;
    },
  };
}

module.exports = { createPasswordResetStore };
