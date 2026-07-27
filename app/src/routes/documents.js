const express = require('express');
const multer = require('multer');
const { ACTIONS } = require('../models/audit-entry');
const { asyncRoute } = require('./credentials');

// UC-04 (upload/list/delete), UC-06 (retrieve). PRD 0025.
//
// Storage is two injected ports: `store` (ports/documents.js — metadata,
// class-table inheritance over VAULT_ITEMS/SECURE_DOCUMENTS) and, reached
// only through `store.removeBlob`, the blob store (ports/blob-store.js —
// the ciphertext itself). This module knows nothing about MySQL or Cloud
// Storage directly, and nothing about AES: the client encrypts the file
// before it ever reaches `POST /`, and everything this route touches is
// opaque bytes. Under the zero-knowledge posture there is no point in this
// file at which plaintext exists, so there is no point at which it could
// reach a log.

// Business rule: uploads limited to PDF/image, 10 MB. `fileSizeKb` is the
// ORIGINAL plaintext size the client reports (not the ciphertext's, which is
// always a little larger — GCM's IV + auth tag overhead) and is what the
// 10 MB business rule is checked against; multer's own limit below is a
// coarser backstop against a ciphertext blob so large it could only be lying
// about `fileSizeKb`.
const ALLOWED_FILE_TYPES = Object.freeze(['application/pdf', 'image/png', 'image/jpeg']);
const MAX_FILE_SIZE_KB = 10240; // 10 MB, business rule
const MIN_FILE_SIZE_KB = 1;

// Ciphertext = plaintext + AES-256-GCM overhead (a 12-byte IV and a 16-byte
// tag, packed into the one opaque blob the client uploads — see
// ports/credentials.js's header for why there's only ever one blob, never
// separate IV/tag fields). 11 MB gives that overhead comfortable room over a
// 10 MB plaintext without moving the real ceiling, which is `fileSizeKb`'s
// CHECK below and the DB constraint behind it (migration 0004).
const MAX_CIPHERTEXT_BYTES = 11 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CIPHERTEXT_BYTES },
});

// multer's own middleware calls `next(err)` directly on a limit violation,
// before this router's handler ever runs — asyncRoute can't catch it because
// it never wraps multer itself. Translated to the same 400 shape every other
// validation failure in this router uses, rather than falling through to
// error-handler.js's generic 500.
function uploadCiphertext(req, res, next) {
  upload.single('ciphertext')(req, res, (err) => {
    if (!err) {
      return next();
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'invalid_request', reason: 'file_too_large' });
    }
    return next(err);
  });
}

function readableFields(doc) {
  const { itemId, fileName, fileType, fileSizeKb, createdAt } = doc;
  return { itemId, fileName, fileType, fileSizeKb, createdAt };
}

function validateUploadFields(body, hasFile) {
  const missing = [];
  if (!hasFile) {
    missing.push('ciphertext');
  }

  const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
  if (fileName.length === 0) {
    missing.push('fileName');
  }

  if (missing.length > 0) {
    return { error: { error: 'invalid_request', missing } };
  }

  if (!ALLOWED_FILE_TYPES.includes(body.fileType)) {
    return { error: { error: 'invalid_request', reason: 'unsupported_file_type' } };
  }

  const fileSizeKb = Number(body.fileSizeKb);
  if (
    !Number.isInteger(fileSizeKb) ||
    fileSizeKb < MIN_FILE_SIZE_KB ||
    fileSizeKb > MAX_FILE_SIZE_KB
  ) {
    return { error: { error: 'invalid_request', reason: 'invalid_file_size' } };
  }

  return { fileName, fileType: body.fileType, fileSizeKb };
}

/**
 * @param store  the documents port (see ports/documents.js):
 *   transaction(fn)
 *   add(tx, { userId, fileName, fileType, fileSizeKb, ciphertext }) -> doc
 *   list({ userId })                                                -> doc[]
 *   get({ userId, itemId })                                         -> doc & { stream } | null
 *   remove(tx, { userId, itemId })                                  -> { objectKey } | null
 *   removeBlob(objectKey)                                           -> void
 * @param audit  a createAuditLog() instance.
 */
