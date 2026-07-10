const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const {
  createAuthMiddleware,
  extractBearerToken,
} = require('../src/middleware/authenticate');
const { errorHandler } = require('../src/middleware/error-handler');
const { testTokenService, TEST_KEY } = require('./helpers/test-token-service');
const { testApp, permissiveSessions } = require('./helpers/test-app');

const tokenService = testTokenService();
const app = () => testApp({ sessions: permissiveSessions }).app;
const validToken = () => tokenService.sign({ userId: 'user-42', sessionId: 'sess-7' });

// The middleware refuses to construct without a session store, so its own
// unit tests supply one that revokes nothing. Revocation has its own suite.
const authMiddleware = (overrides = {}) =>
  createAuthMiddleware({ tokenService, sessions: permissiveSessions, ...overrides });

function forge(payload, options = {}) {
  return jwt.sign(
    { sessionStartedAt: Math.floor(Date.now() / 1000), ...payload },
    TEST_KEY,
    {
      algorithm: 'HS256',
      issuer: 'securevault',
      audience: 'securevault-app',
      expiresIn: 600,
      ...options,
    }
  );
}

describe('extractBearerToken', () => {
  it('accepts the RFC 6750 form, scheme case-insensitively', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('BEARER abc.def.ghi')).toBe('abc.def.ghi');
  });

  it.each([
    ['no header', undefined],
    ['empty string', ''],
    ['scheme only', 'Bearer'],
    ['scheme with no token', 'Bearer '],
    ['wrong scheme', 'Basic abc.def.ghi'],
    ['bare token', 'abc.def.ghi'],
    ['two tokens', 'Bearer abc def'],
    ['non-string', 42],
  ])('rejects %s', (_name, header) => {
    expect(extractBearerToken(header)).toBeNull();
  });
});

