import { useEffect, useRef, useState } from 'react';
import { Container, Form, Button, Alert, Spinner, InputGroup, Modal, Table } from 'react-bootstrap';
import {
  listCredentials,
  getCredential,
  addCredential,
  updateCredential,
  deleteCredential,
} from '../services/credentials-service';
import { encryptField, decryptField } from '../services/vault-crypto';
import * as vaultKeyStore from '../services/vault-key-store';

// UC-02 (add) / UC-03 (view/retrieve) Credential Vault — PRD 0019's full
// build, replacing the one-line placeholder. This is the first screen that
// actually exercises vault-crypto.js: the list shows only plaintext metadata
// (title/url/username, never decrypted here — there is nothing to decrypt,
// see the comment below), Add encrypts a typed password client-side before
// it is ever sent, and View/Edit decrypt the stored ciphertext on demand,
// only when the user explicitly asks to see it (frontend rule 6, "secure by
// default").
//
// A credential's title/url/username are not the zero-knowledge boundary —
// only `encryptedPassword` is ciphertext (see routes/credentials.js's
// MUTABLE_FIELDS and its header comment). The vault key is only ever needed
// to encrypt a new/changed password, or decrypt an existing one on reveal.

const CLIPBOARD_CLEAR_MS = 30000; // matches TwoFactorSetup.jsx's precedent.
const DECRYPT_FAILURE_MESSAGE = 'Unable to decrypt this password.';
const GENERIC_LOAD_ERROR = 'Unable to load your vault. Please try again.';
const GENERIC_SAVE_ERROR = 'Unable to save this credential. Please try again.';
const GENERIC_DELETE_ERROR = 'Unable to delete this credential. Please try again.';

function matchesFilter(item, query) {
  if (!query) {
    return true;
  }
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  return [item.title, item.url, item.username].some((field) => (field ?? '').toLowerCase().includes(q));
}

