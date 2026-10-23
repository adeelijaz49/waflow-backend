'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_e2ebill`;
assertThrowawayDb();

// END TO END (task I1b): past_due and cancelled behaviour mid-onboarding and after it (reads allowed, writes 402, sends
// paused with a code, nothing lost, reactivation resumes), the admin override, and the scheduler's rule that only
// active|past_due workspaces are polled. REAL server.js; Stripe events are SIGNED deliveries to /stripe-billing-webhook.
const { createWorld, spyConsole } = require('./_e2eWorld');

jest.setTimeout(90000);

let w;
let con;
const stateOf = async (t) => (await w.get(t.owner, '/state')).body;
const sweep = () => {
  const scheduler = require('../../../shared/onboarding/scheduler');
  return scheduler.runOnboardingSweep(scheduler.realDeps());
};
const dueNow = (ws) => w.M('WhatsAppConnection').updateOne({ workspaceId: ws }, { $set: { nextCheckAt: new Date(Date.now() - 1000) } });
const failPayment = async (t, sub, invoiceId) => {
  w.stripe.setSubscription({ ...sub, status: 'past_due' });
  return w.deliverStripe('invoice.payment_failed', w.stripe.makeInvoice({ id: invoiceId, subscription: sub.id, customer: sub.customer, status: 'open', billingReason: 'subscription_cycle', attemptCount: 1 }));
};

beforeAll(async () => { w = await createWorld({ policy: 'block' }); con = spyConsole(); });
afterAll(async () => { con.restore(); await w.handle.stop(); });

