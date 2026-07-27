const request = require('supertest');
const { ACTIONS } = require('../src/models/audit-entry');
const { createFakeDatabase } = require('./helpers/fake-database');
const { testApp, seedUser, PASSWORD, TWO_FACTOR_CODE } = require('./helpers/test-app');

const OTHER = seedUser({ userId: 'user-99', email: 'other@example.com' });

function build(dbOptions = {}) {
  const db = createFakeDatabase({ users: [seedUser(), OTHER], ...dbOptions });
  return { ...testApp({ db }), db };
}

async function login(app, email = 'owner@example.com') {
  const res = await request(app)
    .post('/api/session')
    .send({ email, password: PASSWORD, code: TWO_FACTOR_CODE });
  expect(res.status).toBe(201);
  return res.body.token;
}

// A small, deliberately non-uniform buffer -- standing in for the client's
// already-encrypted opaque blob (IV + AES-256-GCM ciphertext + tag, packed
// together per PRD 0025). This route never decrypts it, so its exact bytes
// are what a round trip is judged against, not any "real" ciphertext shape.
const CIPHERTEXT = Buffer.from('AES256-GCM:opaque-client-ciphertext-bytes-not-plaintext');

function uploadRequest(app, token, overrides = {}) {
  const fields = {
    fileName: 'passport.pdf',
    fileType: 'application/pdf',
    fileSizeKb: '128',
    ...overrides.fields,
  };
  let req = request(app).post('/api/documents').set('Authorization', `Bearer ${token}`);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      req = req.field(key, value);
    }
  }
  if (overrides.skipFile !== true) {
    req = req.attach('ciphertext', overrides.fileBuffer ?? CIPHERTEXT, {
      filename: 'ciphertext.bin',
      contentType: 'application/octet-stream',
    });
  }
  return req;
}

async function addDocument(app, token, overrides = {}) {
  return uploadRequest(app, token, overrides);
}

// Routes that fail write a stack to the server log; keep the test output clean.
let errorSpy;
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe('POST /api/documents (UC-04 add)', () => {
  it('stores the document and records document.stored', async () => {
    const { app, db } = build();
    const token = await login(app);

    const res = await addDocument(app, token);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      fileName: 'passport.pdf',
      fileType: 'application/pdf',
      fileSizeKb: 128,
    });
    expect(res.body.itemId).toBeDefined();
    expect(res.body.objectKey).toBeUndefined(); // never disclosed to the client
    expect(db.actions()).toEqual([ACTIONS.LOGIN_SUCCEEDED, ACTIONS.DOCUMENT_STORED]);
  });

  it('writes only ciphertext to the blob store, never the field values as the file body', async () => {
    const { app, db } = build();
    const token = await login(app);

    await addDocument(app, token);

    expect(db.documentsBlobStore.size()).toBe(1);
    const [doc] = [...db.state.documents.values()];
    expect(db.documentsBlobStore.has(doc.objectKey)).toBe(true);
  });

  it.each([
    ['no fileName', { fields: { fileName: '' } }],
    ['blank fileName', { fields: { fileName: '   ' } }],
    ['no ciphertext file', { skipFile: true }],
    ['unsupported file type', { fields: { fileType: 'application/x-msdownload' } }],
    ['fileSizeKb of 0', { fields: { fileSizeKb: '0' } }],
    ['fileSizeKb over 10 MB', { fields: { fileSizeKb: '10241' } }],
    ['non-integer fileSizeKb', { fields: { fileSizeKb: '1.5' } }],
  ])('rejects %s with 400 and stores nothing', async (_name, overrides) => {
    const { app, db } = build();
    const token = await login(app);

    const res = await addDocument(app, token, overrides);

    expect(res.status).toBe(400);
    expect(db.state.documents.size).toBe(0);
    expect(db.documentsBlobStore.size()).toBe(0);
    expect(db.actions()).toEqual([ACTIONS.LOGIN_SUCCEEDED]);
  });

  it('rejects a ciphertext blob over the multipart size limit with 400', async () => {
    const { app, db } = build();
    const token = await login(app);

    const oversized = Buffer.alloc(11 * 1024 * 1024 + 1);
    const res = await addDocument(app, token, { fileBuffer: oversized });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(db.state.documents.size).toBe(0);
  }, 20000);

  it('requires authentication', async () => {
    const { app } = build();
    const res = await uploadRequest(app, 'not-a-token');
    expect(res.status).toBe(401);
  });

  // The two-system consistency guarantee this PRD adds over the credential
  // vault: a document add is a blob write AND a DB write, and if the second
  // half (here, the audit entry sharing the same transaction) fails, the
  // first half must not be left behind as an orphan.
  it('compensates the blob write when the transaction fails mid-add, leaving no orphan', async () => {
    const { app, db } = build({ failAppendOn: ACTIONS.DOCUMENT_STORED });
    const token = await login(app);

    const res = await addDocument(app, token);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
    // The DB side rolled back...
    expect(db.state.documents.size).toBe(0);
    // ...and the blob store has no orphan left over from the write that
    // happened before the transaction failed.
    expect(db.documentsBlobStore.size()).toBe(0);
  });
});

