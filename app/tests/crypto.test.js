const crypto = require('crypto');
const { encrypt, decrypt } = require('../src/services/crypto');

const TEST_KEY = crypto.randomBytes(32);

describe('services/crypto (AES-256-GCM)', () => {
  it('round-trips a plaintext through encrypt/decrypt', () => {
    const sealed = encrypt('a totp seed', { key: TEST_KEY });

    expect(Buffer.isBuffer(sealed.ciphertext)).toBe(true);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.tag).toHaveLength(16);
    expect(decrypt(sealed, { key: TEST_KEY })).toBe('a totp seed');
  });

  it('produces a different ciphertext and iv on every call (no nonce reuse)', () => {
    const a = encrypt('same plaintext', { key: TEST_KEY });
    const b = encrypt('same plaintext', { key: TEST_KEY });

    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('throws — never returns garbage — when the auth tag was tampered with', () => {
    const sealed = encrypt('a totp seed', { key: TEST_KEY });
    const tampered = { ...sealed, tag: Buffer.from(sealed.tag) };
    tampered.tag[0] ^= 0xff;

    expect(() => decrypt(tampered, { key: TEST_KEY })).toThrow();
  });

  it('throws when the ciphertext was tampered with', () => {
    const sealed = encrypt('a totp seed', { key: TEST_KEY });
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    tampered.ciphertext[0] ^= 0xff;

    expect(() => decrypt(tampered, { key: TEST_KEY })).toThrow();
  });

  it('throws when decrypted with the wrong key', () => {
    const sealed = encrypt('a totp seed', { key: TEST_KEY });
    const wrongKey = crypto.randomBytes(32);

    expect(() => decrypt(sealed, { key: wrongKey })).toThrow();
  });

  it('rejects a key of the wrong length via loadKey', () => {
    const { loadKey } = require('../src/services/crypto');
    expect(() => loadKey({ AES_ENCRYPTION_KEY: Buffer.from('too-short').toString('base64') })).toThrow(
      /32 bytes/
    );
  });

  it('requires AES_ENCRYPTION_KEY to be set', () => {
    const { loadKey } = require('../src/services/crypto');
    expect(() => loadKey({})).toThrow(/AES_ENCRYPTION_KEY is not set/);
  });
});
