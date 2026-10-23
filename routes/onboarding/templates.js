'use strict';
// Starter templates on the merchant's own WhatsApp Business account (DB design section 5).
// Absolute paths (routes/onboarding/index.js applies the default gate A by the /templates prefix).
//   GET  /templates                            -> { templates:[{key,language,status,category,reasonKey,rejectedReason,title{en,ar},...}], capacity }
//   POST /templates/submit                     -> queue the starter set + submit up to 3 now (3 per hour)
//   POST /templates/:key/:language/resubmit    -> after REJECTED: new revision, optional edited text
// workspaceId only ever comes from req.user (the verified token). Errors: { error, code, nextStep?, ... }.
const express = require('express');
const { respond, OnbError } = require('../../shared/onboarding/errors');
const rateLimit = require('../../shared/onboarding/rateLimit');

const HOUR = 60 * 60 * 1000;
const NOT_CONNECTED_CODES = Object.freeze(['WHATSAPP_NOT_CONNECTED', 'WHATSAPP_RECONNECT_REQUIRED', 'ENCRYPTION_NOT_CONFIGURED']);
const KEY_RE = /^[a-z0-9_]{1,60}$/;

function wrap(fn) {
  return async (req, res) => {
    try { await fn(req, res); } catch (err) { respond(res, err); }
  };
}

function pickEdits(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const edits = {};
  for (const f of ['header', 'body', 'footer']) {
    if (body[f] !== undefined) edits[f] = typeof body[f] === 'string' ? body[f] : null;
  }
  return Object.keys(edits).length ? edits : undefined;
}

/**
 * @param {{starterTemplates?:object, moduleDeps?:object, rateLimitDeps?:object, gateDeps?:object, memberGate?:Function}} [deps] test hooks:
 *   starterTemplates replaces the module, moduleDeps is passed as the module functions' `deps`,
 *   rateLimitDeps = { limiter } replaces the process-wide limiter, gateDeps / memberGate = the live membership gate.
 */
function createRouter(deps = {}) {
  const router = express.Router();
  const starter = () => deps.starterTemplates || require('../../shared/onboarding/starterTemplates');
  const md = deps.moduleDeps;
  const submitLimit = rateLimit.middleware('templates_submit', { limit: 3, windowMs: HOUR }, deps.rateLimitDeps);
  const resubmitLimit = rateLimit.middleware('templates_resubmit', { limit: 10, windowMs: HOUR }, deps.rateLimitDeps);
  // submit / resubmit SPEND the merchant's Meta credentials: the requester must still be a member (live Membership read; a removed
  // member's 30-day JWT gets 403 NOT_A_MEMBER, review R2-05). It runs before the limiter so it cannot burn the workspace's budget.
  let member = null;
  const memberGate = (req, res, next) => {
    try { if (!member) member = deps.memberGate || require('../../shared/onboarding/requireOnboardingAccess')({ liveMember: true }, deps.gateDeps); } catch (err) { return respond(res, err); }
    return member(req, res, next);
  };

  async function snapshot(workspaceId) {
    const s = starter();
    const [templates, capacity] = await Promise.all([s.listStatuses(workspaceId, md), s.getCapacity(workspaceId, md)]);
    return { templates, capacity };
  }

  router.get('/templates', wrap(async (req, res) => {
    res.json(await snapshot(req.user.workspaceId));
  }));

  router.post('/templates/submit', memberGate, submitLimit, wrap(async (req, res) => {
    const s = starter();
    const workspaceId = req.user.workspaceId;
    await s.seedStarterTemplates(workspaceId, md);
    let result = { submitted: 0, adopted: 0, failed: 0 };
    let blocked = null;
    try {
      result = await s.submitQueued({ workspaceId, max: 3 }, md);
    } catch (err) {
      // queued but no usable connection yet: the rows stay queued, the scheduler submits after connect
      if (err instanceof OnbError && NOT_CONNECTED_CODES.includes(err.code)) blocked = { code: err.code, nextStep: err.nextStep || null };
      else throw err;
    }
    const snap = await snapshot(workspaceId);
    res.json({ ...snap, submitted: (result.submitted || 0) + (result.adopted || 0), failed: result.failed || 0, ...(blocked ? { blocked } : {}) });
  }));

  router.post('/templates/:key/:language/resubmit', memberGate, resubmitLimit, wrap(async (req, res) => {
    const { key, language } = req.params;
    if (!KEY_RE.test(String(key)) || (language !== 'en' && language !== 'ar')) {
      throw new OnbError('VALIDATION_FAILED', { details: { reason: 'UNKNOWN_TEMPLATE' } });
    }
    const out = await starter().resubmit({ workspaceId: req.user.workspaceId, key, language, edits: pickEdits(req.body) }, md);
    res.json(out);
  }));

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
