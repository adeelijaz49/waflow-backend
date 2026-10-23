'use strict';
// GET /state, GET /help-context, POST /preferences (DB design section 5; absolute paths, own gating:
// routes/onboarding/index.js applies NO default gate to this file).
//   GET  /state          auth only: not enrolled -> 200 { enrolled:false }; bypasses the gate cache
//   GET  /help-context   gate E (any enrolled state)
//   POST /preferences    gate A (active subscription)
// The workspace id is only ever req.user.workspaceId; a workspaceId in the body or query is ignored.
// `deps` (tests): { steps, support, gateDeps, <models and fakes passed through to the library> }.
const express = require('express');
const errors = require('../../shared/onboarding/errors');

function createRouter(deps = {}) {
  const router = express.Router();
  const d = deps || {};
  const lib = {
    steps: () => d.steps || require('../../shared/onboarding/steps'),
    support: () => d.support || require('../../shared/onboarding/support'),
  };
  const access = require('../../shared/onboarding/requireOnboardingAccess');
  const gateE = access({ billingExempt: true }, d.gateDeps);
  const gateA = access({}, d.gateDeps);

  router.get('/state', async (req, res) => {
    try {
      const steps = lib.steps();
      const u = req.user || {};
      if (!u.workspaceId) return res.json({ enrolled: false });
      const body = await steps.buildState({ workspaceId: String(u.workspaceId), userId: u.id ? String(u.id) : undefined, role: u.role, deps: d });
      res.set('Cache-Control', 'no-store');
      return res.json(body);
    } catch (err) {
      return errors.respond(res, err);
    }
  });

  router.get('/help-context', gateE, async (req, res) => {
    try {
      const steps = lib.steps();
      const { workspaceId, userId } = steps.requestContext(req);
      const body = await lib.support().getHelpContext({ workspaceId, userId, deps: d });
      res.set('Cache-Control', 'no-store');
      return res.json(body);
    } catch (err) {
      return errors.respond(res, err);
    }
  });

  router.post('/preferences', gateA, async (req, res) => {
    try {
      const steps = lib.steps();
      const { workspaceId } = steps.requestContext(req);
      const stateModule = d.state || require('../../shared/onboarding/state');
      await stateModule.ensureState(workspaceId, d);

      const src = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const picked = {};
      if (src.uiLanguage !== undefined) picked.uiLanguage = src.uiLanguage;
      if (src.languages !== undefined) picked.languages = src.languages;
      const v = steps.validateBusinessInput(picked);
      if (!v.ok) throw new errors.OnbError('VALIDATION_FAILED', { details: { fields: v.fields } });

      const set = {};
      if (v.value.uiLanguage) set['business.uiLanguage'] = v.value.uiLanguage;
      if (v.value.languages) set['business.languages'] = v.value.languages;
      const State = d.OnboardingState || require('../../models/OnboardingState');
      await State.updateOne({ workspaceId }, { $set: set }); // same input, same stored result: idempotent
      return res.json({ uiLanguage: v.value.uiLanguage || undefined, languages: v.value.languages || undefined });
    } catch (err) {
      return errors.respond(res, err);
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
