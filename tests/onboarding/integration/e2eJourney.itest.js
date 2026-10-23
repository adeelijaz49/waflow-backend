'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_e2ejourney`;
assertThrowawayDb();

// END TO END (task I1b): the whole merchant journey against the REAL server.js (flag on), the REAL guard / routers /
// models / scheduler code and the throwaway mongod; only Graph, Stripe and Resend are fakes. /state is asserted at every
// step. Stories: A) admin activation, B) Stripe checkout, C) resume from a second token, D) legacy send policy.
const { createWorld, spyConsole } = require('./_e2eWorld');

jest.setTimeout(90000); // the first boot of the real server.js under jest is slow

let w;
let con;
const scrub = (b) => { const c = JSON.parse(JSON.stringify(b)); delete c.checkedAt; if (c.connection) delete c.connection.checkedAt; return c; };
const stateOf = async (t, who = 'owner') => (await w.get(t[who], '/state')).body;

beforeAll(async () => { w = await createWorld({ policy: 'block' }); con = spyConsole(); });
afterAll(async () => { con.restore(); await w.handle.stop(); });

describe('A) admin activation -> connected -> prompts -> test message -> first promotion -> done', () => {
  let t;
  let ctx;
  beforeAll(async () => { t = await w.tenant('Journey A'); });

  test('step 0: enrolled and active by admin, nothing started, locked until step 3', async () => {
    const s = await stateOf(t);
    expect(s).toMatchObject({
      enrolled: true, view: 'setup', locked: true, unlockAt: 'connected', nextStep: 'business', currentStep: 'business',
      subscription: { state: 'active', source: 'admin' }, progress: { completedAt: null, status: 'in_progress' },
      sendingPaused: { code: 'WHATSAPP_NOT_CONNECTED' }, connection: { level: null, numberMasked: null }, notifications: { unread: 0 },
    });
    expect(Object.values(s.steps).every((x) => x.status === 'todo')).toBe(true);
    expect((await w.rowOf(t.ws)).enrolled).toBe(true);
  });

  test('step 1: business answers move the checklist on (R1: the old wizard stays away)', async () => {
    const bad = await w.put(t.owner, '/business', { name: 'x', country: 'ZZ', industry: 'nope' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    const ok = await w.put(t.owner, '/business', w.BUSINESS(t, { contactEmail: 'journey-a@example.test', instagram: '@journeyshop' }));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ nextStep: 'number', steps: { business: { status: 'done' } }, business: { name: 'Journey A Shop', instagram: 'journeyshop' } });
    const ws = await w.M('Workspace').findById(t.ws).lean();
    expect(ws.onboarding.completed).toBe(true); // R1 applied at enrolment
    // a member can answer steps 1-2 too (live role check only for owner-only routes)
    expect((await w.put(t.member, '/business', { website: 'https://example.com' })).status).toBe(200);
  });

  test('step 2: Path A moves to the connect step; connect is still not possible before it', async () => {
    const early = await w.get(t.owner, '/connect/config');
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('STEP_PREREQUISITE');
    const n = await w.post(t.owner, '/number/path', { hasNumber: true, usage: 'unused' });
    expect(n.status).toBe(200);
    expect(n.body).toMatchObject({ path: 'A', nextStep: 'connect' });
    expect(await stateOf(t)).toMatchObject({ nextStep: 'connect', steps: { number: { status: 'done' } }, progress: { status: 'in_progress' } });
  });

  test('step 3: connect config (no secret) -> complete -> connected, everything unlocks (D6)', async () => {
    ctx = { graph: w.graph.newTarget('A', { displayNumber: '+966 55 811 0001', verifiedName: 'Journey A Shop' }) };
    const cfg = await w.get(t.owner, '/connect/config');
    expect(cfg.status).toBe(200);
    expect(cfg.body).toMatchObject({ enabled: true, appId: 'APP_ID_FIXTURE', configId: 'CONFIG_ID_FIXTURE', expiresInSec: 900, reconnect: null });
    expect(JSON.stringify(cfg.body)).not.toContain('APP_SECRET_FIXTURE');
    ctx.attemptId = cfg.body.attemptId;
    const done = await w.complete(t, ctx);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'connected', level: 'connected', nextStep: 'approvals', connection: { numberMasked: '********0001', verifiedName: 'Journey A Shop', needsReconnect: false } });
    const s = await stateOf(t);
    expect(s).toMatchObject({
      locked: false, nextStep: 'approvals', steps: { connect: { status: 'done' } },
      connection: { level: 'connected', status: 'connected', numberMasked: '********0001', numberFull: '+966 55 811 0001', verifiedName: 'Journey A Shop', causeCode: null },
      sendingPaused: { code: 'SENDING_NOT_AVAILABLE_YET' }, // policy block: the legacy senders still use the platform number (D5)
    });
    expect(s.notifications.unread).toBeGreaterThanOrEqual(1);
    // spec Step 4: the merchant is told by e-mail as well as in the app, once (the provider is the fake behind the real e-mail module)
    for (let i = 0; i < 40 && !w.mail.sent.some((x) => x.subject === 'WhatsApp is connected to WaFlow'); i += 1) await new Promise((r) => setTimeout(r, 50));
    const connectedMails = w.mail.sent.filter((x) => x.to === t.owner.email && x.subject === 'WhatsApp is connected to WaFlow');
    expect(connectedMails).toHaveLength(1);
    expect(connectedMails[0].html).toContain('/setup/approvals');
    w.mail.fake.assertNoLeak([ctx.graph.ids.merchantToken, '+966 55 811 0001']);
    // the member never gets the full number
    const m = await stateOf(t, 'member');
    expect(m.connection.numberMasked).toBe('********0001');
    expect(m.connection.numberFull).toBeUndefined();
    // Graph was only ever called with the merchant token (never the platform token), the platform number was never used
    ctx.graph.assertNeverUsedToken(w.graph.platformToken);
    expect(w.graph.platformCalls).toHaveLength(0);
  });

  test('step 4: approvals are visible and never block; the checklist offers the prompts next', async () => {
    const a = await w.get(t.owner, '/approvals');
    expect(a.status).toBe(200);
    expect(a.body.rows.map((r) => r.key)).toEqual(['verification', 'displayName', 'payment', 'messagingLimit', 'templates']);
    expect(a.body.rows.every((r) => r.blocking === false)).toBe(true);
    expect(a.body.rows.find((r) => r.key === 'payment')).toMatchObject({ status: 'needs_you', value: 'unknown' });
    expect(a.body.rows.find((r) => r.key === 'messagingLimit')).toMatchObject({ status: 'done', tierNumber: 250 });
    const s = await stateOf(t);
    expect(s.steps.approvals.status).toBe('in_progress');
    expect(s.nextStep).toBe('customers');
    expect((await w.post(t.owner, '/approvals/payment-confirmed', { confirmed: true })).status).toBe(200);
    expect((await w.get(t.owner, '/approvals')).body.rows.find((r) => r.key === 'payment').status).toBe('done');
  });

  test('templates: queued at connect, the first 5 handed to the merchant WABA at once, the rest by the next ticks, statuses arrive by signed webhook', async () => {
    const before = await w.get(t.owner, '/templates');
    expect(before.status).toBe(200);
    expect(before.body.templates.length).toBeGreaterThanOrEqual(8);
    const english = before.body.templates.filter((r) => r.language === 'en');
    expect(english.filter((r) => r.status === 'pending')).toHaveLength(5); // the connect handed the first 5 to Meta right after its answer (I5 G6)
    expect(english.filter((r) => r.status === 'queued')).toHaveLength(3); // the rest waits for the next scheduler tick
    expect(ctx.graph.templates()).toHaveLength(5);
    expect(w.graph.platformCalls).toHaveLength(0); // never the platform number or token
    for (let i = 0; i < 3; i += 1) { await w.post(t.owner, '/templates/submit', {}); await require('../../../shared/onboarding/starterTemplates').submitPending({ workspaceId: t.ws }); }
    const created = ctx.graph.templates();
    expect(created.length).toBeGreaterThanOrEqual(8);
    expect(created.every((x) => x.name.startsWith('wf_'))).toBe(true);
    for (const tpl of created.filter((x) => x.language === 'en')) {
      ctx.graph.setTemplateStatus(tpl.name, 'en', 'APPROVED');
      const hook = await w.deliverMeta(ctx.graph.webhook.templateStatus(tpl.name, 'en', 'APPROVED'));
      expect(hook.status).toBe(200);
    }
    const after = await w.get(t.owner, '/templates');
    expect(after.body.templates.filter((r) => r.language === 'en').every((r) => r.status === 'approved')).toBe(true);
    const row = (await w.get(t.owner, '/approvals')).body.rows.find((r) => r.key === 'templates');
    expect(row.status).toBe('done');
  });

  test('prompts: customers "done" needs real data, products can be skipped; the step order follows the spec', async () => {
    const refused = await w.post(t.owner, '/prompts/customers', { state: 'done' });
    expect(refused.status).toBe(422);
    expect(refused.body.details.reason).toBe('NOTHING_ADDED');
    // an erased customer does not count (ruling 5)
    await w.M('Customer').create({ workspaceId: t.ws, firstname: 'Erased', lastname: 'Person', phone: '966555100001', marketingConsent: true, deletedAt: new Date() });
    expect((await w.post(t.owner, '/prompts/customers', { state: 'done' })).status).toBe(422);
    for (const [i, name] of ['Amal', 'Basma'].entries()) {
      await w.M('Customer').create({ workspaceId: t.ws, firstname: name, lastname: 'Seed', phone: `96655510000${i + 2}`, marketingConsent: true, marketingConsentAt: new Date(), marketingConsentMethod: 'manual_staff_entry' });
    }
    await w.M('Customer').create({ workspaceId: t.ws, firstname: 'No', lastname: 'Consent', phone: '966555100009' });
    expect((await w.post(t.owner, '/prompts/customers', { state: 'done' })).status).toBe(200);
    expect((await stateOf(t))).toMatchObject({ nextStep: 'products', prompts: { customers: { state: 'done' }, counts: { customers: 3 } } });
    expect((await w.post(t.owner, '/prompts/products', { state: 'skipped' })).status).toBe(200);
    expect((await stateOf(t))).toMatchObject({ nextStep: 'promotion', prompts: { products: { state: 'skipped' } } });
  });

  test('step 5 (ruling 4): the test message to the owner\'s OWN phone comes first, from the merchant number', async () => {
    const info = await w.get(t.owner, '/first-promotion');
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ ready: true, sendPolicy: 'block', state: 'locked', missing: { template: false }, suggestion: { audience: { optedIn: 2, total: 3 } } });
    expect(info.body.testRecipient).toEqual({ masked: expect.stringMatching(/^\*+\d{4}$/), needsPhone: false });
    const sent = await w.post(t.owner, '/test-message', {});
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ sent: true, templateKey: 'setup_test' });
    expect(sent.body.to).toMatch(/^\*+\d{4}$/);
    const msg = ctx.graph.sentMessages().filter((m) => m.template && /setup_test/.test(m.template.name));
    expect(msg).toHaveLength(1);
    expect(msg[0].phoneId).toBe(ctx.graph.ids.phoneId);
    expect(msg[0].token).toBe(ctx.graph.ids.merchantToken);
    expect(msg[0].to).toBe(t.owner.phone);
    expect(w.graph.platformCalls).toHaveLength(0);
    expect((await stateOf(t)).firstPromotion).toMatchObject({ testMessageCount: 1 });
  });

  test('step 5: the first Promotion hand-off; under policy block only "skipped" finishes the setup', async () => {
    const done = await w.post(t.owner, '/first-promotion/state', { state: 'done' });
    expect(done.status).toBe(422);
    expect(done.body).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'SENDING_NOT_AVAILABLE_YET' } });
    expect((await w.post(t.owner, '/first-promotion/state', { state: 'started' })).status).toBe(200);
    expect((await stateOf(t)).view).toBe('setup');
    const skipped = await w.post(t.owner, '/first-promotion/state', { state: 'skipped' });
    expect(skipped.status).toBe(200);
    const s = await stateOf(t);
    expect(s).toMatchObject({ view: 'done', nextStep: null, progress: { status: 'completed' }, steps: { promotion: { status: 'skipped' } } });
    expect(s.progress.completedAt).toEqual(expect.any(String));
    expect(Object.values(s.steps).every((x) => ['done', 'skipped', 'in_progress'].includes(x.status))).toBe(true);
  });

  test('the journey sent nothing from the platform number and no console line carries a secret', async () => {
    expect(w.graph.platformCalls).toHaveLength(0);
    const secrets = [ctx.graph.ids.merchantToken, w.handle.env.appSecret, t.owner.phone, t.owner.token];
    for (const s of secrets) expect(con.lines.join('\n')).not.toContain(s);
    expect(con.lines.join('\n')).not.toMatch(/AQDe2eCODESECRET/);
  });
});

