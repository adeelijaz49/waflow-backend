'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database (suffix) so suites in one jest run never see each other's workspaces
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_billingapi`;
assertThrowawayDb();

// Billing API (checkout, portal, on-demand refresh, reconcile sweep) against REAL models, the REAL gate
// (requireOnboardingAccess with the live Membership check) and state.js on the throwaway mongod; fakeStripe for
// every Stripe call. The REAL server.js is booted with the flag UNSET to prove the flow is inert and that the
// existing /stripe-webhook route behaves exactly as before. No real network.
const LEGACY_SECRET = 'whsec_legacy_fixture_dummy_secret_0002';
delete process.env.ONBOARDING_FLOW; // the real server below boots with the flag off
process.env.STRIPE_SIGNING_SECRET = LEGACY_SECRET;
process.env.ONBOARDING_STRIPE_PRICES = JSON.stringify({ standard: 'price_fixture_1', pro: 'price_fixture_2' });
process.env.ONBOARDING_CHECKOUT = 'on';
process.env.ONBOARDING_BILLING_PORTAL = 'on';
process.env.FRONTEND_URL = 'https://app.example.test';
delete process.env.ONBOARDING_STRIPE_SECRET_KEY;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.ONBOARDING_BILLING_RECONCILE_ON_DEMAND;

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const app = require('../../../server');
const { JWT_SECRET, ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');
const state = require('../../../shared/onboarding/state');
const billing = require('../../../shared/onboarding/billing');
const { createLimiter } = require('../../../shared/onboarding/rateLimit');
const { createRouter } = require('../../../routes/onboarding/billing');
const Workspace = require('../../../models/Workspace');
const User = require('../../../models/User');
const Membership = require('../../../models/Membership');
const OnboardingState = require('../../../models/OnboardingState');
const OnboardingEvent = require('../../../models/OnboardingEvent');
const { createFakeStripe, makeSubscription } = require('../_fixtures');

const noTrack = { track: async () => {} };
const MIN = 60 * 1000;
let stripe;
let limiterClock;
let hook;
let seq = 0;
const T0 = Date.now();

async function makeEnrolled({ role = 'owner', sub, email, prefillEmail } = {}) {
  seq += 1;
  const ws = await Workspace.collection.insertOne({ name: `WS ${seq}`, createdAt: new Date('2026-10-10T00:00:00Z'), updatedAt: new Date(), onboarding: { completed: false, currentStep: 1 } });
  const workspaceId = String(ws.insertedId);
  const user = await User.create(email ? { email } : { phone: `9665000000${String(seq).padStart(2, '0')}` });
  const userId = String(user._id);
  await Membership.create({ userId, workspaceId, role });
  await state.enrol({ workspaceId, by: 'cli:test' }, noTrack);
  const set = { ...(sub || {}) };
  if (prefillEmail) set['prefill.email'] = prefillEmail;
  if (Object.keys(set).length) await OnboardingState.updateOne({ workspaceId }, { $set: set });
  state.invalidate(workspaceId);
  return { workspaceId, userId };
}
const doc = (ws) => OnboardingState.findOne({ workspaceId: ws }).lean();
const as = (ctx, role = 'owner') => ({ 'x-test-user': JSON.stringify({ id: ctx.userId, workspaceId: ctx.workspaceId, role }) });
const token = (ctx, role = 'owner') => jwt.sign({ sub: ctx.userId, workspaceId: ctx.workspaceId, role }, JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: '1h' });
const quiet = () => { for (const m of ['log', 'info', 'warn', 'error', 'debug']) jest.spyOn(console, m).mockImplementation(() => {}); };

function buildHook() {
  limiterClock = { t: T0, now() { return this.t; } };
  hook = express();
  hook.use(express.json());
  hook.use((req, res, next) => { req.user = JSON.parse(req.headers['x-test-user'] || '{}'); next(); });
  hook.use('/api/onboarding', createRouter({ billingDeps: { stripe }, rateLimitDeps: { limiter: createLimiter({ now: () => limiterClock.t }) } }));
}

beforeAll(async () => {
  await mongoose.connection.asPromise();
  await Promise.all([OnboardingState.init(), Membership.init(), User.init()]);
  await Workspace.collection.insertOne({ name: 'Owner workspace (oldest)', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date(), onboarding: { completed: true, currentStep: 1 } });
});
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(() => { stripe = createFakeStripe({}); buildHook(); state.clearCache(); quiet(); });
afterEach(() => { jest.restoreAllMocks(); process.env.ONBOARDING_CHECKOUT = 'on'; process.env.ONBOARDING_BILLING_PORTAL = 'on'; delete process.env.ONBOARDING_FLOW; delete process.env.ONBOARDING_BILLING_RECONCILE_ON_DEMAND; });

describe('flag UNSET: the real server is inert for the billing flow and /stripe-webhook is untouched', () => {
  const same = async (known, unknown, method = 'get', opts = {}) => {
    const a = await request(app)[method](known).set(opts.headers || {}).send(opts.body);
    const b = await request(app)[method](unknown).set(opts.headers || {}).send(opts.body);
    expect(a.status).toBe(404);
    expect(a.status).toBe(b.status);
    expect(a.text.replace(known, 'X')).toBe(b.text.replace(unknown, 'X'));
  };

  test('the billing routes and the new webhook answer exactly like unknown routes', async () => {
    const ctx = await makeEnrolled({});
    const headers = { Authorization: `Bearer ${token(ctx)}` };
    await same('/api/onboarding/checkout', '/api/zzz-not-a-route/checkout', 'post', { headers, body: { planCode: 'standard' } });
    await same('/api/onboarding/billing-portal', '/api/zzz-not-a-route/billing-portal', 'post', { headers, body: {} });
    await same('/api/onboarding/billing/refresh', '/api/zzz-not-a-route/billing/refresh', 'post', { headers, body: {} });
    await same('/stripe-billing-webhook', '/zzz-not-a-route', 'post', { headers: { 'Content-Type': 'application/json' }, body: { id: 'evt_1' } });
    expect((await OnboardingState.findOne({ workspaceId: ctx.workspaceId }).lean()).subscription.state).toBe('none');
  });

  test('the existing /stripe-webhook: bad signature -> 400 "Webhook Error:", legacy-signed payment_failed -> 200 OK, new-endpoint secret not accepted', async () => {
    const fake = createFakeStripe({});
    const post = (signed) => request(app).post('/stripe-webhook').set('content-type', 'application/json').set('stripe-signature', signed.header).send(signed.payload);
    const bad = await post(fake.signedEvent({ type: 'payment_intent.payment_failed', object: { id: 'pi_a' }, secret: 'whsec_not_ours_dummy' }));
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(/^Webhook Error: /);
    const crossed = await post(fake.signedEvent({ type: 'payment_intent.payment_failed', object: { id: 'pi_b' } })); // fixture secret = the onboarding endpoint's
    expect(crossed.status).toBe(400);
    const ok = await post(fake.signedEvent({ type: 'payment_intent.payment_failed', object: { id: 'pi_c' }, secret: LEGACY_SECRET }));
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('OK');
  });
});

describe('POST /checkout (real gate, real Membership, real DB)', () => {
  test('golden path: {url}, pending, payload from the server only, the User e-mail is pre-filled', async () => {
    const ctx = await makeEnrolled({ email: 'owner@acme.test' });
    const res = await request(hook).post('/api/onboarding/checkout').set(as(ctx)).send({ planCode: 'standard', workspaceId: 'ffffffffffffffffffffffff', priceId: 'price_attacker' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['url']);
    expect(res.body.url).toMatch(/^https:\/\//);
    const params = stripe.callsTo('checkout.sessions.create')[0].args.params;
    expect(params).toMatchObject({
      mode: 'subscription', client_reference_id: ctx.workspaceId, customer_email: 'owner@acme.test', payment_method_collection: 'always',
      line_items: [{ price: 'price_fixture_1', quantity: 1 }],
      metadata: { workspaceId: ctx.workspaceId, planCode: 'standard', waflow_purpose: 'merchant_subscription' },
      subscription_data: { metadata: { workspaceId: ctx.workspaceId, planCode: 'standard', waflow_purpose: 'merchant_subscription' } },
      success_url: 'https://app.example.test/setup?checkout=return', cancel_url: 'https://app.example.test/setup?checkout=cancel',
    });
    const d = await doc(ctx.workspaceId);
    expect(d.subscription.state).toBe('pending');
    expect(d.subscription.stripe.checkoutSessionId).toMatch(/^cs_test_fixture_/);
    expect(d.subscription.stripe.checkoutStartedAt).toBeInstanceOf(Date);
    expect((await state.getGateState(ctx.workspaceId)).sub.state).toBe('pending');
    expect(await OnboardingEvent.countDocuments({ workspaceId: ctx.workspaceId, type: 'payment_state', code: 'SUB_PENDING' })).toBe(1);
  });

  test('a phone-only user: no customer_email; the prefill e-mail wins over the user e-mail', async () => {
    const phoneOnly = await makeEnrolled({});
    await request(hook).post('/api/onboarding/checkout').set(as(phoneOnly)).send({ planCode: 'pro' });
    const p1 = stripe.callsTo('checkout.sessions.create')[0].args.params;
    expect(Object.prototype.hasOwnProperty.call(p1, 'customer_email')).toBe(false);
    expect(p1.line_items[0].price).toBe('price_fixture_2');
    const withPrefill = await makeEnrolled({ email: 'user@acme.test', prefillEmail: 'prefill@acme.test' });
    await request(hook).post('/api/onboarding/checkout').set(as(withPrefill)).send({ planCode: 'standard' });
    expect(stripe.callsTo('checkout.sessions.create')[1].args.params.customer_email).toBe('prefill@acme.test');
  });

  test('a second checkout while a subscription is active -> 409 with the existing state; an abandoned checkout may be retried', async () => {
    const active = await makeEnrolled({ sub: { 'subscription.state': 'active', 'subscription.source': 'stripe', 'subscription.stripe.subscriptionId': 'sub_x', 'subscription.stripe.status': 'active' } });
    const res = await request(hook).post('/api/onboarding/checkout').set(as(active)).send({ planCode: 'standard' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SUBSCRIPTION_EXISTS', subscription: { state: 'active', source: 'stripe' } });
    expect(stripe.callsTo('checkout.sessions.create')).toHaveLength(0);
    const fresh = await makeEnrolled({});
    expect((await request(hook).post('/api/onboarding/checkout').set(as(fresh)).send({ planCode: 'standard' })).status).toBe(200);
    expect((await request(hook).post('/api/onboarding/checkout').set(as(fresh)).send({ planCode: 'standard' })).status).toBe(200); // pending without a subscription
    expect((await doc(fresh.workspaceId)).subscription.state).toBe('pending');
  });

  test('unknown plan 422; unconfigured 503; owner only (also with a stale JWT); legacy 404; Stripe outage 503 STRIPE_ERROR', async () => {
    const ctx = await makeEnrolled({});
    expect((await request(hook).post('/api/onboarding/checkout').set(as(ctx)).send({ planCode: 'gold' })).body.code).toBe('PLAN_UNKNOWN');
    process.env.ONBOARDING_CHECKOUT = 'off';
    const off = await request(hook).post('/api/onboarding/checkout').set(as(ctx)).send({ planCode: 'standard' });
    expect([off.status, off.body.code]).toEqual([503, 'CHECKOUT_NOT_CONFIGURED']);
    process.env.ONBOARDING_CHECKOUT = 'on';

    const member = await makeEnrolled({ role: 'member' });
    const stale = await request(hook).post('/api/onboarding/checkout').set(as(member, 'owner')).send({ planCode: 'standard' }); // JWT still says owner
    expect([stale.status, stale.body.code]).toEqual([403, 'OWNER_ONLY']);

    const legacyWs = await Workspace.collection.insertOne({ name: 'Legacy', createdAt: new Date('2026-02-01T00:00:00Z'), updatedAt: new Date(), onboarding: { completed: true, currentStep: 1 } });
    const legacyUser = await User.create({ email: 'legacy@acme.test' });
    await Membership.create({ userId: legacyUser._id, workspaceId: legacyWs.insertedId, role: 'owner' });
    const legacy = await request(hook).post('/api/onboarding/checkout').set(as({ workspaceId: String(legacyWs.insertedId), userId: String(legacyUser._id) })).send({ planCode: 'standard' });
    expect([legacy.status, legacy.body.code]).toEqual([404, 'ONBOARDING_NOT_AVAILABLE']);
    expect(await OnboardingState.findOne({ workspaceId: legacyWs.insertedId }).lean()).toBeNull(); // never auto-created

    stripe.failNext('checkout.sessions.create', { type: 'StripeConnectionError' });
    const down = await request(hook).post('/api/onboarding/checkout').set(as(ctx)).send({ planCode: 'standard' });
    expect([down.status, down.body.code, down.body.retryable]).toEqual([503, 'STRIPE_ERROR', true]);
    expect((await doc(ctx.workspaceId)).subscription.state).toBe('none');
  });

  test('billing-exempt: works in every subscription state (none, pending, past_due, cancelled)', async () => {
    for (const st of ['none', 'pending', 'past_due', 'cancelled']) {
      const ctx = await makeEnrolled({ sub: { 'subscription.state': st } });
      const res = await request(hook).post('/api/onboarding/checkout').set(as(ctx)).send({ planCode: 'standard' });
      expect(res.status).toBe(200);
    }
  });
});

describe('POST /billing-portal', () => {
  test('past_due owner with a stored customer gets the portal url; no customer -> 503', async () => {
    const ctx = await makeEnrolled({ sub: { 'subscription.state': 'past_due', 'subscription.stripe.customerId': 'cus_p', 'subscription.stripe.subscriptionId': 'sub_p', 'subscription.stripe.status': 'past_due' } });
    const res = await request(hook).post('/api/onboarding/billing-portal').set(as(ctx)).send({});
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    expect(stripe.callsTo('billingPortal.sessions.create')[0].args.params).toEqual({ customer: 'cus_p', return_url: 'https://app.example.test/setup' });
    const none = await makeEnrolled({});
    const r = await request(hook).post('/api/onboarding/billing-portal').set(as(none)).send({});
    expect([r.status, r.body.code]).toEqual([503, 'BILLING_PORTAL_UNAVAILABLE']);
    const member = await makeEnrolled({ role: 'member', sub: { 'subscription.stripe.customerId': 'cus_m' } });
    expect((await request(hook).post('/api/onboarding/billing-portal').set(as(member)).send({})).body.code).toBe('OWNER_ONLY');
    process.env.ONBOARDING_BILLING_PORTAL = 'off';
    expect((await request(hook).post('/api/onboarding/billing-portal').set(as(ctx)).send({})).body.code).toBe('BILLING_PORTAL_UNAVAILABLE');
  });
});

describe('POST /billing/refresh (the server asks Stripe)', () => {
  test('checkout -> paid on Stripe, webhook not yet delivered: refresh activates; rate limited to 1 per 15 s', async () => {
    const ctx = await makeEnrolled({ email: 'refresh.owner@acme.test' });
    await request(hook).post('/api/onboarding/checkout').set(as(ctx)).send({ planCode: 'standard' });
    const sessionId = (await doc(ctx.workspaceId)).subscription.stripe.checkoutSessionId;
    stripe.completeCheckout(sessionId, { subscriptionId: 'sub_r1', customer: 'cus_r1', businessName: 'Acme Sweets' });

    const first = await request(hook).post('/api/onboarding/billing/refresh').set(as(ctx)).send({});
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ changed: true, subscription: { state: 'active', source: 'stripe', retry: { checkout: false, billingPortal: false, reconnect: false } } });
    const d = await doc(ctx.workspaceId);
    expect(d.subscription.stripe).toMatchObject({ subscriptionId: 'sub_r1', customerId: 'cus_r1', status: 'active', planCode: 'standard' });
    expect(d.prefill).toMatchObject({ businessName: 'Acme Sweets', source: 'stripe_checkout' });
    expect((await state.getGateState(ctx.workspaceId)).sub.state).toBe('active');

    const second = await request(hook).post('/api/onboarding/billing/refresh').set(as(ctx)).send({});
    expect([second.status, second.body.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    limiterClock.t += 16 * 1000;
    const third = await request(hook).post('/api/onboarding/billing/refresh').set(as(ctx)).send({});
    expect([third.status, third.body.changed]).toEqual([200, false]);
  });

  test('a member may refresh; legacy workspace 404; nothing to reconcile = no Stripe call; the switch can turn it off', async () => {
    const member = await makeEnrolled({ role: 'member' });
    const res = await request(hook).post('/api/onboarding/billing/refresh').set(as(member)).send({});
    expect([res.status, res.body.changed, res.body.subscription.state]).toEqual([200, false, 'none']);
    expect(stripe.calls).toHaveLength(0);
    const legacyWs = await Workspace.collection.insertOne({ name: 'Legacy2', createdAt: new Date('2026-02-02T00:00:00Z'), updatedAt: new Date(), onboarding: { completed: true, currentStep: 1 } });
    const lu = await User.create({ email: 'legacy2@acme.test' });
    const r = await request(hook).post('/api/onboarding/billing/refresh').set(as({ workspaceId: String(legacyWs.insertedId), userId: String(lu._id) })).send({});
    expect(r.status).toBe(404);

    const pending = await makeEnrolled({ sub: { 'subscription.state': 'pending', 'subscription.stripe.subscriptionId': 'sub_off', 'subscription.stripe.status': 'incomplete' } });
    stripe.setSubscription(makeSubscription({ id: 'sub_off', status: 'active' }));
    process.env.ONBOARDING_BILLING_RECONCILE_ON_DEMAND = 'off';
    const off = await request(hook).post('/api/onboarding/billing/refresh').set(as(pending)).send({});
    expect([off.status, off.body.changed, off.body.subscription.state]).toEqual([200, false, 'pending']);
    expect(stripe.calls).toHaveLength(0);
  });

  test('an expired abandoned checkout is forgotten on refresh (pending -> none) so the owner can start again', async () => {
    const ctx = await makeEnrolled({});
    await request(hook).post('/api/onboarding/checkout').set(as(ctx)).send({ planCode: 'standard' });
    const expiring = { ...stripe, checkout: { sessions: { retrieve: async (id) => ({ ...stripe.getSession(id), status: 'expired' }) } } };
    const out = await billing.refreshBilling({ workspaceId: ctx.workspaceId }, { stripe: expiring });
    expect(out).toMatchObject({ changed: true, subscription: { state: 'none' } });
    const d = await doc(ctx.workspaceId);
    expect(d.subscription.state).toBe('none');
    expect(d.subscription.stripe.checkoutSessionId).toBeUndefined();
  });
});

describe('reconcileSweep (real DB)', () => {
  const at = (ms) => new Date(Date.now() - ms);
  test('pending > 30 min and past_due/active once a day; bounded; never touches the rest', async () => {
    process.env.ONBOARDING_FLOW = 'on';
    const pendingOld = await makeEnrolled({ sub: { 'subscription.state': 'pending', 'subscription.stripe.subscriptionId': 'sw_p_old', 'subscription.stripe.status': 'incomplete', 'subscription.stripe.lastSyncedAt': at(45 * MIN) } });
    const pendingYoung = await makeEnrolled({ sub: { 'subscription.state': 'pending', 'subscription.stripe.subscriptionId': 'sw_p_young', 'subscription.stripe.status': 'incomplete', 'subscription.stripe.lastSyncedAt': at(5 * MIN) } });
    const activeDaily = await makeEnrolled({ sub: { 'subscription.state': 'active', 'subscription.source': 'stripe', 'subscription.stripe.subscriptionId': 'sw_a_old', 'subscription.stripe.status': 'active', 'subscription.stripe.lastSyncedAt': at(26 * 60 * MIN) } });
    const activeFresh = await makeEnrolled({ sub: { 'subscription.state': 'active', 'subscription.source': 'stripe', 'subscription.stripe.subscriptionId': 'sw_a_new', 'subscription.stripe.status': 'active', 'subscription.stripe.lastSyncedAt': at(2 * 60 * MIN) } });
    const pastDue = await makeEnrolled({ sub: { 'subscription.state': 'past_due', 'subscription.stripe.subscriptionId': 'sw_d', 'subscription.stripe.status': 'past_due', 'subscription.stripe.lastSyncedAt': at(30 * 60 * MIN) } });
    const adminOnly = await makeEnrolled({ sub: { 'subscription.state': 'active', 'subscription.source': 'admin', 'subscription.admin.active': true } });
    stripe.setSubscription(makeSubscription({ id: 'sw_p_old', status: 'active' }));
    stripe.setSubscription(makeSubscription({ id: 'sw_p_young', status: 'active' }));
    stripe.setSubscription(makeSubscription({ id: 'sw_a_old', status: 'canceled' }));
    stripe.setSubscription(makeSubscription({ id: 'sw_a_new', status: 'canceled' }));
    stripe.setSubscription(makeSubscription({ id: 'sw_d', status: 'active' }));

    // the DB also holds workspaces from the other tests of this file: only assert on the seeded ones
    const out = await billing.reconcileSweep({ limit: 100 }, { stripe });
    expect(out.checked).toBeGreaterThanOrEqual(3);
    const retrieved = stripe.callsTo('subscriptions.retrieve').map((c) => c.args.id);
    expect(retrieved).toEqual(expect.arrayContaining(['sw_p_old', 'sw_a_old', 'sw_d']));
    expect(retrieved).not.toContain('sw_p_young');
    expect(retrieved).not.toContain('sw_a_new');
    expect((await doc(pendingOld.workspaceId)).subscription.state).toBe('active');
    expect((await doc(activeDaily.workspaceId)).subscription.state).toBe('cancelled');
    expect((await doc(pastDue.workspaceId)).subscription.state).toBe('active');
    expect((await doc(pendingYoung.workspaceId)).subscription.state).toBe('pending');
    expect((await doc(activeFresh.workspaceId)).subscription.state).toBe('active');
    expect((await doc(adminOnly.workspaceId)).subscription).toMatchObject({ state: 'active', source: 'admin' });
    // synced rows rotate out of the next sweep
    const before = stripe.calls.length;
    await billing.reconcileSweep({ limit: 100 }, { stripe });
    expect(stripe.callsTo('subscriptions.retrieve').map((c) => c.args.id).slice(retrieved.length)).not.toEqual(expect.arrayContaining(['sw_p_old', 'sw_a_old', 'sw_d']));
    expect(stripe.calls.length).toBeGreaterThanOrEqual(before);
  });

  test('never throws when Stripe fails; does nothing with the flag off', async () => {
    process.env.ONBOARDING_FLOW = 'on';
    await makeEnrolled({ sub: { 'subscription.state': 'past_due', 'subscription.stripe.subscriptionId': 'sw_fail', 'subscription.stripe.status': 'past_due', 'subscription.stripe.lastSyncedAt': at(48 * 60 * MIN) } });
    stripe.failNext('subscriptions.retrieve', { type: 'StripeConnectionError' }, { times: 50 });
    await expect(billing.reconcileSweep({ limit: 100 }, { stripe })).resolves.toEqual(expect.objectContaining({ changed: expect.any(Number) }));
    delete process.env.ONBOARDING_FLOW;
    expect(await billing.reconcileSweep({ limit: 100 }, { stripe })).toEqual({ checked: 0, changed: 0 });
  });
});
