import { describe, it, expect, beforeEach } from 'vitest';
import { getVaultKey, setVaultKey, hasVaultKey, clear } from '../vault-key-store.js';

beforeEach(() => {
  clear();
});

describe('vault-key-store', () => {
  it('starts with no vault key held', () => {
    expect(hasVaultKey()).toBe(false);
    expect(getVaultKey()).toBeNull();
  });

  it('setVaultKey stores the key and hasVaultKey/getVaultKey reflect it', () => {
    const fakeKey = { algorithm: { name: 'AES-GCM' } };
    setVaultKey(fakeKey);

    expect(hasVaultKey()).toBe(true);
    expect(getVaultKey()).toBe(fakeKey);
  });

  it('setVaultKey ignores a falsy argument rather than wiping a live key', () => {
    const fakeKey = { algorithm: { name: 'AES-GCM' } };
    setVaultKey(fakeKey);

    setVaultKey(null);
    setVaultKey(undefined);

    expect(getVaultKey()).toBe(fakeKey);
  });

  it('clear() removes the key', () => {
    setVaultKey({ algorithm: { name: 'AES-GCM' } });
    clear();

    expect(hasVaultKey()).toBe(false);
    expect(getVaultKey()).toBeNull();
  });
});
