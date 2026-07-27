import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  uploadDocument,
  listDocuments,
  downloadDocument,
  deleteDocument,
  UnsupportedFileError,
} from '../document-service.js';
import { encryptFile } from '../document-crypto.js';
import { deriveVaultKey } from '../vault-crypto.js';
import * as vaultKeyStore from '../vault-key-store.js';
import * as store from '../token-store.js';
import { cancelAutoLock } from '../session.js';

// Plain Node environment (no jsdom, matching credentials-service.test.js):
// global fetch is mocked, but the vault key and encryption are REAL (Node's
// global crypto.subtle + File/Blob), so the "ciphertext only on the wire"
// assertion below exercises the genuine encrypt path, not a stub.

function response(body, { status = 200, headers = {} } = {}) {
  const init = { status, headers: { 'Content-Type': 'application/json', ...headers } };
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Response(text, init);
}

beforeEach(async () => {
  store.clear();
  cancelAutoLock();
  store.setToken('tok-1');
  vaultKeyStore.clear();
  vaultKeyStore.setVaultKey(await deriveVaultKey('correct-horse-battery-staple', 'user@example.com'));
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('document-service', () => {
  it('rejects an unsupported file type before ever calling fetch', async () => {
    const file = new File(['x'], 'malware.exe', { type: 'application/x-msdownload' });

    await expect(uploadDocument({ file })).rejects.toBeInstanceOf(UnsupportedFileError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects a file over 10 MB before ever calling fetch', async () => {
    const bigBytes = new Uint8Array(10 * 1024 * 1024 + 1);
    const file = new File([bigBytes], 'big.pdf', { type: 'application/pdf' });

    await expect(uploadDocument({ file })).rejects.toBeInstanceOf(UnsupportedFileError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // PRD 0025 success criterion: "Uploading a file encrypts it client-side
  // before it is sent — verified by inspecting the upload request body ...
  // only ciphertext, never the original bytes, on the wire".
  it('uploads only ciphertext (plus plaintext metadata) — the original file bytes never appear in the request body', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      response(
        { itemId: 'd1', fileName: 'passport.pdf', fileType: 'application/pdf', fileSizeKb: 1, createdAt: '2026-01-01T00:00:00Z' },
        { status: 201 }
      )
    );

    const plaintextMarker = 'THIS-IS-SECRET-PASSPORT-CONTENT';
    const file = new File([plaintextMarker], 'passport.pdf', { type: 'application/pdf' });

    await uploadDocument({ file });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/documents');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBeInstanceOf(FormData);
    // No manual Content-Type — the browser must generate the multipart boundary.
    expect(opts.headers['Content-Type']).toBeUndefined();

    const formData = opts.body;
    expect(formData.get('fileName')).toBe('passport.pdf');
    expect(formData.get('fileType')).toBe('application/pdf');
    expect(formData.get('fileSizeKb')).toBe(String(Math.ceil(plaintextMarker.length / 1024)));

    const ciphertextPart = formData.get('ciphertext');
    expect(ciphertextPart).toBeInstanceOf(Blob);
    const ciphertextText = await ciphertextPart.text();
    expect(ciphertextText).not.toContain(plaintextMarker);

    // Belt-and-braces: nothing anywhere in the serialized form fields is the
    // original plaintext either.
    expect(formData.get('fileName')).not.toBe(plaintextMarker);
  });

  it('listDocuments calls GET /api/documents', async () => {
    globalThis.fetch.mockResolvedValueOnce(response([{ itemId: 'd1', fileName: 'a.pdf' }]));

    const result = await listDocuments();

    expect(result).toEqual([{ itemId: 'd1', fileName: 'a.pdf' }]);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/documents');
    expect(opts.method).toBe('GET');
  });

  it('downloadDocument fetches the ciphertext bytes and decrypts them back to the original file', async () => {
    const plaintext = 'byte-identical-round-trip-check';
    const encryptedBlob = await encryptFile(new File([plaintext], 'note.pdf', { type: 'application/pdf' }));
    const encryptedBuffer = await encryptedBlob.arrayBuffer();
    globalThis.fetch.mockResolvedValueOnce(new Response(encryptedBuffer, { status: 200 }));

    const { blob, fileName } = await downloadDocument('d1', { fileName: 'note.pdf', fileType: 'application/pdf' });

    expect(fileName).toBe('note.pdf');
    expect(blob.type).toBe('application/pdf');
    await expect(blob.text()).resolves.toBe(plaintext);

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/documents/d1');
    expect(opts.method).toBe('GET');
  });

  it('downloadDocument fails closed (throws) rather than returning garbage when the vault key is wrong', async () => {
    const encryptedBlob = await encryptFile(new File(['secret'], 'note.pdf', { type: 'application/pdf' }));
    const encryptedBuffer = await encryptedBlob.arrayBuffer();
    globalThis.fetch.mockResolvedValueOnce(new Response(encryptedBuffer, { status: 200 }));

    // Swap in a different key after encrypting — simulates the same-class
    // consequence as a master-password reset (ADR 0015).
    vaultKeyStore.setVaultKey(await deriveVaultKey('a-totally-different-password', 'user@example.com'));

    await expect(downloadDocument('d1', { fileName: 'note.pdf', fileType: 'application/pdf' })).rejects.toThrow();
  });

  it('deleteDocument calls DELETE /api/documents/:itemId', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await deleteDocument('d1');

    expect(result).toBeNull();
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/documents/d1');
    expect(opts.method).toBe('DELETE');
  });
});
