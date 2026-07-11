const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { testApp, permissiveSessions } = require('./helpers/test-app');

// Proves the frontend-serving wiring in src/app.js: with a built client/dist
// present, the SPA shell and its assets are public and deep-links fall back to
// index.html, while every /api data route stays behind the bearer token. The
// load-bearing pair is `/credentials -> 200` AND `/api/credentials -> 401`
// from the same app: the shell is public, the data is not.

const INDEX_HTML = '<!doctype html><div id="root"></div><script src="/assets/app.js"></script>';
const ASSET_JS = 'console.log("spa");';

let distDir;

beforeAll(() => {
  // A stand-in for `npm run build` output. app.js reads CLIENT_DIST_PATH at
  // createApp() time, so it must be set before the app is mounted.
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spms-dist-'));
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'index.html'), INDEX_HTML);
  fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), ASSET_JS);
  process.env.CLIENT_DIST_PATH = distDir;
});

afterAll(() => {
  delete process.env.CLIENT_DIST_PATH;
  fs.rmSync(distDir, { recursive: true, force: true });
});

// The SPA static handler mounts ahead of auth, so no token is set anywhere
// in this suite — a public shell must load for an anonymous browser.
const app = () => testApp({ sessions: permissiveSessions }).app;

describe('SPA serving (client build present)', () => {
  it('serves the app shell at / without a token', async () => {
    const res = await request(app()).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
  });

  it('serves hashed static assets', async () => {
    const res = await request(app()).get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });

  it('falls back to index.html for a client-side deep link', async () => {
    // A reload/bookmark on a route React owns — no such file exists, but the
    // fallback (ahead of default-deny auth) returns the shell, not a 401/404.
    const res = await request(app()).get('/credentials');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
  });

  it('still serves /health as JSON, not the shell', async () => {
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'securevault' });
  });

  it('still protects /api data routes without a token', async () => {
    const res = await request(app()).get('/api/credentials');
    expect(res.status).toBe(401);
  });

  it('does not answer an unknown /api path with the shell', async () => {
    const res = await request(app()).get('/api/nope');
    expect(res.status).toBe(401);
    expect(res.text).not.toContain('<div id="root">');
  });

  // Express routes case-insensitively, so /API/credentials reaches the real
  // auth-protected router; the fallback's exclusion must be case-insensitive
  // too, or it would answer this public shell instead of a 401.
  it('does not answer a case-varied /API path with the shell', async () => {
    const res = await request(app()).get('/API/credentials');
    expect(res.status).toBe(401);
    expect(res.text).not.toContain('<div id="root">');
  });

  // Bare /api has no router mounted; it must not fall through to the shell.
  it('does not answer bare /api with the shell', async () => {
    const res = await request(app()).get('/api');
    expect(res.text).not.toContain('<div id="root">');
  });

  it('leaves POST /api/session reachable (not shadowed by the fallback)', async () => {
    // The fallback only handles GET; the login route still receives the POST.
    // A bad body is fine — the point is it reaches the router (not a 200 shell,
    // not a 404 from being swallowed).
    const res = await request(app()).post('/api/session').send({});
    expect(res.status).not.toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });
});
