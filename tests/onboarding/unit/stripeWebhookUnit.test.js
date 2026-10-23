'use strict';
// stripeWebhook.processEvent / createHandler against in-memory models (B0's fake store), the REAL state.js
// recomputeSubscription and subscription.js, and fakeStripe. No network, no DB.
const webhook = require('../../../shared/onboarding/stripeWebhook');
const { makeHarness } = require('./_stripeHarness');
const { TEST_WEBHOOK_SECRET, makeSubscription, makeInvoice, makeCheckoutSession, makeEvent, signedEvent } = require('../_fixtures');

const ENV = ['ONBOARDING_FLOW', 'ONBOARDING_ACCEPT_TRIALING', 'ONBOARDING_STRIPE_PRICES'];
const saved = {};
beforeEach(() => {
  ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  process.env.ONBOARDING_FLOW = 'on';
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); jest.restoreAllMocks(); });

let seq = 0;
const evid = () => `evt_unit_${++seq}`;
const ev = (type, object, extra = {}) => makeEvent({ type, object, id: evid(), ...extra });

function liveWorkspace(h, over = {}) {
  const ws = h.seedWorkspace({
    state: 'active', source: 'stripe',
    stripe: { subscriptionId: 'sub_1', customerId: 'cus_1', status: 'active', hasDefaultPaymentMethod: true },
    ...over,
  });
  return ws;
}
const sub = (h, ws, o = {}) => h.stripe.setSubscription(makeSubscription({ shape: h.shape, id: 'sub_1', customer: 'cus_1', metadata: h.metaFor(ws), ...o }));

describe('claim and idempotency', () => {
  test('a duplicate delivery is processed once', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    sub(h, ws, { status: 'past_due' });
    const e = ev('customer.subscription.updated', makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'past_due', metadata: h.metaFor(ws) }));
    expect((await webhook.processEvent(e, h.deps)).outcome).toBe('processed');
    expect((await webhook.processEvent(e, h.deps)).outcome).toBe('duplicate');
    expect(h.stripe.callsTo('subscriptions.retrieve')).toHaveLength(1);
    expect(h.inbound(e.id)).toMatchObject({ status: 'done', attempts: 1, source: 'stripe', type: 'customer.subscription.updated' });
    expect(String(h.inbound(e.id).workspaceId)).toBe(String(ws));
  });

  test('a failed row is re-claimed and reprocessed', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    sub(h, ws, { status: 'past_due' });
    h.stripe.failNext('subscriptions.retrieve', { type: 'StripeConnectionError' }, { times: 1 });
    const e = ev('invoice.paid', makeInvoice({ subscription: 'sub_1', customer: 'cus_1' }));
    await expect(webhook.processEvent(e, h.deps)).rejects.toBeTruthy();
    expect(h.inbound(e.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(h.inbound(e.id).errorCode).toMatch(/^[A-Za-z0-9_]+$/);
    const out = await webhook.processEvent(e, h.deps);
    expect(out.outcome).toBe('processed');
    expect(h.inbound(e.id)).toMatchObject({ status: 'done', attempts: 2 });
    expect(h.inbound(e.id).errorCode).toBeUndefined();
    expect(h.row(ws).subscription.state).toBe('past_due');
  });

  test('a processing row younger than 2 minutes is a concurrent delivery: nothing happens', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    sub(h, ws);
    const e = ev('invoice.paid', makeInvoice({ subscription: 'sub_1' }));
    h.OnboardingInbound.seed({ _id: `stripe:${e.id}`, source: 'stripe', status: 'processing', attempts: 1, startedAt: new Date(h.clock.ms() - 30 * 1000) });
    expect((await webhook.processEvent(e, h.deps)).outcome).toBe('in_progress');
    expect(h.stripe.callsTo('subscriptions.retrieve')).toHaveLength(0);
    expect(h.inbound(e.id).status).toBe('processing');
  });

  test('a stale processing row (older than 2 minutes) is re-claimed atomically', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    sub(h, ws, { status: 'past_due' });
    const e = ev('invoice.paid', makeInvoice({ subscription: 'sub_1' }));
    h.OnboardingInbound.seed({ _id: `stripe:${e.id}`, source: 'stripe', status: 'processing', attempts: 1, startedAt: new Date(h.clock.ms() - 3 * 60 * 1000) });
    expect((await webhook.processEvent(e, h.deps)).outcome).toBe('processed');
    expect(h.inbound(e.id)).toMatchObject({ status: 'done', attempts: 2 });
  });

  test('two simultaneous deliveries of one event: exactly one does the work', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    sub(h, ws, { status: 'past_due' });
    const e = ev('invoice.paid', makeInvoice({ subscription: 'sub_1' }));
    const [a, b] = await Promise.all([webhook.processEvent(e, h.deps), webhook.processEvent(e, h.deps)]);
    expect([a.outcome, b.outcome].sort()).toEqual(['in_progress', 'processed']);
    expect(h.stripe.callsTo('subscriptions.retrieve')).toHaveLength(1);
  });

  test('ignored / unmatched rows are final: a redelivery is a duplicate', async () => {
    const h = makeHarness();
    const e1 = ev('customer.created', { id: 'cus_9' });
    expect((await webhook.processEvent(e1, h.deps)).outcome).toBe('ignored');
    expect((await webhook.processEvent(e1, h.deps)).outcome).toBe('duplicate');
    expect(h.inbound(e1.id).status).toBe('ignored');
  });

  test('event types outside the allow-list are ignored without any Stripe call (payment_intent is never handled)', async () => {
    const h = makeHarness();
    for (const type of ['payment_intent.succeeded', 'payment_intent.payment_failed', 'charge.refunded', 'customer.updated']) {
      const e = ev(type, { id: 'x' });
      expect((await webhook.processEvent(e, h.deps)).outcome).toBe('ignored');
    }
    expect(h.stripe.calls).toHaveLength(0);
    expect(webhook.EVENT_TYPES).toEqual(expect.not.arrayContaining(['payment_intent.succeeded']));
  });

  test('a malformed event is ignored and leaves no row', async () => {
    const h = makeHarness();
    expect((await webhook.processEvent(null, h.deps)).outcome).toBe('ignored');
    expect((await webhook.processEvent({ type: 'invoice.paid' }, h.deps)).outcome).toBe('ignored');
    expect(h.OnboardingInbound.rows).toHaveLength(0);
  });
});

