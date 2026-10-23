'use strict';
// Step 2 (the WhatsApp number). DB design section 5, default gate A applied by routes/onboarding/index.js.
//   POST /number/path             the questions: Path A (a number exists: four branches) or Path B (no number yet)
//   POST /number/ready            Path B "I've got my number": resumes the flow, step 2 done
//   POST /number/support-request  "Ask WaFlow to help me get a number" (DB-counted limit, de-duplicated, e-mails
//                                 support best effort; it NEVER buys a number)
// Guidance is a list of i18n keys of the onboarding catalogue. Coexistence (using the WhatsApp Business app and
// WaFlow on one number) is UNVERIFIED for Saudi Arabia (AU4 3.1): the keys never promise it and the answer only
// ever says 'unknown' or 'maybe_available' (Meta decides when the merchant connects).
const express = require('express');
const errors = require('../../shared/onboarding/errors');
const rateLimit = require('../../shared/onboarding/rateLimit');

const USAGES = ['unused', 'personal', 'business_app', 'landline'];
const CHOICES = ['coexistence', 'migrate', 'different_number'];
// Meta: "up to 3 minutes for the disconnected number to become available" after the old account is deleted (AU4, HIGH).
const REMOVAL_WAIT_MINUTES = 3;
const GET_NUMBER_KEYS = ['number.getone.title', 'number.getone.body', 'number.getone.t1', 'number.getone.t2', 'number.getone.t3', 'number.getone.t4'];

/**
 * Pure: validate the body of POST /number/path and derive the answer + the static guidance.
 * Throws OnbError (VALIDATION_FAILED | NUMBER_PERSONAL_WARNING_REQUIRED).
 */
function interpretAnswer(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (typeof b.hasNumber !== 'boolean') throw new errors.OnbError('VALIDATION_FAILED', { details: { fields: { hasNumber: 'INVALID' } } });
  if (b.hasNumber === false) {
    return {
      answer: { path: 'B', hasNumber: false, usage: null, businessAppChoice: null, personalWarningAcknowledged: false },
      guidance: { keys: GET_NUMBER_KEYS.slice(), coexistence: 'unknown', callRequired: false, waitMinutes: 0 },
    };
  }
  if (!USAGES.includes(b.usage)) throw new errors.OnbError('VALIDATION_FAILED', { details: { fields: { usage: 'INVALID' } } });
  const usage = b.usage;
  const answer = { path: 'A', hasNumber: true, usage, businessAppChoice: null, personalWarningAcknowledged: false };
  const guidance = { keys: [], coexistence: 'unknown', callRequired: false, waitMinutes: 0 };

  if (usage === 'personal') {
    if (b.acknowledgeRemoval !== true) throw new errors.OnbError('NUMBER_PERSONAL_WARNING_REQUIRED');
    answer.personalWarningAcknowledged = true;
    guidance.keys = ['number.personal.title', 'number.personal.warning', 'number.personal.how'];
    guidance.waitMinutes = REMOVAL_WAIT_MINUTES;
  } else if (usage === 'business_app') {
    if (!CHOICES.includes(b.businessAppChoice)) throw new errors.OnbError('VALIDATION_FAILED', { details: { fields: { businessAppChoice: 'INVALID' } } });
    answer.businessAppChoice = b.businessAppChoice;
    if (b.businessAppChoice === 'different_number') {
      answer.path = 'B';
      guidance.keys = GET_NUMBER_KEYS.slice();
    } else if (b.businessAppChoice === 'migrate') {
      guidance.keys = ['number.migrate.title', 'number.migrate.body'];
      guidance.waitMinutes = REMOVAL_WAIT_MINUTES;
    } else {
      guidance.keys = ['number.bizapp.title', 'number.bizapp.body', 'number.bizapp.changes', 'number.bizapp.c1', 'number.bizapp.c2', 'number.bizapp.c3', 'number.bizapp.c4'];
      guidance.coexistence = 'maybe_available';
    }
  } else if (usage === 'landline') {
    guidance.keys = ['number.landline.title', 'number.landline.body'];
    guidance.callRequired = true;
  }
  return { answer, guidance };
}

function sameAnswer(number, answer) {
  const n = number || {};
  return n.path === answer.path
    && (typeof n.hasNumber === 'boolean' ? n.hasNumber : null) === answer.hasNumber
    && (n.usage || null) === answer.usage
    && (n.businessAppChoice || null) === answer.businessAppChoice
    && !!n.personalWarningAcknowledged === answer.personalWarningAcknowledged
    && !!n.usageAnsweredAt;
}