describe('protected routes', () => {
  it('serves a protected route with a valid token', async () => {
    const res = await request(app())
      .get('/api/session')
      .set('Authorization', `Bearer ${validToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: 'user-42',
      role: 'owner',
      sessionId: 'sess-7',
    });
    expect(Date.parse(res.body.expiresAt)).not.toBeNaN();
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await request(app()).get('/api/session');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_request');
    expect(res.headers['www-authenticate']).toMatch(/^Bearer error="invalid_request"/);
  });

  it('rejects a token signed with the wrong key', async () => {
    const forged = jwt.sign({ role: 'owner' }, 'a'.repeat(64), {
      algorithm: 'HS256',
      subject: 'attacker',
      issuer: 'securevault',
      audience: 'securevault-app',
      expiresIn: 600,
    });

    const res = await request(app()).get('/api/session').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  it('rejects an unsigned alg:none token', async () => {
    const unsigned = jwt.sign({ role: 'owner' }, '', {
      algorithm: 'none',
      subject: 'attacker',
      issuer: 'securevault',
      audience: 'securevault-app',
    });

    const res = await request(app()).get('/api/session').set('Authorization', `Bearer ${unsigned}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token carrying a role outside the allowlist', async () => {
    const escalated = forge({ role: 'superuser' }, { subject: 'user-42' });

    const res = await request(app()).get('/api/session').set('Authorization', `Bearer ${escalated}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  it('distinguishes an expired token so the client knows to log in again', async () => {
    const expired = forge({ role: 'owner' }, { subject: 'user-42', expiresIn: -1 });

    const res = await request(app()).get('/api/session').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error_description).toBe('Token expired');
  });

  // Regression: this returned 500 (RangeError on Invalid Date) before
  // verify() started demanding exp/iat. An auth failure must never be a 500.
  it('rejects a token with no exp claim with 401, not 500', async () => {
    const immortal = jwt.sign({ role: 'owner' }, TEST_KEY, {
      algorithm: 'HS256',
      subject: 'attacker',
      issuer: 'securevault',
      audience: 'securevault-app',
      noTimestamp: true,
    });

    const res = await request(app()).get('/api/session').set('Authorization', `Bearer ${immortal}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  it('rejects a token with no subject with 401', async () => {
    const subjectless = forge({ role: 'owner' });
    const res = await request(app())
      .get('/api/session')
      .set('Authorization', `Bearer ${subjectless}`);
    expect(res.status).toBe(401);
  });

  it('rejects a not-yet-valid token with 401', async () => {
    const notYet = forge({ role: 'owner' }, { subject: 'user-42', notBefore: 3600 });
    const res = await request(app()).get('/api/session').set('Authorization', `Bearer ${notYet}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  it('never echoes the token back in the response', async () => {
    const token = validToken();
    const res = await request(app())
      .get('/api/session')
      .set('Authorization', `Bearer ${token.slice(0, -1)}x`);

    expect(JSON.stringify(res.body)).not.toContain(token.slice(0, 20));
    expect(res.headers['www-authenticate']).not.toContain(token.slice(0, 20));
  });
});

describe('sliding session headers', () => {
  it('returns a renewed token on every authenticated response', async () => {
    const res = await request(app())
      .get('/api/session')
      .set('Authorization', `Bearer ${validToken()}`);

    const renewed = res.headers['x-session-token'];
    expect(renewed).toEqual(expect.any(String));
    expect(tokenService.verify(renewed).userId).toBe('user-42');
  });

  it('reports the new idle deadline as an ISO timestamp', async () => {
    const res = await request(app())
      .get('/api/session')
      .set('Authorization', `Bearer ${validToken()}`);

    const expiresAt = Date.parse(res.headers['x-session-expires-at']);
    expect(expiresAt).not.toBeNaN();
    expect(tokenService.verify(res.headers['x-session-token']).expiresAt.getTime()).toBe(expiresAt);
  });

  it('carries the same session identity forward', async () => {
    const res = await request(app())
      .get('/api/session')
      .set('Authorization', `Bearer ${validToken()}`);

    const before = tokenService.verify(validToken());
    const after = tokenService.verify(res.headers['x-session-token']);

    expect(after.sessionId).toBe(before.sessionId);
    expect(after.userId).toBe(before.userId);
    expect(after.sessionStartedAt.getTime()).toBeCloseTo(before.sessionStartedAt.getTime(), -3);
  });

  it('exposes the headers to cross-origin JavaScript', async () => {
    const res = await request(app())
      .get('/api/session')
      .set('Authorization', `Bearer ${validToken()}`);

    expect(res.headers['access-control-expose-headers']).toContain('X-Session-Token');
  });

  it('the renewed token is itself accepted on the next request', async () => {
    const first = await request(app())
      .get('/api/session')
      .set('Authorization', `Bearer ${validToken()}`);

    const second = await request(app())
      .get('/api/session')
      .set('Authorization', `Bearer ${first.headers['x-session-token']}`);

    expect(second.status).toBe(200);
    expect(second.body.userId).toBe('user-42');
  });

  it('issues no session headers on a rejected request', async () => {
    const res = await request(app()).get('/api/session');

    expect(res.status).toBe(401);
    expect(res.headers['x-session-token']).toBeUndefined();
  });

  it('issues no session headers on a public route', async () => {
    const res = await request(app()).get('/health');
    expect(res.headers['x-session-token']).toBeUndefined();
  });

  it('rejects a session past its absolute cap with 401', async () => {
    const stale = forge(
      { role: 'owner', sessionStartedAt: Math.floor(Date.now() / 1000) - 13 * 60 * 60 },
      { subject: 'user-42' }
    );

    const res = await request(app()).get('/api/session').set('Authorization', `Bearer ${stale}`);
    expect(res.status).toBe(401);
    expect(res.body.error_description).toBe('Session expired');
  });
});

describe('public routes', () => {
  // `/` is no longer a backend route: when a client build is present it is
  // served by the SPA static handler ahead of auth (see spa-serving.test.js);
  // when it is absent (as here) there is simply nothing at `/`. `/health`
  // stays a public backend route because the CD smoke test depends on it.
  it('serves /health without a token', async () => {
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
  });
});

describe('default-deny', () => {
  // The property that matters: a route nobody remembered to guard is guarded.
  it('protects a newly added route that was never explicitly secured', async () => {
    const app = express();
    app.use(authMiddleware());
    app.get('/api/vault/items', (req, res) => res.status(200).json({ items: [] }));

    const anonymous = await request(app).get('/api/vault/items');
    expect(anonymous.status).toBe(401);

    const authorised = await request(app)
      .get('/api/vault/items')
      .set('Authorization', `Bearer ${validToken()}`);
    expect(authorised.status).toBe(200);
  });

  it('rejects unknown paths rather than revealing they do not exist', async () => {
    const res = await request(app()).get('/api/does-not-exist');
    expect(res.status).toBe(401);
  });

  it('guards every method on a protected path', async () => {
    const app = express();
    app.use(authMiddleware());
    app.all('/api/thing', (req, res) => res.status(200).end());

    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const res = await request(app)[method]('/api/thing');
      expect(res.status).toBe(401);
    }
  });
});

describe('unexpected errors', () => {
  let errorSpy;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  function appWithThrowingRoute() {
    const app = express();
    app.use(authMiddleware());
    app.get('/api/boom', () => {
      throw new Error('secret internal detail: db at 10.0.0.5');
    });
    app.use(errorHandler);
    return app;
  }

  it('returns a bare 500 when a route throws', async () => {
    const res = await request(appWithThrowingRoute())
      .get('/api/boom')
      .set('Authorization', `Bearer ${validToken()}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
  });

  it('leaks neither the stack nor the error message to the client', async () => {
    const res = await request(appWithThrowingRoute())
      .get('/api/boom')
      .set('Authorization', `Bearer ${validToken()}`);

    expect(res.text).not.toContain('secret internal detail');
    expect(res.text).not.toContain('10.0.0.5');
    expect(res.text).not.toMatch(/at \w+|node_modules/);
  });

  it('still requires auth before a route can throw', async () => {
    const res = await request(appWithThrowingRoute()).get('/api/boom');
    expect(res.status).toBe(401);
  });

  it('writes the stack to the server log', async () => {
    await request(appWithThrowingRoute())
      .get('/api/boom')
      .set('Authorization', `Bearer ${validToken()}`);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('unhandled error on GET /api/boom'),
      expect.stringContaining('secret internal detail')
    );
  });
});

describe('req.auth', () => {
  it('exposes the identity to the handler and is frozen', async () => {
    const app = express();
    app.use(authMiddleware());
    app.get('/probe', (req, res) => {
      let mutated = false;
      try {
        req.auth.userId = 'attacker';
        mutated = req.auth.userId === 'attacker';
      } catch {
        mutated = false;
      }
      res.status(200).json({ userId: req.auth.userId, mutated });
    });

    const res = await request(app).get('/probe').set('Authorization', `Bearer ${validToken()}`);
    expect(res.body).toEqual({ userId: 'user-42', mutated: false });
  });

  it('is absent on a public route', async () => {
    const app = express();
    app.use(authMiddleware({ publicPaths: ['/open'] }));
    app.get('/open', (req, res) => res.status(200).json({ hasAuth: req.auth !== undefined }));

    const res = await request(app).get('/open');
    expect(res.body).toEqual({ hasAuth: false });
  });
});