describe('workspace resolution (never by e-mail)', () => {
  test('checkout without our metadata, or not a subscription session: ignored_not_ours', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    const plain = ev('checkout.session.completed', makeCheckoutSession({ clientReferenceId: ws, metadata: {} }));
    expect((await webhook.processEvent(plain, h.deps)).outcome).toBe('ignored_not_ours');
    const shop = ev('checkout.session.completed', makeCheckoutSession({ mode: 'payment', clientReferenceId: ws, metadata: h.metaFor(ws) }));
    expect((await webhook.processEvent(shop, h.deps)).outcome).toBe('ignored_not_ours');
    expect(h.inbound(plain.id).status).toBe('ignored');
    expect(h.row(ws).subscription.state).toBe('none');
    expect(h.stripe.calls).toHaveLength(0);
  });

  test('our checkout with an invalid, unknown or contradicting workspace: unmatched, no state change', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    const unknownId = 'abcdefabcdefabcdefabcdef';
    for (const ref of ['not-an-object-id', unknownId, '']) {
      const e = ev('checkout.session.completed', makeCheckoutSession({ clientReferenceId: ref, metadata: h.metaFor(ref) }));
      expect((await webhook.processEvent(e, h.deps)).outcome).toBe('unmatched');
      expect(h.inbound(e.id).status).toBe('unmatched');
    }
    const mismatch = ev('checkout.session.completed', makeCheckoutSession({ clientReferenceId: ws, metadata: h.metaFor(unknownId) }));
    expect((await webhook.processEvent(mismatch, h.deps)).outcome).toBe('unmatched');
    expect(h.row(ws).subscription.state).toBe('none');
    expect(h.stripe.calls).toHaveLength(0);
  });

  test('NO e-mail matching: the same e-mail without a workspace reference matches nothing', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({}, { prefill: { email: 'owner@example.test' } });
    const e = ev('checkout.session.completed', makeCheckoutSession({ clientReferenceId: null, email: 'owner@example.test', metadata: { waflow_purpose: 'merchant_subscription' } }));
    expect((await webhook.processEvent(e, h.deps)).outcome).toBe('unmatched');
    expect(h.row(ws).subscription.state).toBe('none');
    const s = ev('customer.subscription.created', makeSubscription({ id: 'sub_mail', customer: 'cus_mail', metadata: {} }));
    expect((await webhook.processEvent(s, h.deps)).outcome).toBe('ignored_not_ours');
  });

  test('subscription events: by metadata, else by stored subscription id, else by stored customer id', async () => {
    const h = makeHarness();
    const wsMeta = h.seedWorkspace();
    const wsSub = h.seedWorkspace({ stripe: { subscriptionId: 'sub_known', status: 'active' }, state: 'active', source: 'stripe' });
    const wsCus = h.seedWorkspace({ stripe: { customerId: 'cus_known', status: 'active' }, state: 'active', source: 'stripe' });
    const mk = (id, customer, metadata) => makeSubscription({ id, customer, status: 'active', metadata });
    h.stripe.setSubscription(mk('sub_m', 'cus_m', h.metaFor(wsMeta)));
    h.stripe.setSubscription(mk('sub_known', 'cus_x', {}));
    h.stripe.setSubscription(mk('sub_c', 'cus_known', {}));
    await webhook.processEvent(ev('customer.subscription.created', mk('sub_m', 'cus_m', h.metaFor(wsMeta))), h.deps);
    await webhook.processEvent(ev('customer.subscription.updated', mk('sub_known', 'cus_x', {})), h.deps);
    await webhook.processEvent(ev('customer.subscription.updated', mk('sub_c', 'cus_known', {})), h.deps);
    expect(h.row(wsMeta).subscription).toMatchObject({ state: 'active', stripe: { subscriptionId: 'sub_m' } });
    expect(h.row(wsSub).subscription.stripe.lastSyncedAt).toBeTruthy();
    expect(h.row(wsCus).subscription.stripe.lastSyncedAt).toBeTruthy();
  });

  test('a subscription with our metadata but no sidecar is unmatched; one without our metadata is ignored_not_ours', async () => {
    const h = makeHarness();
    const e1 = ev('customer.subscription.updated', makeSubscription({ id: 'sub_a', metadata: h.metaFor('abcdefabcdefabcdefabcdef') }));
    expect((await webhook.processEvent(e1, h.deps)).outcome).toBe('unmatched');
    const e2 = ev('customer.subscription.updated', makeSubscription({ id: 'sub_b', metadata: {} }));
    expect((await webhook.processEvent(e2, h.deps)).outcome).toBe('ignored_not_ours');
  });

  test.each(['current', 'basil'])('invoice events resolve through the subscription id (%s shape)', async (shape) => {
    const h = makeHarness({ shape });
    const ws = liveWorkspace(h);
    sub(h, ws, { shape, status: 'active' });
    const e = ev('invoice.paid', makeInvoice({ shape, subscription: 'sub_1', customer: 'cus_zzz' }));
    const out = await webhook.processEvent(e, h.deps);
    expect(out.outcome).toBe('processed');
    expect(String(h.inbound(e.id).workspaceId)).toBe(String(ws));
  });

  test('an invoice before any checkout/subscription event: Stripe is asked who the subscription belongs to', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ stripe: { checkoutStartedAt: new Date(h.clock.ms()) } });
    h.stripe.setSubscription(makeSubscription({ id: 'sub_early', customer: 'cus_early', status: 'active', metadata: h.metaFor(ws) }));
    const e = ev('invoice.paid', makeInvoice({ subscription: 'sub_early', customer: 'cus_early' }));
    expect((await webhook.processEvent(e, h.deps)).outcome).toBe('processed');
    expect(h.row(ws).subscription).toMatchObject({ state: 'active', source: 'stripe', stripe: { subscriptionId: 'sub_early', customerId: 'cus_early', status: 'active' } });
    expect(h.stripe.callsTo('subscriptions.retrieve')).toHaveLength(1); // the prefetched object is reused
  });

  test('an invoice of someone else\'s subscription, a one-off invoice: ignored_not_ours', async () => {
    const h = makeHarness();
    h.seedWorkspace();
    h.stripe.setSubscription(makeSubscription({ id: 'sub_other', customer: 'cus_other', metadata: {} }));
    const other = ev('invoice.paid', makeInvoice({ subscription: 'sub_other', customer: 'cus_other' }));
    expect((await webhook.processEvent(other, h.deps)).outcome).toBe('ignored_not_ours');
    const oneOff = ev('invoice.paid', makeInvoice({ subscription: null }));
    expect((await webhook.processEvent(oneOff, h.deps)).outcome).toBe('ignored_not_ours');
  });
});

