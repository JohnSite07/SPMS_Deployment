const jwt = require('jsonwebtoken');
const {
  createTokenService,
  ROLES,
  SessionExpiredError,
} = require('../src/services/token-service');
const {
  loadJwtConfig,
  DEFAULT_TTL_SECONDS,
  DEFAULT_ABSOLUTE_SESSION_SECONDS,
} = require('../src/config/env');

const TEST_KEY = 'k'.repeat(64);
const config = {
  signingKey: TEST_KEY,
  issuer: 'securevault',
  audience: 'securevault-app',
  ttlSeconds: DEFAULT_TTL_SECONDS,
};

// A service whose clock we control, so idle and absolute expiry can be
// exercised without waiting.
function atFixedTime(startMillis = 1_700_000_000_000, overrides = {}) {
  let now = startMillis;
  const service = createTokenService({ ...config, clock: () => now, ...overrides });
  return { service, advanceSeconds: (s) => (now += s * 1000), nowSeconds: () => Math.floor(now / 1000) };
}

// Mints a token directly, bypassing the service, to forge payloads the
// service itself would refuse to produce.
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

describe('loadJwtConfig', () => {
  it('reads JWT_SIGNING_KEY from the environment', () => {
    expect(loadJwtConfig({ JWT_SIGNING_KEY: TEST_KEY }).signingKey).toBe(TEST_KEY);
  });

  it('defaults the token lifetime to the 10-minute auto-lock window', () => {
    expect(loadJwtConfig({ JWT_SIGNING_KEY: TEST_KEY }).ttlSeconds).toBe(600);
  });

  it('throws when JWT_SIGNING_KEY is absent', () => {
    expect(() => loadJwtConfig({})).toThrow(/JWT_SIGNING_KEY is not set/);
  });

  it('throws when JWT_SIGNING_KEY is shorter than the minimum', () => {
    expect(() => loadJwtConfig({ JWT_SIGNING_KEY: 'short' })).toThrow(/at least 32/);
  });

  it('does not put the key value in the error message', () => {
    const secret = 'x'.repeat(10);
    expect(() => loadJwtConfig({ JWT_SIGNING_KEY: secret })).toThrow();

    try {
      loadJwtConfig({ JWT_SIGNING_KEY: secret });
    } catch (err) {
      expect(err.message).not.toContain(secret);
    }
  });
});

describe('token payload', () => {
  const tokens = createTokenService(config);

  it('round-trips userId, role, sessionId, issuedAt and expiresAt', () => {
    const payload = tokens.verify(
      tokens.sign({ userId: 'user-42', sessionId: 'sess-7' })
    );

    expect(payload).toEqual({
      userId: 'user-42',
      role: 'owner',
      sessionId: 'sess-7',
      issuedAt: expect.any(Date),
      expiresAt: expect.any(Date),
      sessionStartedAt: expect.any(Date),
    });
  });

  it('maps the payload onto registered claims on the wire', () => {
    const raw = jwt.decode(tokens.sign({ userId: 'user-42', sessionId: 'sess-7' }));

    expect(raw.sub).toBe('user-42');
    expect(raw.jti).toBe('sess-7');
    expect(raw.role).toBe('owner');
    expect(raw.iss).toBe('securevault');
    expect(raw.aud).toBe('securevault-app');
  });

  it('defaults role to owner, the only role the domain defines', () => {
    expect(tokens.verify(tokens.sign({ userId: 'user-42' })).role).toBe(ROLES.OWNER);
  });

  it('omits jti when no session id is supplied', () => {
    const raw = jwt.decode(tokens.sign({ userId: 'user-42' }));
    expect(raw.jti).toBeUndefined();
  });

  it('coerces a numeric userId to a string subject', () => {
    expect(tokens.verify(tokens.sign({ userId: 42 })).userId).toBe('42');
  });

  it('refuses to mint a token with no userId', () => {
    expect(() => tokens.sign({})).toThrow(TypeError);
    expect(() => tokens.sign({ userId: '' })).toThrow(/userId is required/);
  });

  it('refuses to mint a token with an unknown role', () => {
    expect(() => tokens.sign({ userId: 'user-42', role: 'superuser' })).toThrow(
      /unknown role "superuser"/
    );
  });
});

