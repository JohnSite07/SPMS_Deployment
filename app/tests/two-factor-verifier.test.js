const crypto = require('crypto');
const { authenticator } = require('otplib');
const { verifyTwoFactorCode } = require('../src/services/two-factor-verifier');
const cryptoService = require('../src/services/crypto');

// two-factor-verifier.js reads AES_ENCRYPTION_KEY via services/crypto.js's
// default `loadKey()` when no key is injected — set one for the process so
// this suite never depends on a real secret being exported.
const TEST_KEY = crypto.randomBytes(32);
const originalEnv = process.env.AES_ENCRYPTION_KEY;

beforeAll(() => {
  process.env.AES_ENCRYPTION_KEY = TEST_KEY.toString('base64');
});
afterAll(() => {
  process.env.AES_ENCRYPTION_KEY = originalEnv;
});

function encryptedTotpConfig(secret, overrides = {}) {
  const sealed = cryptoService.encrypt(secret);
  return {
    method: 'TOTP',
    enabled: true,
    encryptedSecret: sealed,
    ...overrides,
  };
}

describe('services/two-factor-verifier', () => {
  it('verifies the current TOTP code', async () => {
    const secret = authenticator.generateSecret();
    const config = encryptedTotpConfig(secret);
    const code = authenticator.generate(secret);

    expect(await verifyTwoFactorCode(config, code)).toBe(true);
  });

  it('rejects a wrong code', async () => {
    const secret = authenticator.generateSecret();
    const config = encryptedTotpConfig(secret);

    expect(await verifyTwoFactorCode(config, '000000')).toBe(false);
  });

  it('rejects when the config is not enabled', async () => {
    const secret = authenticator.generateSecret();
    const config = encryptedTotpConfig(secret, { enabled: false });
    const code = authenticator.generate(secret);

    expect(await verifyTwoFactorCode(config, code)).toBe(false);
  });

  it('rejects a missing config outright, never throws', async () => {
    await expect(verifyTwoFactorCode(undefined, '123456')).resolves.toBe(false);
    await expect(verifyTwoFactorCode(null, '123456')).resolves.toBe(false);
  });

  it('rejects a non-TOTP method (out of this PRD\'s scope)', async () => {
    const secret = authenticator.generateSecret();
    const config = encryptedTotpConfig(secret, { method: 'EMAIL' });
    const code = authenticator.generate(secret);

    expect(await verifyTwoFactorCode(config, code)).toBe(false);
  });

  it('fails closed when the encrypted secret cannot be decrypted (tampered)', async () => {
    const secret = authenticator.generateSecret();
    const config = encryptedTotpConfig(secret);
    config.encryptedSecret = { ...config.encryptedSecret, tag: Buffer.alloc(16) };
    const code = authenticator.generate(secret);

    await expect(verifyTwoFactorCode(config, code)).resolves.toBe(false);
  });

  it('rejects a non-string / empty code without throwing', async () => {
    const secret = authenticator.generateSecret();
    const config = encryptedTotpConfig(secret);

    await expect(verifyTwoFactorCode(config, '')).resolves.toBe(false);
    await expect(verifyTwoFactorCode(config, undefined)).resolves.toBe(false);
  });
});
