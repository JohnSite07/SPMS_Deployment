const express = require('express');

// App factory, separated from server.js so tests can mount it without
// binding a port. The Developer team replaces the placeholder route with
// the real SecureVault routes (see docs/requirements/).
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // Health endpoint: used by the CD pipeline's smoke test against the
  // candidate revision before traffic is shifted. Keep it dependency-free
  // (no DB call) so a cold start always answers.
  app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'securevault' });
  });

  app.get('/', (req, res) => {
    res
      .status(200)
      .send('SecureVault deployment skeleton - application under construction.');
  });

  return app;
}

module.exports = { createApp };
