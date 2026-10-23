'use strict';
const express = require('express');
const request = require('supertest');
const stateRouter = require('../../../routes/onboarding/state');
const stateModule = require('../../../shared/onboarding/state');
const { createFakeModel } = require('./_b0Store');

const WS = '507f1f77bcf86cd7994390a1';
const OTHER = '507f1f77bcf86cd7994390a2';
const OWNER = '507f1f77bcf86cd7994390b1';
const MEMBER = '507f1f77bcf86cd7994390b2';
const NOW = new Date('2026-10-15T10:00:00Z');
const done = { status: 'done', completedAt: NOW };

const ENV = ['ONBOARDING_FLOW', 'ONBOARDING_SUPPORT_EMAIL', 'ONBOARDING_SUPPORT_WHATSAPP'];
const saved = {};
beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } stateModule.clearCache(); });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function makeKit(docs = {}) {
  const deps = {
    OnboardingState: createFakeModel({ unique: [['workspaceId']] }),
    OnboardingSupportRequest: createFakeModel(),
    WhatsAppConnection: createFakeModel({ unique: [['workspaceId']] }),
    Membership: createFakeModel(),
    Customer: createFakeModel(),
    Product: createFakeModel(),
    Service: createFakeModel(),
    notifications: { unreadCount: async () => 2 },
    statusRefresh: { snapshot: () => { throw Object.assign(new Error('stub'), { code: 'NOT_IMPLEMENTED' }); } },
    track: jest.fn(async () => {}),
    now: () => NOW,
  };
  deps.gateDeps = { getGateState: (id) => stateModule.getGateState(id, { fresh: true, deps }) };
  for (const [id, doc] of Object.entries(docs)) deps.OnboardingState.seed({ workspaceId: id, enrolled: true, ...doc });
  deps.Membership.seed({ userId: OWNER, workspaceId: WS, role: 'owner' });
  deps.Membership.seed({ userId: MEMBER, workspaceId: WS, role: 'member' });
  return deps;
}
const USERS = {
  owner: { id: OWNER, workspaceId: WS, role: 'owner' },
  member: { id: MEMBER, workspaceId: WS, role: 'member' },
  other: { id: '507f1f77bcf86cd7994390c1', workspaceId: OTHER, role: 'owner' },
  none: { id: OWNER },
};
function makeApp(deps, router) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = USERS[req.get('x-user') || 'owner']; next(); });
  app.use(router || stateRouter.createRouter(deps));
  return app;
}
const get = (app, path, who = 'owner') => request(app).get(path).set('x-user', who);
const post = (app, path, body, who = 'owner') => request(app).post(path).set('x-user', who).send(body);
const row = (deps, id = WS) => deps.OnboardingState.rows.find((r) => String(r.workspaceId) === id);

describe('router shape', () => {
  test('exports a router, createRouter and the three absolute paths of INTERFACES 2.17', () => {
    expect(typeof stateRouter).toBe('function');
    expect(typeof stateRouter.createRouter).toBe('function');
    const paths = stateRouter.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
    expect(paths).toEqual(['get /state', 'get /help-context', 'post /preferences']);
  });
});

