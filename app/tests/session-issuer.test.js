const { createTokenService } = require('../src/services/token-service');
const { createDeviceService } = require('../src/services/device-service');
const {
  createSessionIssuer,
  AuthenticationError,
  DEFAULT_PROOF_TTL_SECONDS,
} = require('../src/services/session-issuer');

const TEST_KEY = 'k'.repeat(64);
const tokenService = createTokenService({
  signingKey: TEST_KEY,
  issuer: 'securevault',
  audience: 'securevault-app',
  ttlSeconds: 600,
});
const deviceService = createDeviceService({ signingKey: TEST_KEY, issuer: 'securevault' });

const USER = Object.freeze({
  userId: 'user-42',
  masterPasswordHash: 'hash-of-correct-password',
  isLocked: false,
  twoFactorConfig: { method: 'TOTP', secret: 's3cret', enabled: true },
});

// Stand-ins for bcrypt.compare and TwoFactorConfig.verifyCode.
const verifyPassword = async (hash, password) =>
  hash === 'hash-of-correct-password' && password === 'correct-horse-battery';
const verifyTwoFactorCode = async (config, code) =>
  config.secret === 's3cret' && code === '123456';

function build(overrides = {}) {
  let now = 1_700_000_000_000;
  const onDeviceSeen = jest.fn();
  const issuer = createSessionIssuer({
    tokenService,
    deviceService,
    verifyPassword,
    verifyTwoFactorCode,
    onDeviceSeen,
    clock: () => now,
    ...overrides,
  });
  return { issuer, onDeviceSeen, advanceSeconds: (s) => (now += s * 1000) };
}

async function loginTo2fa(issuer, user = USER) {
  return issuer.verifyMasterPassword({ user, password: 'correct-horse-battery' });
}
async function loginToProof(issuer, user = USER) {
  const proof = await loginTo2fa(issuer, user);
  return issuer.verifyTwoFactorCode({ proof, user, code: '123456' });
}

describe('happy path', () => {
  it('issues a verifiable token after password then 2FA', async () => {
    const { issuer } = build();
    const { token } = issuer.issueSessionToken({
      proof: await loginToProof(issuer),
      sessionId: 'sess-7',
    });

    expect(tokenService.verify(token)).toMatchObject({
      userId: 'user-42',
      role: 'owner',
      sessionId: 'sess-7',
    });
  });
});

