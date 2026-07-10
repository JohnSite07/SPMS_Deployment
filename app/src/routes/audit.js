const express = require('express');
const { restoreAuditEntry } = require('../models/audit-entry');
const { parseLimit, decodeCursor, readPage, PaginationError } = require('./pagination');

// Business rule 7, enforced at the edge: the audit log is append-only and
// cannot be edited by users.
//
// "Append-only" here is stricter than it sounds, and the strictness is the
// point. Users cannot edit an entry, cannot delete one, and cannot *write*
// one either. Entries are a side effect of doing something — services/
// audit-log.js is the only writer, called from the flows themselves. A POST
// endpoint would let a user forge a record of an action they never took,
// which corrupts the log exactly as thoroughly as editing one, and is the
// easier attack: no existing entry has to be found first.
//
// So the resource is read-only over HTTP, and every mutating method is
// refused by name rather than left to fall through to a 404. A 404 would say
// "no such route" — true today, and silently false the day somebody adds one.
// A 405 says "this resource does not permit that, ever".

// 405 rather than 403. 403 means "you are not allowed to do this", which
// invites the reading that a sufficiently privileged caller would be — and
// there is no such caller. 405 means the method does not exist on this
// resource for anyone, which is the guarantee business rule 7 actually makes.
// The Allow header is mandatory on a 405 (RFC 9110 §15.5.6).
const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';

function refuseMutation(req, res) {
  res.set('Allow', ALLOWED_METHODS);

  // Preflight and discovery are not mutations; answering them with 405 would
  // break CORS for a browser client that only ever intended to read.
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  return res.status(405).json({
    error: 'method_not_allowed',
    error_description: 'The audit log is append-only.',
  });
}

/**
 * The user-facing activity view.
 *
 * @param store  the audit read port:
 *   list({ userId, limit, after })  -> up to `limit` persisted rows, newest
 *                                      first, strictly older than the `after`
 *                                      position ({ timestampMillis, entryId }
 *                                      or null for the first page).
 *   get({ userId, entryId })        -> persisted row | null
 *
 * Both take `userId` and neither takes it from the entry being addressed:
 * business rule 6 again. A user reads their own log or nobody's.
 */
function createAuditRoutes({ store } = {}) {
  if (!store || typeof store.list !== 'function' || typeof store.get !== 'function') {
    throw new TypeError('store is required');
  }

  const router = express.Router();

  // Rows are pushed back through restoreAuditEntry rather than serialised
  // straight out of the store. It re-validates every field, so a row that was
  // tampered with at rest cannot be served as a well-formed entry: it throws,
  // and the read fails loudly instead of laundering the tampering through the
  // API. This is the reason restoreAuditEntry validates at all.
  const present = (row) => restoreAuditEntry(row).toJSON();

  // Reading the audit log is deliberately not itself audited. Every read
  // would append an entry, which is a new action, which would be read back...
  // The regress has no natural floor, and the log would fill with the act of
  // inspecting it. Reads belong in request logs.
  router.get('/', async (req, res, next) => {
    let limit;
    let after;
    try {
      limit = parseLimit(req.query.limit);
      after = req.query.cursor === undefined ? null : decodeCursor(req.query.cursor);
    } catch (err) {
      if (err instanceof PaginationError) {
        // A bad cursor is the client's mistake, not the server's. Answering
        // 500 would send it to error-handler.js and lose the reason.
        return res.status(400).json({ error: 'invalid_request', error_description: err.message });
      }
      return next(err);
    }

    try {
      const page = await readPage({
        limit,
        after,
        fetch: (take, from) => store.list({ userId: req.auth.userId, limit: take, after: from }),
        restore: restoreAuditEntry,
      });

      return res.status(200).json({
        entries: page.entries.map((entry) => entry.toJSON()),
        nextCursor: page.nextCursor,
      });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/:entryId', async (req, res, next) => {
    try {
      const row = await store.get({ userId: req.auth.userId, entryId: req.params.entryId });
      // Absent and not-yours give the same answer, as everywhere else.
      if (!row) {
        return res.status(404).json({ error: 'not_found' });
      }
      return res.status(200).json(present(row));
    } catch (err) {
      return next(err);
    }
  });

  // Registered after the GETs, so a GET is served by the handler above and
  // never reaches this. Everything else — POST, PUT, PATCH, DELETE, and any
  // method invented later — lands here.
  router.all('/', refuseMutation);
  router.all('/:entryId', refuseMutation);

  return router;
}

module.exports = { createAuditRoutes, refuseMutation, ALLOWED_METHODS };