describe('canonical state and convergence', () => {
  test('checkout.session.completed (paid): prefill, ids, plan and period are stored and the state turns active', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ stripe: { checkoutSessionId: 'cs_1', checkoutStartedAt: new Date(h.clock.ms()) }, state: 'pending' });
    process.env.ONBOARDING_STRIPE_PRICES = JSON.stringify({ standard: 'price_fixture_1' });
    h.stripe.setSubscription(makeSubscription({ id: 'sub_n', customer: 'cus_n', status: 'active', metadata: h.metaFor(ws), currentPeriodEnd: 1_800_000_000 }));
    const session = makeCheckoutSession({ id: 'cs_1', clientReferenceId: ws, metadata: h.metaFor(ws), customer: 'cus_n', subscription: 'sub_n', email: 'owner@example.test', businessName: 'Acme Sweets' });
    const out = await webhook.processEvent(ev('checkout.session.completed', session), h.deps);
    expect(out).toMatchObject({ outcome: 'processed', changed: true, state: 'active' });
    const s = h.row(ws).subscription;
    expect(s).toMatchObject({ state: 'active', source: 'stripe' });
    expect(s.stripe).toMatchObject({ customerId: 'cus_n', subscriptionId: 'sub_n', status: 'active', planCode: 'standard', priceId: 'price_fixture_1', checkoutSessionId: 'cs_1', hasDefaultPaymentMethod: true });
    expect(s.stripe.currentPeriodEnd).toEqual(new Date(1_800_000_000 * 1000));
    expect(h.row(ws).prefill).toMatchObject({ email: 'owner@example.test', businessName: 'Acme Sweets', planCode: 'standard', source: 'stripe_checkout' });
    expect(h.stripe.callsTo('subscriptions.retrieve')).toHaveLength(1);
    expect(h.notifications.map((n) => n.kind)).toEqual(['subscription_active']);
  });

  test('checkout.session.completed (unpaid / async): ids and prefill stored, no retrieve, the workspace stays pending', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace();
    const session = makeCheckoutSession({ id: 'cs_2', clientReferenceId: ws, metadata: h.metaFor(ws), status: 'complete', paymentStatus: 'unpaid', customer: 'cus_u', subscription: 'sub_u', email: 'late@example.test' });
    const out = await webhook.processEvent(ev('checkout.session.completed', session), h.deps);
    expect(out.outcome).toBe('processed');
    expect(h.stripe.callsTo('subscriptions.retrieve')).toHaveLength(0);
    const s = h.row(ws).subscription;
    expect(s.state).toBe('pending');
    expect(s.stripe).toMatchObject({ customerId: 'cus_u', checkoutSessionId: 'cs_2' });
    expect(s.stripe.subscriptionId).toBeUndefined();
    expect(h.row(ws).prefill.email).toBe('late@example.test');
  });

  test('a paid session whose retrieve fails answers a retry (throws) and does not touch the state', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'pending', stripe: { checkoutStartedAt: new Date(h.clock.ms()) } });
    const session = makeCheckoutSession({ id: 'cs_3', clientReferenceId: ws, metadata: h.metaFor(ws), subscription: 'sub_gone' });
    const e = ev('checkout.session.completed', session);
    await expect(webhook.processEvent(e, h.deps)).rejects.toBeTruthy();
    expect(h.row(ws).subscription.state).toBe('pending');
    expect(h.row(ws).subscription.stripe.subscriptionId).toBeUndefined();
    expect(h.inbound(e.id).status).toBe('failed');
  });

  test('the retrieved subscription wins over a contradicting payload (out-of-order delivery converges)', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    sub(h, ws, { status: 'active' });
    const stalePayload = ev('customer.subscription.updated', makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'past_due', metadata: h.metaFor(ws) }), { created: 100 });
    await webhook.processEvent(stalePayload, h.deps);
    expect(h.row(ws).subscription.state).toBe('active');
    // later Stripe cancels; an older "created" event arrives afterwards
    sub(h, ws, { status: 'canceled' });
    const older = ev('customer.subscription.created', makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'active', metadata: h.metaFor(ws) }), { created: 50 });
    await webhook.processEvent(older, h.deps);
    expect(h.row(ws).subscription.state).toBe('cancelled');
  });

  test('retrieve failure on customer.subscription.*: the payload is used; an OLDER payload-only event is then ignored', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h, { stripe: { subscriptionId: 'sub_1', customerId: 'cus_1', status: 'active', lastEventCreated: 100 } });
    const newer = ev('customer.subscription.updated', makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'past_due', metadata: h.metaFor(ws) }), { created: 200 });
    h.stripe.failNext('subscriptions.retrieve', { type: 'StripeConnectionError' }, { times: 2 });
    expect((await webhook.processEvent(newer, h.deps)).outcome).toBe('processed');
    expect(h.row(ws).subscription).toMatchObject({ state: 'past_due', stripe: { status: 'past_due', lastEventCreated: 200, lastEventId: newer.id } });
    const older = ev('customer.subscription.updated', makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'active', metadata: h.metaFor(ws) }), { created: 150 });
    const out = await webhook.processEvent(older, h.deps);
    expect(out).toMatchObject({ outcome: 'processed', ignored: 'STALE_EVENT' });
    expect(h.row(ws).subscription.state).toBe('past_due');
  });

  test('retrieve failure on an invoice event: 500-path (throws), row failed, nothing applied', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    h.stripe.failNext('subscriptions.retrieve', { type: 'StripeAPIError' }, { times: 1 });
    const e = ev('invoice.payment_failed', makeInvoice({ status: 'open', subscription: 'sub_1' }));
    await expect(webhook.processEvent(e, h.deps)).rejects.toBeTruthy();
    expect(h.inbound(e.id).status).toBe('failed');
    expect(h.row(ws).subscription.state).toBe('active');
    expect(h.notifications).toHaveLength(0);
  });

  test('customer.subscription.deleted needs no retrieve: cancelled, one notification', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    const e = ev('customer.subscription.deleted', makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: h.metaFor(ws) }), { created: 10 });
    const out = await webhook.processEvent(e, h.deps);
    expect(out).toMatchObject({ outcome: 'processed', state: 'cancelled' });
    expect(h.stripe.callsTo('subscriptions.retrieve')).toHaveLength(0);
    expect(h.row(ws).subscription).toMatchObject({ state: 'cancelled', stripe: { status: 'canceled' } });
    expect(h.row(ws).subscription.cancelledAt).toBeTruthy();
    expect(h.notifications.map((n) => n.kind)).toEqual(['subscription_cancelled']);
    expect(h.notifications[0].dedupeKey).toMatch(/^sub:cancelled:sub_1:/);
  });

  test('a late deleted event of an OLD subscription cannot cancel the current one', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    const e = ev('customer.subscription.deleted', makeSubscription({ id: 'sub_old', customer: 'cus_1', status: 'canceled', metadata: h.metaFor(ws) }));
    const out = await webhook.processEvent(e, h.deps);
    expect(out).toMatchObject({ outcome: 'processed', ignored: 'OTHER_SUBSCRIPTION' });
    expect(h.row(ws).subscription.state).toBe('active');
    expect(h.row(ws).subscription.stripe.subscriptionId).toBe('sub_1');
    expect(h.notifications).toHaveLength(0);
  });

  test('a NEW active subscription replaces a cancelled one (re-subscribe)', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'cancelled', stripe: { subscriptionId: 'sub_old', customerId: 'cus_1', status: 'canceled' } });
    h.stripe.setSubscription(makeSubscription({ id: 'sub_new', customer: 'cus_1', status: 'active', metadata: h.metaFor(ws) }));
    const e = ev('customer.subscription.created', makeSubscription({ id: 'sub_new', customer: 'cus_1', status: 'active', metadata: h.metaFor(ws) }));
    expect((await webhook.processEvent(e, h.deps)).state).toBe('active');
    expect(h.row(ws).subscription.stripe.subscriptionId).toBe('sub_new');
  });

  test('invoice.paid and invoice.payment_succeeded are equivalent', async () => {
    const results = [];
    for (const type of ['invoice.paid', 'invoice.payment_succeeded']) {
      const h = makeHarness();
      const ws = h.seedWorkspace({ state: 'pending', stripe: { checkoutStartedAt: new Date(h.clock.ms()), subscriptionId: 'sub_1', customerId: 'cus_1', status: 'incomplete' } });
      sub(h, ws, { status: 'active', currentPeriodEnd: 1_800_000_000 });
      const out = await webhook.processEvent(ev(type, makeInvoice({ subscription: 'sub_1' })), h.deps);
      const s = h.row(ws).subscription;
      results.push({ outcome: out.outcome, state: s.state, source: s.source, status: s.stripe.status, kinds: h.notifications.map((n) => n.kind) });
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual({ outcome: 'processed', state: 'active', source: 'stripe', status: 'active', kinds: ['subscription_active'] });
  });

  test('payment_failed: past_due and exactly ONE notification per invoice (a re-sent event or retry adds none)', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    sub(h, ws, { status: 'past_due' });
    const inv = makeInvoice({ id: 'in_fail_1', status: 'open', subscription: 'sub_1' });
    await webhook.processEvent(ev('invoice.payment_failed', inv), h.deps);
    await webhook.processEvent(ev('invoice.payment_failed', inv), h.deps); // Stripe retry: another event, same invoice
    expect(h.row(ws).subscription).toMatchObject({ state: 'past_due', stripe: { lastPaymentFailureCode: 'payment_failed' } });
    expect(h.row(ws).subscription.stripe.lastPaymentFailedAt).toBeTruthy();
    expect(h.row(ws).subscription.pastDueAt).toBeTruthy();
    expect(h.notifications.map((n) => [n.kind, n.dedupeKey, n.email, n.severity])).toEqual([['payment_failed', 'sub:past_due:sub_1:in_fail_1', true, 'action']]);
    // a NEW failed invoice (next dunning cycle) is a new notification
    await webhook.processEvent(ev('invoice.payment_failed', makeInvoice({ id: 'in_fail_2', status: 'open', subscription: 'sub_1' })), h.deps);
    expect(h.notifications).toHaveLength(2);
    // exactly one payment_state analytics event for the one transition (state.recomputeSubscription writes it)
    expect(h.tracked.filter((t) => t.type === 'payment_state' && t.code === 'SUB_PAST_DUE')).toHaveLength(1);
  });

  test('payment_failed while Stripe says active again (race): no notification', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    sub(h, ws, { status: 'active' });
    await webhook.processEvent(ev('invoice.payment_failed', makeInvoice({ status: 'open', subscription: 'sub_1' })), h.deps);
    expect(h.notifications).toHaveLength(0);
    expect(h.row(ws).subscription.state).toBe('active');
  });

  test('reactivation after past_due keeps all progress untouched and notifies once', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'past_due', source: null, stripe: { subscriptionId: 'sub_1', customerId: 'cus_1', status: 'past_due' } }, {
      steps: { business: { status: 'done' }, number: { status: 'done' }, connect: { status: 'in_progress' } },
      progress: { currentStep: 3, furthestStep: 3, status: 'in_progress' },
      business: { name: 'Acme' },
    });
    const before = JSON.stringify({ steps: h.row(ws).steps, progress: h.row(ws).progress, business: h.row(ws).business });
    sub(h, ws, { status: 'active' });
    await webhook.processEvent(ev('invoice.paid', makeInvoice({ subscription: 'sub_1' })), h.deps);
    expect(h.row(ws).subscription).toMatchObject({ state: 'active', source: 'stripe' });
    expect(JSON.stringify({ steps: h.row(ws).steps, progress: h.row(ws).progress, business: h.row(ws).business })).toBe(before);
    expect(h.notifications.map((n) => n.kind)).toEqual(['subscription_active']);
  });

  test('trialing stays pending unless ONBOARDING_ACCEPT_TRIALING=on AND a default payment method exists', async () => {
    const run = async (accept, pm) => {
      if (accept) process.env.ONBOARDING_ACCEPT_TRIALING = 'on'; else delete process.env.ONBOARDING_ACCEPT_TRIALING;
      const h = makeHarness();
      const ws = h.seedWorkspace({ state: 'pending', stripe: { checkoutStartedAt: new Date(h.clock.ms()) } });
      h.stripe.setSubscription(makeSubscription({ id: 'sub_t', customer: 'cus_t', status: 'trialing', metadata: h.metaFor(ws), defaultPaymentMethod: pm ? 'pm_1' : null }));
      await webhook.processEvent(ev('customer.subscription.created', makeSubscription({ id: 'sub_t', customer: 'cus_t', status: 'trialing', metadata: h.metaFor(ws) })), h.deps);
      return h.row(ws).subscription.state;
    };
    expect(await run(false, true)).toBe('pending');
    expect(await run(true, false)).toBe('pending');
    expect(await run(true, true)).toBe('active');
  });

  test.each([
    ['paused', 'past_due'], ['unpaid', 'past_due'], ['incomplete', 'pending'], ['incomplete_expired', 'none'], ['canceled', 'cancelled'],
  ])('status %s from Stripe -> %s', async (raw, expected) => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    sub(h, ws, { status: raw });
    await webhook.processEvent(ev('customer.subscription.updated', makeSubscription({ id: 'sub_1', customer: 'cus_1', status: raw, metadata: h.metaFor(ws) })), h.deps);
    expect(h.row(ws).subscription.state).toBe(expected);
  });

  test('an unknown status leaves the stored state untouched', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    sub(h, ws, { status: 'quantum' });
    const out = await webhook.processEvent(ev('customer.subscription.updated', makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'quantum', metadata: h.metaFor(ws) })), h.deps);
    expect(out.ignored).toBe('UNKNOWN_STATUS');
    expect(h.row(ws).subscription).toMatchObject({ state: 'active', source: 'stripe', stripe: { status: 'active' } });
  });

  test('an admin activation is not downgraded by Stripe past_due/cancelled', async () => {
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'active', source: 'admin', admin: { active: true, by: 'admin', notes: 'partner' }, stripe: { subscriptionId: 'sub_1', customerId: 'cus_1', status: 'active' } });
    sub(h, ws, { status: 'past_due' });
    await webhook.processEvent(ev('customer.subscription.updated', makeSubscription({ id: 'sub_1', status: 'past_due', metadata: h.metaFor(ws) })), h.deps);
    expect(h.row(ws).subscription).toMatchObject({ state: 'active', source: 'admin', stripe: { status: 'past_due' } });
  });

  test('notification problems never fail the event; un-enrolled workspaces get no notification but their state syncs', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    sub(h, ws, { status: 'past_due' });
    const boom = { ...h.deps, notify: async () => { throw new Error('notify exploded'); } };
    const e = ev('invoice.payment_failed', makeInvoice({ id: 'in_x', status: 'open', subscription: 'sub_1' }));
    expect((await webhook.processEvent(e, boom)).outcome).toBe('processed');
    expect(h.row(ws).subscription.state).toBe('past_due');
    const h2 = makeHarness();
    const ws2 = h2.seedWorkspace({ state: 'active', source: 'stripe', stripe: { subscriptionId: 'sub_1', customerId: 'cus_1', status: 'active' } }, { enrolled: false });
    sub(h2, ws2, { status: 'past_due' });
    await webhook.processEvent(ev('invoice.payment_failed', makeInvoice({ status: 'open', subscription: 'sub_1' })), h2.deps);
    expect(h2.notifications).toHaveLength(0);
    expect(h2.row(ws2).subscription.state).toBe('past_due');
  });

  test('works with the basil API shape end to end (period end on items, invoice parent)', async () => {
    const h = makeHarness({ shape: 'basil' });
    const ws = h.seedWorkspace({ state: 'pending', stripe: { checkoutStartedAt: new Date(h.clock.ms()) } });
    h.stripe.setSubscription(h.stripe.makeSubscription({ id: 'sub_b', customer: 'cus_b', status: 'active', metadata: h.metaFor(ws), currentPeriodEnd: 1_800_000_000 }));
    const out = await webhook.processEvent(ev('invoice.paid', h.stripe.makeInvoice({ subscription: 'sub_b', customer: 'cus_b' })), h.deps);
    expect(out.state).toBe('active');
    expect(h.row(ws).subscription.stripe.currentPeriodEnd).toEqual(new Date(1_800_000_000 * 1000));
  });
});

