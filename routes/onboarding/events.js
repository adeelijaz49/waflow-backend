'use strict';
// POST /api/onboarding/events (DB design 5, DECISIONS C4): the browser's analytics reports.
// Gate E (enrolled, any subscription state: billing-exempt) is applied by routes/onboarding/index.js (this router defines ABSOLUTE
// paths), so the analytics beacons keep working while a payment is overdue or after a cancellation.
// Whitelist: type in analytics.UI_EVENT_TYPES; a step_fail event needs a code from
// analytics.UI_FAIL_CODES (the C4 client codes) and every other type carries no code. Only
// { type, step, code, durationMs } are read from the body (never free text, reason or meta), the
// rest goes through analytics.sanitizeEvent. Anything unknown is dropped SILENTLY: the answer is
// always 204 (an analytics write must never surface an error to the merchant). 120 per minute.
// workspaceId comes only from the verified token.
const express = require('express');

const RATE = { limit: 120, windowMs: 60 * 1000 };

function realDeps() {
  return {
    analytics: require('../../shared/onboarding/analytics'),
    rateLimit: require('../../shared/onboarding/rateLimit'),
  };
}

/**
 * Build the whitelisted analytics event from a request body, or null (drop).
 * @param {object} body
 * @param {{UI_EVENT_TYPES:string[], UI_FAIL_CODES:string[]}} analytics
 */
function buildEvent(body, analytics) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (typeof body.type !== 'string' || !analytics.UI_EVENT_TYPES.includes(body.type)) return null;
  const evt = { type: body.type };
  if (typeof body.step === 'string') evt.step = body.step;
  if (typeof body.durationMs === 'number') evt.durationMs = body.durationMs;
  if (body.type === 'step_fail') {
    if (typeof body.code !== 'string' || !analytics.UI_FAIL_CODES.includes(body.code)) return null;
    evt.code = body.code;
  }
  return evt;
}

/** @param {{analytics?:object, rateLimit?:object}} [overrides] */
function createRouter(overrides = {}) {
  const router = express.Router();
  let cached = null;
  const deps = () => {
    if (!cached) cached = { ...realDeps(), ...overrides };
    return cached;
  };
  // Built per request so a router created at require time loads nothing (nothing executes at require).
  let limiter = null;
  const limit = (req, res, next) => {
    try {
      if (!limiter) limiter = deps().rateLimit.middleware('onb-events', RATE);
      return limiter(req, res, next);
    } catch (_) {
      return next();
    }
  };

  router.post('/events', limit, async (req, res) => {
    try {
      const workspaceId = req.user && req.user.workspaceId;
      const d = deps();
      const evt = workspaceId ? buildEvent(req.body, d.analytics) : null;
      if (evt) await d.analytics.track(String(workspaceId), evt); // never throws
    } catch (_) { /* dropped silently */ }
    return res.status(204).end();
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.buildEvent = buildEvent;
