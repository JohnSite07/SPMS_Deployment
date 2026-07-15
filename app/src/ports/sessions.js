const { getPool, transaction: sharedTransaction } = require('../db/pool');
const { DEFAULT_ABSOLUTE_SESSION_SECONDS } = require('../config/env');

// The `sessions` port routes/session.js and middleware/authenticate.js read
// through. Method-for-method identical to fake-database.js's `sessions`
// object.
//
// Schema target: 0014's reconciled SESSIONS — NO `token_hash` column.
// Revocation is `session_id`/JWT `jti`-based (ADR 0007): the app never
// stores a token hash, and the session row is created *before* the JWT
// exists (issueSessionToken needs `sessionId` to mint the token's `jti`), so
// a NOT NULL token_hash was never satisfiable to begin with.
//
// `expires_at` here is deliberately the session's ABSOLUTE cap
// (DEFAULT_ABSOLUTE_SESSION_SECONDS, 12h), not the 10-minute idle TTL. The
// idle window is enforced entirely by the JWT's own `exp` claim, which
// token-service.js slides forward on every request without writing to this
// table. If this column instead held the 10-minute idle deadline, a session
// that was still actively sliding its JWT would be reported revoked by
// isRevoked() the moment the *first* idle window lapsed — locking out every
// active user after ten minutes. `expires_at` is a backstop against a
// session outliving the login that created it, not the fine-grained idle
// clock.
const DEFAULT_SESSION_TTL_SECONDS = DEFAULT_ABSOLUTE_SESSION_SECONDS;

function createSessionsPort({
  pool = getPool(),
  transaction = sharedTransaction,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
} = {}) {
  return {
    transaction,

    async start(tx, { userId }) {
      const conn = tx ?? pool;
      const [result] = await conn.execute(
        'INSERT INTO SESSIONS (user_id, expires_at) VALUES (?, DATE_ADD(NOW(), INTERVAL ? SECOND))',
        [userId, ttlSeconds]
      );
      return { sessionId: String(result.insertId) };
    },

    // A DELETE, not a soft revoke flag: the row and the session are the same
    // thing (there is no other state a "live" row could be in), and deleting
    // it is what makes isRevoked() answer true without a second column to
    // keep in sync.
    async revoke(tx, sessionId) {
      const conn = tx ?? pool;
      await conn.execute('DELETE FROM SESSIONS WHERE session_id = ?', [sessionId]);
    },

    // PRD 0015 (password reset): a successful reset must kick every live
    // session, not just the one the reset was performed from — a thief
    // mid-session is logged out the moment the owner regains control. A
    // DELETE by user_id, same reasoning as revoke()'s DELETE by session_id:
    // the row and the session are the same thing, so removing it is what
    // makes isRevoked() answer true for all of them.
    async revokeAllForUser(tx, { userId }) {
      const conn = tx ?? pool;
      await conn.execute('DELETE FROM SESSIONS WHERE user_id = ?', [userId]);
    },

    // Fail closed: absent OR expired both answer `true`. A row that was never
    // started (rolled back with its transaction), was explicitly revoked, or
    // simply outlived its cap is treated identically to "revoked" — there is
    // no state in which an unresolvable session id is honoured.
    async isRevoked(sessionId) {
      if (sessionId === undefined || sessionId === null || sessionId === '') {
        return true;
      }
      const [rows] = await pool.execute(
        'SELECT session_id FROM SESSIONS WHERE session_id = ? AND expires_at > NOW()',
        [sessionId]
      );
      return rows.length === 0;
    },
  };
}

module.exports = { createSessionsPort, DEFAULT_SESSION_TTL_SECONDS };
