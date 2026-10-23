'use strict';
// Per-workspace, in-memory (per instance) fixed-window rate limiter for the
// onboarding routes. DB-backed counters are used where abuse matters (test
// messages, support requests) - this one just protects the Graph/Stripe calls
// and cheap endpoints. Bounded memory; nothing runs at require time.
const { respond, OnbError } = require('./errors');

const MAX_KEYS = 10000;

function createLimiter(opts = {}) {
  const now = opts.now || (() => Date.now());
  const buckets = new Map(); // `${bucket}|${key}` -> { count, resetAt }

  function purge(t) {
    for (const [k, v] of buckets) if (v.resetAt <= t) buckets.delete(k);
  }

  /**
   * @param {string} bucket named limiter (e.g. 'checkout')
   * @param {string} key typically the workspaceId
   * @param {{limit:number, windowMs:number}} cfg
   * @returns {{allowed:boolean, remaining:number, retryAfterSec:number}}
   */
  function consume(bucket, key, cfg) {
    const t = now();
    const id = `${bucket}|${key}`;
    let rec = buckets.get(id);
    if (!rec || rec.resetAt <= t) {
      if (buckets.size >= MAX_KEYS) purge(t);
      if (buckets.size >= MAX_KEYS) buckets.clear(); // hard bound: forget everything rather than grow
      rec = { count: 0, resetAt: t + cfg.windowMs };
      buckets.set(id, rec);
    }
    if (rec.count >= cfg.limit) {
      return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((rec.resetAt - t) / 1000)) };
    }
    rec.count += 1;
    return { allowed: true, remaining: cfg.limit - rec.count, retryAfterSec: 0 };
  }

  function clear() { buckets.clear(); }
  return { consume, clear, _size: () => buckets.size };
}

const shared = createLimiter();

/** Process-wide limiter. */
function consume(bucket, key, cfg, deps) {
  return (deps && deps.limiter ? deps.limiter : shared).consume(bucket, key, cfg);
}
function clear() { shared.clear(); }

/**
 * Express middleware. Key = req.user.workspaceId unless keyFn is given.
 * On deny: 429 RATE_LIMITED + Retry-After via errors.respond.
 */
function middleware(bucket, cfg, deps) {
  return function onboardingRateLimit(req, res, next) {
    const key = cfg.keyFn ? cfg.keyFn(req) : (req.user && req.user.workspaceId);
    if (!key) return next(); // no tenant key: nothing to limit (auth middleware decides)
    const r = consume(bucket, String(key), cfg, deps);
    if (r.allowed) return next();
    return respond(res, new OnbError('RATE_LIMITED', { retryAfterSec: r.retryAfterSec }));
  };
}

module.exports = { consume, middleware, createLimiter, clear };
