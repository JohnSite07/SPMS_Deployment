const { createTokenService } = require('../../src/services/token-service');

// A token service with a fixed key, so tests never read a real secret from
// the environment.
const TEST_KEY = 'k'.repeat(64);

function testTokenService(overrides = {}) {
  return createTokenService({
    signingKey: TEST_KEY,
    issuer: 'securevault',
    audience: 'securevault-app',
    ttlSeconds: 600,
    ...overrides,
  });
}

module.exports = { testTokenService, TEST_KEY };
