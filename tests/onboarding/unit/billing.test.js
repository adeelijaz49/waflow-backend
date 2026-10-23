'use strict';
// billing.js (checkout, portal, applyStripeState, reconcile) and routes/onboarding/billing.js against in-memory models,
// the REAL state.js / subscription.js and fakeStripe. No network, no DB.
const express = require('express');
const request = require('supertest');
const billing = require('../../../shared/onboarding/billing');
const realState = require('../../../shared/onboarding/state');
const { createLimiter } = require('../../../shared/onboarding/rateLimit');
const { createRouter } = require('../../../routes/onboarding/billing');
const { makeHarness, newId } = require('./_stripeHarness');
const { makeSubscription, makeCheckoutSession } = require('../_fixtures');

const ENV = ['ONBOARDING_FLOW', 'ONBOARDING_CHECKOUT', 'ONBOARDING_BILLING_PORTAL', 'ONBOARDING_STRIPE_PRICES', 'ONBOARDING_STRIPE_SECRET_KEY',
  'STRIPE_SECRET_KEY', 'ONBOARDING_BILLING_RECONCILE_ON_DEMAND', 'FRONTEND_URL', 'ONBOARDING_ACCEPT_TRIALING'];
const saved = {};
beforeEach(() => {
  ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  process.env.ONBOARDING_FLOW = 'on';
  process.env.ONBOARDING_CHECKOUT = 'on';
  process.env.ONBOARDING_BILLING_PORTAL = 'on';
  process.env.ONBOARDING_STRIPE_PRICES = JSON.stringify({ standard: 'price_env_standard', pro: 'price_env_pro' });
  process.env.FRONTEND_URL = 'https://app.example.test';
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  jest.restoreAllMocks();
});

const MIN = 60 * 1000;
const createdParams = (h) => h.stripe.callsTo('checkout.sessions.create')[0].args.params;

