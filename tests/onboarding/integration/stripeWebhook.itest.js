'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database (suffix) so suites in one jest run never see each other's workspaces
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_stripewh`;
assertThrowawayDb();

// POST /stripe-billing-webhook end to end: REAL models and state.js on the throwaway mongod, REAL signature
// verification (offline, dummy secrets), fakeStripe for every Stripe API call, fakeResend for e-mail.
// Part 1 uses createHandler(fakes) in a mini app; part 2 boots the REAL server.js (flag ON) to prove the wiring
// and that the existing /stripe-webhook is untouched. No real network (the proxy of the harness is dead on purpose).
const LEGACY_SECRET = 'whsec_legacy_fixture_dummy_secret_0001';
const NEW_SECRET = 'whsec_fixture_dummy_secret_not_real_0123456789';
const PREV_SECRET = 'whsec_previous_fixture_dummy_secret_9999';
process.env.ONBOARDING_FLOW = 'on';
process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET = NEW_SECRET;
process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET_PREV = PREV_SECRET;
process.env.ONBOARDING_STRIPE_PRICES = JSON.stringify({ standard: 'price_fixture_1' });
process.env.FRONTEND_URL = 'https://app.example.test';
process.env.ONBOARDING_CHECKOUT = 'on';
process.env.STRIPE_SIGNING_SECRET = LEGACY_SECRET; // the EXISTING endpoint's secret
delete process.env.ONBOARDING_ACCEPT_TRIALING;
delete process.env.ONBOARDING_STRIPE_SECRET_KEY;
delete process.env.STRIPE_SECRET_KEY;

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../../server');
const state = require('../../../shared/onboarding/state');
const billing = require('../../../shared/onboarding/billing');
const webhook = require('../../../shared/onboarding/stripeWebhook');
const { createNotifications } = require('../../../shared/onboarding/notifications');
const jwt = require('jsonwebtoken');
const { JWT_SECRET, ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');
const Workspace = require('../../../models/Workspace');
const User = require('../../../models/User');
const Membership = require('../../../models/Membership');
const OnboardingState = require('../../../models/OnboardingState');
const OnboardingInbound = require('../../../models/OnboardingInbound');
const OnboardingNotification = require('../../../models/OnboardingNotification');
const OnboardingEvent = require('../../../models/OnboardingEvent');
const { createFakeStripe, createFakeSend, makeInvoice, makeCheckoutSession, makeSubscription, TEST_WEBHOOK_SECRET } = require('../_fixtures');

const noTrack = { track: async () => {} };
let wsCounter = 0;
const newId = () => String(new mongoose.Types.ObjectId());
async function makeEnrolled(extraSub) {
  wsCounter += 1;
  const res = await Workspace.collection.insertOne({ name: `WS ${wsCounter}`, createdAt: new Date('2026-10-10T00:00:00Z'), updatedAt: new Date(), onboarding: { completed: false, currentStep: 1 } });
  const id = String(res.insertedId);
  await state.enrol({ workspaceId: id, by: 'cli:test' }, noTrack);
  if (extraSub) await OnboardingState.updateOne({ workspaceId: id }, { $set: extraSub });
  state.invalidate(id);
  return id;
}
const doc = (ws) => OnboardingState.findOne({ workspaceId: ws }).lean();
const meta = (ws, planCode = 'standard') => ({ workspaceId: ws, planCode, waflow_purpose: 'merchant_subscription' });
const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

let stripe;
let mail;
let hook;
function setup(shape = 'current') {
  stripe = createFakeStripe({ shape });
  mail = createFakeSend();
  const email = { sendNotificationEmail: async ({ kind }) => { const r = await mail.send({ to: 'owner@example.test', subject: `WaFlow ${kind}`, html: `<p>${kind}</p>` }); return { sent: true, id: r.id }; } };
  const notifications = createNotifications({ email });
  const handler = webhook.createHandler({ stripe, secrets: [NEW_SECRET, PREV_SECRET], notify: notifications.notify });
  hook = express();
  hook.post('/stripe-billing-webhook', express.raw({ type: 'application/json' }), handler);
}
const send = (signed, opts = {}) => {
  let r = request(hook).post('/stripe-billing-webhook').set('content-type', 'application/json');
  if (!opts.noHeader) r = r.set('stripe-signature', opts.header || signed.header);
  return r.send(asText(opts.body || signed.body)); // a string: superagent would JSON-serialise a Buffer
};
const evt = (o) => stripe.signedEvent(o);
const asText = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : b);
const quiet = () => { for (const m of ['log', 'info', 'warn', 'error', 'debug']) jest.spyOn(console, m).mockImplementation(() => {}); };

beforeAll(async () => {
  await mongoose.connection.asPromise();
  await Promise.all([OnboardingState.init(), OnboardingInbound.init(), OnboardingNotification.init()]);
  await Workspace.collection.insertOne({ name: 'Owner workspace (oldest)', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date(), onboarding: { completed: true, currentStep: 1 } });
});
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(() => { setup(); state.clearCache(); quiet(); });
afterEach(() => { jest.restoreAllMocks(); delete process.env.ONBOARDING_ACCEPT_TRIALING; process.env.ONBOARDING_FLOW = 'on'; });

describe('checkout -> payment -> active (the golden path)', () => {
  test('createCheckout, Stripe completes it, the signed webhook activates; ids, prefill, notification, one e-mail', async () => {
    const ws = await makeEnrolled();
    const { url } = await billing.createCheckout({ workspaceId: ws, planCode: 'standard' }, { stripe });
    expect(url).toMatch(/^https:\/\//);
    expect((await doc(ws)).subscription.state).toBe('pending');
    // warm the gate cache with `pending`: the webhook must invalidate it
    expect((await state.getGateState(ws)).sub.state).toBe('pending');

    const sessionId = (await doc(ws)).subscription.stripe.checkoutSessionId;
    const { session, subscription } = stripe.completeCheckout(sessionId, { subscriptionId: 'sub_live_1', customer: 'cus_live_1', businessName: 'Acme Sweets', email: 'owner@acme.test' });
    const signed = evt({ type: 'checkout.session.completed', object: session });
    const res = await send(signed);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, outcome: 'processed' });

    const d = await doc(ws);
    expect(d.subscription).toMatchObject({ state: 'active', source: 'stripe' });
    expect(d.subscription.stripe).toMatchObject({ customerId: 'cus_live_1', subscriptionId: 'sub_live_1', status: 'active', planCode: 'standard', checkoutSessionId: sessionId, hasDefaultPaymentMethod: true });
    expect(d.subscription.stripe.currentPeriodEnd).toEqual(new Date(subscription.current_period_end * 1000));
    expect(d.subscription.activatedAt).toBeTruthy();
    expect(d.prefill).toMatchObject({ businessName: 'Acme Sweets', email: 'owner@acme.test', planCode: 'standard', source: 'stripe_checkout' });
    expect((await state.getGateState(ws)).sub.state).toBe('active'); // cache invalidated by the writer

    const inbound = await OnboardingInbound.findById(`stripe:${signed.event.id}`).lean();
    expect(inbound).toMatchObject({ status: 'done', source: 'stripe', type: 'checkout.session.completed', attempts: 1 });
    expect(String(inbound.workspaceId)).toBe(ws);

    const notes = await OnboardingNotification.find({ workspaceId: ws }).lean();
    expect(notes.map((n) => n.kind)).toEqual(['subscription_active']);
    expect(notes[0].dedupeKey).toMatch(/^sub:active:sub_live_1:/);
    await waitFor(() => mail.sent.length === 1);
    expect(mail.sent[0].subject).toBe('WaFlow subscription_active');

    // exactly one payment_state event, written by state.recomputeSubscription (not by the webhook)
    expect(await OnboardingEvent.countDocuments({ workspaceId: ws, type: 'payment_state', code: 'SUB_ACTIVE' })).toBe(1);
  });

  test('the same event delivered again, and again concurrently, is processed once', async () => {
    const ws = await makeEnrolled({ 'subscription.stripe.subscriptionId': 'sub_dup', 'subscription.stripe.customerId': 'cus_dup', 'subscription.stripe.status': 'incomplete', 'subscription.state': 'pending' });
    stripe.setSubscription(makeSubscription({ id: 'sub_dup', customer: 'cus_dup', status: 'active', metadata: meta(ws) }));
    const signed = evt({ type: 'invoice.paid', object: makeInvoice({ subscription: 'sub_dup', customer: 'cus_dup' }) });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => send(signed)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.outcome === 'processed')).toHaveLength(1);
    expect(stripe.callsTo('subscriptions.retrieve')).toHaveLength(1);
    expect((await send(signed)).body.outcome).toBe('duplicate');
    expect((await OnboardingNotification.find({ workspaceId: ws }).lean())).toHaveLength(1);
    await waitFor(() => mail.sent.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(mail.sent).toHaveLength(1);
  });
});

describe('signature cases over HTTP', () => {
  const body = () => ({ type: 'customer.subscription.updated', object: makeSubscription({ id: 'sub_sig', metadata: {} }) });

  test('valid -> 200; the PREVIOUS secret (rolled) -> 200', async () => {
    expect((await send(evt(body()))).status).toBe(200);
    expect((await send(evt({ ...body(), secret: PREV_SECRET }))).status).toBe(200);
  });
  test.each([
    ['wrong secret', () => evt({ ...body(), secret: 'whsec_nobody_dummy' }), {}],
    ['missing header', () => evt(body()), { noHeader: true }],
    ['garbage header', () => evt(body()), { header: 't=1,v1=deadbeef' }],
    ['stale timestamp', () => evt({ ...body(), timestamp: Math.floor(Date.now() / 1000) - 3600 }), {}],
    ['tampered body', () => { const s = evt(body()); return { ...s, body: Buffer.from(s.payload.replace('sub_sig', 'sub_sag')) }; }, {}],
  ])('%s -> 400 and no row is written', async (_n, make, opts) => {
    const before = await OnboardingInbound.countDocuments({});
    const signed = make();
    const res = await send(signed, opts);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(JSON.stringify(res.body)).not.toContain(NEW_SECRET);
    expect(await OnboardingInbound.countDocuments({})).toBe(before);
  });
  test('no secret configured -> 503', async () => {
    const h2 = express();
    h2.post('/stripe-billing-webhook', express.raw({ type: 'application/json' }), webhook.createHandler({ stripe, secrets: [] }));
    const signed = evt(body());
    const res = await request(h2).post('/stripe-billing-webhook').set('stripe-signature', signed.header).set('content-type', 'application/json').send(signed.payload);
    expect([res.status, res.body.code]).toEqual([503, 'CHECKOUT_NOT_CONFIGURED']);
  });
});

describe('resolution', () => {
  test('unmatched (our metadata, no such workspace): 200, an unmatched row, no state change anywhere', async () => {
    const ws = await makeEnrolled();
    const before = JSON.stringify(await doc(ws));
    const total = await OnboardingState.countDocuments({});
    const signed = evt({ type: 'checkout.session.completed', object: makeCheckoutSession({ clientReferenceId: newId(), metadata: meta(newId()) }) });
    const res = await send(signed);
    expect([res.status, res.body.outcome]).toEqual([200, 'unmatched']);
    expect((await OnboardingInbound.findById(`stripe:${signed.event.id}`).lean()).status).toBe('unmatched');
    expect(JSON.stringify(await doc(ws))).toBe(before);
    expect(await OnboardingState.countDocuments({})).toBe(total);
    expect(stripe.calls).toHaveLength(0);
  });

  test('a non-merchant checkout (a shop payment, no waflow_purpose) is ignored even with a valid workspace id as reference', async () => {
    const ws = await makeEnrolled();
    const signed = evt({ type: 'checkout.session.completed', object: makeCheckoutSession({ mode: 'subscription', clientReferenceId: ws, metadata: {} }) });
    const res = await send(signed);
    expect([res.status, res.body.outcome]).toEqual([200, 'ignored_not_ours']);
    expect((await OnboardingInbound.findById(`stripe:${signed.event.id}`).lean()).status).toBe('ignored');
    expect((await doc(ws)).subscription.state).toBe('none');
  });

  test('payment_intent.* is never handled by this endpoint', async () => {
    const signed = evt({ type: 'payment_intent.succeeded', object: { id: 'pi_1', amount: 1000, metadata: { buyerPhone: '966501234567' } } });
    const res = await send(signed);
    expect([res.status, res.body.outcome]).toEqual([200, 'ignored']);
    expect(stripe.calls).toHaveLength(0);
  });

  test('NO e-mail matching: a subscription of the same e-mail but without our reference never touches a workspace', async () => {
    const ws = await makeEnrolled({ 'prefill.email': 'owner@acme.test' });
    const signed = evt({ type: 'checkout.session.completed', object: makeCheckoutSession({ clientReferenceId: null, email: 'owner@acme.test', metadata: { waflow_purpose: 'merchant_subscription' } }) });
    expect((await send(signed)).body.outcome).toBe('unmatched');
    expect((await doc(ws)).subscription.state).toBe('none');
  });

  test.each(['current', 'basil'])('an invoice that arrives BEFORE any checkout/subscription event converges via retrieve (%s API shape)', async (shape) => {
    setup(shape);
    const ws = await makeEnrolled({ 'subscription.stripe.checkoutStartedAt': new Date(), 'subscription.state': 'pending' });
    stripe.setSubscription(stripe.makeSubscription({ id: `sub_early_${shape}`, customer: `cus_early_${shape}`, status: 'active', metadata: meta(ws), currentPeriodEnd: 1_800_000_000 }));
    const res = await send(evt({ type: 'invoice.paid', object: stripe.makeInvoice({ subscription: `sub_early_${shape}`, customer: `cus_early_${shape}` }) }));
    expect(res.body.outcome).toBe('processed');
    const d = await doc(ws);
    expect(d.subscription).toMatchObject({ state: 'active', source: 'stripe' });
    expect(d.subscription.stripe.currentPeriodEnd).toEqual(new Date(1_800_000_000 * 1000));
    // the late subscription.created event with an OLD payload says incomplete: the retrieved truth wins
    const late = evt({ type: 'customer.subscription.created', object: stripe.makeSubscription({ id: `sub_early_${shape}`, customer: `cus_early_${shape}`, status: 'incomplete', metadata: meta(ws) }), created: 1 });
    expect((await send(late)).status).toBe(200);
    expect((await doc(ws)).subscription.state).toBe('active');
  });
});

describe('invoice.paid vs invoice.payment_succeeded', () => {
  test('equivalent outcomes (state, notification, one e-mail each)', async () => {
    const out = [];
    for (const type of ['invoice.paid', 'invoice.payment_succeeded']) {
      const tag = type.replace('.', '_');
      const ws = await makeEnrolled({ 'subscription.stripe.subscriptionId': `sub_${tag}`, 'subscription.stripe.customerId': `cus_${tag}`, 'subscription.stripe.status': 'incomplete', 'subscription.state': 'pending' });
      stripe.setSubscription(makeSubscription({ id: `sub_${tag}`, customer: `cus_${tag}`, status: 'active', metadata: meta(ws), currentPeriodEnd: 1_800_000_000 }));
      const res = await send(evt({ type, object: makeInvoice({ subscription: `sub_${tag}`, customer: `cus_${tag}` }) }));
      const d = await doc(ws);
      out.push({ status: res.status, outcome: res.body.outcome, state: d.subscription.state, source: d.subscription.source, notes: (await OnboardingNotification.find({ workspaceId: ws }).lean()).map((n) => n.kind) });
    }
    expect(out[0]).toEqual(out[1]);
    expect(out[0]).toEqual({ status: 200, outcome: 'processed', state: 'active', source: 'stripe', notes: ['subscription_active'] });
  });
});

describe('payment_failed, reactivation, cancellation', () => {
  test('payment_failed -> past_due + exactly one notification and one e-mail, however often Stripe re-sends', async () => {
    const ws = await makeEnrolled({ 'subscription.stripe.subscriptionId': 'sub_pf', 'subscription.stripe.customerId': 'cus_pf', 'subscription.stripe.status': 'active', 'subscription.state': 'active', 'subscription.source': 'stripe' });
    stripe.setSubscription(makeSubscription({ id: 'sub_pf', customer: 'cus_pf', status: 'past_due', metadata: meta(ws) }));
    const inv = makeInvoice({ id: 'in_pf_1', status: 'open', subscription: 'sub_pf', customer: 'cus_pf' });
    for (let i = 0; i < 3; i += 1) expect((await send(evt({ type: 'invoice.payment_failed', object: inv }))).status).toBe(200);
    const d = await doc(ws);
    expect(d.subscription).toMatchObject({ state: 'past_due', stripe: { status: 'past_due', lastPaymentFailureCode: 'payment_failed' } });
    expect(d.subscription.pastDueAt).toBeTruthy();
    expect(d.subscription.stripe.lastPaymentFailedAt).toBeTruthy();
    const notes = await OnboardingNotification.find({ workspaceId: ws }).lean();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'payment_failed', severity: 'action', dedupeKey: 'sub:past_due:sub_pf:in_pf_1' });
    await waitFor(() => mail.sent.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(mail.sent).toHaveLength(1);
    expect(await OnboardingEvent.countDocuments({ workspaceId: ws, type: 'payment_state', code: 'SUB_PAST_DUE' })).toBe(1);
    // the gate now blocks (state.getGateState is read-through after the invalidate)
    expect((await state.getGateState(ws)).sub.state).toBe('past_due');
  });

  test('reactivation keeps ALL onboarding progress untouched', async () => {
    const ws = await makeEnrolled({
      'subscription.stripe.subscriptionId': 'sub_re', 'subscription.stripe.customerId': 'cus_re', 'subscription.stripe.status': 'past_due',
      'subscription.state': 'past_due',
      'steps.business.status': 'done', 'steps.number.status': 'done', 'steps.connect.status': 'in_progress',
      'progress.currentStep': 3, 'progress.furthestStep': 3,
      'business.name': 'Acme', 'business.industry': 'grocery', 'number.path': 'A',
    });
    const snap = async () => { const d = await doc(ws); return JSON.stringify({ steps: d.steps, progress: d.progress, business: d.business, number: d.number, prompts: d.prompts, firstPromotion: d.firstPromotion }); };
    const before = await snap();
    stripe.setSubscription(makeSubscription({ id: 'sub_re', customer: 'cus_re', status: 'active', metadata: meta(ws), currentPeriodEnd: 1_900_000_000 }));
    expect((await send(evt({ type: 'invoice.paid', object: makeInvoice({ subscription: 'sub_re' }) }))).body.outcome).toBe('processed');
    expect((await doc(ws)).subscription).toMatchObject({ state: 'active', source: 'stripe' });
    expect(await snap()).toBe(before);
  });

  test('customer.subscription.deleted -> cancelled with one notification and one e-mail; data and progress stay', async () => {
    const ws = await makeEnrolled({ 'subscription.stripe.subscriptionId': 'sub_del', 'subscription.stripe.customerId': 'cus_del', 'subscription.stripe.status': 'active', 'subscription.state': 'active', 'subscription.source': 'stripe', 'business.name': 'Keep Me' });
    const del = makeSubscription({ id: 'sub_del', customer: 'cus_del', status: 'canceled', metadata: meta(ws) });
    expect((await send(evt({ type: 'customer.subscription.deleted', object: del }))).status).toBe(200);
    const d = await doc(ws);
    expect(d.subscription).toMatchObject({ state: 'cancelled', stripe: { status: 'canceled' } });
    expect(d.subscription.cancelledAt).toBeTruthy();
    expect(d.business.name).toBe('Keep Me');
    expect((await OnboardingNotification.find({ workspaceId: ws }).lean()).map((n) => n.kind)).toEqual(['subscription_cancelled']);
    await waitFor(() => mail.sent.length === 1);
    expect(stripe.callsTo('subscriptions.retrieve')).toHaveLength(0);
  });

  test('trialing stays pending unless ONBOARDING_ACCEPT_TRIALING=on AND a default payment method exists', async () => {
    const run = async (accept, pm) => {
      if (accept) process.env.ONBOARDING_ACCEPT_TRIALING = 'on'; else delete process.env.ONBOARDING_ACCEPT_TRIALING;
      const ws = await makeEnrolled({ 'subscription.stripe.checkoutStartedAt': new Date(), 'subscription.state': 'pending' });
      const id = `sub_tr_${accept}_${pm}`;
      stripe.setSubscription(makeSubscription({ id, customer: `cus_${id}`, status: 'trialing', metadata: meta(ws), defaultPaymentMethod: pm ? 'pm_1' : null }));
      await send(evt({ type: 'customer.subscription.created', object: makeSubscription({ id, customer: `cus_${id}`, status: 'trialing', metadata: meta(ws) }) }));
      return (await doc(ws)).subscription.state;
    };
    expect(await run(false, true)).toBe('pending');
    expect(await run(true, false)).toBe('pending');
    expect(await run(true, true)).toBe('active');
  });
});

describe('claim: failure, re-claim, stale processing', () => {
  test('a Stripe outage answers 500; the row is failed; the redelivery succeeds (attempts 2)', async () => {
    const ws = await makeEnrolled({ 'subscription.stripe.subscriptionId': 'sub_out', 'subscription.stripe.customerId': 'cus_out', 'subscription.stripe.status': 'incomplete', 'subscription.state': 'pending' });
    stripe.setSubscription(makeSubscription({ id: 'sub_out', customer: 'cus_out', status: 'active', metadata: meta(ws) }));
    stripe.failNext('subscriptions.retrieve', { type: 'StripeConnectionError' }, { times: 1 });
    const signed = evt({ type: 'invoice.paid', object: makeInvoice({ subscription: 'sub_out', customer: 'cus_out' }) });
    const first = await send(signed);
    expect(first.status).toBe(500);
    expect(await OnboardingInbound.findById(`stripe:${signed.event.id}`).lean()).toMatchObject({ status: 'failed', attempts: 1, errorCode: 'StripeConnectionError' });
    expect((await doc(ws)).subscription.state).toBe('pending');
    const second = await send(signed);
    expect([second.status, second.body.outcome]).toEqual([200, 'processed']);
    expect(await OnboardingInbound.findById(`stripe:${signed.event.id}`).lean()).toMatchObject({ status: 'done', attempts: 2 });
    expect((await doc(ws)).subscription.state).toBe('active');
  });

  test('a `processing` row younger than 2 min is left alone (200); an older one is re-claimed', async () => {
    const ws = await makeEnrolled({ 'subscription.stripe.subscriptionId': 'sub_pr', 'subscription.stripe.customerId': 'cus_pr', 'subscription.stripe.status': 'incomplete', 'subscription.state': 'pending' });
    stripe.setSubscription(makeSubscription({ id: 'sub_pr', customer: 'cus_pr', status: 'active', metadata: meta(ws) }));
    const signed = evt({ type: 'invoice.paid', object: makeInvoice({ subscription: 'sub_pr', customer: 'cus_pr' }) });
    await OnboardingInbound.create({ _id: `stripe:${signed.event.id}`, source: 'stripe', type: 'invoice.paid', status: 'processing', attempts: 1, startedAt: new Date() });
    const young = await send(signed);
    expect([young.status, young.body.outcome]).toEqual([200, 'in_progress']);
    expect((await doc(ws)).subscription.state).toBe('pending');
    await OnboardingInbound.updateOne({ _id: `stripe:${signed.event.id}` }, { $set: { startedAt: new Date(Date.now() - 5 * 60 * 1000) } });
    const stale = await send(signed);
    expect([stale.status, stale.body.outcome]).toEqual([200, 'processed']);
    expect((await doc(ws)).subscription.state).toBe('active');
    expect((await OnboardingInbound.findById(`stripe:${signed.event.id}`).lean()).attempts).toBe(2);
  });
});

describe('the REAL server.js (flag ON): wiring and the untouched /stripe-webhook', () => {
  const rawPost = (path, signed, headerOverride) => {
    let r = request(app).post(path).set('content-type', 'application/json');
    const header = headerOverride === undefined ? signed.header : headerOverride;
    if (header) r = r.set('stripe-signature', header);
    return r.send(asText(signed.body));
  };

  test('POST /stripe-billing-webhook through the real server: bad signature 400, ignored event 200, foreign checkout 200', async () => {
    const good = createFakeStripe({}).signedEvent({ type: 'customer.created', object: { id: 'cus_real_server' } });
    const ok = await rawPost('/stripe-billing-webhook', good);
    expect([ok.status, ok.body]).toEqual([200, { received: true, outcome: 'ignored' }]);
    const bad = await rawPost('/stripe-billing-webhook', createFakeStripe({}).signedEvent({ type: 'customer.created', object: {}, secret: 'whsec_not_ours_dummy' }));
    expect([bad.status, bad.body.code]).toEqual([400, 'WEBHOOK_SIGNATURE_INVALID']);
    const none = await rawPost('/stripe-billing-webhook', good, '');
    expect(none.status).toBe(400);
    const foreign = createFakeStripe({}).signedEvent({ type: 'checkout.session.completed', object: makeCheckoutSession({ metadata: {}, clientReferenceId: 'shop-order-1' }) });
    expect((await rawPost('/stripe-billing-webhook', foreign)).body.outcome).toBe('ignored_not_ours');
  });

  test('with the new secret removed the real route answers 503', async () => {
    const saved = process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET;
    const savedPrev = process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET_PREV;
    delete process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET;
    delete process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET_PREV;
    try {
      const res = await rawPost('/stripe-billing-webhook', createFakeStripe({}).signedEvent({ type: 'customer.created', object: {} }));
      expect([res.status, res.body.code]).toEqual([503, 'CHECKOUT_NOT_CONFIGURED']);
    } finally {
      process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET = saved;
      process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET_PREV = savedPrev;
    }
  });

  test('only POST is routed; flipping the flag off makes the path an unknown route again', async () => {
    expect((await request(app).get('/stripe-billing-webhook')).status).toBe(404);
    process.env.ONBOARDING_FLOW = 'off';
    const off = await request(app).post('/stripe-billing-webhook').set('content-type', 'application/json').send('{"id":"evt_1"}');
    const unknown = await request(app).post('/zzz-not-a-route').set('content-type', 'application/json').send('{"id":"evt_1"}');
    expect(off.status).toBe(404);
    expect(off.status).toBe(unknown.status);
    expect(off.text.replace('/stripe-billing-webhook', 'X')).toBe(unknown.text.replace('/zzz-not-a-route', 'X'));
    process.env.ONBOARDING_FLOW = 'on';
  });

  test('the EXISTING /stripe-webhook behaves exactly as before and never reaches the new handler', async () => {
    const before = await OnboardingInbound.countDocuments({});
    // 1. bad signature -> 400 with the legacy text body
    const bad = await rawPost('/stripe-webhook', createFakeStripe({}).signedEvent({ type: 'payment_intent.payment_failed', object: { id: 'pi_legacy_1' }, secret: 'whsec_not_ours_dummy' }));
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(/^Webhook Error: /);
    // 2. a payload signed with the NEW onboarding secret is NOT accepted by the legacy endpoint
    const withNew = await rawPost('/stripe-webhook', createFakeStripe({}).signedEvent({ type: 'payment_intent.payment_failed', object: { id: 'pi_legacy_2' } }));
    expect(withNew.status).toBe(400);
    expect(withNew.text).toMatch(/^Webhook Error: /);
    // 3. a payload signed with the LEGACY secret is processed by the legacy handler (payment_failed -> 200 OK)
    const legacy = await rawPost('/stripe-webhook', createFakeStripe({}).signedEvent({ type: 'payment_intent.payment_failed', object: { id: 'pi_legacy_3' }, secret: LEGACY_SECRET }));
    expect(legacy.status).toBe(200);
    expect(legacy.text).toBe('OK');
    // 4. the legacy secret does not work on the new endpoint either, and no inbound row was ever created by any of this
    const crossed = await rawPost('/stripe-billing-webhook', createFakeStripe({}).signedEvent({ type: 'customer.created', object: {}, secret: LEGACY_SECRET }));
    expect(crossed.status).toBe(400);
    expect(await OnboardingInbound.countDocuments({})).toBe(before);
  });
});

describe('the REAL server.js (flag ON): the billing routes are mounted behind the right gates', () => {
  const tokenFor = (userId, workspaceId, role = 'owner') => jwt.sign({ sub: userId, workspaceId, role }, JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: '1h' });
  async function member(workspaceId, role) {
    const user = await User.create({ email: `${role}.${workspaceId}@acme.test` });
    await Membership.create({ userId: user._id, workspaceId, role });
    return tokenFor(String(user._id), workspaceId, role);
  }
  const post = (path, tok) => request(app).post(path).set(tok ? { Authorization: `Bearer ${tok}` } : {}).send({ planCode: 'standard' });

  test('POST /api/onboarding/checkout: 401 without a token, 403 for a member, 503 (no Stripe key configured) for the owner, 404 for a legacy workspace', async () => {
    const ws = await makeEnrolled();
    expect((await post('/api/onboarding/checkout')).status).toBe(401);
    const ownerTok = await member(ws, 'owner');
    const res = await post('/api/onboarding/checkout', ownerTok);
    expect([res.status, res.body.code, res.body.nextStep]).toEqual([503, 'CHECKOUT_NOT_CONFIGURED', 'billing']);
    const memberTok = await member(ws, 'member');
    const denied = await post('/api/onboarding/checkout', memberTok);
    expect([denied.status, denied.body.code]).toEqual([403, 'OWNER_ONLY']);
    const legacy = await Workspace.collection.insertOne({ name: 'Legacy', createdAt: new Date('2026-02-01T00:00:00Z'), updatedAt: new Date(), onboarding: { completed: true, currentStep: 1 } });
    const legacyTok = await member(String(legacy.insertedId), 'owner');
    const gone = await post('/api/onboarding/checkout', legacyTok);
    expect([gone.status, gone.body.code]).toEqual([404, 'ONBOARDING_NOT_AVAILABLE']);
    expect((await post('/api/onboarding/billing-portal', ownerTok)).body.code).toBe('BILLING_PORTAL_UNAVAILABLE');
  });

  test('POST /api/onboarding/billing/refresh: a member of an enrolled pending workspace gets {changed:false}; the second call within 15 s is 429', async () => {
    const ws = await makeEnrolled({ 'subscription.state': 'pending', 'subscription.stripe.checkoutStartedAt': new Date() });
    const tok = await member(ws, 'member');
    const first = await post('/api/onboarding/billing/refresh', tok);
    expect([first.status, first.body.changed, first.body.subscription.state]).toEqual([200, false, 'pending']);
    const second = await post('/api/onboarding/billing/refresh', tok);
    expect([second.status, second.body.code]).toEqual([429, 'RATE_LIMITED']);
  });
});

describe('sanity of the fixtures used here', () => {
  test('the fixture secret is the one the handler was configured with', () => {
    expect(TEST_WEBHOOK_SECRET).toBe(NEW_SECRET);
  });
});
