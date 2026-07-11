import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as store from '../token-store.js';
import { setRedirectHandler, endSession, scheduleAutoLock, cancelAutoLock } from '../session.js';

beforeEach(() => {
  store.clear();
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
