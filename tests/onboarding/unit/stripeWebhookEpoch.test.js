'use strict';
// Review R7-04: the notification keys of "subscription active" / "subscription cancelled" carry the time of the Stripe event that caused
// the state change, so a state that comes back in the SAME billing period (past due -> paid -> past due -> paid) tells the merchant again,
// while a re-delivery of one event stays one notification. In-memory models and fakeStripe: no network, no DB.
const webhook = require('../../../shared/onboarding/stripeWebhook');
const { makeHarness } = require('./_stripeHarness');
const { makeSubscription, makeEvent } = require('../_fixtures');

const ENV = ['ONBOARDING_FLOW', 'ONBOARDING_ACCEPT_TRIALING', 'ONBOARDING_STRIPE_PRICES'];
const saved = {};
beforeEach(() => {
  ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  process.env.ONBOARDING_FLOW = 'on';
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); jest.restoreAllMocks(); });

let seq = 0;
const PERIOD_END = 1_800_000_000;
const evid = () => `evt_epoch_${++seq}`;
const ev = (type, object, extra = {}) => makeEvent({ type, object, id: evid(), ...extra });
const live = (h) => h.seedWorkspace({
  state: 'active', source: 'stripe',
  stripe: { subscriptionId: 'sub_1', customerId: 'cus_1', status: 'active', hasDefaultPaymentMethod: true },
});
const retrieved = (h, ws, status) => h.stripe.setSubscription(makeSubscription({ shape: h.shape, id: 'sub_1', customer: 'cus_1', status, currentPeriodEnd: PERIOD_END, metadata: h.metaFor(ws) }));
const updated = (h, ws, status, created) => ev('customer.subscription.updated', makeSubscription({ id: 'sub_1', customer: 'cus_1', status, currentPeriodEnd: PERIOD_END, metadata: h.metaFor(ws) }), { created });
const kinds = (h, kind) => h.notifications.filter((n) => n.kind === kind);

describe('notification keys carry the epoch of the event that caused the change (review R7-04)', () => {
  test('past due -> paid -> past due -> paid inside ONE billing period: both recoveries are announced, with different keys', async () => {
    const h = makeHarness();
    const ws = live(h);
    const flow = [['past_due', 100], ['active', 200], ['past_due', 300], ['active', 400]];
    for (const [status, created] of flow) {
      retrieved(h, ws, status);
      expect((await webhook.processEvent(updated(h, ws, status, created), h.deps)).outcome).toBe('processed');
    }
    expect(h.row(ws).subscription.state).toBe('active');
    const active = kinds(h, 'subscription_active');
    expect(active).toHaveLength(2);
    expect(active.map((n) => n.dedupeKey)).toEqual([`sub:active:sub_1:${PERIOD_END}:200`, `sub:active:sub_1:${PERIOD_END}:400`]);
    expect(new Set(active.map((n) => n.dedupeKey)).size).toBe(2);
  });

  test('a re-delivery of the same event (same id) is one notification; a different event of the same time and change is the same key', async () => {
    const h = makeHarness();
    const ws = live(h);
    retrieved(h, ws, 'past_due');
    await webhook.processEvent(updated(h, ws, 'past_due', 100), h.deps);
    retrieved(h, ws, 'active');
    const paid = updated(h, ws, 'active', 200);
    expect((await webhook.processEvent(paid, h.deps)).outcome).toBe('processed');
    expect((await webhook.processEvent(paid, h.deps)).outcome).toBe('duplicate');
    expect(kinds(h, 'subscription_active')).toHaveLength(1);
    // a second event id for the very same instant finds the state already active: no state change, no notification
    const twin = updated(h, ws, 'active', 200);
    await webhook.processEvent(twin, h.deps);
    expect(kinds(h, 'subscription_active')).toHaveLength(1);
  });

  test('cancelled: the key ends with the event time; a different subscription id or time is a different key', async () => {
    const h = makeHarness();
    const ws = live(h);
    const e = ev('customer.subscription.deleted', makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'canceled', currentPeriodEnd: PERIOD_END, metadata: h.metaFor(ws) }), { created: 10 });
    expect((await webhook.processEvent(e, h.deps)).state).toBe('cancelled');
    expect(kinds(h, 'subscription_cancelled').map((n) => n.dedupeKey)).toEqual([`sub:cancelled:sub_1:${PERIOD_END}:10`]);
    expect((await webhook.processEvent(e, h.deps)).outcome).toBe('duplicate');
    expect(kinds(h, 'subscription_cancelled')).toHaveLength(1);
  });

  test('the payment-failed key is unchanged (it is keyed by the invoice, which already differs per failure)', async () => {
    const h = makeHarness();
    const ws = live(h);
    retrieved(h, ws, 'past_due');
    const { makeInvoice } = require('../_fixtures');
    const e = ev('invoice.payment_failed', makeInvoice({ status: 'open', subscription: 'sub_1', id: 'in_fail_9' }));
    await webhook.processEvent(e, h.deps);
    expect(kinds(h, 'payment_failed').map((n) => n.dedupeKey)).toEqual(['sub:past_due:sub_1:in_fail_9']);
  });
});
