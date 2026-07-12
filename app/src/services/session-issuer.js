const { createTokenService, ROLES } = require('./token-service');
const { createDeviceService } = require('./device-service');

// A session token is only ever minted at the end of UC-01: master password
// verified, then second factor verified. That ordering is enforced by the
// shape of this module rather than by convention — `issueSessionToken` takes
// a proof it cannot construct, and `verifyTwoFactorCode` takes a proof only
// `verifyMasterPassword` can produce. There is no argument a caller can
// fabricate that skips a step.
//
// Proofs are held in a module-private WeakSet: an object is a genuine proof
// only if this module minted it. A caller can copy the shape of one, but a
// literal `{ userId: 'admin', factor: '2fa' }` is not in the set.
const genuineProofs = new WeakSet();

// A proof is a receipt for a check that just happened, not a credential to
// keep. Five minutes is long enough to read a TOTP code off a phone and
// short enough that a proof captured from a crashed flow is worthless.
const DEFAULT_PROOF_TTL_SECONDS = 5 * 60;

const FACTOR = Object.freeze({ PASSWORD: 'password', TWO_FACTOR: 'two-factor' });

class AuthenticationError extends Error {
  // `code` is for the audit log; `message` is safe to return to the client.
  // Both factors fail with the same message so the response cannot be used
  // as an oracle for which half of the credentials was correct.
  constructor(code, message = 'Authentication failed') {
    super(message);
    this.name = 'AuthenticationError';
    this.code = code;
  }
}

function mintProof({ factor, userId, role, issuedAtSeconds }) {
  const proof = Object.freeze({ factor, userId, role, issuedAtSeconds });
  genuineProofs.add(proof);
  return proof;
}

// Proofs are single-use: consuming one removes it from the set, so a captured
// proof cannot be replayed to mint a second token or re-run a factor.
function consumeProof(proof, { expectedFactor, nowSeconds, ttlSeconds }) {
  if (typeof proof !== 'object' || proof === null || !genuineProofs.has(proof)) {
    throw new AuthenticationError('PROOF_INVALID');
  }
  if (proof.factor !== expectedFactor) {
    throw new AuthenticationError('PROOF_WRONG_FACTOR');
  }
  if (nowSeconds - proof.issuedAtSeconds > ttlSeconds) {
    genuineProofs.delete(proof);
    throw new AuthenticationError('PROOF_EXPIRED');
  }

  genuineProofs.delete(proof);
  return proof;
}

/**
 * @param verifyPassword   (masterPasswordHash, password) => Promise<boolean>
 *                         Must be a constant-time comparison (bcrypt/argon2).
 * @param verifyTwoFactorCode (twoFactorConfig, code) => Promise<boolean>
 *                         Wraps TwoFactorConfig.verifyCode() / the external
 *                         AuthenticationService.
 * @param onDeviceSeen     ({ userId, deviceId, known, sessionId }) => void
 *                         Writes the AuditEntry and, for an unrecognised
 *                         device, raises a SecurityAlert. Required: device
 *                         recognition exists only to feed this, so an issuer
 *                         with nowhere to report to would be doing nothing.
 */
