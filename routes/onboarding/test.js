'use strict';
// Step 5 routes (DB design section 5). Absolute paths; the default gate A is applied by
// routes/onboarding/index.js for the /test-message and /first-promotion prefixes.
//   POST /test-message            { phone? } -> { sent:true, to:<masked>, templateKey }
//   GET  /first-promotion         -> hand-off data (ready, missing, suggestion, sendPolicy, testRecipient)
//   POST /first-promotion/state   { state:'started'|'done'|'skipped' } -> { state, sendPolicy, firstPromotion }
// workspaceId / userId only ever come from req.user. The test message is limited in the DB (5 per hour,
// 2 distinct numbers); the in-memory limiter below is only a cheap safety net in front of it. It SENDS from the merchant's number, so the
// requester must still be a member of the workspace (live Membership read: a removed member's 30-day JWT gets 403 NOT_A_MEMBER, review
// R2-05); the recipient is the requester's own login phone (shared/onboarding/testMessage.js, review R2-03).
const express = require('express');
const { respond } = require('../../shared/onboarding/errors');
const rateLimit = require('../../shared/onboarding/rateLimit');

const HOUR = 60 * 60 * 1000;

function wrap(fn) {
  return async (req, res) => {
    try { await fn(req, res); } catch (err) { respond(res, err); }
  };
}

/**
 * @param {{testMessage?:object, firstPromotion?:object, moduleDeps?:object, rateLimitDeps?:object, gateDeps?:object, memberGate?:Function}} [deps]
 *   test hooks: module replacements, moduleDeps (passed to the module functions), rateLimitDeps = { limiter }, gateDeps / memberGate (the live membership gate).
 */
function createRouter(deps = {}) {
  const router = express.Router();
  const testMessage = () => deps.testMessage || require('../../shared/onboarding/testMessage');
  const firstPromotion = () => deps.firstPromotion || require('../../shared/onboarding/firstPromotion');
  const md = deps.moduleDeps;
  const testLimit = rateLimit.middleware('test_message', { limit: 15, windowMs: HOUR }, deps.rateLimitDeps);
  let member = null;
  const memberGate = (req, res, next) => {
    try { if (!member) member = deps.memberGate || require('../../shared/onboarding/requireOnboardingAccess')({ liveMember: true }, deps.gateDeps); } catch (err) { return respond(res, err); }
    return member(req, res, next);
  };

  // the membership check comes BEFORE the limiter: a removed member must not be able to use up the workspace's budget
  router.post('/test-message', memberGate, testLimit, wrap(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const typed = body.phone !== undefined ? body.phone : body.to;
    const to = typeof typed === 'string' || typeof typed === 'number' ? String(typed) : undefined;
    const out = await testMessage().sendTestMessage({ workspaceId: req.user.workspaceId, userId: req.user.id, to }, md);
    res.json(out);
  }));

  router.get('/first-promotion', wrap(async (req, res) => {
    res.json(await firstPromotion().getFirstPromotion({ workspaceId: req.user.workspaceId, userId: req.user.id }, md));
  }));

  router.post('/first-promotion/state', wrap(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const out = await firstPromotion().setFirstPromotionState({ workspaceId: req.user.workspaceId, state: typeof body.state === 'string' ? body.state : '' }, md);
    res.json(out);
  }));

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
