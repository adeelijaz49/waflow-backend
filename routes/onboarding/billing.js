'use strict';
// Billing routes of the onboarding flow (DB design 5, DECISIONS C2 / C15). ABSOLUTE paths: routes/onboarding/index.js
// mounts this router at /api/onboarding with the DEFAULT gate E (any enrolled workspace, billing exempt) for
// /checkout, /billing-portal and /billing. Each route repeats its gate so the router is also safe on its own:
//   POST /checkout        owner  -> { url }                      (Stripe-hosted Checkout, https)
//   POST /billing-portal  owner  -> { url }                      (Stripe billing portal, https)
//   POST /billing/refresh E      -> { changed, subscription }    (the server asks Stripe; 1 per 15 s)
// workspaceId and userId only ever come from the verified token (req.user), never from the body.
const express = require('express');
const requireOnboardingAccess = require('../../shared/onboarding/requireOnboardingAccess');
const rateLimit = require('../../shared/onboarding/rateLimit');
const { respond } = require('../../shared/onboarding/errors');

const HOUR_MS = 60 * 60 * 1000;

/**
 * @param {{billing?:object, gateDeps?:object, rateLimitDeps?:object}} [deps] injected for tests
 * @returns {import('express').Router}
 */
function createRouter(deps = {}) {
  const router = express.Router();
  const billing = () => deps.billing || require('../../shared/onboarding/billing');
  const billingDeps = deps.billingDeps;
  const ownerGate = requireOnboardingAccess({ ownerOnly: true, billingExempt: true }, deps.gateDeps);
  const exemptGate = requireOnboardingAccess({ billingExempt: true }, deps.gateDeps);
  const limit = (bucket, cfg) => rateLimit.middleware(bucket, cfg, deps.rateLimitDeps);

  // SUBSCRIPTION_EXISTS is a catalogue code (errors.js): billing.SubscriptionExistsError is an OnbError whose body
  // carries the extra top-level `subscription` key, so the shared responder writes it like every other error.
  function fail(res, err) {
    return respond(res, err);
  }

  router.post('/checkout', ownerGate, limit('checkout', { limit: 10, windowMs: HOUR_MS }), async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await billing().createCheckout({
        workspaceId: req.user.workspaceId,
        userId: req.user.id,
        planCode: typeof body.planCode === 'string' ? body.planCode : '',
      }, billingDeps);
      return res.json({ url: out.url });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post('/billing-portal', ownerGate, limit('billing-portal', { limit: 10, windowMs: HOUR_MS }), async (req, res) => {
    try {
      const out = await billing().createPortal({ workspaceId: req.user.workspaceId }, billingDeps);
      return res.json({ url: out.url });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post('/billing/refresh', exemptGate, limit('billing-refresh', { limit: 1, windowMs: 15 * 1000 }), async (req, res) => {
    try {
      const out = await billing().refreshBilling({ workspaceId: req.user.workspaceId }, billingDeps);
      return res.json({ changed: !!out.changed, subscription: out.subscription });
    } catch (err) {
      return fail(res, err);
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
