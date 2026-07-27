import { describe, it, expect, beforeEach } from 'vitest';
import { deriveVaultKey } from '../vault-crypto.js';
import { encryptFile, decryptToBlob, MissingVaultKeyError } from '../document-crypto.js';
import * as vaultKeyStore from '../vault-key-store.js';

// Plain Node environment (no jsdom), same posture as vault-crypto.test.js:
// Node >=20's global crypto.subtle is real WebCrypto, and Node 20+ also
// provides global File/Blob, so this suite exercises the real binary
// encrypt/decrypt round trip end to end, no mocking.

describe('document-crypto', () => {
  beforeEach(() => {
    vaultKeyStore.clear();
  });

  it('round-trips a file byte-identical after encrypt then decrypt', async () => {
    const key = await deriveVaultKey('correct-horse-battery-staple', 'user@example.com');
    vaultKeyStore.setVaultKey(key);

    const originalBytes = new Uint8Array([1, 2, 3, 4, 250, 251, 252, 0, 255, 128]);
    const file = new File([originalBytes], 'passport.pdf', { type: 'application/pdf' });

    const encryptedBlob = await encryptFile(file);
    expect(encryptedBlob).toBeInstanceOf(Blob);

    const encryptedBytes = new Uint8Array(await encryptedBlob.arrayBuffer());
    // Sanity: the ciphertext is not the plaintext (never sends the original
    // bytes as-is — the core zero-knowledge guarantee this module exists for).
    expect(encryptedBytes).not.toEqual(originalBytes);

    const decryptedBlob = await decryptToBlob(encryptedBytes, 'application/pdf');
    expect(decryptedBlob.type).toBe('application/pdf');

    const decryptedBytes = new Uint8Array(await decryptedBlob.arrayBuffer());
    expect(decryptedBytes).toEqual(originalBytes);
  });

  it('encrypts the same file to different ciphertext each time (random IV), but both decrypt back identically', async () => {
    const key = await deriveVaultKey('correct-horse-battery-staple', 'user@example.com');
    vaultKeyStore.setVaultKey(key);
    const file = new File(['same content'], 'a.png', { type: 'image/png' });

    const firstBlob = await encryptFile(file);
    const secondBlob = await encryptFile(file);
    const firstBytes = new Uint8Array(await firstBlob.arrayBuffer());
    const secondBytes = new Uint8Array(await secondBlob.arrayBuffer());
    expect(firstBytes).not.toEqual(secondBytes);

    const firstPlain = await (await decryptToBlob(firstBytes, 'image/png')).text();
    const secondPlain = await (await decryptToBlob(secondBytes, 'image/png')).text();
    expect(firstPlain).toBe('same content');
    expect(secondPlain).toBe('same content');
  });

  it('a wrong vault key fails closed on decrypt (GCM auth failure), never yields garbage', async () => {
    const rightKey = await deriveVaultKey('correct-horse-battery-staple', 'user@example.com');
    const wrongKey = await deriveVaultKey('totally-different-password!', 'user@example.com');

    vaultKeyStore.setVaultKey(rightKey);
    const file = new File(['sensitive document contents'], 'a.jpg', { type: 'image/jpeg' });
    const encryptedBlob = await encryptFile(file);
    const encryptedBytes = new Uint8Array(await encryptedBlob.arrayBuffer());

    vaultKeyStore.setVaultKey(wrongKey);
    await expect(decryptToBlob(encryptedBytes, 'image/jpeg')).rejects.toThrow();
  });

  it('rejects tampered ciphertext rather than returning corrupted bytes', async () => {
    const key = await deriveVaultKey('correct-horse-battery-staple', 'user@example.com');
    vaultKeyStore.setVaultKey(key);
    const file = new File(['tamper check'], 'a.pdf', { type: 'application/pdf' });
    const encryptedBlob = await encryptFile(file);
    const bytes = new Uint8Array(await encryptedBlob.arrayBuffer());

    // Flip the last byte (part of the GCM tag) to simulate tampering/corruption.
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 1] ^= 0xff;

    await expect(decryptToBlob(tampered, 'application/pdf')).rejects.toThrow();
  });

  it('throws MissingVaultKeyError rather than crashing when no vault key is in memory', async () => {
    vaultKeyStore.clear();
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });

    await expect(encryptFile(file)).rejects.toBeInstanceOf(MissingVaultKeyError);

    const someBytes = new Uint8Array(20);
    await expect(decryptToBlob(someBytes, 'application/pdf')).rejects.toBeInstanceOf(MissingVaultKeyError);
  });
});
