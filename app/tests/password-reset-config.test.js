const {
  loadPasswordResetConfig,
  DEFAULT_RESET_TOKEN_TTL_MINUTES,
} = require('../src/config/password-reset-config');

const VALID_ENV = Object.freeze({
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USERNAME: 'securevault-relay',
  SMTP_PASSWORD: 'super-secret',
  APP_BASE_URL: 'https://securevault.example.com',
});

describe('config/password-reset-config', () => {
  it('loads a complete, valid env', () => {
    const config = loadPasswordResetConfig(VALID_ENV);
    expect(config).toEqual({
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        username: 'securevault-relay',
        password: 'super-secret',
      },
      resetTokenTtlMinutes: DEFAULT_RESET_TOKEN_TTL_MINUTES,
      appBaseUrl: 'https://securevault.example.com',
    });
  });

  it.each(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'APP_BASE_URL'])(
    'fails fast when %s is missing',
    (key) => {
      const env = { ...VALID_ENV };
      delete env[key];
      expect(() => loadPasswordResetConfig(env)).toThrow(new RegExp(key));
    }
  );

  it('never includes a secret value in its error message', () => {
    const env = { ...VALID_ENV, SMTP_PASSWORD: undefined };
    delete env.SMTP_PASSWORD;
    let message = '';
    try {
      loadPasswordResetConfig(env);
    } catch (err) {
      message = err.message;
    }
    expect(message).not.toContain('super-secret');
  });

  it('rejects a non-numeric SMTP_PORT', () => {
    expect(() => loadPasswordResetConfig({ ...VALID_ENV, SMTP_PORT: 'not-a-port' })).toThrow(
      /SMTP_PORT/
    );
  });

  it('honours a custom RESET_TOKEN_TTL_MINUTES', () => {
    const config = loadPasswordResetConfig({ ...VALID_ENV, RESET_TOKEN_TTL_MINUTES: '15' });
    expect(config.resetTokenTtlMinutes).toBe(15);
  });

  it('rejects a non-positive RESET_TOKEN_TTL_MINUTES', () => {
    expect(() =>
      loadPasswordResetConfig({ ...VALID_ENV, RESET_TOKEN_TTL_MINUTES: '0' })
    ).toThrow(/RESET_TOKEN_TTL_MINUTES/);
  });
});
