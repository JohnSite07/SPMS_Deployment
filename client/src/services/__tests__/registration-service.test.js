import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerAccount } from '../registration-service.js';
import * as store from '../token-store.js';

function response(body, { status = 200, headers = {} } = {}) {
  const init = { status, headers: { 'Content-Type': 'application/json', ...headers } };
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Response(text, init);
}

beforeEach(() => {
  store.clear();
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registration-service', () => {
  it('registerAccount posts email/password to /api/register and returns the userId', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ userId: 'user-1' }, { status: 201 }));

    const result = await registerAccount({ email: 'a@b.co', password: 'StrongPass1!aaaa' });

    expect(result).toEqual({ userId: 'user-1' });

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/register');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ email: 'a@b.co', password: 'StrongPass1!aaaa' });

    // No session token is minted by registration — nothing is stored.
    expect(store.hasToken()).toBe(false);
  });

  it('propagates a 409 email_already_registered error to the caller', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ error: 'email_already_registered' }, { status: 409 }));

    await expect(registerAccount({ email: 'a@b.co', password: 'StrongPass1!aaaa' })).rejects.toMatchObject({
      status: 409,
      error: 'email_already_registered',
    });
  });

  it('propagates a 400 weak_password error to the caller', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ error: 'weak_password' }, { status: 400 }));

    await expect(registerAccount({ email: 'a@b.co', password: 'weak' })).rejects.toMatchObject({
      status: 400,
      error: 'weak_password',
    });
  });
});
