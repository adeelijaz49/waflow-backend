'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database (suffix) so suites in one jest run never see each other's workspaces
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_guard`;
assertThrowawayDb();

// REAL server.js, ONBOARDING_FLOW=on, real (throwaway) DB: the pre-router guard, the default gates of
// /api/onboarding, auto-enrolment on first sight, and "legacy workspaces are untouched".
process.env.ONBOARDING_FLOW = 'on';
delete process.env.ONBOARDING_ENROL_FROM;
delete process.env.ONBOARDING_LEGACY_SEND_POLICY;

const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const app = require('../../../server');
const { JWT_SECRET, ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');
const state = require('../../../shared/onboarding/state');
const Workspace = require('../../../models/Workspace');
const OnboardingState = require('../../../models/OnboardingState');
const WhatsAppConnection = require('../../../models/WhatsAppConnection');

const sign = (payload) => jwt.sign(payload, JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: '1h' });
const tokenFor = (workspaceId, role = 'owner') => sign({ sub: '507f1f77bcf86cd799439099', workspaceId, role });
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const PROMO = '507f1f77bcf86cd799439022';
const ACCESS = ['SUBSCRIPTION_REQUIRED', 'PAYMENT_PENDING', 'PAYMENT_PAST_DUE', 'SUBSCRIPTION_CANCELLED', 'WHATSAPP_NOT_CONNECTED', 'WHATSAPP_RECONNECT_REQUIRED', 'SENDING_NOT_AVAILABLE_YET'];

async function makeWorkspace(name, createdAt, completed) {
  const res = await Workspace.collection.insertOne({ name, createdAt, updatedAt: createdAt, onboarding: { completed, currentStep: 1 } });
  return String(res.insertedId);
}
const sendRoute = (t) => request(app).post(`/api/promotions/${PROMO}/send`).set(auth(t)).send({});
const notOurs = (res) => { expect(ACCESS).not.toContain(res.body && res.body.code); expect(res.status).not.toBe(401); };
const reachedRoute = (res) => { notOurs(res); expect(res.status).not.toBe(402); expect(res.status).toBeGreaterThanOrEqual(200); };

let oldest; let legacy; let enrolled; let fresh;
beforeAll(async () => {
  await mongoose.connection.asPromise();
  await Promise.all([OnboardingState.init(), WhatsAppConnection.init()]);
  oldest = await makeWorkspace('Owner workspace', new Date('2026-01-01T00:00:00Z'), true);
  legacy = await makeWorkspace('Legacy workspace', new Date('2026-06-01T00:00:00Z'), true);
  enrolled = await makeWorkspace('Enrolled workspace', new Date('2026-10-10T00:00:00Z'), false);
  fresh = await makeWorkspace('Fresh signup', new Date('2026-10-14T00:00:00Z'), false);
});
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(() => { state.clearCache(); process.env.ONBOARDING_FLOW = 'on'; delete process.env.ONBOARDING_ENROL_FROM; delete process.env.ONBOARDING_LEGACY_SEND_POLICY; });

describe('flag on, no sidecar: legacy workspaces are untouched', () => {
  test('the app boots with the flow mounted', async () => {
    expect((await request(app).get('/')).text).toBe('Waflow backend running');
  });
  test('a legacy workspace reaches the real send route (no 402) and nothing is written', async () => {
    for (const ws of [legacy, oldest]) {
      reachedRoute(await sendRoute(tokenFor(ws)));
      reachedRoute(await sendRoute(tokenFor(ws, 'member')));
    }
    expect(await OnboardingState.countDocuments({})).toBe(0);
    expect(await WhatsAppConnection.countDocuments({})).toBe(0);
    expect((await request(app).get('/api/customers').set(auth(tokenFor(legacy)))).status).toBe(200);
  });
  test('POST /webhook (hunks E1 + E3) still reaches the legacy handler with the flag on: 200, body parsed, nothing onboarding-related written', async () => {
    // ruling 1: an UNSIGNED payload whose entry id no merchant connection owns (and that is not the platform's either)
    // is NOT rejected: only a positive merchant match with a bad signature is a 403
    const res = await request(app).post('/webhook').send({ entry: [{ id: '123', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '999' }, statuses: [] } }] }] });
    expect(res.status).toBe(200);
    const after = await OnboardingState.countDocuments({});
    expect(after).toBe(0);
  });
  test('POST /webhook: legacy shapes (no entry id, the platform id, an empty object) pass unsigned too', async () => {
    for (const body of [{ entry: [{ changes: [{ field: 'messages', value: { statuses: [] } }] }] }, { entry: [{ id: process.env.WA_WABA_ID || '555', changes: [] }] }, {}]) {
      expect((await request(app).post('/webhook').send(body)).status).toBe(200);
    }
  });
  test('POST /stripe-billing-webhook with the flag on reaches the REAL handler: without a signing secret 503 CHECKOUT_NOT_CONFIGURED, never a crash', async () => {
    const saved = process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET;
    delete process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET;
    try {
      const res = await request(app).post('/stripe-billing-webhook').set('Content-Type', 'application/json').send('{"id":"evt_1"}');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('CHECKOUT_NOT_CONFIGURED');
    } finally { if (saved !== undefined) process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET = saved; }
  });
  test('/api/onboarding/* for a legacy workspace: gated routes answer 404 ONBOARDING_NOT_AVAILABLE, never 402/401', async () => {
    const res = await request(app).post('/api/onboarding/connect/complete').set(auth(tokenFor(legacy))).send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ONBOARDING_NOT_AVAILABLE');
    const res2 = await request(app).put('/api/onboarding/business').set(auth(tokenFor(legacy))).send({});
    expect(res2.status).toBe(404);
  });
  test('M2 mode: enrolling ONE workspace changes nothing for another', async () => {
    await state.enrol({ workspaceId: enrolled, by: 'cli:test' }, { track: async () => {} });
    state.clearCache();
    expect((await sendRoute(tokenFor(enrolled))).status).toBe(402);
    notOurs(await sendRoute(tokenFor(legacy)));
    notOurs(await sendRoute(tokenFor(oldest)));
    await state.unenrol({ workspaceId: enrolled, by: 'cli:test' }, { track: async () => {} });
  });
});

describe('tokens the guard cannot attribute fall through to the route\'s own 401', () => {
  test('no token', async () => {
    const res = await request(app).post(`/api/promotions/${PROMO}/send`).send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Not logged in' });
  });
  test('garbage / wrong-secret / expired / wrong-audience tokens', async () => {
    const bad = [
      'garbage',
      jwt.sign({ sub: 'u', workspaceId: enrolled, role: 'owner' }, 'another-secret', { issuer: ISSUER, audience: AUDIENCE }),
      jwt.sign({ sub: 'u', workspaceId: enrolled, role: 'owner' }, JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: -10 }),
      jwt.sign({ sub: 'u', workspaceId: enrolled, role: 'owner' }, JWT_SECRET, { issuer: ISSUER, audience: 'someone-else' }),
    ];
    for (const t of bad) {
      const res = await request(app).post(`/api/promotions/${PROMO}/send`).set(auth(t)).send({});
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Session expired or invalid — please log in again' });
    }
  });
  test('a pre-auth token (no workspace) is never gated by the guard', async () => {
    await state.enrol({ workspaceId: enrolled, by: 'cli:test' }, { track: async () => {} });
    state.clearCache();
    notOurs(await sendRoute(sign({ sub: '507f1f77bcf86cd799439099', preAuth: true })));
    notOurs(await sendRoute(sign({ sub: '507f1f77bcf86cd799439099', workspaceId: 'not-an-object-id', role: 'owner' })));
    await state.unenrol({ workspaceId: enrolled, by: 'cli:test' }, { track: async () => {} });
  });
});

describe('an ENROLLED workspace', () => {
  beforeEach(async () => {
    await state.enrol({ workspaceId: enrolled, by: 'cli:test' }, { track: async () => {} });
    await OnboardingState.updateOne({ workspaceId: enrolled }, { $set: { 'subscription.state': 'none', 'subscription.source': null, 'subscription.admin.active': false }, $unset: { 'subscription.stripe': 1 } });
    await WhatsAppConnection.updateOne({ workspaceId: enrolled }, { $set: { status: 'not_connected', needsReconnect: false } }); // reset (no row = no-op)
    state.clearCache();
  });
  afterEach(async () => { await state.unenrol({ workspaceId: enrolled, by: 'cli:test' }, { track: async () => {} }); });

  const setSub = async (substate, source = null) => {
    await OnboardingState.updateOne({ workspaceId: enrolled }, { $set: { 'subscription.state': substate, 'subscription.source': source } });
    state.invalidate(enrolled);
  };
  const setConn = async (fields) => {
    await WhatsAppConnection.updateOne({ workspaceId: enrolled }, { $set: fields, $setOnInsert: { workspaceId: enrolled } }, { upsert: true });
    state.invalidate(enrolled);
  };

  test('subscription none: send route -> 402 SUBSCRIPTION_REQUIRED with the documented body', async () => {
    const res = await sendRoute(tokenFor(enrolled));
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: 'SUBSCRIPTION_REQUIRED', nextStep: 'billing', retry: { checkout: true, billingPortal: false, reconnect: false } });
    expect(typeof res.body.error).toBe('string');
  });
  test('non-send routes pass through (data stays readable, writes that are not sends work)', async () => {
    expect((await request(app).get('/api/customers').set(auth(tokenFor(enrolled)))).status).toBe(200);
    expect((await request(app).get('/api/promotions').set(auth(tokenFor(enrolled)))).status).toBe(200);
    const imp = await request(app).post('/api/imports/507f1f77bcf86cd799439033/run').set(auth(tokenFor(enrolled))).send({});
    notOurs(imp); // customer import is deliberately NOT blocked (spec 0b)
  });
  test('owner and member are treated alike by the guard', async () => {
    expect((await sendRoute(tokenFor(enrolled, 'owner'))).status).toBe(402);
    expect((await sendRoute(tokenFor(enrolled, 'member'))).status).toBe(402);
  });
  test('the onboarding API: step routes -> 402, billing-exempt routes are not stopped by the gate', async () => {
    const t = auth(tokenFor(enrolled));
    for (const [method, path] of [['put', '/api/onboarding/business'], ['post', '/api/onboarding/number/ready'], ['post', '/api/onboarding/connect/complete'], ['get', '/api/onboarding/approvals'], ['post', '/api/onboarding/test-message'], ['get', '/api/onboarding/brand-new-route']]) {
      const res = await request(app)[method](path).set(t).send({});
      expect(res.status).toBe(402);
      expect(res.body.code).toBe('SUBSCRIPTION_REQUIRED');
    }
    // /state and the billing routes are exempt: the stub sub-routers have no handler yet, so they fall through to the default 404 (NOT 402)
    // (BF1: the bell and the analytics beacons are billing-exempt too, gate E)
    for (const [method, path] of [['get', '/api/onboarding/state'], ['post', '/api/onboarding/checkout'], ['post', '/api/onboarding/billing-portal'], ['post', '/api/onboarding/billing/refresh'],
      ['get', '/api/onboarding/notifications'], ['post', '/api/onboarding/notifications/read'], ['post', '/api/onboarding/events']]) {
      const res = await request(app)[method](path).set(t).send({});
      expect(res.status).not.toBe(402);
    }
  });
  test.each([
    ['pending', 'PAYMENT_PENDING'],
    ['past_due', 'PAYMENT_PAST_DUE'],
    ['cancelled', 'SUBSCRIPTION_CANCELLED'],
  ])('subscription %s -> 402 %s on a send route and on onboarding step writes', async (substate, code) => {
    await setSub(substate);
    expect((await sendRoute(tokenFor(enrolled))).body.code).toBe(code);
    const res = await request(app).put('/api/onboarding/business').set(auth(tokenFor(enrolled))).send({});
    expect(res.status).toBe(402);
    expect(res.body.code).toBe(code);
  });
  test('active (admin) but no WhatsApp connection -> WHATSAPP_NOT_CONNECTED', async () => {
    await setSub('active', 'admin');
    const res = await sendRoute(tokenFor(enrolled));
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('WHATSAPP_NOT_CONNECTED');
    expect(res.body.nextStep).toBe('connect');
  });
  test('active + connection states', async () => {
    await setSub('active', 'admin');
    await setConn({ status: 'waba_only' });
    expect((await sendRoute(tokenFor(enrolled))).body.code).toBe('WHATSAPP_NOT_CONNECTED');
    await setConn({ status: 'reconnect_required', needsReconnect: true });
    const rec = await sendRoute(tokenFor(enrolled));
    expect(rec.body.code).toBe('WHATSAPP_RECONNECT_REQUIRED');
    expect(rec.body.retry.reconnect).toBe(true);
  });
  test('active + connected + policy block (default) -> SENDING_NOT_AVAILABLE_YET (the legacy senders use the platform number)', async () => {
    await setSub('active', 'admin');
    await setConn({ status: 'connected', needsReconnect: false });
    const res = await sendRoute(tokenFor(enrolled));
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('SENDING_NOT_AVAILABLE_YET');
  });
  test('active + connected + policy platform_number -> the request reaches the route', async () => {
    await setSub('active', 'admin');
    await setConn({ status: 'connected', needsReconnect: false });
    process.env.ONBOARDING_LEGACY_SEND_POLICY = 'platform_number';
    state.clearCache();
    reachedRoute(await sendRoute(tokenFor(enrolled)));
  });
  test('Instagram connect/publish routes only need an active subscription', async () => {
    const res = await request(app).get('/api/social-accounts/instagram/connect-url').set(auth(tokenFor(enrolled)));
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('SUBSCRIPTION_REQUIRED');
    await setSub('active', 'admin');
    const ok = await request(app).get('/api/social-accounts/instagram/connect-url').set(auth(tokenFor(enrolled)));
    notOurs(ok);
  });
  test('the flag turned off at runtime makes the guard inert again', async () => {
    expect((await sendRoute(tokenFor(enrolled))).status).toBe(402);
    process.env.ONBOARDING_FLOW = 'off';
    reachedRoute(await sendRoute(tokenFor(enrolled)));
    expect((await request(app).post('/api/onboarding/connect/complete').set(auth(tokenFor(enrolled))).send({})).status).toBe(404);
  });
  test('un-enrolling is instant: the same workspace is a legacy workspace again', async () => {
    expect((await sendRoute(tokenFor(enrolled))).status).toBe(402);
    await state.unenrol({ workspaceId: enrolled, by: 'cli:test' }, { track: async () => {} });
    reachedRoute(await sendRoute(tokenFor(enrolled)));
    await state.enrol({ workspaceId: enrolled, by: 'cli:test' }, { track: async () => {} }); // restore for afterEach
  });
  test('workspaceId in the body or query cannot redirect the gate to another workspace', async () => {
    const res = await request(app).post(`/api/promotions/${PROMO}/send?workspaceId=${legacy}`).set(auth(tokenFor(enrolled))).send({ workspaceId: legacy });
    expect(res.status).toBe(402);
    const res2 = await request(app).post(`/api/promotions/${PROMO}/send`).set(auth(tokenFor(legacy))).send({ workspaceId: enrolled });
    notOurs(res2);
  });
});

describe('auto-enrolment on first sight (ONBOARDING_ENROL_FROM)', () => {
  test('a fresh signup is enrolled by its first authenticated request; the oldest and legacy workspaces never are', async () => {
    process.env.ONBOARDING_ENROL_FROM = '2026-10-01T00:00:00Z';
    state.clearCache();
    expect((await request(app).get('/api/customers').set(auth(tokenFor(oldest)))).status).toBe(200);
    expect((await request(app).get('/api/customers').set(auth(tokenFor(legacy)))).status).toBe(200);
    expect(await OnboardingState.countDocuments({ workspaceId: { $in: [oldest, legacy] } })).toBe(0);
    expect(await OnboardingState.countDocuments({ workspaceId: fresh })).toBe(0);

    // two simultaneous first requests
    const [a, b] = await Promise.all([
      request(app).get('/api/customers').set(auth(tokenFor(fresh))),
      request(app).get('/api/customers').set(auth(tokenFor(fresh))),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await OnboardingState.countDocuments({ workspaceId: fresh })).toBe(1);
    const row = await OnboardingState.findOne({ workspaceId: fresh }).lean();
    expect(row).toMatchObject({ enrolled: true, enrolledVia: 'auto_signup', r1Applied: true });
    expect((await Workspace.findById(fresh).lean()).onboarding.completed).toBe(true);        // R1 only here
    expect((await Workspace.findById(legacy).lean()).onboarding.completed).toBe(true);
    expect((await Workspace.findById(oldest).lean()).onboarding.completed).toBe(true);
    expect((await sendRoute(tokenFor(fresh))).body.code).toBe('SUBSCRIPTION_REQUIRED');
    notOurs(await sendRoute(tokenFor(legacy)));
  });
  test('without the cutover nothing is enrolled even for a completed:false workspace', async () => {
    const extra = await makeWorkspace('Another fresh signup', new Date('2026-10-15T00:00:00Z'), false);
    state.clearCache();
    expect((await request(app).get('/api/customers').set(auth(tokenFor(extra)))).status).toBe(200);
    expect(await OnboardingState.countDocuments({ workspaceId: extra })).toBe(0);
    notOurs(await sendRoute(tokenFor(extra)));
  });
});
