import { useEffect, useRef, useState } from 'react';
import { Container, Form, Button, Alert, Spinner, Table, Modal, Badge } from 'react-bootstrap';
import { listDocuments, uploadDocument, downloadDocument, deleteDocument, UnsupportedFileError } from '../services/document-service';
import { MissingVaultKeyError } from '../services/document-crypto';
import * as vaultKeyStore from '../services/vault-key-store';

// UC-04 Store Sensitive Document (PRD 0025) — full build, replacing the
// one-line placeholder. This is the Secure Documents screen from Figure 13:
// a drop-zone that states the PDF/image, 10 MB limit up front (error
// prevention), a list of stored documents (metadata only), and download /
// delete actions. Secure-by-default (frontend rule 6): a document's contents
// are only ever decrypted in memory, transiently, on an explicit download
// click — the list itself never touches plaintext.
//
// Mirrors Credentials.jsx's structure (the same hasKey guard, list/loading/
// error states, and confirm-before-delete modal) rather than inventing a new
// pattern for this screen.

const GENERIC_LOAD_ERROR = 'Unable to load your documents. Please try again.';
const GENERIC_DOWNLOAD_ERROR = 'Unable to download this document. Please try again.';
const GENERIC_DELETE_ERROR = 'Unable to delete this document. Please try again.';
const MISSING_KEY_ERROR = 'Your vault key isn’t available in this session. Please log out and log back in to unlock your vault.';

const FILE_TYPE_LABELS = {
  'application/pdf': 'PDF',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
};

function fileTypeLabel(mimeType) {
  return FILE_TYPE_LABELS[mimeType] ?? mimeType;
}

function formatSize(fileSizeKb) {
  if (typeof fileSizeKb !== 'number') {
    return '—';
  }
  if (fileSizeKb >= 1024) {
    return `${(fileSizeKb / 1024).toFixed(1)} MB`;
  }
  return `${fileSizeKb} KB`;
}

function formatDate(createdAt) {
  if (!createdAt) {
    return '—';
  }
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString();
}

