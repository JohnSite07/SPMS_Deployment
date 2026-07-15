// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The reset-confirm service is mocked so this suite exercises the SCREEN
// only (PRD 0015) — the backend contract is covered by app/tests and
// client/src/services/__tests__/password-reset.test.js.
vi.mock('../../services/password-reset', () => ({
  confirmReset: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { confirmReset } from '../../services/password-reset';
import ResetPassword from '../ResetPassword.jsx';

const STRONG_PASSWORD = 'StrongPass1!';

function renderResetPassword(path = '/reset-password?token=abc123') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ResetPassword />
    </MemoryRouter>
  );
}

beforeEach(() => {
  confirmReset.mockReset();
  mockNavigate.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ResetPassword screen (PRD 0015)', () => {
  it('reads the token from the URL and passes it to confirmReset along with the new password', async () => {
    confirmReset.mockResolvedValueOnce(null);
    renderResetPassword('/reset-password?token=xyz-789');

    fireEvent.change(screen.getByLabelText(/new master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    await waitFor(() => expect(confirmReset).toHaveBeenCalledTimes(1));
    expect(confirmReset).toHaveBeenCalledWith({ token: 'xyz-789', newPassword: STRONG_PASSWORD });
  });

  it('masks the new password by default and reveals it via the toggle', () => {
    renderResetPassword();

    const passwordInput = screen.getByLabelText(/new master password/i);
    expect(passwordInput.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: /show new password/i }));
    expect(passwordInput.type).toBe('text');

    fireEvent.click(screen.getByRole('button', { name: /hide new password/i }));
    expect(passwordInput.type).toBe('password');
  });

  it('rejects a weak password client-side without calling confirmReset', async () => {
    renderResetPassword();

    fireEvent.change(screen.getByLabelText(/new master password/i), { target: { value: 'short1!' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: 'short1!' } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/at least 12 characters/i);
    expect(confirmReset).not.toHaveBeenCalled();
  });

  it('rejects mismatched passwords client-side without calling confirmReset', async () => {
    renderResetPassword();

    fireEvent.change(screen.getByLabelText(/new master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: 'DifferentPass2@' } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Passwords do not match.');
    expect(confirmReset).not.toHaveBeenCalled();
  });

  it('shows a success message and navigates to /login on a successful reset', async () => {
    confirmReset.mockResolvedValueOnce(null);
    renderResetPassword();

    fireEvent.change(screen.getByLabelText(/new master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    // findByText (not role: react-bootstrap's Spinner also carries role="status"
    // while the request is in flight, so querying by role would race it).
    const status = await screen.findByText(/password has been reset/i);
    expect(status).toBeTruthy();
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('shows a single generic invalid-link message when the server rejects the token', async () => {
    // Expired, already-used, and unknown tokens must all look identical to
    // the client (PRD 0015 anti-enumeration posture).
    confirmReset.mockRejectedValueOnce(new Error('reset_token_invalid'));
    renderResetPassword();

    fireEvent.change(screen.getByLabelText(/new master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('This reset link is invalid or has expired.');
    expect(screen.queryByText(/reset_token_invalid/i)).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows the same generic invalid-link message when no token is present in the URL', () => {
    renderResetPassword('/reset-password');

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('This reset link is invalid or has expired.');
    expect(screen.queryByLabelText(/new master password/i)).toBeNull();
  });
});
