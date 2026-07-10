// Last resort. Express's default handler renders the stack into the response
// body whenever NODE_ENV is not "production" — a bug in a route would then
// hand an attacker our internals. The stack goes to Cloud Logging; the client
// gets a code and nothing else.
//
// Express identifies an error handler by its arity, so the fourth parameter
// must stay even though it is unused.
function errorHandler(err, req, res, _next) {
  // eslint-disable-next-line no-console
  console.error(`unhandled error on ${req.method} ${req.path}:`, err.stack);

  if (res.headersSent) {
    return;
  }
  res.status(500).json({ error: 'internal_error' });
}

module.exports = { errorHandler };
