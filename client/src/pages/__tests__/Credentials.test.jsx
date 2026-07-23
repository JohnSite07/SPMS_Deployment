// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The vault key is real (vault-key-store.js is trivial in-memory state, no
// crypto), but encryption/decryption and the network layer are mocked so
// this suite exercises the SCREEN only (PRD 0019/0022) — the real crypto
// round-trip is covered by vault-crypto.test.js, the real request shapes by
// credentials-service.test.js/password-health-service.test.js, and the real
// weak/reused scoring by vault-health-analyzer.test.js (used for real here,
// unmocked, since it is pure and its own dedicated suite already covers it).
vi.mock('../../services/credentials-service', () => ({
  listCredentials: vi.fn(),
  getCredential: vi.fn(),
  addCredential: vi.fn(),
  updateCredential: vi.fn(),
  deleteCredential: vi.fn(),
}));

vi.mock('../../services/vault-crypto', () => ({
  encryptField: vi.fn(),
  decryptField: vi.fn(),
}));

vi.mock('../../services/password-health-service', () => ({
  submitHealthReport: vi.fn(),
}));

import {
  listCredentials,
  getCredential,
  addCredential,
  updateCredential,
  deleteCredential,
} from '../../services/credentials-service';
import { encryptField, decryptField } from '../../services/vault-crypto';
import { submitHealthReport } from '../../services/password-health-service';
import * as vaultKeyStore from '../../services/vault-key-store.js';
import Credentials from '../Credentials.jsx';

const FAKE_KEY = { algorithm: { name: 'AES-GCM' } };

function renderPage({ route = '/', state } = {}) {
  const initialEntries = [state ? { pathname: route, state } : route];
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Credentials />
    </MemoryRouter>
  );
}

