'use strict';
// routes/onboarding/index.js: lazy router, flag handling, default gates, sub-router isolation.
const express = require('express');
const request = require('supertest');

const WS = '507f1f77bcf86cd799439011';
const SUBS = ['state', 'business', 'number', 'prompts', 'billing', 'connect', 'connection', 'approvals', 'templates', 'test', 'notifications', 'events'];

let savedFlag;
beforeEach(() => {
  savedFlag = process.env.ONBOARDING_FLOW;
  delete process.env.ONBOARDING_FLOW;
  SUBS.forEach((n) => jest.dontMock(`../../../routes/onboarding/${n}`));
  jest.resetModules();
});
afterEach(() => { if (savedFlag === undefined) delete process.env.ONBOARDING_FLOW; else process.env.ONBOARDING_FLOW = savedFlag; });

const conn = (status) => ({ status, needsReconnect: false });
const gs = (state) => ({ enrolled: true, sub: { state, source: null }, conn: conn('connected'), legacyPolicy: 'block' });

/** Mini app: injects req.user (as requireAuth would) and mounts the index router at /api/onboarding. */
function buildApp(gateState, overrides = {}, user = { id: '507f1f77bcf86cd799439099', workspaceId: WS, role: 'owner' }) {
  const { createRouter } = require('../../../routes/onboarding');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use('/api/onboarding', createRouter({ gateDeps: { getGateState: async () => gateState }, ...overrides }));
  return app;
}
function mockSub(name, build) {
  jest.doMock(`../../../routes/onboarding/${name}`, () => {
    const exp = require('express');
    const createRouter = () => { const r = exp.Router(); build(r); return r; };
    const router = createRouter();
    router.createRouter = createRouter;
    return router;
  });
}

describe('flag handling', () => {
  test('flag off: every path falls through to the default 404 (same as an unknown route)', async () => {
    const app = buildApp(gs('active'));
    for (const [method, path] of [['get', '/api/onboarding/state'], ['post', '/api/onboarding/connect/complete'], ['get', '/api/onboarding/whatever']]) {
      const res = await request(app)[method](path);
      expect(res.status).toBe(404);
      expect(res.text).toMatch(/Cannot/); // Express's own default page: not our JSON
    }
  });
  test('flag off: no sub-router and no model is loaded', async () => {
    const mongoose = require('mongoose');
    const loaded = [];
    SUBS.forEach((n) => jest.doMock(`../../../routes/onboarding/${n}`, () => { loaded.push(n); return require('express').Router(); }));
    const app = buildApp(gs('active'));
    await request(app).get('/api/onboarding/state');
    expect(loaded).toEqual([]);
    expect(mongoose.modelNames().filter((n) => /^(Onboarding|WhatsAppConnection)/.test(n))).toEqual([]);
  });
  test('flag turned on later builds the tree lazily; turned off again -> inert', async () => {
    mockSub('state', (r) => r.get('/state', (req, res) => res.json({ ok: true })));
    const app = buildApp(gs('active'));
    expect((await request(app).get('/api/onboarding/state')).status).toBe(404);
    process.env.ONBOARDING_FLOW = 'on';
    expect((await request(app).get('/api/onboarding/state')).body).toEqual({ ok: true });
    delete process.env.ONBOARDING_FLOW;
    expect((await request(app).get('/api/onboarding/state')).status).toBe(404);
  });
});

