const { loadDbConfig, REQUIRED_VARS } = require('../src/db/pool');

const FULL_ENV = Object.freeze({
  DB_HOST: '10.0.0.5',
  DB_PORT: '3306',
  DB_NAME: 'securevault',
  DB_USER: 'spms_app',
  DB_PASSWORD: 'not-a-real-secret',
});

describe('db/pool loadDbConfig', () => {
  it('requiring the module does not throw even with no DB env set — lazy, not eager', () => {
    // Getting this far without an exception proves it: db/pool.js is
    // required (directly and transitively, by every ports/*.js file) all
    // over the test suite, none of which sets DB_* vars.
    expect(typeof loadDbConfig).toBe('function');
  });

  it('parses a complete env', () => {
    expect(loadDbConfig(FULL_ENV)).toEqual({
      host: '10.0.0.5',
      port: 3306,
      database: 'securevault',
      user: 'spms_app',
      password: 'not-a-real-secret',
    });
  });

  it.each(REQUIRED_VARS)('throws (fail-fast) when %s is missing, and never echoes a value', (key) => {
    const env = { ...FULL_ENV, [key]: undefined };
    delete env[key];

    let caught;
    try {
      loadDbConfig(env);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain(key);
    expect(caught.message).not.toContain(FULL_ENV.DB_PASSWORD);
  });

  it('rejects a non-numeric DB_PORT', () => {
    expect(() => loadDbConfig({ ...FULL_ENV, DB_PORT: 'not-a-port' })).toThrow(/DB_PORT/);
  });

  it('rejects a zero or negative DB_PORT', () => {
    expect(() => loadDbConfig({ ...FULL_ENV, DB_PORT: '0' })).toThrow(/DB_PORT/);
    expect(() => loadDbConfig({ ...FULL_ENV, DB_PORT: '-1' })).toThrow(/DB_PORT/);
  });
});
