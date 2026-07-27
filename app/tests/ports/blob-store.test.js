const { Readable } = require('stream');
const { createGcsBlobStore, createInMemoryBlobStore } = require('../../src/ports/blob-store');

// A minimal stand-in for the `@google-cloud/storage` client's
// bucket().file() surface -- just enough of save/createReadStream/delete to
// exercise createGcsBlobStore()'s own logic (ADC/bucket wiring aside, which
// is out of scope for a hermetic test -- see PRD 0025's "never touches real
// GCS" constraint).
function fakeStorageClient() {
  const files = new Map();
  return {
    bucket() {
      return {
        file(key) {
          return {
            async save(bytes) {
              files.set(key, Buffer.from(bytes));
            },
            createReadStream() {
              const bytes = files.get(key);
              if (!bytes) {
                const stream = new Readable({
                  read() {},
                });
                process.nextTick(() => {
                  const err = new Error('not found');
                  err.code = 404;
                  stream.emit('error', err);
                });
                return stream;
              }
              return Readable.from(bytes);
            },
            async delete() {
              if (!files.has(key)) {
                const err = new Error('not found');
                err.code = 404;
                throw err;
              }
              files.delete(key);
            },
          };
        },
      };
    },
    files,
  };
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

describe('createInMemoryBlobStore (tests + local dev adapter)', () => {
  it('round-trips a put blob back byte-identical', async () => {
    const store = createInMemoryBlobStore();
    const bytes = Buffer.from('ciphertext-bytes');

    await store.put('key-1', bytes);
    const stream = await store.get('key-1');

    expect(await readAll(stream)).toEqual(bytes);
    expect(store.has('key-1')).toBe(true);
    expect(store.size()).toBe(1);
  });

  it('throws a 404-coded error for a key that was never written', async () => {
    const store = createInMemoryBlobStore();
    await expect(store.get('missing')).rejects.toMatchObject({ code: 404 });
  });

  it('remove() is idempotent -- removing an absent key is not an error', async () => {
    const store = createInMemoryBlobStore();
    await expect(store.remove('never-written')).resolves.toBeUndefined();

    await store.put('key-1', Buffer.from('x'));
    await store.remove('key-1');
    expect(store.has('key-1')).toBe(false);
    await expect(store.remove('key-1')).resolves.toBeUndefined();
  });
});

describe('createGcsBlobStore (real adapter, injected client)', () => {
  it('throws when DOCUMENTS_BUCKET is unset and no bucketName is given', () => {
    const previous = process.env.DOCUMENTS_BUCKET;
    delete process.env.DOCUMENTS_BUCKET;
    try {
      expect(() => createGcsBlobStore()).toThrow(/DOCUMENTS_BUCKET/);
    } finally {
      if (previous !== undefined) {
        process.env.DOCUMENTS_BUCKET = previous;
      }
    }
  });

  it('puts, gets, and removes a blob against an injected storage client', async () => {
    const storage = fakeStorageClient();
    const store = createGcsBlobStore({ bucketName: 'test-bucket', storage });

    await store.put('key-1', Buffer.from('hello'));
    const stream = await store.get('key-1');
    expect((await readAll(stream)).toString()).toBe('hello');

    await store.remove('key-1');
    expect(storage.files.has('key-1')).toBe(false);
  });

  it('remove() swallows a 404 from the client -- idempotent delete', async () => {
    const storage = fakeStorageClient();
    const store = createGcsBlobStore({ bucketName: 'test-bucket', storage });

    await expect(store.remove('never-written')).resolves.toBeUndefined();
  });

  it('remove() still throws a non-404 error from the client', async () => {
    const storage = {
      bucket: () => ({
        file: () => ({
          delete: async () => {
            throw Object.assign(new Error('service unavailable'), { code: 503 });
          },
        }),
      }),
    };
    const store = createGcsBlobStore({ bucketName: 'test-bucket', storage });

    await expect(store.remove('key-1')).rejects.toThrow('service unavailable');
  });
});
