// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// document-crypto/vault-crypto stay real here (no crypto is actually
// exercised by this screen's mocked service calls) — only document-service's
// network-facing functions are mocked, mirroring how Credentials.test.jsx
// mocks credentials-service but keeps vault-key-store real (trivial
// in-memory state, no crypto). UnsupportedFileError is kept real (via
// importActual) so `err instanceof UnsupportedFileError` in Documents.jsx
// still matches errors thrown by the mocked uploadDocument.
vi.mock('../../services/document-service', async () => {
  const actual = await vi.importActual('../../services/document-service');
  return {
    ...actual,
    listDocuments: vi.fn(),
    uploadDocument: vi.fn(),
    downloadDocument: vi.fn(),
    deleteDocument: vi.fn(),
  };
});

import {
  listDocuments,
  uploadDocument,
  downloadDocument,
  deleteDocument,
  UnsupportedFileError,
} from '../../services/document-service';
import * as vaultKeyStore from '../../services/vault-key-store.js';
import Documents from '../Documents.jsx';

const FAKE_KEY = { algorithm: { name: 'AES-GCM' } };

function renderPage() {
  return render(
    <MemoryRouter>
      <Documents />
    </MemoryRouter>
  );
}

beforeEach(() => {
  listDocuments.mockReset();
  uploadDocument.mockReset();
  downloadDocument.mockReset();
  deleteDocument.mockReset();
  vaultKeyStore.clear();

  // jsdom does not implement the Blob-URL / anchor-download machinery real
  // browsers do — stub just enough of it so the download flow's "trigger a
  // save" step doesn't throw, without faking the actual decrypt/service call.
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  globalThis.URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Documents screen (PRD 0025)', () => {
  it('shows a guard message and never fetches when there is no vault key in memory', () => {
    renderPage();

    expect(screen.getByRole('alert').textContent).toMatch(/log out and log back in/i);
    expect(listDocuments).not.toHaveBeenCalled();
  });

  it('fetches and renders the stored documents list — metadata only', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listDocuments.mockResolvedValueOnce([
      { itemId: 'd1', fileName: 'passport.pdf', fileType: 'application/pdf', fileSizeKb: 512, createdAt: '2026-01-02T00:00:00Z' },
      { itemId: 'd2', fileName: 'photo.png', fileType: 'image/png', fileSizeKb: 2048, createdAt: '2026-01-01T00:00:00Z' },
    ]);

    renderPage();

    expect(await screen.findByText('passport.pdf')).toBeTruthy();
    expect(screen.getByText('photo.png')).toBeTruthy();
    expect(screen.getAllByText('Encrypted')).toHaveLength(2);
    expect(screen.getByText('512 KB')).toBeTruthy();
    expect(screen.getByText('2.0 MB')).toBeTruthy();
  });

  it('shows the empty state when there are no stored documents', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listDocuments.mockResolvedValueOnce([]);

    renderPage();

    expect(await screen.findByText(/no documents stored yet/i)).toBeTruthy();
  });

  it('shows a load error when the list call fails', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listDocuments.mockRejectedValueOnce(new Error('network down'));

    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/unable to load your documents/i);
  });

  it('upload: selecting a valid file encrypts+uploads it and adds it to the list', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listDocuments.mockResolvedValueOnce([]);
    uploadDocument.mockResolvedValueOnce({
      itemId: 'd1',
      fileName: 'passport.pdf',
      fileType: 'application/pdf',
      fileSizeKb: 10,
      createdAt: '2026-01-01T00:00:00Z',
    });

    renderPage();
    await screen.findByText(/no documents stored yet/i);

    const file = new File(['hello'], 'passport.pdf', { type: 'application/pdf' });
    const input = screen.getByLabelText(/choose a file to upload/i);
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(1));
    expect(uploadDocument).toHaveBeenCalledWith({ file });
    expect(await screen.findByText('passport.pdf')).toBeTruthy();
  });

  it('upload: a rejected file shows the exact rejection message and never adds it to the list', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listDocuments.mockResolvedValueOnce([]);
    uploadDocument.mockRejectedValueOnce(
      new UnsupportedFileError('Unsupported type or over 10 MB is rejected. Choose a PDF, PNG, or JPEG file.')
    );

    renderPage();
    await screen.findByText(/no documents stored yet/i);

    const file = new File(['x'], 'malware.exe', { type: 'application/x-msdownload' });
    const input = screen.getByLabelText(/choose a file to upload/i);
    fireEvent.change(input, { target: { files: [file] } });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/unsupported type or over 10 mb/i);
    expect(screen.queryByText('malware.exe')).toBeNull();
  });

  it('download: fetches and decrypts the document, then triggers a save — only on explicit click', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listDocuments.mockResolvedValueOnce([
      { itemId: 'd1', fileName: 'passport.pdf', fileType: 'application/pdf', fileSizeKb: 10, createdAt: '2026-01-01T00:00:00Z' },
    ]);
    const blob = new Blob(['decrypted-bytes'], { type: 'application/pdf' });
    downloadDocument.mockResolvedValueOnce({ blob, fileName: 'passport.pdf' });

    renderPage();
    await screen.findByText('passport.pdf');

    // Never decrypted just by listing/rendering — only the explicit click.
    expect(downloadDocument).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /download passport\.pdf/i }));

    await waitFor(() =>
      expect(downloadDocument).toHaveBeenCalledWith('d1', { fileName: 'passport.pdf', fileType: 'application/pdf' })
    );
    await waitFor(() => expect(globalThis.URL.createObjectURL).toHaveBeenCalledWith(blob));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('download: shows an error message rather than crashing when decrypt/fetch fails', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listDocuments.mockResolvedValueOnce([
      { itemId: 'd1', fileName: 'passport.pdf', fileType: 'application/pdf', fileSizeKb: 10, createdAt: '2026-01-01T00:00:00Z' },
    ]);
    downloadDocument.mockRejectedValueOnce(new Error('OperationError'));

    renderPage();
    await screen.findByText('passport.pdf');

    fireEvent.click(screen.getByRole('button', { name: /download passport\.pdf/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/unable to download/i);
  });

  it('delete: requires an explicit confirmation before calling the API', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listDocuments.mockResolvedValueOnce([
      { itemId: 'd1', fileName: 'passport.pdf', fileType: 'application/pdf', fileSizeKb: 10, createdAt: '2026-01-01T00:00:00Z' },
    ]);

    renderPage();
    await screen.findByText('passport.pdf');

    fireEvent.click(screen.getByRole('button', { name: /delete passport\.pdf/i }));
    expect(deleteDocument).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();

    deleteDocument.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith('d1'));
    await waitFor(() => expect(screen.queryByText('passport.pdf')).toBeNull());
  });

  it('delete: canceling the confirmation never calls the API', async () => {
    vaultKeyStore.setVaultKey(FAKE_KEY);
    listDocuments.mockResolvedValueOnce([
      { itemId: 'd1', fileName: 'passport.pdf', fileType: 'application/pdf', fileSizeKb: 10, createdAt: '2026-01-01T00:00:00Z' },
    ]);

    renderPage();
    await screen.findByText('passport.pdf');

    fireEvent.click(screen.getByRole('button', { name: /delete passport\.pdf/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(deleteDocument).not.toHaveBeenCalled();
  });
});