describe('token expiry', () => {
  const tokens = createTokenService(config);

  it('expires after the auto-lock window', () => {
    const raw = jwt.decode(tokens.sign({ userId: 'user-42' }));
    expect(raw.exp - raw.iat).toBe(DEFAULT_TTL_SECONDS);
  });

  it('reports issuedAt and expiresAt exactly ttlSeconds apart', () => {
    const { issuedAt, expiresAt } = tokens.verify(tokens.sign({ userId: 'user-42' }));
    expect((expiresAt - issuedAt) / 1000).toBe(DEFAULT_TTL_SECONDS);
  });

  it('honours a vault-specific auto-lock window', () => {
    const shortLived = createTokenService({ ...config, ttlSeconds: 60 });
    const raw = jwt.decode(shortLived.sign({ userId: 'user-42' }));
    expect(raw.exp - raw.iat).toBe(60);
  });

  it('rejects an already-expired token', () => {
    const expired = forge({ role: 'owner' }, { subject: 'user-42', expiresIn: -1 });
    expect(() => tokens.verify(expired)).toThrow(jwt.TokenExpiredError);
  });
});

describe('token verification', () => {
  const tokens = createTokenService(config);

  it('rejects a token signed with a different key', () => {
    const forged = jwt.sign({ role: 'owner' }, 'a'.repeat(64), {
      algorithm: 'HS256',
      subject: 'attacker',
      issuer: 'securevault',
      audience: 'securevault-app',
      expiresIn: 600,
    });

    expect(() => tokens.verify(forged)).toThrow(jwt.JsonWebTokenError);
  });

  it('rejects an unsigned alg:none token', () => {
    const unsigned = jwt.sign({ role: 'owner' }, '', {
      algorithm: 'none',
      subject: 'attacker',
      issuer: 'securevault',
      audience: 'securevault-app',
    });

    expect(() => tokens.verify(unsigned)).toThrow(jwt.JsonWebTokenError);
  });

  it('rejects a token minted for a different audience', () => {
    const wrongAudience = forge(
      { role: 'owner' },
      { subject: 'user-42', audience: 'some-other-app' }
    );
    expect(() => tokens.verify(wrongAudience)).toThrow(jwt.JsonWebTokenError);
  });

  // A validly-signed token is not automatically a trusted one: our own key
  // may have signed a role we have since retired.
  it('rejects a validly-signed token carrying an unknown role', () => {
    const escalated = forge({ role: 'superuser' }, { subject: 'user-42' });
    expect(() => tokens.verify(escalated)).toThrow(/unknown role "superuser"/);
  });

  it('rejects a validly-signed token carrying no role at all', () => {
    const roleless = forge({}, { subject: 'user-42' });
    expect(() => tokens.verify(roleless)).toThrow(/unknown role/);
  });

  // jwt.verify enforces exp only when it is present. A token minted without
  // one would otherwise verify forever, and surface as an Invalid Date.
  it('rejects a validly-signed token with no exp claim', () => {
    const immortal = jwt.sign({ role: 'owner' }, TEST_KEY, {
      algorithm: 'HS256',
      subject: 'attacker',
      issuer: 'securevault',
      audience: 'securevault-app',
      noTimestamp: true,
    });

    expect(() => tokens.verify(immortal)).toThrow(/missing exp or iat/);
  });

  it('rejects a validly-signed token with no iat claim', () => {
    const noIat = jwt.sign({ role: 'owner', exp: 9999999999 }, TEST_KEY, {
      algorithm: 'HS256',
      subject: 'attacker',
      issuer: 'securevault',
      audience: 'securevault-app',
      noTimestamp: true,
    });

    expect(() => tokens.verify(noIat)).toThrow(/missing exp or iat/);
  });

  it('rejects a validly-signed token with no subject', () => {
    const subjectless = forge({ role: 'owner' });
    expect(() => tokens.verify(subjectless)).toThrow(/missing sub/);
  });

  it('rejects a token whose nbf is still in the future', () => {
    const notYet = forge({ role: 'owner' }, { subject: 'user-42', notBefore: 3600 });
    expect(() => tokens.verify(notYet)).toThrow(jwt.NotBeforeError);
  });

  it('rejects a validly-signed token with no sessionStartedAt claim', () => {
    const uncapped = jwt.sign({ role: 'owner' }, TEST_KEY, {
      algorithm: 'HS256',
      subject: 'attacker',
      issuer: 'securevault',
      audience: 'securevault-app',
      expiresIn: 600,
    });

    expect(() => tokens.verify(uncapped)).toThrow(/missing sessionStartedAt/);
  });
});

