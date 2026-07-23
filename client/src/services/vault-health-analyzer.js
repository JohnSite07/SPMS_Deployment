// Client-side password health analysis (PRD 0022, UC-05). Pure and
// side-effect free: no network calls live here, and it is never handed
// ciphertext -- the caller (Credentials.jsx) is the one that decrypts every
// item's password with vault-crypto.js's decryptField and the vault key
// already in vault-key-store.js, then hands the resulting plaintext to
// analyzeVault() for the brief window this computation needs it. Nothing
// here logs, persists, or transmits plaintext; the caller is responsible for
// only ever POSTing the *findings* this returns (see
// password-health-service.js), never the passwords themselves.
//
// Why this has to run client-side at all: since PRD 0019 the server only
// ever holds opaque ciphertext, so it has no way to compare two passwords or
// score one's strength. See ports/password-health.js's header comment for
// the accepted trust-boundary consequence (the server cannot verify a
// client's self-reported findings).

import { scorePasswordStrength, WEAK_THRESHOLD } from '../utils/password-strength';

// Weak-vs-reused precedence: a password can be both weak *and* reused, but
// REPORT_FINDINGS.status is a single enum per item, not a set, so one label
// has to win. REUSED takes precedence over WEAK: a password shared across
// two or more vault items multiplies the blast radius of a single leak (every
// account it protects is exposed at once), which is the more actionable/
// severe signal than "this one item's password is easy to guess". WEAK is
// only assigned when a password is not reused.
const STATUS = Object.freeze({ WEAK: 'WEAK', REUSED: 'REUSED', OK: 'OK' });

// Overall score formula (documented per the PRD, since "the" score is
// otherwise an arbitrary number someone will ask about):
//
//   overallScore = round(100 * okCount / totalCount)
//
// where okCount excludes anything flagged WEAK or REUSED. 100 means every
// item is strong and unique; 0 means every item is weak and/or reused.
//
// Empty vault (0 items): there is nothing to score and a divide-by-zero
// would otherwise occur, so this is a defined edge case, not a crash or a
// misleading 100 -- `{ overallScore: null, findings: [] }` signals "no
// report to show" and is left to the UI layer (Credentials.jsx skips
// submitting a report; PasswordHealth.jsx shows its own empty state driven
// by the persisted GET, not by this null directly).
export function analyzeVault(decryptedItems) {
  const items = Array.isArray(decryptedItems) ? decryptedItems : [];

  if (items.length === 0) {
    return { overallScore: null, findings: [] };
  }

  // Reused: any password value identical (case-sensitive, exact match) to
  // another item's password in the same array. Compared only in memory —
  // never logged, never sent anywhere in plaintext form.
  const occurrences = new Map();
  items.forEach(({ password }) => {
    const value = password ?? '';
    occurrences.set(value, (occurrences.get(value) ?? 0) + 1);
  });

  const findings = items.map(({ itemId, password }) => {
    const value = password ?? '';
    const isReused = (occurrences.get(value) ?? 0) > 1;
    const { score } = scorePasswordStrength(value);
    const isWeak = score < WEAK_THRESHOLD;

    let status = STATUS.OK;
    if (isReused) {
      status = STATUS.REUSED;
    } else if (isWeak) {
      status = STATUS.WEAK;
    }

    return { itemId, status };
  });

  const okCount = findings.filter((finding) => finding.status === STATUS.OK).length;
  const overallScore = Math.round((100 * okCount) / findings.length);

  return { overallScore, findings };
}
