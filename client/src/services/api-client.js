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
  const refreshedToken = res.headers.get('X-Session-Token');
  if (refreshedToken) {
    store.setToken(refreshedToken);
    store.setExpiresAt(res.headers.get('X-Session-Expires-At'));
    scheduleAutoLock();
  }

  if (res.status === 204) {
    return null;
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

  if (!res.ok) {
    const error = payload && typeof payload === 'object' ? payload.error : undefined;
    const description = payload && typeof payload === 'object' ? payload.error_description : undefined;
    // Fail-safe expiry path: end the session exactly once, centrally, before
    // the error propagates — the token is cleared so nothing reuses it.
    if (res.status === 401 && SESSION_ENDED_DESCRIPTIONS.has(description)) {
      endSession();
    }
    throw new ApiError(res.status, error, description);
  }

  return payload;
}

export const get = (path, options) => request('GET', path, options);
export const post = (path, body, options) => request('POST', path, { ...options, body });
export const put = (path, body, options) => request('PUT', path, { ...options, body });
export const del = (path, options) => request('DELETE', path, options);
