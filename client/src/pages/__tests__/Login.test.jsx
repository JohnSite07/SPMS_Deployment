// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { getPendingLogin, setPendingLogin, clearPendingLogin } from '../../services/pending-login';
import Login from '../Login.jsx';

function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockNavigate.mockReset();
  clearPendingLogin();
});

afterEach(() => {
  cleanup();
  clearPendingLogin();
});

// Step 1 of UC-01. This screen no longer talks to the network at all — it
// collects email + master password and hands off to /login/2fa, where the
// single POST /api/session happens (see TwoFactorVerify.test.jsx).
describe('Login screen — step 1 (UC-01)', () => {
  it('renders email and master password inputs and an Unlock button, and no 2FA code field', () => {
    renderLogin();

    expect(screen.getByLabelText(/email/i)).toBeTruthy();
    expect(screen.getByLabelText('Master password')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^unlock$/i })).toBeTruthy();

    // The second factor lives on its own screen now.
    expect(screen.queryByLabelText(/6-digit code/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /verify code/i })).toBeNull();
  });

  it('masks the master password by default and reveals it via the toggle', () => {
    renderLogin();

    const passwordInput = screen.getByLabelText('Master password');
    expect(passwordInput.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: /show master password/i }));
    expect(passwordInput.type).toBe('text');

    fireEvent.click(screen.getByRole('button', { name: /hide master password/i }));
    expect(passwordInput.type).toBe('password');
  });

  it('parks the credentials in memory and redirects to the 2FA step on Unlock', () => {
    renderLogin();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Master password'), {
      target: { value: 'correct-horse-battery' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^unlock$/i }));

    expect(getPendingLogin()).toEqual({
      email: 'user@example.com',
      password: 'correct-horse-battery',
    });
    expect(mockNavigate).toHaveBeenCalledWith('/login/2fa');
  });

  it('advances without validating, so step 1 leaks no signal about the account', () => {
    // Anti-enumeration (UC-01 exceptions): step 1 must not be an oracle. It
    // makes no request, shows no error, and advances regardless — the single
    // generic 401 is surfaced on step 2 instead.
    renderLogin();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'nobody@example.com' } });
    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'wrong' } });

    fireEvent.click(screen.getByRole('button', { name: /^unlock$/i }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('/login/2fa');
  });

  it('clears any abandoned step-1 handoff when it mounts', () => {
    setPendingLogin({ email: 'stale@example.com', password: 'stale-password' });

    renderLogin();

    expect(getPendingLogin()).toBeNull();
  });
});
