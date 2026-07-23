import { describe, it, expect } from 'vitest';
import { deriveVaultKey, encryptField, decryptField } from '../vault-crypto.js';

// Plain Node environment (no jsdom): Node >=20's global crypto.subtle is a
// real WebCrypto implementation, and this suite exercises real crypto end to
// end — no mocking. jsdom does not implement crypto.subtle at all, which is
// exactly why this file (unlike the *.jsx screen tests) does not opt into
// // @vitest-environment jsdom.

describe('vault-crypto', () => {
  it('derives the same key for the same (password, email) pair every time', async () => {
    const keyA = await deriveVaultKey('correct-horse-battery-staple', 'User@Example.com');
    const keyB = await deriveVaultKey('correct-horse-battery-staple', '  user@example.com  ');

    // Same key material -> ciphertext produced with keyA decrypts under keyB.
    const opaque = await encryptField(keyA, 'hunter2');
    await expect(decryptField(keyB, opaque)).resolves.toBe('hunter2');
  });

  it('derives a different key for a different email (deterministic salt)', async () => {
    const keyA = await deriveVaultKey('correct-horse-battery-staple', 'alice@example.com');
    const keyB = await deriveVaultKey('correct-horse-battery-staple', 'bob@example.com');

    const opaque = await encryptField(keyA, 'hunter2');
    await expect(decryptField(keyB, opaque)).rejects.toThrow();
  });

  it('a wrong master password derives a key that fails to decrypt (GCM auth failure), never garbage', async () => {
    const rightKey = await deriveVaultKey('correct-horse-battery-staple', 'user@example.com');
    const wrongKey = await deriveVaultKey('totally-different-password!', 'user@example.com');

    const opaque = await encryptField(rightKey, 'my vault secret');

    await expect(decryptField(wrongKey, opaque)).rejects.toThrow();
  });

  it('produces the derived key as a non-extractable CryptoKey', async () => {
    const key = await deriveVaultKey('correct-horse-battery-staple', 'user@example.com');
    expect(key.extractable).toBe(false);
    expect(key.algorithm.name).toBe('AES-GCM');
    expect(key.usages).toEqual(expect.arrayContaining(['encrypt', 'decrypt']));
  });

  it('encrypts the same plaintext to different ciphertext each time (random IV), but both decrypt back to it', async () => {
    const key = await deriveVaultKey('correct-horse-battery-staple', 'user@example.com');

    const first = await encryptField(key, 'my-saved-password');
    const second = await encryptField(key, 'my-saved-password');

    expect(first).not.toBe(second);
    await expect(decryptField(key, first)).resolves.toBe('my-saved-password');
    await expect(decryptField(key, second)).resolves.toBe('my-saved-password');
  });

  it('round-trips unicode plaintext', async () => {
    const key = await deriveVaultKey('correct-horse-battery-staple', 'user@example.com');
    const opaque = await encryptField(key, 'pässwörd-日本語-🔒');
    await expect(decryptField(key, opaque)).resolves.toBe('pässwörd-日本語-🔒');
  });

  it('rejects tampered ciphertext rather than returning corrupted plaintext', async () => {
    const key = await deriveVaultKey('correct-horse-battery-staple', 'user@example.com');
    const opaque = await encryptField(key, 'hunter2');

    // Flip a byte in the middle of the base64 payload to simulate tampering.
    const tampered = opaque.slice(0, -4) + (opaque.slice(-4, -3) === 'A' ? 'B' : 'A') + opaque.slice(-3);

    await expect(decryptField(key, tampered)).rejects.toThrow();
  });
});
