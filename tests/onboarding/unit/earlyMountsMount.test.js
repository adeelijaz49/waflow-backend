'use strict';
// earlyMounts (hunk E1) and mount (hunk E2): inert with the flag off.
const express = require('express');
const request = require('supertest');

let savedFlag;
const MOCKED = ['../../../shared/onboarding/stripeWebhook', '../../../shared/onboarding/webhookSignature', '../../../routes/onboarding'];
beforeEach(() => {
  savedFlag = process.env.ONBOARDING_FLOW;
  delete process.env.ONBOARDING_FLOW;
  MOCKED.forEach((m) => jest.dontMock(m)); // doMock factories survive resetModules
  jest.resetModules();
});
afterEach(() => { if (savedFlag === undefined) delete process.env.ONBOARDING_FLOW; else process.env.ONBOARDING_FLOW = savedFlag; });

// server.js order: early mounts, then express.json(), then the real routes.
function buildApp({ early = true } = {}) {
  const app = express();
  if (early) require('../../../shared/onboarding/earlyMounts').mount(app, express);
  app.use(express.json());
  app.post('/webhook', (req, res) => res.json({ legacy: true, body: req.body, sig: req.metaSignature || null }));
  return app;
}

describe('earlyMounts with the flag OFF', () => {
  test('POST /stripe-billing-webhook falls through to the default 404 (identical to an unknown route)', async () => {
    const app = buildApp();
    const bare = express(); bare.use(express.json());
    const a = await request(app).post('/stripe-billing-webhook').set('Content-Type', 'application/json').send('{"x":1}');
    const b = await request(bare).post('/stripe-billing-webhook').set('Content-Type', 'application/json').send('{"x":1}');
    expect(a.status).toBe(404);
    expect(a.status).toBe(b.status);
    expect(a.text).toBe(b.text);
  });
  test('POST /webhook reaches the legacy handler with the body parsed by express.json (stream untouched)', async () => {
    const res = await request(buildApp()).post('/webhook').send({ entry: [{ id: '1' }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ legacy: true, body: { entry: [{ id: '1' }] }, sig: null });
  });
  test('the stripe and signature modules are not even loaded', () => {
    jest.isolateModules(() => {
      const loaded = [];
      jest.doMock('../../../shared/onboarding/stripeWebhook', () => { loaded.push('stripeWebhook'); return { handler: (req, res) => res.sendStatus(204) }; });
      jest.doMock('../../../shared/onboarding/webhookSignature', () => { loaded.push('webhookSignature'); return { middleware: (req, res, next) => next() }; });
      const app = express();
      require('../../../shared/onboarding/earlyMounts').mount(app, express);
      expect(loaded).toEqual([]);
    });
  });
  test('no onboarding model is registered by loading earlyMounts + mount with the flag off', () => {
    jest.isolateModules(() => {
      const mongoose = require('mongoose');
      const app = express();
      require('../../../shared/onboarding/earlyMounts').mount(app, express);
      const out = require('../../../shared/onboarding/mount').mount(app, { requireAuth: () => {}, requireInternalAdmin: () => {} });
      expect(out).toEqual({ mounted: false, parts: [] });
      expect(mongoose.modelNames().filter((n) => /^(Onboarding|WhatsAppConnection|WhatsAppClaim)/.test(n))).toEqual([]);
    });
  });
});

describe('earlyMounts with the flag ON', () => {
  beforeEach(() => { process.env.ONBOARDING_FLOW = 'on'; });

  test('the billing webhook handler receives the RAW body (Buffer) before express.json', async () => {
    let seen;
    jest.doMock('../../../shared/onboarding/stripeWebhook', () => ({ handler: (req, res) => { seen = { isBuffer: Buffer.isBuffer(req.body), text: req.body.toString('utf8') }; res.status(200).json({ ok: true }); } }));
    const res = await request(buildApp()).post('/stripe-billing-webhook').set('Content-Type', 'application/json').send('{"id":"evt_1"}');
    expect(res.status).toBe(200);
    expect(seen).toEqual({ isBuffer: true, text: '{"id":"evt_1"}' });
  });
  test('with the REAL stripeWebhook and no signing secret the billing webhook answers 503 CHECKOUT_NOT_CONFIGURED (never crashes)', async () => {
    const saved = process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET;
    delete process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET;
    try {
      const res = await request(buildApp()).post('/stripe-billing-webhook').set('Content-Type', 'application/json').send('{}');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('CHECKOUT_NOT_CONFIGURED');
    } finally { if (saved !== undefined) process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET = saved; }
  });
  test('with the REAL stripeWebhook and a signing secret an unsigned body is a 400 (signature checked on the raw body)', async () => {
    const saved = process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET;
    process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET = 'whsec_test_unit_secret_0123456789';
    try {
      const res = await request(buildApp()).post('/stripe-billing-webhook').set('Content-Type', 'application/json').send('{}');
      expect(res.status).toBe(400);
    } finally { if (saved === undefined) delete process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET; else process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET = saved; }
  });
  test('a billing handler that throws -> 500 INTERNAL_ERROR', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.doMock('../../../shared/onboarding/stripeWebhook', () => ({ handler: async () => { throw new Error('boom'); } }));
    const res = await request(buildApp()).post('/stripe-billing-webhook').set('Content-Type', 'application/json').send('{}');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    spy.mockRestore();
  });
  test('a missing/broken stripeWebhook module -> default 404, the app keeps working', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.doMock('../../../shared/onboarding/stripeWebhook', () => { throw new Error('cannot load'); });
    const app = buildApp();
    expect((await request(app).post('/stripe-billing-webhook').set('Content-Type', 'application/json').send('{}')).status).toBe(404);
    expect((await request(app).post('/webhook').send({ a: 1 })).status).toBe(200);
    spy.mockRestore();
  });
  test('POST /webhook runs the signature middleware first, then the legacy handler', async () => {
    jest.doMock('../../../shared/onboarding/webhookSignature', () => ({ middleware: (req, res, next) => { req.metaSignature = 'valid'; next(); } }));
    const res = await request(buildApp()).post('/webhook').send({ entry: [] });
    expect(res.body).toMatchObject({ legacy: true, sig: 'valid' });
  });
  test('the signature middleware can answer for itself (e.g. 403 for an unsigned merchant payload)', async () => {
    jest.doMock('../../../shared/onboarding/webhookSignature', () => ({ middleware: (req, res) => res.sendStatus(403) }));
    expect((await request(buildApp()).post('/webhook').send({ entry: [] })).status).toBe(403);
  });
  test('a throwing / unloadable signature middleware never breaks the webhook (fail open to the legacy handler)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.doMock('../../../shared/onboarding/webhookSignature', () => ({ middleware: async () => { throw new Error('boom'); } }));
    expect((await request(buildApp()).post('/webhook').send({ a: 1 })).body.legacy).toBe(true);
    jest.resetModules();
    jest.doMock('../../../shared/onboarding/webhookSignature', () => { throw new Error('cannot load'); });
    expect((await request(buildApp()).post('/webhook').send({ a: 1 })).body.legacy).toBe(true);
    spy.mockRestore();
  });
  test('turning the flag off after mount makes both early routes inert again', async () => {
    jest.doMock('../../../shared/onboarding/webhookSignature', () => ({ middleware: (req, res) => res.sendStatus(403) }));
    const app = buildApp();
    expect((await request(app).post('/webhook').send({ a: 1 })).status).toBe(403);
    delete process.env.ONBOARDING_FLOW;
    expect((await request(app).post('/webhook').send({ a: 1 })).status).toBe(200);
    expect((await request(app).post('/stripe-billing-webhook').set('Content-Type', 'application/json').send('{}')).status).toBe(404);
  });
});

