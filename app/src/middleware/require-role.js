const { ROLES } = require('../services/token-service');

// Mounted *after* createAuthMiddleware, never instead of it. It reads
// req.auth, which only the auth middleware sets, and only after verifying a
// signature, an issuer, an audience, an expiry, and a live session.
//
// 403 here, where /api/audit answers 405 to a DELETE. The two are not
// interchangeable. 405 says the method does not exist on that resource for
// anyone, ever — nobody may edit an audit entry. 403 says this resource and
// method do exist, the caller is authenticated, and a different caller would
// be allowed through. That is exactly the situation of an owner at an admin
// route, and it is the one case in this codebase where 403 is the honest code.
function requireRole(...allowedRoles) {
  const allowed = new Set(allowedRoles);

  if (allowed.size === 0 || [...allowed].some((role) => !Object.values(ROLES).includes(role))) {
    throw new TypeError('requireRole needs at least one role from ROLES');
  }

  return function checkRole(req, res, next) {
    // Belt and braces. If this middleware is ever mounted on a path the auth
    // middleware treats as public, `req.auth` is undefined and the role check
    // would read `undefined.role` and 500 — or, worse, a future refactor might
    // make that read `undefined` and compare it against an allowlist that
    // someday contains undefined. Deny instead.
    if (!req.auth) {
      return res.status(401).json({ error: 'invalid_request' });
    }

    if (!allowed.has(req.auth.role)) {
      // No hint about what role would have worked. An owner probing admin
      // routes learns only that this one is not for them.
      return res.status(403).json({ error: 'forbidden' });
    }

    return next();
  };
}

module.exports = { requireRole };