function createDocumentRoutes({ store, audit } = {}) {
  if (!store || typeof store.transaction !== 'function') {
    throw new TypeError('store is required');
  }
  if (!audit || typeof audit.forRequest !== 'function') {
    throw new TypeError('audit is required');
  }

  const router = express.Router();

  // UC-04 add. The blob write and the metadata insert happen inside
  // store.add() (see ports/documents.js for the blob-first order and its
  // own compensating delete on an insert failure); this handler adds a
  // second layer over the *whole* transaction, including the audit entry:
  // if anything after add() succeeds still causes the transaction to fail
  // (the entry, most notably), the object add() already wrote would
  // otherwise survive the DB rollback as an orphan. `objectKey` is captured
  // from add()'s own return value before that can happen, so it is known to
  // this catch block even though the row that named it was rolled back.
  router.post(
    '/',
    uploadCiphertext,
    asyncRoute(async (req, res) => {
      const validated = validateUploadFields(req.body ?? {}, Boolean(req.file));
      if (validated.error) {
        return res.status(400).json(validated.error);
      }
      const { fileName, fileType, fileSizeKb } = validated;

      let objectKey = null;
      try {
        const created = await store.transaction(async (tx) => {
          const doc = await store.add(tx, {
            userId: req.auth.userId,
            fileName,
            fileType,
            fileSizeKb,
            ciphertext: req.file.buffer,
          });
          objectKey = doc.objectKey;

          await audit.forRequest(req).logAction({ action: ACTIONS.DOCUMENT_STORED, context: tx });
          return doc;
        });

        return res.status(201).json(readableFields(created));
      } catch (err) {
        if (objectKey) {
          await store.removeBlob(objectKey).catch(() => {});
        }
        throw err;
      }
    })
  );

  // Whole-vault listing, metadata only — never touches the blob store.
  // Filtered through business rule 6 by the store (list() joins through
  // VAULTS.user_id, same as get()/remove()).
  //
  // One DOCUMENTS_LISTED entry per call, not one per returned item, and not
  // zero — same forensic reasoning as CREDENTIALS_LISTED (see
  // routes/credentials.js's `GET /` and audit-entry.js): a stolen bearer
  // token enumerating every stored document in one call must leave a trail,
  // and per-item entries here would just be routine-navigation noise.
  //
  // Written before the response, uncaught: if the access cannot be logged,
  // it is not disclosed.
  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const docs = await store.list({ userId: req.auth.userId });
      await audit.forRequest(req).logAction({ action: ACTIONS.DOCUMENTS_LISTED });
      return res.status(200).json(docs.map(readableFields));
    })
  );

  // UC-06. The entry is written *before* the ciphertext-bearing response is
  // sent, and its failure is not caught — same fail-closed shape as
  // routes/credentials.js's GET /:itemId. Streamed back as opaque bytes:
  // this route never buffers the whole file into a JSON body, and never
  // decrypts it.
  router.get(
    '/:itemId',
    asyncRoute(async (req, res) => {
      const doc = await store.get({ userId: req.auth.userId, itemId: req.params.itemId });

      // Absent and not-yours are the same answer — an itemId is never an
      // oracle for what exists in another user's vault.
      if (!doc) {
        return res.status(404).json({ error: 'not_found' });
      }

      await audit.forRequest(req).logAction({ action: ACTIONS.DOCUMENT_RETRIEVED });

      res.status(200);
      res.set('Content-Type', 'application/octet-stream');

      // Stream the ciphertext straight through — never buffered whole, never
      // decrypted here. A bare `doc.stream.pipe(res)` is unsafe: with the real
      // GCS adapter the read only starts when the stream is consumed, so a
      // mid-stream failure (a network blip, or a row whose backing object is
      // missing) emits an 'error' with no listener, which Node turns into an
      // uncaught exception *outside* asyncRoute's promise chain — taking the
      // whole Cloud Run instance down rather than failing this one request
      // (see the process-teardown note in services/audit-log.js). Attaching an
      // error handler keeps a failed download local to its own request.
      await new Promise((resolve) => {
        doc.stream.once('error', (err) => {
          // eslint-disable-next-line no-console
          console.error(`failed to stream document "${req.params.itemId}": ${err.message}`);
          if (res.headersSent) {
            // Bytes already went out; a clean error response is impossible, so
            // abort the connection rather than leave the client hanging.
            res.destroy(err);
          } else {
            // The octet-stream Content-Type was set for the happy path; reset
            // it to JSON explicitly — res.json() will NOT override an already
            // set Content-Type, so without this the error body ships
            // mislabelled as application/octet-stream.
            res.status(502);
            res.set('Content-Type', 'application/json');
            res.json({ error: 'blob_unavailable' });
          }
          resolve();
        });
        res.once('close', resolve);
        doc.stream.pipe(res);
      });
      return undefined;
    })
  );

  // Delete direction: DB rows first (store.remove(), on this transaction, so
  // the deletion and its audit entry commit together or not at all — the
  // destructive action the log most needs to witness), the GCS object only
  // once that commit is certain. A GCS failure here is logged and the
  // response still succeeds: a dangling blob is acceptable (PRD 0025), a
  // dangling row is not, and by this point there is no row left to dangle.
  router.delete(
    '/:itemId',
    asyncRoute(async (req, res) => {
      const removed = await store.transaction(async (tx) => {
        const result = await store.remove(tx, {
          userId: req.auth.userId,
          itemId: req.params.itemId,
        });
        if (!result) {
          return null;
        }

        await audit.forRequest(req).logAction({ action: ACTIONS.DOCUMENT_DELETED, context: tx });
        return result;
      });

      if (!removed) {
        return res.status(404).json({ error: 'not_found' });
      }

      try {
        await store.removeBlob(removed.objectKey);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `failed to remove blob "${removed.objectKey}" after its row was deleted: ${err.message}`
        );
      }

      return res.status(204).end();
    })
  );

  return router;
}

module.exports = { createDocumentRoutes, ALLOWED_FILE_TYPES, MAX_FILE_SIZE_KB, MIN_FILE_SIZE_KB };
