const jwt = require('jsonwebtoken');
const { createTokenService, SessionExpiredError } = require('../src/services/token-service');

// Structural attacks on the token itself — tampering, splicing, malformed
// input — and the exact expiry boundary. Claim-level rules (unknown role,
// missing exp/iat/sub/sessionStartedAt, wrong audience) live in
// token-service.test.js; the HTTP-facing 401 behaviour lives in
// authenticate.test.js.

const TEST_KEY = 'k'.repeat(64);
const OTHER_KEY = 'a'.repeat(64);
const BASE = {
  signingKey: TEST_KEY,
  issuer: 'securevault',
  audience: 'securevault-app',
  ttlSeconds: 600,
};

const START_MILLIS = 1_700_000_000_000;
const START_SECONDS = START_MILLIS / 1000;

// A service whose clock we control. Both minting and verification read it,
// so expiry can be walked second by second.
function atFixedTime() {
  let now = START_MILLIS;
  return {
    service: createTokenService({ ...BASE, clock: () => now }),
    at: (offsetSeconds) => {
      now = START_MILLIS + offsetSeconds * 1000;
    },
  };
}

const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const decode = (segment) => JSON.parse(Buffer.from(segment, 'base64url'));
const parts = (token) => token.split('.');

describe('valid tokens', () => {
  const tokens = createTokenService(BASE);

  it('verifies a token it just minted', () => {
    const auth = tokens.verify(tokens.sign({ userId: 'user-42', sessionId: 'sess-7' }));

    expect(auth.userId).toBe('user-42');
    expect(auth.sessionId).toBe('sess-7');
    expect(auth.role).toBe('owner');
  });

  it('verifies a token produced by renew()', () => {
    const auth = tokens.verify(tokens.sign({ userId: 'user-42' }));
    const renewed = tokens.renew(auth);

    expect(tokens.verify(renewed.token).userId).toBe('user-42');
  });

  it('accepts a token one second before it expires', () => {
    const { service, at } = atFixedTime();
    const token = service.sign({ userId: 'user-42' });

    at(599);
    expect(service.verify(token).userId).toBe('user-42');
  });

  it('is not fooled into rejecting a token whose signature contains dots-safe base64url', () => {
    // base64url never emits '.', '+' or '/', so a three-segment split is
    // unambiguous. Mint a batch and assert the invariant rather than trusting it.
    for (let i = 0; i < 50; i += 1) {
      const token = tokens.sign({ userId: `user-${i}`, sessionId: `sess-${i}` });
      expect(parts(token)).toHaveLength(3);
      expect(tokens.verify(token).userId).toBe(`user-${i}`);
    }
  });
});

describe('expired tokens', () => {
  it('rejects a token exactly at its expiry second', () => {
    const { service, at } = atFixedTime();
    const token = service.sign({ userId: 'user-42' });

    at(600);
    expect(() => service.verify(token)).toThrow(jwt.TokenExpiredError);
  });

  it('rejects a token past its expiry', () => {
    const { service, at } = atFixedTime();
    const token = service.sign({ userId: 'user-42' });

    at(601);
    expect(() => service.verify(token)).toThrow(jwt.TokenExpiredError);
  });

  // Pinned deliberately: jsonwebtoken's clockTolerance defaults to 0, and a
  // non-zero tolerance would silently extend every session past its window.
  it('allows no clock tolerance at the boundary', () => {
    const { service, at } = atFixedTime();
    const token = service.sign({ userId: 'user-42' });

    at(599);
    expect(() => service.verify(token)).not.toThrow();
    at(600);
    expect(() => service.verify(token)).toThrow(jwt.TokenExpiredError);
  });

  it('reports expiry, not a generic failure, so the client can re-authenticate', () => {
    const { service, at } = atFixedTime();
    const token = service.sign({ userId: 'user-42' });

    at(700);
    try {
      service.verify(token);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.name).toBe('TokenExpiredError');
      expect(err).not.toBeInstanceOf(SessionExpiredError);
    }
  });

  it('rejects an expired token even when every other claim is correct', () => {
    const { service, at } = atFixedTime();
    const token = service.sign({ userId: 'user-42', sessionId: 'sess-7' });

    at(600);
    // Same issuer, audience, role, subject, signature — only time moved.
    expect(decode(parts(token)[1])).toMatchObject({
      iss: 'securevault',
      aud: 'securevault-app',
      role: 'owner',
      sub: 'user-42',
    });
    expect(() => service.verify(token)).toThrow(jwt.TokenExpiredError);
  });

  it('an expired token cannot be renewed back to life', () => {
    const { service, at } = atFixedTime();
    const token = service.sign({ userId: 'user-42' });

    at(601);
    // renew() takes verify()'s output, and verify() is the thing that fails.
    expect(() => service.renew(service.verify(token))).toThrow(jwt.TokenExpiredError);
  });
});

