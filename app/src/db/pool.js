const mysql = require('mysql2/promise');

// The one connection pool behind every port, and the one place `BEGIN` /
// `COMMIT` / `ROLLBACK` are spelled out. Every port's `transaction(fn)` is
// this same function — a credential write and its audit entry share a real
// transaction only because they share this helper, not because each adapter
// reimplements one.
//
// Config comes from the environment only (container-first, see
// config/env.js): no default, no localhost fallback, no committed .env. A
// revision missing a DB var must fail the operation that needed it, not
// silently talk to the wrong database.

const REQUIRED_VARS = Object.freeze(['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']);

function loadDbConfig(env = process.env) {
  const missing = REQUIRED_VARS.filter((key) => !env[key]);
  if (missing.length > 0) {
    // Names only, never values — the values are the secrets.
    throw new Error(
      `Missing required DB env var(s): ${missing.join(', ')}. Cloud Run injects these from ` +
        'Secret Manager / the Cloud SQL instance config; locally, export them yourself.'
    );
  }

  const port = Number(env.DB_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`DB_PORT must be a positive integer; got "${env.DB_PORT}"`);
  }

  return {
    host: env.DB_HOST,
    port,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
  };
}

function createPool(config = loadDbConfig()) {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    waitForConnections: true,
    connectionLimit: 10,
    // DATETIME(3) columns come back as JS Date objects (not strings), which
    // is what models/audit-entry.js's normalizeTimestamp() and every port's
    // row mapper expect.
    dateStrings: false,
  });
}

// Lazy and memoised: requiring this module must never itself attempt a
// connection or even validate the env — only calling getPool()/transaction()
// does, and only on first use. That is what lets ports/*.js be required by
// tests with no DB_* vars set at all (see tests/ports/*.contract.test.js,
// which skip the real half without ever importing this file eagerly enough
// to throw).
let sharedPool = null;

function getPool() {
  if (!sharedPool) {
    sharedPool = createPool();
  }
  return sharedPool;
}

/**
 * Runs `fn(tx)` inside a real transaction on a single pooled connection.
 * `tx` is that connection — every port's write methods take it as their
 * first argument and call `tx.execute(...)` on it so the credential/session
 * row and its audit entry commit together or not at all (business rule 7's
 * atomicity requirement, and the reason a route never opens its own
 * connection).
 *
 * Commits on resolve, rolls back on throw, always releases the connection
 * back to the pool — including when `fn` throws before doing anything, and
 * when commit/rollback itself throws.
 */
async function transaction(fn) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// For tests and graceful shutdown; not called on the request path.
async function closePool() {
  if (sharedPool) {
    const toClose = sharedPool;
    sharedPool = null;
    await toClose.end();
  }
}

module.exports = { loadDbConfig, createPool, getPool, transaction, closePool, REQUIRED_VARS };
