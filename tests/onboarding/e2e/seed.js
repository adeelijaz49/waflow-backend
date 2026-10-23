'use strict';
// SANDBOX-ONLY seed (task I1b): fills an EMPTY throwaway database with the workspace set of DF section 9, going through
// the REAL modules and the REAL HTTP surface wherever possible (state.enrol / adminActivate, the onboarding API behind
// real JWTs, the real signed Stripe and Meta webhooks, the real connect orchestration against the fake Graph).
//
//   W0 legacy (no sidecar, completed:true)            W6 reconnect_required
//   W0b legacy self-serve (completed:false)           W7 past_due, mid-onboarding (paid through Stripe, then the payment failed)
//   W1 enrolled, subscription none                    W8 cancelled + finished
//   W2 enrolled, pending (checkout started)           W9 finished, customers prompt skipped
//   W3 active, not started                            W10 MEMBER (non-owner) of W5
//   W4 active, Path B paused                          W11 Arabic-preferring owner (active, business done)
//   W5 connected, approvals mixed (verification waiting, name declined NAME_NOT_CONSISTENT, payment unknown, TIER_250,
//      templates 5 approved / 2 pending / 1 rejected, 3 opted-in customers)
//
// Login tokens come from the platform's own AUTH_TEST_MODE login path (POST /api/auth/otp/request -> testCode ->
// /otp/verify), exactly like tests/ does. The result is written to a JSON file (ids, phones, tokens, expectations,
// the per-workspace fake-Graph options the launcher needs to rebuild the fakes). No deletes: the seed refuses a
// database that already has workspaces (use a fresh database name).
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { boot } = require('./boot');

const DEFAULT_OUT = path.join(require('os').tmpdir(), 'waflow-onboarding-e2e', 'e2e-seed.json');
const flat = (s) => Object.assign({ event: s.event }, s.data);

function tag(n) { return String(n).padStart(2, '0'); }

/**
 * @param {object} handle the boot() result
 * @returns {Promise<{workspaces:object, graph:object, summary:object}>}
 */