describe('GET /state', () => {
  test('not enrolled (legacy workspace) -> 200 { enrolled:false }, nothing written', async () => {
    const deps = makeKit();
    const res = await get(makeApp(deps), '/state');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enrolled: false });
    expect(deps.OnboardingState.calls.every((c) => c[0] === 'findOne')).toBe(true);
  });
  test('a token without a workspace -> { enrolled:false }', async () => {
    const res = await get(makeApp(makeKit()), '/state', 'none');
    expect(res.body).toEqual({ enrolled: false });
  });
  test('un-enrolled sidecar -> { enrolled:false }', async () => {
    const deps = makeKit({ [WS]: { subscription: { state: 'active' } } });
    deps.OnboardingState.rows[0].enrolled = false;
    expect((await get(makeApp(deps), '/state')).body).toEqual({ enrolled: false });
  });
  test('none and pending -> view billing, the subset only', async () => {
    for (const s of ['none', 'pending']) {
      stateModule.clearCache();
      const deps = makeKit({ [WS]: { subscription: { state: s }, business: { name: 'Hidden' } } });
      const res = await get(makeApp(deps), '/state');
      expect(res.status).toBe(200);
      expect(res.body.view).toBe('billing');
      expect(res.body.subscription.state).toBe(s);
      expect(Object.keys(res.body).sort()).toEqual(['checkedAt', 'checkout', 'enrolled', 'locked', 'notifications', 'subscription', 'view']);
      expect(JSON.stringify(res.body)).not.toContain('Hidden');
    }
  });
  test('past_due / cancelled -> the full state with the subscription set', async () => {
    for (const [s, view] of [['past_due', 'setup'], ['cancelled', 'done']]) {
      stateModule.clearCache();
      const deps = makeKit({ [WS]: { subscription: { state: s, source: 'stripe' }, steps: { business: done, number: done }, progress: view === 'done' ? { completedAt: NOW } : {} } });
      const res = await get(makeApp(deps), '/state');
      expect(res.body.view).toBe(view);
      expect(res.body.subscription.state).toBe(s);
      expect(res.body.steps.business.status).toBe('done');
      expect(res.body.nextStep).toBe('connect');
      expect(res.body.sendingPaused.code).toBe(s === 'past_due' ? 'PAYMENT_PAST_DUE' : 'SUBSCRIPTION_CANCELLED');
    }
  });
  test('the body satisfies the typed contract of onb.types.ts for an active workspace', async () => {
    const deps = makeKit({ [WS]: { subscription: { state: 'active', source: 'admin' }, steps: { business: done }, business: { name: 'Rose', country: 'SA', industry: 'other' } } });
    deps.WhatsAppConnection.seed({ workspaceId: WS, status: 'connected', display: { displayPhoneNumber: '+966501234567', verifiedName: 'Rose' }, lastStatusCheckAt: NOW });
    const res = await get(makeApp(deps), '/state');
    const b = res.body;
    expect(res.headers['cache-control']).toBe('no-store');
    expect(b.enrolled).toBe(true);
    expect(['billing', 'setup', 'done']).toContain(b.view);
    expect(['business', 'number', 'connect', 'approvals', 'customers', 'products', 'promotion', null]).toContain(b.nextStep);
    expect(typeof b.currentStep).toBe('string');
    expect(typeof b.locked).toBe('boolean');
    expect(typeof b.unlockAt).toBe('string');
    for (const k of ['business', 'number', 'connect', 'approvals', 'promotion']) expect(typeof b.steps[k].status).toBe('string');
    expect(['connected', 'needs_attention', 'reconnect_needed', null]).toContain(b.connection.level);
    expect(b.connection.numberFull).toBe('+966501234567');
    expect(b.connection.checkedAt).toBe(NOW.toISOString());
    expect(['pending', 'skipped', 'done']).toContain(b.prompts.customers.state);
    expect(b.prompts.counts).toEqual({ customers: 0, products: 0, services: 0 });
    expect(Array.isArray(b.business.industryOptions)).toBe(true);
    expect(typeof b.checkedAt).toBe('string');
    expect(b.notifications).toEqual({ unread: 2 });
    expect(typeof b.number.paused).toBe('boolean');
    expect(b.sendingPaused === null || typeof b.sendingPaused.code === 'string').toBe(true);
  });
  test('resume from a second token: the same account (another user) gets the same progress', async () => {
    const deps = makeKit({ [WS]: { subscription: { state: 'active' }, steps: { business: done, number: done }, number: { path: 'A', usage: 'unused' } } });
    deps.WhatsAppConnection.seed({ workspaceId: WS, status: 'connected', display: { displayPhoneNumber: '+966501234567' } });
    const app = makeApp(deps);
    const a = (await get(app, '/state', 'owner')).body;
    stateModule.clearCache();
    const b = (await get(app, '/state', 'member')).body;
    const strip = (x) => { const c = JSON.parse(JSON.stringify(x)); delete c.connection.numberFull; return c; };
    expect(strip(b)).toEqual(strip(a));
    expect(a.nextStep).toBe('connect');
    expect('numberFull' in a.connection).toBe(true);
    expect('numberFull' in b.connection).toBe(false);
  });
  test('tenant isolation: workspaceId in the query or the body is ignored', async () => {
    const deps = makeKit({
      [WS]: { subscription: { state: 'active' }, business: { name: 'Mine' } },
      [OTHER]: { subscription: { state: 'active' }, business: { name: 'Theirs' } },
    });
    const res = await get(makeApp(deps), `/state?workspaceId=${OTHER}`);
    expect(res.body.business.name).toBe('Mine');
    expect(JSON.stringify(res.body)).not.toContain('Theirs');
    const other = await get(makeApp(deps), '/state', 'other');
    expect(other.body.business.name).toBe('Theirs');
  });
  test('an internal failure is a JSON 500 INTERNAL_ERROR without details, never a 401', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const steps = { buildState: async () => { throw new Error('mongo://user:pass@host exploded'); }, requestContext: () => ({}) };
    const res = await get(makeApp(makeKit(), stateRouter.createRouter({ steps })), '/state');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Something went wrong', code: 'INTERNAL_ERROR', retryable: true });
    quiet.mockRestore();
  });
});

