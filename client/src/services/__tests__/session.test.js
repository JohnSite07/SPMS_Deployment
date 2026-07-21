import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as store from '../token-store.js';
import * as vaultKeyStore from '../vault-key-store.js';
import { setRedirectHandler, endSession, scheduleAutoLock, cancelAutoLock } from '../session.js';

beforeEach(() => {
  store.clear();
  vaultKeyStore.clear();
  cancelAutoLock();
  setRedirectHandler(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session lifecycle', () => {
  it('endSession clears the token and redirects', () => {
    store.setToken('tok-1');
    const redirect = vi.fn();
    setRedirectHandler(redirect);

    endSession();

    expect(store.hasToken()).toBe(false);
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  // PRD 0019: endSession() is the single choke point for a 401-triggered
  // session end and the auto-lock timer firing, so clearing the vault key
  // here is what makes business rule 5 ("auto-lock") actually lock the
  // vault, not just end the session token.
  it('endSession also clears the vault key', () => {
    store.setToken('tok-1');
    vaultKeyStore.setVaultKey({ algorithm: { name: 'AES-GCM' } });
    setRedirectHandler(vi.fn());

    endSession();

    expect(vaultKeyStore.hasVaultKey()).toBe(false);
  });

  it('proactive timer locks the UI exactly at the expiry deadline', () => {
    vi.useFakeTimers();
    const redirect = vi.fn();
    setRedirectHandler(redirect);
    store.setToken('tok-1');
    store.setExpiresAt(new Date(Date.now() + 600000).toISOString()); // 10 min

    scheduleAutoLock();

    vi.advanceTimersByTime(599999);
    expect(redirect).not.toHaveBeenCalled(); // not yet

    vi.advanceTimersByTime(1);
    expect(redirect).toHaveBeenCalledTimes(1); // locked at the deadline
    expect(store.hasToken()).toBe(false);
  });

  it('the auto-lock timer firing clears the vault key too', () => {
    vi.useFakeTimers();
    setRedirectHandler(vi.fn());
    store.setToken('tok-1');
    vaultKeyStore.setVaultKey({ algorithm: { name: 'AES-GCM' } });
    store.setExpiresAt(new Date(Date.now() + 600000).toISOString());

    scheduleAutoLock();
    vi.advanceTimersByTime(600000);

    expect(vaultKeyStore.hasVaultKey()).toBe(false);
  });

  it('re-arming the timer cancels the previous one (sliding refresh)', () => {
    vi.useFakeTimers();
    const redirect = vi.fn();
    setRedirectHandler(redirect);
    store.setToken('tok-1');

    store.setExpiresAt(new Date(Date.now() + 300000).toISOString());
    scheduleAutoLock();
    // A refresh pushes the deadline out before the first would have fired.
    store.setExpiresAt(new Date(Date.now() + 600000).toISOString());
    scheduleAutoLock();

    vi.advanceTimersByTime(300000);
    expect(redirect).not.toHaveBeenCalled(); // old timer was cancelled

    vi.advanceTimersByTime(300000);
    expect(redirect).toHaveBeenCalledTimes(1); // new deadline
  });

  it('an already-past expiry ends the session immediately', () => {
    vi.useFakeTimers();
    const redirect = vi.fn();
    setRedirectHandler(redirect);
    store.setToken('tok-1');
    store.setExpiresAt(new Date(Date.now() - 1000).toISOString());

    scheduleAutoLock();

    expect(redirect).toHaveBeenCalledTimes(1);
    expect(store.hasToken()).toBe(false);
  });
});
