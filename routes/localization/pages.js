'use strict';
// Arabic customer pages (spec §3.5): the payment pages and the referral / Instagram
// link pages, right-to-left. Unlike the rest of routes/localization/*, this router is
// PUBLIC (a customer's browser, no login) and is mounted at the app ROOT by server.js,
// in front of the three existing page routers:
//   try { app.use(require('./routes/localization/pages')); } catch (...) {}   // before app.use(require('./routes/pay'))
// The existing handlers never call next(), so a route can only be taken over by being
// registered ahead of them. It declares exactly six GET routes and nothing else, so
// everything else on those paths and prefixes is untouched:
//   /pay/:piId  /payment-result  /payment-cancelled  /r/:code  /c/:code  /t/:code
//
// FAIL OPEN is the whole design. Each request first gets a PLAN from the page modules
// (shared/localization/pages/*): either "fall through" - the router calls next() and the
// untouched English handler answers - or an Arabic page. That happens only when the
// kill switch is off, ?lang is not "en", the merchant has Arabic enabled and the visitor's
// language is Arabic (see pages/index.js). A plan is built from read-only lookups under a
// time budget and never touches the response, so any error or timeout simply falls
// through (nothing has been sent or recorded yet). No cookies are set, no body is parsed.
//
// The one exception is a referral / Instagram "continue" tap (?go=1): the plan carries a
// commit that records the click through the existing exported function. From that moment
// next() is never called - the English handler would record the click a second time -
// and a failure is answered with an Arabic error page.
const express = require('express');
const pages = require('../../shared/localization/pages');
const pay = require('../../shared/localization/pages/pay');
const referral = require('../../shared/localization/pages/referral');
const instagram = require('../../shared/localization/pages/instagram');

const ROUTES = [
  ['/pay/:piId', pay.planPay],
  ['/payment-result', pay.planPaymentResult],
  ['/payment-cancelled', pay.planPaymentCancelled],
  ['/r/:code', (req, deps) => referral.planReferral(req, deps, { generic: false })],
  ['/c/:code', (req, deps) => referral.planReferral(req, deps, { generic: true })],
  ['/t/:code', instagram.planTracking],
];

// Payment pages carry a client secret and the redirect records a click: nothing here is
// ever cacheable.
function send(res, outcome) {
  res.set('Cache-Control', 'no-store');
  if (outcome.redirect) return res.redirect(302, outcome.redirect);
  res.set('Content-Language', 'ar');
  return res.status(outcome.status).type('html').send(outcome.html);
}

async function run(planFn, req, res, next, getDeps) {
  let plan;
  try {
    const deps = getDeps();
    const budget = deps.precheckTimeoutMs || pages.PRECHECK_TIMEOUT_MS;
    plan = await pages.withTimeout(Promise.resolve().then(() => planFn(req, deps)), budget, 'Arabic page lookup');
  } catch (err) {
    console.error('[localization:pages] falling back to the English page:', err && err.message);
    return next();
  }
  if (!plan || plan.next) return next();
  try {
    return send(res, plan.commit ? await plan.commit() : plan);
  } catch (err) {
    console.error('[localization:pages] Arabic page failed:', err && err.message);
    if (res.headersSent) return undefined;
    // A plain page has done nothing yet, so the English page can still answer. After a
    // commit (a click was recorded) it must not, or the click would be counted twice.
    return plan.commit ? send(res, plan.onError()) : next();
  }
}

// getDeps() returns the collaborators (database models, Stripe, click recorders...);
// tests pass fakes, production builds the real ones on the first request.
function createRouter(getDeps) {
  const router = express.Router();
  for (const [path, planFn] of ROUTES) {
    router.get(path, (req, res, next) => run(planFn, req, res, next, getDeps));
  }
  return router;
}

let realDeps = null;
const router = createRouter(() => realDeps || (realDeps = pages.realDeps()));

module.exports = router;
module.exports.createRouter = createRouter;
module.exports.ROUTES = ROUTES;