describe('GET /help-context (gate E)', () => {
  test('answers for any enrolled state, including before payment', async () => {
    process.env.ONBOARDING_SUPPORT_EMAIL = 'help@waflow.test';
    for (const s of ['none', 'pending', 'active', 'past_due', 'cancelled']) {
      stateModule.clearCache();
      const deps = makeKit({ [WS]: { subscription: { state: s }, business: { name: 'Rose Salon' } } });
      const res = await get(makeApp(deps), '/help-context');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ businessName: 'Rose Salon', supportEmail: 'help@waflow.test', supportWhatsapp: null, lastError: null });
      expect(typeof res.body.prefilledText).toBe('string');
      expect(res.body.stepKey).toBe(s === 'none' || s === 'pending' ? 'billing' : 'business');
    }
  });
  test('legacy workspace -> 404 ONBOARDING_NOT_AVAILABLE', async () => {
    const res = await get(makeApp(makeKit()), '/help-context');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ONBOARDING_NOT_AVAILABLE');
  });
  test('another workspace is never visible', async () => {
    const deps = makeKit({ [WS]: { subscription: { state: 'active' }, business: { name: 'Mine' } }, [OTHER]: { subscription: { state: 'active' }, business: { name: 'Theirs' } } });
    const res = await get(makeApp(deps), `/help-context?workspaceId=${OTHER}`);
    expect(res.body.businessName).toBe('Mine');
  });
});

describe('POST /preferences (gate A)', () => {
  test('stores the languages; the same call again is a no-op in effect', async () => {
    const deps = makeKit({ [WS]: { subscription: { state: 'active' } } });
    const app = makeApp(deps);
    const res = await post(app, '/preferences', { uiLanguage: 'ar', languages: ['ar', 'en'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uiLanguage: 'ar', languages: ['ar', 'en'] });
    expect(row(deps).business.uiLanguage).toBe('ar');
    expect(row(deps).business.languages).toEqual(['ar', 'en']);
    const before = JSON.stringify(row(deps));
    await post(app, '/preferences', { uiLanguage: 'ar', languages: ['ar', 'en'] });
    expect(JSON.stringify(row(deps))).toBe(before);
  });
  test('either field alone is fine; nothing / invalid values -> 422 and nothing written', async () => {
    const deps = makeKit({ [WS]: { subscription: { state: 'active' } } });
    const app = makeApp(deps);
    expect((await post(app, '/preferences', { uiLanguage: 'en' })).status).toBe(200);
    expect(row(deps).business.languages).toBeUndefined();
    for (const bad of [{}, { uiLanguage: 'fr' }, { languages: [] }, { languages: ['xx'] }, { name: 'only unknown fields' }]) {
      const res = await post(app, '/preferences', bad);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    expect(row(deps).business.uiLanguage).toBe('en');
  });
  test('the gate: none/pending/past_due/cancelled -> 402 with the right code; legacy -> 404', async () => {
    const codes = { none: 'SUBSCRIPTION_REQUIRED', pending: 'PAYMENT_PENDING', past_due: 'PAYMENT_PAST_DUE', cancelled: 'SUBSCRIPTION_CANCELLED' };
    for (const [s, code] of Object.entries(codes)) {
      stateModule.clearCache();
      const deps = makeKit({ [WS]: { subscription: { state: s } } });
      const res = await post(makeApp(deps), '/preferences', { uiLanguage: 'ar' });
      expect(res.status).toBe(402);
      expect(res.body.code).toBe(code);
      expect(row(deps).business).toBeUndefined();
    }
    const res = await post(makeApp(makeKit()), '/preferences', { uiLanguage: 'ar' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ONBOARDING_NOT_AVAILABLE');
  });
  test('tenant isolation: a workspaceId in the body changes only the token workspace', async () => {
    const deps = makeKit({ [WS]: { subscription: { state: 'active' } }, [OTHER]: { subscription: { state: 'active' } } });
    await post(makeApp(deps), '/preferences', { uiLanguage: 'ar', workspaceId: OTHER, userId: 'x' });
    expect(row(deps, WS).business.uiLanguage).toBe('ar');
    expect(row(deps, OTHER).business).toBeUndefined();
  });
});
