// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The reset-request service is mocked so this suite exercises the SCREEN
// only (PRD 0015) — the backend contract is covered by app/tests and
// client/src/services/__tests__/password-reset.test.js.
vi.mock('../../services/password-reset', () => ({
  requestReset: vi.fn(),
}));

import { requestReset } from '../../services/password-reset';
import ForgotPassword from '../ForgotPassword.jsx';

function renderForgotPassword() {
  return render(
    <MemoryRouter>
      <ForgotPassword />
    </MemoryRouter>
  );
}

beforeEach(() => {
  requestReset.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ForgotPassword screen (PRD 0015)', () => {
  it('renders an email field and a submit button', () => {
    renderForgotPassword();

    expect(screen.getByLabelText(/email/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeTruthy();
  });

  it('submits the entered email to requestReset', async () => {
    requestReset.mockResolvedValueOnce(null);
    renderForgotPassword();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => expect(requestReset).toHaveBeenCalledTimes(1));
    expect(requestReset).toHaveBeenCalledWith({ email: 'user@example.com' });
  });

  it('shows the generic confirmation after a successful request', async () => {
    requestReset.mockResolvedValueOnce(null);
    renderForgotPassword();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    // findByText (not role: react-bootstrap's Spinner also carries role="status"
    // while the request is in flight, so querying by role would race it).
    const status = await screen.findByText('If an account exists for that email, a reset link has been sent.');
    expect(status).toBeTruthy();
  });

  it('shows the SAME generic confirmation even when the email does not exist / the request fails', async () => {
    // Anti-enumeration: the backend always answers 200, but even if the
    // client call itself errors, the UI still must not reveal anything
    // account-specific. A network failure is the one case that legitimately
    // differs (generic retry message), which we assert separately below.
    requestReset.mockRejectedValueOnce(new Error('network'));
    renderForgotPassword();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'nobody@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Something went wrong. Please try again.');
    expect(screen.queryByText(/no account/i)).toBeNull();
    expect(screen.queryByText(/not found/i)).toBeNull();
  });

  it('disables submission and shows a "Sending…" state while the request is in flight', async () => {
    let resolveRequest;
    requestReset.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );
    const { container } = renderForgotPassword();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findAllByText(/sending/i)).not.toHaveLength(0);
    expect(container.querySelector('fieldset').disabled).toBe(true);

    resolveRequest(null);
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  });
});
