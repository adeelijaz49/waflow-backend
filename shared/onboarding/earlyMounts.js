'use strict';
// Hunk E1 (server.js, between the existing Stripe raw route and express.json()):
// the two routes that MUST be registered before the JSON body parser.
//   - POST /stripe-billing-webhook: raw body, own signing secret (B1-b's handler)
//   - POST /webhook: the Meta signature middleware (B1-d), registered BEFORE
//     express.json() so it can read the raw bytes
// Both are pass-throughs when the flag is off (first statement, no stream read,
// no DB, no model) and resolve their real handler LAZILY per request, so a
// stub or a missing/broken module never breaks the app.
const config = require('./config');

function mount(app, express) {
  const billingGate = (req, res, next) => (config.enabled() ? next() : next('route'));

  const billingHandler = (req, res, next) => {
    let handler;
    try { handler = require('./stripeWebhook').handler; } catch (err) {
      config.safeLog('error', '[onboarding] stripe billing webhook not loadable:', err && err.message);
      return next('route');
    }
    if (typeof handler !== 'function') return next('route');
    return Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((err) => {
        config.safeLog('error', '[onboarding] stripe billing webhook failed:', err && err.code, err && err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Something went wrong', code: 'INTERNAL_ERROR' });
      });
  };

  app.post('/stripe-billing-webhook', billingGate, express.raw({ type: 'application/json', limit: '1mb' }), billingHandler);

  app.post('/webhook', (req, res, next) => {
    if (!config.enabled()) return next();
    let mw;
    try { mw = require('./webhookSignature').middleware; } catch (err) {
      config.safeLog('error', '[onboarding] webhook signature middleware not loadable:', err && err.message);
      return next();
    }
    if (typeof mw !== 'function') return next();
    return Promise.resolve()
      .then(() => mw(req, res, next))
      .catch((err) => {
        config.safeLog('error', '[onboarding] webhook signature middleware failed:', err && err.code, err && err.message);
        if (!res.headersSent) next();
      });
  });
}

module.exports = { mount };
