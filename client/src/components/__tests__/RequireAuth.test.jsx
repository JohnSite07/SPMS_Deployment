// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Guard the auth check, not the real token store, so the test states the
// intent directly: no session -> login, session -> protected content.
vi.mock('../../services/auth-service', () => ({
  isAuthenticated: vi.fn(),
}));

import { isAuthenticated } from '../../services/auth-service';
import RequireAuth from '../RequireAuth.jsx';

function renderAtRoot() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/welcome" element={<div>Welcome Screen</div>} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <div>Protected Vault</div>
            </RequireAuth>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RequireAuth', () => {
  it('redirects to /welcome when there is no session', () => {
    isAuthenticated.mockReturnValue(false);
    renderAtRoot();

    expect(screen.getByText('Welcome Screen')).toBeTruthy();
    expect(screen.queryByText('Protected Vault')).toBeNull();
  });

  it('renders the protected content when authenticated', () => {
    isAuthenticated.mockReturnValue(true);
    renderAtRoot();

    expect(screen.getByText('Protected Vault')).toBeTruthy();
    expect(screen.queryByText('Welcome Screen')).toBeNull();
  });
});