// Triggers a browser "Save As" for the given Blob using a throwaway <a>
// element — the standard client-side download trick, no extra dependency.
function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName || 'document';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function Documents() {
  // Same guard as Credentials.jsx: a hard refresh lands here with a live
  // session token but no in-memory vault key (never persisted, by design —
  // see vault-key-store.js), and there is no password available to
  // re-derive it from, so the only correct move is to send the user back
  // through login rather than guess or crash.
  const [hasKey] = useState(() => vaultKeyStore.hasVaultKey());

  const [items, setItems] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);

  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const [downloadingId, setDownloadingId] = useState(null);
  const [downloadError, setDownloadError] = useState(null);

  const [showDelete, setShowDelete] = useState(false);
  const [deleteItem, setDeleteItem] = useState(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  useEffect(() => {
    if (!hasKey) {
      setListLoading(false);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await listDocuments();
        if (!cancelled) {
          setItems(Array.isArray(data) ? data : []);
        }
      } catch {
        if (!cancelled) {
          setListError(GENERIC_LOAD_ERROR);
        }
      } finally {
        if (!cancelled) {
          setListLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasKey]);

  // Validates, encrypts, and uploads the first selected/dropped file. Errors
  // from validation (wrong type / too big) are surfaced with the exact
  // rejection wording the wireframe calls for; anything else (network,
  // missing vault key) gets a generic message.
  async function handleFiles(fileList) {
    const file = fileList?.[0];
    if (!file) {
      return;
    }
    setUploadError(null);
    setUploading(true);
    try {
      const created = await uploadDocument({ file });
      setItems((prev) => [created, ...prev]);
    } catch (err) {
      if (err instanceof UnsupportedFileError) {
        setUploadError(err.message);
      } else if (err instanceof MissingVaultKeyError) {
        setUploadError(MISSING_KEY_ERROR);
      } else {
        setUploadError('Unable to upload this document. Please try again.');
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragActive(false);
    handleFiles(event.dataTransfer?.files);
  }

  async function handleDownload(item) {
    setDownloadError(null);
    setDownloadingId(item.itemId);
    try {
      const { blob, fileName } = await downloadDocument(item.itemId, {
        fileName: item.fileName,
        fileType: item.fileType,
      });
      saveBlob(blob, fileName);
    } catch (err) {
      setDownloadError(err instanceof MissingVaultKeyError ? MISSING_KEY_ERROR : GENERIC_DOWNLOAD_ERROR);
    } finally {
      setDownloadingId(null);
    }
  }

  function openDelete(item) {
    setDeleteItem(item);
    setDeleteError(null);
    setShowDelete(true);
  }

  async function handleConfirmDelete() {
    if (!deleteItem || deleteSubmitting) {
      return;
    }
    setDeleteSubmitting(true);
    setDeleteError(null);
    try {
      await deleteDocument(deleteItem.itemId);
      setItems((prev) => prev.filter((it) => it.itemId !== deleteItem.itemId));
      setShowDelete(false);
    } catch {
      setDeleteError(GENERIC_DELETE_ERROR);
    } finally {
      setDeleteSubmitting(false);
    }
  }

  if (!hasKey) {
    return (
      <Container className="py-4">
        <Alert variant="warning" role="alert">
          {MISSING_KEY_ERROR}
        </Alert>
      </Container>
    );
  }

  return (
    <Container className="py-4">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="h4 mb-0">Secure documents</h2>
      </div>

      {/* Drop-zone: file type/size limits stated up front (error prevention). */}
      <Form.Group controlId="documents-upload-input" className="mb-1">
        <Form.Label className="visually-hidden">Choose a file to upload</Form.Label>
        <div
          className={`border rounded-3 p-4 text-center mb-1 ${dragActive ? 'border-primary bg-primary-subtle' : 'bg-white'}`}
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              fileInputRef.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
        >
          <p className="mb-1 fw-semibold">Drag a file here, or click to browse</p>
          <p className="text-muted small mb-0">PDF or image · up to 10 MB</p>
          <Form.Control
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            className="d-none"
            disabled={uploading}
            onChange={(event) => handleFiles(event.target.files)}
          />
          {uploading && (
            <div className="mt-3">
              <Spinner as="span" animation="border" size="sm" role="status" className="me-2" />
              Encrypting and uploading…
            </div>
          )}
        </div>
      </Form.Group>
      <p className="text-muted small mb-3">Every file is AES-256 encrypted before it leaves this page.</p>

      {uploadError && (
        <Alert variant="danger" role="alert">
          {uploadError}
        </Alert>
      )}
      {downloadError && (
        <Alert variant="danger" role="alert">
          {downloadError}
        </Alert>
      )}
      {listError && (
        <Alert variant="danger" role="alert">
          {listError}
        </Alert>
      )}

      {listLoading ? (
        <div className="d-flex justify-content-center py-5">
          <Spinner animation="border" role="status" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-muted">No documents stored yet. Upload your first file to get started.</p>
      ) : (
        <Table hover responsive className="bg-white">
          <thead>
            <tr>
              <th>File</th>
              <th>Type</th>
              <th>Size</th>
              <th>Uploaded</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.itemId}>
                <td>
                  {item.fileName} <Badge bg="secondary">Encrypted</Badge>
                </td>
                <td>{fileTypeLabel(item.fileType)}</td>
                <td>{formatSize(item.fileSizeKb)}</td>
                <td>{formatDate(item.createdAt)}</td>
                <td className="text-end">
                  <Button
                    variant="outline-secondary"
                    size="sm"
                    className="me-2"
                    onClick={() => handleDownload(item)}
                    disabled={downloadingId === item.itemId}
                    aria-label={`Download ${item.fileName}`}
                  >
                    {downloadingId === item.itemId ? (
                      <Spinner as="span" animation="border" size="sm" role="status" />
                    ) : (
                      'Download'
                    )}
                  </Button>
                  <Button
                    variant="outline-danger"
                    size="sm"
                    onClick={() => openDelete(item)}
                    aria-label={`Delete ${item.fileName}`}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* Delete confirmation */}
      <Modal show={showDelete} onHide={() => setShowDelete(false)} centered>
        <Modal.Header closeButton>
          <Modal.Title>Delete document</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {deleteError && (
            <Alert variant="danger" role="alert">
              {deleteError}
            </Alert>
          )}
          <p className="mb-0">
            Are you sure you want to delete <strong>{deleteItem?.fileName}</strong>? This cannot be undone.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => setShowDelete(false)} disabled={deleteSubmitting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleConfirmDelete} disabled={deleteSubmitting}>
            {deleteSubmitting ? (
              <>
                <Spinner as="span" animation="border" size="sm" role="status" className="me-2" />
                Deleting…
              </>
            ) : (
              'Delete'
            )}
          </Button>
        </Modal.Footer>
      </Modal>
    </Container>
  );
}
