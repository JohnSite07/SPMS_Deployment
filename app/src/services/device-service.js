const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { loadJwtConfig } = require('../config/env');

const ALGORITHM = 'HS256';

// A device is identified by a signed token the client stores — a secret it
// *holds* — never by User-Agent, IP, or any other attribute the request
// merely *asserts* about itself. Those are attacker-controlled: an attacker
// with a stolen master password would replay them and be waved through as a
// known device. Under business rule 4 as implemented here that would only
// suppress an alert, but the same mistake in a design where "known device"
// skips 2FA turns a two-factor login into a one-factor login.
//
// Distinct audience from session tokens, so neither can be presented where
// the other is expected. Same signing key: adding a seventh Secret Manager
// secret is DevOps's lane (see terraform/modules/secrets/), and the audience
// separation is what actually prevents token confusion.
const DEVICE_AUDIENCE = 'securevault-device';

// Long-lived by nature — the point is to remember a device across logins.
const DEVICE_TOKEN_TTL_SECONDS = 400 * 24 * 60 * 60;

function createDeviceService(config = loadJwtConfig()) {
  const { signingKey, issuer, clock = () => Date.now() } = config;
  const nowSeconds = () => Math.floor(clock() / 1000);

  return {
    // Mints a fresh identity for a device we have not seen before. Called
    // only after both factors have already passed, so a device token is
    // never handed to an unauthenticated caller.
    issue(userId) {
      const deviceId = crypto.randomUUID();
      const now = nowSeconds();

      const token = jwt.sign({ iat: now }, signingKey, {
        algorithm: ALGORITHM,
        subject: String(userId),
        issuer,
        audience: DEVICE_AUDIENCE,
        jwtid: deviceId,
        expiresIn: DEVICE_TOKEN_TTL_SECONDS,
      });

      return { deviceId, token, expiresAt: new Date((now + DEVICE_TOKEN_TTL_SECONDS) * 1000) };
    },

    // Never throws, and never denies a login. A missing, expired, forged, or
    // wrong-user device token is simply an unrecognised device. Recognition
    // is a signal for the audit log, not a gate on authentication — so its
    // failure mode must be "tell the user about a new device", never "lock
    // the user out" and never "skip a factor".
    recognize({ userId, deviceToken } = {}) {
      if (typeof deviceToken !== 'string' || deviceToken === '') {
        return { known: false };
      }

      let claims;
      try {
        claims = jwt.verify(deviceToken, signingKey, {
          algorithms: [ALGORITHM],
          issuer,
          audience: DEVICE_AUDIENCE,
          clockTimestamp: nowSeconds(),
        });
      } catch {
        return { known: false };
      }

      // A device token belongs to the user it was issued to. Presenting
      // someone else's is an unrecognised device, not a recognised one.
      if (claims.sub !== String(userId) || typeof claims.jti !== 'string') {
        return { known: false };
      }

      return { known: true, deviceId: claims.jti };
    },
  };
}

module.exports = { createDeviceService, DEVICE_AUDIENCE, DEVICE_TOKEN_TTL_SECONDS };
