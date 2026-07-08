const request = require('supertest');
const { createApp } = require('../src/app');

describe('GET /healthz', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(createApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'securevault' });
  });
});
