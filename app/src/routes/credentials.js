const express = require('express');
const { ACTIONS } = require('../models/audit-entry');

// UC-02 (add), UC-03 (view), plus the edit and delete flows the requirements
// never wrote down (see the note in models/audit-entry.js).
//
// Storage is an injected port. This module knows nothing about MySQL, and
// nothing about AES: the client sends `encryptedPassword` already ciphertext
// and the server stores what it is given. Under the zero-knowledge posture
// there is no point in this file at which plaintext exists, so there is no
// point at which it could reach a log.

// Only these move. `itemId` and `userId` are not writable: a PATCH that could
// set `userId` would be a one-request transfer of a credential into someone
// else's vault, and a PATCH that could set `itemId` would let one entry
// overwrite another.
const MUTABLE_FIELDS = Object.freeze(['title', 'url', 'username', 'encryptedPassword']);
const REQUIRED_ON_CREATE = Object.freeze(['title', 'encryptedPassword']);

// Express 4 does not catch a rejected promise from an async handler: the
// rejection escapes to the process, the request hangs until it times out, and
// on Node >= 20 the container dies. Every route below is wrapped, so a failed
// audit write becomes a 500 through error-handler.js — the outcome the audit
// log's failure policy depends on.
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function readableFields(credential) {
  const { itemId, title, url, username, encryptedPassword, createdAt, updatedAt } = credential;
  return { itemId, title, url, username, encryptedPassword, createdAt, updatedAt };
}

function pickMutable(body) {
  const patch = {};
  for (const field of MUTABLE_FIELDS) {
    if (body[field] !== undefined) {
      patch[field] = body[field];
    }
  }
  return patch;
}

/**
 * @param store  the credential port:
 *   transaction(fn)                        -> fn(tx), commits on resolve
 *   add(tx, { userId, ...fields })         -> credential
 *   get({ userId, itemId })                -> credential | null
 *   update(tx, { userId, itemId, patch })  -> credential | null
 *   remove(tx, { userId, itemId })         -> boolean
 *
 * Every method takes `userId`, and none takes it from the credential being
 * addressed. That is business rule 6 expressed as a signature: the store
 * cannot be asked for an item without also being told whose vault to look in.
 * @param audit  a createAuditLog() instance.
 */
function createCredentialRoutes({ store, audit } = {}) {
  if (!store || typeof store.transaction !== 'function') {
    throw new TypeError('store is required');
  }
  if (!audit || typeof audit.forRequest !== 'function') {
    throw new TypeError('audit is required');
  }

  const router = express.Router();

  // UC-02. The write and its entry share one transaction: a credential that
  // commits without its entry would be an unlogged action, and an entry that
  // commits without its credential would be a lie. `context: tx` is what ties
  // them together.
  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const fields = pickMutable(req.body ?? {});
      const missing = REQUIRED_ON_CREATE.filter((f) => !fields[f]);
      if (missing.length > 0) {
        // UC-02 exception: required field empty -> save blocked.
        return res.status(400).json({ error: 'invalid_request', missing });
      }

      const credential = await store.transaction(async (tx) => {
        const created = await store.add(tx, { userId: req.auth.userId, ...fields });
        await audit
          .forRequest(req)
          .logAction({ action: ACTIONS.CREDENTIAL_ADDED, context: tx });
        return created;
      });

      return res.status(201).json(readableFields(credential));
    })
  );

  // UC-03. The entry is written *before* the plaintext-bearing response is
  // sent, and its failure is not caught. If the access cannot be logged, the
  // credential is not disclosed — a 500 with no entry, rather than a 200 with
  // no entry. Reading needs no transaction: there is nothing to roll back,
  // and ordering alone gives the guarantee.
  router.get(
    '/:itemId',
    asyncRoute(async (req, res) => {
      const credential = await store.get({
        userId: req.auth.userId,
        itemId: req.params.itemId,
      });

      // Absent and not-yours are the same answer. Distinguishing them would
      // turn this route into an oracle for which item ids exist in other
      // users' vaults. No entry is written: no access occurred.
      if (!credential) {
        return res.status(404).json({ error: 'not_found' });
      }

      await audit.forRequest(req).logAction({ action: ACTIONS.CREDENTIAL_RETRIEVED });

      return res.status(200).json(readableFields(credential));
    })
  );

  router.patch(
    '/:itemId',
    asyncRoute(async (req, res) => {
      const patch = pickMutable(req.body ?? {});
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'invalid_request', missing: MUTABLE_FIELDS });
      }

      const updated = await store.transaction(async (tx) => {
        const credential = await store.update(tx, {
          userId: req.auth.userId,
          itemId: req.params.itemId,
          patch,
        });
        // Nothing changed hands, so nothing is logged and the transaction
        // carries no entry. Logging a failed edit of an item that may not
        // exist would let a stranger write into another user's audit log.
        if (!credential) {
          return null;
        }

        await audit
          .forRequest(req)
          .logAction({ action: ACTIONS.CREDENTIAL_UPDATED, context: tx });
        return credential;
      });

      if (!updated) {
        return res.status(404).json({ error: 'not_found' });
      }
      return res.status(200).json(readableFields(updated));
    })
  );

  // The action the log most needs to witness, and the one the requirements
  // forgot. The entry commits with the deletion; if the entry cannot be
  // written the deletion rolls back, and the credential survives.
  router.delete(
    '/:itemId',
    asyncRoute(async (req, res) => {
      const deleted = await store.transaction(async (tx) => {
        const removed = await store.remove(tx, {
          userId: req.auth.userId,
          itemId: req.params.itemId,
        });
        if (!removed) {
          return false;
        }

        await audit
          .forRequest(req)
          .logAction({ action: ACTIONS.CREDENTIAL_DELETED, context: tx });
        return true;
      });

      if (!deleted) {
        return res.status(404).json({ error: 'not_found' });
      }
      return res.status(204).end();
    })
  );

  return router;
}

module.exports = { createCredentialRoutes, asyncRoute, MUTABLE_FIELDS };
