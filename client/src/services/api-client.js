// The one "phone line" the whole SPA uses to reach the backend (PRD 0012).
// Every screen calls these helpers (or a per-resource service built on them),
// never fetch() directly, so bearer-token attach, the sliding-session refresh,
// error shaping, and the expiry path live in exactly one place.

import * as store from './token-store';
import { endSession, scheduleAutoLock } from './session';

// Same-origin in production (Express serves the SPA, ADR 0009) and proxied to
// the backend in dev (vite.config server.proxy), so the base URL is always the
// relative /api — no absolute host, no env var, no CORS (Decision 2).
const BASE_URL = '/api';

// The auth middleware's 401 descriptions that mean "this session is over"
// (see app/src/middleware/authenticate.js). A 401 with any of these ends the
// session; other 401s (e.g. a bad login) are surfaced as errors only.
const SESSION_ENDED_DESCRIPTIONS = new Set(['Session expired', 'Session ended', 'Token expired']);

// A typed error carrying the HTTP status and the server's {error,
// error_description}, so callers branch on real data instead of parsing
// strings. The token value is never included.
export class ApiError extends Error {
  constructor(status, error, description) {
    super(description || error || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.error = error ?? null;
    this.description = description ?? null;
  }
}

// Shared by every request path below: captures the sliding-session refresh
// headers (if present) and re-arms the auto-lock. Pulled out of request()
// so postMultipart/getBinary (PRD 0025) get the exact same session-refresh
// behaviour without duplicating it ad hoc.
function captureRefreshedSession(res) {
  const refreshedToken = res.headers.get('X-Session-Token');
  if (refreshedToken) {
    store.setToken(refreshedToken);
    store.setExpiresAt(res.headers.get('X-Session-Expires-At'));
    scheduleAutoLock();
  }
}

// Shared error path: on a non-2xx response, parse whatever body is there,
// end the session on a "session is over" 401 (fail-safe, before the error
// propagates), and throw a typed ApiError. Does nothing (and does not touch
// the body) on success, so callers remain free to read the body themselves.
async function throwIfError(res) {
  if (res.ok) {
    return;
  }
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  const error = payload && typeof payload === 'object' ? payload.error : undefined;
  const description = payload && typeof payload === 'object' ? payload.error_description : undefined;
  if (res.status === 401 && SESSION_ENDED_DESCRIPTIONS.has(description)) {
    endSession();
  }
  throw new ApiError(res.status, error, description);
}

export async function request(method, path, { body, headers } = {}) {
  const outgoing = { Accept: 'application/json', ...headers };
  if (body !== undefined) {
    outgoing['Content-Type'] = 'application/json';
  }
  const token = store.getToken();
  if (token) {
    outgoing.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: outgoing,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Sliding-session refresh: every authenticated response carries a renewed
  // token and a fresh expiry. Capture them from any response that has them and
  // re-arm the auto-lock, so an active user is never logged out mid-session.
  captureRefreshedSession(res);

  if (res.status === 204) {
    return null;
  }

  await throwIfError(res);

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return payload;
}

export const get = (path, options) => request('GET', path, options);
export const post = (path, body, options) => request('POST', path, { ...options, body });
export const put = (path, body, options) => request('PUT', path, { ...options, body });
// PRD 0019: routes/credentials.js's edit route is a PATCH, not a PUT — this
// wrapper exists so credentials-service.js actually sends that verb instead
// of silently reusing put() for a different HTTP method.
export const patch = (path, body, options) => request('PATCH', path, { ...options, body });
export const del = (path, options) => request('DELETE', path, options);

// PRD 0025 (Secure Document Vault) — a multipart POST for the one route that
// isn't a JSON body: routes/documents.js's upload takes a `ciphertext` file
// part plus plaintext metadata fields. Deliberately does NOT set
// Content-Type: the browser must generate the multipart boundary itself
// (`multipart/form-data; boundary=...`); setting it by hand here would omit
// or corrupt that boundary and the server would fail to parse the body. See
// document-service.js's uploadDocument, the only caller.
export async function postMultipart(path, formData) {
  const outgoing = { Accept: 'application/json' };
  const token = store.getToken();
  if (token) {
    outgoing.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: outgoing,
    body: formData,
  });

  captureRefreshedSession(res);

  if (res.status === 204) {
    return null;
  }

  await throwIfError(res);

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return payload;
}

// PRD 0025 — the download counterpart: routes/documents.js streams back raw
// ciphertext bytes (application/octet-stream), not JSON, so this returns an
// ArrayBuffer instead of a parsed payload. document-service.js's
// downloadDocument decrypts it client-side; this function never touches
// plaintext — it only ever sees ciphertext bytes.
export async function getBinary(path) {
  const outgoing = {};
  const token = store.getToken();
  if (token) {
    outgoing.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: outgoing,
  });

  captureRefreshedSession(res);
  await throwIfError(res);

  return res.arrayBuffer();
}
