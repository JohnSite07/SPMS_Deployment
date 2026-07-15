import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { requestReset, confirmReset } from '../password-reset.js';

function response(body, { status = 200, headers = {} } = {}) {
  const init = { status, headers: { 'Content-Type': 'application/json', ...headers } };
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Response(text, init);
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('password-reset service', () => {
  it('requestReset posts the email to /password-reset/request', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ ok: true }));

    await requestReset({ email: 'user@example.com' });

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/password-reset/request');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ email: 'user@example.com' });
  });

  it('requestReset resolves the same way for a known or unknown email (no client-side branching)', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ ok: true }));

    await expect(requestReset({ email: 'nobody@example.com' })).resolves.toEqual({ ok: true });
  });

  it('confirmReset posts the token and new password to /password-reset/confirm', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await confirmReset({ token: 'tok-123', newPassword: 'StrongPass1!' });

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/password-reset/confirm');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ token: 'tok-123', newPassword: 'StrongPass1!' });
  });

  it('confirmReset rejects when the server rejects an invalid/expired token', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ error: 'reset_token_invalid' }, { status: 400 }));

    await expect(confirmReset({ token: 'bad', newPassword: 'StrongPass1!' })).rejects.toThrow();
  });
});
