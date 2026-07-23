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

  it('logs out and returns to the login screen (Figure 7 logout edge)', async () => {
    logout.mockResolvedValueOnce(undefined);
    renderLayout();

    fireEvent.click(screen.getByRole('button', { name: /log out/i }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/login'));
  });
});