describe('createCheckout', () => {
  test('payload: price from env only, ids and metadata, no e-mail when unknown', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    const out = await billing.createCheckout({ workspaceId: ws, userId: newId(), planCode: 'standard' }, h.deps);
    expect(out.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const meta = { workspaceId: ws, planCode: 'standard', waflow_purpose: 'merchant_subscription' };
    expect(createdParams(h)).toEqual({
      mode: 'subscription',
      line_items: [{ price: 'price_env_standard', quantity: 1 }],
      client_reference_id: ws,
      metadata: meta,
      subscription_data: { metadata: meta },
      custom_fields: [{ key: 'business_name', label: { type: 'custom', custom: 'Business name' }, type: 'text' }],
      payment_method_collection: 'always',
      success_url: 'https://app.example.test/setup?checkout=return',
      cancel_url: 'https://app.example.test/setup?checkout=cancel',
    });
    expect(h.stripe.callsTo('checkout.sessions.create')[0].args.reqOpts.idempotencyKey).toMatch(/^onb-checkout-/);
  });

  test('state none -> pending, session id and start time stored, one payment_state event', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    const out = await billing.createCheckout({ workspaceId: ws, planCode: 'pro' }, h.deps);
    const s = h.row(ws).subscription;
    expect(s.state).toBe('pending');
    expect(s.stripe.checkoutSessionId).toMatch(/^cs_test_fixture_/);
    expect(s.stripe.checkoutStartedAt).toEqual(h.clock.now());
    expect(out.url).toContain(s.stripe.checkoutSessionId);
    expect(h.tracked.filter((t) => t.type === 'payment_state')).toEqual([expect.objectContaining({ code: 'SUB_PENDING' })]);
    expect(createdParams(h).line_items[0].price).toBe('price_env_pro');
  });

  test('a price id (or anything not in the env table) sent as the plan is refused: the price never comes from the client', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    for (const planCode of ['price_env_standard', 'price_attacker', '', '   ', undefined, null, 5, '__proto__', 'constructor', 'toString', 'STANDARD']) {
      await expect(billing.createCheckout({ workspaceId: ws, planCode }, h.deps)).rejects.toMatchObject({ code: 'PLAN_UNKNOWN', status: 422 });
    }
    expect(h.stripe.calls).toHaveLength(0);
    expect(h.row(ws).subscription.state).toBe('none');
  });

  test('the plan code is trimmed', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    await billing.createCheckout({ workspaceId: ws, planCode: '  standard ' }, h.deps);
    expect(createdParams(h).metadata.planCode).toBe('standard');
  });

  test.each([
    ['flag off', () => { delete process.env.ONBOARDING_CHECKOUT; }],
    ['flag not exactly on', () => { process.env.ONBOARDING_CHECKOUT = 'true'; }],
    ['no prices configured', () => { delete process.env.ONBOARDING_STRIPE_PRICES; }],
    ['prices not an object', () => { process.env.ONBOARDING_STRIPE_PRICES = '["x"]'; }],
  ])('unconfigured (%s): 503 CHECKOUT_NOT_CONFIGURED and nothing happens', async (_n, setup) => {
    setup();
    const h = makeHarness();
    const ws = h.seedWorkspace();
    await expect(billing.createCheckout({ workspaceId: ws, planCode: 'standard' }, h.deps)).rejects.toMatchObject({ code: 'CHECKOUT_NOT_CONFIGURED', status: 503 });
    expect(h.stripe.calls).toHaveLength(0);
    expect(h.row(ws).subscription.state).toBe('none');
  });

  test('no Stripe secret key (and no injected client): 503 CHECKOUT_NOT_CONFIGURED', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    const { stripe, ...noStripe } = h.deps; // eslint-disable-line no-unused-vars
    await expect(billing.createCheckout({ workspaceId: ws, planCode: 'standard' }, noStripe)).rejects.toMatchObject({ code: 'CHECKOUT_NOT_CONFIGURED' });
  });

  test('a workspace that is not enrolled: ONBOARDING_NOT_AVAILABLE', async () => {
    const h = makeHarness();
    await expect(billing.createCheckout({ workspaceId: newId(), planCode: 'standard' }, h.deps)).rejects.toMatchObject({ code: 'ONBOARDING_NOT_AVAILABLE', status: 404 });
    expect(h.stripe.calls).toHaveLength(0);
  });

  describe('customer_email (only when known, never a phone)', () => {
    test('prefill.email wins; else the User e-mail; else none', async () => {
      const h = makeHarness();
      const uid = newId();
      h.User.seed({ _id: uid, email: 'user@example.test', phone: '966501234567' });
      const a = h.seedWorkspace({}, { prefill: { email: 'prefill@example.test' } });
      await billing.createCheckout({ workspaceId: a, userId: uid, planCode: 'standard' }, h.deps);
      expect(createdParams(h).customer_email).toBe('prefill@example.test');
      const b = h.seedWorkspace();
      await billing.createCheckout({ workspaceId: b, userId: uid, planCode: 'standard' }, h.deps);
      expect(h.stripe.callsTo('checkout.sessions.create')[1].args.params.customer_email).toBe('user@example.test');
    });
    test('a phone-only user gives no customer_email at all', async () => {
      const h = makeHarness();
      const uid = newId();
      h.User.seed({ _id: uid, phone: '966501234567' });
      const ws = h.seedWorkspace();
      await billing.createCheckout({ workspaceId: ws, userId: uid, planCode: 'standard' }, h.deps);
      expect(Object.prototype.hasOwnProperty.call(createdParams(h), 'customer_email')).toBe(false);
      expect(JSON.stringify(createdParams(h))).not.toContain('966501234567');
    });
    test('a failing User lookup does not block checkout', async () => {
      const h = makeHarness();
      h.User.failWith = new Error('db down');
      const ws = h.seedWorkspace();
      await expect(billing.createCheckout({ workspaceId: ws, userId: newId(), planCode: 'standard' }, h.deps)).resolves.toHaveProperty('url');
    });
  });

  describe('an existing subscription: 409 with the existing state, no second Stripe subscription', () => {
    test.each([
      ['active (stripe)', { state: 'active', source: 'stripe', stripe: { subscriptionId: 'sub_1', status: 'active' } }, 'active'],
      ['active (admin)', { state: 'active', source: 'admin', admin: { active: true } }, 'active'],
      ['pending with a Stripe subscription (incomplete / trial)', { state: 'pending', stripe: { subscriptionId: 'sub_1', status: 'incomplete' } }, 'pending'],
      ['past_due', { state: 'past_due', stripe: { subscriptionId: 'sub_1', status: 'past_due' } }, 'past_due'],
    ])('%s', async (_n, sub, state) => {
      const h = makeHarness();
      const ws = h.seedWorkspace(sub);
      const before = JSON.stringify(h.row(ws));
      const err = await billing.createCheckout({ workspaceId: ws, planCode: 'standard' }, h.deps).catch((e) => e);
      expect(err).toBeInstanceOf(billing.SubscriptionExistsError);
      expect(err).toMatchObject({ status: 409, code: 'SUBSCRIPTION_EXISTS', subscription: { state } });
      expect(h.stripe.calls).toHaveLength(0);
      expect(JSON.stringify(h.row(ws))).toBe(before);
    });
    test.each([
      ['none', { state: 'none' }, 'pending'],
      ['an abandoned checkout (pending without a subscription)', { state: 'pending', stripe: { checkoutSessionId: 'cs_old', checkoutStartedAt: new Date(0) } }, 'pending'],
      ['cancelled', { state: 'cancelled', stripe: { subscriptionId: 'sub_old', status: 'canceled' } }, 'cancelled'],
      ['incomplete_expired', { state: 'none', stripe: { subscriptionId: 'sub_old', status: 'incomplete_expired' } }, 'none'],
    ])('allowed when %s; the state only becomes pending from none', async (_n, sub, expectedState) => {
      const h = makeHarness();
      const ws = h.seedWorkspace(sub);
      await expect(billing.createCheckout({ workspaceId: ws, planCode: 'standard' }, h.deps)).resolves.toHaveProperty('url');
      expect(h.row(ws).subscription.state).toBe(expectedState);
      expect(h.row(ws).subscription.stripe.checkoutSessionId).toMatch(/^cs_test_fixture_/);
    });
  });

  describe('Stripe failures', () => {
    test('connection / server errors -> STRIPE_ERROR (retryable), nothing written', async () => {
      const h = makeHarness();
      const ws = h.seedWorkspace();
      for (const type of ['StripeConnectionError', 'StripeRateLimitError', 'StripeAPIError']) {
        h.stripe.failNext('checkout.sessions.create', { type, message: 'customer owner@example.test card' }, { times: 1 });
        const err = await billing.createCheckout({ workspaceId: ws, planCode: 'standard' }, h.deps).catch((e) => e);
        expect(err).toMatchObject({ code: 'STRIPE_ERROR', status: 503, retryable: true });
        expect(err.message).not.toContain('owner@example.test');
      }
      expect(h.row(ws).subscription.state).toBe('none');
      expect(h.row(ws).subscription.stripe).toBeUndefined();
    });
    test('a rejected request (bad price id in the env table) is a configuration problem: CHECKOUT_NOT_CONFIGURED', async () => {
      const h = makeHarness();
      const ws = h.seedWorkspace();
      h.stripe.failNext('checkout.sessions.create', { type: 'StripeInvalidRequestError', statusCode: 400 });
      await expect(billing.createCheckout({ workspaceId: ws, planCode: 'standard' }, h.deps)).rejects.toMatchObject({ code: 'CHECKOUT_NOT_CONFIGURED' });
    });
    test('a session without an https url is refused', async () => {
      const h = makeHarness();
      const ws = h.seedWorkspace();
      for (const url of [null, 'http://checkout.stripe.test/x', 'javascript:alert(1)', '']) {
        const stripe = { checkout: { sessions: { create: async () => ({ id: 'cs_x', url }) } } };
        await expect(billing.createCheckout({ workspaceId: ws, planCode: 'standard' }, { ...h.deps, stripe })).rejects.toMatchObject({ code: 'STRIPE_ERROR' });
      }
    });
    test('a bookkeeping failure after the session exists still returns the URL (the webhook resolves by metadata)', async () => {
      const h = makeHarness();
      const ws = h.seedWorkspace();
      const state = { ...realState, recomputeSubscription: async () => { throw new Error('db hiccup'); } };
      await expect(billing.createCheckout({ workspaceId: ws, planCode: 'standard' }, { ...h.deps, state })).resolves.toHaveProperty('url');
    });
  });
});