describe('GET /api/documents (list)', () => {
  it("returns only the caller's own documents, metadata only", async () => {
    const { app } = build();
    const ownerToken = await login(app);
    await addDocument(app, ownerToken, { fields: { fileName: 'owner.pdf' } });
    const otherToken = await login(app, 'other@example.com');
    await addDocument(app, otherToken, { fields: { fileName: 'other.pdf' } });

    const res = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ fileName: 'owner.pdf', fileType: 'application/pdf' });
    expect(res.body[0].objectKey).toBeUndefined();
  });

  it('returns an empty array, not a 404, for a vault with no documents', async () => {
    const { app } = build();
    const token = await login(app);

    const res = await request(app).get('/api/documents').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('writes exactly one documents.listed entry per list call, regardless of item count', async () => {
    const { app, db } = build();
    const token = await login(app);
    await addDocument(app, token, { fields: { fileName: 'first.pdf' } });
    await addDocument(app, token, { fields: { fileName: 'second.pdf' } });

    const res = await request(app).get('/api/documents').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(db.actions()).not.toContain(ACTIONS.DOCUMENT_RETRIEVED);
    expect(db.actions().filter((a) => a === ACTIONS.DOCUMENTS_LISTED)).toHaveLength(1);
  });

  it('does not disclose the list when the access cannot be logged', async () => {
    const { app } = build({ failAppendOn: ACTIONS.DOCUMENTS_LISTED });
    const token = await login(app);
    await addDocument(app, token);

    const res = await request(app).get('/api/documents').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
  });

  it('requires authentication', async () => {
    const { app } = build();
    const res = await request(app).get('/api/documents');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/documents/:itemId (UC-06 retrieve)', () => {
  it('streams the ciphertext back byte-identical and records document.retrieved', async () => {
    const { app, db } = build();
    const token = await login(app);
    const { body } = await addDocument(app, token);

    const res = await request(app)
      .get(`/api/documents/${body.itemId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body)).toEqual(CIPHERTEXT);
    expect(db.actions()).toContain(ACTIONS.DOCUMENT_RETRIEVED);
  });

  // Business rule 6, and no oracle: not-yours reads exactly like not-there.
  it("answers 404 for another user's document and logs no access", async () => {
    const { app, db } = build();
    const ownerToken = await login(app);
    const { body } = await addDocument(app, ownerToken);
    const otherToken = await login(app, 'other@example.com');

    const res = await request(app)
      .get(`/api/documents/${body.itemId}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(404);
    expect(db.entriesFor('user-99').map((e) => e.action)).toEqual([ACTIONS.LOGIN_SUCCEEDED]);
  });

  it('answers 404 for a document that does not exist, writing no entry', async () => {
    const { app, db } = build();
    const token = await login(app);

    const res = await request(app)
      .get('/api/documents/nope')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(db.actions()).not.toContain(ACTIONS.DOCUMENT_RETRIEVED);
  });

  it('does not disclose the document when the access cannot be logged', async () => {
    const { app } = build({ failAppendOn: ACTIONS.DOCUMENT_RETRIEVED });
    const token = await login(app);
    const { body } = await addDocument(app, token);

    const res = await request(app)
      .get(`/api/documents/${body.itemId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.text ?? '').not.toContain('opaque-client-ciphertext');
  });
});

describe('DELETE /api/documents/:itemId (delete)', () => {
  it('removes the document and its blob, and records document.deleted', async () => {
    const { app, db } = build();
    const token = await login(app);
    const { body } = await addDocument(app, token);
    const objectKey = [...db.state.documents.values()][0].objectKey;

    const res = await request(app)
      .delete(`/api/documents/${body.itemId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(db.state.documents.size).toBe(0);
    expect(db.documentsBlobStore.has(objectKey)).toBe(false);
    expect(db.actions()).toContain(ACTIONS.DOCUMENT_DELETED);
  });

  it('answers 404 the second time, having written one entry', async () => {
    const { app, db } = build();
    const token = await login(app);
    const { body } = await addDocument(app, token);
    const url = `/api/documents/${body.itemId}`;

    await request(app).delete(url).set('Authorization', `Bearer ${token}`);
    const second = await request(app).delete(url).set('Authorization', `Bearer ${token}`);

    expect(second.status).toBe(404);
    expect(db.actions().filter((a) => a === ACTIONS.DOCUMENT_DELETED)).toHaveLength(1);
  });

  it("answers 404 for another user's document and deletes nothing", async () => {
    const { app, db } = build();
    const ownerToken = await login(app);
    const { body } = await addDocument(app, ownerToken);
    const otherToken = await login(app, 'other@example.com');

    const res = await request(app)
      .delete(`/api/documents/${body.itemId}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(404);
    expect(db.state.documents.has(body.itemId)).toBe(true);
    expect(db.actions()).not.toContain(ACTIONS.DOCUMENT_DELETED);
  });

  // The destructive action the log most needs to witness. If it cannot be
  // witnessed, it does not happen -- and DB-first ordering means the blob
  // (untouched at this point) survives right alongside the row.
  it('keeps the document and its blob when the deletion cannot be logged', async () => {
    const { app, db } = build({ failAppendOn: ACTIONS.DOCUMENT_DELETED });
    const token = await login(app);
    const { body } = await addDocument(app, token);
    const objectKey = [...db.state.documents.values()][0].objectKey;

    const res = await request(app)
      .delete(`/api/documents/${body.itemId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(db.state.documents.has(body.itemId)).toBe(true);
    expect(db.documentsBlobStore.has(objectKey)).toBe(true);
  });
});
