// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The 2FA service is mocked so this suite exercises the SCREEN only
// (PRD 0017) — the backend contract is covered by app/tests and
// client/src/services/__tests__/two-factor-service.test.js.
vi.mock('../../services/two-factor-service', () => ({
  enrollTwoFactor: vi.fn(),
  confirmTwoFactor: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { enrollTwoFactor, confirmTwoFactor } from '../../services/two-factor-service';
import TwoFactorSetup from '../TwoFactorSetup.jsx';

function renderPage(initialEntries = ['/2fa-setup']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <TwoFactorSetup />
    </MemoryRouter>
  );
}

async function fillStepOneAndSubmit() {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } });
  fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: 'correct-horse-battery' } });
  fireEvent.click(screen.getByRole('button', { name: /set up two-factor authentication/i }));
}

beforeEach(() => {
  enrollTwoFactor.mockReset();
  confirmTwoFactor.mockReset();
  mockNavigate.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('TwoFactorSetup screen (PRD 0017)', () => {
  it('renders the step 1 form', () => {
    renderPage();

    expect(screen.getByLabelText(/email/i)).toBeTruthy();
    expect(screen.getByLabelText(/master password/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /set up two-factor authentication/i })).toBeTruthy();
  });

  it('defaults the email field to empty when reached with no router state (PRD 0017 behaviour, unchanged)', () => {
    renderPage();

    expect(screen.getByLabelText(/email/i).value).toBe('');
  });

  it('pre-fills the email field from router state when handed off by SignUp.jsx (PRD 0018)', () => {
    renderPage([{ pathname: '/2fa-setup', state: { email: 'fresh@example.com' } }]);

    expect(screen.getByLabelText(/email/i).value).toBe('fresh@example.com');
  });

  it('advances to step 2 and shows the secret + otpauth URI after a successful enroll', async () => {
    enrollTwoFactor.mockResolvedValueOnce({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/SecureVault:user@example.com?secret=JBSWY3DPEHPK3PXP',
    });
    renderPage();

    await fillStepOneAndSubmit();

    await waitFor(() => expect(enrollTwoFactor).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'correct-horse-battery',
    }));

    expect(await screen.findByDisplayValue('JBSWY3DPEHPK3PXP')).toBeTruthy();
    expect(await screen.findByDisplayValue('otpauth://totp/SecureVault:user@example.com?secret=JBSWY3DPEHPK3PXP')).toBeTruthy();
    expect(screen.getByLabelText(/6-digit code/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /confirm and log in/i })).toBeTruthy();
  });

  it('shows a generic error on enroll failure and stays on step 1', async () => {
    const apiError = new Error('invalid_credentials');
    apiError.status = 401;
    apiError.error = 'invalid_credentials';
    enrollTwoFactor.mockRejectedValueOnce(apiError);
    renderPage();

    await fillStepOneAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Invalid email or password.');
    expect(screen.queryByLabelText(/6-digit code/i)).toBeNull();
  });

  it('shows a distinct message when the account already has 2FA enabled', async () => {
    const apiError = new Error('two_factor_already_enabled');
    apiError.status = 409;
    apiError.error = 'two_factor_already_enabled';
    enrollTwoFactor.mockRejectedValueOnce(apiError);
    renderPage();

    await fillStepOneAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Two-factor authentication is already set up for this account.');
  });

  it('navigates to / after a successful confirm', async () => {
    enrollTwoFactor.mockResolvedValueOnce({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/SecureVault:user@example.com?secret=JBSWY3DPEHPK3PXP',
    });
    confirmTwoFactor.mockResolvedValueOnce({ sessionId: 'sess-1' });
    renderPage();

    await fillStepOneAndSubmit();
    await screen.findByLabelText(/6-digit code/i);

    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm and log in/i }));

    await waitFor(() =>
      expect(confirmTwoFactor).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'correct-horse-battery',
        code: '123456',
      })
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
  });

  it('shows a generic error on confirm failure without losing step 2 state', async () => {
    enrollTwoFactor.mockResolvedValueOnce({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/SecureVault:user@example.com?secret=JBSWY3DPEHPK3PXP',
    });
    const apiError = new Error('invalid_credentials');
    apiError.status = 401;
    apiError.error = 'invalid_credentials';
    confirmTwoFactor.mockRejectedValueOnce(apiError);
    renderPage();

    await fillStepOneAndSubmit();
    await screen.findByLabelText(/6-digit code/i);

    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm and log in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Invalid email, password, or code.');
    // Step 2 state must still be visible so the user can just retry the code.
    expect(screen.getByDisplayValue('JBSWY3DPEHPK3PXP')).toBeTruthy();
    expect(screen.getByLabelText(/6-digit code/i)).toBeTruthy();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
