const { createAuditReaderPort } = require('../src/ports/audit-reader');

// Regression guard for the /api/audit 500.
//
// mysql2 types every JS number as DOUBLE in the binary protocol
// (lib/packets/encode_parameter.js), and MySQL demands an integer for LIMIT,
// so `LIMIT ?` was rejected with "Incorrect arguments to mysqld_stmt_execute"
// on every read — the activity page could never load a row.
//
// The real adapter suite (ports/mysql.contract.test.js) only runs with a live
// database, so it caught nothing locally and nothing in CI. These tests need
// no DB: they inspect the SQL the port actually builds, which is where the
// defect lived.

function fakePool(rows = []) {
  const calls = [];
  return {
    calls,
    execute: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      return [rows];
    }),
  };
}

const CURSOR = { timestampMillis: 1_700_000_000_000, entryId: '42' };

describe('audit reader LIMIT handling', () => {
  it('never binds LIMIT as a parameter', async () => {
    const pool = fakePool();
    await createAuditReaderPort({ pool }).list({ userId: '7', limit: 20 });

    const { sql, params } = pool.calls[0];
    expect(sql).not.toMatch(/LIMIT\s*\?/i);
    expect(sql).toMatch(/LIMIT\s+20\b/);
    // The count must not linger in the bind list either — a stray trailing
    // param would shift every placeholder and silently corrupt the WHERE.
    expect(params).toEqual(['7']);
  });

  it('keeps the cursor comparison parameterised', async () => {
    const pool = fakePool();
    await createAuditReaderPort({ pool }).list({ userId: '7', limit: 5, after: CURSOR });

    const { sql, params } = pool.calls[0];
    expect(sql).toMatch(/LIMIT\s+5\b/);
    // Only the limit was inlined; the cursor values are still bound.
    expect(params).toHaveLength(4);
    expect(params[0]).toBe('7');
    expect(params[3]).toBe(42);
  });

  // The limit is the one value that reaches SQL as text, so it carries the
  // injection risk the bind list otherwise removes.
  it.each([
    ['1; DROP TABLE AUDIT_ENTRIES', 'a SQL fragment'],
    ['20 OR 1=1', 'a boolean tail'],
    [1.5, 'a non-integer'],
    [0, 'zero'],
    [-1, 'a negative'],
    [Number.NaN, 'NaN'],
    [undefined, 'undefined'],
    [null, 'null'],
    [1001, 'a count above the ceiling'],
  ])('refuses %p (%s) without querying', async (limit) => {
    const pool = fakePool();
    const port = createAuditReaderPort({ pool });

    await expect(port.list({ userId: '7', limit })).rejects.toThrow(TypeError);
    // The guard runs before the query is built, so nothing reached the server.
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('accepts a numeric string, since readPage arithmetic yields numbers', async () => {
    const pool = fakePool();
    await createAuditReaderPort({ pool }).list({ userId: '7', limit: '30' });

    expect(pool.calls[0].sql).toMatch(/LIMIT\s+30\b/);
  });
});
