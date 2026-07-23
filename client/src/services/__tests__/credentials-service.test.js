import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  listCredentials,
  getCredential,
  addCredential,
  updateCredential,
  deleteCredential,
} from '../credentials-service.js';
import * as store from '../token-store.js';
import { cancelAutoLock } from '../session.js';

function response(body, { status = 200, headers = {} } = {}) {
  const init = { status, headers: { 'Content-Type': 'application/json', ...headers } };
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Response(text, init);
}

beforeEach(() => {
  store.clear();
  cancelAutoLock();
  store.setToken('tok-1');
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('credentials-service', () => {
  it('listCredentials calls GET /api/credentials', async () => {
    globalThis.fetch.mockResolvedValueOnce(response([{ itemId: 'i1', title: 'Email' }]));

    const result = await listCredentials();

    expect(result).toEqual([{ itemId: 'i1', title: 'Email' }]);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/credentials');
    expect(opts.method).toBe('GET');
  });

  it('getCredential calls GET /api/credentials/:itemId', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ itemId: 'i1', title: 'Email' }));

    await getCredential('i1');

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/credentials/i1');
    expect(opts.method).toBe('GET');
  });

  it('addCredential POSTs the given fields, including only ciphertext for the password', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ itemId: 'i1' }, { status: 201 }));

    await addCredential({ title: 'Email', url: 'https://mail.example.com', username: 'me', encryptedPassword: 'CIPHERTEXT==' });

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/credentials');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      title: 'Email',
      url: 'https://mail.example.com',
      username: 'me',
      encryptedPassword: 'CIPHERTEXT==',
    });
  });

  it('updateCredential sends a real PATCH, not a PUT', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ itemId: 'i1', title: 'Renamed' }));

    await updateCredential('i1', { title: 'Renamed' });

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/credentials/i1');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ title: 'Renamed' });
  });

  it('deleteCredential calls DELETE /api/credentials/:itemId', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await deleteCredential('i1');

    expect(result).toBeNull();
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/credentials/i1');
    expect(opts.method).toBe('DELETE');
  });
});
