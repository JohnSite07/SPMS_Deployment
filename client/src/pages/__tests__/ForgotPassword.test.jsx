// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The reset service is mocked so this suite exercises the SCREEN only (PRD
// 0020) — the backend contract is covered by app/tests and
// client/src/services/__tests__/password-reset.test.js.
vi.mock('../../services/password-reset', () => ({
  resetPassword: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { resetPassword } from '../../services/password-reset';
import ForgotPassword from '../ForgotPassword.jsx';

const STRONG_PASSWORD = 'StrongPass1!';

function renderForgotPassword() {
  return render(
    <MemoryRouter>
      <ForgotPassword />
    </MemoryRouter>
  );
}

beforeEach(() => {
  resetPassword.mockReset();
  mockNavigate.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ForgotPassword screen (PRD 0020)', () => {
  it('renders email, code, new password, and confirm password fields in a single form', () => {
    renderForgotPassword();

    expect(screen.getByLabelText(/email/i)).toBeTruthy();
    expect(screen.getByLabelText(/6-digit code/i)).toBeTruthy();
    expect(screen.getByLabelText(/new master password/i)).toBeTruthy();
    expect(screen.getByLabelText(/confirm new password/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /reset password/i })).toBeTruthy();
  });

  it('only accepts digits in the code field, capped at 6', () => {
    renderForgotPassword();

    const codeInput = screen.getByLabelText(/6-digit code/i);
    fireEvent.change(codeInput, { target: { value: 'ab12cd34ef' } });

    expect(codeInput.value).toBe('1234');
  });

  it('submits email, code, and newPassword to resetPassword', async () => {
    resetPassword.mockResolvedValueOnce(null);
    renderForgotPassword();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText(/new master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    await waitFor(() => expect(resetPassword).toHaveBeenCalledTimes(1));
    expect(resetPassword).toHaveBeenCalledWith({
      email: 'user@example.com',
      code: '123456',
      newPassword: STRONG_PASSWORD,
    });
  });

  it('rejects a weak password client-side without calling resetPassword', async () => {
    renderForgotPassword();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText(/new master password/i), { target: { value: 'short1!' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: 'short1!' } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/at least 12 characters/i);
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('rejects mismatched passwords client-side without calling resetPassword', async () => {
    renderForgotPassword();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText(/new master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: 'DifferentPass2@' } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Passwords do not match.');
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('shows a success message and navigates to /login on a successful reset', async () => {
    resetPassword.mockResolvedValueOnce(null);
    renderForgotPassword();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText(/new master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    // findByText (not role: react-bootstrap's Spinner also carries role="status"
    // while the request is in flight, so querying by role would race it).
    const status = await screen.findByText(/password has been reset/i);
    expect(status).toBeTruthy();
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('shows ONE generic message for the 401 covering unknown email / no-2FA / wrong code', async () => {
    const apiError = new Error('invalid_credentials');
    apiError.status = 401;
    apiError.error = 'invalid_credentials';
    resetPassword.mockRejectedValueOnce(apiError);
    renderForgotPassword();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'nobody@example.com' } });
    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '000000' } });
    fireEvent.change(screen.getByLabelText(/new master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Invalid email, code, or account.');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows the same generic 401 message regardless of which of the three causes it', async () => {
    for (const description of ['unknown email', 'no enabled 2FA', 'wrong code']) {
      const apiError = new Error(description);
      apiError.status = 401;
      apiError.error = 'invalid_credentials';
      resetPassword.mockReset();
      resetPassword.mockRejectedValueOnce(apiError);
      cleanup();
      renderForgotPassword();

      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'someone@example.com' } });
      fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '000000' } });
      fireEvent.change(screen.getByLabelText(/new master password/i), { target: { value: STRONG_PASSWORD } });
      fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: STRONG_PASSWORD } });
      fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe('Invalid email, code, or account.');
    }
  });

  it('shows the specific weak_password message when the server rejects a password the client-side check missed', async () => {
    const apiError = new Error('weak_password');
    apiError.status = 400;
    apiError.error = 'weak_password';
    resetPassword.mockRejectedValueOnce(apiError);
    renderForgotPassword();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText(/new master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/at least 12 characters/i);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('masks the new password by default and reveals it via the toggle', () => {
    renderForgotPassword();

    const passwordInput = screen.getByLabelText(/new master password/i);
    expect(passwordInput.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: /show new password/i }));
    expect(passwordInput.type).toBe('text');

    fireEvent.click(screen.getByRole('button', { name: /hide new password/i }));
    expect(passwordInput.type).toBe('password');
  });

  it('disables submission and shows a "Resetting…" state while the request is in flight', async () => {
    let resolveRequest;
    resetPassword.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );
    const { container } = renderForgotPassword();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText(/new master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    expect(await screen.findAllByText(/resetting/i)).not.toHaveLength(0);
    expect(container.querySelector('fieldset').disabled).toBe(true);

    resolveRequest(null);
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  });
});
