const request = require('supertest');
const { testApp, permissiveSessions } = require('./helpers/test-app');

const app = () => testApp({ sessions: permissiveSessions }).app;

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'securevault' });
  });

  // The CD smoke test hits /health on a cold candidate revision with no
  // credentials. If auth ever starts guarding it, deploys break.
  it('answers without a bearer token', async () => {
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
  });
});
