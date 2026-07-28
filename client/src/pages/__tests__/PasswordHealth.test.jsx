// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/password-health-service', () => ({
  getHealthReport: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { getHealthReport } from '../../services/password-health-service';
import PasswordHealth from '../PasswordHealth.jsx';

function renderPage() {
  return render(
    <MemoryRouter>
      <PasswordHealth />
    </MemoryRouter>
  );
}

beforeEach(() => {
  getHealthReport.mockReset();
  mockNavigate.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('PasswordHealth screen (PRD 0022, UC-05)', () => {
  it('this screen only reads the latest report — it never triggers analysis itself', async () => {
    getHealthReport.mockResolvedValueOnce({ report: null });
    renderPage();
    await screen.findByText(/no health report yet/i);
    expect(getHealthReport).toHaveBeenCalledTimes(1);
  });

  it('shows a friendly empty state when no report exists yet', async () => {
    getHealthReport.mockResolvedValueOnce({ report: null });

    renderPage();

    expect(await screen.findByText(/no health report yet/i)).toBeTruthy();
    expect(screen.queryByRole('alert', { name: /unable to load/i })).toBeNull();
  });

  it('shows a load error if the report fetch fails', async () => {
    getHealthReport.mockRejectedValueOnce(new Error('network down'));

    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/unable to load/i);
  });

  it('shows the overall score, a strong/weak/reused breakdown, and per-finding alerts when a report exists', async () => {
    getHealthReport.mockResolvedValueOnce({
      report: {
        reportId: 'r1',
        overallScore: 67,
        generatedAt: '2026-01-01T00:00:00.000Z',
        findings: [
          { itemId: 'i1', status: 'OK' },
          { itemId: 'i2', status: 'OK' },
          { itemId: 'i3', status: 'WEAK' },
        ],
        alerts: [
          { alertId: 'a1', type: 'WEAK', message: 'A saved password was flagged as weak.', isRead: false, createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      },
    });

    renderPage();

    expect(await screen.findByRole('img', { name: /67 out of 100/i })).toBeTruthy();
    // Strong/Weak/Reused breakdown, derived from findings.
    expect(screen.getByText('2')).toBeTruthy(); // Strong count
    expect(screen.getAllByText('1')).toHaveLength(1); // Weak count (Reused is 0, rendered as '0' elsewhere)
    expect(screen.getByText(/a saved password was flagged as weak/i)).toBeTruthy();
  });

  it('shows a "Fix now" link per weak/reused finding that navigates to the vault list with that item pre-selected', async () => {
    getHealthReport.mockResolvedValueOnce({
      report: {
        reportId: 'r1',
        overallScore: 50,
        generatedAt: '2026-01-01T00:00:00.000Z',
        findings: [
          { itemId: 'i1', status: 'OK' },
          { itemId: 'i2', status: 'REUSED' },
        ],
        alerts: [],
      },
    });

    renderPage();

    const fixNowButton = await screen.findByRole('button', { name: /fix now/i });
    fireEvent.click(fixNowButton);

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/', { state: { openItemId: 'i2' } })
    );
  });

  it('names each at-risk finding by its username, not an opaque item id', async () => {
    getHealthReport.mockResolvedValueOnce({
      report: {
        reportId: 'r1',
        overallScore: 50,
        generatedAt: '2026-01-01T00:00:00.000Z',
        findings: [
          { itemId: 'i1', status: 'OK', username: 'fine@example.com', title: 'Fine' },
          { itemId: 'i2', status: 'WEAK', username: 'alice@example.com', title: 'Bank' },
        ],
        alerts: [],
      },
    });

    renderPage();

    expect(await screen.findByText('alice@example.com')).toBeTruthy();
    expect(screen.queryByText(/credential #i2/i)).toBeNull();
  });

  it('falls back to the item title, then to the item id, when a finding has no username', async () => {
    getHealthReport.mockResolvedValueOnce({
      report: {
        reportId: 'r1',
        overallScore: 0,
        generatedAt: '2026-01-01T00:00:00.000Z',
        findings: [
          // A credential saved without a username: the title still names it.
          { itemId: 'i1', status: 'WEAK', username: null, title: 'Old router' },
          // A finding whose credential was deleted after the report was
          // generated — the API returns it with both labels null.
          { itemId: 'i2', status: 'REUSED', username: null, title: null },
        ],
        alerts: [],
      },
    });

    renderPage();

    expect(await screen.findByText('Old router')).toBeTruthy();
    expect(screen.getByText('Credential #i2')).toBeTruthy();
  });

  it('shows a positive message when every finding is OK', async () => {
    getHealthReport.mockResolvedValueOnce({
      report: {
        reportId: 'r1',
        overallScore: 100,
        generatedAt: '2026-01-01T00:00:00.000Z',
        findings: [{ itemId: 'i1', status: 'OK' }],
        alerts: [],
      },
    });

    renderPage();

    expect(await screen.findByText(/strong and unique/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /fix now/i })).toBeNull();
  });
});