describe('sliding idle expiry', () => {
  it('renew() moves the idle deadline to ten minutes from now', () => {
    const { service, advanceSeconds } = atFixedTime();
    const auth = service.verify(service.sign({ userId: 'user-42' }));

    advanceSeconds(9 * 60);
    const renewed = service.renew(auth);

    // 9 minutes elapsed, yet the fresh deadline is a full window away.
    expect((renewed.expiresAt - auth.expiresAt) / 1000).toBe(9 * 60);
    expect(service.verify(renewed.token).expiresAt).toEqual(renewed.expiresAt);
  });

  it('keeps a session alive indefinitely while it keeps being used', () => {
    const { service, advanceSeconds } = atFixedTime();
    let auth = service.verify(service.sign({ userId: 'user-42', sessionId: 'sess-7' }));

    // Nine minutes of idling, then a request — forty times over. Well past
    // the ten-minute idle window, nowhere near the twelve-hour cap.
    for (let i = 0; i < 40; i += 1) {
      advanceSeconds(9 * 60);
      auth = service.verify(service.renew(auth).token);
    }

    expect(auth.userId).toBe('user-42');
    expect(auth.sessionId).toBe('sess-7');
  });

  it('preserves sessionStartedAt across renewals', () => {
    const { service, advanceSeconds } = atFixedTime();
    const original = service.verify(service.sign({ userId: 'user-42' }));

    advanceSeconds(60);
    const renewed = service.verify(service.renew(original).token);

    expect(renewed.sessionStartedAt).toEqual(original.sessionStartedAt);
    expect(renewed.issuedAt).not.toEqual(original.issuedAt);
  });

  it('expires a token left unused for the full idle window', () => {
    const { service, advanceSeconds } = atFixedTime();
    const token = service.sign({ userId: 'user-42' });

    advanceSeconds(DEFAULT_TTL_SECONDS + 1);
    expect(() => service.verify(token)).toThrow(jwt.TokenExpiredError);
  });

  it('still accepts a token one second before the idle window lapses', () => {
    const { service, advanceSeconds } = atFixedTime();
    const token = service.sign({ userId: 'user-42' });

    advanceSeconds(DEFAULT_TTL_SECONDS - 1);
    expect(service.verify(token).userId).toBe('user-42');
  });
});

describe('absolute session cap', () => {
  const tokens = createTokenService(config);

  // Because renew() clamps, a token issued near the cap dies *at* the cap and
  // trips ordinary idle expiry first. That is the path a real client takes.
  it('expires the last renewed token exactly when the cap is reached', () => {
    const { service, advanceSeconds } = atFixedTime();
    const auth = service.verify(service.sign({ userId: 'user-42' }));

    advanceSeconds(DEFAULT_ABSOLUTE_SESSION_SECONDS - 30);
    const nearCap = service.renew(auth);

    advanceSeconds(29);
    expect(service.verify(nearCap.token).userId).toBe('user-42');

    advanceSeconds(1);
    expect(() => service.verify(nearCap.token)).toThrow(jwt.TokenExpiredError);
  });

  // The cap check in verify() is the backstop for a token the clamp never
  // saw: one minted before the cap existed, or forged with a long lifetime.
  it('rejects an unexpired token whose session began before the cap', () => {
    const stale = forge(
      {
        role: 'owner',
        sessionStartedAt: Math.floor(Date.now() / 1000) - DEFAULT_ABSOLUTE_SESSION_SECONDS - 1,
      },
      { subject: 'user-42', expiresIn: 600 }
    );

    expect(() => tokens.verify(stale)).toThrow(SessionExpiredError);
  });

  it('refuses to renew a session that has reached the cap', () => {
    const { service, advanceSeconds } = atFixedTime();
    const auth = service.verify(service.sign({ userId: 'user-42' }));

    advanceSeconds(DEFAULT_ABSOLUTE_SESSION_SECONDS);
    expect(() => service.renew(auth)).toThrow(SessionExpiredError);
  });

  // The clamp: near the cap, a renewed token must die at the cap, not ten
  // minutes after it.
  it('clamps a renewed token to the cap rather than overshooting it', () => {
    const { service, advanceSeconds, nowSeconds } = atFixedTime();
    const auth = service.verify(service.sign({ userId: 'user-42' }));
    const capAt = Math.floor(auth.sessionStartedAt.getTime() / 1000) + DEFAULT_ABSOLUTE_SESSION_SECONDS;

    // One minute of cap remaining, but the idle window is ten.
    advanceSeconds(DEFAULT_ABSOLUTE_SESSION_SECONDS - 60);
    const renewed = service.renew(auth);

    expect(Math.floor(renewed.expiresAt.getTime() / 1000)).toBe(capAt);
    expect(Math.floor(renewed.expiresAt.getTime() / 1000) - nowSeconds()).toBe(60);
  });

  it('honours a shorter cap when configured', () => {
    const { service, advanceSeconds } = atFixedTime(1_700_000_000_000, { absoluteMaxSeconds: 120 });
    const auth = service.verify(service.sign({ userId: 'user-42' }));

    advanceSeconds(119);
    expect(service.verify(service.renew(auth).token).userId).toBe('user-42');

    advanceSeconds(1);
    expect(() => service.renew(auth)).toThrow(SessionExpiredError);
  });
});
