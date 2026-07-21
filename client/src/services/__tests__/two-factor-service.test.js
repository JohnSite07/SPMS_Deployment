import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { enrollTwoFactor, confirmTwoFactor } from '../two-factor-service.js';
import * as store from '../token-store.js';
import * as vaultKeyStore from '../vault-key-store.js';
import { cancelAutoLock } from '../session.js';

function response(body, { status = 200, headers = {} } = {}) {
  const init = { status, headers: { 'Content-Type': 'application/json', ...headers } };
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Response(text, init);
}

beforeEach(() => {
  store.clear();
  vaultKeyStore.clear();
  cancelAutoLock();
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('two-factor-service', () => {
  it('enrollTwoFactor posts email/password and returns the secret + otpauthUri', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      response({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/SecureVault:a@b.co?secret=JBSWY3DPEHPK3PXP' })
    );

    const result = await enrollTwoFactor({ email: 'a@b.co', password: 'pw' });

    expect(result).toEqual({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/SecureVault:a@b.co?secret=JBSWY3DPEHPK3PXP' });

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/2fa/enroll');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ email: 'a@b.co', password: 'pw' });
    // The plaintext secret must never be stored client-side beyond this
    // one-time response — it never touches the token store.
    expect(store.hasToken()).toBe(false);
  });

  it('enrollTwoFactor lets a 409 already-enabled error propagate to the caller', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ error: 'two_factor_already_enabled' }, { status: 409 }));

    await expect(enrollTwoFactor({ email: 'a@b.co', password: 'pw' })).rejects.toMatchObject({
      status: 409,
      error: 'two_factor_already_enabled',
    });
  });

  it('confirmTwoFactor posts credentials + code, stores the token, and returns the sessionId', async () => {
    const future = new Date(Date.now() + 600000).toISOString();
    globalThis.fetch
      // POST /api/2fa/confirm -> token + sessionId (same shape as POST /api/session)
      .mockResolvedValueOnce(response({ token: 'tok-1', sessionId: 'sess-9' }, { status: 201 }))
      // GET /api/session (authed prime) -> carries expiry header
      .mockResolvedValueOnce(
        response({ userId: 'u1', sessionId: 'sess-9', expiresAt: future }, { headers: { 'X-Session-Expires-At': future } })
      );

    const result = await confirmTwoFactor({ email: 'a@b.co', password: 'pw', code: '123456' });

    expect(result).toEqual({ sessionId: 'sess-9' });
    expect(store.getToken()).toBe('tok-1');

    const [confirmUrl, confirmOpts] = globalThis.fetch.mock.calls[0];
    expect(confirmUrl).toBe('/api/2fa/confirm');
    expect(confirmOpts.method).toBe('POST');
    expect(JSON.parse(confirmOpts.body)).toMatchObject({ email: 'a@b.co', password: 'pw', code: '123456' });

    const [primeUrl, primeOpts] = globalThis.fetch.mock.calls[1];
    expect(primeUrl).toBe('/api/session');
    expect(primeOpts.method).toBe('GET');
    expect(primeOpts.headers.Authorization).toBe('Bearer tok-1');
  });

  it('confirmTwoFactor still succeeds if the prime GET fails', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(response({ token: 'tok-1', sessionId: 'sess-9' }, { status: 201 }))
      .mockRejectedValueOnce(new Error('network'));

    const result = await confirmTwoFactor({ email: 'a@b.co', password: 'pw', code: '123456' });

    expect(result).toEqual({ sessionId: 'sess-9' });
    expect(store.getToken()).toBe('tok-1');
  });

  it('confirmTwoFactor lets a wrong-code/password error propagate without storing a token', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ error: 'invalid_credentials' }, { status: 401 }));

    await expect(confirmTwoFactor({ email: 'a@b.co', password: 'pw', code: '000000' })).rejects.toMatchObject({
      status: 401,
      error: 'invalid_credentials',
    });
    expect(store.hasToken()).toBe(false);
  });

  // PRD 0019: confirming 2FA also completes a login, so it derives and
  // stores a vault key exactly as auth-service.js's login() does.
  it('confirmTwoFactor derives and stores a usable vault key', async () => {
    const future = new Date(Date.now() + 600000).toISOString();
    globalThis.fetch
      .mockResolvedValueOnce(response({ token: 'tok-1', sessionId: 'sess-9' }, { status: 201 }))
      .mockResolvedValueOnce(
        response({ userId: 'u1', sessionId: 'sess-9', expiresAt: future }, { headers: { 'X-Session-Expires-At': future } })
      );

    expect(vaultKeyStore.hasVaultKey()).toBe(false);

    await confirmTwoFactor({ email: 'a@b.co', password: 'correct-horse-battery', code: '123456' });

    expect(vaultKeyStore.hasVaultKey()).toBe(true);
    expect(vaultKeyStore.getVaultKey().extractable).toBe(false);
  });
});
