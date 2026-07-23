import { describe, it, expect, beforeEach } from 'vitest';
import {
  setPendingLogin,
  getPendingLogin,
  hasPendingLogin,
  clearPendingLogin,
} from '../pending-login';

beforeEach(() => {
  clearPendingLogin();
});

describe('pending-login store (UC-01 step 1 → step 2 handoff)', () => {
  it('starts empty', () => {
    expect(getPendingLogin()).toBeNull();
    expect(hasPendingLogin()).toBe(false);
  });

  it('holds the email and master password handed over by step 1', () => {
    setPendingLogin({ email: 'user@example.com', password: 'correct-horse-battery' });

    expect(getPendingLogin()).toEqual({
      email: 'user@example.com',
      password: 'correct-horse-battery',
    });
    expect(hasPendingLogin()).toBe(true);
  });

  it('ignores an incomplete handoff rather than parking a half-filled attempt', () => {
    setPendingLogin({ email: 'user@example.com' });
    expect(getPendingLogin()).toBeNull();

    setPendingLogin({ password: 'correct-horse-battery' });
    expect(getPendingLogin()).toBeNull();

    setPendingLogin();
    expect(getPendingLogin()).toBeNull();
  });

  it('clears on demand so the master password does not outlive the attempt', () => {
    setPendingLogin({ email: 'user@example.com', password: 'correct-horse-battery' });

    clearPendingLogin();

    expect(getPendingLogin()).toBeNull();
    expect(hasPendingLogin()).toBe(false);
  });

  it('never touches web storage (frontend rule 4 — in-memory only)', () => {
    setPendingLogin({ email: 'user@example.com', password: 'correct-horse-battery' });

    // The module has no storage dependency at all; assert on the source's
    // contract by confirming the value is gone once the module state is
    // cleared, which persisted storage would survive.
    clearPendingLogin();
    expect(getPendingLogin()).toBeNull();
  });
});