describe('createPortal', () => {
  const withCustomer = (h) => h.seedWorkspace({ state: 'past_due', stripe: { customerId: 'cus_77', subscriptionId: 'sub_1', status: 'past_due' } });

  test('returns the Stripe-hosted portal url for the stored customer, with a return url', async () => {
    const h = makeHarness();
    const ws = withCustomer(h);
    const out = await billing.createPortal({ workspaceId: ws }, h.deps);
    expect(out.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    expect(h.stripe.callsTo('billingPortal.sessions.create')[0].args.params).toEqual({ customer: 'cus_77', return_url: 'https://app.example.test/setup' });
  });
  test('disabled, no customer, no key, portal not configured in Stripe: 503 BILLING_PORTAL_UNAVAILABLE', async () => {
    const h = makeHarness();
    const ws = withCustomer(h);
    delete process.env.ONBOARDING_BILLING_PORTAL;
    await expect(billing.createPortal({ workspaceId: ws }, h.deps)).rejects.toMatchObject({ code: 'BILLING_PORTAL_UNAVAILABLE', status: 503 });
    process.env.ONBOARDING_BILLING_PORTAL = 'on';
    const noCustomer = h.seedWorkspace({ state: 'none' });
    await expect(billing.createPortal({ workspaceId: noCustomer }, h.deps)).rejects.toMatchObject({ code: 'BILLING_PORTAL_UNAVAILABLE' });
    const { stripe, ...noStripe } = h.deps; // eslint-disable-line no-unused-vars
    await expect(billing.createPortal({ workspaceId: ws }, noStripe)).rejects.toMatchObject({ code: 'BILLING_PORTAL_UNAVAILABLE' });
    h.stripe.failNext('billingPortal.sessions.create', { type: 'StripeInvalidRequestError', statusCode: 400 });
    await expect(billing.createPortal({ workspaceId: ws }, h.deps)).rejects.toMatchObject({ code: 'BILLING_PORTAL_UNAVAILABLE' });
    expect(h.stripe.callsTo('billingPortal.sessions.create')).toHaveLength(1);
  });
  test('Stripe outages -> STRIPE_ERROR; a non-https url is refused; not enrolled -> 404', async () => {
    const h = makeHarness();
    const ws = withCustomer(h);
    h.stripe.failNext('billingPortal.sessions.create', { type: 'StripeConnectionError' });
    await expect(billing.createPortal({ workspaceId: ws }, h.deps)).rejects.toMatchObject({ code: 'STRIPE_ERROR' });
    const stripe = { billingPortal: { sessions: { create: async () => ({ url: 'http://portal.test/x' }) } } };
    await expect(billing.createPortal({ workspaceId: ws }, { ...h.deps, stripe })).rejects.toMatchObject({ code: 'STRIPE_ERROR' });
    await expect(billing.createPortal({ workspaceId: newId() }, h.deps)).rejects.toMatchObject({ code: 'ONBOARDING_NOT_AVAILABLE' });
  });
});

describe('applyStripeState', () => {
  const apply = (h, ws, status, ctx = {}, subOver = {}) =>
    billing.applyStripeState(ws, makeSubscription({ id: 'sub_1', customer: 'cus_1', status, ...subOver }), { canonical: true, ...ctx }, h.deps);

  test('writes subscription.stripe.* in one update, then the state (priceId -> planCode from the env table)', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    const res = await apply(h, ws, 'active', {}, { priceId: 'price_env_pro', cancelAtPeriodEnd: true, currentPeriodEnd: 1_800_000_000 });
    expect(res).toMatchObject({ changed: true, before: { state: 'none' }, after: { state: 'active', source: 'stripe' } });
    expect(h.row(ws).subscription.stripe).toMatchObject({
      customerId: 'cus_1', subscriptionId: 'sub_1', status: 'active', priceId: 'price_env_pro', planCode: 'pro',
      cancelAtPeriodEnd: true, hasDefaultPaymentMethod: true,
    });
    expect(h.row(ws).subscription.stripe.currentPeriodEnd).toEqual(new Date(1_800_000_000 * 1000));
    expect(h.row(ws).subscription.activatedAt).toEqual(h.clock.now());
    const updates = h.OnboardingState.calls.filter((c) => c[0] === 'updateOne' && c[2].$set && Object.keys(c[2].$set).some((k) => k.startsWith('subscription.stripe.')));
    expect(updates).toHaveLength(1);
  });

  test('idempotent: re-applying changes nothing but lastSyncedAt and writes no second payment_state event', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    await apply(h, ws, 'active');
    const changedAt = h.row(ws).subscription.changedAt;
    h.clock.advance(5000);
    const again = await apply(h, ws, 'active');
    expect(again.changed).toBe(false);
    expect(h.row(ws).subscription.changedAt).toEqual(changedAt);
    expect(h.row(ws).subscription.stripe.lastSyncedAt).toEqual(h.clock.now());
    expect(h.tracked.filter((t) => t.type === 'payment_state')).toHaveLength(1);
  });

  test.each([
    ['active', 'active'], ['trialing', 'pending'], ['incomplete', 'pending'], ['incomplete_expired', 'none'],
    ['past_due', 'past_due'], ['unpaid', 'past_due'], ['paused', 'past_due'], ['canceled', 'cancelled'],
  ])('table 4.2 through the real state writer: %s -> %s', async (raw, expected) => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'pending', stripe: { checkoutStartedAt: new Date(0) } });
    await apply(h, ws, raw);
    expect(h.row(ws).subscription.state).toBe(expected);
  });

  test('incomplete_expired records the failure time', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'pending', stripe: { checkoutStartedAt: new Date(0) } });
    await apply(h, ws, 'incomplete_expired');
    expect(h.row(ws).subscription.stripe.lastPaymentFailedAt).toEqual(h.clock.now());
  });

  test('unknown status: nothing but lastSyncedAt is written and the state survives (even an active one)', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    await apply(h, ws, 'active');
    const res = await apply(h, ws, 'brand_new_status');
    expect(res).toMatchObject({ changed: false, ignored: 'UNKNOWN_STATUS' });
    expect(h.row(ws).subscription).toMatchObject({ state: 'active', stripe: { status: 'active' } });
    expect((await billing.applyStripeState(ws, { id: 'sub_1' }, { canonical: true }, h.deps)).ignored).toBe('UNKNOWN_STATUS');
  });

  describe('effective state matrix (stripe x admin, DB 4.3) through the real state writer', () => {
    const cases = [
      // adminActive, stripe raw (null = no stripe data), expected state, expected source
      [false, null, 'none', null],
      [false, 'active', 'active', 'stripe'],
      [false, 'past_due', 'past_due', null],
      [false, 'canceled', 'cancelled', null],
      [true, null, 'active', 'admin'],
      [true, 'active', 'active', 'stripe'],
      [true, 'past_due', 'active', 'admin'],
      [true, 'canceled', 'active', 'admin'],
    ];
    test.each(cases)('admin.active=%s stripe=%s -> %s / %s', async (adminActive, raw, state, source) => {
      const h = makeHarness();
      const ws = h.seedWorkspace({ admin: { active: adminActive } });
      if (raw) await apply(h, ws, raw);
      else await realState.recomputeSubscription(ws, {}, { OnboardingState: h.OnboardingState, now: h.deps.now, track: h.deps.track });
      expect(h.row(ws).subscription).toMatchObject({ state, source });
    });
  });

  test('guards: unknown workspace -> NOT_ENROLLED, invalid id throws, a stale payload-only event is ignored', async () => {
    const h = makeHarness();
    expect(await apply(h, newId(), 'active')).toMatchObject({ changed: false, ignored: 'NOT_ENROLLED' });
    await expect(apply(h, 'nope', 'active')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const ws = h.seedWorkspace({ stripe: { lastEventCreated: 500 } });
    const stale = await billing.applyStripeState(ws, makeSubscription({ id: 'sub_1', status: 'active' }), { canonical: false, eventCreated: 400 }, h.deps);
    expect(stale.ignored).toBe('STALE_EVENT');
    const canonicalOlder = await billing.applyStripeState(ws, makeSubscription({ id: 'sub_1', status: 'active' }), { canonical: true, eventCreated: 400 }, h.deps);
    expect(canonicalOlder.ignored).toBeUndefined();
    expect(h.row(ws).subscription.stripe.lastEventCreated).toBe(500); // never moves backwards
  });

  test('a basil-shaped subscription (period end on the items) is stored correctly', async () => {
    const h = makeHarness({ shape: 'basil' });
    const ws = h.seedWorkspace();
    await billing.applyStripeState(ws, h.stripe.makeSubscription({ id: 'sub_1', status: 'active', currentPeriodEnd: 1_800_000_000 }), { canonical: true }, h.deps);
    expect(h.row(ws).subscription.stripe.currentPeriodEnd).toEqual(new Date(1_800_000_000 * 1000));
  });
});

