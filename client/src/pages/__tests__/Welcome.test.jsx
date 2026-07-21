// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Welcome from '../Welcome.jsx';

function renderWelcome() {
  return render(
    <MemoryRouter>
      <Welcome />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
});

describe('Welcome screen (PRD 0018)', () => {
  it('renders the SecureVault wordmark', () => {
    renderWelcome();

    expect(screen.getByText('SecureVault')).toBeTruthy();
  });

  it('renders a feature summary drawn from real shipped functionality', () => {
    renderWelcome();

    expect(screen.getByText(/encrypted vault/i)).toBeTruthy();
    expect(screen.getByText(/two-factor authentication/i)).toBeTruthy();
    expect(screen.getByText(/password generator/i)).toBeTruthy();
    expect(screen.getByText(/secure document storage/i)).toBeTruthy();
    expect(screen.getByText(/10-minute auto-lock/i)).toBeTruthy();
    expect(screen.getByText(/append-only audit log/i)).toBeTruthy();
  });

  it('links "Sign Up" to /signup and "Sign In" to /login', () => {
    renderWelcome();

    // react-bootstrap's <Button as={Link}> renders an <a role="button">, so
    // these are queried as buttons, not links, but the href is what matters.
    const signUpLink = screen.getByRole('button', { name: /sign up/i });
    const signInLink = screen.getByRole('button', { name: /sign in/i });

    expect(signUpLink.getAttribute('href')).toBe('/signup');
    expect(signInLink.getAttribute('href')).toBe('/login');
  });
});