beforeEach(() => {
  listCredentials.mockReset();
  getCredential.mockReset();
  addCredential.mockReset();
  updateCredential.mockReset();
  deleteCredential.mockReset();
  encryptField.mockReset();
  decryptField.mockReset();
  submitHealthReport.mockReset();
  vaultKeyStore.clear();

  Object.defineProperty(window.navigator, 'clipboard', {
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue(''),
    },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Credentials screen (PRD 0019)', () => {
  it('shows a guard message and never fetches when there is no vault key in memory', () => {
    renderPage();

    expect(screen.getByRole('alert').textContent).toMatch(/log out and log back in/i);
    expect(listCredentials).not.toHaveBeenCalled();
  });

  it('fetches and renders the list — title/url/username only, never the password', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listCredentials.mockResolvedValueOnce([
      {
        itemId: 'i1',
        title: 'Email',
        url: 'https://mail.example.com',
        username: 'me@example.com',
        encryptedPassword: 'CIPHER1==',
      },
      {
        itemId: 'i2',
        title: 'Bank',
        url: 'https://bank.example.com',
        username: 'someone',
        encryptedPassword: 'CIPHER2==',
      },
    ]);

    renderPage();

    expect(await screen.findByText('Email')).toBeTruthy();
    expect(screen.getByText('Bank')).toBeTruthy();
    expect(screen.getByText('me@example.com')).toBeTruthy();
    expect(screen.queryByText('CIPHER1==')).toBeNull();
    // PRD 0022: the list still never DISPLAYS a decrypted password, but it
    // does now decrypt each item's password transiently, in memory, purely
    // to compute the health badges below.
    await waitFor(() => expect(decryptField).toHaveBeenCalledTimes(2));
  });

  it('filters the already-fetched list client-side, with no additional API call', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listCredentials.mockResolvedValueOnce([
      { itemId: 'i1', title: 'Email', url: 'https://mail.example.com', username: 'me', encryptedPassword: 'C1' },
      { itemId: 'i2', title: 'Bank', url: 'https://bank.example.com', username: 'someone', encryptedPassword: 'C2' },
    ]);

    renderPage();
    await screen.findByText('Email');

    fireEvent.change(screen.getByPlaceholderText(/filter by title/i), { target: { value: 'bank' } });

    expect(screen.queryByText('Email')).toBeNull();
    expect(screen.getByText('Bank')).toBeTruthy();
    expect(listCredentials).toHaveBeenCalledTimes(1);
  });

  it('adding a credential encrypts the password client-side before it is ever sent — never plaintext on the wire', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listCredentials.mockResolvedValueOnce([]);
    encryptField.mockResolvedValueOnce('CIPHERTEXT==');
    addCredential.mockResolvedValueOnce({
      itemId: 'new-1',
      title: 'New site',
      url: '',
      username: '',
      encryptedPassword: 'CIPHERTEXT==',
    });

    renderPage();
    await screen.findByText(/vault is empty/i);

    fireEvent.click(screen.getByRole('button', { name: /add credential/i }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New site' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'super-secret-plaintext' } });
    fireEvent.click(screen.getByRole('button', { name: /save credential/i }));

    await waitFor(() => expect(addCredential).toHaveBeenCalledTimes(1));

    expect(encryptField).toHaveBeenCalledWith(FAKE_KEY, 'super-secret-plaintext');
    const [payload] = addCredential.mock.calls[0];
    expect(payload.encryptedPassword).toBe('CIPHERTEXT==');
    // The actual request body sent must never contain the plaintext.
    expect(JSON.stringify(payload)).not.toContain('super-secret-plaintext');
  });

  it('view: fetches the single item, masks the password by default, and decrypts only on reveal', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    const item = {
      itemId: 'i1',
      title: 'Email',
      url: 'https://mail.example.com',
      username: 'me',
      encryptedPassword: 'CIPHER1==',
    };
    listCredentials.mockResolvedValueOnce([item]);
    getCredential.mockResolvedValueOnce(item);
    // First call is the mount-time health analysis decrypting this same
    // item; the second is the user's explicit reveal.
    decryptField.mockResolvedValueOnce('irrelevant-for-analysis').mockResolvedValueOnce('hunter2');

    renderPage();
    await screen.findByText('Email');

    fireEvent.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => expect(getCredential).toHaveBeenCalledWith('i1'));

    expect(await screen.findByDisplayValue('••••••••••••')).toBeTruthy();
    await waitFor(() => expect(decryptField).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /reveal/i }));

    await waitFor(() => expect(decryptField).toHaveBeenCalledTimes(2));
    expect(decryptField).toHaveBeenLastCalledWith(FAKE_KEY, 'CIPHER1==');
    expect(await screen.findByDisplayValue('hunter2')).toBeTruthy();
  });

  it('view: shows a decrypt-failure message rather than garbage when decryptField throws', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    const item = { itemId: 'i1', title: 'Email', url: '', username: '', encryptedPassword: 'CIPHER1==' };
    listCredentials.mockResolvedValueOnce([item]);
    getCredential.mockResolvedValueOnce(item);
    // Analysis's own decrypt call succeeds (or fails — either way it is
    // swallowed internally); the user's explicit reveal is the one that
    // throws and must be surfaced.
    decryptField.mockResolvedValueOnce('irrelevant-for-analysis').mockRejectedValueOnce(new Error('OperationError'));

    renderPage();
    await screen.findByText('Email');
    fireEvent.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => expect(getCredential).toHaveBeenCalled());
    await waitFor(() => expect(decryptField).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /reveal/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/unable to decrypt/i);
    expect(screen.queryByDisplayValue('OperationError')).toBeNull();
  });

  it('view: copy writes the revealed password to the clipboard and auto-clears it after 30s, only if unchanged', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    const item = { itemId: 'i1', title: 'Email', url: '', username: '', encryptedPassword: 'CIPHER1==' };
    listCredentials.mockResolvedValueOnce([item]);
    getCredential.mockResolvedValueOnce(item);
    decryptField.mockResolvedValueOnce('irrelevant-for-analysis').mockResolvedValueOnce('hunter2');

    renderPage();
    await screen.findByText('Email');
    fireEvent.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => expect(getCredential).toHaveBeenCalled());
    await waitFor(() => expect(decryptField).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /reveal/i }));
    await screen.findByDisplayValue('hunter2');

    vi.useFakeTimers();
    window.navigator.clipboard.readText.mockResolvedValue('hunter2');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith('hunter2');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });

    // Only cleared because the clipboard still held the exact value copied.
    expect(window.navigator.clipboard.writeText).toHaveBeenLastCalledWith('');
  });

  it('view: does not clobber the clipboard on auto-clear if the user copied something else meanwhile', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    const item = { itemId: 'i1', title: 'Email', url: '', username: '', encryptedPassword: 'CIPHER1==' };
    listCredentials.mockResolvedValueOnce([item]);
    getCredential.mockResolvedValueOnce(item);
    decryptField.mockResolvedValueOnce('irrelevant-for-analysis').mockResolvedValueOnce('hunter2');

    renderPage();
    await screen.findByText('Email');
    fireEvent.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => expect(getCredential).toHaveBeenCalled());
    await waitFor(() => expect(decryptField).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /reveal/i }));
    await screen.findByDisplayValue('hunter2');

    vi.useFakeTimers();
    // Something else now sits on the clipboard by the time the timer fires.
    window.navigator.clipboard.readText.mockResolvedValue('something-else');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));
      await vi.advanceTimersByTimeAsync(30000);
    });

    expect(window.navigator.clipboard.writeText).not.toHaveBeenLastCalledWith('');
  });

  it('view: copies the password while it is still masked, without revealing it', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    const item = { itemId: 'i1', title: 'Email', url: '', username: '', encryptedPassword: 'CIPHER1==' };
    listCredentials.mockResolvedValueOnce([item]);
    getCredential.mockResolvedValueOnce(item);
    // #1 is the mount-time analysis decrypt; #2 is the on-demand decrypt the
    // Copy button performs even though Reveal was never clicked.
    decryptField.mockResolvedValueOnce('irrelevant-for-analysis').mockResolvedValueOnce('hunter2');

    renderPage();
    await screen.findByText('Email');
    fireEvent.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => expect(getCredential).toHaveBeenCalled());
    await waitFor(() => expect(decryptField).toHaveBeenCalledTimes(1));

    // Copy without ever revealing.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));
    });

    expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith('hunter2');
    // The field stays masked — copying must never force the secret on screen.
    expect(screen.getByDisplayValue('••••••••••••')).toBeTruthy();
    expect(screen.queryByDisplayValue('hunter2')).toBeNull();
  });

  it('view: reveal then hide masks the password again (toggle), without re-decrypting', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    const item = { itemId: 'i1', title: 'Email', url: '', username: '', encryptedPassword: 'CIPHER1==' };
    listCredentials.mockResolvedValueOnce([item]);
    getCredential.mockResolvedValueOnce(item);
    decryptField.mockResolvedValueOnce('irrelevant-for-analysis').mockResolvedValueOnce('hunter2');

    renderPage();
    await screen.findByText('Email');
    fireEvent.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => expect(decryptField).toHaveBeenCalledTimes(1));

    // Reveal → shows plaintext (decrypt #2).
    fireEvent.click(screen.getByRole('button', { name: /reveal/i }));
    expect(await screen.findByDisplayValue('hunter2')).toBeTruthy();
    await waitFor(() => expect(decryptField).toHaveBeenCalledTimes(2));

    // Hide → masks again.
    fireEvent.click(screen.getByRole('button', { name: /hide/i }));
    expect(await screen.findByDisplayValue('••••••••••••')).toBeTruthy();

    // Reveal again → reuses the cached plaintext, no third decrypt call.
    fireEvent.click(screen.getByRole('button', { name: /reveal/i }));
    expect(await screen.findByDisplayValue('hunter2')).toBeTruthy();
    expect(decryptField).toHaveBeenCalledTimes(2);
  });

  it('edit: only sends encryptedPassword when a new password was typed', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    const item = {
      itemId: 'i1',
      title: 'Email',
      url: 'https://mail.example.com',
      username: 'me',
      encryptedPassword: 'CIPHER1==',
    };
    listCredentials.mockResolvedValueOnce([item]);
    updateCredential.mockResolvedValueOnce({ ...item, title: 'Email (personal)' });

    renderPage();
    await screen.findByText('Email');

    fireEvent.click(screen.getByRole('button', { name: /edit email/i }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Email (personal)' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateCredential).toHaveBeenCalledTimes(1));
    expect(updateCredential).toHaveBeenCalledWith('i1', {
      title: 'Email (personal)',
      url: 'https://mail.example.com',
      username: 'me',
    });
    expect(encryptField).not.toHaveBeenCalled();
  });

  it('edit: re-encrypts and sends encryptedPassword when a new password is typed', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    const item = {
      itemId: 'i1',
      title: 'Email',
      url: 'https://mail.example.com',
      username: 'me',
      encryptedPassword: 'CIPHER1==',
    };
    listCredentials.mockResolvedValueOnce([item]);
    encryptField.mockResolvedValueOnce('NEWCIPHER==');
    updateCredential.mockResolvedValueOnce({ ...item, encryptedPassword: 'NEWCIPHER==' });

    renderPage();
    await screen.findByText('Email');

    fireEvent.click(screen.getByRole('button', { name: /edit email/i }));
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'brand-new-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateCredential).toHaveBeenCalledTimes(1));
    expect(encryptField).toHaveBeenCalledWith(FAKE_KEY, 'brand-new-secret');
    const [, patchBody] = updateCredential.mock.calls[0];
    expect(patchBody.encryptedPassword).toBe('NEWCIPHER==');
    expect(JSON.stringify(patchBody)).not.toContain('brand-new-secret');
  });

  it('edit: does not decrypt the existing password unless the user explicitly reveals it', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    const item = { itemId: 'i1', title: 'Email', url: '', username: '', encryptedPassword: 'CIPHER1==' };
    listCredentials.mockResolvedValueOnce([item]);

    renderPage();
    await screen.findByText('Email');
    fireEvent.click(screen.getByRole('button', { name: /edit email/i }));

    const currentPasswordInput = await screen.findByLabelText(/current password/i);
    expect(currentPasswordInput.value).toBe('••••••••••••');
    // Only the mount-time health analysis decrypted this item — the edit
    // form's "reveal existing" was never clicked.
    await waitFor(() => expect(decryptField).toHaveBeenCalledTimes(1));
  });

  it('delete: requires an explicit confirmation before calling the API', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    const item = { itemId: 'i1', title: 'Email', url: '', username: '', encryptedPassword: 'C1' };
    listCredentials.mockResolvedValueOnce([item]);

    renderPage();
    await screen.findByText('Email');

    fireEvent.click(screen.getByRole('button', { name: /delete email/i }));
    expect(deleteCredential).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();

    deleteCredential.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(deleteCredential).toHaveBeenCalledWith('i1'));
  });

  it('delete: canceling the confirmation never calls the API', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    const item = { itemId: 'i1', title: 'Email', url: '', username: '', encryptedPassword: 'C1' };
    listCredentials.mockResolvedValueOnce([item]);

    renderPage();
    await screen.findByText('Email');

    fireEvent.click(screen.getByRole('button', { name: /delete email/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(deleteCredential).not.toHaveBeenCalled();
  });

  // PRD 0021 — password generator + live strength meter. generatePassword and
  // scorePasswordStrength are real (not mocked): they are pure, side-effect
  // free, and their own dedicated unit tests already cover the crypto and
  // scoring in depth — here we only need to confirm the screen wires them up.
  it('add: generating a password fills the field, reveals it, and shows a strength meter', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listCredentials.mockResolvedValueOnce([]);

    renderPage();
    await screen.findByText(/vault is empty/i);

    fireEvent.click(screen.getByRole('button', { name: /add credential/i }));
    expect(screen.queryByTestId('add-password-strength')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /generate strong password/i }));

    const passwordInput = screen.getByLabelText('Password');
    expect(passwordInput.value.length).toBeGreaterThan(0);
    expect(passwordInput.type).toBe('text'); // revealed after generating

    expect(screen.getByTestId('add-password-strength')).toBeTruthy();
  });

  it('add: the strength meter updates as the user types', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listCredentials.mockResolvedValueOnce([]);

    renderPage();
    await screen.findByText(/vault is empty/i);
    fireEvent.click(screen.getByRole('button', { name: /add credential/i }));

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'aaaa' } });
    expect(screen.getByText('Weak')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Tr7$kL9!qWbZx2#Q' } });
    expect(screen.getByText('Strong')).toBeTruthy();
  });

  it('edit: generating a new password fills the field and shows a strength meter', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    const item = {
      itemId: 'i1',
      title: 'Email',
      url: 'https://mail.example.com',
      username: 'me',
      encryptedPassword: 'CIPHER1==',
    };
    listCredentials.mockResolvedValueOnce([item]);

    renderPage();
    await screen.findByText('Email');
    fireEvent.click(screen.getByRole('button', { name: /edit email/i }));

    expect(screen.queryByTestId('edit-password-strength')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /generate strong password/i }));

    const newPasswordInput = screen.getByLabelText('New password');
    expect(newPasswordInput.value.length).toBeGreaterThan(0);
    expect(newPasswordInput.type).toBe('text');
    expect(screen.getByTestId('edit-password-strength')).toBeTruthy();
  });
});

