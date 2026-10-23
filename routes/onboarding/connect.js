'use strict';
// Embedded Signup routes of the onboarding flow (DB design 5):
//   GET  /connect/config    (gate A, from routes/onboarding/index.js)  20/min
//   POST /connect/event     (gate A)                                   30/min
//   POST /connect/complete  (gate L = owner + legal acceptance)        5 per 10 min, body <= 4 KB
//   POST /connect/resume    (gate O = owner)                           5 per 10 min
// Absolute paths (Express 5 sub-router, INTERFACES 0.3/0.4). workspaceId and userId come from the verified
// token only. No log line, error body or analytics field here contains the authorization code, a token or a PIN.
const express = require('express');
const { respond, OnbError } = require('../../shared/onboarding/errors');
const rateLimit = require('../../shared/onboarding/rateLimit');

const BODY_LIMIT_BYTES = 4096;

function lazy(factory) {
  let fn = null;
  return function lazyMiddleware(req, res, next) {
    try {
      if (!fn) fn = factory();
    } catch (err) {
      return respond(res, err);
    }
    return fn(req, res, next);
  };
}

function wrap(handler) {
  return async function onboardingConnectRoute(req, res) {
    try {
      await handler(req, res);
    } catch (err) {
      respond(res, err);
    }
  };
}

const who = (req) => ({
  workspaceId: req.user && req.user.workspaceId ? String(req.user.workspaceId) : '',
  userId: req.user && (req.user.id || req.user.userId) ? String(req.user.id || req.user.userId) : '',
});

function str(v, max) {
  return typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null;
}

/** Router factory. deps = { connect?, connectDeps?, gateDeps?, limiter? } (tests inject fakes). */
function createRouter(deps = {}) {
  const d = deps || {};
  const router = express.Router();
  const connect = () => d.connect || require('../../shared/onboarding/connect');
  const gate = (opts) => lazy(() => require('../../shared/onboarding/requireOnboardingAccess')(opts, d.gateDeps));
  const limit = (bucket, cfg) => rateLimit.middleware(bucket, cfg, d);
  const ownerOnly = gate({ ownerOnly: true });
  const ownerAndLegal = gate({ ownerOnly: true, needsLegal: true });

  router.get('/connect/config', limit('connect_config', { limit: 20, windowMs: 60 * 1000 }), wrap(async (req, res) => {
    const out = await connect().getConnectConfig(who(req), d.connectDeps);
    res.set('Cache-Control', 'no-store');
    res.json(out);
  }));

  router.post('/connect/event', limit('connect_event', { limit: 30, windowMs: 60 * 1000 }), wrap(async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const event = typeof b.event === 'string' ? b.event.trim().toUpperCase() : '';
    const fields = [];
    if (!['CANCEL', 'ERROR', 'NO_FACEBOOK'].includes(event)) fields.push('event');
    if (!str(b.attemptId, 80)) fields.push('attemptId');
    if (fields.length) throw new OnbError('VALIDATION_FAILED', { details: { fields } });
    const out = await connect().recordConnectEvent({
      ...who(req),
      attemptId: b.attemptId.trim(),
      event,
      currentStep: typeof b.currentStep === 'string' ? b.currentStep.slice(0, 60) : undefined,
      errorCode: typeof b.errorCode === 'number' || typeof b.errorCode === 'string' ? b.errorCode : undefined,
      errorMessage: typeof b.errorMessage === 'string' ? b.errorMessage.slice(0, 500) : undefined,
    }, d.connectDeps);
    res.json(out);
  }));

  const badBody = (err, req, res, next) => { // eslint-disable-line no-unused-vars
    const tooLarge = err && (err.type === 'entity.too.large' || err.status === 413);
    respond(res, new OnbError('VALIDATION_FAILED', { details: { reason: tooLarge ? 'BODY_TOO_LARGE' : 'INVALID_BODY' } }));
  };
  router.post(
    '/connect/complete',
    ownerAndLegal,
    limit('connect_complete', { limit: 5, windowMs: 10 * 60 * 1000 }),
    express.json({ limit: '4kb' }),
    badBody,
    wrap(async (req, res) => {
      const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      let size = 0;
      try { size = Buffer.byteLength(JSON.stringify(b)); } catch (_) { size = BODY_LIMIT_BYTES + 1; }
      if (size > BODY_LIMIT_BYTES) throw new OnbError('VALIDATION_FAILED', { details: { reason: 'BODY_TOO_LARGE' } });
      const fields = [];
      const attemptId = str(b.attemptId, 80);
      const code = str(b.code, 1024);
      if (!attemptId) fields.push('attemptId');
      if (!code) fields.push('code');
      if (fields.length) throw new OnbError('VALIDATION_FAILED', { details: { fields } });
      const session = b.session && typeof b.session === 'object' && !Array.isArray(b.session) ? b.session : {};
      const out = await connect().completeConnect({ ...who(req), attemptId, code, session }, d.connectDeps);
      res.set('Cache-Control', 'no-store');
      res.json(out);
    }),
  );

  router.post('/connect/resume', ownerOnly, limit('connect_resume', { limit: 5, windowMs: 10 * 60 * 1000 }), wrap(async (req, res) => {
    const out = await connect().resumeConnect(who(req), d.connectDeps);
    res.set('Cache-Control', 'no-store');
    res.json(out);
  }));

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
