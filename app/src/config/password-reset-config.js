// Environment contract loader for the password-reset flow (PRD 0015),
// mirroring config/env.js: every value comes from the environment, and
// nothing falls back to a default that could quietly point at the wrong
// mailbox or leak a localhost URL into a production reset email. This loader
// itself is still fail-fast — it throws on any missing/invalid value, same
// as loadJwtConfig() — but its caller need not be: server.js calls it inside
// its own non-fatal try/catch (SMTP is not yet provisioned everywhere) and,
// on failure, boots with /api/password-reset/* in routes/password-reset.js's
// "disabled mode" (503 on both routes) rather than exiting the whole
// process. See this PRD's Outcome for the terraform-engineer follow-up.
//
// SMTP_HOST / SMTP_PORT are NOT yet injected by Terraform — only
// SMTP_USERNAME / SMTP_PASSWORD are (terraform/modules/app/main.tf). This
// loader requires all four anyway: a caller that wants the reset flow live
// gets a clear, name-only error rather than a silent partial config. Tests
// never exercise this loader against a real environment — they pass a fake
// `env` object and mock the SMTP transport.
const REQUIRED_VARS = Object.freeze([
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USERNAME',
  'SMTP_PASSWORD',
  'APP_BASE_URL',
]);

// The reset link's lifetime. 30 minutes balances "long enough to find the
// email" against "short enough that a captured-but-unused link is worthless
// soon after" — the token is also single-use (ports/password-reset-store.js),
// so this is a backstop, not the only defence.
const DEFAULT_RESET_TOKEN_TTL_MINUTES = 30;

function loadPasswordResetConfig(env = process.env) {
  const missing = REQUIRED_VARS.filter((key) => !env[key]);
  if (missing.length > 0) {
    // Names only, never values — the values are the secrets.
    throw new Error(
      `Missing required password-reset env var(s): ${missing.join(', ')}. SMTP_USERNAME/` +
        'SMTP_PASSWORD come from Secret Manager; SMTP_HOST/SMTP_PORT/APP_BASE_URL are plain ' +
        'config that must be set alongside them (see this module\'s header comment).'
    );
  }

  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`SMTP_PORT must be a positive integer; got "${env.SMTP_PORT}"`);
  }

  const ttlMinutes =
    env.RESET_TOKEN_TTL_MINUTES !== undefined
      ? Number(env.RESET_TOKEN_TTL_MINUTES)
      : DEFAULT_RESET_TOKEN_TTL_MINUTES;
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new Error(
      `RESET_TOKEN_TTL_MINUTES must be a positive number; got "${env.RESET_TOKEN_TTL_MINUTES}"`
    );
  }

  return {
    smtp: {
      host: env.SMTP_HOST,
      port,
      username: env.SMTP_USERNAME,
      password: env.SMTP_PASSWORD,
    },
    resetTokenTtlMinutes: ttlMinutes,
    appBaseUrl: env.APP_BASE_URL,
  };
}

module.exports = {
  loadPasswordResetConfig,
  DEFAULT_RESET_TOKEN_TTL_MINUTES,
  REQUIRED_VARS,
};
