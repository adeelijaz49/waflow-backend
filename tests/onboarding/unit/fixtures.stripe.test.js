'use strict';
// Unit tests for tests/onboarding/_fixtures/fakeStripe.js. Pure, no DB, no network.

const Stripe = require('stripe');
const { createFakeStripe, signedEvent, makeSubscription, makeInvoice, makeCheckoutSession, makeEvent, TEST_WEBHOOK_SECRET } = require('../_fixtures');

// An independent real Stripe instance, only for its offline webhook verification.
const verifier = new Stripe('sk_test_verifier_dummy', { host: 'localhost.invalid', maxNetworkRetries: 0 });

describe('fakeStripe: client surface', () => {
  test('exposes exactly the methods the onboarding code is allowed to call', () => {
    const s = createFakeStripe();
    expect(typeof s.checkout.sessions.create).toBe('function');
    expect(typeof s.checkout.sessions.retrieve).toBe('function');
    expect(typeof s.subscriptions.retrieve).toBe('function');
    expect(typeof s.billingPortal.sessions.create).toBe('function');
    expect(typeof s.webhooks.constructEvent).toBe('function');
    expect(Object.keys(s.checkout.sessions).sort()).toEqual(['create', 'retrieve']);
    expect(Object.keys(s.subscriptions)).toEqual(['retrieve']);
  });

  test('checkout.sessions.create is recorded, returns a Stripe-hosted https url and stores the session', async () => {
    const s = createFakeStripe();
    const params = { mode: 'subscription', line_items: [{ price: 'price_1', quantity: 1 }], client_reference_id: 'ws1', metadata: { workspaceId: 'ws1', waflow_purpose: 'merchant_subscription' }, subscription_data: { metadata: { workspaceId: 'ws1' } }, success_url: 'https://app.example.test/setup?checkout=return', cancel_url: 'https://app.example.test/setup?checkout=cancel', customer_email: 'o@example.test', payment_method_collection: 'always' };
    const sess = await s.checkout.sessions.create(params);
    expect(sess.object).toBe('checkout.session');
    expect(new URL(sess.url).protocol).toBe('https:');
    expect(new URL(sess.url).hostname).toMatch(/stripe\.com$/);
    expect(sess).toMatchObject({ status: 'open', payment_status: 'unpaid', client_reference_id: 'ws1', mode: 'subscription', subscription: null });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ method: 'checkout.sessions.create', args: { params: { client_reference_id: 'ws1' } } });
    expect(await s.checkout.sessions.retrieve(sess.id)).toMatchObject({ id: sess.id, status: 'open' });
  });

  test('create validates required params and client_reference_id length with real Stripe error classes', async () => {
    const s = createFakeStripe();
    await expect(s.checkout.sessions.create({ mode: 'subscription' })).rejects.toBeInstanceOf(Stripe.errors.StripeInvalidRequestError);
    await expect(s.checkout.sessions.create({ mode: 'subscription', success_url: 'https://x.test', line_items: [] })).rejects.toMatchObject({ code: 'parameter_missing' });
    await expect(s.checkout.sessions.create({ mode: 'subscription', success_url: 'https://x.test', line_items: [{ price: 'p', quantity: 1 }], client_reference_id: 'x'.repeat(201) })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('retrieve of an unknown id is resource_missing / 404', async () => {
    const s = createFakeStripe();
    await expect(s.checkout.sessions.retrieve('cs_nope')).rejects.toMatchObject({ code: 'resource_missing', statusCode: 404 });
    await expect(s.subscriptions.retrieve('sub_nope')).rejects.toMatchObject({ code: 'resource_missing', statusCode: 404 });
  });

  test('completeCheckout flips the session, creates the subscription with the requested metadata', async () => {
    const s = createFakeStripe();
    const sess = await s.checkout.sessions.create({ mode: 'subscription', line_items: [{ price: 'price_1', quantity: 1 }], success_url: 'https://x.test', subscription_data: { metadata: { workspaceId: 'ws9', planCode: 'basic' } }, client_reference_id: 'ws9' });
    const done = s.completeCheckout(sess.id, { businessName: 'Acme Coffee', email: 'owner@acme.test' });
    expect(done.session).toMatchObject({ status: 'complete', payment_status: 'paid', subscription: done.subscription.id });
    expect(done.session.custom_fields[0].text.value).toBe('Acme Coffee');
    expect(done.subscription.metadata).toEqual({ workspaceId: 'ws9', planCode: 'basic' });
    expect(await s.subscriptions.retrieve(done.subscription.id)).toMatchObject({ status: 'active', customer: 'cus_fixture_1' });
    const stored = await s.checkout.sessions.retrieve(sess.id);
    expect(stored.customer_details.email).toBe('owner@acme.test');
  });

  test('subscriptions.retrieve serves seeded subscriptions in the configured shape', async () => {
    const s = createFakeStripe({ shape: 'basil' });
    const seeded = s.setSubscription({ id: 'sub_seed', status: 'past_due' });
    expect(seeded.current_period_end).toBeUndefined();
    expect((await s.subscriptions.retrieve('sub_seed', { expand: ['default_payment_method'] })).status).toBe('past_due');
    expect(s.callsTo('subscriptions.retrieve')[0].args.params).toEqual({ expand: ['default_payment_method'] });
  });

  test('billingPortal.sessions.create needs a customer, returns a Stripe-hosted https url', async () => {
    const s = createFakeStripe();
    await expect(s.billingPortal.sessions.create({ return_url: 'https://x.test' })).rejects.toMatchObject({ code: 'parameter_missing' });
    const p = await s.billingPortal.sessions.create({ customer: 'cus_1', return_url: 'https://app.example.test/setup' });
    expect(p).toMatchObject({ object: 'billing_portal.session', customer: 'cus_1', return_url: 'https://app.example.test/setup' });
    expect(new URL(p.url).hostname).toMatch(/stripe\.com$/);
  });

  test('failNext scripts failures by method with real Stripe error classes, once or n times', async () => {
    const s = createFakeStripe();
    s.failNext('checkout.sessions.create', { type: 'StripeConnectionError', message: 'socket hang up' });
    await expect(s.checkout.sessions.create({ mode: 'subscription', success_url: 'https://x.test', line_items: [{ price: 'p', quantity: 1 }] })).rejects.toBeInstanceOf(Stripe.errors.StripeConnectionError);
    await expect(s.checkout.sessions.create({ mode: 'subscription', success_url: 'https://x.test', line_items: [{ price: 'p', quantity: 1 }] })).resolves.toMatchObject({ status: 'open' });
    s.failNext('subscriptions.retrieve', { type: 'StripeRateLimitError', statusCode: 429 }, { times: 2 });
    await expect(s.subscriptions.retrieve('x')).rejects.toBeInstanceOf(Stripe.errors.StripeRateLimitError);
    await expect(s.subscriptions.retrieve('x')).rejects.toBeInstanceOf(Stripe.errors.StripeRateLimitError);
    await expect(s.subscriptions.retrieve('x')).rejects.toMatchObject({ code: 'resource_missing' });
    s.failNext('billingPortal.sessions.create', { type: 'StripeInvalidRequestError', message: 'No configuration provided', statusCode: 400 });
    await expect(s.billingPortal.sessions.create({ customer: 'c' })).rejects.toMatchObject({ message: 'No configuration provided' });
    const custom = Object.assign(new Error('custom'), { code: 'X' });
    s.failNext('checkout.sessions.retrieve', custom);
    await expect(s.checkout.sessions.retrieve('x')).rejects.toBe(custom);
  });

  test('reset clears calls, store and failures; calls keep their args as copies', async () => {
    const s = createFakeStripe();
    const params = { mode: 'subscription', success_url: 'https://x.test', line_items: [{ price: 'p', quantity: 1 }], metadata: { a: '1' } };
    const sess = await s.checkout.sessions.create(params);
    params.metadata.a = 'mutated';
    expect(s.calls[0].args.params.metadata.a).toBe('1');
    s.failNext('subscriptions.retrieve', {});
    s.reset();
    expect(s.calls).toHaveLength(0);
    await expect(s.checkout.sessions.retrieve(sess.id)).rejects.toMatchObject({ code: 'resource_missing' });
    await expect(s.subscriptions.retrieve('x')).rejects.toMatchObject({ code: 'resource_missing' }); // failure was cleared
  });

  test('never touches the network: https/http/net are not used by any fake method', async () => {
    const https = require('https');
    const http = require('http');
    const net = require('net');
    const boom = () => { throw new Error('NETWORK ACCESS ATTEMPTED'); };
    const spies = [jest.spyOn(https, 'request').mockImplementation(boom), jest.spyOn(http, 'request').mockImplementation(boom), jest.spyOn(net, 'connect').mockImplementation(boom)];
    try {
      const s = createFakeStripe();
      const sess = await s.checkout.sessions.create({ mode: 'subscription', success_url: 'https://x.test', line_items: [{ price: 'p', quantity: 1 }] });
      s.completeCheckout(sess.id);
      await s.billingPortal.sessions.create({ customer: 'c' });
      const e = s.signedEvent({ type: 'invoice.paid', object: makeInvoice() });
      s.webhooks.constructEvent(e.payload, e.header, e.secret);
      spies.forEach((sp) => expect(sp).not.toHaveBeenCalled());
    } finally {
      spies.forEach((sp) => sp.mockRestore());
    }
  });
});

describe('fakeStripe: signed webhook events round trip with the real stripe package', () => {
  test('signedEvent -> constructEvent returns the same event (string and Buffer bodies)', () => {
    const sub = makeSubscription({ id: 'sub_rt', status: 'active' });
    const signed = signedEvent({ type: 'customer.subscription.updated', object: sub, id: 'evt_roundtrip' });
    expect(signed.secret).toBe(TEST_WEBHOOK_SECRET);
    expect(signed.header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const ev1 = verifier.webhooks.constructEvent(signed.payload, signed.header, TEST_WEBHOOK_SECRET);
    expect(ev1.id).toBe('evt_roundtrip');
    expect(ev1.type).toBe('customer.subscription.updated');
    expect(ev1.data.object.id).toBe('sub_rt');
    const ev2 = verifier.webhooks.constructEvent(signed.body, signed.header, TEST_WEBHOOK_SECRET);
    expect(ev2).toEqual(ev1);
  });

  test('the fake client verifies its own deliveries with the real implementation', () => {
    const s = createFakeStripe({ webhookSecret: 'whsec_other_dummy_secret' });
    const d = s.signedEvent({ type: 'invoice.paid', object: makeInvoice({ id: 'in_x' }) });
    expect(s.webhooks.constructEvent(d.body, d.header, 'whsec_other_dummy_secret').data.object.id).toBe('in_x');
  });

  test('wrong secret, tampered payload, garbage header and stale timestamp are all rejected', () => {
    const signed = signedEvent({ type: 'invoice.paid', object: makeInvoice() });
    expect(() => verifier.webhooks.constructEvent(signed.payload, signed.header, 'whsec_wrong')).toThrow(Stripe.errors.StripeSignatureVerificationError);
    expect(() => verifier.webhooks.constructEvent(signed.payload.replace('invoice', 'invoicf'), signed.header, TEST_WEBHOOK_SECRET)).toThrow(/signature/i);
    expect(() => verifier.webhooks.constructEvent(signed.payload, 'garbage', TEST_WEBHOOK_SECRET)).toThrow();
    const stale = signedEvent({ type: 'invoice.paid', object: makeInvoice(), timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(() => verifier.webhooks.constructEvent(stale.payload, stale.header, TEST_WEBHOOK_SECRET)).toThrow(/tolerance/i);
    const ok = signedEvent({ type: 'invoice.paid', object: makeInvoice(), secret: 'whsec_custom_dummy' });
    expect(verifier.webhooks.constructEvent(ok.payload, ok.header, 'whsec_custom_dummy').type).toBe('invoice.paid');
  });

  test('default ids are unique, explicit id/created are honoured, makeEvent requires a type', () => {
    const a = makeEvent({ type: 'x.y', object: {} });
    const b = makeEvent({ type: 'x.y', object: {} });
    expect(a.id).not.toBe(b.id);
    const c = makeEvent({ type: 'x.y', object: { id: 'o' }, id: 'evt_fixed', created: 1700000000 });
    expect(c).toMatchObject({ id: 'evt_fixed', created: 1700000000, object: 'event', livemode: false, data: { object: { id: 'o' } } });
    expect(() => makeEvent({ object: {} })).toThrow(/type/);
  });
});

describe('fakeStripe: current and basil object shapes', () => {
  test('subscription CURRENT shape has the period on the subscription and not on items', () => {
    const sub = makeSubscription({ id: 'sub_c', currentPeriodStart: 1000, currentPeriodEnd: 2000 });
    expect(sub).toMatchObject({ object: 'subscription', id: 'sub_c', status: 'active', customer: 'cus_fixture_1', current_period_start: 1000, current_period_end: 2000, default_payment_method: 'pm_fixture_1' });
    expect(sub.items.data[0].current_period_end).toBeUndefined();
    expect(sub.items.data[0].price.id).toBe('price_fixture_1');
  });

  test('subscription BASIL shape moves the period onto the items and drops it from the subscription', () => {
    const sub = makeSubscription({ shape: 'basil', currentPeriodStart: 1000, currentPeriodEnd: 2000, items: [{ currentPeriodEnd: 3000 }] });
    expect(sub.current_period_end).toBeUndefined();
    expect(sub.current_period_start).toBeUndefined();
    expect(sub.items.data[0]).toMatchObject({ current_period_start: 1000, current_period_end: 3000 });
  });

  test('subscription options: status, metadata, no payment method, trial, cancel flags', () => {
    const sub = makeSubscription({ status: 'trialing', metadata: { workspaceId: 'w1' }, defaultPaymentMethod: null, trialEnd: 5, cancelAtPeriodEnd: true, latestInvoice: 'in_1', extra: { foo: 'bar' } });
    expect(sub).toMatchObject({ status: 'trialing', metadata: { workspaceId: 'w1' }, default_payment_method: null, trial_end: 5, cancel_at_period_end: true, latest_invoice: 'in_1', foo: 'bar' });
  });

  test('invoice CURRENT links by invoice.subscription; BASIL by parent.subscription_details.subscription', () => {
    const cur = makeInvoice({ subscription: 'sub_1', status: 'paid' });
    expect(cur.subscription).toBe('sub_1');
    expect(cur.parent).toBeUndefined();
    expect(cur).toMatchObject({ object: 'invoice', status: 'paid', paid: true, amount_paid: 10000 });
    const bas = makeInvoice({ shape: 'basil', subscription: 'sub_2', status: 'open', metadata: { workspaceId: 'w' } });
    expect(bas.subscription).toBeUndefined();
    expect(bas.parent).toEqual({ type: 'subscription_details', quote_details: null, subscription_details: { subscription: 'sub_2', metadata: { workspaceId: 'w' } } });
    expect(bas).toMatchObject({ status: 'open', amount_paid: 0 });
  });

  test('checkout session builder: completed paid by default, open/unpaid variant, business name paths', () => {
    const done = makeCheckoutSession({ clientReferenceId: 'ws1', metadata: { planCode: 'p' }, businessName: 'Acme' });
    expect(done).toMatchObject({ object: 'checkout.session', status: 'complete', payment_status: 'paid', client_reference_id: 'ws1', customer: 'cus_fixture_1', subscription: 'sub_fixture_1' });
    expect(done.custom_fields[0]).toMatchObject({ key: 'business_name', text: { value: 'Acme' } });
    expect(done.customer_details.email).toBe('owner@example.test');
    const open = makeCheckoutSession({ status: 'open' });
    expect(open).toMatchObject({ payment_status: 'unpaid', customer: null, subscription: null });
    const cd = makeCheckoutSession({ businessName: 'Acme', businessNameVia: 'customer_details' });
    expect(cd.customer_details.business_name).toBe('Acme');
    expect(cd.custom_fields).toEqual([]);
    expect(makeCheckoutSession({ email: null }).customer_details).toBeNull();
  });

  test('builders return independent objects (no shared mutable state)', () => {
    const a = makeSubscription({ metadata: { k: 'v' } });
    const b = makeSubscription({ metadata: { k: 'v' } });
    a.metadata.k = 'changed';
    expect(b.metadata.k).toBe('v');
    expect(a.id).not.toBe(b.id);
  });

  test('the fake client builders default to its configured shape', () => {
    const s = createFakeStripe({ shape: 'basil' });
    expect(s.makeSubscription({}).current_period_end).toBeUndefined();
    expect(s.makeInvoice({}).subscription).toBeUndefined();
    expect(createFakeStripe().makeInvoice({}).subscription).toBe('sub_fixture_1');
  });
});