export default function Credentials() {
  // A hard refresh lands here with a live session token but no in-memory
  // vault key (it is never persisted, by design — see vault-key-store.js).
  // There is no password available to re-derive it from, so the only correct
  // move is to send the user back through login, not guess or fall back.
  const [hasKey] = useState(() => vaultKeyStore.hasVaultKey());

  const [items, setItems] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [filterText, setFilterText] = useState('');

  useEffect(() => {
    if (!hasKey) {
      setListLoading(false);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await listCredentials();
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

  // --- Add -------------------------------------------------------------
  const [showAdd, setShowAdd] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addUsername, setAddUsername] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [addShowPassword, setAddShowPassword] = useState(false);
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState(null);

  function openAdd() {
    setAddTitle('');
    setAddUrl('');
    setAddUsername('');
    setAddPassword('');
    setAddShowPassword(false);
    setAddError(null);
    setShowAdd(true);
  }

  async function handleAddSubmit(event) {
    event.preventDefault();
    if (addSubmitting) {
      return;
    }
    if (!addTitle.trim() || !addPassword) {
      setAddError('Title and password are required.');
      return;
    }
    setAddError(null);
    setAddSubmitting(true);
    try {
      // Encrypted client-side, before it is ever handed to credentials-service
      // — the plaintext password never leaves this function.
      const encryptedPassword = await encryptField(vaultKeyStore.getVaultKey(), addPassword);
      const created = await addCredential({
        title: addTitle,
        url: addUrl,
        username: addUsername,
        encryptedPassword,
      });
      setItems((prev) => [created, ...prev]);
      setShowAdd(false);
    } catch {
      setAddError(GENERIC_SAVE_ERROR);
    } finally {
      setAddSubmitting(false);
    }
  }

  // --- View --------------------------------------------------------------
  const [showView, setShowView] = useState(false);
  const [viewItem, setViewItem] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState(null);
  const [viewRevealed, setViewRevealed] = useState(false);
  const [viewPlaintext, setViewPlaintext] = useState(null);
  const [viewDecryptError, setViewDecryptError] = useState(null);
  const [viewCopied, setViewCopied] = useState(false);
  const viewClipboardTimer = useRef(null);

  useEffect(
    () => () => {
      if (viewClipboardTimer.current) {
        clearTimeout(viewClipboardTimer.current);
      }
    },
    []
  );

  async function openView(item) {
    setViewItem(null);
    setViewError(null);
    setViewRevealed(false);
    setViewPlaintext(null);
    setViewDecryptError(null);
    setViewCopied(false);
    setViewLoading(true);
    setShowView(true);
    try {
      // A fresh single-item GET, not the list's cached copy: this is the call
      // that is audit-logged as CREDENTIAL_RETRIEVED (UC-03) — see
      // routes/credentials.js's comment on why the list route deliberately
      // is not.
      const fresh = await getCredential(item.itemId);
      setViewItem(fresh);
    } catch {
      setViewError(GENERIC_LOAD_ERROR);
    } finally {
      setViewLoading(false);
    }
  }

  async function handleReveal() {
    if (!viewItem) {
      return;
    }
    setViewDecryptError(null);
    try {
      const plaintext = await decryptField(vaultKeyStore.getVaultKey(), viewItem.encryptedPassword);
      setViewPlaintext(plaintext);
      setViewRevealed(true);
    } catch {
      // A GCM auth failure (wrong key, tampered/corrupted ciphertext) is
      // never shown as garbage text — see decryptField's own comment.
      setViewDecryptError(DECRYPT_FAILURE_MESSAGE);
    }
  }

  async function handleCopyPassword() {
    if (!viewPlaintext) {
      return;
    }
    const clipboard = window.navigator?.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      return;
    }
    try {
      await clipboard.writeText(viewPlaintext);
    } catch {
      return;
    }
    setViewCopied(true);
    if (viewClipboardTimer.current) {
      clearTimeout(viewClipboardTimer.current);
    }
    const copiedValue = viewPlaintext;
    viewClipboardTimer.current = setTimeout(async () => {
      try {
        // Only clear the clipboard if it still holds the value we put there
        // — never clobber something the user copied elsewhere meanwhile.
        const current = await clipboard.readText();
        if (current === copiedValue) {
          await clipboard.writeText('');
        }
      } catch {
        // Reading the clipboard back can be denied/unavailable; nothing
        // further to do.
      }
      setViewCopied(false);
    }, CLIPBOARD_CLEAR_MS);
  }

  function openEditFromView() {
    if (viewItem) {
      setShowView(false);
      openEdit(viewItem);
    }
  }

  function openDeleteFromView() {
    if (viewItem) {
      setShowView(false);
      openDelete(viewItem);
    }
  }

  // --- Edit ----------------------------------------------------------
  const [showEdit, setShowEdit] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editUsername, setEditUsername] = useState('');
  const [editNewPassword, setEditNewPassword] = useState('');
  const [editShowNewPassword, setEditShowNewPassword] = useState(false);
  const [editRevealedExisting, setEditRevealedExisting] = useState(false);
  const [editExistingPlaintext, setEditExistingPlaintext] = useState(null);
  const [editDecryptError, setEditDecryptError] = useState(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState(null);

  function openEdit(item) {
    setEditItem(item);
    setEditTitle(item.title ?? '');
    setEditUrl(item.url ?? '');
    setEditUsername(item.username ?? '');
    setEditNewPassword('');
    setEditShowNewPassword(false);
    setEditRevealedExisting(false);
    setEditExistingPlaintext(null);
    setEditDecryptError(null);
    setEditError(null);
    setShowEdit(true);
  }

  async function handleRevealExisting() {
    if (!editItem) {
      return;
    }
    setEditDecryptError(null);
    try {
      const plaintext = await decryptField(vaultKeyStore.getVaultKey(), editItem.encryptedPassword);
      setEditExistingPlaintext(plaintext);
      setEditRevealedExisting(true);
    } catch {
      setEditDecryptError(DECRYPT_FAILURE_MESSAGE);
    }
  }

  async function handleEditSubmit(event) {
    event.preventDefault();
    if (!editItem || editSubmitting) {
      return;
    }
    if (!editTitle.trim()) {
      setEditError('Title is required.');
      return;
    }
    setEditError(null);
    setEditSubmitting(true);
    try {
      const patchFields = { title: editTitle, url: editUrl, username: editUsername };
      // Re-encrypt only if the user actually typed a replacement password —
      // otherwise the existing ciphertext is left untouched.
      if (editNewPassword) {
        patchFields.encryptedPassword = await encryptField(vaultKeyStore.getVaultKey(), editNewPassword);
      }
      const updated = await updateCredential(editItem.itemId, patchFields);
      setItems((prev) => prev.map((it) => (it.itemId === updated.itemId ? updated : it)));
      setShowEdit(false);
    } catch {
      setEditError(GENERIC_SAVE_ERROR);
    } finally {
      setEditSubmitting(false);
    }
  }

  // --- Delete --------------------------------------------------------
  const [showDelete, setShowDelete] = useState(false);
  const [deleteItem, setDeleteItem] = useState(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

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
      await deleteCredential(deleteItem.itemId);
      setItems((prev) => prev.filter((it) => it.itemId !== deleteItem.itemId));
      setShowDelete(false);
    } catch {
      setDeleteError(GENERIC_DELETE_ERROR);
    } finally {
      setDeleteSubmitting(false);
    }
  }

  const filteredItems = items.filter((item) => matchesFilter(item, filterText));

  if (!hasKey) {
    return (
      <Container className="py-4">
        <Alert variant="warning" role="alert">
          Your vault key isn&apos;t available in this session. Please log out and log back in to unlock your vault.
        </Alert>
      </Container>
    );
  }

  return (
    <Container className="py-4">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="h4 mb-0">Your vault</h2>
        <Button variant="primary" onClick={openAdd}>
          Add credential
        </Button>
      </div>

      <Form.Group className="mb-3" controlId="credentials-filter">
        <Form.Control
          type="search"
          placeholder="Filter by title, URL, or username"
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
        />
      </Form.Group>

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
        <p className="text-muted">Your vault is empty. Add your first credential to get started.</p>
      ) : filteredItems.length === 0 ? (
        <p className="text-muted">No credentials match your filter.</p>
      ) : (
        <Table hover responsive className="bg-white">
          <thead>
            <tr>
              <th>Title</th>
              <th>URL</th>
              <th>Username</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((item) => (
              <tr key={item.itemId}>
                <td>
                  <Button variant="link" className="p-0 text-decoration-none" onClick={() => openView(item)}>
                    {item.title}
                  </Button>
                </td>
                <td>{item.url}</td>
                <td>{item.username}</td>
                <td className="text-end">
                  <Button
                    variant="outline-secondary"
                    size="sm"
                    className="me-2"
                    onClick={() => openEdit(item)}
                    aria-label={`Edit ${item.title}`}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="outline-danger"
                    size="sm"
                    onClick={() => openDelete(item)}
                    aria-label={`Delete ${item.title}`}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* Add Credential */}
      <Modal show={showAdd} onHide={() => setShowAdd(false)} centered>
        <Modal.Header closeButton>
          <Modal.Title>Add credential</Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleAddSubmit} noValidate>
          <Modal.Body>
            <fieldset disabled={addSubmitting}>
              {addError && (
                <Alert variant="danger" role="alert">
                  {addError}
                </Alert>
              )}
              <Form.Group className="mb-3" controlId="cred-add-title">
                <Form.Label>Title</Form.Label>
                <Form.Control
                  type="text"
                  value={addTitle}
                  onChange={(event) => setAddTitle(event.target.value)}
                  required
                />
              </Form.Group>
              <Form.Group className="mb-3" controlId="cred-add-url">
                <Form.Label>URL</Form.Label>
                <Form.Control type="text" value={addUrl} onChange={(event) => setAddUrl(event.target.value)} />
              </Form.Group>
              <Form.Group className="mb-3" controlId="cred-add-username">
                <Form.Label>Username</Form.Label>
                <Form.Control
                  type="text"
                  value={addUsername}
                  onChange={(event) => setAddUsername(event.target.value)}
                />
              </Form.Group>
              <Form.Group className="mb-3" controlId="cred-add-password">
                <Form.Label>Password</Form.Label>
                <InputGroup>
                  <Form.Control
                    type={addShowPassword ? 'text' : 'password'}
                    value={addPassword}
                    onChange={(event) => setAddPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                  <Button
                    variant="outline-secondary"
                    type="button"
                    onClick={() => setAddShowPassword((visible) => !visible)}
                    aria-label={addShowPassword ? 'Hide password' : 'Show password'}
                  >
                    {addShowPassword ? 'Hide' : 'Show'}
                  </Button>
                </InputGroup>
              </Form.Group>
            </fieldset>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="outline-secondary" type="button" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={addSubmitting}>
              {addSubmitting ? (
                <>
                  <Spinner as="span" animation="border" size="sm" role="status" className="me-2" />
                  Saving…
                </>
              ) : (
                'Save credential'
              )}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>

      {/* View Credential */}
      <Modal show={showView} onHide={() => setShowView(false)} centered>
        <Modal.Header closeButton>
          <Modal.Title>{viewItem?.title ?? 'Credential'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {viewLoading ? (
            <div className="d-flex justify-content-center py-4">
              <Spinner animation="border" role="status" />
            </div>
          ) : viewError ? (
            <Alert variant="danger" role="alert">
              {viewError}
            </Alert>
          ) : (
            viewItem && (
              <>
                <p className="mb-1">
                  <strong>URL:</strong> {viewItem.url || '—'}
                </p>
                <p className="mb-3">
                  <strong>Username:</strong> {viewItem.username || '—'}
                </p>

                {viewDecryptError && (
                  <Alert variant="danger" role="alert">
                    {viewDecryptError}
                  </Alert>
                )}

                <Form.Group className="mb-3" controlId="cred-view-password">
                  <Form.Label>Password</Form.Label>
                  <InputGroup>
                    <Form.Control
                      type="text"
                      readOnly
                      value={viewRevealed ? viewPlaintext ?? '' : '••••••••••••'}
                    />
                    <Button variant="outline-secondary" type="button" onClick={handleReveal}>
                      {viewRevealed ? 'Hide' : 'Reveal'}
                    </Button>
                    <Button
                      variant="outline-secondary"
                      type="button"
                      onClick={handleCopyPassword}
                      disabled={!viewRevealed}
                    >
                      {viewCopied ? 'Copied' : 'Copy'}
                    </Button>
                  </InputGroup>
                  <Form.Text className="text-muted">
                    The clipboard is cleared automatically 30 seconds after copying.
                  </Form.Text>
                </Form.Group>
              </>
            )
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-danger" onClick={openDeleteFromView} disabled={!viewItem}>
            Delete
          </Button>
          <Button variant="outline-secondary" onClick={openEditFromView} disabled={!viewItem}>
            Edit
          </Button>
          <Button variant="primary" onClick={() => setShowView(false)}>
            Close
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Edit Credential */}
      <Modal show={showEdit} onHide={() => setShowEdit(false)} centered>
        <Modal.Header closeButton>
          <Modal.Title>Edit credential</Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleEditSubmit} noValidate>
          <Modal.Body>
            <fieldset disabled={editSubmitting}>
              {editError && (
                <Alert variant="danger" role="alert">
                  {editError}
                </Alert>
              )}
              <Form.Group className="mb-3" controlId="cred-edit-title">
                <Form.Label>Title</Form.Label>
                <Form.Control
                  type="text"
                  value={editTitle}
                  onChange={(event) => setEditTitle(event.target.value)}
                  required
                />
              </Form.Group>
              <Form.Group className="mb-3" controlId="cred-edit-url">
                <Form.Label>URL</Form.Label>
                <Form.Control type="text" value={editUrl} onChange={(event) => setEditUrl(event.target.value)} />
              </Form.Group>
              <Form.Group className="mb-3" controlId="cred-edit-username">
                <Form.Label>Username</Form.Label>
                <Form.Control
                  type="text"
                  value={editUsername}
                  onChange={(event) => setEditUsername(event.target.value)}
                />
              </Form.Group>

              {editDecryptError && (
                <Alert variant="danger" role="alert">
                  {editDecryptError}
                </Alert>
              )}

              <Form.Group className="mb-3" controlId="cred-edit-current-password">
                <Form.Label>Current password</Form.Label>
                <InputGroup>
                  <Form.Control
                    type="text"
                    readOnly
                    value={editRevealedExisting ? editExistingPlaintext ?? '' : '••••••••••••'}
                  />
                  <Button variant="outline-secondary" type="button" onClick={handleRevealExisting}>
                    {editRevealedExisting ? 'Hide' : 'Reveal'}
                  </Button>
                </InputGroup>
              </Form.Group>

              <Form.Group className="mb-3" controlId="cred-edit-new-password">
                <Form.Label>New password</Form.Label>
                <InputGroup>
                  <Form.Control
                    type={editShowNewPassword ? 'text' : 'password'}
                    value={editNewPassword}
                    onChange={(event) => setEditNewPassword(event.target.value)}
                    autoComplete="new-password"
                    placeholder="Leave blank to keep the current password"
                  />
                  <Button
                    variant="outline-secondary"
                    type="button"
                    onClick={() => setEditShowNewPassword((visible) => !visible)}
                    aria-label={editShowNewPassword ? 'Hide new password' : 'Show new password'}
                  >
                    {editShowNewPassword ? 'Hide' : 'Show'}
                  </Button>
                </InputGroup>
                <Form.Text className="text-muted">Leave blank to keep the current password unchanged.</Form.Text>
              </Form.Group>
            </fieldset>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="outline-secondary" type="button" onClick={() => setShowEdit(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={editSubmitting}>
              {editSubmitting ? (
                <>
                  <Spinner as="span" animation="border" size="sm" role="status" className="me-2" />
                  Saving…
                </>
              ) : (
                'Save changes'
              )}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>

      {/* Delete confirmation */}
      <Modal show={showDelete} onHide={() => setShowDelete(false)} centered>
        <Modal.Header closeButton>
          <Modal.Title>Delete credential</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {deleteError && (
            <Alert variant="danger" role="alert">
              {deleteError}
            </Alert>
          )}
          <p className="mb-0">
            Are you sure you want to delete <strong>{deleteItem?.title}</strong>? This cannot be undone.
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
