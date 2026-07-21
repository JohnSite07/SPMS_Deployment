const express = require('express');
const request = require('supertest');
const {
  loadTrustProxyHops,
  MAX_TRUST_PROXY_HOPS,
  TRUST_PROXY_ENV_VAR,
} = require('../src/config/env');

// `req.ip` is the address services/audit-log.js stamps on every entry, so the
// hop count is an audit-integrity control, not a formatting preference. These
// tests cover the two failure modes that matter: a value that lets a client
// forge its own address, and a value that silently resolves to no proxy at all.

const hops = (value) =>
  loadTrustProxyHops(value === undefined ? {} : { [TRUST_PROXY_ENV_VAR]: value });

describe('loadTrustProxyHops', () => {
  it('defaults to 0 when unset or empty', () => {
    expect(hops(undefined)).toBe(0);
    expect(hops('')).toBe(0);
  });

  it('accepts a non-negative integer hop count', () => {
    expect(hops('0')).toBe(0);
    expect(hops('1')).toBe(1);
    expect(hops(String(MAX_TRUST_PROXY_HOPS))).toBe(MAX_TRUST_PROXY_HOPS);
  });

  it('tolerates surrounding whitespace', () => {
    expect(hops('  2  ')).toBe(2);
  });

  // The headline rule. Express accepts `true` and it is the one value that
  // hands the audit-log address to the caller, so it must not reach app.set().
  it.each(['true', 'TRUE', 'false'])('rejects the boolean %s', (value) => {
    expect(() => hops(value)).toThrow(/hop count, not/i);
  });

  it.each(['1.5', '2px', '0x2', '-1', 'loopback', ' '])(
    'rejects the non-integer %p',
    (value) => {
      expect(() => hops(value)).toThrow(/non-negative integer/i);
    }
  );

  it('rejects a count above the maximum', () => {
    expect(() => hops(String(MAX_TRUST_PROXY_HOPS + 1))).toThrow(/above the maximum/i);
  });

  it('never mentions the raw value back in a way that implies it was accepted', () => {
    expect(() => hops('true')).toThrow(/forge/i);
  });
});

// The property the hop count exists for: counting in from the right skips a
// client-supplied prefix. These assert Express's behaviour, because that is
// what the parsed value is ultimately feeding.
describe('req.ip under a hop count', () => {
  function appWithHops(count) {
    const app = express();
    if (count > 0) {
      app.set('trust proxy', count);
    }
    app.get('/ip', (req, res) => res.json({ ip: req.ip }));
    return app;
  }

  it('ignores a forged X-Forwarded-For prefix at hop count 1', async () => {
    const res = await request(appWithHops(1))
      .get('/ip')
      .set('X-Forwarded-For', '10.9.9.9, 203.0.113.7');

    // 203.0.113.7 is the entry the infrastructure appended; 10.9.9.9 is what
    // the client claimed. The claim is skipped.
    expect(res.body.ip).toBe('203.0.113.7');
  });

  it('still resolves the appended entry when the client sends several', async () => {
    const res = await request(appWithHops(1))
      .get('/ip')
      .set('X-Forwarded-For', 'evil-1, evil-2, evil-3, 203.0.113.7');

    expect(res.body.ip).toBe('203.0.113.7');
  });

  it('leaves req.ip as the socket peer when unset', async () => {
    const res = await request(appWithHops(0))
      .get('/ip')
      .set('X-Forwarded-For', '10.9.9.9');

    expect(res.body.ip).not.toBe('10.9.9.9');
  });
});