describe('refreshBilling', () => {
  test('nothing to reconcile: no Stripe call, current state returned', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    const out = await billing.refreshBilling({ workspaceId: ws }, h.deps);
    expect(out).toEqual({ changed: false, subscription: { state: 'none', source: null, retry: { checkout: true, billingPortal: false, reconnect: false } } });
    expect(h.stripe.calls).toHaveLength(0);
  });

  test('a stored subscription is re-read FROM STRIPE and applied (the server asks, the browser decides nothing)', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'pending', stripe: { subscriptionId: 'sub_1', customerId: 'cus_1', status: 'incomplete' } });
    h.stripe.setSubscription(makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'active' }));
    const out = await billing.refreshBilling({ workspaceId: ws }, h.deps);
    expect(out).toMatchObject({ changed: true, subscription: { state: 'active', source: 'stripe', retry: { checkout: false, billingPortal: false } } });
    expect(h.row(ws).subscription.state).toBe('active');
    expect(h.stripe.callsTo('subscriptions.retrieve')).toHaveLength(1);
  });

  test('unchanged on a second refresh (changed:false) and the retry flags follow the state', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'past_due', stripe: { subscriptionId: 'sub_1', customerId: 'cus_1', status: 'past_due' } });
    h.stripe.setSubscription(makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'past_due' }));
    const out = await billing.refreshBilling({ workspaceId: ws }, h.deps);
    expect(out).toMatchObject({ changed: false, subscription: { state: 'past_due', retry: { billingPortal: true, checkout: false } } });
  });

  test('before any subscription exists: a paid Checkout Session is retrieved, prefill captured, subscription applied', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    const created = await billing.createCheckout({ workspaceId: ws, planCode: 'standard' }, h.deps);
    expect(created.url).toBeTruthy();
    const sessionId = h.row(ws).subscription.stripe.checkoutSessionId;
    h.stripe.completeCheckout(sessionId, { subscriptionId: 'sub_done', customer: 'cus_done', businessName: 'Acme Sweets' });
    const out = await billing.refreshBilling({ workspaceId: ws }, h.deps);
    expect(out).toMatchObject({ changed: true, subscription: { state: 'active' } });
    expect(h.row(ws).subscription.stripe).toMatchObject({ subscriptionId: 'sub_done', customerId: 'cus_done', status: 'active', planCode: 'standard' });
    expect(h.row(ws).prefill).toMatchObject({ businessName: 'Acme Sweets', email: 'owner@example.test' });
  });

  test('an open session changes nothing; an expired one resets pending -> none so the owner can retry', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    await billing.createCheckout({ workspaceId: ws, planCode: 'standard' }, h.deps);
    expect(await billing.refreshBilling({ workspaceId: ws }, h.deps)).toMatchObject({ changed: false, subscription: { state: 'pending' } });
    const sessionId = h.row(ws).subscription.stripe.checkoutSessionId;
    // the fake keeps sessions open: wrap the client so the stored session reads as expired
    const expiredStripe = { ...h.stripe, checkout: { sessions: { retrieve: async (id) => ({ ...h.stripe.getSession(id), status: 'expired' }) } } };
    const out = await billing.refreshBilling({ workspaceId: ws }, { ...h.deps, stripe: expiredStripe });
    expect(out).toMatchObject({ changed: true, subscription: { state: 'none' } });
    expect(h.row(ws).subscription.stripe.checkoutSessionId).toBeUndefined();
    expect(h.row(ws).subscription.stripe.checkoutStartedAt).toBeUndefined();
  });

  test('a session that is not ours (another workspace reference) is never applied', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'pending', stripe: { checkoutSessionId: 'cs_foreign', checkoutStartedAt: new Date(0) } });
    const stripe = { checkout: { sessions: { retrieve: async () => makeCheckoutSession({ id: 'cs_foreign', clientReferenceId: newId(), metadata: h.metaFor(newId()), subscription: 'sub_x' }) } }, subscriptions: { retrieve: async () => { throw new Error('must not be called'); } } };
    const out = await billing.refreshBilling({ workspaceId: ws }, { ...h.deps, stripe });
    expect(out.changed).toBe(false);
    expect(h.row(ws).subscription.state).toBe('pending');
  });

  test('honours ONBOARDING_BILLING_RECONCILE_ON_DEMAND=off (no Stripe call)', async () => {
    process.env.ONBOARDING_BILLING_RECONCILE_ON_DEMAND = 'off';
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'pending', stripe: { subscriptionId: 'sub_1', status: 'incomplete' } });
    h.stripe.setSubscription(makeSubscription({ id: 'sub_1', status: 'active' }));
    const out = await billing.refreshBilling({ workspaceId: ws }, h.deps);
    expect(out).toMatchObject({ changed: false, subscription: { state: 'pending' } });
    expect(h.stripe.calls).toHaveLength(0);
  });

  test('Stripe failures surface as STRIPE_ERROR (retryable) and change nothing', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'pending', stripe: { subscriptionId: 'sub_1', status: 'incomplete' } });
    h.stripe.failNext('subscriptions.retrieve', { type: 'StripeConnectionError' });
    await expect(billing.refreshBilling({ workspaceId: ws }, h.deps)).rejects.toMatchObject({ code: 'STRIPE_ERROR', status: 503, retryable: true });
    await expect(billing.refreshBilling({ workspaceId: ws }, h.deps)).rejects.toMatchObject({ code: 'STRIPE_ERROR' }); // sub_1 unknown to the fake: 404
    expect(h.row(ws).subscription.state).toBe('pending');
  });

  test('not enrolled -> ONBOARDING_NOT_AVAILABLE', async () => {
    const h = makeHarness();
    await expect(billing.refreshBilling({ workspaceId: newId() }, h.deps)).rejects.toMatchObject({ code: 'ONBOARDING_NOT_AVAILABLE' });
  });
});