function createSessionIssuer({
  tokenService,
  deviceService,
  verifyPassword,
  verifyTwoFactorCode,
  onDeviceSeen,
  clock = () => Date.now(),
  proofTtlSeconds = DEFAULT_PROOF_TTL_SECONDS,
} = {}) {
  // Argument checks come first. The service defaults below read the
  // environment, so constructing them eagerly would report a missing
  // JWT_SIGNING_KEY to a caller whose actual mistake was a missing port.
  if (typeof verifyPassword !== 'function') {
    throw new TypeError('verifyPassword is required');
  }
  if (typeof verifyTwoFactorCode !== 'function') {
    throw new TypeError('verifyTwoFactorCode is required');
  }
  if (typeof onDeviceSeen !== 'function') {
    throw new TypeError('onDeviceSeen is required');
  }

  const tokens = tokenService ?? createTokenService();
  const devices = deviceService ?? createDeviceService();

  const nowSeconds = () => Math.floor(clock() / 1000);

  return {
    async verifyMasterPassword({ user, password } = {}) {
      if (!user || !user.userId) {
        throw new TypeError('user is required');
      }

      // Refuse before touching the hash: a locked account must not be a
      // password oracle, and must not have its lockout window refreshed.
      // Counting failures toward the five-attempt limit is the caller's job
      // (it owns the User row) — this only honours the resulting flag.
      if (user.isLocked) {
        throw new AuthenticationError('ACCOUNT_LOCKED', 'Account is locked');
      }

      if (!(await verifyPassword(user.masterPasswordHash, password))) {
        throw new AuthenticationError('INVALID_CREDENTIALS');
      }

      return mintProof({
        factor: FACTOR.PASSWORD,
        userId: user.userId,
        role: user.role ?? ROLES.OWNER,
        issuedAtSeconds: nowSeconds(),
      });
    },

    async verifyTwoFactorCode({ proof, user, code } = {}) {
      const passwordProof = consumeProof(proof, {
        expectedFactor: FACTOR.PASSWORD,
        nowSeconds: nowSeconds(),
        ttlSeconds: proofTtlSeconds,
      });

      if (!user || user.userId !== passwordProof.userId) {
        throw new AuthenticationError('PROOF_USER_MISMATCH');
      }

      // UC-01's precondition is "2FA set up". A user without an enabled
      // second factor does not skip this step — they cannot log in at all.
      // Treating a missing config as "nothing to check" would be the bypass
      // this whole module exists to prevent.
      if (!user.twoFactorConfig || !user.twoFactorConfig.enabled) {
        throw new AuthenticationError(
          'TWO_FACTOR_NOT_ENABLED',
          'Two-factor authentication is not set up'
        );
      }

      if (!(await verifyTwoFactorCode(user.twoFactorConfig, code))) {
        throw new AuthenticationError('INVALID_TWO_FACTOR');
      }

      return mintProof({
        factor: FACTOR.TWO_FACTOR,
        userId: passwordProof.userId,
        role: passwordProof.role,
        issuedAtSeconds: nowSeconds(),
      });
    },

    // The only path to a session token. Reachable only with a two-factor
    // proof, which is reachable only with a password proof.
    //
    // The device check happens here, after both factors and before the token
    // exists. It never decides *whether* to issue — 2FA has already run
    // unconditionally (business rule 4 read as "a new device is worth
    // telling the user about", not "an old device may skip a factor"; see
    // UC-01, which branches nowhere). It only decides what gets recorded.
    //
    // async so `onDeviceSeen` can be awaited: it writes an AuditEntry, and
    // services/audit-log.js's own failure policy — never fire-and-forget a
    // write whose rejection would otherwise surface as an unhandledRejection
    // after the caller has already moved on — only holds if this method's
    // caller can await it too. Every caller does (routes/session.js,
    // tests/session-issuer.test.js).
    async issueSessionToken({ proof, sessionId, deviceToken } = {}) {
      const twoFactorProof = consumeProof(proof, {
        expectedFactor: FACTOR.TWO_FACTOR,
        nowSeconds: nowSeconds(),
        ttlSeconds: proofTtlSeconds,
      });

      const { userId, role } = twoFactorProof;
      const seen = devices.recognize({ userId, deviceToken });
      const device = seen.known ? seen : { known: false, ...devices.issue(userId) };

      // Deliberately before the token is minted, and deliberately not caught:
      // UC-01's post-condition is "login logged", and the audit log is
      // append-only (business rule 7). If the sighting cannot be recorded,
      // the login does not happen. An unlogged login is worse than a failed
      // one.
      await onDeviceSeen({ userId, deviceId: device.deviceId, known: device.known, sessionId });

      return {
        token: tokens.sign({ userId, role, sessionId }),
        device,
      };
    },
  };
}

module.exports = {
  createSessionIssuer,
  AuthenticationError,
  DEFAULT_PROOF_TTL_SECONDS,
};
