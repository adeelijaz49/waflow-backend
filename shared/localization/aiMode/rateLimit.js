'use strict';
// A tiny in-memory sliding-window rate limiter, keyed per workspace. AI Mode turns
// cost money (several model calls each, and Arabic costs more tokens), and the
// confirm endpoint is the gate in front of real sends, so both are limited per
// workspace (brief B7a §8). In-memory means per server instance: a second
// instance has its own window, which is acceptable for a courtesy limit.
// Prompt-count limits for the plan are a different mechanism (aiPromptMetering).
function createRateLimiter({ limit, windowMs = 60 * 1000, now = () => Date.now(), maxKeys = 5000 } = {}) {
  const hits = new Map(); // key -> ascending timestamps inside the window

  function prune(t) {
    if (hits.size <= maxKeys) return;
    for (const [key, stamps] of hits) {
      if (!stamps.length || t - stamps[stamps.length - 1] >= windowMs) hits.delete(key);
    }
  }

  // -> { ok: true } | { ok: false, retryAfterSec }
  function check(key) {
    const t = now();
    const stamps = (hits.get(key) || []).filter((ts) => t - ts < windowMs);
    if (stamps.length >= limit) {
      hits.set(key, stamps);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (t - stamps[0])) / 1000)) };
    }
    stamps.push(t);
    hits.set(key, stamps);
    prune(t);
    return { ok: true };
  }

  return { check, reset: () => hits.clear() };
}

module.exports = { createRateLimiter };
