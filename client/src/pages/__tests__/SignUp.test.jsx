// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The registration service is mocked so this suite exercises the SCREEN
// only (PRD 0018) — the backend contract is covered by app/tests and
// client/src/services/__tests__/registration-service.test.js.
vi.mock('../../services/registration-service', () => ({
  registerAccount: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { registerAccount } from '../../services/registration-service';
import SignUp from '../SignUp.jsx';

const STRONG_PASSWORD = 'StrongPass1!';

function renderSignUp() {
  return render(
    <MemoryRouter>
      <SignUp />
    </MemoryRouter>
  );
}

beforeEach(() => {
  registerAccount.mockReset();
  mockNavigate.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SignUp screen (PRD 0018)', () => {
  it('renders email, password, and confirm-password fields plus a submit button', () => {
    renderSignUp();

    expect(screen.getByLabelText(/email/i)).toBeTruthy();
    expect(screen.getByLabelText(/^master password/i)).toBeTruthy();
    expect(screen.getByLabelText(/confirm master password/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /sign up/i })).toBeTruthy();
  });

  it('rejects a weak password client-side without calling registerAccount', async () => {
    renderSignUp();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText(/^master password/i), { target: { value: 'short1!' } });
    fireEvent.change(screen.getByLabelText(/confirm master password/i), { target: { value: 'short1!' } });
    fireEvent.click(screen.getByRole('button', { name: /sign up/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/at least 12 characters/i);
    expect(registerAccount).not.toHaveBeenCalled();
  });

  it('rejects mismatched passwords client-side without calling registerAccount', async () => {
    renderSignUp();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText(/^master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm master password/i), { target: { value: 'DifferentPass2@' } });
    fireEvent.click(screen.getByRole('button', { name: /sign up/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Passwords do not match.');
    expect(registerAccount).not.toHaveBeenCalled();
  });

  it('registers and navigates to /2fa-setup with the email in router state on success', async () => {
    registerAccount.mockResolvedValueOnce({ userId: 'user-1' });
    renderSignUp();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText(/^master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /sign up/i }));

    await waitFor(() =>
      expect(registerAccount).toHaveBeenCalledWith({ email: 'user@example.com', password: STRONG_PASSWORD })
    );
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/2fa-setup', { state: { email: 'user@example.com' } })
    );
  });

  it('shows a distinct message with a login link when the email is already registered', async () => {
    const apiError = new Error('email_already_registered');
    apiError.status = 409;
    apiError.error = 'email_already_registered';
    registerAccount.mockRejectedValueOnce(apiError);
    renderSignUp();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText(/^master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /sign up/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/already exists/i);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows the specific weak-password message when the server rejects it', async () => {
    const apiError = new Error('weak_password');
    apiError.status = 400;
    apiError.error = 'weak_password';
    registerAccount.mockRejectedValueOnce(apiError);
    renderSignUp();

    // Client-side check passes (strong-looking), but the server disagrees.
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText(/^master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /sign up/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/at least 12 characters/i);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows a generic error for invalid_request or any other failure', async () => {
    const apiError = new Error('invalid_request');
    apiError.status = 400;
    apiError.error = 'invalid_request';
    registerAccount.mockRejectedValueOnce(apiError);
    renderSignUp();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText(/^master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/confirm master password/i), { target: { value: STRONG_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /sign up/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Something went wrong. Please try again.');
    expect(screen.queryByText(/invalid_request/i)).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
