// Secure Document Vault CRUD (PRD 0025, UC-04) — mirrors credentials-service.js:
// a thin wrapper over api-client.js, no crypto state of its own beyond calling
// into document-crypto.js. Every byte this module sends or receives that
// represents file contents is already ciphertext (encryption/decryption
// happens one layer down, in document-crypto.js) — this file never sees
// plaintext document bytes, only File objects (input) and encrypted
// Blobs (output).

import { get, del, postMultipart, getBinary } from './api-client';
import { encryptFile, decryptToBlob } from './document-crypto';

// Business rule (CLAUDE.md / functional-requirements.md): uploads limited to
// PDF/image, up to 10 MB. Checked client-side BEFORE encrypting — there is no
// point spending CPU encrypting a file the server will reject anyway, and
// stating the limit up front is the "error prevention" principle the Secure
// Documents wireframe (Figure 13) calls for.
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);

export class UnsupportedFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedFileError';
  }
}

function validateFile(file) {
  if (!file) {
    throw new UnsupportedFileError('No file selected.');
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new UnsupportedFileError('Unsupported type or over 10 MB is rejected. Choose a PDF, PNG, or JPEG file.');
  }
  if (file.size <= 0 || file.size > MAX_FILE_SIZE_BYTES) {
    throw new UnsupportedFileError('Unsupported type or over 10 MB is rejected. The maximum file size is 10 MB.');
  }
}

// POST /api/documents — UC-04. Validates, then encrypts the file client-side,
// and uploads ONLY the resulting ciphertext (plus plaintext metadata) as
// multipart/form-data — the original file bytes are never part of the
// request body. See api-client.js's postMultipart for why Content-Type is
// left for the browser to set.
export async function uploadDocument({ file } = {}) {
  validateFile(file);
  const encryptedBlob = await encryptFile(file);

  const formData = new FormData();
  formData.append('ciphertext', encryptedBlob, file.name);
  formData.append('fileName', file.name);
  formData.append('fileType', file.type);
  formData.append('fileSizeKb', String(Math.ceil(file.size / 1024)));

  return postMultipart('/documents', formData);
}

// GET /api/documents — metadata only (file_name/file_type/file_size_kb/
// createdAt), newest first. No blob is ever fetched here.
export async function listDocuments() {
  return get('/documents');
}

// GET /api/documents/:itemId — fetches the ciphertext bytes and decrypts them
// client-side back into the original file, returning a Blob plus the file
// name so the caller (Documents.jsx) can trigger a save. `fileName`/`fileType`
// come from the list metadata the caller already has (routes/documents.js's
// download response is the raw bytes only, no metadata headers to parse).
// Decryption only ever happens here, on an explicit download call — secure by
// default (frontend rule 6).
export async function downloadDocument(itemId, { fileName, fileType } = {}) {
  const bytes = await getBinary(`/documents/${itemId}`);
  const blob = await decryptToBlob(bytes, fileType);
  return { blob, fileName };
}

// DELETE /api/documents/:itemId — irreversible; the caller (Documents.jsx) is
// responsible for confirming with the user first. Returns null (204).
export async function deleteDocument(itemId) {
  return del(`/documents/${itemId}`);
}
