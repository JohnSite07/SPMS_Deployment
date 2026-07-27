const request = require('supertest');
const express = require('express');
const { Readable } = require('stream');
const { createDocumentRoutes } = require('../src/routes/documents');

// Regression guard for the PRD 0025 security review's HIGH finding: the
// download route streams the ciphertext blob back with `doc.stream.pipe(res)`.
// With the real GCS adapter the read only fails once the stream is *consumed*
// (a network blip, or a row whose backing object is gone), emitting 'error'
// after the handler has already returned. A bare pipe would leave that 'error'
// unhandled → uncaught exception → the whole Cloud Run instance goes down,
// not just this one request. The route must instead fail only this request.
//
// The in-memory blob store used by the main suite can't reproduce this — its
// get() rejects synchronously for a missing key, so the error is caught by
// asyncRoute normally. Here we inject a stream that errors mid-consumption,
// which is the real adapter's failure shape.

function mountWith(store) {
  const audit = { forRequest: () => ({ logAction: async () => {} }) };
  const app = express();
  app.use((req, _res, next) => {
    req.auth = { userId: 'user-1' };
    next();
  });
  app.use('/api/documents', createDocumentRoutes({ store, audit }));
  return app;
}

// A store whose get() hands back a stream that errors the moment it is read —
// i.e. after the route has already set 200 + Content-Type and called pipe().
function storeReturningErroringStream() {
  return {
    transaction: async (fn) => fn({}),
    async get() {
      const stream = new Readable({
        read() {
          this.destroy(new Error('gcs read failed mid-stream'));
        },
      });
      return {
        itemId: 'doc-1',
        fileName: 'passport.pdf',
        fileType: 'application/pdf',
        fileSizeKb: 128,
        objectKey: 'obj-abc',
        createdAt: '2026-07-27T00:00:00.000Z',
        stream,
      };
    },
  };
}

let errorSpy;
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe('GET /api/documents/:itemId — blob stream failure (review HIGH finding)', () => {
  it('fails only the request (no uncaught exception) and responds 502 when the blob stream errors before any bytes', async () => {
    const app = mountWith(storeReturningErroringStream());

    const res = await request(app).get('/api/documents/doc-1');

    // The request itself fails cleanly rather than crashing the process.
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'blob_unavailable' });
    // The failure is logged for forensics, keyed by itemId (never the bytes).
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('doc-1'));
  });

  it('does not leave an unhandled rejection/exception when the stream errors', async () => {
    // If the route regressed to a bare pipe, the stream 'error' would escape
    // as an uncaught exception. Assert the process sees none across the call.
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.once('uncaughtException', onUnhandled);
    process.once('unhandledRejection', onUnhandled);

    const app = mountWith(storeReturningErroringStream());
    await request(app).get('/api/documents/doc-1');
    // Give any stray async error a tick to surface (the request already
    // resolved, so the stream 'error' has fired and been handled by now;
    // this is belt-and-suspenders). `process` is the allowed timer global.
    await new Promise((resolve) => process.nextTick(resolve));

    process.removeListener('uncaughtException', onUnhandled);
    process.removeListener('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });
});
