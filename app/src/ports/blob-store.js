const { Readable } = require('stream');

// The ciphertext half of the document vault (PRD 0025). ports/documents.js
// stores exactly one opaque blob per SECURE_DOCUMENTS row, addressed by a
// random `object_key` — this module never sees a userId, an itemId, or
// anything the app could use to reconstruct plaintext. It knows three verbs:
// put, get, remove.
//
// Two adapters, selected by whoever constructs the documents port (see
// server.js): `createGcsBlobStore()` for real traffic, `createInMemoryBlobStore()`
// for tests and local dev without a bucket. Both satisfy the same shape:
//   put(key, bytes)    -> Promise<void>
//   get(key)           -> Promise<Readable>   (the ciphertext, streamed)
//   remove(key)        -> Promise<void>       (idempotent — a missing key is not an error)
//
// There is deliberately no "unimplemented" stand-in here the way
// config/unimplemented-ports.js gives the storage ports one: a document
// route with no blob store wired should fail at construction (missing
// DOCUMENTS_BUCKET, see requireBucketName below), not silently no-op.

function requireBucketName(env = process.env) {
  const bucketName = env.DOCUMENTS_BUCKET;
  if (!bucketName) {
    throw new Error(
      'DOCUMENTS_BUCKET is not set. Cloud Run injects it from the documents bucket ' +
        "Terraform output (PRD 0024); locally, export it yourself, or use " +
        'createInMemoryBlobStore() for tests and backend-only dev.'
    );
  }
  return bucketName;
}

/**
 * The real adapter. Application Default Credentials only — no key file, per
 * PRD 0024's storage contract: Cloud Run's runtime service account carries
 * the IAM role that lets it read/write the bucket, and nothing in this
 * process ever holds a service-account JSON key.
 *
 * `storage` is injectable so a caller could swap in a pre-built
 * `@google-cloud/storage` client (e.g. one already configured for a specific
 * project); it is never required for normal operation.
 */
function createGcsBlobStore({ bucketName = requireBucketName(), storage } = {}) {
  // Required lazily so importing this module — and its in-memory sibling
  // below — never itself needs GCP credentials; only calling this
  // constructor does. Mirrors db/pool.js's lazy getPool().
  const { Storage } = require('@google-cloud/storage');
  const client = storage ?? new Storage();
  const bucket = client.bucket(bucketName);

  return {
    async put(key, bytes) {
      await bucket.file(key).save(bytes, { resumable: false });
    },

    async get(key) {
      return bucket.file(key).createReadStream();
    },

    // Idempotent: a compensating delete (see ports/documents.js) and a
    // normal delete can race the same key, and a key already gone is not a
    // failure worth surfacing — only an unexpected error is.
    async remove(key) {
      try {
        await bucket.file(key).delete();
      } catch (err) {
        if (err && err.code === 404) {
          return;
        }
        throw err;
      }
    },
  };
}

/**
 * Tests + local dev (per PRD 0025: "the developer team never touches real
 * GCS"). A Map from object_key to Buffer — no network, no disk, no ADC.
 *
 * `has`/`size` are test-only introspection, in the same spirit as
 * tests/helpers/fake-database.js's `state` escape hatch: they let a
 * compensating-delete test assert "no orphan blob" directly against the
 * store, rather than through a side channel.
 */
function createInMemoryBlobStore() {
  const store = new Map();

  return {
    async put(key, bytes) {
      store.set(key, Buffer.from(bytes));
    },

    async get(key) {
      const bytes = store.get(key);
      if (!bytes) {
        const err = new Error(`no blob for object_key "${key}"`);
        err.code = 404;
        throw err;
      }
      return Readable.from(bytes);
    },

    async remove(key) {
      store.delete(key);
    },

    has(key) {
      return store.has(key);
    },

    size() {
      return store.size;
    },
  };
}

module.exports = { createGcsBlobStore, createInMemoryBlobStore };