describe('the password factor cannot be skipped', () => {
  it('rejects a forged proof object of the right shape', async () => {
    const { issuer } = build();
    const forged = { factor: 'two-factor', userId: 'user-42', role: 'owner', issuedAtSeconds: 1_700_000_000 };

    expect(() => issuer.issueSessionToken({ proof: forged })).toThrow(AuthenticationError);
    expect(() => issuer.issueSessionToken({ proof: forged })).toThrow(
      expect.objectContaining({ code: 'PROOF_INVALID' })
    );
  });

  it.each([undefined, null, 'proof', 42, {}, []])('rejects %p as a proof', (proof) => {
    const { issuer } = build();
    expect(() => issuer.issueSessionToken({ proof })).toThrow(
      expect.objectContaining({ code: 'PROOF_INVALID' })
    );
  });

  it('rejects a wrong master password', async () => {
    const { issuer } = build();
    await expect(
      issuer.verifyMasterPassword({ user: USER, password: 'wrong' })
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_CREDENTIALS' }));
  });
});

describe('the 2FA factor cannot be skipped', () => {
  it('refuses to issue a token from a password proof alone', async () => {
    const { issuer } = build();
    const passwordProof = await loginTo2fa(issuer);

    expect(() => issuer.issueSessionToken({ proof: passwordProof })).toThrow(
      expect.objectContaining({ code: 'PROOF_WRONG_FACTOR' })
    );
  });

  it('rejects a wrong 2FA code', async () => {
    const { issuer } = build();
    const proof = await loginTo2fa(issuer);

    await expect(
      issuer.verifyTwoFactorCode({ proof, user: USER, code: '000000' })
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_TWO_FACTOR' }));
  });

  it('refuses login outright when 2FA is not enabled, rather than skipping it', async () => {
    const { issuer } = build();
    const user = { ...USER, twoFactorConfig: { ...USER.twoFactorConfig, enabled: false } };
    const proof = await loginTo2fa(issuer, user);

    await expect(
      issuer.verifyTwoFactorCode({ proof, user, code: '123456' })
    ).rejects.toThrow(expect.objectContaining({ code: 'TWO_FACTOR_NOT_ENABLED' }));
  });

  it('refuses login when the user has no 2FA config at all', async () => {
    const { issuer } = build();
    const user = { ...USER, twoFactorConfig: undefined };
    const proof = await loginTo2fa(issuer, user);

    await expect(
      issuer.verifyTwoFactorCode({ proof, user, code: '123456' })
    ).rejects.toThrow(expect.objectContaining({ code: 'TWO_FACTOR_NOT_ENABLED' }));
  });
});

describe('proofs are single-use', () => {
  it('will not mint two tokens from one 2FA proof', async () => {
    const { issuer } = build();
    const proof = await loginToProof(issuer);

    expect(issuer.issueSessionToken({ proof }).token).toEqual(expect.any(String));
    expect(() => issuer.issueSessionToken({ proof })).toThrow(
      expect.objectContaining({ code: 'PROOF_INVALID' })
    );
  });

  it('will not replay a password proof through the 2FA step twice', async () => {
    const { issuer } = build();
    const proof = await loginTo2fa(issuer);

    await issuer.verifyTwoFactorCode({ proof, user: USER, code: '123456' });
    await expect(
      issuer.verifyTwoFactorCode({ proof, user: USER, code: '123456' })
    ).rejects.toThrow(expect.objectContaining({ code: 'PROOF_INVALID' }));
  });
});

describe('proofs expire', () => {
  it('rejects a password proof older than the ttl', async () => {
    const { issuer, advanceSeconds } = build();
    const proof = await loginTo2fa(issuer);

    advanceSeconds(DEFAULT_PROOF_TTL_SECONDS + 1);
    await expect(
      issuer.verifyTwoFactorCode({ proof, user: USER, code: '123456' })
    ).rejects.toThrow(expect.objectContaining({ code: 'PROOF_EXPIRED' }));
  });

  it('rejects a 2FA proof older than the ttl', async () => {
    const { issuer, advanceSeconds } = build();
    const proof = await loginToProof(issuer);

    advanceSeconds(DEFAULT_PROOF_TTL_SECONDS + 1);
    expect(() => issuer.issueSessionToken({ proof })).toThrow(
      expect.objectContaining({ code: 'PROOF_EXPIRED' })
    );
  });

  it('accepts a proof still inside the ttl', async () => {
    const { issuer, advanceSeconds } = build();
    const proof = await loginToProof(issuer);

    advanceSeconds(DEFAULT_PROOF_TTL_SECONDS - 1);
    expect(issuer.issueSessionToken({ proof }).token).toEqual(expect.any(String));
  });
});

describe('account lockout', () => {
  it('refuses a locked account without consulting the password', async () => {
    const { issuer } = build({ verifyPassword: () => { throw new Error('must not be called'); } });

    await expect(
      issuer.verifyMasterPassword({ user: { ...USER, isLocked: true }, password: 'correct-horse-battery' })
    ).rejects.toThrow(expect.objectContaining({ code: 'ACCOUNT_LOCKED' }));
  });
});

describe('a proof is bound to its user', () => {
  it('rejects a proof presented alongside a different user', async () => {
    const { issuer } = build();
    const proof = await loginTo2fa(issuer);

    await expect(
      issuer.verifyTwoFactorCode({ proof, user: { ...USER, userId: 'user-99' }, code: '123456' })
    ).rejects.toThrow(expect.objectContaining({ code: 'PROOF_USER_MISMATCH' }));
  });
});

describe('failures do not leak which factor was wrong', () => {
  it('returns the same client-facing message for a bad password and a bad code', async () => {
    const { issuer } = build();
    const badPassword = await issuer
      .verifyMasterPassword({ user: USER, password: 'wrong' })
      .catch((e) => e);

    const proof = await loginTo2fa(issuer);
    const badCode = await issuer
      .verifyTwoFactorCode({ proof, user: USER, code: '000000' })
      .catch((e) => e);

    expect(badPassword.message).toBe('Authentication failed');
    expect(badCode.message).toBe(badPassword.message);
    expect(badCode.code).not.toBe(badPassword.code);
  });
});

describe('wiring', () => {
  const onDeviceSeen = () => {};

  it('requires both verifier ports', () => {
    expect(() =>
      createSessionIssuer({ tokenService, verifyTwoFactorCode, onDeviceSeen })
    ).toThrow(/verifyPassword is required/);
    expect(() => createSessionIssuer({ tokenService, verifyPassword, onDeviceSeen })).toThrow(
      /verifyTwoFactorCode is required/
    );
  });

  // Recognition exists only to feed the audit log. An issuer with nowhere to
  // report a new device would silently do nothing.
  it('requires somewhere to report a device sighting', () => {
    expect(() =>
      createSessionIssuer({ tokenService, verifyPassword, verifyTwoFactorCode })
    ).toThrow(/onDeviceSeen is required/);
  });
});

describe('new-device check', () => {
  it('treats a login with no device token as a new device', async () => {
    const { issuer, onDeviceSeen } = build();
    const result = issuer.issueSessionToken({ proof: await loginToProof(issuer), sessionId: 's1' });

    expect(result.device.known).toBe(false);
    expect(result.device.token).toEqual(expect.any(String));
    expect(onDeviceSeen).toHaveBeenCalledWith({
      userId: 'user-42',
      deviceId: result.device.deviceId,
      known: false,
      sessionId: 's1',
    });
  });

  it('recognises the same device on a later login and mints no new identity', async () => {
    const { issuer, onDeviceSeen } = build();
    const first = issuer.issueSessionToken({ proof: await loginToProof(issuer) });

    const second = issuer.issueSessionToken({
      proof: await loginToProof(issuer),
      deviceToken: first.device.token,
    });

    expect(second.device.known).toBe(true);
    expect(second.device.deviceId).toBe(first.device.deviceId);
    expect(second.device.token).toBeUndefined();
    expect(onDeviceSeen).toHaveBeenLastCalledWith(
      expect.objectContaining({ known: true, deviceId: first.device.deviceId })
    );
  });

  // The property the whole design rests on: 2FA already ran, unconditionally.
  it('still requires 2FA on a recognised device', async () => {
    const { issuer } = build();
    const first = issuer.issueSessionToken({ proof: await loginToProof(issuer) });

    // Password only, on the known device: still refused.
    const passwordProof = await loginTo2fa(issuer);
    expect(() =>
      issuer.issueSessionToken({ proof: passwordProof, deviceToken: first.device.token })
    ).toThrow(expect.objectContaining({ code: 'PROOF_WRONG_FACTOR' }));
  });

  it.each([
    ['a garbage device token', 'not-a-token'],
    ['an empty device token', ''],
    ['a non-string device token', 12345],
    ['a device token signed with another key', 'eyJhbGciOiJIUzI1NiJ9.e30.bad'],
  ])('falls back to "new device" for %s, never an error', async (_name, deviceToken) => {
    const { issuer } = build();
    const result = issuer.issueSessionToken({ proof: await loginToProof(issuer), deviceToken });

    expect(result.device.known).toBe(false);
    expect(result.token).toEqual(expect.any(String));
  });

  it('does not recognise another user\'s device token', async () => {
    const { issuer } = build();
    const other = deviceService.issue('user-99');

    const result = issuer.issueSessionToken({
      proof: await loginToProof(issuer),
      deviceToken: other.token,
    });

    expect(result.device.known).toBe(false);
    expect(result.device.deviceId).not.toBe(other.deviceId);
  });

  it('does not accept a session token as a device token', async () => {
    const { issuer } = build();
    const sessionToken = tokenService.sign({ userId: 'user-42' });

    const result = issuer.issueSessionToken({
      proof: await loginToProof(issuer),
      deviceToken: sessionToken,
    });

    expect(result.device.known).toBe(false);
  });

  // Audit is append-only and UC-01's post-condition is "login logged".
  it('issues no token if the sighting cannot be recorded', async () => {
    const { issuer } = build({
      onDeviceSeen: () => {
        throw new Error('audit log unavailable');
      },
    });

    expect(() => issuer.issueSessionToken({ proof: null })).toThrow();
    await expect(
      loginToProof(issuer).then((proof) => issuer.issueSessionToken({ proof }))
    ).rejects.toThrow(/audit log unavailable/);
  });

  it('records the sighting before the session token exists', async () => {
    const calls = [];
    const { issuer } = build({
      onDeviceSeen: () => calls.push('recorded'),
      tokenService: {
        sign: (...args) => {
          calls.push('signed');
          return tokenService.sign(...args);
        },
        verify: tokenService.verify,
      },
    });

    issuer.issueSessionToken({ proof: await loginToProof(issuer) });
    expect(calls).toEqual(['recorded', 'signed']);
  });
});
