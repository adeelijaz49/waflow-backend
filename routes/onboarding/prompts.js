'use strict';
// POST /prompts/customers and POST /prompts/products (DB design section 5, default gate A applied by
// routes/onboarding/index.js). Body { state: 'done' | 'skipped' }.
//   skipped: always accepted (a visible reminder stays while skipped)
//   done:    only when the workspace really has data (read-only count > 0), else 422 VALIDATION_FAILED.
//            customers = Customer rows; products = Product rows + Service rows (the prompt adds either).
// Idempotent: the same state again is a no-op. Answering a prompt also means the merchant has moved past the
// non-blocking approvals screen, so a never-opened approvals step is set to in_progress (see steps.nextStep).
const express = require('express');
const errors = require('../../shared/onboarding/errors');

const KINDS = ['customers', 'products'];
const STATES = ['done', 'skipped'];

function createRouter(deps = {}) {
  const router = express.Router();
  const d = deps || {};

  for (const kind of KINDS) {
    router.post(`/prompts/${kind}`, async (req, res) => {
      try {
        const steps = d.steps || require('../../shared/onboarding/steps');
        const stateModule = d.state || require('../../shared/onboarding/state');
        const { workspaceId } = steps.requestContext(req);
        const doc = await stateModule.ensureState(workspaceId, d);

        const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        if (!STATES.includes(b.state)) throw new errors.OnbError('VALIDATION_FAILED', { details: { fields: { state: 'INVALID' } } });
        const state = b.state;
        const prompts = doc.prompts || {};
        const current = (prompts[kind] && prompts[kind].state) || 'pending';

        if (current !== state) {
          if (state === 'done') {
            const counts = await steps.readCounts(workspaceId, d);
            const have = kind === 'customers'
              ? counts.customers
              : (counts.products === null && counts.services === null ? null : (counts.products || 0) + (counts.services || 0));
            if (have === null) throw new errors.OnbError('INTERNAL_ERROR'); // cannot verify: do not accept a "done" blindly
            if (have <= 0) throw new errors.OnbError('VALIDATION_FAILED', { details: { reason: 'NOTHING_ADDED', fields: { state: 'NO_DATA' } } });
          }
          const now = d.now ? d.now() : new Date();
          const set = { [`prompts.${kind}.state`]: state, [`prompts.${kind}.updatedAt`]: now };
          if (!prompts.promptedAt) set['prompts.promptedAt'] = now;
          const State = d.OnboardingState || require('../../models/OnboardingState');
          await State.updateOne({ workspaceId }, { $set: set });
          await steps.trackEvent(workspaceId, state === 'done'
            ? { type: 'step_complete', step: kind }
            : { type: 'step_skip', step: kind, reason: `${kind}_skipped` }, d);
        }

        let fresh = doc;
        if (steps.stepStatus(doc, 'approvals') === 'todo') fresh = await steps.markStep(workspaceId, 'approvals', 'in_progress', d);
        else if (current !== state) fresh = await stateModule.ensureState(workspaceId, d);
        const p = fresh.prompts || {};
        return res.json({
          kind,
          state,
          nextStep: steps.nextStep(fresh),
          prompts: {
            customers: { state: (p.customers && p.customers.state) || 'pending' },
            products: { state: (p.products && p.products.state) || 'pending' },
          },
        });
      } catch (err) {
        return errors.respond(res, err);
      }
    });
  }

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
