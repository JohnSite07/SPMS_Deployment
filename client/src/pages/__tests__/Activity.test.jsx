// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/audit', () => ({
  getAuditLog: vi.fn(),
}));

import { getAuditLog } from '../../services/audit';
import Activity from '../Activity.jsx';

const PAGE_SIZE = 7;

// Keyset pagination, so a page is identified by the cursor that produced it,
// not by an offset. These fixtures mirror what routes/audit.js returns.
function page(entries, nextCursor = null) {
  return { entries, nextCursor };
}

function entriesNamed(...actions) {
  return actions.map((action, i) => ({
    entryId: `${action}-${i}`,
    action,
    timestamp: new Date(1_700_000_000_000 - i * 1000).toISOString(),
    ipAddress: '203.0.113.7',
  }));
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Activity />
    </MemoryRouter>
  );
}

beforeEach(() => {
  getAuditLog.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('Activity screen', () => {
  it('requests 7 entries per page', async () => {
    getAuditLog.mockResolvedValueOnce(page(entriesNamed('login.succeeded')));
    renderPage();

    await screen.findByText('Login Succeeded');
    expect(getAuditLog).toHaveBeenCalledWith(PAGE_SIZE, null);
  });

  it('shows the action and its time, and never the IP address', async () => {
    getAuditLog.mockResolvedValueOnce(page(entriesNamed('credentials.listed')));
    renderPage();

    await screen.findByText('Credentials Listed');
    // The address is still in the payload; the screen must not render it.
    expect(screen.queryByText(/203\.0\.113\.7/)).toBeNull();
  });

  it('pages forward with the cursor the server returned', async () => {
    getAuditLog
      .mockResolvedValueOnce(page(entriesNamed('login.succeeded'), 'cursor-2'))
      .mockResolvedValueOnce(page(entriesNamed('vault.locked')));

    renderPage();
    await screen.findByText('Login Succeeded');

    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    await screen.findByText('Vault Locked');
    expect(getAuditLog).toHaveBeenLastCalledWith(PAGE_SIZE, 'cursor-2');
    expect(screen.getByText(/page 2/i)).toBeTruthy();
  });

  it('pages back to the cursor that produced the previous page', async () => {
    getAuditLog
      .mockResolvedValueOnce(page(entriesNamed('login.succeeded'), 'cursor-2'))
      .mockResolvedValueOnce(page(entriesNamed('vault.locked'), 'cursor-3'))
      .mockResolvedValueOnce(page(entriesNamed('login.succeeded'), 'cursor-2'));

    renderPage();
    await screen.findByText('Login Succeeded');
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    await screen.findByText('Vault Locked');

    fireEvent.click(screen.getByRole('button', { name: /previous/i }));

    // Back to the first page means back to a null cursor, not "cursor-2 minus
    // one" — there is no arithmetic on a keyset cursor.
    await waitFor(() => expect(getAuditLog).toHaveBeenLastCalledWith(PAGE_SIZE, null));
    expect(screen.getByText(/page 1/i)).toBeTruthy();
  });

  it('disables Previous on the first page and Next on the last', async () => {
    getAuditLog.mockResolvedValueOnce(page(entriesNamed('login.succeeded')));
    renderPage();
    await screen.findByText('Login Succeeded');

    expect(screen.getByRole('button', { name: /previous/i }).disabled).toBe(true);
    // nextCursor was null, so there is nothing after this page.
    expect(screen.getByRole('button', { name: /next/i }).disabled).toBe(true);
  });

  it('surfaces a failed load instead of showing an empty log', async () => {
    getAuditLog.mockRejectedValueOnce(new Error('boom'));
    renderPage();

    await screen.findByText(/boom/i);
  });
});
