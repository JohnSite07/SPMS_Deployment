const jwt = require('jsonwebtoken');
const {
  createDeviceService,
  DEVICE_AUDIENCE,
  DEVICE_TOKEN_TTL_SECONDS,
} = require('../src/services/device-service');
const { createTokenService } = require('../src/services/token-service');

const TEST_KEY = 'k'.repeat(64);
const config = { signingKey: TEST_KEY, issuer: 'securevault' };

function atFixedTime(startMillis = 1_700_000_000_000) {
  let now = startMillis;
  return {
    service: createDeviceService({ ...config, clock: () => now }),
    advanceSeconds: (s) => (now += s * 1000),
  };
}

describe('issue', () => {
  const devices = createDeviceService(config);

  it('mints a distinct identity per device', () => {
    const a = devices.issue('user-42');
    const b = devices.issue('user-42');

    expect(a.deviceId).not.toBe(b.deviceId);
    expect(a.token).not.toBe(b.token);
  });

  it('binds the token to the user and to the device audience', () => {
    const { deviceId, token } = devices.issue('user-42');
    const claims = jwt.decode(token);

    expect(claims.sub).toBe('user-42');
    expect(claims.jti).toBe(deviceId);
    expect(claims.aud).toBe(DEVICE_AUDIENCE);
  });
});

describe('recognize', () => {
  const devices = createDeviceService(config);

  it('recognises a token it issued', () => {
    const { deviceId, token } = devices.issue('user-42');
    expect(devices.recognize({ userId: 'user-42', deviceToken: token })).toEqual({
      known: true,
      deviceId,
    });
  });

  // Recognition informs; it must never deny or crash a login.
  it.each([
    ['no token', undefined],
    ['null', null],
    ['empty string', ''],
    ['garbage', 'not-a-token'],
    ['a number', 12345],
    ['a truncated token', 'eyJhbGciOiJIUzI1NiJ9.e30'],
  ])('reports "unknown" for %s without throwing', (_name, deviceToken) => {
    expect(() => devices.recognize({ userId: 'user-42', deviceToken })).not.toThrow();
    expect(devices.recognize({ userId: 'user-42', deviceToken }).known).toBe(false);
  });

  it('reports "unknown" when called with no arguments at all', () => {
    expect(devices.recognize().known).toBe(false);
  });

  it('does not recognise a device token issued to another user', () => {
    const { token } = devices.issue('user-99');
    expect(devices.recognize({ userId: 'user-42', deviceToken: token }).known).toBe(false);
  });

  it('does not recognise a token signed with a different key', () => {
    const forged = jwt.sign({}, 'a'.repeat(64), {
      algorithm: 'HS256',
      subject: 'user-42',
      issuer: 'securevault',
      audience: DEVICE_AUDIENCE,
      jwtid: 'forged-device',
      expiresIn: 600,
    });

    expect(devices.recognize({ userId: 'user-42', deviceToken: forged }).known).toBe(false);
  });

  it('does not recognise an alg:none token', () => {
    const unsigned = jwt.sign({}, '', {
      algorithm: 'none',
      subject: 'user-42',
      issuer: 'securevault',
      audience: DEVICE_AUDIENCE,
      jwtid: 'forged-device',
    });

    expect(devices.recognize({ userId: 'user-42', deviceToken: unsigned }).known).toBe(false);
  });

  // Audience separation: the two token families share a signing key, so this
  // is the only thing stopping one being presented as the other.
  it('does not accept a session token as a device token', () => {
    const sessions = createTokenService({
      ...config,
      audience: 'securevault-app',
      ttlSeconds: 600,
    });
    const sessionToken = sessions.sign({ userId: 'user-42', sessionId: 'sess-1' });

    expect(devices.recognize({ userId: 'user-42', deviceToken: sessionToken }).known).toBe(false);
  });

  it('does not accept a device token as a session token', () => {
    const sessions = createTokenService({
      ...config,
      audience: 'securevault-app',
      ttlSeconds: 600,
    });
    const { token } = devices.issue('user-42');

    expect(() => sessions.verify(token)).toThrow(jwt.JsonWebTokenError);
  });

  it('stops recognising a device once its token expires', () => {
    const { service, advanceSeconds } = atFixedTime();
    const { token } = service.issue('user-42');

    advanceSeconds(DEVICE_TOKEN_TTL_SECONDS - 1);
    expect(service.recognize({ userId: 'user-42', deviceToken: token }).known).toBe(true);

    advanceSeconds(2);
    expect(service.recognize({ userId: 'user-42', deviceToken: token }).known).toBe(false);
  });
});