describe('past_due in the middle of the setup', () => {
  let t;
  let sub;
  let ctx;
  let snapshot;
  beforeAll(async () => {
    t = await w.tenant('PastDue', { activate: false });
    sub = (await w.payViaStripe(t)).subscription;
    ctx = await w.connectTenant(t);
    await w.get(t.owner, '/approvals');
    snapshot = await stateOf(t);
    w.mail.reset();
  });

  test('a failed payment moves the workspace to past_due: ONE notification and ONE e-mail however often Stripe re-sends it', async () => {
    const hook = await failPayment(t, sub, 'in_fixture_pd_1');
    expect(hook.status).toBe(200);
    expect((await w.deliverStripe('invoice.payment_failed', w.stripe.makeInvoice({ id: 'in_fixture_pd_1', subscription: sub.id, customer: sub.customer, status: 'open' }))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 250));
    const row = await w.rowOf(t.ws);
    expect(row.subscription.state).toBe('past_due');
    const notes = await w.M('OnboardingNotification').find({ workspaceId: t.ws, kind: 'payment_failed' }).lean();
    expect(notes).toHaveLength(1);
    const mails = w.mail.sent.filter((m) => m.to === t.owner.email);
    expect(mails).toHaveLength(1);
    expect(mails[0].text + mails[0].html).toContain('WhatsApp message fees are charged by Meta to your own Meta account.');
    expect(mails[0].html).not.toMatch(/(SAR|USD|\$|price|plan)/i);
    // a NEW failed invoice is a new problem: a second notification
    await failPayment(t, sub, 'in_fixture_pd_2');
    expect(await w.M('OnboardingNotification').countDocuments({ workspaceId: t.ws, kind: 'payment_failed' })).toBe(2);
  });

  test('the state is the FULL state (progress readable) with the billing way out; every step write is refused with the 402 code', async () => {
    const s = await stateOf(t);
    expect(s).toMatchObject({ view: 'setup', locked: true, subscription: { state: 'past_due', retry: { checkout: false, billingPortal: true } }, sendingPaused: { code: 'PAYMENT_PAST_DUE' } });
    expect(s.steps).toEqual(snapshot.steps);
    expect(s.business).toEqual(snapshot.business);
    expect(s.connection.level).toBe('connected');
    expect((await w.get(t.owner, '/help-context')).status).toBe(200); // billing-exempt
    for (const [m, p, b] of [['put', '/business', { name: 'Changed Name' }], ['post', '/number/path', { hasNumber: false }], ['post', '/prompts/customers', { state: 'skipped' }], ['post', '/test-message', {}], ['post', '/first-promotion/state', { state: 'skipped' }], ['post', '/connection/refresh', {}], ['post', '/templates/submit', {}], ['post', '/preferences', { uiLanguage: 'ar' }]]) {
      const r = await w.call(t.owner, m, p, b);
      expect([m, p, r.status, r.body.code]).toEqual([m, p, 402, 'PAYMENT_PAST_DUE']);
      expect(r.body.retry).toMatchObject({ billingPortal: true, checkout: false });
    }
    expect((await w.rowOf(t.ws)).business.name).toBe(snapshot.business.name);
  });

  test('the bell and the analytics beacons are billing-exempt (gate E): while the payment is overdue the merchant still reads the payment_failed notification, marks it read, and the beacons are accepted', async () => {
    const list = await w.get(t.owner, '/notifications');
    expect(list.status).toBe(200); // before the gate change this was 402 PAYMENT_PAST_DUE
    const failed = list.body.notifications.filter((n) => n.kind === 'payment_failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(list.body.unread).toBeGreaterThanOrEqual(failed.length);
    const read = await w.post(t.owner, '/notifications/read', { ids: failed.map((n) => n.id) });
    expect(read.status).toBe(200);
    expect(read.body.modified).toBe(failed.length);
    const before = await w.M('OnboardingEvent').countDocuments({ workspaceId: t.ws, type: 'help_opened' });
    expect((await w.post(t.owner, '/events', { type: 'help_opened', step: 'billing' })).status).toBe(204);
    expect(await w.M('OnboardingEvent').countDocuments({ workspaceId: t.ws, type: 'help_opened' })).toBe(before + 1);
    // the owner-only and step routes next to them are still refused
    expect((await w.put(t.owner, '/business', { name: 'Still refused' })).status).toBe(402);
  });

  test('reads of the app stay allowed, sends are paused with a visible code, the billing portal and the on-demand refresh stay open', async () => {
    expect((await w.agent.get('/api/promotions').set('Authorization', `Bearer ${t.owner.token}`)).status).toBe(200);
    const send = await w.agent.post('/api/promotions/000000000000000000000001/send').set('Authorization', `Bearer ${t.owner.token}`).send({});
    expect(send.status).toBe(402);
    expect(send.body.code).toBe('PAYMENT_PAST_DUE');
    expect((await w.post(t.owner, '/billing-portal', {})).status).toBe(200);
    expect((await w.post(t.owner, '/checkout', { planCode: 'pro' })).body.code).toBe('SUBSCRIPTION_EXISTS');
    expect((await w.post(t.owner, '/billing/refresh', {})).status).toBe(200);
    expect(w.graph.platformCalls).toHaveLength(0);
  });

  test('the scheduler still polls a past_due workspace (the merchant must see the status change back) but never needs the browser', async () => {
    await dueNow(t.ws);
    const before = ctx.graph.calls.length;
    const r = await sweep();
    expect(r.connections.refreshed).toBeGreaterThanOrEqual(1);
    expect(ctx.graph.calls.length).toBeGreaterThan(before);
  });

  test('reactivation (the payment succeeds): active again, steps / business / connection untouched, writes work, sending follows the policy', async () => {
    w.stripe.setSubscription({ ...sub, status: 'active' });
    const hook = await w.deliverStripe('invoice.paid', w.stripe.makeInvoice({ id: 'in_fixture_pd_3', subscription: sub.id, customer: sub.customer, status: 'paid' }));
    expect(hook.status).toBe(200);
    const s = await stateOf(t);
    expect(s).toMatchObject({ view: 'setup', locked: false, subscription: { state: 'active', source: 'stripe' }, sendingPaused: { code: 'SENDING_NOT_AVAILABLE_YET' } });
    expect(s.steps).toEqual(snapshot.steps);
    expect(s.nextStep).toBe(snapshot.nextStep);
    expect((await w.post(t.owner, '/prompts/customers', { state: 'skipped' })).status).toBe(200);
  });
});

describe('cancelled (and finished): the work is kept, the app stays usable, sending is paused, a new subscription resumes everything', () => {
  let t;
  let sub;
  let ctx;
  let templateRows;
  beforeAll(async () => {
    t = await w.tenant('Cancelled', { activate: false });
    sub = (await w.payViaStripe(t)).subscription;
    ctx = await w.connectTenant(t);
    await w.get(t.owner, '/approvals');
    await w.post(t.owner, '/prompts/customers', { state: 'skipped' });
    await w.post(t.owner, '/prompts/products', { state: 'skipped' });
    await w.post(t.owner, '/first-promotion/state', { state: 'skipped' });
    templateRows = await w.M('OnboardingTemplate').countDocuments({ workspaceId: t.ws });
    expect((await stateOf(t)).view).toBe('done');
    const cancelled = w.stripe.setSubscription({ ...sub, status: 'canceled', canceledAt: Math.floor(Date.now() / 1000) });
    expect((await w.deliverStripe('customer.subscription.deleted', cancelled)).status).toBe(200);
  });

  test('cancelled + finished: view stays "done", locked, sending paused with the code, checkout and portal offered', async () => {
    const s = await stateOf(t);
    expect(s).toMatchObject({ view: 'done', locked: true, subscription: { state: 'cancelled', retry: { checkout: true, billingPortal: true } }, sendingPaused: { code: 'SUBSCRIPTION_CANCELLED' } });
    expect(s.progress.completedAt).toEqual(expect.any(String));
    expect(await w.M('OnboardingTemplate').countDocuments({ workspaceId: t.ws })).toBe(templateRows);
    const r = await w.put(t.owner, '/business', { name: 'Changed' });
    expect([r.status, r.body.code]).toEqual([402, 'SUBSCRIPTION_CANCELLED']);
    const send = await w.agent.post('/api/promotions/000000000000000000000001/send').set('Authorization', `Bearer ${t.owner.token}`).send({});
    expect([send.status, send.body.code]).toEqual([402, 'SUBSCRIPTION_CANCELLED']);
    expect((await w.agent.get('/api/customers').set('Authorization', `Bearer ${t.owner.token}`)).status).toBe(200);
  });

  test('after the cancellation the bell still lists the subscription_cancelled notification and the beacons are accepted (the data and the progress stay readable)', async () => {
    const list = await w.get(t.owner, '/notifications');
    expect(list.status).toBe(200);
    expect(list.body.notifications.some((n) => n.kind === 'subscription_cancelled')).toBe(true);
    expect((await w.post(t.owner, '/notifications/read', { all: true })).status).toBe(200);
    expect((await w.get(t.owner, '/notifications?unread=1')).body).toMatchObject({ notifications: [], unread: 0 });
    expect((await w.post(t.owner, '/events', { type: 'step_enter', step: 'billing' })).status).toBe(204);
    expect((await w.get(t.owner, '/approvals')).status).toBe(402); // a step read next to it is still refused
  });

  test('the scheduler never polls Meta for a cancelled workspace (it defers it); the connection data stays', async () => {
    await dueNow(t.ws);
    const before = ctx.graph.calls.length;
    const r = await sweep();
    expect(r.connections.deferred).toBeGreaterThanOrEqual(1);
    expect(ctx.graph.calls.length).toBe(before);
    const conn = await w.connOf(t.ws);
    expect(new Date(conn.nextCheckAt).getTime()).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
    expect(conn.status).toBe('connected');
  });

  test('a new subscription (checkout again) resumes everything exactly where it was', async () => {
    const co = await w.post(t.owner, '/checkout', { planCode: 'basic' });
    expect(co.status).toBe(200);
    const sessionId = String(co.body.url).split('/').pop();
    const done = w.stripe.completeCheckout(sessionId, { businessName: 'Cancelled Shop', email: t.owner.email });
    expect((await w.deliverStripe('checkout.session.completed', done.session)).status).toBe(200);
    const s = await stateOf(t);
    expect(s).toMatchObject({ view: 'done', locked: false, subscription: { state: 'active', source: 'stripe' }, connection: { level: 'connected' } });
    expect((await w.put(t.owner, '/business', { website: 'https://example.org' })).status).toBe(200);
    // an OLD subscription event arriving late cannot cancel the new one
    const late = w.stripe.setSubscription({ ...sub, status: 'canceled' });
    await w.deliverStripe('customer.subscription.deleted', late);
    expect((await stateOf(t)).subscription.state).toBe('active');
  });
});

describe('the admin override and an unknown Stripe status never fight', () => {
  test('admin activation without Stripe: deactivate -> billing view, activate -> setup resumes untouched', async () => {
    const t = await w.tenant('AdminOnly');
    await w.put(t.owner, '/business', w.BUSINESS(t));
    const before = await stateOf(t);
    await w.state.adminDeactivate({ workspaceId: t.ws, by: 'cli:e2e-test', notes: 'e2e' });
    const off = await stateOf(t);
    expect(off).toMatchObject({ view: 'billing', subscription: { state: 'none' }, locked: true });
    expect((await w.put(t.owner, '/business', { name: 'x' })).status).toBe(402);
    await w.state.adminActivate({ workspaceId: t.ws, by: 'cli:e2e-test', notes: 'e2e again' });
    const on = await stateOf(t);
    expect(on.steps).toEqual(before.steps);
    expect(on).toMatchObject({ view: 'setup', subscription: { state: 'active', source: 'admin' } });
    expect(await w.M('OnboardingAdminLog').countDocuments({ workspaceId: t.ws })).toBeGreaterThanOrEqual(3);
  });

  test('trialing is NOT active (D2) and an unknown Stripe status keeps the stored state', async () => {
    const t = await w.tenant('Trial', { activate: false });
    const co = await w.post(t.owner, '/checkout', { planCode: 'basic' });
    const sessionId = String(co.body.url).split('/').pop();
    const done = w.stripe.completeCheckout(sessionId, { subscriptionStatus: 'trialing', businessName: 'Trial Shop', email: t.owner.email });
    expect((await w.deliverStripe('checkout.session.completed', done.session)).status).toBe(200);
    expect((await stateOf(t)).subscription.state).toBe('pending');
    expect((await w.put(t.owner, '/business', { name: 'x' })).body.code).toBe('PAYMENT_PENDING');
    w.stripe.setSubscription({ ...done.subscription, status: 'active' });
    await w.deliverStripe('customer.subscription.updated', w.stripe.getSubscription(done.subscription.id));
    expect((await stateOf(t)).subscription.state).toBe('active');
    w.stripe.setSubscription({ ...done.subscription, status: 'some_new_stripe_status' });
    await w.deliverStripe('customer.subscription.updated', w.stripe.getSubscription(done.subscription.id));
    expect((await stateOf(t)).subscription.state).toBe('active');
  });
});

describe('the webhook is late or lost: the browser asks, the SERVER asks Stripe (never trusts the browser)', () => {
  test('checkout URLs return to the SPA; a completed session activates through the rate-limited on-demand refresh, once', async () => {
    const t = await w.tenant('LostWebhook', { activate: false });
    const co = await w.post(t.owner, '/checkout', { planCode: 'basic' });
    expect(co.status).toBe(200);
    const params = w.stripe.callsTo('checkout.sessions.create').pop().args.params;
    expect(params.success_url).toMatch(/^http:\/\/localhost:4200\/setup\?checkout=return/);
    expect(params.cancel_url).toMatch(/^http:\/\/localhost:4200\/setup\?checkout=cancel/);
    expect(params.mode).toBe('subscription');
    expect(params.metadata).toMatchObject({ workspaceId: t.ws });
    const sessionId = String(co.body.url).split('/').pop();
    // the customer pays; the webhook never arrives
    w.stripe.completeCheckout(sessionId, { businessName: 'Lost Webhook Shop', email: t.owner.email });
    expect((await stateOf(t)).subscription.state).toBe('pending'); // the state alone does not move
    const r = await w.post(t.owner, '/billing/refresh', {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: true, subscription: { state: 'active' } });
    expect(await stateOf(t)).toMatchObject({ view: 'setup', subscription: { state: 'active', source: 'stripe' } });
    expect((await w.post(t.owner, '/billing/refresh', {})).status).toBe(429);
    // a member cannot start a checkout, an unknown plan is refused, a body "workspaceId" is ignored
    expect((await w.post(t.member, '/checkout', { planCode: 'basic', workspaceId: t.ws })).status).toBe(403);
  });

  test('with checkout switched off the state says so and POST /checkout is refused with a code (admin activation is the fallback)', async () => {
    const t = await w.tenant('NoCheckout', { activate: false });
    process.env.ONBOARDING_CHECKOUT = 'off';
    try {
      const s = await stateOf(t);
      expect(s.checkout.available).toBe(false);
      const r = await w.post(t.owner, '/checkout', { planCode: 'basic' });
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('CHECKOUT_NOT_CONFIGURED');
    } finally { process.env.ONBOARDING_CHECKOUT = 'on'; }
    await w.state.adminActivate({ workspaceId: t.ws, by: 'cli:e2e-test', notes: 'checkout off, activated by staff' });
    expect(await stateOf(t)).toMatchObject({ subscription: { state: 'active', source: 'admin' } });
  });
});
