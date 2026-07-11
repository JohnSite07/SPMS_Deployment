import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { login, logout, isAuthenticated } from '../auth-service.js';
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
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auth-service', () => {
  it('login posts credentials, stores the token, and returns the sessionId', async () => {
    const future = new Date(Date.now() + 600000).toISOString();
    globalThis.fetch
      // POST /api/session (public login) -> token + sessionId
      .mockResolvedValueOnce(response({ token: 'tok-1', sessionId: 'sess-9' }, { status: 201 }))
      // GET /api/session (authed prime) -> carries expiry header
      .mockResolvedValueOnce(
        response({ userId: 'u1', sessionId: 'sess-9', expiresAt: future }, { headers: { 'X-Session-Expires-At': future } })
      );

    const result = await login({ email: 'a@b.co', password: 'pw', code: '123456' });

    expect(result).toEqual({ sessionId: 'sess-9' });
    expect(store.getToken()).toBe('tok-1');
    expect(isAuthenticated()).toBe(true);

    const [loginUrl, loginOpts] = globalThis.fetch.mock.calls[0];
    expect(loginUrl).toBe('/api/session');
    expect(loginOpts.method).toBe('POST');
    expect(JSON.parse(loginOpts.body)).toMatchObject({ email: 'a@b.co', password: 'pw', code: '123456' });

    const [primeUrl, primeOpts] = globalThis.fetch.mock.calls[1];
    expect(primeUrl).toBe('/api/session');
    expect(primeOpts.method).toBe('GET');
    expect(primeOpts.headers.Authorization).toBe('Bearer tok-1'); // authed with the fresh token
  });

  it('login still succeeds if the prime GET fails', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(response({ token: 'tok-1', sessionId: 'sess-9' }, { status: 201 }))
      .mockRejectedValueOnce(new Error('network'));

    const result = await login({ email: 'a@b.co', password: 'pw', code: '123456' });

    expect(result).toEqual({ sessionId: 'sess-9' });
    expect(store.getToken()).toBe('tok-1');
  });

  it('logout calls DELETE and clears the token', async () => {
    store.setToken('tok-1');
    globalThis.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    await logout();

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/session');
    expect(opts.method).toBe('DELETE');
    expect(store.hasToken()).toBe(false);
  });

  it('logout clears the token even if the server call fails', async () => {
    store.setToken('tok-1');
    globalThis.fetch.mockRejectedValue(new Error('network'));

    await expect(logout()).resolves.toBeUndefined();
    expect(store.hasToken()).toBe(false);
  });
});