describe('reconcileSweep', () => {
  function world(h) {
    const ago = (ms) => new Date(h.clock.ms() - ms);
    const mk = (name, sub, extra) => ({ name, ws: h.seedWorkspace(sub, extra) });
    const rows = [
      mk('pendingOld', { state: 'pending', stripe: { checkoutSessionId: 'cs_old', checkoutStartedAt: ago(31 * MIN) } }),
      mk('pendingYoung', { state: 'pending', stripe: { checkoutSessionId: 'cs_young', checkoutStartedAt: ago(5 * MIN) } }),
      mk('pendingSubOld', { state: 'pending', stripe: { subscriptionId: 'sub_p', status: 'incomplete', lastSyncedAt: ago(40 * MIN) } }),
      mk('activeDaily', { state: 'active', source: 'stripe', stripe: { subscriptionId: 'sub_a', status: 'active', lastSyncedAt: ago(25 * 60 * MIN) } }),
      mk('activeFresh', { state: 'active', source: 'stripe', stripe: { subscriptionId: 'sub_f', status: 'active', lastSyncedAt: ago(60 * MIN) } }),
      mk('pastDueDaily', { state: 'past_due', stripe: { subscriptionId: 'sub_d', status: 'past_due', lastSyncedAt: ago(30 * 60 * MIN) } }),
      mk('adminOnly', { state: 'active', source: 'admin', admin: { active: true } }),
      mk('none', { state: 'none' }),
      mk('cancelled', { state: 'cancelled', stripe: { subscriptionId: 'sub_c', status: 'canceled', lastSyncedAt: ago(90 * 60 * MIN) } }),
      mk('unenrolled', { state: 'active', source: 'stripe', stripe: { subscriptionId: 'sub_u', status: 'active', lastSyncedAt: ago(90 * 60 * MIN) } }, { enrolled: false }),
    ];
    for (const id of ['sub_p', 'sub_a', 'sub_f', 'sub_d']) h.stripe.setSubscription(makeSubscription({ id, status: id === 'sub_p' ? 'active' : 'active' }));
    h.stripe.setSubscription(makeSubscription({ id: 'sub_d', status: 'past_due' }));
    h.stripe.setSubscription(makeSubscription({ id: 'sub_u', status: 'canceled' }));
    return Object.fromEntries(rows.map((r) => [r.name, r.ws]));
  }

  test('checks pending > 30 min and past_due/active once a day, nothing else', async () => {
    const h = makeHarness();
    const w = world(h);
    const out = await billing.reconcileSweep({}, h.deps);
    const retrieved = h.stripe.callsTo('subscriptions.retrieve').map((c) => c.args.id).sort();
    expect(retrieved).toEqual(['sub_a', 'sub_d', 'sub_p']);
    expect(h.stripe.callsTo('checkout.sessions.retrieve').map((c) => c.args.id)).toEqual(['cs_old']);
    expect(out.checked).toBe(4);
    expect(h.row(w.pendingSubOld).subscription.state).toBe('active'); // incomplete -> active
    expect(out.changed).toBe(1);
    expect(h.row(w.activeDaily).subscription.stripe.lastSyncedAt).toEqual(h.clock.now());
    expect(h.row(w.activeFresh).subscription.stripe.lastSyncedAt).not.toEqual(h.clock.now());
    expect(h.row(w.unenrolled).subscription.state).toBe('active');
  });

  test('a second sweep right after finds nothing due for the long-lived ones (lastSyncedAt rotation)', async () => {
    const h = makeHarness();
    world(h);
    await billing.reconcileSweep({}, h.deps);
    const n = h.stripe.calls.length;
    await billing.reconcileSweep({}, h.deps);
    // only the pending-without-sync row (its session unknown to the fake) is retried: failures do not stamp lastSyncedAt
    expect(h.stripe.calls.length - n).toBeLessThanOrEqual(1);
  });

  test('bounded by limit', async () => {
    const h = makeHarness();
    world(h);
    const out = await billing.reconcileSweep({ limit: 2 }, h.deps);
    expect(out.checked).toBe(2);
    expect(h.stripe.calls.length).toBeLessThanOrEqual(2);
  });

  test('an expired abandoned checkout is reset to none by the sweep', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'pending', stripe: { checkoutSessionId: 'cs_exp', checkoutStartedAt: new Date(h.clock.ms() - 31 * MIN) } });
    const stripe = { ...h.stripe, checkout: { sessions: { retrieve: async () => makeCheckoutSession({ id: 'cs_exp', status: 'expired', clientReferenceId: ws, metadata: h.metaFor(ws), subscription: null, customer: null }) } } };
    const out = await billing.reconcileSweep({}, { ...h.deps, stripe });
    expect(out).toEqual({ checked: 1, changed: 1 });
    expect(h.row(ws).subscription.state).toBe('none');
  });

  test('never throws: DB failure, Stripe failure, bad input', async () => {
    const h = makeHarness();
    world(h);
    h.stripe.failNext('subscriptions.retrieve', { type: 'StripeConnectionError' }, { times: 10 });
    await expect(billing.reconcileSweep({}, h.deps)).resolves.toEqual(expect.objectContaining({ checked: expect.any(Number) }));
    h.OnboardingState.failWith = new Error('db down');
    await expect(billing.reconcileSweep({}, h.deps)).resolves.toEqual({ checked: 0, changed: 0 });
    await expect(billing.reconcileSweep(null, h.deps)).resolves.toBeDefined();
    await expect(billing.reconcileSweep({ now: 'garbage', limit: 'x' }, h.deps)).resolves.toBeDefined();
  });

  test('flag off or no Stripe key: does nothing', async () => {
    const h = makeHarness();
    world(h);
    delete process.env.ONBOARDING_FLOW;
    expect(await billing.reconcileSweep({}, h.deps)).toEqual({ checked: 0, changed: 0 });
    process.env.ONBOARDING_FLOW = 'on';
    const { stripe, ...noStripe } = h.deps; // eslint-disable-line no-unused-vars
    expect(await billing.reconcileSweep({}, noStripe)).toEqual({ checked: 0, changed: 0 });
    expect(h.stripe.calls).toHaveLength(0);
  });
});

