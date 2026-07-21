const express = require('express');
const { ACTIONS } = require('../models/audit-entry');
const { ItemOwnershipError } = require('../ports/password-health');
const { asyncRoute } = require('./credentials');

// UC-05 (PRD 0022). Password health analysis (weak/reused detection) runs
// client-side, in the browser, using the vault key already in memory to
// decrypt every item -- the server never sees plaintext and so can never
// compute or verify these findings itself (see ports/password-health.js's
// header for the full trust-boundary note). This route's job is narrow: take
// the client's already-computed conclusions, verify the itemIds they're about
// are genuinely the caller's own (business rule 6 -- the one thing that IS
// verifiable here), and persist the result atomically.

const VALID_STATUSES = Object.freeze(['WEAK', 'REUSED', 'OK']);
const ALERT_STATUSES = Object.freeze(['WEAK', 'REUSED']);

function isValidScore(overallScore) {
  return (
    typeof overallScore === 'number' &&
    Number.isFinite(overallScore) &&
    overallScore >= 0 &&
    overallScore <= 100
  );
}

function isValidFindings(findings) {
  if (!Array.isArray(findings)) {
    return false;
  }

  const seenItemIds = new Set();
  return findings.every((finding) => {
    if (!finding || typeof finding !== 'object') {
      return false;
    }
    const { itemId, status } = finding;
    const hasItemId =
      (typeof itemId === 'string' && itemId !== '') || typeof itemId === 'number';
    if (!hasItemId || !VALID_STATUSES.includes(status)) {
      return false;
    }

    // A malformed or replayed request naming the same itemId twice would
    // otherwise reach REPORT_FINDINGS' composite PK (report_id, item_id) and
    // fail there as a MySQL duplicate-key error mid-transaction -- safe (the
    // whole transaction rolls back, nothing persists) but a 500, not the
    // clean 400 a malformed request deserves. Caught here, before the
    // transaction even opens, same as every other shape check in this
    // function. Normalized to a string so `1` and `"1"` collide, matching
    // ports/password-health.js's own `String(itemId)` comparison in
    // addFindings().
    const key = String(itemId);
    if (seenItemIds.has(key)) {
      return false;
    }
    seenItemIds.add(key);

    return true;
  });
}

// The server builds this message itself, from nothing but the status label
// the finding already carries -- SECURITY_ALERTS.message never holds a byte
// of client-supplied free text. There is no reason it should: an alert
// message is a fixed sentence about a fixed condition, not a place for a
// caller to write arbitrary prose into another table.
function alertMessageFor(status) {
  return status === 'WEAK'
    ? 'A saved password was flagged as weak.'
    : 'A saved password was flagged as reused.';
}

function readableReport(report) {
  if (!report) {
    return null;
  }
  return {
    reportId: report.reportId,
    overallScore: report.overallScore,
    generatedAt: report.generatedAt,
    findings: report.findings,
    alerts: report.alerts,
  };
}

/**
 * @param store  the password-health port (see ports/password-health.js):
 *   transaction(fn)
 *   getVaultIdForUser(userId, conn?)               -> vaultId
 *   createReport(tx, { vaultId, overallScore })    -> reportId
 *   addFindings(tx, { vaultId, reportId, findings }) — throws
 *     ItemOwnershipError if any itemId isn't the caller's own.
 *   addAlerts(tx, { reportId, alerts })
 *   getLatestReport({ vaultId })                   -> report | null
 * @param audit  a createAuditLog() instance.
 */
function createPasswordHealthRoutes({ store, audit } = {}) {
  if (!store || typeof store.transaction !== 'function') {
    throw new TypeError('store is required');
  }
  if (!audit || typeof audit.forRequest !== 'function') {
    throw new TypeError('audit is required');
  }

  const router = express.Router();

  // The write and its entry share one transaction, same shape as
  // routes/credentials.js's POST /: a report that commits without its
  // findings/alerts/audit entry would be a health report that lies about
  // what it found.
  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const { overallScore, findings } = req.body ?? {};

      if (!isValidScore(overallScore) || !isValidFindings(findings)) {
        // Real input validation, not an anti-enumeration case: an invalid
        // score or status is a malformed request regardless of whose vault
        // it names.
        return res.status(400).json({ error: 'invalid_request' });
      }

      let reportId;
      try {
        reportId = await store.transaction(async (tx) => {
          const vaultId = await store.getVaultIdForUser(req.auth.userId, tx);
          const newReportId = await store.createReport(tx, { vaultId, overallScore });

          await store.addFindings(tx, { vaultId, reportId: newReportId, findings });

          // Only WEAK/REUSED findings ever raise an alert -- SECURITY_ALERTS.
          // type has no OK member, and an OK finding is nothing to alert
          // anyone about.
          const alerts = findings
            .filter((finding) => ALERT_STATUSES.includes(finding.status))
            .map((finding) => ({
              type: finding.status,
              message: alertMessageFor(finding.status),
            }));
          await store.addAlerts(tx, { reportId: newReportId, alerts });

          await audit
            .forRequest(req)
            .logAction({ action: ACTIONS.HEALTH_REPORT_GENERATED, context: tx });

          return newReportId;
        });
      } catch (err) {
        // Business rule 6: a claimed itemId that isn't the caller's own is
        // answered exactly like "not found" -- the same anti-enumeration
        // posture routes/credentials.js already applies to a GET/PATCH/DELETE
        // naming another user's itemId. Nothing was persisted: the whole
        // transaction above threw before commit.
        if (err instanceof ItemOwnershipError) {
          return res.status(404).json({ error: 'not_found' });
        }
        throw err;
      }

      return res.status(201).json({ reportId: String(reportId) });
    })
  );

  // Read-only: the caller reading their own already-audited report, not a new
  // event, so no audit entry here. A vault that has never been analyzed
  // yields `{ report: null }`, a legitimate state -- never a 404/500.
  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const vaultId = await store.getVaultIdForUser(req.auth.userId);
      const report = await store.getLatestReport({ vaultId });
      return res.status(200).json({ report: readableReport(report) });
    })
  );

  return router;
}

module.exports = { createPasswordHealthRoutes };