describe('B) Stripe checkout -> signed webhook -> active (the redirect is not proof)', () => {
  let t;
  let pay;
  beforeAll(async () => { t = await w.tenant('Journey B', { activate: false }); });

  test('none: the billing subset only; every setup route is refused with the 402 code', async () => {
    const s = await stateOf(t);
    expect(s).toMatchObject({ enrolled: true, view: 'billing', locked: true, subscription: { state: 'none', source: null, retry: { checkout: true } }, checkout: { available: true, plans: [{ code: 'basic', name: 'Basic' }, { code: 'pro', name: 'Pro' }] } });
    expect(s.steps).toBeUndefined();
    for (const [m, p, b] of [['put', '/business', { name: 'Journey B Shop' }], ['post', '/number/path', { hasNumber: false }], ['get', '/connect/config'], ['get', '/approvals'], ['get', '/templates'], ['post', '/test-message', {}]]) {
      const r = await w.call(t.owner, m, p, b);
      expect([m, p, r.status, r.body.code]).toEqual([m, p, 402, 'SUBSCRIPTION_REQUIRED']);
    }
    // the bell and the analytics beacons are billing-exempt (gate E): they answer for a workspace that has not paid yet, too
    const bell = await w.get(t.owner, '/notifications');
    expect([bell.status, bell.body]).toEqual([200, { notifications: [], unread: 0 }]);
    expect((await w.post(t.owner, '/events', { type: 'help_opened', step: 'billing' })).status).toBe(204);
  });

  test('checkout (owner only): a hosted https URL, the workspace reference, and the state turns pending', async () => {
    expect((await w.post(t.member, '/checkout', { planCode: 'basic' })).status).toBe(403);
    expect((await w.post(t.owner, '/checkout', { planCode: 'nope' })).body.code).toBe('PLAN_UNKNOWN');
    const co = await w.post(t.owner, '/checkout', { planCode: 'basic' });
    expect(co.status).toBe(200);
    expect(co.body.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const params = w.stripe.callsTo('checkout.sessions.create').pop().args.params;
    expect(params.client_reference_id).toBe(t.ws);
    expect(params.line_items[0].price).toBe('price_test_basic');
    expect(JSON.stringify(params)).not.toContain(t.owner.phone);
    expect(await stateOf(t)).toMatchObject({ view: 'billing', subscription: { state: 'pending' } });
    expect((await w.put(t.owner, '/business', { name: 'x' })).body.code).toBe('PAYMENT_PENDING');
    expect((await w.get(t.owner, '/notifications')).status).toBe(200); // pending: the bell works (gate E), the setup stays closed
    pay = { sessionId: String(co.body.url).split('/').pop() };
  });

  test('coming back from Stripe is NOT proof: the on-demand refresh asks Stripe and finds an unfinished session', async () => {
    const r = await w.post(t.owner, '/billing/refresh', {});
    expect(r.status).toBe(200);
    expect(r.body.subscription.state).toBe('pending');
    expect((await w.get(t.owner, '/state')).body.subscription.state).toBe('pending');
    expect((await w.post(t.owner, '/billing/refresh', {})).status).toBe(429); // 1 per 15 s
  });

  test('an UNSIGNED or wrongly signed delivery changes nothing', async () => {
    const d = w.stripe.completeCheckout(pay.sessionId, { businessName: 'Journey B Shop', email: t.owner.email });
    const evt = w.stripe.signedEvent({ type: 'checkout.session.completed', object: d.session });
    const unsigned = await w.agent.post('/stripe-billing-webhook').set('content-type', 'application/json').send(evt.payload);
    expect(unsigned.status).toBe(400);
    const wrong = w.stripe.signedEvent({ type: 'checkout.session.completed', object: d.session, secret: 'whsec_not_the_secret_at_all_000000' });
    const bad = await w.agent.post('/stripe-billing-webhook').set('stripe-signature', wrong.header).set('content-type', 'application/json').send(wrong.payload);
    expect(bad.status).toBe(400);
    expect((await w.get(t.owner, '/state')).body.subscription.state).toBe('pending');
    pay.signed = evt;
    pay.subscription = d.subscription;
  });

  test('the signed webhook activates the workspace; replaying it changes nothing; setup resumes', async () => {
    const hook = await w.agent.post('/stripe-billing-webhook').set('stripe-signature', pay.signed.header).set('content-type', 'application/json').send(pay.signed.payload);
    expect(hook.status).toBe(200);
    const s = await stateOf(t);
    expect(s).toMatchObject({ view: 'setup', subscription: { state: 'active', source: 'stripe' }, nextStep: 'business', locked: true });
    const first = await w.rowOf(t.ws);
    const again = await w.agent.post('/stripe-billing-webhook').set('stripe-signature', pay.signed.header).set('content-type', 'application/json').send(pay.signed.payload);
    expect(again.status).toBe(200);
    const second = await w.rowOf(t.ws);
    expect(second.subscription.changedAt).toEqual(first.subscription.changedAt);
    expect((await w.put(t.owner, '/business', w.BUSINESS(t))).status).toBe(200);
    // prefill from checkout is available to the business step (name + e-mail), never a phone
    expect(first.prefill).toMatchObject({ businessName: 'Journey B Shop', email: t.owner.email });
  });

  test('a second checkout is refused while the subscription is live (SUBSCRIPTION_EXISTS carries the state)', async () => {
    const r = await w.post(t.owner, '/checkout', { planCode: 'pro' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'SUBSCRIPTION_EXISTS', nextStep: 'billing', subscription: { state: 'active' } });
    const p = await w.post(t.owner, '/billing-portal', {});
    expect(p.status).toBe(200);
    expect(p.body.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
  });
});

describe('C) resume from a second token (second device)', () => {
  test('a fresh login of the same user sees exactly the same state and lands on the same next step', async () => {
    const t = await w.tenant('Journey C');
    await w.put(t.owner, '/business', w.BUSINESS(t));
    await w.post(t.owner, '/number/path', { hasNumber: true, usage: 'personal', acknowledgeRemoval: true });
    await new Promise((r) => setTimeout(r, 1100)); // a JWT carries whole seconds: a second login must differ
    const second = { ...t.owner, token: await w.login(t.owner.phone) };
    expect(second.token).not.toBe(t.owner.token);
    const a = (await w.get(t.owner, '/state')).body;
    const b = (await w.get(second, '/state')).body;
    expect(scrub(a)).toEqual(scrub(b));
    expect(b).toMatchObject({ nextStep: 'connect', steps: { business: { status: 'done' }, number: { status: 'done' } }, number: { usage: 'personal', personalWarningAcknowledged: true } });
    // the second device carries on: connect there
    const ctx = await w.prepareConnect({ ...t, owner: second });
    const done = await w.complete({ ...t, owner: second }, ctx);
    expect(done.status).toBe(200);
    expect((await w.get(t.owner, '/state')).body).toMatchObject({ nextStep: 'approvals', connection: { level: 'connected' } });
  });
});

describe('D) the legacy send policy decides what a connected workspace may send through the OLD senders', () => {
  let t;
  beforeAll(async () => { t = await w.tenant('Journey D'); await w.connectTenant(t); });
  afterAll(() => { process.env.ONBOARDING_LEGACY_SEND_POLICY = 'block'; w.state.clearCache(); });

  test('block (default): the old send routes answer 402 SENDING_NOT_AVAILABLE_YET before the route runs; reads are untouched', async () => {
    const r = await w.agent.post('/api/promotions/000000000000000000000001/send').set('Authorization', `Bearer ${t.owner.token}`).send({});
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('SENDING_NOT_AVAILABLE_YET');
    expect((await w.agent.get('/api/promotions').set('Authorization', `Bearer ${t.owner.token}`)).status).toBe(200);
    expect((await w.get(t.owner, '/state')).body.sendingPaused).toEqual({ code: 'SENDING_NOT_AVAILABLE_YET' });
    expect(w.graph.platformCalls).toHaveLength(0);
  });

  test('platform_number (explicit owner opt-in): the guard lets the request reach the route; /state stops saying "paused"', async () => {
    process.env.ONBOARDING_LEGACY_SEND_POLICY = 'platform_number';
    w.state.clearCache();
    const r = await w.agent.post('/api/promotions/000000000000000000000001/send').set('Authorization', `Bearer ${t.owner.token}`).send({});
    expect(r.status).not.toBe(402);
    expect((await w.get(t.owner, '/state')).body.sendingPaused).toBeNull();
    expect((await w.get(t.owner, '/first-promotion')).body.sendPolicy).toBe('platform_number');
  });
});
