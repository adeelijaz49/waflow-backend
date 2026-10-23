'use strict';
// Fail-open helpers of the hot-path hooks (review R1-F3). The three hooks that sit on a LEGACY request path
// (httpGuard on every /api request, webhookEvents.intercept on POST /webhook, sendGate.flowBlocked in the flow sweep)
// await a database lookup. A lookup that never settles (a stalled socket) must never stall the legacy path, so every such
// lookup is raced against a short timeout and FAILS OPEN: the legacy code goes on exactly as it did before the feature
// existed. A timed-out result is never cached (the callers cache nothing on an error), and every fail-open path writes at
// most one log line per minute per module (the error CODE only: never a message, id, token, number or payload).
const config = require('./config');

const TIMEOUT_MS = 1500;
const LOG_EVERY_MS = 60 * 1000;
const lastLogged = new Map(); // module -> ms of the last line

/**
 * Run `fn` (sync or async) and stop waiting after `ms` (default 1.5 s): the returned promise then rejects with
 * code ONB_LOOKUP_TIMEOUT. The abandoned call keeps running in the background, but nothing awaits it any more and a late
 * rejection is absorbed. The timer is unref()ed and always cleared.
 * @template T
 * @param {() => (T|Promise<T>)} fn
 * @param {number} [ms]
 * @param {string} [label] only used in the (never logged) error message
 * @returns {Promise<T>}
 */
function withTimeout(fn, ms, label) {
  const limit = Number.isFinite(ms) && ms > 0 ? ms : TIMEOUT_MS;
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label || 'lookup'} timed out`), { code: 'ONB_LOOKUP_TIMEOUT' })), limit);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve().then(fn), guard]).finally(() => { clearTimeout(timer); });
}

/**
 * A fail-open path was taken: one throttled warning per module and minute, with the error code only.
 * Never throws.
 * @param {string} module short module name, e.g. 'httpGuard'
 * @param {*} err
 * @param {number} [nowMs] test clock
 */
function logFailOpen(module, err, nowMs) {
  try {
    const t = Number.isFinite(nowMs) ? nowMs : Date.now();
    const last = lastLogged.get(module);
    if (last !== undefined && t - last < LOG_EVERY_MS) return;
    if (lastLogged.size > 50) lastLogged.clear();
    lastLogged.set(module, t);
    const code = err && typeof err.code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(err.code) ? err.code : 'ERROR';
    config.safeLog('warn', '[onboarding] fail-open:', module, code);
  } catch (_) { /* logging must never break a request */ }
}

function _resetLog() { lastLogged.clear(); }

module.exports = { withTimeout, logFailOpen, TIMEOUT_MS, LOG_EVERY_MS, _resetLog };
