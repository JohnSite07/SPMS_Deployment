import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request, get, patch, ApiError } from '../api-client.js';
import * as store from '../token-store.js';
import { setRedirectHandler, cancelAutoLock } from '../session.js';

// Build a real Response so res.headers.get / res.text / res.status behave
// exactly as they will in the browser.
function response(body, { status = 200, headers = {} } = {}) {
  const init = { status, headers: { 'Content-Type': 'application/json', ...headers } };
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Response(text, init);
}

beforeEach(() => {
  store.clear();
  cancelAutoLock();
  setRedirectHandler(null);
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api-client request', () => {
  it('attaches the bearer token when one is held', async () => {
    store.setToken('tok-1');
    globalThis.fetch.mockResolvedValue(response({ ok: true }));

    await get('/credentials');

    const [, opts] = globalThis.fetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer tok-1');
  });

  it('sends no Authorization header when no token is held', async () => {
    globalThis.fetch.mockResolvedValue(response({ ok: true }));

    await get('/health');

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/health');
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it('captures the refreshed sliding-session token and uses it next', async () => {
    store.setToken('tok-1');
    const future = new Date(Date.now() + 600000).toISOString();
    globalThis.fetch
      .mockResolvedValueOnce(
        response({ ok: true }, { headers: { 'X-Session-Token': 'tok-2', 'X-Session-Expires-At': future } })
      )
      .mockResolvedValueOnce(response({ ok: true }));

    await get('/credentials');
    expect(store.getToken()).toBe('tok-2');

    await get('/credentials');
    const [, secondOpts] = globalThis.fetch.mock.calls[1];
    expect(secondOpts.headers.Authorization).toBe('Bearer tok-2');
  });

  it('rejects a non-2xx with a typed ApiError carrying status + description', async () => {
    globalThis.fetch.mockResolvedValue(
      response({ error: 'invalid_request', error_description: 'Missing bearer token' }, { status: 401 })
    );

    await expect(get('/credentials')).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      error: 'invalid_request',
      description: 'Missing bearer token',
    });
  });

  it('returns null for a 204 with no body', async () => {
    globalThis.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(request('DELETE', '/session')).resolves.toBeNull();
  });

  // PRD 0019: routes/credentials.js's edit route is a PATCH, not a PUT --
  // this wrapper must actually send that verb.
  it('patch sends a PATCH request with a JSON body', async () => {
    globalThis.fetch.mockResolvedValue(response({ ok: true }));

    await patch('/credentials/i1', { title: 'Renamed' });

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/credentials/i1');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ title: 'Renamed' });
  });

  it('ends the session on a 401 that means the session is over', async () => {
    store.setToken('tok-1');
    const redirect = vi.fn();
    setRedirectHandler(redirect);
    globalThis.fetch.mockResolvedValue(
      response({ error: 'invalid_token', error_description: 'Session expired' }, { status: 401 })
    );

    await expect(get('/credentials')).rejects.toBeInstanceOf(ApiError);

    expect(store.hasToken()).toBe(false); // token cleared (fail-safe)
    expect(redirect).toHaveBeenCalledTimes(1); // bounced to login
  });

  it('does NOT end the session on a 401 that is just a bad login', async () => {
    store.setToken('tok-1');
    const redirect = vi.fn();
    setRedirectHandler(redirect);
    globalThis.fetch.mockResolvedValue(response({ error: 'invalid_credentials' }, { status: 401 }));

    await expect(get('/credentials')).rejects.toBeInstanceOf(ApiError);

    expect(store.hasToken()).toBe(true); // untouched
    expect(redirect).not.toHaveBeenCalled();
  });
});
