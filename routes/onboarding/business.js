'use strict';
// PUT /business (Step 1; DB design section 5, default gate A applied by routes/onboarding/index.js).
// Body (all optional, partial updates are fine): { name, country, industry, website, instagram, crNumber,
// crSkipped, contactEmail, uiLanguage, languages }. The step is `done` once name + country + industry exist.
// crSkipped:true records verificationNeedsCr; a CR number answers the question (crSkipped false). No CR upload.
// Idempotent: only fields that differ are written. Answers with the new /state body.
// contactEmail is OWNER-ONLY (review R2-09: the platform sends system e-mails to it): for anyone else (a live Membership read, the JWT role
// can be 30 days stale) the field is silently dropped and the rest of the request is processed; an address the owner typed is marked
// business.contactEmailByOwner, and only such an address is used for notification mail (shared/onboarding/email.js).
const express = require('express');
const errors = require('../../shared/onboarding/errors');

const PLAIN_KEYS = ['name', 'country', 'industry', 'website', 'instagram', 'crNumber', 'contactEmail', 'uiLanguage', 'languages'];

function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a || null) === JSON.stringify(b || null);
  return (a === undefined || a === null ? null : a) === (b === undefined || b === null ? null : b);
}

function createRouter(deps = {}) {
  const router = express.Router();
  const d = deps || {};

  router.put('/business', async (req, res) => {
    try {
      const steps = d.steps || require('../../shared/onboarding/steps');
      const stateModule = d.state || require('../../shared/onboarding/state');
      const { workspaceId, userId, role } = steps.requestContext(req);
      const doc = await stateModule.ensureState(workspaceId, d); // 404 ONBOARDING_NOT_AVAILABLE for a legacy workspace

      const v = steps.validateBusinessInput(req.body);
      if (!v.ok) throw new errors.OnbError('VALIDATION_FAILED', { details: { fields: v.fields } });
      const val = { ...v.value };
      const stored = doc.business || {};

      let ownerContact = false;
      if (Object.prototype.hasOwnProperty.call(val, 'contactEmail')) {
        if (await steps.isOwner(userId, workspaceId, d)) ownerContact = true;
        else delete val.contactEmail; // not the owner: dropped, nothing else changes
      }

      const set = {};
      const unset = {};
      for (const k of PLAIN_KEYS) {
        if (Object.prototype.hasOwnProperty.call(val, k) && !same(val[k], stored[k])) set[`business.${k}`] = val[k];
      }
      if (ownerContact) {
        // the owner's own address (also an unchanged one the owner confirms) is the only one notification mail may use
        const mark = !!val.contactEmail;
        if (mark !== !!stored.contactEmailByOwner) set['business.contactEmailByOwner'] = mark;
      }
      // CR rule: a CR number answers the question; otherwise crSkipped follows the body; verificationNeedsCr = crSkipped
      const crNumber = Object.prototype.hasOwnProperty.call(val, 'crNumber') ? val.crNumber : stored.crNumber;
      let crSkipped = !!stored.crSkipped;
      if (crNumber) crSkipped = false;
      else if (Object.prototype.hasOwnProperty.call(val, 'crSkipped')) crSkipped = val.crSkipped;
      const crTouched = Object.prototype.hasOwnProperty.call(val, 'crSkipped') || Object.prototype.hasOwnProperty.call(val, 'crNumber');
      if (crTouched) {
        if (crSkipped !== stored.crSkipped) set['business.crSkipped'] = crSkipped;
        if (crSkipped !== stored.verificationNeedsCr) set['business.verificationNeedsCr'] = crSkipped;
        if (crSkipped && !stored.crSkipped) set['business.crSkippedAt'] = (d.now ? d.now() : new Date());
        if (!crSkipped && stored.crSkippedAt) unset['business.crSkippedAt'] = '';
      }

      const update = {};
      if (Object.keys(set).length) update.$set = set;
      if (Object.keys(unset).length) update.$unset = unset;
      if (Object.keys(update).length) {
        const State = d.OnboardingState || require('../../models/OnboardingState');
        await State.updateOne({ workspaceId }, update);
        if (crSkipped && !stored.crSkipped) {
          await steps.trackEvent(workspaceId, { type: 'step_skip', step: 'business', reason: 'cr_skipped' }, d);
        }
      }

      const merged = { ...stored, ...val };
      const target = steps.businessComplete(merged) ? 'done' : 'in_progress';
      if (steps.stepStatus(doc, 'business') !== target && !(target === 'in_progress' && steps.stepDone(doc, 'business'))) {
        await steps.markStep(workspaceId, 'business', target, d);
      }

      const body = await steps.buildState({ workspaceId, userId, role, deps: d });
      return res.json(body);
    } catch (err) {
      return errors.respond(res, err);
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
