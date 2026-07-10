// Keyset (cursor) pagination, not offset pagination, and the difference is
// correctness rather than taste.
//
// The audit log is append-only and ordered newest-first, so it grows at the
// head — exactly where page 1 is. With `?page=2&limit=50`, three entries
// arriving between the two requests push three rows the reader already saw
// down into page 2, and one row off the bottom of it entirely: duplicates and
// a silent skip. An activity view that loses a row is worse than one that
// paginates awkwardly, and an *audit* view that loses a row is a defect.
//
// A keyset cursor names a position — "everything strictly older than this
// entry" — so entries appended at the head cannot shift it.

const DEFAULT_PAGE_SIZE = 50;

// An unbounded `limit` is a memory and latency footgun: `?limit=10000000` on a
// long-lived log would load it all into the process to serialise it.
const MAX_PAGE_SIZE = 200;

class PaginationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaginationError';
  }
}

function parseLimit(raw) {
  if (raw === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  // Express yields an array for a repeated param (`?limit=1&limit=2`) and an
  // object for `?limit[a]=1`. Both stringify into something a numeric check
  // can be fooled by — `String(['5'])` is `'5'`, and `Number([])` is 0. Demand
  // the string form rather than coercing whatever arrived.
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) {
    throw new PaginationError('limit must be a positive integer');
  }

  const limit = Number(raw);
  if (limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new PaginationError(`limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return limit;
}

// The cursor names a position in the ordering, and nothing else. In
// particular it does not carry a userId: the caller's identity always comes
// from req.auth, so a forged or edited cursor can only move a reader around
// inside their own log — never into someone else's. That is why it needs no
// signature.
//
// `entryId` is in the cursor because `timestamp` alone is not a unique key.
// Two entries written in the same millisecond — a login and its device
// sighting, say — would make "everything older than this timestamp" either
// skip one or repeat it. The pair is unique, so the ordering is total.
function encodeCursor({ timestampMillis, entryId }) {
  return Buffer.from(`${timestampMillis}.${entryId}`, 'utf8').toString('base64url');
}

function decodeCursor(raw) {
  if (typeof raw !== 'string' || raw === '') {
    throw new PaginationError('cursor must be a string');
  }

  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('.');
  if (separator < 1) {
    throw new PaginationError('cursor is malformed');
  }

  const timestampMillis = Number(decoded.slice(0, separator));
  const entryId = decoded.slice(separator + 1);

  if (!Number.isSafeInteger(timestampMillis) || entryId === '') {
    throw new PaginationError('cursor is malformed');
  }

  return { timestampMillis, entryId };
}

const cursorFor = (entry) => encodeCursor({
  timestampMillis: entry.timestamp.getTime(),
  entryId: entry.entryId,
});

/**
 * Reads one page. `fetch(limit, after)` must return up to `limit` rows,
 * newest first, strictly older than `after`.
 *
 * One extra row is requested and discarded: it is how the page learns whether
 * a next one exists without a second COUNT query. Returning a nextCursor
 * whenever the page came back full would hand the client a cursor onto an
 * empty page as its last act — harmless, but it makes "nextCursor === null"
 * mean "probably done" instead of "done".
 */
async function readPage({ limit, after, fetch, restore }) {
  const rows = await fetch(limit + 1, after);
  const hasMore = rows.length > limit;
  const entries = rows.slice(0, limit).map(restore);

  return {
    entries,
    nextCursor: hasMore ? cursorFor(entries[entries.length - 1]) : null,
  };
}

module.exports = {
  parseLimit,
  encodeCursor,
  decodeCursor,
  cursorFor,
  readPage,
  PaginationError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
};