// ───────────────────────────── the router ─────────────────────────────
describe('routes/onboarding/billing.js', () => {
  function buildApp(h, { gateState = { enrolled: true, sub: { state: 'none' } }, role = 'owner', billingDeps } = {}) {
    const clock = h.clock;
    const limiter = createLimiter({ now: () => clock.ms() });
    const Membership = { findOne: (q) => ({ select: () => ({ lean: async () => (role ? { role } : null), q }) }) };
    const router = createRouter({
      billingDeps: billingDeps || h.deps,
      gateDeps: { getGateState: async () => gateState, Membership },
      rateLimitDeps: { limiter },
    });
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = JSON.parse(req.headers['x-test-user'] || '{}'); next(); });
    app.use('/api/onboarding', router);
    return { app, limiter };
  }
  const as = (ws, id = newId(), role = 'owner') => ({ 'x-test-user': JSON.stringify({ id, workspaceId: ws, role }) });

  test('exports a router and createRouter', () => {
    const mod = require('../../../routes/onboarding/billing');
    expect(typeof mod.createRouter).toBe('function');
    expect(typeof mod).toBe('function');
  });

  test('POST /checkout (owner, gate E): {url}; the workspace comes from the token, plan and price from the server', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    const other = h.seedWorkspace();
    const { app } = buildApp(h);
    const res = await request(app).post('/api/onboarding/checkout').set(as(ws)).send({ planCode: 'standard', workspaceId: other, priceId: 'price_attacker', line_items: [{ price: 'price_attacker' }] });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['url']);
    expect(res.body.url).toMatch(/^https:\/\//);
    expect(createdParams(h).client_reference_id).toBe(ws);
    expect(createdParams(h).line_items).toEqual([{ price: 'price_env_standard', quantity: 1 }]);
    expect(h.row(other).subscription.state).toBe('none');
  });

  test('POST /checkout: member 403 OWNER_ONLY, not enrolled 404, unknown plan 422, unconfigured 503, duplicate 409 with the existing state', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    const member = buildApp(h, { role: 'member' }).app;
    const r1 = await request(member).post('/api/onboarding/checkout').set(as(ws)).send({ planCode: 'standard' });
    expect([r1.status, r1.body.code]).toEqual([403, 'OWNER_ONLY']);

    const legacy = buildApp(h, { gateState: { enrolled: false } }).app;
    const r2 = await request(legacy).post('/api/onboarding/checkout').set(as(ws)).send({ planCode: 'standard' });
    expect([r2.status, r2.body.code]).toEqual([404, 'ONBOARDING_NOT_AVAILABLE']);

    const { app } = buildApp(h);
    const r3 = await request(app).post('/api/onboarding/checkout').set(as(ws)).send({ planCode: 'nope' });
    expect([r3.status, r3.body.code]).toEqual([422, 'PLAN_UNKNOWN']);
    const r3b = await request(app).post('/api/onboarding/checkout').set(as(ws)).send({});
    expect([r3b.status, r3b.body.code]).toEqual([422, 'PLAN_UNKNOWN']);

    delete process.env.ONBOARDING_CHECKOUT;
    const r4 = await request(app).post('/api/onboarding/checkout').set(as(ws)).send({ planCode: 'standard' });
    expect([r4.status, r4.body.code, r4.body.nextStep]).toEqual([503, 'CHECKOUT_NOT_CONFIGURED', 'billing']);
    process.env.ONBOARDING_CHECKOUT = 'on';

    const active = h.seedWorkspace({ state: 'active', source: 'stripe', stripe: { subscriptionId: 'sub_1', status: 'active' } });
    const r5 = await request(app).post('/api/onboarding/checkout').set(as(active)).send({ planCode: 'standard' });
    expect(r5.status).toBe(409);
    expect(r5.body).toEqual({ error: 'You already have a subscription.', code: 'SUBSCRIPTION_EXISTS', nextStep: 'billing', retryable: false, subscription: { state: 'active', source: 'stripe', retry: { checkout: false, billingPortal: false, reconnect: false } } });
    expect(h.stripe.callsTo('checkout.sessions.create')).toHaveLength(0);
  });

  test('POST /checkout is rate limited to 10 per hour per workspace', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    const other = h.seedWorkspace();
    const { app } = buildApp(h);
    for (let i = 0; i < 10; i += 1) {
      const r = await request(app).post('/api/onboarding/checkout').set(as(ws)).send({ planCode: 'nope' });
      expect(r.status).toBe(422);
    }
    const blocked = await request(app).post('/api/onboarding/checkout').set(as(ws)).send({ planCode: 'standard' });
    expect([blocked.status, blocked.body.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await request(app).post('/api/onboarding/checkout').set(as(other)).send({ planCode: 'standard' })).status).toBe(200);
    h.clock.advance(61 * MIN);
    expect((await request(app).post('/api/onboarding/checkout').set(as(ws)).send({ planCode: 'standard' })).status).toBe(200);
  });

  test('POST /billing-portal: {url}; owner only; 503 when unavailable', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'past_due', stripe: { customerId: 'cus_5', subscriptionId: 'sub_1', status: 'past_due' } });
    const { app } = buildApp(h, { gateState: { enrolled: true, sub: { state: 'past_due' } } });
    const ok = await request(app).post('/api/onboarding/billing-portal').set(as(ws)).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    const member = buildApp(h, { role: 'member', gateState: { enrolled: true, sub: { state: 'past_due' } } }).app;
    expect((await request(member).post('/api/onboarding/billing-portal').set(as(ws)).send({})).body.code).toBe('OWNER_ONLY');
    const none = h.seedWorkspace();
    const r = await request(app).post('/api/onboarding/billing-portal').set(as(none)).send({});
    expect([r.status, r.body.code]).toEqual([503, 'BILLING_PORTAL_UNAVAILABLE']);
  });

  test('POST /billing/refresh: {changed, subscription}; rate limit 1 per 15 s (429 + Retry-After), then allowed again', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'pending', stripe: { subscriptionId: 'sub_1', customerId: 'cus_1', status: 'incomplete' } });
    h.stripe.setSubscription(makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'active' }));
    const { app } = buildApp(h, { gateState: { enrolled: true, sub: { state: 'pending' } }, role: 'member' }); // gate E: any member, any state
    const first = await request(app).post('/api/onboarding/billing/refresh').set(as(ws)).send({});
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ changed: true, subscription: { state: 'active', source: 'stripe', retry: { checkout: false, billingPortal: false, reconnect: false } } });
    const second = await request(app).post('/api/onboarding/billing/refresh').set(as(ws)).send({});
    expect([second.status, second.body.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    expect(h.stripe.callsTo('subscriptions.retrieve')).toHaveLength(1);
    h.clock.advance(16 * 1000);
    const third = await request(app).post('/api/onboarding/billing/refresh').set(as(ws)).send({});
    expect(third.status).toBe(200);
    expect(third.body.changed).toBe(false);
  });

  test('POST /billing/refresh: not enrolled 404; Stripe outage 503 STRIPE_ERROR; reconcile off is a harmless 200', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'pending', stripe: { subscriptionId: 'sub_1', status: 'incomplete' } });
    const legacy = buildApp(h, { gateState: { enrolled: false } }).app;
    expect((await request(legacy).post('/api/onboarding/billing/refresh').set(as(ws)).send({})).status).toBe(404);
    const { app } = buildApp(h, { gateState: { enrolled: true, sub: { state: 'pending' } } });
    h.stripe.failNext('subscriptions.retrieve', { type: 'StripeConnectionError' });
    const down = await request(app).post('/api/onboarding/billing/refresh').set(as(ws)).send({});
    expect([down.status, down.body.code, down.body.retryable]).toEqual([503, 'STRIPE_ERROR', true]);
    process.env.ONBOARDING_BILLING_RECONCILE_ON_DEMAND = 'off';
    h.clock.advance(20 * 1000);
    const off = await request(app).post('/api/onboarding/billing/refresh').set(as(ws)).send({});
    expect([off.status, off.body.changed, off.body.subscription.state]).toEqual([200, false, 'pending']);
  });

  test('error bodies never leak Stripe messages', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    h.stripe.failNext('checkout.sessions.create', { type: 'StripeAPIError', message: 'acct_secret customer owner@example.test' });
    const { app } = buildApp(h);
    const res = await request(app).post('/api/onboarding/checkout').set(as(ws)).send({ planCode: 'standard' });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/acct_secret|owner@example/);
  });
});