function createRouter(deps = {}) {
  const router = express.Router();
  const d = deps || {};
  const lib = () => ({
    steps: d.steps || require('../../shared/onboarding/steps'),
    state: d.state || require('../../shared/onboarding/state'),
  });

  router.post('/number/path', async (req, res) => {
    try {
      const { steps, state } = lib();
      const { workspaceId } = steps.requestContext(req);
      const doc = await state.ensureState(workspaceId, d);
      const { answer, guidance } = interpretAnswer(req.body);
      const now = d.now ? d.now() : new Date();
      const same = sameAnswer(doc.number, answer);

      // After a connection exists the answers can no longer change; re-sending the same answer is a no-op.
      if (!same) {
        let conn = null;
        try {
          const Conn = d.WhatsAppConnection || require('../../models/WhatsAppConnection');
          conn = await Conn.findOne({ workspaceId }).select('status needsReconnect').lean();
        } catch (_) { conn = null; }
        const connected = steps.stepDone(doc, 'connect') || !!(conn && steps.CONNECTION_EXISTS_STATUSES.includes(conn.status));
        if (connected) throw new errors.OnbError('NUMBER_ALREADY_CONNECTED');

        const set = {
          'number.path': answer.path,
          'number.hasNumber': answer.hasNumber,
          'number.usage': answer.usage,
          'number.businessAppChoice': answer.businessAppChoice,
          'number.personalWarningAcknowledged': answer.personalWarningAcknowledged,
          'number.usageAnsweredAt': now,
        };
        if (answer.path === 'B') {
          set['number.numberReady'] = false;
          if (!(doc.number && doc.number.pausedAt) || (doc.progress && doc.progress.status !== 'paused_number')) set['number.pausedAt'] = now;
        }
        const State = d.OnboardingState || require('../../models/OnboardingState');
        await State.updateOne({ workspaceId }, { $set: set });
      }

      // keep the step and progress consistent with the answer (a no-op when they already are)
      const target = answer.path === 'A' ? 'done' : 'in_progress';
      const paused = !!(doc.progress && doc.progress.status === 'paused_number');
      let fresh = doc;
      if (steps.stepStatus(doc, 'number') !== target || (answer.path === 'B' && !paused) || (answer.path === 'A' && paused) || !same) {
        const wasPaused = paused;
        fresh = await steps.markStep(workspaceId, 'number', target, d);
        if (answer.path === 'B' && !wasPaused) {
          await steps.trackEvent(workspaceId, { type: 'step_skip', step: 'number', reason: 'number_paused', meta: { path: 'B', usage: answer.usage || undefined } }, d);
        }
      }
      return res.json({ path: answer.path, nextStep: steps.nextStep(fresh), guidance });
    } catch (err) {
      return errors.respond(res, err);
    }
  });

  router.post('/number/ready', async (req, res) => {
    try {
      const { steps, state } = lib();
      const { workspaceId } = steps.requestContext(req);
      const doc = await state.ensureState(workspaceId, d);
      const n = doc.number || {};
      let fresh = doc;
      const alreadyDone = steps.stepDone(doc, 'number') && (n.path === 'A' || n.numberReady === true);
      if (!alreadyDone) {
        const set = { 'number.numberReady': true };
        if (!n.path) set['number.path'] = 'B';
        const State = d.OnboardingState || require('../../models/OnboardingState');
        await State.updateOne({ workspaceId }, { $set: set });
        fresh = await steps.markStep(workspaceId, 'number', 'done', d);
      }
      return res.json({ path: (fresh.number && fresh.number.path) || 'B', numberReady: true, nextStep: steps.nextStep(fresh) });
    } catch (err) {
      return errors.respond(res, err);
    }
  });

  // a cheap first line in front of the DB-counted limits (3 per day, one per 10-minute window, atomic): at most 10 attempts per 10 minutes per workspace
  const supportLimit = rateLimit.middleware('number_support_request', { limit: 10, windowMs: 10 * 60 * 1000 }, d.rateLimitDeps || d);

  router.post('/number/support-request', supportLimit, async (req, res) => {
    try {
      const { steps } = lib();
      const support = d.support || require('../../shared/onboarding/support');
      const { workspaceId, userId } = steps.requestContext(req);
      const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      if (b.message !== undefined && b.message !== null && typeof b.message !== 'string') {
        throw new errors.OnbError('VALIDATION_FAILED', { details: { fields: { message: 'INVALID' } } });
      }
      const { request, duplicate } = await support.createSupportRequest({ workspaceId, userId, kind: 'number_help', step: 'number', message: b.message }, d);
      return res.json({ ok: true, duplicate, requestId: request.id });
    } catch (err) {
      return errors.respond(res, err);
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.interpretAnswer = interpretAnswer;
module.exports.sameAnswer = sameAnswer;
module.exports.REMOVAL_WAIT_MINUTES = REMOVAL_WAIT_MINUTES;