describe('mount', () => {
  test('flag off: returns { mounted:false } and registers NOTHING on the app', () => {
    const app = { use: jest.fn(), get: jest.fn(), post: jest.fn() };
    const out = require('../../../shared/onboarding/mount').mount(app, { requireAuth: () => {}, requireInternalAdmin: () => {} });
    expect(out).toEqual({ mounted: false, parts: [] });
    expect(app.use).not.toHaveBeenCalled();
  });
  test('flag on: guard + api + admin + metaCallbacks are mounted in that order, each wrapped', () => {
    process.env.ONBOARDING_FLOW = 'on';
    const mounts = [];
    const app = { use: jest.fn((...a) => mounts.push(a[0])) };
    const out = require('../../../shared/onboarding/mount').mount(app, { requireAuth: (req, res, next) => next(), requireInternalAdmin: (req, res, next) => next() });
    expect(out.mounted).toBe(true);
    expect(out.parts).toEqual(['guard', 'api', 'admin', 'metaCallbacks']);
    expect(mounts).toEqual(['/api', '/api/onboarding', '/internal-admin-onboarding', '/onboarding-meta']);
  });
  test('flag on but requireAuth missing: the API is NOT mounted unauthenticated', () => {
    process.env.ONBOARDING_FLOW = 'on';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mounts = [];
    const app = { use: jest.fn((...a) => mounts.push(a[0])) };
    const out = require('../../../shared/onboarding/mount').mount(app, {});
    expect(out.parts).toEqual(['guard', 'metaCallbacks']);
    expect(mounts).not.toContain('/api/onboarding');
    expect(mounts).not.toContain('/internal-admin-onboarding');
    spy.mockRestore();
  });
  test('a broken part does not stop the others', () => {
    process.env.ONBOARDING_FLOW = 'on';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.doMock('../../../routes/onboarding', () => { throw new Error('router broke'); });
    const app = { use: jest.fn() };
    const out = require('../../../shared/onboarding/mount').mount(app, { requireAuth: (r, s, n) => n(), requireInternalAdmin: (r, s, n) => n() });
    expect(out.parts).toEqual(['guard', 'admin', 'metaCallbacks']);
    spy.mockRestore();
  });
  test('mounted for real: with the flag turned off after mount, /api/onboarding, the admin page and /onboarding-meta fall through to the default 404 BEFORE requireAuth', async () => {
    process.env.ONBOARDING_FLOW = 'on';
    const app = express();
    const authCalls = jest.fn();
    const adminCalls = jest.fn((req, res) => res.status(401).send('admin auth'));
    const authMw = (req, res) => { authCalls(); res.status(401).json({ error: 'Not logged in' }); };
    require('../../../shared/onboarding/mount').mount(app, { requireAuth: authMw, requireInternalAdmin: adminCalls });
    // flag on: requireAuth answers 401 for an unauthenticated request (the router sits behind it)
    expect((await request(app).get('/api/onboarding/state')).status).toBe(401);
    delete process.env.ONBOARDING_FLOW;
    authCalls.mockClear();
    for (const path of ['/api/onboarding/state', '/internal-admin-onboarding', '/onboarding-meta/deauthorize']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
    }
    expect(authCalls).not.toHaveBeenCalled();
    expect(adminCalls).not.toHaveBeenCalled();
  });
});