describe('forged tokens', () => {
  const tokens = createTokenService(BASE);
  const genuine = () => tokens.sign({ userId: 'user-42', sessionId: 'sess-7' });

  // The classic forgery: rewrite the claims, keep the signature that was
  // computed over the original ones.
  it('rejects an escalated payload carrying the original signature', () => {
    const [header, payload, signature] = parts(genuine());
    const escalated = encode({ ...decode(payload), role: 'admin' });

    expect(() => tokens.verify(`${header}.${escalated}.${signature}`)).toThrow(
      /invalid signature/
    );
  });

  it('rejects a substituted subject carrying the original signature', () => {
    const [header, payload, signature] = parts(genuine());
    const impersonated = encode({ ...decode(payload), sub: 'user-99' });

    expect(() => tokens.verify(`${header}.${impersonated}.${signature}`)).toThrow(
      /invalid signature/
    );
  });

  it('rejects an extended expiry carrying the original signature', () => {
    const [header, payload, signature] = parts(genuine());
    const immortal = encode({ ...decode(payload), exp: 9_999_999_999 });

    expect(() => tokens.verify(`${header}.${immortal}.${signature}`)).toThrow(
      /invalid signature/
    );
  });

  // Both tokens are real and signed with the real key; the signature still
  // does not transfer, because it covers the header and payload.
  it('rejects a signature spliced from another genuine token', () => {
    const [header, payload] = parts(genuine());
    const attackerSignature = parts(tokens.sign({ userId: 'attacker' }))[2];

    expect(() => tokens.verify(`${header}.${payload}.${attackerSignature}`)).toThrow(
      /invalid signature/
    );
  });

  it('rejects a payload spliced from another genuine token', () => {
    const [header, , signature] = parts(genuine());
    const attackerPayload = parts(tokens.sign({ userId: 'attacker' }))[1];

    expect(() => tokens.verify(`${header}.${attackerPayload}.${signature}`)).toThrow(
      /invalid signature/
    );
  });

  it('rejects a token signed with a different key', () => {
    const forged = jwt.sign({ role: 'owner', sessionStartedAt: START_SECONDS }, OTHER_KEY, {
      algorithm: 'HS256',
      subject: 'attacker',
      issuer: 'securevault',
      audience: 'securevault-app',
      expiresIn: 600,
    });

    expect(() => tokens.verify(forged)).toThrow(/invalid signature/);
  });

  // The algorithms allowlist, from two directions.
  it('rejects a header downgraded to alg:none with the signature left in place', () => {
    const [, payload, signature] = parts(genuine());
    const noneHeader = encode({ alg: 'none', typ: 'JWT' });

    expect(() => tokens.verify(`${noneHeader}.${payload}.${signature}`)).toThrow(
      /invalid algorithm/
    );
  });

  it('rejects a header downgraded to alg:none with the signature stripped', () => {
    const [, payload] = parts(genuine());
    const noneHeader = encode({ alg: 'none', typ: 'JWT' });

    expect(() => tokens.verify(`${noneHeader}.${payload}.`)).toThrow(jwt.JsonWebTokenError);
  });

  it('rejects a header claiming an algorithm we do not allow', () => {
    const [, payload, signature] = parts(genuine());
    const hs512 = encode({ alg: 'HS512', typ: 'JWT' });

    expect(() => tokens.verify(`${hs512}.${payload}.${signature}`)).toThrow(/invalid algorithm/);
  });

  it.each([
    ['an empty string', ''],
    ['a single segment', 'onlyonesegment'],
    ['two segments', 'aaa.bbb'],
    ['four segments', 'aaa.bbb.ccc.ddd'],
    ['bare separators', '...'],
    ['non-base64 segments', '!!!.???.***'],
    ['a truncated token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0'],
  ])('rejects %s as malformed', (_name, token) => {
    expect(() => tokens.verify(token)).toThrow(jwt.JsonWebTokenError);
  });

  it.each([null, undefined, 42, {}, []])('rejects %p rather than crashing', (token) => {
    expect(() => tokens.verify(token)).toThrow(jwt.JsonWebTokenError);
  });

  it('never returns a payload for any forged variant', () => {
    const [header, payload, signature] = parts(genuine());
    const forgeries = [
      `${header}.${encode({ ...decode(payload), role: 'admin' })}.${signature}`,
      `${encode({ alg: 'none', typ: 'JWT' })}.${payload}.${signature}`,
      `${header}.${payload}.${parts(tokens.sign({ userId: 'attacker' }))[2]}`,
      'aaa.bbb.ccc',
    ];

    for (const forged of forgeries) {
      let result = 'threw';
      try {
        result = tokens.verify(forged);
      } catch {
        // expected
      }
      expect(result).toBe('threw');
    }
  });
});
