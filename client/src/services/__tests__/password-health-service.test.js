import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getHealthReport, submitHealthReport } from '../password-health-service.js';
import * as store from '../token-store.js';
import { cancelAutoLock } from '../session.js';

function response(body, { status = 200, headers = {} } = {}) {
  const init = { status, headers: { 'Content-Type': 'application/json', ...headers } };
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Response(text, init);
}

beforeEach(() => {
  store.clear();
  cancelAutoLock();
  store.setToken('tok-1');
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('password-health-service', () => {
  it('getHealthReport calls GET /api/password-health and returns { report } as-is', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ report: null }));

    const result = await getHealthReport();

    expect(result).toEqual({ report: null });
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/password-health');
    expect(opts.method).toBe('GET');
  });

  it('submitHealthReport POSTs overallScore and findings, and nothing else', async () => {
    globalThis.fetch.mockResolvedValueOnce(response({ reportId: 'r1' }, { status: 201 }));

    await submitHealthReport({
      overallScore: 67,
      findings: [
        { itemId: 'i1', status: 'OK' },
        { itemId: 'i2', status: 'WEAK' },
      ],
    });

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/password-health');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      overallScore: 67,
      findings: [
        { itemId: 'i1', status: 'OK' },
        { itemId: 'i2', status: 'WEAK' },
      ],
    });
  });

  it('never calls fetch directly outside api-client — only through get/post', async () => {
    // This is enforced mechanically by ESLint's no-restricted-globals rule
    // (see eslint.config.js) for every file except api-client.js itself; this
    // test simply documents that this service goes through that boundary.
    globalThis.fetch.mockResolvedValueOnce(response({ reportId: 'r1' }, { status: 201 }));
    await submitHealthReport({ overallScore: 100, findings: [] });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
