const { createDocumentsPort } = require('../../src/ports/documents');
const { createInMemoryBlobStore } = require('../../src/ports/blob-store');
const { createFakeDocumentsConnection } = require('./helpers/fake-documents-connection');

// Drives the REAL ports/documents.js against a fake connection scoped to its
// exact query shapes (see helpers/fake-documents-connection.js) and the real
// in-memory blob store. Complements tests/document-routes.test.js, which
// exercises the HTTP contract over a fully separate fake of the whole port;
// this file is the one place the SQL text and the add() compensating-delete
// logic themselves are exercised.

function buildPort({ failOn } = {}) {
  const blobStore = createInMemoryBlobStore();
  const conn = createFakeDocumentsConnection({ failOn });
  const transaction = async (fn) => fn(conn);
  const port = createDocumentsPort({ pool: conn, transaction, blobStore });
  return { port, blobStore, conn };
}

describe('ports/documents.js (PRD 0025)', () => {
  it('requires a blobStore', () => {
    expect(() =>
      createDocumentsPort({ pool: {}, transaction: async (fn) => fn({}) })
    ).toThrow(/blobStore is required/);
  });

  it('adds a document the owner can list, read back byte-identical, and delete', async () => {
    const { port, blobStore, conn } = buildPort();
    const userId = 'user-1';
    conn.seedVault(userId);
    const ciphertext = Buffer.from('AES256-GCM:opaque-bytes');

    const created = await port.transaction((tx) =>
      port.add(tx, {
        userId,
        fileName: 'passport.pdf',
        fileType: 'application/pdf',
        fileSizeKb: 128,
        ciphertext,
      })
    );

    expect(created).toMatchObject({
      userId,
      fileName: 'passport.pdf',
      fileType: 'application/pdf',
      fileSizeKb: 128,
    });
    expect(blobStore.has(created.objectKey)).toBe(true);

    const listed = await port.list({ userId });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ itemId: created.itemId, fileName: 'passport.pdf' });

    const fetched = await port.get({ userId, itemId: created.itemId });
    expect(fetched.objectKey).toBe(created.objectKey);
    const chunks = [];
    for await (const chunk of fetched.stream) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks)).toEqual(ciphertext);

    const removed = await port.transaction((tx) =>
      port.remove(tx, { userId, itemId: created.itemId })
    );
    expect(removed).toEqual({ objectKey: created.objectKey });

    // DB-then-blob delete order (PRD 0025): the row is gone; the caller
    // removes the blob only once that commit is certain.
    expect(await port.get({ userId, itemId: created.itemId })).toBeNull();
    expect(blobStore.has(created.objectKey)).toBe(true);
    await port.removeBlob(removed.objectKey);
    expect(blobStore.has(created.objectKey)).toBe(false);
  });

  it("never returns, lists, or removes another user's document (business rule 6)", async () => {
    const { port, conn } = buildPort();
    conn.seedVault('owner');
    conn.seedVault('stranger');

    const created = await port.transaction((tx) =>
      port.add(tx, {
        userId: 'owner',
        fileName: 'tax.pdf',
        fileType: 'application/pdf',
        fileSizeKb: 64,
        ciphertext: Buffer.from('x'),
      })
    );

    expect(await port.get({ userId: 'stranger', itemId: created.itemId })).toBeNull();
    expect(await port.list({ userId: 'stranger' })).toEqual([]);

    const strangerRemove = await port.transaction((tx) =>
      port.remove(tx, { userId: 'stranger', itemId: created.itemId })
    );
    expect(strangerRemove).toBeNull();

    // Untouched by the stranger's attempt.
    expect(await port.get({ userId: 'owner', itemId: created.itemId })).toMatchObject({
      fileName: 'tax.pdf',
    });
  });

  it('throws (not a silent 404 case) when the caller has no VAULTS row at all', async () => {
    const { port } = buildPort();

    await expect(
      port.transaction((tx) =>
        port.add(tx, {
          userId: 'ghost',
          fileName: 'x.pdf',
          fileType: 'application/pdf',
          fileSizeKb: 1,
          ciphertext: Buffer.from('z'),
        })
      )
    ).rejects.toThrow(/no vault provisioned/);
  });

  // Success criterion: "a simulated DB failure during add leaves no orphan
  // blob in the store". The blob is written before the DB rows (add()'s
  // documented order); when the second insert throws, add() must remove the
  // object it already wrote rather than leave it dangling in the store.
  it('compensates the blob write when the SECURE_DOCUMENTS insert fails mid-add', async () => {
    const { port, blobStore, conn } = buildPort({ failOn: 'INSERT INTO SECURE_DOCUMENTS' });
    conn.seedVault('user-1');

    await expect(
      port.transaction((tx) =>
        port.add(tx, {
          userId: 'user-1',
          fileName: 'broken.pdf',
          fileType: 'application/pdf',
          fileSizeKb: 32,
          ciphertext: Buffer.from('y'),
        })
      )
    ).rejects.toThrow('simulated DB failure');

    // No orphan: whatever key add() minted before the insert failed was
    // removed again, and nothing else was ever written to the store.
    expect(blobStore.size()).toBe(0);
  });

  it('also compensates when the VAULT_ITEMS insert itself fails', async () => {
    const { port, blobStore, conn } = buildPort({ failOn: 'INSERT INTO VAULT_ITEMS' });
    conn.seedVault('user-1');

    await expect(
      port.transaction((tx) =>
        port.add(tx, {
          userId: 'user-1',
          fileName: 'broken.pdf',
          fileType: 'application/pdf',
          fileSizeKb: 32,
          ciphertext: Buffer.from('y'),
        })
      )
    ).rejects.toThrow('simulated DB failure');

    expect(blobStore.size()).toBe(0);
  });
});
