'use strict';
// Step 4 routes (DB design section 5): ABSOLUTE paths, the default gate A is applied by routes/onboarding/index.js,
// only the STRICTER owner gate of POST /display-name is added here.
//   GET  /approvals                     the five-row view model (read-only, DB only: no Graph call)
//   POST /approvals/payment-confirmed   { confirmed: true } payment self-attestation (D11)
//   POST /display-name                  { newName } owner only; Graph new_display_name
// workspaceId comes ONLY from the verified token (req.user.workspaceId); body fields are validated.
const express = require('express');
const config = require('../../shared/onboarding/config');
const { OnbError, respond } = require('../../shared/onboarding/errors');
const rateLimit = require('../../shared/onboarding/rateLimit');

function createRouter(deps = {}) {
  const router = express.Router();
  const approvals = () => deps.approvals || require('../../shared/onboarding/approvals');
  const ownerGate = () => {
    if (deps.ownerGate) return deps.ownerGate;
    const { requireOnboardingAccess } = require('../../shared/onboarding/requireOnboardingAccess');
    return requireOnboardingAccess({ ownerOnly: true }, deps.gateDeps);
  };
  let owner = null;
  const ownerMw = (req, res, next) => {
    try { if (!owner) owner = ownerGate(); } catch (err) { return respond(res, err); }
    return owner(req, res, next);
  };
  // the payment attestation is a write on the merchant's connection: the requester must still be a member (live Membership read; a removed
  // member's 30-day JWT gets 403 NOT_A_MEMBER, review R2-05), before the limiter
  let member = null;
  const memberMw = (req, res, next) => {
    try { if (!member) member = deps.memberGate || require('../../shared/onboarding/requireOnboardingAccess').requireOnboardingAccess({ liveMember: true }, deps.gateDeps); } catch (err) { return respond(res, err); }
    return member(req, res, next);
  };
  const off = (req, res, next) => (config.enabled() ? next() : next('router'));
  const limit = (bucket, cfg) => rateLimit.middleware(bucket, cfg, deps.rateLimitDeps);
  const wsOf = (req) => (req.user && req.user.workspaceId ? String(req.user.workspaceId) : '');

  router.get('/approvals', off, limit('approvals:get', { limit: 120, windowMs: 60 * 1000 }), async (req, res) => {
    try {
      const ws = wsOf(req);
      if (!ws) throw new OnbError('ONBOARDING_NOT_AVAILABLE');
      const view = await approvals().buildApprovals(ws, deps.approvalsDeps);
      // step 4 follows what the merchant has seen (never fails the read). I1b: not before step 3 exists: a look at the
      // rows of a workspace that has no connection yet must not mark step 4 opened (the checklist would skip it later).
      try {
        if (view.level !== 'not_connected' && typeof approvals().touchProgress === 'function') await approvals().touchProgress(ws, view.overall, deps.progressDeps);
      } catch (_) { /* the read never fails because of progress bookkeeping */ }
      res.json(view);
    } catch (err) { respond(res, err); }
  });

  router.post('/approvals/payment-confirmed', off, memberMw, limit('approvals:payment', { limit: 20, windowMs: 60 * 60 * 1000 }), async (req, res) => {
    try {
      const ws = wsOf(req);
      if (!ws) throw new OnbError('ONBOARDING_NOT_AVAILABLE');
      if (!req.body || req.body.confirmed !== true) throw new OnbError('VALIDATION_FAILED', { details: { fields: { confirmed: 'required' } } });
      const result = await approvals().confirmPayment(ws, deps.approvalsDeps);
      res.json(result);
    } catch (err) { respond(res, err); }
  });

  router.post('/display-name', off, ownerMw, limit('approvals:display-name', { limit: 5, windowMs: 60 * 60 * 1000 }), async (req, res) => {
    try {
      const ws = wsOf(req);
      if (!ws) throw new OnbError('ONBOARDING_NOT_AVAILABLE');
      const newName = req.body && typeof req.body.newName === 'string' ? req.body.newName : '';
      if (!newName.trim()) throw new OnbError('VALIDATION_FAILED', { details: { fields: { newName: 'required' } } });
      const result = await approvals().changeDisplayName({ workspaceId: ws, userId: req.user && req.user.id, newName }, deps.approvalsDeps);
      res.json(result);
    } catch (err) { respond(res, err); }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
