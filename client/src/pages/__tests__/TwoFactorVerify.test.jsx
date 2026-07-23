// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The login service is mocked so this suite exercises the SCREEN only (UC-01
// step 2 UI), never the real network path — the backend contract is covered by
// app/tests and client/src/services/__tests__/auth-service.test.js.
vi.mock('../../services/auth-service', () => ({
  login: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { login } from '../../services/auth-service';
import { setPendingLogin, getPendingLogin, clearPendingLogin } from '../../services/pending-login';
import TwoFactorVerify from '../TwoFactorVerify.jsx';

function renderStep2() {
  return render(
    <MemoryRouter>
      <TwoFactorVerify />
    </MemoryRouter>
  );
}

function arriveFromStep1() {
  setPendingLogin({ email: 'user@example.com', password: 'correct-horse-battery' });
}

beforeEach(() => {
  login.mockReset();
  mockNavigate.mockReset();
  clearPendingLogin();
});

afterEach(() => {
  cleanup();
  clearPendingLogin();
});

describe('Two-factor verification screen — step 2 (UC-01)', () => {
  it('renders the code input and Verify button, and no email/password fields', () => {
    arriveFromStep1();
    renderStep2();

    expect(screen.getByLabelText(/6-digit code/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /verify code/i })).toBeTruthy();

    // Those belong to step 1; this screen only shows which account it is for.
    expect(screen.queryByLabelText('Master password')).toBeNull();
    expect(screen.queryByLabelText(/^email$/i)).toBeNull();
    expect(screen.getByText(/signing in as user@example.com/i)).toBeTruthy();
  });

  it('strips non-digits and caps the code at six characters', () => {
    arriveFromStep1();
    renderStep2();

    const codeInput = screen.getByLabelText(/6-digit code/i);
    fireEvent.change(codeInput, { target: { value: '12a34b5678' } });

    expect(codeInput.value).toBe('123456');
  });

  it('submits the parked email and password together with the code in one login call', async () => {
    arriveFromStep1();
    login.mockResolvedValueOnce({ sessionId: 'sess-1' });
    renderStep2();

    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify code/i }));

    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect(login).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'correct-horse-battery',
      code: '123456',
    });
  });

  it('navigates to the dashboard and drops the parked credentials on success', async () => {
    arriveFromStep1();
    login.mockResolvedValueOnce({ sessionId: 'sess-1' });
    renderStep2();

    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify code/i }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
    expect(getPendingLogin()).toBeNull();
  });

  it('shows a single generic error on failure and leaks no field-specific detail', async () => {
    // Mirrors the backend's real shape (session.js): every failure — bad
    // password, bad code, unknown email, or a lockout — is the same 401
    // with no distinguishing description.
    arriveFromStep1();
    const apiError = new Error('invalid_credentials');
    apiError.status = 401;
    apiError.error = 'invalid_credentials';
    login.mockRejectedValueOnce(apiError);
    renderStep2();

    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /verify code/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Invalid email, password, or code.');

    // No leak: the raw backend error code/message never reaches the DOM, and
    // no field is singled out as the culprit.
    expect(screen.queryByText(/invalid_credentials/i)).toBeNull();
    expect(screen.queryByText(/password is incorrect/i)).toBeNull();
    expect(screen.queryByText(/wrong code/i)).toBeNull();
    expect(screen.queryByText(/locked/i)).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('keeps the user on step 2 after a failure so the code can be retried', async () => {
    arriveFromStep1();
    login.mockRejectedValueOnce(new Error('nope'));
    renderStep2();

    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /verify code/i }));

    await screen.findByRole('alert');
    expect(screen.getByLabelText(/6-digit code/i)).toBeTruthy();
    // The handoff survives so a retry doesn't force the password to be retyped.
    expect(getPendingLogin()).not.toBeNull();
  });

  it('disables submission and shows an "Unlocking…" state while the request is in flight', async () => {
    arriveFromStep1();
    let resolveLogin;
    login.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLogin = resolve;
      })
    );
    const { container } = renderStep2();

    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify code/i }));

    expect(await screen.findAllByText(/unlocking/i)).not.toHaveLength(0);
    // The whole field group (including the submit button) is disabled via the
    // wrapping <fieldset disabled>, per TwoFactorVerify.jsx.
    expect(container.querySelector('fieldset').disabled).toBe(true);

    resolveLogin({ sessionId: 'sess-1' });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
  });

  it('clears the handoff and returns to step 1 via "Back to sign in"', () => {
    arriveFromStep1();
    renderStep2();

    fireEvent.click(screen.getByRole('button', { name: /back to sign in/i }));

    expect(getPendingLogin()).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('redirects to step 1 when reached with no handoff (deep link or refresh)', () => {
    // No setPendingLogin() — the in-memory store does not survive a reload.
    renderStep2();

    expect(screen.queryByLabelText(/6-digit code/i)).toBeNull();
    expect(login).not.toHaveBeenCalled();
  });
});
