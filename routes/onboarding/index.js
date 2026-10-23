'use strict';
// /api/onboarding router (mounted by shared/onboarding/mount.js behind requireAuth).
//
// - Flag off at request time: the FIRST middleware does next('router'), so the
//   path falls through to today's 404 and nothing onboarding-related is loaded.
// - Gates (INTERFACES 0.4): every request is gated by the table below; a path
//   that matches no listed prefix gets gate A (default-deny: enrolled +
//   active subscription), so a route added later can never be left ungated.
//   Sub-routers define ABSOLUTE paths ('/connect/config') and add only the
//   STRICTER per-route gates (owner / legal) themselves.
// - Sub-routers are required lazily, each inside try/catch: a broken one is
//   logged and skipped, the others keep working.
const express = require('express');
const config = require('../../shared/onboarding/config');

// default gate letters: E = billing-exempt (any enrolled state), A = active subscription, null = none
// (the handler gates itself: /state answers { enrolled:false } to legacy workspaces).
const SUBROUTERS = Object.freeze([
  { name: 'state', file: './state', owner: 'B1-a', prefixes: ['/state', '/help-context', '/preferences'], gate: null },
  { name: 'business', file: './business', owner: 'B1-a', prefixes: ['/business'], gate: 'A' },
  { name: 'number', file: './number', owner: 'B1-a', prefixes: ['/number'], gate: 'A' },
  { name: 'prompts', file: './prompts', owner: 'B1-a', prefixes: ['/prompts'], gate: 'A' },
  { name: 'billing', file: './billing', owner: 'B1-b', prefixes: ['/checkout', '/billing-portal', '/billing'], gate: 'E' },
  { name: 'connect', file: './connect', owner: 'B1-c', prefixes: ['/connect'], gate: 'A' },
  { name: 'connection', file: './connection', owner: 'B1-c', prefixes: ['/connection'], gate: 'A' },
  { name: 'approvals', file: './approvals', owner: 'B1-d', prefixes: ['/approvals', '/display-name'], gate: 'A' },
  { name: 'templates', file: './templates', owner: 'B1-e', prefixes: ['/templates'], gate: 'A' },
  { name: 'test', file: './test', owner: 'B1-e', prefixes: ['/test-message', '/first-promotion'], gate: 'A' },
  // E: the bell and the analytics beacons keep working while a payment is overdue or after a cancellation (spec 1b.5: the merchant
  // "keeps access to their data and their saved onboarding progress"; the payment problem itself is announced there)
  { name: 'notifications', file: './notifications', owner: 'B1-f', prefixes: ['/notifications'], gate: 'E' },
  { name: 'events', file: './events', owner: 'B1-f', prefixes: ['/events'], gate: 'E' },
]);

/** Which default gate letter applies to a request path (case-insensitive, segment boundary). */
function gateFor(path) {
  const p = String(path || '').toLowerCase().replace(/\/+$/, '') || '/';
  for (const sr of SUBROUTERS) {
    if (sr.prefixes.some((x) => p === x || p.startsWith(`${x}/`))) return sr.gate;
  }
  return 'A';
}

function build(overrides = {}) {
  const { requireOnboardingAccess } = require('../../shared/onboarding/requireOnboardingAccess');
  const gates = {
    A: requireOnboardingAccess({}, overrides.gateDeps),
    E: requireOnboardingAccess({ billingExempt: true }, overrides.gateDeps),
  };
  const inner = express.Router();
  inner.use((req, res, next) => {
    const letter = gateFor(req.path);
    if (!letter) return next();
    return gates[letter](req, res, next);
  });
  for (const sr of SUBROUTERS) {
    try {
      const mod = require(sr.file);
      const router = typeof mod.createRouter === 'function' ? mod.createRouter((overrides.routers || {})[sr.name]) : mod;
      inner.use(router);
    } catch (err) {
      config.safeLog('error', `[onboarding] sub-router ${sr.file} not loaded:`, err && err.message);
    }
  }
  return inner;
}

/**
 * Router factory (tests pass overrides = { routers:{name:deps}, gateDeps }).
 * The returned router builds the real sub-router tree lazily on the first request with the flag on.
 */
function createRouter(overrides = {}) {
  const router = express.Router();
  let inner = null;
  router.use((req, res, next) => {
    if (!config.enabled()) return next('router');
    try {
      if (!inner) inner = build(overrides);
    } catch (err) {
      config.safeLog('error', '[onboarding] router build failed:', err && err.message);
      return next('router');
    }
    return inner(req, res, next);
  });
  router._reset = () => { inner = null; };
  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.SUBROUTERS = SUBROUTERS;
module.exports.gateFor = gateFor;
