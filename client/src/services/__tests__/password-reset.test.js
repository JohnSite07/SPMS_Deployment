import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetPassword } from '../password-reset.js';

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

describe('password-reset service (PRD 0020)', () => {
  it('posts email, code, and newPassword to /password-reset', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await resetPassword({ email: 'user@example.com', code: '123456', newPassword: 'StrongPass1!' });

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/password-reset');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      email: 'user@example.com',
      code: '123456',
      newPassword: 'StrongPass1!',
    });
  });

  it('resolves to null on a successful 204', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      resetPassword({ email: 'user@example.com', code: '123456', newPassword: 'StrongPass1!' })
    ).resolves.toBeNull();
  });

  it('rejects with an ApiError for the generic 401 (unknown email / no 2FA / wrong code)', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ error: 'invalid_credentials' }, { status: 401 }));

    await expect(
      resetPassword({ email: 'nobody@example.com', code: '000000', newPassword: 'StrongPass1!' })
    ).rejects.toMatchObject({ status: 401, error: 'invalid_credentials' });
  });

  it('rejects with an ApiError for a weak new password (400)', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ error: 'weak_password' }, { status: 400 }));

    await expect(
      resetPassword({ email: 'user@example.com', code: '123456', newPassword: 'short' })
    ).rejects.toMatchObject({ status: 400, error: 'weak_password' });
  });
});
