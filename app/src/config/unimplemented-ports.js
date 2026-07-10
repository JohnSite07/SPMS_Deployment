// The storage ports createApp() needs, none of which exist yet: MySQL schema,
// AES-256 encryption, and the vault tables are the Developer team's work (see
// docs/requirements/). This module lets the deployment skeleton keep doing its
// one job — answering /health for the CD smoke test — while every route that
// would touch storage fails loudly instead of quietly returning something.
//
// Each method throws. It does not return null, does not return an empty list,
// and does not resolve. A port that answered `[]` would let /api/audit report
// an empty audit log, and an empty audit log is indistinguishable from a
// clean one; a `sessions.isRevoked` that answered `false` would wave every
// token through. Unimplemented must not be mistakable for benign.

class NotImplementedError extends Error {
  constructor(port, method) {
    super(`${port}.${method}() is not implemented: no storage layer is wired yet`);
    this.name = 'NotImplementedError';
  }
}

function unimplemented(port, methods) {
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [
        method,
        () => {
          throw new NotImplementedError(port, method);
        },
      ])
    )
  );
}

// The shapes each route module and the auth middleware validate at
// construction, so createApp() still wires up and /health still answers.
function createUnimplementedPorts() {
  return {
    users: unimplemented('users', [
      'findByEmail',
      'findById',
      'recordFailedAttempt',
      'resetFailedAttempts',
    ]),
    sessions: unimplemented('sessions', ['transaction', 'start', 'revoke', 'isRevoked']),
    credentials: unimplemented('credentials', ['transaction', 'add', 'get', 'update', 'remove']),
    auditReader: unimplemented('auditReader', ['list', 'get', 'transaction']),
  };
}

module.exports = { createUnimplementedPorts, NotImplementedError };