describe('Credentials screen — password health badges (PRD 0022)', () => {
  function itemsFixture() {
    return [
      { itemId: 'i1', title: 'Email', url: '', username: 'me', encryptedPassword: 'CIPHER-REUSED-A' },
      { itemId: 'i2', title: 'Bank', url: '', username: 'me', encryptedPassword: 'CIPHER-REUSED-B' },
      { itemId: 'i3', title: 'Forum', url: '', username: 'me', encryptedPassword: 'CIPHER-WEAK' },
      { itemId: 'i4', title: 'Work VPN', url: '', username: 'me', encryptedPassword: 'CIPHER-STRONG' },
    ];
  }

  // Deterministic ciphertext -> plaintext mapping, independent of call order
  // — i1 and i2 share a password (REUSED), i3 is short (WEAK), i4 is long
  // and varied (OK).
  function wirePlaintextMap() {
    const plaintextByCiphertext = {
      'CIPHER-REUSED-A': 'same-Secret1!',
      'CIPHER-REUSED-B': 'same-Secret1!',
      'CIPHER-WEAK': 'abcd',
      'CIPHER-STRONG': 'Tr7$kL9!qWbZx2#Q',
    };
    decryptField.mockImplementation(async (_key, ciphertext) => plaintextByCiphertext[ciphertext]);
  }

  it('decrypts every item on mount, submits the computed report, and colors rows by finding', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listCredentials.mockResolvedValueOnce(itemsFixture());
    wirePlaintextMap();

    renderPage();
    await screen.findByText('Email');

    await waitFor(() => expect(submitHealthReport).toHaveBeenCalledTimes(1));
    const [report] = submitHealthReport.mock.calls[0];
    const byId = Object.fromEntries(report.findings.map((f) => [f.itemId, f.status]));
    expect(byId).toEqual({ i1: 'REUSED', i2: 'REUSED', i3: 'WEAK', i4: 'OK' });
    // round(100 * 1 / 4) = 25
    expect(report.overallScore).toBe(25);

    const reusedRow = screen.getByText('Email').closest('tr');
    const weakRow = screen.getByText('Forum').closest('tr');
    const okRow = screen.getByText('Work VPN').closest('tr');

    expect(reusedRow.className).toMatch(/bg-danger-subtle/);
    expect(weakRow.className).toMatch(/bg-warning-subtle/);
    expect(okRow.className).not.toMatch(/bg-danger-subtle|bg-warning-subtle/);
  });

  it('excludes an item whose ciphertext fails to decrypt instead of aborting analysis for the whole vault', async () => {
    // Regression test: a single foreign/legacy ciphertext (e.g. seed data
    // never actually produced by vault-crypto.js) must not poison every
    // other item's badge via an all-or-nothing Promise.all rejection.
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listCredentials.mockResolvedValueOnce(itemsFixture());
    const plaintextByCiphertext = {
      'CIPHER-REUSED-A': 'same-Secret1!',
      'CIPHER-REUSED-B': 'same-Secret1!',
      'CIPHER-WEAK': 'abcd',
    };
    decryptField.mockImplementation(async (_key, ciphertext) => {
      if (ciphertext === 'CIPHER-STRONG') {
        throw new Error('OperationError');
      }
      return plaintextByCiphertext[ciphertext];
    });

    renderPage();
    await screen.findByText('Email');

    await waitFor(() => expect(submitHealthReport).toHaveBeenCalledTimes(1));
    const [report] = submitHealthReport.mock.calls[0];
    const byId = Object.fromEntries(report.findings.map((f) => [f.itemId, f.status]));
    // i4 (the undecryptable one) is excluded entirely — not present, not
    // miscounted as OK or WEAK — rather than the whole call throwing and
    // leaving healthFindings/submitHealthReport untouched.
    expect(byId).toEqual({ i1: 'REUSED', i2: 'REUSED', i3: 'WEAK' });
    expect(byId.i4).toBeUndefined();
    // round(100 * 0 / 3) = 0 — the three analyzable items are all flagged.
    expect(report.overallScore).toBe(0);
  });

  it('does not attempt analysis or submit a report for an empty vault', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listCredentials.mockResolvedValueOnce([]);

    renderPage();
    await screen.findByText(/vault is empty/i);

    expect(decryptField).not.toHaveBeenCalled();
    expect(submitHealthReport).not.toHaveBeenCalled();
  });

  it('re-runs analysis after a credential is deleted', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listCredentials.mockResolvedValueOnce(itemsFixture());
    wirePlaintextMap();
    deleteCredential.mockResolvedValueOnce(null);

    renderPage();
    await screen.findByText('Email');
    await waitFor(() => expect(submitHealthReport).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /delete bank/i }));
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(deleteCredential).toHaveBeenCalledWith('i2'));
    // Removing i2 resolves i1's reuse pairing — analysis reran with the
    // remaining three items.
    await waitFor(() => expect(submitHealthReport).toHaveBeenCalledTimes(2));
    const [secondReport] = submitHealthReport.mock.calls[1];
    const byId = Object.fromEntries(secondReport.findings.map((f) => [f.itemId, f.status]));
    expect(byId).toEqual({ i1: 'OK', i3: 'WEAK', i4: 'OK' });
  });

  it('opens the credential named by router state (the "Fix now" deep link) once the list loads', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    const item = itemsFixture()[2]; // Forum, the weak one
    listCredentials.mockResolvedValueOnce(itemsFixture());
    wirePlaintextMap();
    getCredential.mockResolvedValueOnce(item);

    renderPage({ state: { openItemId: 'i3' } });

    await waitFor(() => expect(getCredential).toHaveBeenCalledWith('i3'));
    // The View modal opened (masked password field rendered) for the item
    // named by the deep link, without the user clicking anything.
    expect(await screen.findByDisplayValue('••••••••••••')).toBeTruthy();
  });
});
