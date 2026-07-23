const nodemailer = require('nodemailer');

// The one place the app talks SMTP, and the one place a reset link is ever
// composed into an email. It sends a link, never the token in any other
// form and never the new/old password — printing either into a mail body
// would defeat the point of hashing the token at rest (routes/
// password-reset.js) and the zero-knowledge posture generally.
//
// The transport is injected, not built here: this module never reads
// SMTP_HOST/PORT/USERNAME/PASSWORD itself — a caller loads that config and
// passes a built transport to createSmtpTransport/createEmailService — and
// tests pass a fake transport with a jest.fn() `sendMail` so no test ever
// opens a real SMTP connection.
//
// As of PRD 0020, no route in this app calls createEmailService: password
// reset (the original caller, PRD 0015) now verifies identity via TOTP
// instead (see routes/password-reset.js and ADR 0014) and has no SMTP
// dependency. This module is kept, unwired, for a future feature that needs
// to send mail — the domain model documents SecurityAlert as depending on
// an EmailService. sendPasswordResetEmail's reset-specific wording below
// would need generalizing (or a sibling function added) before any new
// caller reuses this service for a different kind of email.

const SUBJECT = 'Reset your SecureVault master password';

function resetEmailBody(resetUrl) {
  return (
    'Use the link below to reset your SecureVault master password. ' +
    'This link expires soon and can only be used once.\n\n' +
    `${resetUrl}\n\n` +
    'If you did not request this, you can safely ignore this email — your ' +
    'master password has not been changed.'
  );
}

/**
 * @param transport  a nodemailer-shaped transport: `{ sendMail(options) }`.
 *                    Required and never defaulted — an EmailService that
 *                    quietly built its own transport from the environment
 *                    could not be pointed at a fake one in tests, and a
 *                    silently-misconfigured transport would fail a real send
 *                    with no way to catch it before deploy.
 * @param from       optional sender address; nodemailer requires one on
 *                    `sendMail` if the transport itself has none configured.
 */
function createEmailService({ transport, from } = {}) {
  if (!transport || typeof transport.sendMail !== 'function') {
    throw new TypeError('transport is required');
  }

  return {
    /**
     * @param to        the account's registered email — never logged.
     * @param resetUrl  the full link, including the raw single-use token —
     *                  never logged. The only record of a reset request is
     *                  the token's SHA-256 hash in PASSWORD_RESET_TOKENS.
     */
    async sendPasswordResetEmail({ to, resetUrl } = {}) {
      if (typeof to !== 'string' || to === '') {
        throw new TypeError('to is required');
      }
      if (typeof resetUrl !== 'string' || resetUrl === '') {
        throw new TypeError('resetUrl is required');
      }

      const options = { to, subject: SUBJECT, text: resetEmailBody(resetUrl) };
      if (from) {
        options.from = from;
      }

      await transport.sendMail(options);
    },
  };
}

/**
 * Builds the real nodemailer transport from a loaded SMTP config (host,
 * port, username, password). Kept separate from createEmailService so only
 * a real caller (a future feature that wires this service up) ever
 * constructs a live SMTP connection; every test constructs createEmailService
 * directly with a fake transport instead.
 */
function createSmtpTransport({ host, port, username, password } = {}) {
  return nodemailer.createTransport({
    host,
    port,
    // Implicit TLS on 465, STARTTLS otherwise — nodemailer's own default,
    // left unoverridden rather than guessed at here.
    secure: port === 465,
    auth: { user: username, pass: password },
  });
}

module.exports = { createEmailService, createSmtpTransport };