function fakeRes() {
  const r = { statusCode: null, body: undefined, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  r.set = (k, v) => { r.headers[k] = v; return r; };
  Object.defineProperty(r, 'headersSent', { get: () => r.statusCode !== null });
  return r;
}

describe('createHandler', () => {
  const build = (h, over = {}) => webhook.createHandler({ ...h.deps, secrets: [TEST_WEBHOOK_SECRET], ...over });
  const post = (handler, signed, extra = {}) => {
    const req = { headers: { 'stripe-signature': signed.header }, body: signed.body, ...extra };
    const res = fakeRes();
    const next = jest.fn();
    return handler(req, res, next).then(() => ({ res, next }));
  };

  test('flag off: the handler does nothing and falls through (next("route"))', async () => {
    delete process.env.ONBOARDING_FLOW;
    const h = makeHarness();
    const signed = h.stripe.signedEvent({ type: 'customer.created', object: { id: 'cus_1' } });
    const { res, next } = await post(build(h), signed);
    expect(next).toHaveBeenCalledWith('route');
    expect(res.statusCode).toBeNull();
    expect(h.OnboardingInbound.rows).toHaveLength(0);
  });

  test('no secret configured: 503 CHECKOUT_NOT_CONFIGURED', async () => {
    const h = makeHarness();
    const signed = h.stripe.signedEvent({ type: 'customer.created', object: { id: 'cus_1' } });
    const { res } = await post(build(h, { secrets: [] }), signed);
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('CHECKOUT_NOT_CONFIGURED');
  });

  test.each([
    ['wrong secret', (h) => h.stripe.signedEvent({ type: 'customer.created', object: {}, secret: 'whsec_not_ours_dummy' }), (s) => s],
    ['missing header', (h) => h.stripe.signedEvent({ type: 'customer.created', object: {} }), (s) => ({ ...s, header: undefined })],
    ['tampered body', (h) => h.stripe.signedEvent({ type: 'customer.created', object: {} }), (s) => ({ ...s, body: Buffer.from(s.payload.replace('customer.created', 'customer.creatXd')) })],
    ['already-parsed body', (h) => h.stripe.signedEvent({ type: 'customer.created', object: {} }), (s) => ({ ...s, body: JSON.parse(s.payload) })],
  ])('bad signature (%s): 400 and nothing is stored', async (_n, make, tweak) => {
    const h = makeHarness();
    const signed = tweak(make(h));
    const { res } = await post(build(h), signed, signed.header === undefined ? { headers: {} } : {});
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(JSON.stringify(res.body)).not.toContain(TEST_WEBHOOK_SECRET);
    expect(h.OnboardingInbound.rows).toHaveLength(0);
  });

  test('a valid delivery signed with the PREVIOUS secret is accepted', async () => {
    const h = makeHarness();
    const prev = 'whsec_previous_dummy_for_handler';
    const signed = signedEvent({ type: 'customer.created', object: { id: 'cus_1' }, secret: prev });
    const { res } = await post(build(h, { secrets: [TEST_WEBHOOK_SECRET, prev] }), signed);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ received: true, outcome: 'ignored' });
  });

  test('200 for a processed event and for its duplicate', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    sub(h, ws, { status: 'past_due' });
    const signed = h.stripe.signedEvent({ type: 'invoice.payment_failed', object: makeInvoice({ id: 'in_h', status: 'open', subscription: 'sub_1' }) });
    const handler = build(h);
    const first = await post(handler, signed);
    const second = await post(handler, signed);
    expect(first.res.statusCode).toBe(200);
    expect(first.res.body.outcome).toBe('processed');
    expect(second.res.statusCode).toBe(200);
    expect(second.res.body.outcome).toBe('duplicate');
    expect(h.notifications).toHaveLength(1);
  });

  test('a handler failure answers 500 so Stripe retries; the redelivery then succeeds', async () => {
    const h = makeHarness();
    const ws = liveWorkspace(h);
    sub(h, ws, { status: 'past_due' });
    h.stripe.failNext('subscriptions.retrieve', { type: 'StripeConnectionError' }, { times: 1 });
    const signed = h.stripe.signedEvent({ type: 'invoice.paid', object: makeInvoice({ subscription: 'sub_1' }) });
    const handler = build(h);
    const first = await post(handler, signed);
    expect(first.res.statusCode).toBe(500);
    expect(first.res.body).toEqual({ error: 'Processing failed', code: 'INTERNAL_ERROR' });
    const second = await post(handler, signed);
    expect(second.res.statusCode).toBe(200);
    expect(h.row(ws).subscription.state).toBe('past_due');
  });

  test('never logs payload bodies or customer details (ids and event types only)', async () => {
    const lines = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug']) jest.spyOn(console, m).mockImplementation((...a) => { lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
    const h = makeHarness();
    const ws = h.seedWorkspace({ state: 'pending', stripe: { checkoutStartedAt: new Date(h.clock.ms()) } });
    h.stripe.setSubscription(makeSubscription({ id: 'sub_log', customer: 'cus_log', status: 'weirdstatus', metadata: h.metaFor(ws) }));
    const session = makeCheckoutSession({ id: 'cs_log', clientReferenceId: ws, metadata: h.metaFor(ws), customer: 'cus_log', subscription: 'sub_log', email: 'secret.person@example.test', businessName: 'Hidden Biz Name' });
    const handler = build(h);
    await post(handler, h.stripe.signedEvent({ type: 'checkout.session.completed', object: session }));
    await post(handler, h.stripe.signedEvent({ type: 'checkout.session.completed', object: session, secret: 'whsec_bad_dummy' }));
    await post(handler, h.stripe.signedEvent({ type: 'customer.subscription.updated', object: makeSubscription({ id: 'sub_log', metadata: {} }) }));
    const all = lines.join('\n');
    expect(all).not.toContain('secret.person@example.test');
    expect(all).not.toContain('Hidden Biz Name');
    expect(all).not.toContain(TEST_WEBHOOK_SECRET);
    expect(all).not.toContain('whsec_');
  });
});
