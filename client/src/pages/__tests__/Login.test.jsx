// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The login service is mocked so this suite exercises the SCREEN only (UC-01
// UI), never the real network path — the backend contract is covered by
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
import Login from '../Login.jsx';

function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
  );
}

beforeEach(() => {
  login.mockReset();
  mockNavigate.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('Login screen (UC-01)', () => {
  it('renders email, master password, and 2FA code inputs plus a submit button', () => {
    renderLogin();

    expect(screen.getByLabelText(/email/i)).toBeTruthy();
    expect(screen.getByLabelText('Master password')).toBeTruthy();
    expect(screen.getByLabelText(/6-digit code/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /unlock/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /verify code/i })).toBeTruthy();
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

  it('submits email, password, and code together in one call to auth-service.login', async () => {
    login.mockResolvedValueOnce({ sessionId: 'sess-1' });
    renderLogin();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'correct-horse-battery' } });
    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '123456' } });

    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect(login).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'correct-horse-battery',
      code: '123456',
    });
  });

  it('navigates to the dashboard on a successful login', async () => {
    login.mockResolvedValueOnce({ sessionId: 'sess-1' });
    renderLogin();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'correct-horse-battery' } });
    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '123456' } });

    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
  });

  it('shows a single generic error on failure and leaks no field-specific detail', async () => {
    // Mirrors the backend's real shape (session.js): every failure — bad
    // password, bad code, unknown email, or a lockout — is the same 401
    // with no distinguishing description.
    const apiError = new Error('invalid_credentials');
    apiError.status = 401;
    apiError.error = 'invalid_credentials';
    login.mockRejectedValueOnce(apiError);
    renderLogin();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'wrong-password' } });
    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '000000' } });

    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

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

  it('disables submission and shows an "Unlocking…" state while the request is in flight', async () => {
    let resolveLogin;
    login.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLogin = resolve;
      })
    );
    const { container } = renderLogin();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'correct-horse-battery' } });
    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '123456' } });

    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    expect(await screen.findAllByText(/unlocking/i)).not.toHaveLength(0);
    // The whole field group (including the submit buttons) is disabled via
    // the wrapping <fieldset disabled>, per Login.jsx.
    expect(container.querySelector('fieldset').disabled).toBe(true);

    resolveLogin({ sessionId: 'sess-1' });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
  });
});