describe('default gates (flag on)', () => {
  beforeEach(() => {
    process.env.ONBOARDING_FLOW = 'on';
    const ok = (r, method, path) => r[method](path, (req, res) => res.json({ ok: true, gate: !!(req.onboarding && req.onboarding.gate) }));
    mockSub('state', (r) => { ok(r, 'get', '/state'); ok(r, 'get', '/help-context'); ok(r, 'post', '/preferences'); });
    mockSub('business', (r) => ok(r, 'put', '/business'));
    mockSub('billing', (r) => { ok(r, 'post', '/checkout'); ok(r, 'post', '/billing-portal'); ok(r, 'post', '/billing/refresh'); });
    mockSub('connect', (r) => ok(r, 'post', '/connect/complete'));
    mockSub('approvals', (r) => { ok(r, 'get', '/approvals'); ok(r, 'post', '/display-name'); });
    mockSub('test', (r) => { ok(r, 'post', '/test-message'); ok(r, 'get', '/first-promotion'); });
  });

  test('state routes have NO default gate (the handler answers { enrolled:false } itself): a legacy workspace reaches them', async () => {
    const app = buildApp({ enrolled: false });
    expect((await request(app).get('/api/onboarding/state')).body.ok).toBe(true);
    expect((await request(app).get('/api/onboarding/help-context')).status).toBe(200);
  });
  test('a legacy workspace calling any gated route gets the 404 ONBOARDING_NOT_AVAILABLE', async () => {
    const app = buildApp({ enrolled: false });
    for (const [method, path] of [['put', '/business'], ['post', '/connect/complete'], ['get', '/approvals'], ['post', '/test-message'], ['post', '/checkout']]) {
      const res = await request(app)[method](`/api/onboarding${path}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ONBOARDING_NOT_AVAILABLE');
    }
  });
  test('unpaid enrolled workspace: step routes -> 402, billing routes (E) pass', async () => {
    const app = buildApp(gs('none'));
    const business = await request(app).put('/api/onboarding/business');
    expect(business.status).toBe(402);
    expect(business.body.code).toBe('SUBSCRIPTION_REQUIRED');
    expect((await request(app).post('/api/onboarding/connect/complete')).status).toBe(402);
    expect((await request(app).get('/api/onboarding/approvals')).status).toBe(402);
    for (const path of ['/checkout', '/billing-portal', '/billing/refresh']) {
      const res = await request(app).post(`/api/onboarding${path}`);
      expect(res.status).toBe(200);
      expect(res.body.gate).toBe(true);
    }
  });
  test.each(['pending', 'past_due', 'cancelled'])('%s: step writes refused with that state\'s code', async (state) => {
    const res = await request(buildApp(gs(state))).put('/api/onboarding/business');
    expect(res.status).toBe(402);
    expect({ pending: 'PAYMENT_PENDING', past_due: 'PAYMENT_PAST_DUE', cancelled: 'SUBSCRIPTION_CANCELLED' }[state]).toBe(res.body.code);
  });
  test('active: step routes pass with req.onboarding.gate set', async () => {
    const res = await request(buildApp(gs('active'))).put('/api/onboarding/business');
    expect(res.body).toEqual({ ok: true, gate: true });
  });
  test('notifications and events are billing-exempt (gate E): they keep working for none, pending, past_due and cancelled, legacy workspaces still get the 404', async () => {
    mockSub('notifications', (r) => { r.get('/notifications', (req, res) => res.json({ ok: true, gate: !!(req.onboarding && req.onboarding.gate) })); r.post('/notifications/read', (req, res) => res.json({ ok: true })); });
    mockSub('events', (r) => r.post('/events', (req, res) => res.status(204).end()));
    for (const state of ['none', 'pending', 'active', 'past_due', 'cancelled']) {
      const app = buildApp(gs(state));
      const list = await request(app).get('/api/onboarding/notifications');
      expect([state, list.status, list.body.gate]).toEqual([state, 200, true]);
      expect([state, (await request(app).post('/api/onboarding/notifications/read').send({ all: true })).status]).toEqual([state, 200]);
      expect([state, (await request(app).post('/api/onboarding/events').send({ type: 'help_opened' })).status]).toEqual([state, 204]);
    }
    const legacy = buildApp({ enrolled: false });
    for (const [method, path] of [['get', '/notifications'], ['post', '/notifications/read'], ['post', '/events']]) {
      const res = await request(legacy)[method](`/api/onboarding${path}`);
      expect([path, res.status, res.body.code]).toEqual([path, 404, 'ONBOARDING_NOT_AVAILABLE']);
    }
    const { gateFor } = require('../../../routes/onboarding');
    expect(['/notifications', '/notifications/read', '/events', '/Notifications/', '/EVENTS'].map((p) => gateFor(p))).toEqual(['E', 'E', 'E', 'E', 'E']);
    expect(['/notificationsx', '/eventsx', '/events-beacon'].map((p) => gateFor(p))).toEqual(['A', 'A', 'A']);
  });
  test('default-deny: a path that matches no listed prefix is gated with A (cannot be left ungated)', async () => {
    mockSub('events', (r) => r.post('/brand-new-route', (req, res) => res.json({ ok: true })));
    const denied = await request(buildApp(gs('none'))).post('/api/onboarding/brand-new-route');
    expect(denied.status).toBe(402);
    const ok = await request(buildApp(gs('active'))).post('/api/onboarding/brand-new-route');
    expect(ok.status).toBe(200);
  });
  test('prefix matching is on a path-segment boundary and case-insensitive', async () => {
    const app = buildApp(gs('none'));
    expect((await request(app).post('/api/onboarding/Checkout')).status).toBe(200);   // E gate, case-insensitive like Express routing
    expect((await request(app).post('/api/onboarding/CONNECT/complete')).status).toBe(402);
    const { gateFor } = require('../../../routes/onboarding');
    expect(gateFor('/connection/refresh')).toBe('A');
    expect(gateFor('/connect')).toBe('A');
    expect(gateFor('/billing')).toBe('E');
    expect(gateFor('/billingx')).toBe('A');
    expect(gateFor('/state/')).toBeNull();
    expect(gateFor('/statex')).toBe('A');
  });
  test('workspaceId in the body or query is ignored: the gate uses the token workspace', async () => {
    const seen = [];
    const app = buildApp(null, { gateDeps: { getGateState: async (id) => { seen.push(id); return gs('active'); } } });
    await request(app).put('/api/onboarding/business?workspaceId=507f1f77bcf86cd799439888').send({ workspaceId: '507f1f77bcf86cd799439777' });
    expect(seen).toEqual([WS]);
  });
});

describe('sub-router isolation', () => {
  test('a sub-router that fails to load is logged and skipped; the others keep working', async () => {
    process.env.ONBOARDING_FLOW = 'on';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.doMock('../../../routes/onboarding/business', () => { throw new Error('syntax error in business.js'); });
    mockSub('number', (r) => r.post('/number/ready', (req, res) => res.json({ number: true })));
    const app = buildApp(gs('active'));
    expect((await request(app).post('/api/onboarding/number/ready')).body).toEqual({ number: true });
    expect((await request(app).put('/api/onboarding/business')).status).toBe(404);
    expect(JSON.stringify(spy.mock.calls)).toContain('business');
    spy.mockRestore();
  });
  test('createRouter(deps) of a sub-router receives overrides.routers[name]', async () => {
    process.env.ONBOARDING_FLOW = 'on';
    let received;
    jest.doMock('../../../routes/onboarding/prompts', () => {
      const exp = require('express');
      const createRouter = (deps) => { received = deps; return exp.Router(); };
      const r = createRouter(); r.createRouter = createRouter; return r;
    });
    const app = buildApp(gs('active'), { routers: { prompts: { fake: 1 } } });
    await request(app).get('/api/onboarding/nothing');
    expect(received).toEqual({ fake: 1 });
  });
  test('a sub-router that is a plain Router (no createRouter) works too', async () => {
    process.env.ONBOARDING_FLOW = 'on';
    jest.doMock('../../../routes/onboarding/events', () => {
      const r = require('express').Router();
      r.post('/events', (req, res) => res.json({ plain: true }));
      return r;
    });
    expect((await request(buildApp(gs('active'))).post('/api/onboarding/events')).body).toEqual({ plain: true });
  });
});

describe('table', () => {
  test('SUBROUTERS matches INTERFACES section 4 (files, prefixes, default gates, owners)', () => {
    const { SUBROUTERS } = require('../../../routes/onboarding');
    expect(SUBROUTERS.map((s) => [s.name, s.gate, s.owner, s.prefixes])).toEqual([
      ['state', null, 'B1-a', ['/state', '/help-context', '/preferences']],
      ['business', 'A', 'B1-a', ['/business']],
      ['number', 'A', 'B1-a', ['/number']],
      ['prompts', 'A', 'B1-a', ['/prompts']],
      ['billing', 'E', 'B1-b', ['/checkout', '/billing-portal', '/billing']],
      ['connect', 'A', 'B1-c', ['/connect']],
      ['connection', 'A', 'B1-c', ['/connection']],
      ['approvals', 'A', 'B1-d', ['/approvals', '/display-name']],
      ['templates', 'A', 'B1-e', ['/templates']],
      ['test', 'A', 'B1-e', ['/test-message', '/first-promotion']],
      ['notifications', 'E', 'B1-f', ['/notifications']],
      ['events', 'E', 'B1-f', ['/events']],
    ]);
  });
  test('every file of the table exists and exports a Router + createRouter (stubs included)', () => {
    process.env.ONBOARDING_FLOW = 'on';
    const { SUBROUTERS } = require('../../../routes/onboarding');
    for (const s of SUBROUTERS) {
      const mod = require(`../../../routes/onboarding/${s.file.slice(2)}`);
      expect(typeof mod).toBe('function');
      expect(typeof mod.createRouter).toBe('function');
      expect(typeof mod.createRouter()).toBe('function');
    }
  });
});
