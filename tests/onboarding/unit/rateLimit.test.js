'use strict';
const { createLimiter, consume, middleware, clear } = require('../../../shared/onboarding/rateLimit');

function fakeRes() {
  const res = { headers: {}, statusCode: null, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}

describe('createLimiter', () => {
  test('allows up to the limit then denies with a retry hint', () => {
    let t = 1000000;
    const lim = createLimiter({ now: () => t });
    const cfg = { limit: 3, windowMs: 60000 };
    expect(lim.consume('b', 'ws1', cfg)).toEqual({ allowed: true, remaining: 2, retryAfterSec: 0 });
    expect(lim.consume('b', 'ws1', cfg).allowed).toBe(true);
    expect(lim.consume('b', 'ws1', cfg).allowed).toBe(true);
    const denied = lim.consume('b', 'ws1', cfg);
    expect(denied).toEqual({ allowed: false, remaining: 0, retryAfterSec: 60 });
    t += 30000;
    expect(lim.consume('b', 'ws1', cfg).retryAfterSec).toBe(30);
  });
  test('the window resets', () => {
    let t = 0;
    const lim = createLimiter({ now: () => t });
    const cfg = { limit: 1, windowMs: 1000 };
    expect(lim.consume('b', 'k', cfg).allowed).toBe(true);
    expect(lim.consume('b', 'k', cfg).allowed).toBe(false);
    t = 1001;
    expect(lim.consume('b', 'k', cfg).allowed).toBe(true);
  });
  test('buckets and keys are independent (per workspace)', () => {
    const lim = createLimiter({ now: () => 0 });
    const cfg = { limit: 1, windowMs: 1000 };
    expect(lim.consume('a', 'ws1', cfg).allowed).toBe(true);
    expect(lim.consume('a', 'ws2', cfg).allowed).toBe(true);
    expect(lim.consume('b', 'ws1', cfg).allowed).toBe(true);
    expect(lim.consume('a', 'ws1', cfg).allowed).toBe(false);
  });
  test('memory is bounded', () => {
    const lim = createLimiter({ now: () => 0 });
    for (let i = 0; i < 10050; i += 1) lim.consume('b', `k${i}`, { limit: 1, windowMs: 1000 });
    expect(lim._size()).toBeLessThanOrEqual(10000);
  });
  test('clear forgets everything', () => {
    const lim = createLimiter({ now: () => 0 });
    lim.consume('b', 'k', { limit: 1, windowMs: 1000 });
    lim.clear();
    expect(lim.consume('b', 'k', { limit: 1, windowMs: 1000 }).allowed).toBe(true);
  });
});

describe('shared limiter + middleware', () => {
  beforeEach(() => clear());
  test('consume uses the process-wide limiter unless one is injected', () => {
    const cfg = { limit: 1, windowMs: 10000 };
    expect(consume('x', 'ws', cfg).allowed).toBe(true);
    expect(consume('x', 'ws', cfg).allowed).toBe(false);
    const own = createLimiter({ now: () => 0 });
    expect(consume('x', 'ws', cfg, { limiter: own }).allowed).toBe(true);
  });
  test('middleware keys on req.user.workspaceId and answers 429 RATE_LIMITED + Retry-After', () => {
    const mw = middleware('t', { limit: 1, windowMs: 60000 });
    const next = jest.fn();
    const req = { user: { workspaceId: 'ws1' } };
    mw(req, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    const res = fakeRes();
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
    // another workspace is unaffected
    mw({ user: { workspaceId: 'ws2' } }, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });
  test('custom keyFn; no tenant key -> pass-through', () => {
    const mw = middleware('t2', { limit: 1, windowMs: 60000, keyFn: (r) => r.ip });
    const next = jest.fn();
    mw({ ip: '1.1.1.1' }, fakeRes(), next);
    const res = fakeRes();
    mw({ ip: '1.1.1.1' }, res, next);
    expect(res.statusCode).toBe(429);
    const mw2 = middleware('t3', { limit: 1, windowMs: 60000 });
    const n2 = jest.fn();
    mw2({}, fakeRes(), n2); mw2({}, fakeRes(), n2);
    expect(n2).toHaveBeenCalledTimes(2);
  });
});
