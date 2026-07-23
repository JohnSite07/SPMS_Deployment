// Password health report CRUD (PRD 0022, UC-05) — mirrors
// credentials-service.js: a thin wrapper over api-client.js, no crypto and
// no analysis logic here. The findings/overallScore this module sends are
// already-computed conclusions (see vault-health-analyzer.js); this file
// never sees a plaintext password.

import { get, post } from './api-client';

// GET /api/password-health — returns `{ report: null }` for a vault that has
// never been analyzed (a legitimate state, not an error), or the latest
// report with its findings and unread alerts. Used by PasswordHealth.jsx to
// render the health screen, and could be reused by any other screen wanting
// the latest persisted findings without recomputing them.
export async function getHealthReport() {
  return get('/password-health');
}

// POST /api/password-health — persists a freshly computed report. Called by
// Credentials.jsx after it decrypts the vault list and runs analyzeVault(),
// on mount and after any add/edit/delete that changes a password value.
export async function submitHealthReport({ overallScore, findings }) {
  return post('/password-health', { overallScore, findings });
}