async function seed(handle) {
  const Workspace = handle.model('Workspace');
  const User = handle.model('User');
  const Membership = handle.model('Membership');
  const Customer = handle.model('Customer');
  const state = require('../../../shared/onboarding/state');
  const legal = require('../../../shared/legalAcceptance');
  const starter = require('../../../shared/onboarding/starterTemplates');
  const agent = request(handle.app);

  if (await Workspace.countDocuments({}) > 0) throw new Error('seed: the database is not empty (use a fresh waflow_loc_test_* database name; the seed never deletes)');

  const out = { workspaces: {}, graph: {} };
  let phoneSeq = 0;
  let wsSeq = 0;

  const call = async (method, url, token, body, expected) => {
    let r = agent[method](url);
    if (token) r = r.set('Authorization', `Bearer ${token}`);
    if (body !== undefined && method !== 'get') r = r.send(body);
    const res = await r;
    // a completed connect starts the immediate starter-template submission IN THE BACKGROUND (connect.js, never awaited by the answer):
    // the seed waits for it, so every later step (and the written seed file) describes a settled world
    if (url.endsWith('/connect/complete') || url.endsWith('/connect/resume')) await require('../../../shared/onboarding/connect')._internal.idle();
    const ok = expected === undefined ? res.status >= 200 && res.status < 300 : [].concat(expected).includes(res.status);
    if (!ok) throw new Error(`seed: ${method.toUpperCase()} ${url} answered ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    return res;
  };

  async function login(phone) {
    const a = await agent.post('/api/auth/otp/request').send({ phone });
    if (a.status !== 200 || !a.body.testCode) throw new Error(`seed: otp/request failed (${a.status})`);
    const v = await agent.post('/api/auth/otp/verify').send({ phone, code: a.body.testCode });
    if (v.status !== 200 || !v.body.token) throw new Error(`seed: otp/verify failed (${v.status} ${JSON.stringify(v.body).slice(0, 200)})`);
    return v.body;
  }

  async function makeWorkspace(label, name, { completed = false, createdAt } = {}) {
    wsSeq += 1;
    const at = createdAt || new Date(Date.UTC(2026, 9, 1, 0, wsSeq));
    const res = await Workspace.collection.insertOne({ name, createdAt: at, updatedAt: at, onboarding: { completed, currentStep: 1 } });
    return String(res.insertedId);
  }
  async function makeUser(label, who, extra = {}) {
    phoneSeq += 1;
    const phone = `96650${String(7000000 + phoneSeq * 11).slice(0, 7)}`;
    const u = await User.create({ phone, email: `${label.toLowerCase()}-${who}@example.test`, name: `E2E ${label} ${who}`, ...extra });
    return { id: String(u._id), phone, email: u.email };
  }
  async function person(label, ws, who, role) {
    const u = await makeUser(label, who);
    await Membership.create({ userId: u.id, workspaceId: ws, role });
    const session = await login(u.phone);
    if (role === 'owner') {
      await legal.recordCombinedAcceptance({ userId: u.id, workspaceId: ws, role: 'owner' });
      await legal.recordDpaAcceptance({ userId: u.id, workspaceId: ws, role: 'owner' });
    }
    return { ...u, role, token: session.token };
  }
  function register(label, ws, kind, people, extra) {
    out.workspaces[label] = { id: ws, label, kind, ...people, ...(extra || {}) };
    return out.workspaces[label];
  }

  async function enrolWs(ws, activate) {
    await state.enrol({ workspaceId: ws, by: 'cli:e2e-seed' });
    if (activate) await state.adminActivate({ workspaceId: ws, by: 'cli:e2e-seed', notes: 'e2e seed activation' });
    state.invalidate(ws);
  }

  const BIZ = (label, industry, extra) => ({ name: `E2E ${label} Shop`, country: 'SA', industry, ...(extra || {}) });
  const FAKE_NUMBERS = {};
  const onb = (token, method, url, body, expected) => call(method, `/api/onboarding${url}`, token, body, expected);

  async function deliverStripe(type, object) {
    const d = handle.stripe.signedEvent({ type, object });
    const r = await agent.post('/stripe-billing-webhook').set('stripe-signature', d.header).set('content-type', 'application/json').send(d.payload); // a string: superagent would JSON-serialise a Buffer
    if (r.status !== 200) throw new Error(`seed: stripe webhook ${type} answered ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return r.body;
  }
  /** Pay through the real checkout + the real signed webhook; returns the fake subscription. */
  async function payViaStripe(w) {
    const co = await onb(w.owner.token, 'post', '/checkout', { planCode: 'basic' });
    const sessionId = String(co.body.url).split('/').pop();
    const done = handle.stripe.completeCheckout(sessionId, { businessName: `E2E ${w.label} Shop`, email: w.owner.email });
    await deliverStripe('checkout.session.completed', done.session);
    return done.subscription;
  }

  /** business + number (Path A) + the real connect orchestration against its OWN fake WhatsApp Business account. */
  async function connectWs(w, industry, graphOptions = {}) {
    FAKE_NUMBERS[w.label] = FAKE_NUMBERS[w.label] || `+966 55 9${tag(Object.keys(FAKE_NUMBERS).length + 10)} 4567`;
    const opts = { displayNumber: FAKE_NUMBERS[w.label], verifiedName: `E2E ${w.label} Shop`, wabaName: `E2E ${w.label} Shop`, ...graphOptions };
    handle.graph.newTarget(w.label, opts);
    out.graph[w.label] = opts;
    await onb(w.owner.token, 'put', '/business', BIZ(w.label, industry));
    await onb(w.owner.token, 'post', '/number/path', { hasNumber: true, usage: 'unused' });
    const cfg = await onb(w.owner.token, 'get', '/connect/config');
    const g = handle.graph.get(w.label);
    const done = await onb(w.owner.token, 'post', '/connect/complete', { attemptId: cfg.body.attemptId, code: `AQDseed${w.label}CodeSECRET0001valueXYZ`, session: flat(g.session('FINISH')) });
    if (!['connected', 'needs_attention'].includes(done.body.status)) throw new Error(`seed: ${w.label} connect ended ${done.body.status}`);
    return g;
  }
  async function finishSetup(w) {
    await onb(w.owner.token, 'get', '/approvals'); // opens step 4
    await onb(w.owner.token, 'post', '/prompts/customers', { state: 'skipped' });
    await onb(w.owner.token, 'post', '/prompts/products', { state: 'skipped' });
    await onb(w.owner.token, 'post', '/first-promotion/state', { state: 'skipped' });
  }
  async function metaWebhook(g, wabaId, payloadFor) {
    const payload = payloadFor(g);
    const raw = JSON.stringify(payload);
    const r = await agent.post('/webhook').set('content-type', 'application/json').set('x-hub-signature-256', g.webhook.sign(raw, handle.env.appSecret)).send(raw);
    if (r.status !== 200) throw new Error(`seed: meta webhook answered ${r.status}`);
    await new Promise((res) => setTimeout(res, 150)); // the handler answers 200 first and processes after
  }

  // ---- W0 legacy, W0b legacy self-serve --------------------------------------------------------------------------
  const w0 = await makeWorkspace('W0', "E2E W0 Legacy Workspace", { completed: true, createdAt: new Date('2026-01-01T00:00:00Z') });
  register('W0', w0, 'legacy', { owner: await person('W0', w0, 'owner', 'owner') });
  const w0bPhone = '966501999000';
  const w0bSession = await login(w0bPhone); // a brand-new login = the platform's self-serve signup: a workspace with completed:false
  const w0bUser = await User.findOne({ phone: w0bPhone }).lean();
  const w0b = String(w0bSession.workspace.id);
  await legal.recordCombinedAcceptance({ userId: String(w0bUser._id), workspaceId: w0b, role: 'owner' });
  await legal.recordDpaAcceptance({ userId: String(w0bUser._id), workspaceId: w0b, role: 'owner' });
  register('W0b', w0b, 'legacy_self_serve', { owner: { id: String(w0bUser._id), phone: w0bPhone, email: null, role: 'owner', token: w0bSession.token } });

  // ---- W1 none, W2 pending ---------------------------------------------------------------------------------------
  const w1 = await makeWorkspace('W1', 'E2E W1 Not Paid');
  const W1 = register('W1', w1, 'enrolled_none', { owner: await person('W1', w1, 'owner', 'owner') });
  await enrolWs(w1, false);
  const w2 = await makeWorkspace('W2', 'E2E W2 Checkout Started');
  const W2 = register('W2', w2, 'enrolled_pending', { owner: await person('W2', w2, 'owner', 'owner') });
  await enrolWs(w2, false);
  await onb(W2.owner.token, 'post', '/checkout', { planCode: 'basic' });

  // ---- W3 active/not started, W4 Path B paused, W11 Arabic ------------------------------------------------------
  const w3 = await makeWorkspace('W3', 'E2E W3 Active Not Started');
  const W3 = register('W3', w3, 'active_not_started', { owner: await person('W3', w3, 'owner', 'owner') });
  await enrolWs(w3, true);
  const w4 = await makeWorkspace('W4', 'E2E W4 Path B Paused');
  const W4 = register('W4', w4, 'active_path_b', { owner: await person('W4', w4, 'owner', 'owner') });
  await enrolWs(w4, true);
  await onb(W4.owner.token, 'put', '/business', BIZ('W4', 'salon_beauty'));
  await onb(W4.owner.token, 'post', '/number/path', { hasNumber: false });
  const w11 = await makeWorkspace('W11', 'E2E W11 Arabic Owner');
  const W11 = register('W11', w11, 'active_arabic', { owner: await person('W11', w11, 'owner', 'owner') });
  await enrolWs(w11, true);
  await onb(W11.owner.token, 'put', '/business', { ...BIZ('W11', 'restaurant'), uiLanguage: 'ar', languages: ['ar', 'en'] });
  await onb(W11.owner.token, 'post', '/preferences', { uiLanguage: 'ar', languages: ['ar', 'en'] });

  // ---- W5 connected, approvals mixed (+ W10 member) ----------------------------------------------------------------
  const w5 = await makeWorkspace('W5', 'E2E W5 Connected Mixed');
  const W5 = register('W5', w5, 'connected_mixed', { owner: await person('W5', w5, 'owner', 'owner') });
  await enrolWs(w5, true);
  W5.member = await person('W10', w5, 'member', 'member');
  register('W10', w5, 'member_of_W5', { owner: null, member: W5.member });
  const g5 = await connectWs(W5, 'fashion', { verificationStatus: 'pending', nameStatus: 'DECLINED', tier: 'TIER_250' });
  out.graph.W5 = { ...out.graph.W5, verificationStatus: 'pending', nameStatus: 'DECLINED', tier: 'TIER_250' };
  // submit the starter set (5 per call) and set the statuses through REAL signed webhooks
  for (let i = 0; i < 3; i += 1) await starter.submitPending({ workspaceId: w5 });
  const enRows = (await handle.model('OnboardingTemplate').find({ workspaceId: w5, language: 'en', metaTemplateName: { $exists: true, $ne: null } }).lean());
  const order = ['setup_test', 'welcome_optin', 'promotion_weekend', 'promotion_new_arrival', 'comeback', 'points_balance', 'order_confirmation', 'booking_confirmation'];
  const byKey = new Map(enRows.map((r) => [r.key, r]));
  for (let i = 0; i < order.length; i += 1) {
    const row = byKey.get(order[i]);
    if (!row) throw new Error(`seed: W5 template ${order[i]} was not submitted`);
    const status = i < 5 ? 'APPROVED' : (i === 7 ? 'REJECTED' : 'PENDING');
    if (status === 'PENDING') continue;
    g5.setTemplateStatus(row.metaTemplateName, 'en', status, status === 'REJECTED' ? 'INVALID_FORMAT' : undefined);
    await metaWebhook(g5, null, (g) => g.webhook.templateStatus(row.metaTemplateName, 'en', status, status === 'REJECTED' ? 'INVALID_FORMAT' : undefined));
  }
  await metaWebhook(g5, null, (g) => g.webhook.envelope('phone_number_name_update', { display_phone_number: FAKE_NUMBERS.W5, decision: 'REJECTED', requested_verified_name: 'E2E Mixed Shop Co', rejection_reason: 'NAME_NOT_CONSISTENT' }));
  for (const [i, c] of [['Amal', true], ['Basma', true], ['Carim', true], ['Dana', false]].entries()) {
    const [firstname, consent] = c;
    await Customer.create({ workspaceId: w5, firstname, lastname: 'Seed', phone: `96655500${tag(i + 10)}1`, marketingConsent: consent, ...(consent ? { marketingConsentAt: new Date(), marketingConsentMethod: 'manual_staff_entry' } : {}) });
  }
  await onb(W5.owner.token, 'get', '/approvals');

  // ---- W6 reconnect_required --------------------------------------------------------------------------------------
  const w6 = await makeWorkspace('W6', 'E2E W6 Reconnect');
  const W6 = register('W6', w6, 'reconnect_required', { owner: await person('W6', w6, 'owner', 'owner') });
  await enrolWs(w6, true);
  const g6 = await connectWs(W6, 'grocery');
  g6.scenarios.token190();
  await onb(W6.owner.token, 'post', '/connection/refresh', {}, [200, 429, 409, 503]);
  out.graph.W6 = { ...out.graph.W6, scenarios: ['token190'] };

  // ---- W7 past_due mid-onboarding (Stripe) ------------------------------------------------------------------------
  const w7 = await makeWorkspace('W7', 'E2E W7 Past Due');
  const W7 = register('W7', w7, 'past_due', { owner: await person('W7', w7, 'owner', 'owner') });
  await enrolWs(w7, false);
  const sub7 = await payViaStripe(W7);
  await onb(W7.owner.token, 'put', '/business', BIZ('W7', 'electronics'));
  await onb(W7.owner.token, 'post', '/number/path', { hasNumber: true, usage: 'unused' });
  handle.stripe.setSubscription({ ...sub7, status: 'past_due' });
  await deliverStripe('invoice.payment_failed', handle.stripe.makeInvoice({ subscription: sub7.id, customer: sub7.customer, status: 'open', billingReason: 'subscription_cycle', attemptCount: 1 }));

  // ---- W8 cancelled + finished (Stripe), W9 finished with customers skipped ------------------------------------
  const w8 = await makeWorkspace('W8', 'E2E W8 Cancelled Finished');
  const W8 = register('W8', w8, 'cancelled_finished', { owner: await person('W8', w8, 'owner', 'owner') });
  await enrolWs(w8, false);
  const sub8 = await payViaStripe(W8);
  await connectWs(W8, 'health');
  await finishSetup(W8);
  const cancelled = handle.stripe.setSubscription({ ...sub8, status: 'canceled', canceledAt: Math.floor(Date.now() / 1000) });
  await deliverStripe('customer.subscription.deleted', cancelled);

  const w9 = await makeWorkspace('W9', 'E2E W9 Finished');
  const W9 = register('W9', w9, 'finished_customers_skipped', { owner: await person('W9', w9, 'owner', 'owner') });
  await enrolWs(w9, true);
  await connectWs(W9, 'fitness');
  await finishSetup(W9);

  // ---- expectations (what each workspace's /state says right after the seed) -----------------------------------
  const summary = {};
  for (const label of Object.keys(out.workspaces)) {
    const w = out.workspaces[label];
    const who = w.owner || w.member;
    const s = await agent.get('/api/onboarding/state').set('Authorization', `Bearer ${who.token}`);
    summary[label] = { status: s.status, enrolled: s.body.enrolled, view: s.body.view, subscription: s.body.subscription && s.body.subscription.state, nextStep: s.body.nextStep, locked: s.body.locked, connection: s.body.connection ? s.body.connection.level : null, sendingPaused: s.body.sendingPaused ? s.body.sendingPaused.code : null };
    w.expect = summary[label];
  }
  return { workspaces: out.workspaces, graph: out.graph, summary };
}

async function main() {
  const handle = await boot({ policy: process.env.E2E_POLICY || 'block' });
  const result = await seed(handle);
  const file = process.env.E2E_SEED_FILE || DEFAULT_OUT;
  const doc = {
    generatedAt: new Date().toISOString(), db: handle.db, policy: process.env.ONBOARDING_LEGACY_SEND_POLICY,
    backend: { appPort: Number(process.env.E2E_PORT || 3100), controlPort: Number(process.env.E2E_CONTROL_PORT || 3199), jwtSecretIsSandboxOnly: true },
    workspaces: result.workspaces, graph: result.graph,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`[e2e-seed] ${Object.keys(result.workspaces).length} workspaces seeded in ${handle.db}; written to ${file}`);
  console.log(JSON.stringify(result.summary, null, 2));
  await handle.stop();
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => { console.error('[e2e-seed] failed:', err && err.stack || err); process.exit(1); });
}

module.exports = { seed, main, DEFAULT_OUT };
