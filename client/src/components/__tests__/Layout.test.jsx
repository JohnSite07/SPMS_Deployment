// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/auth-service', () => ({
  logout: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { logout } from '../../services/auth-service';
import Layout from '../Layout.jsx';

function renderLayout() {
  return render(
    <MemoryRouter>
      <Layout />
    </MemoryRouter>
  );
}

beforeEach(() => {
  logout.mockReset();
  mockNavigate.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('Layout (authenticated shell)', () => {
  it('renders the persistent bottom navigation tabs', () => {
    renderLayout();

    expect(screen.getByRole('link', { name: 'Vault' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Documents' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Health' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Activity' })).toBeTruthy();
  });

  it('opens the mobile navigation drawer from the header menu button', async () => {
    renderLayout();

    // The drawer is closed at rest, so only the desktop sidebar's links exist.
    expect(screen.getAllByRole('link', { name: 'Vault' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /open navigation menu/i }));

    // Once opened, the drawer adds its own copy of the nav (and a close
    // control), so the same destination now appears twice.
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Vault' })).toHaveLength(2));
    expect(screen.getByRole('button', { name: /close/i })).toBeTruthy();
  });

  it('logs out and returns to the login screen (Figure 7 logout edge)', async () => {
    logout.mockResolvedValueOnce(undefined);
    renderLayout();

    fireEvent.click(screen.getByRole('button', { name: /log out/i }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/login'));
  });
});
