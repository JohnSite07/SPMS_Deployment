// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

// The vault key is real (vault-key-store.js is trivial in-memory state, no
// crypto), but encryption/decryption and the network layer are mocked so
// this suite exercises the SCREEN only (PRD 0019) — the real crypto
// round-trip is covered by vault-crypto.test.js, and the real request
// shapes by credentials-service.test.js.
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

import {
  listCredentials,
  getCredential,
  addCredential,
  updateCredential,
  deleteCredential,
} from '../../services/credentials-service';
import { encryptField, decryptField } from '../../services/vault-crypto';
import * as vaultKeyStore from '../../services/vault-key-store.js';
import Credentials from '../Credentials.jsx';

const FAKE_KEY = { algorithm: { name: 'AES-GCM' } };

function renderPage() {
  return render(<Credentials />);
}

beforeEach(() => {
  listCredentials.mockReset();
  getCredential.mockReset();
  addCredential.mockReset();
  updateCredential.mockReset();
  deleteCredential.mockReset();
  encryptField.mockReset();
  decryptField.mockReset();
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
    expect(decryptField).not.toHaveBeenCalled();
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
    decryptField.mockResolvedValueOnce('hunter2');

    renderPage();
    await screen.findByText('Email');

    fireEvent.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => expect(getCredential).toHaveBeenCalledWith('i1'));

    expect(await screen.findByDisplayValue('••••••••••••')).toBeTruthy();
    expect(decryptField).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /reveal/i }));

    await waitFor(() => expect(decryptField).toHaveBeenCalledWith(FAKE_KEY, 'CIPHER1=='));
    expect(await screen.findByDisplayValue('hunter2')).toBeTruthy();
  });

  it('view: shows a decrypt-failure message rather than garbage when decryptField throws', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    const item = { itemId: 'i1', title: 'Email', url: '', username: '', encryptedPassword: 'CIPHER1==' };
    listCredentials.mockResolvedValueOnce([item]);
    getCredential.mockResolvedValueOnce(item);
    decryptField.mockRejectedValueOnce(new Error('OperationError'));

    renderPage();
    await screen.findByText('Email');
    fireEvent.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => expect(getCredential).toHaveBeenCalled());

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
    decryptField.mockResolvedValueOnce('hunter2');

    renderPage();
    await screen.findByText('Email');
    fireEvent.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => expect(getCredential).toHaveBeenCalled());
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
    decryptField.mockResolvedValueOnce('hunter2');

    renderPage();
    await screen.findByText('Email');
    fireEvent.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => expect(getCredential).toHaveBeenCalled());
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
    expect(decryptField).not.toHaveBeenCalled();
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
});
