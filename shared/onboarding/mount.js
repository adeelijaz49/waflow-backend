'use strict';
// Hunk E2 (server.js, before the auth mount): mounts the onboarding HTTP surface.
//
// mount() returns { mounted:false } BEFORE requiring any guard, router or model
// when the flag is off at mount time (Azure env changes restart the app), so a
// flag-off boot loads no onboarding model and registers no onboarding layer
// except the two thin early mounts (earlyMounts.js).
// HOW TESTS ENABLE THE FLOW: set process.env.ONBOARDING_FLOW='on' BEFORE calling
// mount() (or before require('server.js')). The guard and every router ALSO test
// the flag per request, so turning it off after mount makes them inert again.
const config = require('./config');

/**
 * @param {import('express').Express} app
 * @param {{requireAuth:Function, requireInternalAdmin:Function}} deps
 * @returns {{mounted:boolean, parts:string[]}}
 */
function mount(app, deps = {}) {
  if (!config.enabled()) return { mounted: false, parts: [] };

  const express = require('express');
  const parts = [];
  // Falls through to the rest of the app (today's 404) when the flag is off at request time;
  // inside its own Router so next('router') leaves only this wrapper, never the app router.
  const offGate = (req, res, next) => (config.enabled() ? next() : next('router'));
  const wrap = (...handlers) => {
    const r = express.Router();
    r.use(offGate);
    for (const h of handlers) r.use(h);
    return r;
  };
  const attempt = (name, fn) => {
    try { fn(); parts.push(name); } catch (err) {
      console.error(`[onboarding] ${name} not mounted:`, err && err.message);
    }
  };

  attempt('guard', () => {
    app.use('/api', require('./httpGuard').middleware);
  });
  attempt('api', () => {
    if (typeof deps.requireAuth !== 'function') throw new Error('requireAuth is required');
    app.use('/api/onboarding', wrap(deps.requireAuth, require('../../routes/onboarding')));
  });
  attempt('admin', () => {
    if (typeof deps.requireInternalAdmin !== 'function') throw new Error('requireInternalAdmin is required');
    app.use('/internal-admin-onboarding', wrap(deps.requireInternalAdmin, require('../../routes/adminOnboarding')));
  });
  attempt('metaCallbacks', () => {
    app.use('/onboarding-meta', wrap(require('./metaCallbacks').router));
  });
  return { mounted: true, parts };
}

module.exports = { mount };
