const { createFakeDatabase } = require('../../helpers/fake-database');

// The fake half of the port contract. Builds a fresh in-memory database per
// test so the two fixtures (fake vs. real MySQL) can share exactly the same
// assertions in contract-suite.js.
function buildFakeFixture() {
  const db = createFakeDatabase();
  let counter = 0;

  async function seedUser(overrides = {}) {
    counter += 1;
    const user = {
      userId: overrides.userId ?? `contract-user-${counter}`,
      email: overrides.email ?? `contract-${counter}@example.com`,
      masterPasswordHash: overrides.masterPasswordHash ?? 'x'.repeat(60),
      failedAttempts: overrides.failedAttempts ?? 0,
      isLocked: overrides.isLocked ?? false,
    };
    db.state.users.set(user.userId, user);
    return { userId: user.userId, email: user.email };
  }

  return {
    users: db.users,
    sessions: db.sessions,
    credentials: db.credentials,
    auditReader: db.auditReader,
    append: db.append,
    resetTokens: db.resetTokens,
    seedUser,
    async cleanup() {},
  };
}

module.exports = { buildFakeFixture };
