'use strict';
// CHARACTERISATION TEST #2: the EXISTING WhatsApp-sending / customer code paths that the Arabic wiring phase will touch
// must behave identically for English / unflagged merchants (flag off), under the kill switch, and for a flagged
// merchant whose audience is entirely English. Companion of englishUnchanged.itest.js (which covers the webhook
// text/keyword surface); this one covers the senders: shared/operations.js (promotions, test sends, loyalty reminders,
// consent requests, booking messages, orders), shared/referrals.js, shared/inbox.js, shared/consent.js,
// utils/flowScheduler.js + utils/flowTriggers/*, utils/whatsapp.js, the shopping journey behind POST /webhook,
// status callbacks, the Stripe webhook, the HTTP routes in front of all of it, and the CSV customer import.
//
// It boots the real server.js against the THROWAWAY mongod with the axios adapter stubbed (nothing leaves the machine),
// records every outbound call and the documents each scenario creates/changes (see helpers/_eng2.js), and must run
// UNCHANGED on the pristine pre-Arabic backend and on the modified one:
//
//   ENG_RECORD=1  on the BASELINE copy  -> writes the golden file (ENG_GOLDEN_FILE)
//   (default)     on the MODIFIED copy  -> asserts the same record per scenario
//
// Modes (env):  (none) = flag off | LOCALIZATION_DISABLED=1 = kill switch | ENG_FLAG=on = LocaleSettings.arabicEnabled
// for the workspaces PLUS an Arabic-language bystander customer (CustomerLanguage 'ar') who is NOT part of any scenario's
// audience (every audience member is English, so results must still equal baseline). ENG_FLAG=on needs the modified code.
//
// APPROVED differences (explicit, keyed by scenario - see helpers/_eng2.js): H1 'dup/...' (a STOP opts out every record
// of the same normalised phone), C3 'status/...' (Meta error code stored on a failed status callback), B2 'import/arabic...',
// and B4 '(B4 ...)' scenarios (a one-word WhatsApp profile name creates the customer) in the ENG_FLAG=on mode only.
// C3 is exactly CampaignMessage.errorCode (a String) on a failed status callback; B4J = B4 for the journey replies that depend on the customer
// record existing (flag on only: anything may differ). Section 10 at the end was added after a v8 coverage run of sections 1-9: it covers
// the sender / opt-out / phone code those scenarios never reached (see the audit in the validation report). Scenario names must be unique.
// Always use a FRESH database name per run.
const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const E = require('./helpers/_eng2');
const { H, FLAG_ON, KILL, RECORD, NEW_COLLECTION_RE, sleep, scenario, isMsgType, isMsgTo, isMessage, envelope, textMsg, tplBtn, ibtn, lrow, statusPayload } = E;

// Stripe: deterministic, offline. Payment intent ids are unique per scenario (orders are matched by PI id).
const mockStripeCtl = { scenario: 0, seq: 0, store: {}, failCreate: false };
jest.mock('stripe', () => () => ({
  paymentIntents: {
    create: async (args) => {
      if (mockStripeCtl.failCreate) { mockStripeCtl.failCreate = false; throw new Error('stripe stub: temporarily unavailable'); }
      const id = `pi_stub_S${mockStripeCtl.scenario}_${++mockStripeCtl.seq}`;
      mockStripeCtl.store[id] = { id, ...args, status: 'requires_payment_method', client_secret: `${id}_secret_x` };
      return mockStripeCtl.store[id];
    },
    retrieve: async (id) => { if (!mockStripeCtl.store[id]) throw new Error('No such payment_intent'); return mockStripeCtl.store[id]; },
  },
  webhooks: { constructEvent: (body) => JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body)) },
}));

jest.setTimeout(120000);

// ── fixtures ─────────────────────────────────────────────────────────────────
const Q = (m) => require(`../../../models/${m}`);
const ops = () => require('../../../shared/operations');
const sched = () => require('../../../utils/flowScheduler');
const refs = () => require('../../../shared/referrals');
const inboxMod = () => require('../../../shared/inbox');
const wa = () => require('../../../utils/whatsapp');
const state = () => require('../../../utils/state');
const F = {}; // fixtures
let W2; let restoreConsole; let arabicBystander; let arabicBystander2;
const D = (days) => new Date(Date.now() - days * 86400000);
const consented = { marketingConsent: true, marketingConsentAt: new Date(), marketingConsentMethod: 'manual_staff_entry' };
const optedOut = { ...consented, optedOut: true, optedOutAt: new Date() };
const ids = (...cs) => cs.map((c) => c._id);
const sids = (...cs) => cs.map((c) => String(c._id));
const lastPi = () => { const k = Object.keys(mockStripeCtl.store).filter((x) => x.startsWith(`pi_stub_S${H.scenarioNo}_`)); return mockStripeCtl.store[k[k.length - 1]]; };
const piEvent = (type, pi) => ({ id: 'evt_stub', type, data: { object: { id: pi.id, amount: pi.amount, currency: pi.currency, metadata: pi.metadata, status: 'succeeded' } } });

beforeAll(async () => {
  process.env.WA_TOKEN = process.env.WA_TOKEN || 'dummy';
  process.env.APP_URL = 'http://localhost:3999';
  restoreConsole = E.silenceConsole();
  E.installAdapter();
  H.app = require('../../../server');
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => (mongoose.connection.readyState === 1 ? resolve() : (Date.now() - t0 > 20000 ? reject(new Error('mongo not connected')) : setTimeout(poll, 100)));
    poll();
  });
  const modelsDir = path.join(__dirname, '../../../models');
  for (const f of fs.readdirSync(modelsDir)) if (f.endsWith('.js')) require(path.join(modelsDir, f));
  await Promise.all(Object.values(mongoose.models).map((m) => m.init().catch(() => {})));
  const db = mongoose.connection.db;
  if ((await db.collection('customers').countDocuments()) || (await db.collection('workspaces').countDocuments())) throw new Error('database is not fresh: use a new --db name for every run of englishUnchanged2.itest.js');

  const { JWT_SECRET, ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');
  if (!JWT_SECRET) throw new Error('AUTH_JWT_SECRET missing from the sandbox .env');

  H.W = (await Q('Workspace').create({ name: 'English Unchanged Fixture 2' }))._id;
  await sleep(25);
  W2 = (await Q('Workspace').create({ name: 'English Unchanged Fixture 2b' }))._id;
  H.userId = String(new mongoose.Types.ObjectId());
  H.token = jwt.sign({ sub: H.userId, workspaceId: String(H.W), role: 'owner' }, JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: '3h' });
  H.onScenarioStart = (n) => { mockStripeCtl.scenario = n; mockStripeCtl.seq = 0; mockStripeCtl.failCreate = false; };
  const W = H.W;

  await Q('Settings').create({ workspaceId: W, currency: 'SAR', merchantName: 'Eng Fixture Shop' });

  const mkP = (o) => Q('Product').create({ workspaceId: W, ...o });
  F.p1 = await mkP({ name: 'Blue Shirt', category: 'Shirts', basePrice: 25, description: 'Soft cotton shirt', images: ['https://img.example.test/blue-shirt.jpg'], variants: [{ size: 'M', color: 'Blue', stock: 5 }, { size: 'L', color: 'Blue', stock: 0 }, { size: 'S', color: 'Red', stock: 2 }] });
  F.p2 = await mkP({ name: 'Red Hat', category: 'Hats', basePrice: 12, images: ['https://img.example.test/red-hat.webp'] });
  F.p3 = await mkP({ name: 'Green Scarf', category: 'Scarves', basePrice: 18, description: 'Soft wool scarf' });
  F.p4 = await mkP({ name: 'Yellow Socks', category: 'Socks', basePrice: 6.5, images: ['https://img.example.test/socks.jpg'] });
  F.p5 = await mkP({ name: 'Black Belt', category: 'Belts', basePrice: 30, images: ['https://img.example.test/belt.jpg'] });
  F.bulk = [];
  for (let i = 1; i <= 12; i++) F.bulk.push(await mkP({ name: `Bulk ${String(i).padStart(2, '0')}`, category: 'Bulk', basePrice: 10 + i }));
  await mkP({ name: 'Retired Item', category: 'Old', basePrice: 5, active: false });

  F.svcA = await Q('Service').create({ workspaceId: W, name: 'Massage', category: 'Wellness', duration: 60, basePrice: 80, pointsPrice: 100, description: 'Relaxing hour', images: ['https://img.example.test/massage.jpg'] });
  F.svcB = await Q('Service').create({ workspaceId: W, name: 'Facial', category: 'Wellness', duration: 45, basePrice: 120, images: ['https://img.example.test/facial.jpg'] });
  const mkSlot = (svc, o) => Q('TimeSlot').create({ workspaceId: W, serviceId: svc._id, date: '2030-01-15', startTime: '09:00', endTime: '10:00', capacity: 50, bookedCount: 0, ...o });
  F.slotA1 = await mkSlot(F.svcA, {});
  F.slotA2 = await mkSlot(F.svcA, { date: '2030-01-16', startTime: '10:00', endTime: '11:00' });
  F.slotAfull = await mkSlot(F.svcA, { date: '2030-01-17', startTime: '10:00', endTime: '11:00', capacity: 1, bookedCount: 1 });
  F.slotB1 = await mkSlot(F.svcB, { date: '2030-02-01', startTime: '14:00', endTime: '14:45' });

  const mkPromo = (o) => Q('Promotion').create({ workspaceId: W, customerType: 'cash', scope: 'products', ...o });
  const mkNode = (o) => Q('MessageNode').create({ workspaceId: W, ...o });
  const pid = (...ps) => ps.map((p) => p._id);
  F.pEntry = await mkPromo({ name: 'Summer Entry', discountPercent: 20, products: pid(F.p1, F.p2), description: 'Hot deals' });
  F.nN2 = await mkNode({ ownerType: 'promotion', ownerId: F.pEntry._id, bodyText: 'All set {{1}}, see you soon!', depth: 2, buttons: [{ position: 0, label: 'Done', nextAction: { type: 'end_flow' } }] });
  F.nN1 = await mkNode({ ownerType: 'promotion', ownerId: F.pEntry._id, bodyText: 'Great {{1}}, pick one:', depth: 1, buttons: [
    { position: 0, label: 'Next', nextAction: { type: 'send_message', targetNodeId: F.nN2._id } },
    { position: 1, label: 'Redeem points', nextAction: { type: 'redeem_points' } },
    { position: 2, label: 'Get discount', nextAction: { type: 'apply_discount' } }] });
  F.nE = await mkNode({ ownerType: 'promotion', ownerId: F.pEntry._id, isEntryNode: true, templateName: 'waflow_flow_eng_entry1', templateStatus: 'approved', bodyText: 'Hi {{1}}! {{2}} for {{3}} in {{4}}.', buttons: [
    { position: 0, label: 'Show me', nextAction: { type: 'send_message', targetNodeId: F.nN1._id } },
    { position: 1, label: 'Not now', nextAction: { type: 'end_flow' } },
    { position: 2, label: 'Discount', nextAction: { type: 'apply_discount' } }] });
  await Q('Promotion').updateOne({ _id: F.pEntry._id }, { entryNodeId: F.nE._id });
  F.pEntry = await Q('Promotion').findById(F.pEntry._id);

  F.pPending = await mkPromo({ name: 'Pending Entry', discountPercent: 10, products: pid(F.p3, F.p4) });
  F.nPend = await mkNode({ ownerType: 'promotion', ownerId: F.pPending._id, isEntryNode: true, templateName: 'waflow_flow_eng_pending', templateStatus: 'pending', bodyText: 'Hello {{1}} {{2}}', buttons: [{ position: 0, label: 'Open', nextAction: { type: 'end_flow' } }] });
  await Q('Promotion').updateOne({ _id: F.pPending._id }, { entryNodeId: F.nPend._id });
  F.pPending = await Q('Promotion').findById(F.pPending._id);

  F.pPlain = await mkPromo({ name: 'Summer Sale', discountPercent: 15, description: 'Limited time only', products: pid(F.p1, F.p2, F.p3, F.p4, F.p5) });
  F.pSmall = await mkPromo({ name: 'Small Sale', discountPercent: 0, products: pid(F.p3, F.p4) });
  F.pPoints = await mkPromo({ name: 'Points Party', customerType: 'points', pointsPrice: 200, products: pid(F.p3, F.p4) });
  F.pPointsEntry = await mkPromo({ name: 'Points Entry', customerType: 'points', pointsPrice: 150, products: pid(F.p3, F.p4) });
  F.nPE = await mkNode({ ownerType: 'promotion', ownerId: F.pPointsEntry._id, isEntryNode: true, templateName: 'waflow_flow_eng_pointsentry', templateStatus: 'approved', bodyText: 'Hi {{1}}, redeem {{3}} for {{2}} ({{4}})', buttons: [{ position: 0, label: 'Redeem', nextAction: { type: 'end_flow' } }] });
  await Q('Promotion').updateOne({ _id: F.pPointsEntry._id }, { entryNodeId: F.nPE._id });
  F.pPointsEntry = await Q('Promotion').findById(F.pPointsEntry._id);
  F.pSvc = await mkPromo({ name: 'Spa Week', scope: 'services', type: 'specific_services', discountPercent: 10, services: pid(F.svcA, F.svcB) });
  F.pSvcPoints = await mkPromo({ name: 'Spa Points', scope: 'services', type: 'specific_services', customerType: 'points', pointsPrice: 100, services: pid(F.svcA) });
  F.pStoreWide = await mkPromo({ name: 'Store Wide', type: 'store_wide', discountPercent: 5 });
  F.pDemo = await mkPromo({ name: 'Demo Promo', isDemo: true, discountPercent: 25, products: pid(F.p1, F.p3) });
  F.pMany = await mkPromo({ name: 'Mega Sale', discountPercent: 30, products: F.bulk.map((p) => p._id) });
  F.pCarousel = await mkPromo({ name: 'Carousel Sale', discountPercent: 20, sendFormat: 'carousel', products: pid(F.p1, F.p4, F.p5) });
  F.pCarouselSvc = await mkPromo({ name: 'Carousel Spa', scope: 'services', type: 'specific_services', sendFormat: 'carousel', discountPercent: 10, services: pid(F.svcA, F.svcB) });
  F.pCarouselThin = await mkPromo({ name: 'Thin Carousel', sendFormat: 'carousel', products: pid(F.p3) });

  F.rp = await Q('ReferralPromotion').create({ workspaceId: W, name: 'Friends Rewards', status: 'active', friendRewardType: 'percent_discount', friendRewardValue: 10, referrerRewardType: 'loyalty_points', referrerRewardValue: 100, qualifyingAction: 'customer_created' });

  // bystanders: consented, no points, no orders, never in an audience. Arabic only when the flag is on.
  const mkBy = (ws, label, phone) => Q('Customer').create({ firstname: label, lastname: 'Bystander', phone, workspaceId: ws, ...consented });
  arabicBystander = await mkBy(W, 'ArabicBystander', '15550100001');
  arabicBystander2 = await mkBy(W2, 'ArabicBystander2', '15550100002');
  if (FLAG_ON) {
    for (const ws of [W, W2]) await Q('LocaleSettings').create({ workspaceId: ws, arabicEnabled: true, arabicEnabledAt: new Date() });
    await Q('CustomerLanguage').create({ workspaceId: W, customerId: arabicBystander._id, language: 'ar', languageSource: 'merchant_set' });
    await Q('CustomerLanguage').create({ workspaceId: W2, customerId: arabicBystander2._id, language: 'ar', languageSource: 'merchant_set' });
  }

  // warm-up: load every lazily required module before the first recorded scenario
  const request = require('supertest');
  const warm = await Q('Customer').create({ firstname: 'Warm', lastname: 'Up', phone: '15550100009', workspaceId: W, ...consented });
  await request(H.app).post('/webhook').send(envelope(textMsg(warm.phone, 'hello there'), 'Warm Up'));
  await sleep(1500);
  await request(H.app).post('/webhook').send(envelope(ibtn(warm.phone, 'shop_now', 'Shop'), 'Warm Up'));
  await sleep(800);
  await request(H.app).post('/webhook').send(statusPayload([{ id: 'wamid.NOPE', status: 'delivered', timestamp: '1760000000' }]));
  await sleep(800);
  H.prevStrings = null; H.calls = [];
});

afterAll(async () => { E.writeGolden(); if (restoreConsole) restoreConsole(); });

const eachRetire = (ctx) => ctx.afterRecord(async () => {
  const cids = ctx.created.map((c) => c._id);
  await Q('Customer').collection.updateMany({ _id: { $in: cids } }, { $set: { isDemo: true } });
  await Q('Order').collection.updateMany({ customer: { $in: cids } }, { $set: { paidAt: D(500), createdAt: D(500) } });
  await Q('Booking').collection.updateMany({ customerId: { $in: cids } }, { $set: { status: 'completed' } });
  await Q('Flow').collection.updateMany({ status: 'active' }, { $set: { status: 'paused' } });
});

// ══════════════════════════════════════════════════════════════════════════════
// 1. AUTOMATED FLOWS (first: the triggers read every workspace, so they must run before other scenarios create orders)
// ══════════════════════════════════════════════════════════════════════════════
describe('flows: default templates (scheduler driven)', () => {
  const oldOrder = (c, days, extra) => Q('Order').create({ customer: c._id, workspaceId: H.W, items: [{ productName: 'Old Tee', category: 'Shirts', quantity: 1, unitPrice: 20 }], subtotal: 20, total: 20, status: 'delivered', paymentStatus: 'paid', paidAt: D(days), createdAt: D(days), ...(extra || {}) });
  const newFlow = async (ctx, o, activate = true) => {
    const flow = await ops().createFlow({ name: `Flow ${o.triggerType}`, workspaceId: H.W, ...o });
    return activate ? ops().activateFlow({ id: flow._id, workspaceId: H.W }) : flow;
  };
  const drive = async (ctx, flow, passes = 2) => {
    await ctx.run('enroll', () => sched().enrollEligibleCustomers(flow));
    for (let i = 1; i <= passes; i++) await ctx.run(`send${i}`, () => sched().sendPendingEnrollments(flow));
  };

  scenario('flow/inactive_customer default template: eligible, recent, no orders, opted out, no consent, demo', async (ctx) => {
    const a = await ctx.cust('InactA', consented); await oldOrder(a, 90);
    const a2 = await ctx.cust('InactA2', consented); await oldOrder(a2, 75);
    const recent = await ctx.cust('InactRecent', consented); await oldOrder(recent, 10);
    await ctx.cust('InactNoOrders', consented);
    const oo = await ctx.cust('InactOptOut', optedOut); await oldOrder(oo, 90);
    const nc = await ctx.cust('InactNoConsent'); await oldOrder(nc, 90);
    const dm = await ctx.cust('InactDemo', { ...consented, isDemo: true }); await oldOrder(dm, 90);
    const flow = await newFlow(ctx, { triggerType: 'inactive_customer', inactivityDays: 60 });
    await drive(ctx, flow);
    await ctx.run('pause', () => ops().pauseFlow({ id: flow._id, workspaceId: H.W }));
    await ctx.run('report', () => ops().getFlowReport({ flowId: flow._id, workspaceId: H.W }));
    await ctx.run('enrollments', () => ops().listFlowEnrollments({ flowId: flow._id, workspaceId: H.W }));
    eachRetire(ctx);
  });
  scenario('flow/inactive_customer: reordered / opted out / consent withdrawn between enrolment and send', async (ctx) => {
    const re = await ctx.cust('InactReorder', consented); await oldOrder(re, 90);
    const oo = await ctx.cust('InactLateOptOut', consented); await oldOrder(oo, 90);
    const nc = await ctx.cust('InactLateNoConsent', consented); await oldOrder(nc, 90);
    const flow = await newFlow(ctx, { triggerType: 'inactive_customer', inactivityDays: 60 });
    await ctx.run('enroll', () => sched().enrollEligibleCustomers(flow));
    await oldOrder(re, 1);
    await Q('Customer').updateOne({ _id: oo._id }, { optedOut: true, optedOutAt: new Date() });
    await Q('Customer').updateOne({ _id: nc._id }, { marketingConsent: false });
    await ctx.run('send', () => sched().sendPendingEnrollments(flow));
    eachRetire(ctx);
  });
  scenario('flow/inactive_customer: cross-flow cooldown blocks, cooldownDaysOverride 0 lets it through', async (ctx) => {
    const a = await ctx.cust('CoolA', consented); await oldOrder(a, 90);
    const b = await ctx.cust('CoolB', consented); await oldOrder(b, 90);
    const other = await Q('Flow').create({ workspaceId: H.W, name: 'Other flow', triggerType: 'post_purchase_points', templateName: 'x' });
    await Q('CampaignMessage').create({ workspaceId: H.W, kind: 'flow', flow: other._id, customer: a._id, phone: a.phone, messageType: 'template', status: 'sent', sentAt: new Date() });
    const blocked = await newFlow(ctx, { triggerType: 'inactive_customer', inactivityDays: 60 });
    await ctx.run('enroll1', () => sched().enrollEligibleCustomers(blocked));
    await ctx.run('send1', () => sched().sendPendingEnrollments(blocked));
    await Q('Flow').updateOne({ _id: blocked._id }, { status: 'paused' });
    const open = await newFlow(ctx, { triggerType: 'inactive_customer', inactivityDays: 60, cooldownDaysOverride: 0 });
    await ctx.run('enroll2', () => sched().enrollEligibleCustomers(open));
    await ctx.run('send2', () => sched().sendPendingEnrollments(open));
    eachRetire(ctx);
  });
  scenario('flow/inactive_customer: requiresPriorFlow escalation (30 -> 60 days)', async (ctx) => {
    const a = await ctx.cust('EscalA', consented); await oldOrder(a, 90);
    const b = await ctx.cust('EscalB', consented); await oldOrder(b, 40);
    const stage1 = await newFlow(ctx, { triggerType: 'inactive_customer', inactivityDays: 30, cooldownDaysOverride: 0 });
    await drive(ctx, stage1, 1);
    const stage2 = await newFlow(ctx, { triggerType: 'inactive_customer', inactivityDays: 60, requiresPriorFlowId: stage1._id, cooldownDaysOverride: 0 });
    await drive(ctx, stage2, 1);
    eachRetire(ctx);
  });
  scenario('flow/inactive_customer: template send rejected by Meta -> failed CampaignMessage', async (ctx) => {
    const a = await ctx.cust('InactFail', consented); await oldOrder(a, 90);
    const flow = await newFlow(ctx, { triggerType: 'inactive_customer', inactivityDays: 60 });
    ctx.fail(isMsgType('template'), { code: 132001, message: 'Template name does not exist in the translation' });
    await drive(ctx, flow, 1);
    eachRetire(ctx);
  });
  scenario('flow/post_purchase_points default template: due, not yet due, refunded, opted out, no consent, demo', async (ctx) => {
    const mk = async (label, fields, orderExtra) => { const c = await ctx.cust(label, fields); await Q('Order').create({ customer: c._id, workspaceId: H.W, items: [{ productName: 'Tee', category: 'Shirts', quantity: 1, unitPrice: 20 }], subtotal: 20, total: 20, status: 'confirmed', paymentStatus: 'paid', paidAt: D(5 / 24), loyaltyPointsEarned: 100, ...(orderExtra || {}) }); return c; };
    await mk('PostDue', { ...consented, loyaltyPoints: 250 });
    await mk('PostDue2', { ...consented, loyaltyPoints: 100 });
    await mk('PostSoon', { ...consented, loyaltyPoints: 100 }, { paidAt: D(0.5 / 24) });
    await mk('PostRefunded', consented, { paymentStatus: 'refunded' });
    await mk('PostOptOut', optedOut);
    await mk('PostNoConsent', {});
    await mk('PostDemo', { ...consented, isDemo: true });
    const flow = await newFlow(ctx, { triggerType: 'post_purchase_points', delayHours: 2 });
    await drive(ctx, flow);
    await Q('Flow').updateOne({ _id: flow._id }, { status: 'paused' });
    eachRetire(ctx);
  });
  scenario('flow/points_balance_reminder default template', async (ctx) => {
    await ctx.cust('PtsStale', { ...consented, loyaltyPoints: 500, loyaltyPointsUpdatedAt: D(40) });
    await ctx.cust('PtsStale2', { ...consented, loyaltyPoints: 80, loyaltyPointsUpdatedAt: D(35) });
    await ctx.cust('PtsFresh', { ...consented, loyaltyPoints: 500, loyaltyPointsUpdatedAt: D(5) });
    await ctx.cust('PtsZero', { ...consented, loyaltyPoints: 0, loyaltyPointsUpdatedAt: D(40) });
    await ctx.cust('PtsOptOut', { ...optedOut, loyaltyPoints: 500, loyaltyPointsUpdatedAt: D(40) });
    await ctx.cust('PtsNoConsent', { loyaltyPoints: 500, loyaltyPointsUpdatedAt: D(40) });
    await ctx.cust('PtsDemo', { ...consented, isDemo: true, loyaltyPoints: 500, loyaltyPointsUpdatedAt: D(40) });
    const flow = await newFlow(ctx, { triggerType: 'points_balance_reminder', inactivityDays: 30 });
    await drive(ctx, flow);
    eachRetire(ctx);
  });
  scenario('flow/points_balance_reminder: balance changes between enrolment and send', async (ctx) => {
    const a = await ctx.cust('PtsMoved', { ...consented, loyaltyPoints: 500, loyaltyPointsUpdatedAt: D(40) });
    const b = await ctx.cust('PtsSpent', { ...consented, loyaltyPoints: 500, loyaltyPointsUpdatedAt: D(40) });
    const flow = await newFlow(ctx, { triggerType: 'points_balance_reminder', inactivityDays: 30 });
    await ctx.run('enroll', () => sched().enrollEligibleCustomers(flow));
    await Q('Customer').updateOne({ _id: a._id }, { loyaltyPointsUpdatedAt: new Date() });
    await Q('Customer').updateOne({ _id: b._id }, { loyaltyPoints: 0 });
    await ctx.run('send', () => sched().sendPendingEnrollments(flow));
    eachRetire(ctx);
  });
  scenario('flow/booking_no_show default template', async (ctx) => {
    const mkB = async (label, fields, bookingExtra, backdateHours) => {
      const c = fields === null ? null : await ctx.cust(label, fields);
      const slot = await Q('TimeSlot').create({ workspaceId: H.W, serviceId: F.svcA._id, date: '2030-03-05', startTime: '11:00', endTime: '12:00', capacity: 5, bookedCount: 1 });
      const b = await Q('Booking').create({ workspaceId: H.W, serviceId: F.svcA._id, slotId: slot._id, customerId: c ? c._id : undefined, phone: c ? c.phone : '15550999888', customerName: label, status: 'no-show', paymentType: 'cash', amount: 80, ...(bookingExtra || {}) });
      await Q('Booking').collection.updateOne({ _id: b._id }, { $set: { updatedAt: new Date(Date.now() - (backdateHours || 3) * 3600000) } });
      return c;
    };
    await mkB('NoShowDue', consented);
    await mkB('NoShowDue2', consented);
    await mkB('NoShowFresh', consented, {}, 0.2);
    await mkB('NoShowAnon', null);
    await mkB('NoShowOptOut', optedOut);
    await mkB('NoShowNoConsent', {});
    await mkB('NoShowDemo', { ...consented, isDemo: true });
    const flow = await newFlow(ctx, { triggerType: 'booking_no_show', delayHours: 1 });
    await drive(ctx, flow);
    eachRetire(ctx);
  });
});

describe('flows: promotion-linked and legacy entry-node flows', () => {
  const newFlowRaw = (o) => Q('Flow').create({ workspaceId: H.W, status: 'active', ...o });
  const entryFor = async (flow, o) => {
    const follow = await Q('MessageNode').create({ workspaceId: H.W, ownerType: 'flow', ownerId: flow._id, bodyText: 'Thanks {{1}}!', depth: 1, buttons: [{ position: 0, label: 'Bye', nextAction: { type: 'end_flow' } }] });
    const node = await Q('MessageNode').create({ workspaceId: H.W, ownerType: 'flow', ownerId: flow._id, isEntryNode: true, templateName: `waflow_flow_legacy_${flow.triggerType}`, templateStatus: 'approved', bodyText: 'Hi {{1}}, a message for you', buttons: [
      { position: 0, label: 'Shop', nextAction: { type: 'send_message', targetNodeId: follow._id } },
      { position: 1, label: 'No', nextAction: { type: 'end_flow' } }], ...(o || {}) });
    await Q('Flow').updateOne({ _id: flow._id }, { entryNodeId: node._id });
    return { follow, node };
  };
  const drive = async (ctx, flow) => { await ctx.run('enroll', () => sched().enrollEligibleCustomers(flow)); await ctx.run('send', () => sched().sendPendingEnrollments(flow)); };

  scenario('flow/points_threshold promotion-linked (cash promotion with approved entry message)', async (ctx) => {
    await ctx.cust('ThrRich', { ...consented, loyaltyPoints: 900 });
    await ctx.cust('ThrRich2', { ...consented, loyaltyPoints: 400 });
    await ctx.cust('ThrPoor', { ...consented, loyaltyPoints: 50 });
    await ctx.cust('ThrOptOut', { ...optedOut, loyaltyPoints: 900 });
    const flow = await ops().createFlow({ name: 'Threshold', triggerType: 'points_threshold', pointsThreshold: 300, promotionId: F.pEntry._id, workspaceId: H.W });
    const live = await ctx.run('activate', () => ops().activateFlow({ id: flow._id, workspaceId: H.W }));
    await drive(ctx, flow);
    eachRetire(ctx);
  });
  scenario('flow/points_threshold promotion-linked (points promotion)', async (ctx) => {
    await ctx.cust('ThrPts', { ...consented, loyaltyPoints: 700 });
    const flow = await ops().createFlow({ name: 'Threshold pts', triggerType: 'points_threshold', pointsThreshold: 300, promotionId: F.pPointsEntry._id, workspaceId: H.W });
    await ctx.run('activate', () => ops().activateFlow({ id: flow._id, workspaceId: H.W }));
    await drive(ctx, flow);
    eachRetire(ctx);
  });
  scenario('flow/promotion-linked: referenced promotion has no approved entry message', async (ctx) => {
    await ctx.cust('ThrNoNode', { ...consented, loyaltyPoints: 700 });
    const flow = await ops().createFlow({ name: 'Threshold nonode', triggerType: 'points_threshold', pointsThreshold: 300, promotionId: F.pPlain._id, workspaceId: H.W });
    await ctx.run('activateRejected', () => ops().activateFlow({ id: flow._id, workspaceId: H.W }));
    await Q('Flow').updateOne({ _id: flow._id }, { status: 'active' });
    await drive(ctx, flow);
    eachRetire(ctx);
  });
  scenario('flow/purchase_frequency promotion-linked', async (ctx) => {
    const a = await ctx.cust('FreqA', consented);
    for (const d of [2, 5, 9]) await Q('Order').create({ customer: a._id, workspaceId: H.W, items: [{ productName: 'Tee', quantity: 1, unitPrice: 20 }], total: 20, status: 'delivered', paymentStatus: 'paid', paidAt: D(d), createdAt: D(d) });
    const b = await ctx.cust('FreqB', consented);
    await Q('Order').create({ customer: b._id, workspaceId: H.W, items: [{ productName: 'Tee', quantity: 1, unitPrice: 20 }], total: 20, status: 'delivered', paymentStatus: 'paid', paidAt: D(3), createdAt: D(3) });
    const flow = await ops().createFlow({ name: 'Frequency', triggerType: 'purchase_frequency', orderCountThreshold: 2, inactivityDays: 30, promotionId: F.pEntry._id, workspaceId: H.W });
    await ctx.run('activate', () => ops().activateFlow({ id: flow._id, workspaceId: H.W }));
    await drive(ctx, flow);
    eachRetire(ctx);
  });
  scenario('flow/points_threshold with no message configured -> failed send', async (ctx) => {
    await ctx.cust('ThrNoMsg', { ...consented, loyaltyPoints: 700 });
    const flow = await newFlowRaw({ name: 'No message', triggerType: 'points_threshold', pointsThreshold: 300 });
    await drive(ctx, flow);
    eachRetire(ctx);
  });
  for (const [trigger, setup] of [
    ['inactive_customer', async (ctx) => { const c = await ctx.cust('LegInact', consented); await Q('Order').create({ customer: c._id, workspaceId: H.W, items: [{ productName: 'Tee', quantity: 1, unitPrice: 20 }], total: 20, status: 'delivered', paymentStatus: 'paid', paidAt: D(90), createdAt: D(90) }); return { inactivityDays: 60 }; }],
    ['post_purchase_points', async (ctx) => { const c = await ctx.cust('LegPost', { ...consented, loyaltyPoints: 320 }); await Q('Order').create({ customer: c._id, workspaceId: H.W, items: [{ productName: 'Tee', quantity: 1, unitPrice: 20 }], total: 20, status: 'confirmed', paymentStatus: 'paid', paidAt: D(5 / 24) }); return { delayHours: 2 }; }],
    ['points_balance_reminder', async (ctx) => { await ctx.cust('LegPts', { ...consented, loyaltyPoints: 410, loyaltyPointsUpdatedAt: D(40) }); return { inactivityDays: 30 }; }],
    ['booking_no_show', async (ctx) => {
      const c = await ctx.cust('LegNoShow', consented);
      const slot = await Q('TimeSlot').create({ workspaceId: H.W, serviceId: F.svcB._id, date: '2030-03-06', startTime: '11:00', endTime: '12:00', capacity: 5, bookedCount: 1 });
      const b = await Q('Booking').create({ workspaceId: H.W, serviceId: F.svcB._id, slotId: slot._id, customerId: c._id, phone: c.phone, customerName: 'Leg NoShow', status: 'no-show', paymentType: 'cash', amount: 120 });
      await Q('Booking').collection.updateOne({ _id: b._id }, { $set: { updatedAt: D(0.5) } });
      return { delayHours: 1 };
    }],
  ]) {
    scenario(`flow/${trigger} legacy custom entry message (approved) with a follow-up node`, async (ctx) => {
      const extra = await setup(ctx);
      const flow = await ops().createFlow({ name: `Legacy ${trigger}`, triggerType: trigger, workspaceId: H.W, ...extra });
      await entryFor(flow);
      await ctx.run('activate', () => ops().activateFlow({ id: flow._id, workspaceId: H.W }));
      await drive(ctx, await Q('Flow').findById(flow._id));
      eachRetire(ctx);
    });
  }
  scenario('flow/inactive_customer legacy entry message NOT approved -> fixed default template', async (ctx) => {
    const c = await ctx.cust('LegPending', consented);
    await Q('Order').create({ customer: c._id, workspaceId: H.W, items: [{ productName: 'Tee', quantity: 1, unitPrice: 20 }], total: 20, status: 'delivered', paymentStatus: 'paid', paidAt: D(90), createdAt: D(90) });
    const flow = await ops().createFlow({ name: 'Legacy pending', triggerType: 'inactive_customer', inactivityDays: 60, workspaceId: H.W });
    await entryFor(flow, { templateStatus: 'pending' });
    await ctx.run('activateRejected', () => ops().activateFlow({ id: flow._id, workspaceId: H.W }));
    await Q('Flow').updateOne({ _id: flow._id }, { status: 'active' });
    await drive(ctx, await Q('Flow').findById(flow._id));
    eachRetire(ctx);
  });
  scenario('flow/runSweep drives every active flow once and the lock blocks the second sweep', async (ctx) => {
    const a = await ctx.cust('SweepInact', consented);
    await Q('Order').create({ customer: a._id, workspaceId: H.W, items: [{ productName: 'Tee', quantity: 1, unitPrice: 20 }], total: 20, status: 'delivered', paymentStatus: 'paid', paidAt: D(90), createdAt: D(90) });
    const b = await ctx.cust('SweepPost', { ...consented, loyaltyPoints: 140 });
    await Q('Order').create({ customer: b._id, workspaceId: H.W, items: [{ productName: 'Tee', quantity: 1, unitPrice: 20 }], total: 20, status: 'confirmed', paymentStatus: 'paid', paidAt: D(5 / 24) });
    const f1 = await ops().createFlow({ name: 'Sweep inactive', triggerType: 'inactive_customer', inactivityDays: 60, cooldownDaysOverride: 0, workspaceId: H.W });
    const f2 = await ops().createFlow({ name: 'Sweep post', triggerType: 'post_purchase_points', delayHours: 2, cooldownDaysOverride: 0, workspaceId: H.W });
    await ctx.run('activate1', () => ops().activateFlow({ id: f1._id, workspaceId: H.W }));
    await ctx.run('activate2', () => ops().activateFlow({ id: f2._id, workspaceId: H.W }));
    await ctx.run('sweep1', () => sched().runSweep());
    await ctx.run('sweep2', () => sched().runSweep());
    eachRetire(ctx);
  });
  scenario('flow/management reads: presets, preview, message variables, flow list', async (ctx) => {
    await ctx.run('presets', async () => ops().getFlowPresets().length);
    for (const t of ['inactive_customer', 'post_purchase_points', 'points_balance_reminder', 'booking_no_show']) await ctx.run(`preview_${t}`, () => ops().previewFlowMessage({ triggerType: t }));
    await ctx.run('variables', async () => ops().getFlowMessageVariables({ triggerType: 'booking_no_show' }));
    await ctx.http('GET', '/api/flows/preview?triggerType=inactive_customer');
    await ctx.http('GET', '/api/flows/message-variables?triggerType=post_purchase_points');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. PROMOTIONS (shared/operations.js sendPromotion / sendTestMessage / sendLoyaltyReminders / consent requests)
// ══════════════════════════════════════════════════════════════════════════════
describe('ops.sendPromotion', () => {
  const send = (promo, custs, extra) => ops().sendPromotion({ promotionId: promo._id, customerIds: ids(...custs), workspaceId: H.W, ...(extra || {}) });

  scenario('promo/approved entry message (template path): consented x2, no consent, opted out, demo', async (ctx) => {
    ctx.randomConst(0.3);
    const a = await ctx.cust('EntryA', consented); const b = await ctx.cust('EntryB', { ...consented, loyaltyPoints: 120 });
    const nc = await ctx.cust('EntryNoConsent'); const oo = await ctx.cust('EntryOptOut', optedOut); const dm = await ctx.cust('EntryDemo', { isDemo: true });
    await ctx.run('send', () => send(F.pEntry, [a, b, nc, oo, dm]));
  });
  scenario('promo/entry message not yet approved falls back to the interactive announcement', async (ctx) => {
    const a = await ctx.cust('PendA', consented); const b = await ctx.cust('PendB', consented);
    await ctx.run('send', () => send(F.pPending, [a, b]));
  });
  scenario('promo/entry message template send rejected -> failed CampaignMessage with reason', async (ctx) => {
    const a = await ctx.cust('EntryFailA', consented); const b = await ctx.cust('EntryFailB', consented);
    ctx.fail(isMsgType('template'), { times: 1, code: 132001, message: 'Template name does not exist in the translation' });
    await ctx.run('send', () => send(F.pEntry, [a, b]));
  });
  scenario('promo/plain cash promotion -> interactive announcement (image header, description, >3 items)', async (ctx) => {
    const a = await ctx.cust('PlainA', consented); const b = await ctx.cust('PlainB', consented); const nc = await ctx.cust('PlainNoConsent'); const oo = await ctx.cust('PlainOptOut', optedOut);
    await ctx.run('send', () => send(F.pPlain, [a, b, nc, oo]));
  });
  scenario('promo/small promotion without discount or description', async (ctx) => {
    const a = await ctx.cust('SmallA', consented);
    await ctx.run('send', () => send(F.pSmall, [a]));
  });
  scenario('promo/store-wide promotion (items fall back to the first 10 active products)', async (ctx) => {
    const a = await ctx.cust('StoreA', consented);
    await ctx.run('send', () => send(F.pStoreWide, [a]));
  });
  scenario('promo/interactive announcement fails once -> promo template fallback', async (ctx) => {
    const a = await ctx.cust('FallA', consented); const b = await ctx.cust('FallB', consented);
    ctx.fail(isMsgType('interactive'), { times: 1 });
    await ctx.run('send', () => send(F.pPlain, [a, b]));
  });
  scenario('promo/announcement and template both fail -> failed CampaignMessage rows and errors', async (ctx) => {
    const a = await ctx.cust('BothFailA', consented); const b = await ctx.cust('BothFailB', consented);
    ctx.fail(isMessage, { code: 131049, message: 'Healthy ecosystem engagement' });
    await ctx.run('send', () => send(F.pPlain, [a, b]));
  });
  scenario('promo/points promotion', async (ctx) => {
    const a = await ctx.cust('PointsA', { ...consented, loyaltyPoints: 500 }); const b = await ctx.cust('PointsB', { ...consented, loyaltyPoints: 0 }); const nc = await ctx.cust('PointsNoConsent', { loyaltyPoints: 500 });
    await ctx.run('send', () => send(F.pPoints, [a, b, nc]));
  });
  scenario('promo/points promotion interactive fails -> plain text fallback', async (ctx) => {
    const a = await ctx.cust('PointsFallA', { ...consented, loyaltyPoints: 500 });
    ctx.fail(isMsgType('interactive'), { times: 1 });
    await ctx.run('send', () => send(F.pPoints, [a]));
  });
  scenario('promo/points promotion with an approved entry message', async (ctx) => {
    const a = await ctx.cust('PointsEntryA', { ...consented, loyaltyPoints: 500 });
    await ctx.run('send', () => send(F.pPointsEntry, [a]));
  });
  scenario('promo/service promotion (cash)', async (ctx) => {
    const a = await ctx.cust('SvcPromoA', consented); const b = await ctx.cust('SvcPromoB', consented);
    await ctx.run('send', () => send(F.pSvc, [a, b]));
  });
  scenario('promo/service promotion (points)', async (ctx) => {
    const a = await ctx.cust('SvcPromoPts', { ...consented, loyaltyPoints: 300 });
    await ctx.run('send', () => send(F.pSvcPoints, [a]));
  });
  scenario('promo/service promotion interactive fails -> promo template fallback', async (ctx) => {
    const a = await ctx.cust('SvcFall', consented);
    ctx.fail(isMsgType('interactive'), { times: 1 });
    await ctx.run('send', () => send(F.pSvc, [a]));
  });
  scenario('promo/demo promotion is simulated (conversion happens)', async (ctx) => {
    ctx.randomConst(0.3);
    const a = await ctx.cust('DemoPromoA', consented); const b = await ctx.cust('DemoPromoB', { loyaltyPoints: 500 });
    await ctx.run('send', () => send(F.pDemo, [a, b]));
  });
  scenario('promo/demo customer on a real promotion is simulated (no conversion)', async (ctx) => {
    ctx.randomConst(0.9);
    const a = await ctx.cust('DemoCustA', { isDemo: true }); const b = await ctx.cust('DemoCustB', consented);
    await ctx.run('send', () => send(F.pPlain, [a, b]));
  });
  scenario('promo/allowRealDemoSend sends really to demo data', async (ctx) => {
    const a = await ctx.cust('RealDemoA', { isDemo: true }); const b = await ctx.cust('RealDemoB', consented);
    await ctx.run('sendDemoPromo', () => send(F.pDemo, [a, b], { allowRealDemoSend: true }));
    await ctx.run('sendRealPromo', () => send(F.pPlain, [a], { allowRealDemoSend: true }));
  });
  scenario('promo/live-demo route and regular send route differ for demo data', async (ctx) => {
    ctx.randomConst(0.3);
    const a = await ctx.cust('LiveDemoA', { isDemo: true });
    await ctx.http('POST', `/api/promotions/${F.pPlain._id}/send-live-demo`, { customerIds: sids(a) });
    await ctx.http('POST', `/api/promotions/${F.pPlain._id}/send`, { customerIds: sids(a) });
    await ctx.http('POST', `/api/promotions/${F.pPlain._id}/send-live-demo`, {});
  });
  scenario('promo/six customers (throttle) incl. duplicate and unknown ids', async (ctx) => {
    const cs = []; for (let i = 1; i <= 6; i++) cs.push(await ctx.cust(`Multi${i}`, { ...consented, firstname: `Multi${i}` }));
    await ctx.run('send', () => ops().sendPromotion({ promotionId: F.pPlain._id, customerIds: [...ids(...cs), cs[0]._id, new mongoose.Types.ObjectId()], workspaceId: H.W }));
    await ctx.run('report', () => ops().getCampaignReport({ promotionId: F.pPlain._id, workspaceId: H.W }));
  });
  scenario('promo/errors: no customers, unknown promotion, other workspace', async (ctx) => {
    const a = await ctx.cust('ErrA', consented);
    await ctx.run('noCustomers', () => ops().sendPromotion({ promotionId: F.pPlain._id, customerIds: [], workspaceId: H.W }));
    await ctx.run('unknownPromotion', () => ops().sendPromotion({ promotionId: new mongoose.Types.ObjectId(), customerIds: ids(a), workspaceId: H.W }));
    await ctx.run('otherWorkspace', () => ops().sendPromotion({ promotionId: F.pPlain._id, customerIds: ids(a), workspaceId: W2 }));
    await ctx.run('noWorkspace', () => ops().sendPromotion({ promotionId: F.pSmall._id, customerIds: ids(a) }));
  });
  scenario('promo/HTTP routes: send, test-send, preview, errors', async (ctx) => {
    const a = await ctx.cust('RouteA', consented); const nc = await ctx.cust('RouteNoConsent');
    await ctx.http('POST', `/api/promotions/${F.pEntry._id}/send`, { customerIds: sids(a, nc) });
    await ctx.http('POST', `/api/promotions/${F.pPlain._id}/send`, { customerIds: sids(a) });
    await ctx.http('POST', `/api/promotions/${F.pPlain._id}/send`, {});
    await ctx.http('POST', `/api/promotions/${new mongoose.Types.ObjectId()}/send`, { customerIds: sids(a) });
    await ctx.http('GET', `/api/promotions/${F.pEntry._id}/preview`);
    await ctx.http('GET', `/api/promotions/${F.pPlain._id}/preview`);
    await ctx.http('GET', `/api/promotions/${F.pPoints._id}/preview`);
    await ctx.http('GET', `/api/promotions/${F.pPending._id}/preview`);
    await ctx.http('GET', `/api/promotions/${F.pSvc._id}/preview`);
    await ctx.http('GET', `/api/promotions/${new mongoose.Types.ObjectId()}/preview`);
    await ctx.http('GET', '/api/promotions/message-variables');
  });
});

describe('carousel promotions (sendFormat carousel)', () => {
  scenario('carousel/send to customers incl. demo and opted out (product carousel)', async (ctx) => {
    const a = await ctx.cust('CarA', consented); const b = await ctx.cust('CarB', consented); const dm = await ctx.cust('CarDemo', { isDemo: true }); const oo = await ctx.cust('CarOptOut', optedOut);
    await ctx.http('POST', `/api/promotions/${F.pCarousel._id}/send`, { customerIds: sids(a, b, dm, oo) });
  });
  scenario('carousel/send service carousel and thin carousel (ineligible)', async (ctx) => {
    const a = await ctx.cust('CarSvcA', consented);
    await ctx.http('POST', `/api/promotions/${F.pCarouselSvc._id}/send`, { customerIds: sids(a) });
    await ctx.http('POST', `/api/promotions/${F.pCarouselThin._id}/send`, { customerIds: sids(a) });
  });
  scenario('carousel/test-send and preview', async (ctx) => {
    await ctx.http('POST', `/api/promotions/${F.pCarousel._id}/test-send`, { phone: '15550990010' });
    await ctx.http('POST', `/api/promotions/${F.pCarousel._id}/test-send`, {});
    await ctx.http('POST', `/api/promotions/${F.pCarouselThin._id}/test-send`, { phone: '15550990010' });
    await ctx.http('GET', `/api/promotions/${F.pCarousel._id}/preview`, undefined, { settle: true });
    await ctx.http('GET', `/api/promotions/${F.pCarouselThin._id}/preview`, undefined, { settle: true });
  });
  scenario('carousel/send fails at the template -> failed row', async (ctx) => {
    const a = await ctx.cust('CarFail', consented);
    ctx.fail(isMsgType('template'), { code: 132018, message: 'Hydrated body cannot contain more than 2 line breaks' });
    await ctx.http('POST', `/api/promotions/${F.pCarousel._id}/send`, { customerIds: sids(a) });
  });
});

describe('ops.sendTestMessage', () => {
  const T = '15550990001';
  scenario('testsend/approved entry message', async (ctx) => { await ctx.run('t', () => ops().sendTestMessage({ promotionId: F.pEntry._id, phone: T, workspaceId: H.W })); });
  scenario('testsend/plain cash promotion', async (ctx) => { await ctx.run('t', () => ops().sendTestMessage({ promotionId: F.pPlain._id, phone: T, workspaceId: H.W })); });
  scenario('testsend/points promotion and points entry message', async (ctx) => {
    await ctx.run('points', () => ops().sendTestMessage({ promotionId: F.pPoints._id, phone: T, workspaceId: H.W }));
    await ctx.run('pointsEntry', () => ops().sendTestMessage({ promotionId: F.pPointsEntry._id, phone: T, workspaceId: H.W }));
  });
  scenario('testsend/service promotion and pending entry message', async (ctx) => {
    await ctx.run('service', () => ops().sendTestMessage({ promotionId: F.pSvc._id, phone: T, workspaceId: H.W }));
    await ctx.run('pending', () => ops().sendTestMessage({ promotionId: F.pPending._id, phone: T, workspaceId: H.W }));
  });
  scenario('testsend/errors and HTTP route', async (ctx) => {
    await ctx.run('noPhone', () => ops().sendTestMessage({ promotionId: F.pPlain._id, workspaceId: H.W }));
    await ctx.run('unknown', () => ops().sendTestMessage({ promotionId: new mongoose.Types.ObjectId(), phone: T, workspaceId: H.W }));
    await ctx.http('POST', `/api/promotions/${F.pPlain._id}/test-send`, { phone: T });
    await ctx.http('POST', `/api/promotions/${F.pPlain._id}/test-send`, {});
    await ctx.http('POST', `/api/promotions/${new mongoose.Types.ObjectId()}/test-send`, { phone: T });
  });
});

describe('ops.sendLoyaltyReminders', () => {
  scenario('loyalty/template ok: points, no points, opted out, demo, no consent', async (ctx) => {
    const a = await ctx.cust('LoyA', { ...consented, loyaltyPoints: 500 }); const b = await ctx.cust('LoyB', { ...consented, loyaltyPoints: 1234 });
    const z = await ctx.cust('LoyZero', { ...consented, loyaltyPoints: 0 }); const oo = await ctx.cust('LoyOptOut', { ...optedOut, loyaltyPoints: 400 });
    const dm = await ctx.cust('LoyDemo', { isDemo: true, loyaltyPoints: 300 }); const nc = await ctx.cust('LoyNoConsent', { loyaltyPoints: 300 });
    await ctx.run('send', () => ops().sendLoyaltyReminders({ customerIds: ids(a, b, z, oo, dm, nc), workspaceId: H.W }));
  });
  scenario('loyalty/template rejected -> interactive reminder fallback', async (ctx) => {
    const a = await ctx.cust('LoyFallA', { ...consented, loyaltyPoints: 500 });
    ctx.fail(isMsgType('template'), { times: 1, code: 132001 });
    await ctx.run('send', () => ops().sendLoyaltyReminders({ customerIds: ids(a), workspaceId: H.W }));
  });
  scenario('loyalty/template and fallback both fail -> failed row', async (ctx) => {
    const a = await ctx.cust('LoyFailA', { ...consented, loyaltyPoints: 500 });
    ctx.fail(isMessage, { code: 131049 });
    await ctx.run('send', () => ops().sendLoyaltyReminders({ customerIds: ids(a), workspaceId: H.W }));
  });
  scenario('loyalty/every customer with points in a second workspace (no id list)', async (ctx) => {
    await ctx.cust('LoyW2A', { ...consented, loyaltyPoints: 100, workspaceId: W2 }); await ctx.cust('LoyW2B', { ...consented, loyaltyPoints: 2500, workspaceId: W2 });
    await ctx.cust('LoyW2Opt', { ...optedOut, loyaltyPoints: 100, workspaceId: W2 }); await ctx.cust('LoyW2None', { ...consented, workspaceId: W2 });
    await ctx.run('send', () => ops().sendLoyaltyReminders({ workspaceId: W2 }));
  });
  scenario('loyalty/HTTP routes (promotions and inbox quick action)', async (ctx) => {
    const a = await ctx.cust('LoyRouteA', { ...consented, loyaltyPoints: 600 }); const b = await ctx.cust('LoyRouteNoPts', consented);
    await ctx.http('POST', '/api/promotions/loyalty/remind', { customerIds: sids(a) });
    await ctx.http('POST', `/api/inbox/conversations/${a._id}/loyalty-reminder`);
    await ctx.http('POST', `/api/inbox/conversations/${b._id}/loyalty-reminder`);
  });
});

describe('ops.sendConsentRequests', () => {
  scenario('consent request/every eligible customer of a second workspace', async (ctx) => {
    await ctx.cust('AskW2A', { workspaceId: W2 }); await ctx.cust('AskW2B', { workspaceId: W2 });
    await ctx.cust('AskW2Consented', { ...consented, workspaceId: W2 }); await ctx.cust('AskW2OptOut', { optedOut: true, workspaceId: W2 });
    await ctx.cust('AskW2Asked', { marketingConsentAskedAt: new Date(), workspaceId: W2 }); await ctx.cust('AskW2Demo', { isDemo: true, workspaceId: W2 });
    await ctx.run('send', () => ops().sendConsentRequests({ workspaceId: W2 }));
    await ctx.run('again', () => ops().sendConsentRequests({ workspaceId: W2 }));
  });
  scenario('consent request/selected customers, template rejected for one', async (ctx) => {
    const a = await ctx.cust('AskA'); const b = await ctx.cust('AskB'); const c = await ctx.cust('AskC', consented);
    ctx.fail(isMsgTo(b.phone), { code: 131049 });
    await ctx.run('send', () => ops().sendConsentRequests({ workspaceId: H.W, customerIds: ids(a, b, c) }));
  });
  scenario('consent request/HTTP route and consent stats', async (ctx) => {
    const a = await ctx.cust('AskRouteA');
    await ctx.http('POST', '/api/customers/consent-requests', { customerIds: sids(a) });
    await ctx.http('POST', '/api/customers/consent-requests', { customerIds: sids(a) });
    await ctx.http('GET', '/api/customers/consent-stats');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. REFERRALS
// ══════════════════════════════════════════════════════════════════════════════
describe('referrals', () => {
  scenario('referral/send links: consented, no consent, opted out, demo', async (ctx) => {
    const a = await ctx.cust('RefA', { ...consented, firstname: 'Ref A' }); const b = await ctx.cust('RefNoConsent'); const oo = await ctx.cust('RefOptOut', optedOut); const dm = await ctx.cust('RefDemo', { isDemo: true });
    await ctx.run('send', () => refs().sendReferralLinksToCustomers({ referralPromotionId: String(F.rp._id), customerIds: sids(a, b, oo, dm), workspaceId: H.W }));
    await ctx.run('sendAgain', () => refs().sendReferralLinksToCustomers({ referralPromotionId: String(F.rp._id), customerIds: sids(a), workspaceId: H.W }));
  });
  scenario('referral/send links: message rejected for one customer, bad ids, HTTP route', async (ctx) => {
    const a = await ctx.cust('RefFailA', consented); const b = await ctx.cust('RefFailB', consented);
    ctx.fail(isMsgTo(a.phone), { code: 131049 });
    await ctx.http('POST', `/api/referrals/promotions/${F.rp._id}/send`, { customerIds: sids(a, b) });
    await ctx.http('POST', `/api/referrals/promotions/${F.rp._id}/send`, { customerIds: ['nope'] });
    await ctx.http('POST', `/api/referrals/promotions/${F.rp._id}/send`, {});
    await ctx.http('POST', `/api/referrals/promotions/${F.rp._id}/customer-links`, { customerIds: sids(a) });
    await ctx.http('GET', `/api/referrals/promotions/${F.rp._id}/generic-link`);
  });
  scenario('referral/inbound: a friend arrives with the referrer link code', async (ctx) => {
    const referrer = await ctx.cust('RefReferrer', consented);
    const code = await refs().getOrCreateCustomerCode({ referralPromotionId: F.rp._id, customerId: referrer._id, workspaceId: H.W });
    await ctx.post(envelope(textMsg('15550777001', `Hi! I would like to join. Code: ${code.code}`), 'Friend One'));
    await ctx.post(envelope(textMsg(referrer.phone, `Testing my own link. Code: ${code.code}`), 'Self Referrer'));
    await ctx.post(envelope(textMsg('15550777001', `Code: ${code.code}`), 'Friend One'));
    await ctx.run('report', () => refs().getReferralReport({ referralPromotionId: F.rp._id, workspaceId: H.W }));
  });
  scenario('referral/inbound with a one-word WhatsApp profile name (B4: only flagged workspaces may change)', async (ctx) => {
    const referrer = await ctx.cust('RefB4Referrer', consented);
    const code = await refs().getOrCreateCustomerCode({ referralPromotionId: F.rp._id, customerId: referrer._id, workspaceId: H.W });
    await ctx.post(envelope(textMsg('15550777002', `Hello! Code: ${code.code}`), 'Madonna'));
    await ctx.post(envelope(textMsg('15550777003', `Hello! Code: ${code.code}`), ''));
  }, { approve: 'B4' });
  scenario('instagram/inbound tracking code with a one-word WhatsApp profile name (B4: only flagged workspaces may change)', async (ctx) => {
    const post = await Q('InstagramPost').create({ workspaceId: H.W, socialAccountId: new mongoose.Types.ObjectId(), name: 'Autumn Offer', status: 'published', promotionCode: 'IG-QWER5678' });
    const link = await Q('TrackingLink').create({ workspaceId: H.W, instagramPostId: post._id, code: 'QWER5678', shortUrl: 'http://localhost:3999/t/QWER5678' });
    await Q('InstagramPost').updateOne({ _id: post._id }, { trackingLinkId: link._id });
    await ctx.post(envelope(textMsg('15550777014', 'Hello. Code: IG-QWER5678'), 'Layla'));
  }, { approve: 'B4' });
  scenario('instagram/inbound tracking code: new customer, known customer, unknown code; link click', async (ctx) => {
    const post = await Q('InstagramPost').create({ workspaceId: H.W, socialAccountId: new mongoose.Types.ObjectId(), name: 'Spring Offer', status: 'published', promotionCode: 'IG-ZXCV1234' });
    const link = await Q('TrackingLink').create({ workspaceId: H.W, instagramPostId: post._id, code: 'ZXCV1234', shortUrl: 'http://localhost:3999/t/ZXCV1234' });
    await Q('InstagramPost').updateOne({ _id: post._id }, { trackingLinkId: link._id });
    const known = await ctx.cust('IgKnown', consented);
    await ctx.post(envelope(textMsg('15550777011', 'Hi! I saw your post. Code: IG-ZXCV1234'), 'Instagram Lead'));
    await ctx.post(envelope(textMsg(known.phone, 'Hi again. Code: IG-ZXCV1234'), 'Ig Known'));
    await ctx.post(envelope(textMsg('15550777013', 'Hello. Code: IG-NOSUCH99'), 'Ghost Lead'));
    await ctx.http('GET', '/t/ZXCV1234', undefined, { noAuth: true });
    await ctx.http('GET', '/t/NOSUCH99', undefined, { noAuth: true });
  });
  scenario('referral/link redirect pages', async (ctx) => {
    const referrer = await ctx.cust('RefLinkReferrer', consented);
    const code = await refs().getOrCreateCustomerCode({ referralPromotionId: F.rp._id, customerId: referrer._id, workspaceId: H.W });
    const generic = await refs().getOrCreateGenericCode({ referralPromotionId: F.rp._id, workspaceId: H.W });
    await ctx.http('GET', `/r/${code.code}`, undefined, { noAuth: true });
    await ctx.http('GET', `/c/${generic.code}?source=flyer`, undefined, { noAuth: true });
    await ctx.http('GET', '/r/ZZZZZZZZZZ', undefined, { noAuth: true });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. BOOKING / ORDER / PAYMENT MESSAGES
// ══════════════════════════════════════════════════════════════════════════════
describe('booking messages (shared/operations.js)', () => {
  const mkSlot = (o) => Q('TimeSlot').create({ workspaceId: H.W, serviceId: F.svcA._id, date: '2030-04-10', startTime: '15:00', endTime: '16:00', capacity: 3, bookedCount: 1, ...o });
  const mkBooking = async (c, o, slotOver) => {
    const slot = await mkSlot(slotOver);
    return Q('Booking').create({ workspaceId: H.W, serviceId: slot.serviceId, slotId: slot._id, customerId: c ? c._id : undefined, phone: c ? c.phone : '15550999777', customerName: c ? `${c.firstname} ${c.lastname}` : 'Walk In', status: 'confirmed', paymentType: 'cash', amount: 80, ...(o || {}) });
  };
  scenario('booking/cancel sends the free-rebook interactive message', async (ctx) => {
    const c = await ctx.cust('CancelA', consented); const b = await mkBooking(c);
    await ctx.run('cancel', () => ops().cancelBooking({ bookingId: b._id, workspaceId: H.W }));
    await ctx.run('cancelAgain', () => ops().cancelBooking({ bookingId: b._id, workspaceId: H.W }));
    await ctx.run('unknown', () => ops().cancelBooking({ bookingId: new mongoose.Types.ObjectId(), workspaceId: H.W }));
  });
  scenario('booking/cancel: interactive fails -> plain text; booking without customer; opted-out customer', async (ctx) => {
    const c = await ctx.cust('CancelFall', consented); const b1 = await mkBooking(c);
    ctx.fail(isMsgType('interactive'), { times: 1 });
    await ctx.run('cancelFallback', () => ops().cancelBooking({ bookingId: b1._id, workspaceId: H.W }));
    const b2 = await mkBooking(null); await ctx.run('cancelAnonymous', () => ops().cancelBooking({ bookingId: b2._id, workspaceId: H.W }));
    const oo = await ctx.cust('CancelOpt', optedOut); const b3 = await mkBooking(oo); await ctx.run('cancelOptedOut', () => ops().cancelBooking({ bookingId: b3._id, workspaceId: H.W }));
  });
  scenario('booking/reschedule sends a text; full and unknown slots', async (ctx) => {
    const c = await ctx.cust('ResA', consented); const b = await mkBooking(c); const target = await mkSlot({ date: '2030-04-12', startTime: '09:30', endTime: '10:30', bookedCount: 0 });
    const full = await mkSlot({ date: '2030-04-13', capacity: 1, bookedCount: 1 });
    await ctx.run('reschedule', () => ops().rescheduleBooking({ bookingId: b._id, newSlotId: target._id, workspaceId: H.W }));
    await ctx.run('full', () => ops().rescheduleBooking({ bookingId: b._id, newSlotId: full._id, workspaceId: H.W }));
    await ctx.run('unknownSlot', () => ops().rescheduleBooking({ bookingId: b._id, newSlotId: new mongoose.Types.ObjectId(), workspaceId: H.W }));
    const b2 = await mkBooking(null); await ctx.run('anonymous', () => ops().rescheduleBooking({ bookingId: b2._id, newSlotId: target._id, workspaceId: H.W }));
  });
  scenario('booking/confirm a requested booking: consented, not asked (consent ask), already asked, anonymous', async (ctx) => {
    const a = await ctx.cust('ConfA', consented); const b = await ctx.cust('ConfB'); const c = await ctx.cust('ConfC', { marketingConsentAskedAt: new Date() });
    for (const [label, cu] of [['consented', a], ['notAsked', b], ['alreadyAsked', c], ['anonymous', null]]) {
      const bk = await mkBooking(cu, { status: 'requested', paymentType: 'pay_later' });
      await ctx.run(`confirm_${label}`, () => ops().confirmBooking({ bookingId: bk._id, workspaceId: H.W }));
    }
    const bk2 = await mkBooking(a, { status: 'confirmed' }); await ctx.run('confirmWrongStatus', () => ops().confirmBooking({ bookingId: bk2._id, workspaceId: H.W }));
  });
  scenario('booking/confirm: consent-ask interactive fails -> plain text', async (ctx) => {
    const b = await ctx.cust('ConfFall'); const bk = await mkBooking(b, { status: 'requested', paymentType: 'pay_later' });
    ctx.fail(isMsgType('interactive'), { times: 1 });
    await ctx.run('confirm', () => ops().confirmBooking({ bookingId: bk._id, workspaceId: H.W }));
  });
  scenario('booking/decline, complete and no-show', async (ctx) => {
    const a = await ctx.cust('DeclA', consented);
    const bk = await mkBooking(a, { status: 'requested', paymentType: 'pay_later' });
    await ctx.run('decline', () => ops().declineBooking({ bookingId: bk._id, workspaceId: H.W }));
    await ctx.run('declineAgain', () => ops().declineBooking({ bookingId: bk._id, workspaceId: H.W }));
    const b2 = await mkBooking(a); await ctx.run('complete', () => ops().completeBooking({ bookingId: b2._id, workspaceId: H.W }));
    const b3 = await mkBooking(a); await ctx.run('noShow', () => ops().markNoShow({ bookingId: b3._id, workspaceId: H.W }));
    await ctx.run('noShowAgain', () => ops().markNoShow({ bookingId: b3._id, workspaceId: H.W }));
  });
  scenario('booking/HTTP routes: cancel, reschedule, confirm, decline, no-show and their errors', async (ctx) => {
    const a = await ctx.cust('BkRoute', consented);
    const b1 = await mkBooking(a); const b2 = await mkBooking(a, { status: 'requested' }); const b3 = await mkBooking(a, { status: 'requested' }); const b4 = await mkBooking(a);
    const t = await mkSlot({ date: '2030-04-20', bookedCount: 0 });
    await ctx.http('POST', `/api/services/bookings/${b1._id}/cancel`);
    await ctx.http('POST', `/api/services/bookings/${b1._id}/cancel`);
    await ctx.http('POST', `/api/services/bookings/${b4._id}/reschedule`, { newSlotId: String(t._id) });
    await ctx.http('POST', `/api/services/bookings/${b2._id}/confirm`);
    await ctx.http('POST', `/api/services/bookings/${b3._id}/decline`);
    await ctx.http('POST', `/api/services/bookings/${b4._id}/no-show`);
    await ctx.http('POST', `/api/services/bookings/${new mongoose.Types.ObjectId()}/confirm`);
  });
});

describe('orders and payment messages', () => {
  scenario('order/createOrder: consented customer gets a plain order summary', async (ctx) => {
    const c = await ctx.cust('OrdA', { ...consented, address: '12 George St, Riyadh' });
    await ctx.run('create', () => ops().createOrder({ customerId: c._id, items: [{ productId: F.p1._id, quantity: 2 }, { productId: F.p3._id }], workspaceId: H.W }));
    const pi = lastPi();
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', pi));
    await ctx.http('GET', `/pay/${pi.id}`, undefined, { noAuth: true });
  });
  scenario('order/createOrder: customer not yet asked for consent gets the consent-ask interactive', async (ctx) => {
    const c = await ctx.cust('OrdB');
    await ctx.run('create', () => ops().createOrder({ customerId: c._id, items: [{ productId: F.p2._id }], shippingAddress: '9 Palm Rd', workspaceId: H.W }));
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', lastPi()));
    await ctx.run('createAgain', () => ops().createOrder({ customerId: c._id, items: [{ productId: F.p2._id }], workspaceId: H.W }));
  });
  scenario('order/createOrder: consent-ask interactive fails -> plain text; errors', async (ctx) => {
    const c = await ctx.cust('OrdC', { address: '1 Test St' });
    ctx.fail(isMsgType('interactive'), { times: 1 });
    await ctx.run('create', () => ops().createOrder({ customerId: c._id, items: [{ productId: F.p4._id }], workspaceId: H.W }));
    await ctx.run('unknownProduct', () => ops().createOrder({ customerId: c._id, items: [{ productId: new mongoose.Types.ObjectId() }], workspaceId: H.W }));
    const d = await ctx.cust('OrdNoAddress', consented);
    await ctx.run('noAddress', () => ops().createOrder({ customerId: d._id, items: [{ productId: F.p4._id }], workspaceId: H.W }));
    await ctx.run('unknownCustomer', () => ops().createOrder({ customerId: new mongoose.Types.ObjectId(), items: [], workspaceId: H.W }));
  });
  scenario('stripe webhook: payment failed, unknown event, bad signature, buyer without a customer record', async (ctx) => {
    const c = await ctx.cust('PayFail', { ...consented, address: '3 Lane' });
    await ctx.run('create', () => ops().createOrder({ customerId: c._id, items: [{ productId: F.p4._id }], workspaceId: H.W }));
    const pi = lastPi();
    await ctx.stripeEvent(piEvent('payment_intent.payment_failed', pi));
    await ctx.stripeEvent({ id: 'evt_x', type: 'charge.refunded', data: { object: { id: 'ch_x' } } });
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', { id: 'pi_ghost', amount: 1550, currency: 'sar', metadata: { buyerPhone: '15550888999', subtotal: '15', shippingCost: '0.5', address: 'Nowhere' } }));
    const res = await require('supertest')(H.app).post('/stripe-webhook').set('Content-Type', 'application/json').send('{not json');
    ctx.ret('badBody', { status: res.status, text: res.text });
  });
  scenario('pay pages: payment page, result, cancelled', async (ctx) => {
    const c = await ctx.cust('PayPages', { ...consented, address: '5 Road' });
    await ctx.run('create', () => ops().createOrder({ customerId: c._id, items: [{ productId: F.p1._id }], workspaceId: H.W }));
    const pi = lastPi();
    await ctx.http('GET', `/pay/${pi.id}`, undefined, { noAuth: true });
    await ctx.http('GET', '/pay/pi_missing', undefined, { noAuth: true });
    await ctx.http('GET', `/payment-result?payment_intent=${pi.id}`, undefined, { noAuth: true });
    await ctx.http('GET', '/payment-result', undefined, { noAuth: true });
    await ctx.http('GET', `/payment-cancelled?phone=${c.phone}`, undefined, { noAuth: true });
    await ctx.http('GET', '/payment-cancelled', undefined, { noAuth: true });
  });
});

describe('inbox (shared/inbox.js)', () => {
  scenario('inbox/staff message: normal, opted-out customer, empty body, unknown customer', async (ctx) => {
    const a = await ctx.cust('InboxA', consented); const oo = await ctx.cust('InboxOpt', optedOut);
    await ctx.http('POST', `/api/inbox/conversations/${a._id}/messages`, { body: 'Hello, your order is ready for pickup.' });
    await ctx.http('POST', `/api/inbox/conversations/${oo._id}/messages`, { body: 'We have updated your delivery slot.' });
    await ctx.http('POST', `/api/inbox/conversations/${a._id}/messages`, { body: '   ' });
    await ctx.http('POST', `/api/inbox/conversations/${new mongoose.Types.ObjectId()}/messages`, { body: 'hi' });
    await ctx.http('POST', `/api/inbox/conversations/${a._id}/messages`, { body: 'x'.repeat(10) });
  });
  scenario('inbox/staff message rejected by Meta -> error response', async (ctx) => {
    const a = await ctx.cust('InboxFail', consented);
    ctx.fail(isMessage, { code: 131047, message: 'Re-engagement message' });
    await ctx.http('POST', `/api/inbox/conversations/${a._id}/messages`, { body: 'Hello after 24 hours' });
  });
  scenario('inbox/payment link', async (ctx) => {
    const a = await ctx.cust('InboxPay', consented);
    await ctx.http('POST', `/api/inbox/conversations/${a._id}/payment-link`, { amount: 49.5 });
    await ctx.http('POST', `/api/inbox/conversations/${a._id}/payment-link`, { amount: 0 });
    await ctx.http('POST', `/api/inbox/conversations/${a._id}/payment-link`, {});
    await ctx.http('GET', `/pay/${lastPi().id}`, undefined, { noAuth: true });
  });
  scenario('inbox/thread and snapshot of a customer with history', async (ctx) => {
    const a = await ctx.cust('InboxThread', { ...consented, loyaltyPoints: 250 });
    await ctx.post(envelope(textMsg(a.phone, 'Hi, is my order on the way?'), 'Inbox Thread'));
    await ctx.http('POST', `/api/inbox/conversations/${a._id}/messages`, { body: 'Yes, it ships today.' });
    await ctx.run('send', () => ops().sendLoyaltyReminders({ customerIds: ids(a), workspaceId: H.W }));
    await ctx.http('GET', `/api/inbox/conversations/${a._id}/thread`);
    await ctx.http('GET', `/api/inbox/conversations/${a._id}/snapshot`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. WEBHOOK: shopping journey, services, branching taps
// ══════════════════════════════════════════════════════════════════════════════
describe('webhook shopping journey (cash)', () => {
  const sendTo = async (ctx, promo, c) => { await ops().sendPromotion({ promotionId: promo._id, customerIds: [c._id], workspaceId: H.W }); return ctx.cm(c); };
  scenario('journey/cash: promo tap, add to cart, checkout asks address, address, pay link, Stripe confirmation (consented)', async (ctx) => {
    const c = await ctx.cust('JCash', consented); const cm = await sendTo(ctx, F.pPlain, c);
    await ctx.post(envelope(tplBtn(c.phone, `promo_${F.pPlain._id}`, 'Shop Now! 🛍️', cm.wamid)));
    await ctx.post(envelope(ibtn(c.phone, `cart_${F.p3._id}`, 'Add to Cart 🛒')));
    await ctx.post(envelope(ibtn(c.phone, 'continue_shopping', 'Keep Browsing')));
    await ctx.post(envelope(ibtn(c.phone, `cart_${F.p4._id}`, 'Add to Cart 🛒')));
    await ctx.post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
    await ctx.post(envelope(textMsg(c.phone, 'Building 7, King Fahd Road, Riyadh 12211')));
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', lastPi()));
    await ctx.http('GET', `/pay/${lastPi().id}`, undefined, { noAuth: true });
  });
  scenario('journey/cash: customer not yet asked for consent gets the consent ask with the confirmation, then taps yes', async (ctx) => {
    const c = await ctx.cust('JCashAsk', { address: '2 Garden Lane' });
    await ctx.post(envelope(ibtn(c.phone, `promo_${F.pPlain._id}`, 'Shop Now! 🛍️')));
    await ctx.post(envelope(ibtn(c.phone, `cart_${F.p3._id}`, 'Add to Cart 🛒')));
    await ctx.post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', lastPi()));
    await ctx.post(envelope(ibtn(c.phone, `consent_yes_${c._id}`, 'Yes, sign me up')));
  });
  scenario('journey/cash: product with variants -> variant picker -> variant chosen (and the base option)', async (ctx) => {
    const c = await ctx.cust('JVariant', consented);
    await ctx.post(envelope(ibtn(c.phone, `promo_${F.pPlain._id}`, 'Shop Now! 🛍️')));
    await ctx.post(envelope(ibtn(c.phone, `cart_${F.p1._id}`, 'Add to Cart 🛒')));
    await ctx.post(envelope(lrow(c.phone, `variant_${F.p1._id}_0`, 'M · Blue')));
    await ctx.post(envelope(ibtn(c.phone, `cart_${F.p1._id}`, 'Add to Cart 🛒')));
    await ctx.post(envelope(lrow(c.phone, `variant_${F.p1._id}_base`, 'No preference')));
    await ctx.post(envelope(lrow(c.phone, `variant_${F.p1._id}_1`, 'L · Blue')));
    await ctx.post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
  });
  scenario('journey/cash: template carousel card taps (cart_ payload) and list fallback rows', async (ctx) => {
    const c = await ctx.cust('JCarousel', consented);
    await ctx.post(envelope(tplBtn(c.phone, `cart_${F.p3._id}`, 'View')));
    await ctx.post(envelope(lrow(c.phone, `cart_${F.p4._id}`, 'Yellow Socks')));
    await ctx.post(envelope(tplBtn(c.phone, `carouselsvc_${F.svcA._id}_${F.pSvc._id}`, 'Book Now')));
    await ctx.post(envelope(ibtn(c.phone, `carouselsvc_${F.svcB._id}_${F.pSvc._id}`, 'Book Now')));
    await ctx.post(envelope(tplBtn(c.phone, `carouselsvc_${new mongoose.Types.ObjectId()}_none`, 'Book Now')));
  });
  scenario('journey/cash: more than ten products -> list of ten, "more" button, next batch, number selection', async (ctx) => {
    const c = await ctx.cust('JMany', consented);
    await ctx.post(envelope(tplBtn(c.phone, `promo_${F.pMany._id}`, 'Shop Now')));
    await ctx.post(envelope(ibtn(c.phone, `more_10_${F.pMany._id}`, 'See Next 2')));
    await ctx.post(envelope(textMsg(c.phone, '1, 2')));
    await ctx.post(envelope(ibtn(c.phone, 'continue_shopping', 'Keep Browsing')));
    await ctx.post(envelope(ibtn(c.phone, 'more_0_none', 'See Next')));
  });
  scenario('journey/cash: store-wide promotion tap and unknown promotion tap', async (ctx) => {
    const c = await ctx.cust('JStore', consented);
    await ctx.post(envelope(ibtn(c.phone, `promo_${F.pStoreWide._id}`, 'Shop Now')));
    await ctx.post(envelope(ibtn(c.phone, `promo_${new mongoose.Types.ObjectId()}`, 'Shop Now')));
    await ctx.post(envelope(tplBtn(c.phone, 'promo_notanid', 'Shop Now')));
  });
  scenario('journey/cash: continue shopping and shop_now with and without a catalogue', async (ctx) => {
    const c = await ctx.cust('JContinue', consented);
    await ctx.post(envelope(ibtn(c.phone, 'continue_shopping', 'Keep Browsing')));
    await ctx.post(envelope(ibtn(c.phone, 'shop_now', 'Shop Now! 🛍️')));
    await ctx.post(envelope(ibtn(c.phone, `promo_${F.pSmall._id}`, 'Shop Now')));
    await ctx.post(envelope(ibtn(c.phone, 'shop_now', 'Shop Now! 🛍️')));
  });
  scenario('journey/cash: legacy int_ button and unknown button ids', async (ctx) => {
    const c = await ctx.cust('JLegacy', consented);
    await ctx.post(envelope(ibtn(c.phone, 'int_unknownproductid', 'Interested? 🛍️')));
    await ctx.post(envelope(ibtn(c.phone, 'something_else', 'Whatever')));
    await ctx.post(envelope(tplBtn(c.phone, 'unknown_payload', 'Hmm')));
    await ctx.post(envelope(tplBtn(c.phone, '', 'Empty')));
    await ctx.post(envelope({ ...msgBaseFrom(c.phone), type: 'interactive', interactive: { type: 'nfm_reply' } }));
    await ctx.post(envelope(lrow(c.phone, 'row_unknown', 'Unknown row')));
  });
  scenario('journey/checkout: customer with a saved address goes straight to payment; empty and unknown customer', async (ctx) => {
    const c = await ctx.cust('JSaved', { ...consented, address: '77 Olaya St, Riyadh' });
    await ctx.post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
    await ctx.post(envelope(ibtn(c.phone, `cart_${F.p5._id}`, 'Add to Cart 🛒')));
    await ctx.post(envelope(ibtn(c.phone, `checkout_${F.p5._id}`, 'Checkout ✅')));
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', lastPi()));
  });
  scenario('journey/checkout: Stripe unavailable -> sorry message', async (ctx) => {
    const c = await ctx.cust('JNoStripe', { ...consented, address: '1 Test Rd' });
    await ctx.post(envelope(ibtn(c.phone, `cart_${F.p4._id}`, 'Add to Cart 🛒')));
    mockStripeCtl.failCreate = true;
    await ctx.post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
    await ctx.post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', lastPi()));
  });
});
function msgBaseFrom(from) { return E.msgBase(from); }

describe('webhook shopping journey (points)', () => {
  scenario('journey/points: promo tap, redeem, points checkout asks address, address, YES redeems', async (ctx) => {
    const c = await ctx.cust('JPoints', { ...consented, loyaltyPoints: 600 });
    await ops().sendPromotion({ promotionId: F.pPoints._id, customerIds: [c._id], workspaceId: H.W });
    const cm = await ctx.cm(c);
    await ctx.post(envelope(tplBtn(c.phone, `promo_${F.pPoints._id}`, 'Shop Now! 💎', cm.wamid)));
    await ctx.post(envelope(ibtn(c.phone, `cart_${F.p3._id}`, 'Redeem 💎')));
    await ctx.post(envelope(ibtn(c.phone, 'points_checkout', 'Redeem Points 💎')));
    await ctx.post(envelope(textMsg(c.phone, 'Villa 4, Al Nakheel, Riyadh')));
    await ctx.post(envelope(textMsg(c.phone, 'YES')));
  });
  scenario('journey/points: saved address, NO cancels; insufficient points; empty cart', async (ctx) => {
    const c = await ctx.cust('JPointsNo', { ...consented, loyaltyPoints: 600, address: '9 Hill St' });
    await ctx.post(envelope(ibtn(c.phone, 'points_checkout', 'Redeem Points 💎')));
    await ctx.post(envelope(ibtn(c.phone, `promo_${F.pPoints._id}`, 'Shop Now! 💎')));
    await ctx.post(envelope(ibtn(c.phone, `cart_${F.p3._id}`, 'Redeem 💎')));
    await ctx.post(envelope(ibtn(c.phone, 'points_checkout', 'Redeem Points 💎')));
    await ctx.post(envelope(textMsg(c.phone, 'NO')));
    const poor = await ctx.cust('JPointsPoor', { ...consented, loyaltyPoints: 50, address: '1 Poor St' });
    await ctx.post(envelope(ibtn(poor.phone, `promo_${F.pPoints._id}`, 'Shop Now! 💎')));
    await ctx.post(envelope(ibtn(poor.phone, `cart_${F.p3._id}`, 'Redeem 💎')));
    await ctx.post(envelope(ibtn(poor.phone, 'points_checkout', 'Redeem Points 💎')));
  });
  scenario('journey/points: not yet asked for consent -> consent ask rides on the redemption confirmation', async (ctx) => {
    const c = await ctx.cust('JPointsAsk', { loyaltyPoints: 600, address: '3 Ask St' });
    await ctx.post(envelope(ibtn(c.phone, `promo_${F.pPoints._id}`, 'Shop Now! 💎')));
    await ctx.post(envelope(ibtn(c.phone, `cart_${F.p4._id}`, 'Redeem 💎')));
    await ctx.post(envelope(ibtn(c.phone, 'points_checkout', 'Redeem Points 💎')));
    await ctx.post(envelope(textMsg(c.phone, 'yes')));
    await ctx.post(envelope(ibtn(c.phone, `consent_no_${c._id}`, 'No thanks')));
  });
});

describe('webhook service bookings', () => {
  scenario('service/cash: promo tap, slot list, slot pick, pay link + pay-later offer, reserve, merchant confirms', async (ctx) => {
    const c = await ctx.cust('SvcCash', consented);
    await ops().sendPromotion({ promotionId: F.pSvc._id, customerIds: [c._id], workspaceId: H.W });
    const cm = await ctx.cm(c);
    await ctx.post(envelope(tplBtn(c.phone, `promo_${F.pSvc._id}`, 'Book Now! 📅', cm.wamid)));
    await ctx.post(envelope(lrow(c.phone, `slot_${F.slotA1._id}`, '2030-01-15 · 09:00')));
    await ctx.post(envelope(ibtn(c.phone, `paylater_${F.slotA1._id}`, 'Reserve, Pay in Person')));
    const bk = await Q('Booking').findOne({ customerId: c._id });
    await ctx.run('confirm', () => ops().confirmBooking({ bookingId: bk._id, workspaceId: H.W }));
  });
  scenario('service/cash: slot pay -> Stripe booking confirmation (consented) and a full slot', async (ctx) => {
    const c = await ctx.cust('SvcPay', consented);
    await ctx.post(envelope(ibtn(c.phone, `promo_${F.pSvc._id}`, 'Book Now! 📅')));
    await ctx.post(envelope(lrow(c.phone, `slot_${F.slotA2._id}`, '2030-01-16 · 10:00')));
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', lastPi()));
    await ctx.post(envelope(lrow(c.phone, `slot_${F.slotAfull._id}`, 'Full slot')));
    await ctx.post(envelope(ibtn(c.phone, `paylater_${F.slotAfull._id}`, 'Reserve')));
  });
  scenario('service/cash: not yet asked for consent, booking confirmation carries the consent ask; unknown buyer', async (ctx) => {
    const c = await ctx.cust('SvcAsk');
    await ctx.post(envelope(ibtn(c.phone, `promo_${F.pSvc._id}`, 'Book Now! 📅')));
    await ctx.post(envelope(lrow(c.phone, `slot_${F.slotA1._id}`, '2030-01-15 · 09:00')));
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', lastPi()));
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', { id: 'pi_ghost_svc', amount: 8000, currency: 'sar', metadata: { bookingType: 'service', buyerPhone: '15550888777', serviceId: String(F.svcA._id), slotId: String(F.slotA1._id), serviceName: 'Massage', slotLabel: '2030-01-15 at 09:00', promotionId: '', campaignMessageId: '' } }));
  });
  scenario('service/points: slot pick shows summary, YES books, NO cancels, insufficient points', async (ctx) => {
    const c = await ctx.cust('SvcPts', { ...consented, loyaltyPoints: 450 });
    await ctx.post(envelope(ibtn(c.phone, `promo_${F.pSvcPoints._id}`, 'Book Now! 📅')));
    await ctx.post(envelope(lrow(c.phone, `slot_${F.slotA1._id}`, '2030-01-15 · 09:00')));
    await ctx.post(envelope(textMsg(c.phone, 'YES')));
    const d = await ctx.cust('SvcPtsNo', { ...consented, loyaltyPoints: 450 });
    await ctx.post(envelope(ibtn(d.phone, `promo_${F.pSvcPoints._id}`, 'Book Now! 📅')));
    await ctx.post(envelope(lrow(d.phone, `slot_${F.slotA2._id}`, '2030-01-16 · 10:00')));
    await ctx.post(envelope(textMsg(d.phone, 'NO')));
    const e = await ctx.cust('SvcPtsPoor', { ...consented, loyaltyPoints: 10 });
    await ctx.post(envelope(ibtn(e.phone, `promo_${F.pSvcPoints._id}`, 'Book Now! 📅')));
    await ctx.post(envelope(lrow(e.phone, `slot_${F.slotA1._id}`, '2030-01-15 · 09:00')));
  });
  scenario('service/rebook: cancellation message, Rebook Free tap, pick a new slot', async (ctx) => {
    const c = await ctx.cust('SvcRebook', consented);
    const slot = await Q('TimeSlot').create({ workspaceId: H.W, serviceId: F.svcA._id, date: '2030-05-02', startTime: '09:00', endTime: '10:00', capacity: 3, bookedCount: 1 });
    const bk = await Q('Booking').create({ workspaceId: H.W, serviceId: F.svcA._id, slotId: slot._id, customerId: c._id, phone: c.phone, customerName: 'Rebook Eng', status: 'confirmed', paymentType: 'cash', amount: 80 });
    await ctx.run('cancel', () => ops().cancelBooking({ bookingId: bk._id, workspaceId: H.W }));
    await ctx.post(envelope(ibtn(c.phone, `rebook_${F.svcA._id}_${bk._id}`, 'Rebook Free 🔄')));
    await ctx.post(envelope(lrow(c.phone, `reslot_${F.slotA2._id}`, '2030-01-16 · 10:00')));
    await ctx.post(envelope(ibtn(c.phone, `rebook_${new mongoose.Types.ObjectId()}_${bk._id}`, 'Rebook Free 🔄')));
  });
  const noShowJourney = async (ctx, label, stamp) => {
    const c = await ctx.cust(label, consented);
    const slot = await Q('TimeSlot').create({ workspaceId: H.W, serviceId: F.svcA._id, date: '2030-05-03', startTime: '09:00', endTime: '10:00', capacity: 3, bookedCount: 1 });
    const bk = await Q('Booking').create({ workspaceId: H.W, serviceId: F.svcA._id, slotId: slot._id, customerId: c._id, phone: c.phone, customerName: 'No Show Eng', status: 'no-show', paymentType: 'cash', amount: 80 });
    await Q('Booking').collection.updateOne({ _id: bk._id }, { $set: { updatedAt: D(0.5) } });
    const flow = await ops().createFlow({ name: 'NoShow journey', triggerType: 'booking_no_show', delayHours: 1, workspaceId: H.W });
    const live = await ops().activateFlow({ id: flow._id, workspaceId: H.W });
    await sched().enrollEligibleCustomers(live); await sched().sendPendingEnrollments(live);
    if (stamp) await Q('CampaignMessage').collection.updateMany({ customer: c._id }, { $set: { workspaceId: H.W } });
    const cm = await ctx.cm(c);
    await ctx.post(envelope(tplBtn(c.phone, `flownoshow_${F.svcA._id}_${bk._id}`, 'Rebook Free', cm.wamid)));
    await ctx.post(envelope(lrow(c.phone, `reslot_${F.slotA1._id}`, '2030-01-15 · 09:00')));
    await ctx.run('enrollments', () => ops().listFlowEnrollments({ flowId: flow._id, workspaceId: H.W }));
    eachRetire(ctx);
  };
  scenario('service/no-show flow: default template, flownoshow tap (row without workspaceId, existing defect), rebook', async (ctx) => { await noShowJourney(ctx, 'SvcNoShow', false); });
  scenario('service/no-show flow with workspaceId on the row: rebook completes the enrolment', async (ctx) => { await noShowJourney(ctx, 'SvcNoShow2', true); });
  scenario('service/pay-later reserve without a pending offer and slot already booked up', async (ctx) => {
    const c = await ctx.cust('SvcLater', consented);
    await ctx.post(envelope(ibtn(c.phone, `paylater_${F.slotA1._id}`, 'Reserve, Pay in Person')));
    await ctx.post(envelope(lrow(c.phone, `slot_${new mongoose.Types.ObjectId()}`, 'Ghost slot')));
    await ctx.post(envelope(lrow(c.phone, `reslot_${F.slotA1._id}`, 'Reslot without pending')));
  });
});

describe('webhook flow taps, branching and attribution', () => {
  const flowWithEntry = async (ctx, trigger, extra) => {
    const flow = await ops().createFlow({ name: `Branch ${trigger}`, triggerType: trigger, workspaceId: H.W, ...(extra || {}) });
    const follow2 = await Q('MessageNode').create({ workspaceId: H.W, ownerType: 'flow', ownerId: flow._id, bodyText: 'Final step {{1}}', depth: 2, buttons: [{ position: 0, label: 'Done', nextAction: { type: 'end_flow' } }] });
    const follow = await Q('MessageNode').create({ workspaceId: H.W, ownerType: 'flow', ownerId: flow._id, bodyText: 'Pick for {{1}}', depth: 1, buttons: [
      { position: 0, label: 'Next', nextAction: { type: 'send_message', targetNodeId: follow2._id } },
      { position: 1, label: 'Use points', nextAction: { type: 'redeem_points' } },
      { position: 2, label: 'Discount', nextAction: { type: 'apply_discount' } }] });
    const entry = await Q('MessageNode').create({ workspaceId: H.W, ownerType: 'flow', ownerId: flow._id, isEntryNode: true, templateName: `waflow_flow_branch_${trigger}`, templateStatus: 'approved', bodyText: 'Hi {{1}}, hello', buttons: [
      { position: 0, label: 'Go', nextAction: { type: 'send_message', targetNodeId: follow._id } },
      { position: 1, label: 'Stop here', nextAction: { type: 'end_flow' } }] });
    await Q('Flow').updateOne({ _id: flow._id }, { entryNodeId: entry._id });
    return { flow: await ops().activateFlow({ id: flow._id, workspaceId: H.W }), entry, follow, follow2 };
  };

  scenario('branch/promotion entry message: tap -> follow-up -> deeper node, double tap ignored', async (ctx) => {
    const c = await ctx.cust('BrPromo', consented);
    await ops().sendPromotion({ promotionId: F.pEntry._id, customerIds: [c._id], workspaceId: H.W });
    const entryCm = await ctx.cm(c);
    await ctx.post(envelope(tplBtn(c.phone, `msgnode_${F.nE._id}_0`, 'Show me', entryCm.wamid)));
    await ctx.post(envelope(tplBtn(c.phone, `msgnode_${F.nE._id}_0`, 'Show me', entryCm.wamid)));
    const follow1 = await Q('CampaignMessage').findOne({ customer: c._id, messageNode: F.nN1._id });
    await ctx.post(envelope(ibtn(c.phone, `msgnode_${F.nN1._id}_0`, 'Next', follow1.wamid)));
    const follow2 = await Q('CampaignMessage').findOne({ customer: c._id, messageNode: F.nN2._id });
    await ctx.post(envelope(ibtn(c.phone, `msgnode_${F.nN2._id}_0`, 'Done', follow2.wamid)));
  });
  scenario('branch/promotion entry message: apply_discount, redeem_points, end_flow, unknown position', async (ctx) => {
    const c = await ctx.cust('BrActions', consented);
    await ops().sendPromotion({ promotionId: F.pEntry._id, customerIds: [c._id], workspaceId: H.W });
    const entryCm = await ctx.cm(c);
    await ctx.post(envelope(tplBtn(c.phone, `msgnode_${F.nE._id}_2`, 'Discount', entryCm.wamid)));
    await ctx.post(envelope(tplBtn(c.phone, `msgnode_${F.nE._id}_1`, 'Not now', entryCm.wamid)));
    const d = await ctx.cust('BrActions2', consented);
    await ops().sendPromotion({ promotionId: F.pEntry._id, customerIds: [d._id], workspaceId: H.W });
    const cm2 = await ctx.cm(d);
    await ctx.post(envelope(tplBtn(d.phone, `msgnode_${F.nE._id}_0`, 'Show me', cm2.wamid)));
    const f1 = await Q('CampaignMessage').findOne({ customer: d._id, messageNode: F.nN1._id });
    await ctx.post(envelope(ibtn(d.phone, `msgnode_${F.nN1._id}_1`, 'Redeem points', f1.wamid)));
    await ctx.post(envelope(ibtn(d.phone, `msgnode_${F.nN1._id}_2`, 'Get discount', f1.wamid)));
    const e = await ctx.cust('BrActions3', consented);
    await ops().sendPromotion({ promotionId: F.pEntry._id, customerIds: [e._id], workspaceId: H.W });
    const cm3 = await ctx.cm(e);
    await ctx.post(envelope(tplBtn(e.phone, `msgnode_${F.nE._id}_7`, 'Ghost button', cm3.wamid)));
    await ctx.post(envelope(tplBtn(e.phone, `msgnode_${new mongoose.Types.ObjectId()}_0`, 'Ghost node', cm3.wamid)));
    await ctx.post(envelope(tplBtn(e.phone, `msgnode_${F.nE._id}_0`, 'No context')));
  });
  scenario('branch/customer opts out after the entry message: the follow-up is not sent', async (ctx) => {
    const c = await ctx.cust('BrOptOut', consented);
    await ops().sendPromotion({ promotionId: F.pEntry._id, customerIds: [c._id], workspaceId: H.W });
    const entryCm = await ctx.cm(c);
    await ctx.post(envelope(textMsg(c.phone, 'STOP')));
    await ctx.post(envelope(tplBtn(c.phone, `msgnode_${F.nE._id}_0`, 'Show me', entryCm.wamid)));
  });
  scenario('branch/follow-up send fails -> failed CampaignMessage', async (ctx) => {
    const c = await ctx.cust('BrFail', consented);
    await ops().sendPromotion({ promotionId: F.pEntry._id, customerIds: [c._id], workspaceId: H.W });
    const entryCm = await ctx.cm(c);
    ctx.fail(isMsgType('interactive'), { code: 131047 });
    await ctx.post(envelope(tplBtn(c.phone, `msgnode_${F.nE._id}_0`, 'Show me', entryCm.wamid)));
  });
  const staleOrder = (c) => Q('Order').create({ customer: c._id, workspaceId: H.W, items: [{ productName: 'Tee', quantity: 1, unitPrice: 20 }], total: 20, status: 'delivered', paymentStatus: 'paid', paidAt: D(90), createdAt: D(90) });
  scenario('branch/flow entry message: its CampaignMessage has no workspaceId (existing defect) so the tap is ignored', async (ctx) => {
    const c = await ctx.cust('BrFlowLegacy', consented); await staleOrder(c);
    const { flow, entry } = await flowWithEntry(ctx, 'inactive_customer', { inactivityDays: 60 });
    await sched().enrollEligibleCustomers(flow); await sched().sendPendingEnrollments(flow);
    const entryCm = await ctx.cm(c);
    await ctx.post(envelope(tplBtn(c.phone, `msgnode_${entry._id}_0`, 'Go', entryCm.wamid)));
    await ctx.post(envelope(tplBtn(c.phone, `msgnode_${entry._id}_1`, 'Stop here', entryCm.wamid)));
    await ctx.run('enrollments', () => ops().listFlowEnrollments({ flowId: flow._id, workspaceId: H.W }));
    eachRetire(ctx);
  });
  scenario('branch/flow entry message with workspaceId on its row: tap, follow-ups, redeem/discount actions, end_flow completes the enrolment', async (ctx) => {
    const { flow, entry, follow, follow2 } = await flowWithEntry(ctx, 'inactive_customer', { inactivityDays: 60, cooldownDaysOverride: 0 });
    const custs = {};
    for (const label of ['BrFlowPath', 'BrFlowRedeem', 'BrFlowDiscount', 'BrFlowStop']) { custs[label] = await ctx.cust(label, consented); await staleOrder(custs[label]); }
    await sched().enrollEligibleCustomers(flow); await sched().sendPendingEnrollments(flow);
    await Q('CampaignMessage').collection.updateMany({ customer: { $in: ids(...Object.values(custs)) } }, { $set: { workspaceId: H.W } });
    for (const label of ['BrFlowPath', 'BrFlowRedeem', 'BrFlowDiscount']) {
      const c = custs[label]; const entryCm = await ctx.cm(c);
      await ctx.post(envelope(tplBtn(c.phone, `msgnode_${entry._id}_0`, 'Go', entryCm.wamid)));
    }
    const fu = async (c, node) => Q('CampaignMessage').findOne({ customer: c._id, messageNode: node._id });
    const pathF1 = await fu(custs.BrFlowPath, follow); ctx.ret('followUpFound', !!pathF1);
    if (pathF1) {
      await ctx.post(envelope(ibtn(custs.BrFlowPath.phone, `msgnode_${follow._id}_0`, 'Next', pathF1.wamid)));
      const f2 = await fu(custs.BrFlowPath, follow2); ctx.ret('deeperFound', !!f2);
      if (f2) await ctx.post(envelope(ibtn(custs.BrFlowPath.phone, `msgnode_${follow2._id}_0`, 'Done', f2.wamid)));
    }
    const redeemF1 = await fu(custs.BrFlowRedeem, follow); if (redeemF1) await ctx.post(envelope(ibtn(custs.BrFlowRedeem.phone, `msgnode_${follow._id}_1`, 'Use points', redeemF1.wamid)));
    const discF1 = await fu(custs.BrFlowDiscount, follow); if (discF1) await ctx.post(envelope(ibtn(custs.BrFlowDiscount.phone, `msgnode_${follow._id}_2`, 'Discount', discF1.wamid)));
    const stopCm = await ctx.cm(custs.BrFlowStop);
    await ctx.post(envelope(tplBtn(custs.BrFlowStop.phone, `msgnode_${entry._id}_1`, 'Stop here', stopCm.wamid)));
    await ctx.run('enrollments', () => ops().listFlowEnrollments({ flowId: flow._id, workspaceId: H.W }));
    await ctx.run('report', () => ops().getFlowReport({ flowId: flow._id, workspaceId: H.W }));
    eachRetire(ctx);
  });
  scenario('attribution: flow template -> flowbrowse tap -> catalogue -> cart -> pay -> Stripe completes the enrolment', async (ctx) => {
    const c = await ctx.cust('AttrFlow', { ...consented, address: '40 Flow Ave', loyaltyPoints: 90, loyaltyPointsUpdatedAt: D(40) });
    const flow = await ops().createFlow({ name: 'Attr points', triggerType: 'points_balance_reminder', inactivityDays: 30, workspaceId: H.W });
    const live = await ops().activateFlow({ id: flow._id, workspaceId: H.W });
    await sched().enrollEligibleCustomers(live); await sched().sendPendingEnrollments(live);
    const cm = await ctx.cm(c); const enr = await Q('FlowEnrollment').findOne({ customer: c._id });
    await ctx.post(envelope(tplBtn(c.phone, `flowbrowse_${flow._id}_${enr._id}`, 'Shop Now', cm.wamid)));
    await ctx.post(envelope(ibtn(c.phone, `cart_${F.p3._id}`, 'Add to Cart 🛒')));
    await ctx.post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', lastPi()));
    await ctx.run('report', () => ops().getFlowReport({ flowId: flow._id, workspaceId: H.W }));
    eachRetire(ctx);
  });
  scenario('attribution: flow template row stamped with workspaceId -> flowbrowse tap -> pay -> Stripe completes the enrolment and credits the row', async (ctx) => {
    const c = await ctx.cust('AttrFlow2', { ...consented, address: '40 Flow Ave', loyaltyPoints: 90, loyaltyPointsUpdatedAt: D(40) });
    const flow = await ops().createFlow({ name: 'Attr points 2', triggerType: 'points_balance_reminder', inactivityDays: 30, workspaceId: H.W });
    const live = await ops().activateFlow({ id: flow._id, workspaceId: H.W });
    await sched().enrollEligibleCustomers(live); await sched().sendPendingEnrollments(live);
    await Q('CampaignMessage').collection.updateMany({ customer: c._id }, { $set: { workspaceId: H.W } });
    const cm = await ctx.cm(c); const enr = await Q('FlowEnrollment').findOne({ customer: c._id });
    await ctx.post(envelope(tplBtn(c.phone, `flowbrowse_${flow._id}_${enr._id}`, 'Shop Now', cm.wamid)));
    await ctx.post(envelope(ibtn(c.phone, `cart_${F.p3._id}`, 'Add to Cart 🛒')));
    await ctx.post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', lastPi()));
    await ctx.run('report', () => ops().getFlowReport({ flowId: flow._id, workspaceId: H.W }));
    eachRetire(ctx);
  });
  scenario('attribution: promotion send -> tap -> cart -> pay -> campaign report', async (ctx) => {
    const c = await ctx.cust('AttrPromo', { ...consented, address: '41 Promo Ave' });
    await ops().sendPromotion({ promotionId: F.pPlain._id, customerIds: [c._id], workspaceId: H.W });
    const cm = await ctx.cm(c);
    await ctx.post(envelope(tplBtn(c.phone, `promo_${F.pPlain._id}`, 'Shop Now', cm.wamid)));
    await ctx.post(envelope(ibtn(c.phone, `cart_${F.p3._id}`, 'Add to Cart 🛒')));
    await ctx.post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', lastPi()));
    await ctx.run('report', () => ops().getCampaignReport({ promotionId: F.pPlain._id, workspaceId: H.W }));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. STATUS CALLBACKS (C3 approved: Meta error code stored)
// ══════════════════════════════════════════════════════════════════════════════
describe('status callbacks', () => {
  let statSeq = 0;
  const mkCm = async (ctx, c, extra) => Q('CampaignMessage').create({ workspaceId: H.W, kind: 'promotion', promotion: F.pPlain._id, customer: c._id, phone: c.phone, wamid: `wamid.STAT_${H.scenarioNo}_${++statSeq}`, messageType: 'template', status: 'sent', sentAt: new Date(), ...(extra || {}) });
  const failure = (cm, c, code, title, message) => ({ id: cm.wamid, status: 'failed', timestamp: '1760000100', recipient_id: c.phone, errors: [{ code, title, ...(message ? { message } : {}), error_data: { details: title } }] });
  scenario('status/failed with Meta error codes 131047, 131049, 132001 and without errors', async (ctx) => {
    const cs = []; for (const l of ['StA', 'StB', 'StC', 'StD']) cs.push(await ctx.cust(l, consented));
    const cms = []; for (const c of cs) cms.push(await mkCm(ctx, c));
    await ctx.post(statusPayload([failure(cms[0], cs[0], 131047, 'Re-engagement message', 'Re-engagement message')]));
    await ctx.post(statusPayload([failure(cms[1], cs[1], 131049, 'This message was not delivered to maintain healthy ecosystem engagement.')]));
    await ctx.post(statusPayload([failure(cms[2], cs[2], 132001, 'Template does not exist', 'template name does not exist in en')]));
    await ctx.post(statusPayload([{ id: cms[3].wamid, status: 'failed', timestamp: '1760000100', recipient_id: cs[3].phone }]));
  }, { approve: 'C3' });
  scenario('status/sent, delivered, read, stale and out-of-order updates for campaign messages', async (ctx) => {
    const c = await ctx.cust('StFlow', consented); const cm = await mkCm(ctx, c, { status: 'queued', sentAt: undefined });
    for (const [st, ts] of [['sent', '1760000050'], ['delivered', '1760000100'], ['read', '1760000200'], ['delivered', '1760000300'], ['sent', '1760000400']]) await ctx.post(statusPayload([{ id: cm.wamid, status: st, timestamp: ts, recipient_id: c.phone }]));
    const d = await ctx.cust('StBatch', consented); const cm2 = await mkCm(ctx, d); const e = await ctx.cust('StBatch2', consented); const cm3 = await mkCm(ctx, e);
    await ctx.post(statusPayload([{ id: cm2.wamid, status: 'delivered', timestamp: '1760000100' }, { id: cm3.wamid, status: 'read', timestamp: '1760000150' }, { id: 'wamid.UNKNOWN', status: 'delivered', timestamp: '1760000150' }, { id: cm2.wamid, status: 'read' }]));
  }, { approve: 'C3' });
  scenario('status/failed after delivered is ignored; read after failed', async (ctx) => {
    const c = await ctx.cust('StOrder', consented); const cm = await mkCm(ctx, c);
    await ctx.post(statusPayload([{ id: cm.wamid, status: 'delivered', timestamp: '1760000100' }]));
    await ctx.post(statusPayload([failure(cm, c, 131026, 'Message undeliverable')]));
    const d = await ctx.cust('StOrder2', consented); const cm2 = await mkCm(ctx, d);
    await ctx.post(statusPayload([failure(cm2, d, 131026, 'Message undeliverable')]));
    await ctx.post(statusPayload([{ id: cm2.wamid, status: 'read', timestamp: '1760000200' }]));
  }, { approve: 'C3' });
  scenario('status/callbacks for manual inbox messages (WhatsAppMessage)', async (ctx) => {
    const c = await ctx.cust('StInbox', consented);
    await ctx.http('POST', `/api/inbox/conversations/${c._id}/messages`, { body: 'Hello from staff' });
    const msg = await Q('WhatsAppMessage').findOne({ customer: c._id, direction: 'outbound' });
    await ctx.post(statusPayload([{ id: msg.wamid, status: 'delivered', timestamp: '1760000100' }]));
    await ctx.post(statusPayload([{ id: msg.wamid, status: 'read', timestamp: '1760000200' }]));
    await ctx.http('POST', `/api/inbox/conversations/${c._id}/messages`, { body: 'Second message' });
    const msg2 = await Q('WhatsAppMessage').findOne({ customer: c._id, direction: 'outbound', messageBody: 'Second message' });
    await ctx.post(statusPayload([failure(msg2, c, 131049, 'Healthy ecosystem engagement')]));
  }, { approve: 'C3' });
  scenario('status/booking, flow and loyalty sends get their delivery ticks', async (ctx) => {
    const c = await ctx.cust('StKinds', { ...consented, loyaltyPoints: 300 });
    await ops().sendLoyaltyReminders({ customerIds: [c._id], workspaceId: H.W });
    const cm = await ctx.cm(c);
    await ctx.post(statusPayload([{ id: cm.wamid, status: 'delivered', timestamp: '1760000100' }]));
    await ctx.post(statusPayload([{ id: cm.wamid, status: 'read', timestamp: '1760000200' }]));
    await ctx.post(statusPayload([]));
  }, { approve: 'C3' });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. KEYWORDS not covered by the first suite, and duplicate phone numbers (H1 approved)
// ══════════════════════════════════════════════════════════════════════════════
describe('webhook envelope: verification handshake and template-status events', () => {
  scenario('webhook/verification handshake and template status update events are ignored', async (ctx) => {
    const token = process.env.WEBHOOK_VERIFY_TOKEN || 'my_verify_token';
    await ctx.http('GET', `/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=abc123`, undefined, { noAuth: true });
    await ctx.http('GET', '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123', undefined, { noAuth: true });
    await ctx.post({ object: 'whatsapp_business_account', entry: [{ id: '222222222222222', changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: 123, message_template_name: 'waflow_promo_v2', message_template_language: 'en', reason: 'NONE' } }] }] });
    await ctx.post({ object: 'whatsapp_business_account', entry: [{ id: '222222222222222', changes: [{ field: 'template_category_update', value: { message_template_name: 'waflow_promo_v2', previous_category: 'MARKETING', new_category: 'UTILITY' } }] }] });
    await ctx.http('GET', '/', undefined, { noAuth: true });
  });
});

describe('opt-out / opt-in: variants the first suite does not cover', () => {
  scenario('keywords/demo customer and already opted-out customer send STOP', async (ctx) => {
    const dm = await ctx.cust('KwDemo', { ...consented, isDemo: true }); const oo = await ctx.cust('KwAlready', optedOut);
    await ctx.post(envelope(textMsg(dm.phone, 'STOP'))); await ctx.post(envelope(textMsg(oo.phone, 'stop'))); await ctx.post(envelope(textMsg(oo.phone, 'Start')));
  });
  scenario('keywords/STOP variants that are not exact keywords are ignored', async (ctx) => {
    const c = await ctx.cust('KwNear', consented);
    for (const t of ['Stop.', 'STOP please', 'stop!', 'Please stop', 'unsubscribe me', 'START now', 'Subscribe!', 'stopp', 'S T O P']) await ctx.post(envelope(textMsg(c.phone, t)));
  });
  scenario('keywords/opted out, never consented: START explains it will not subscribe', async (ctx) => {
    const c = await ctx.cust('KwOptNoConsent', { optedOut: true, optedOutAt: new Date() });
    await ctx.post(envelope(textMsg(c.phone, 'START')));
    await ctx.post(envelope(textMsg(c.phone, 'SUBSCRIBE')));
  });
  scenario('keywords/pending consent ask: YES, NO, STOP, START and chat in one conversation', async (ctx) => {
    const c = await ctx.cust('KwAsk', { marketingConsentAskedAt: new Date() });
    for (const t of ['yes', 'stop', 'start', 'no', 'YES', 'maybe']) await ctx.post(envelope(textMsg(c.phone, t)));
  });
  scenario('keywords/YES typed while a points checkout, address request and consent ask are all pending', async (ctx) => {
    const c = await ctx.cust('KwBusy', { ...consented, marketingConsentAskedAt: new Date(), loyaltyPoints: 400 });
    state().pendingPointsCheckouts.set(c.phone, { cart: [{ name: 'Widget', description: 'Gadgets' }], promotion: null, totalPointsCost: 40, address: '1 Busy St', workspaceId: H.W, campaignMessageId: null });
    state().pendingAddressReqs.set(c.phone, 'cash');
    await ctx.post(envelope(textMsg(c.phone, 'yes')));
    await ctx.post(envelope(textMsg(c.phone, 'My address is 5 Busy Rd')));
  });
  scenario('keywords/unknown number sends START, YES and a button tap', async (ctx) => {
    await ctx.post(envelope(textMsg('15550999201', 'START'), 'Newcomer Start'));
    await ctx.post(envelope(textMsg('15550999202', 'YES'), 'Newcomer Yes'));
    await ctx.post(envelope(ibtn('15550999203', 'optout_none', 'Opt Out'), 'Newcomer Optout'));
    await ctx.post(envelope(textMsg('15550999204', 'SHOP'), 'Newcomer Shop'));
    await ctx.post(envelope(textMsg('15550999205', 'BOOK'), 'Newcomer Book'));
  });
  scenario('keywords/promo Opt Out buttons from template and interactive sends, repeated', async (ctx) => {
    const c = await ctx.cust('KwOptBtn', consented); await ops().sendPromotion({ promotionId: F.pPlain._id, customerIds: [c._id], workspaceId: H.W });
    const cm = await ctx.cm(c);
    await ctx.post(envelope(ibtn(c.phone, `optout_${F.pPlain._id}`, 'Opt Out', cm.wamid)));
    await ctx.post(envelope(tplBtn(c.phone, `optout_${F.pPlain._id}`, 'Opt Out', cm.wamid)));
    await ctx.post(envelope(textMsg(c.phone, 'START')));
    await ctx.post(envelope(ibtn(c.phone, `consent_yes_${c._id}`, 'Yes, sign me up')));
    await ctx.post(envelope(tplBtn(c.phone, `consent_no_${c._id}`, 'No thanks')));
  });
});

describe('duplicate phone numbers (H1: a STOP opts out every record of the same phone)', () => {
  const mk = async (ctx, label, phone, fields) => Q('Customer').create({ firstname: label, lastname: 'Dup', phone, workspaceId: H.W, ...(fields || {}) }).then((c) => { ctx.created.push(c); return c; });
  scenario('dup/same stored phone twice, STOP from that number', async (ctx) => {
    const a = await mk(ctx, 'DupExactA', '15550400001', consented); const b = await mk(ctx, 'DupExactB', '15550400001', consented);
    ctx.meta({ senderPhones: ['15550400001'] });
    await ctx.post(envelope(textMsg('15550400001', 'STOP')));
  }, { approve: 'H1' });
  scenario('dup/plus-prefixed and plain record, STOP from the plain number', async (ctx) => {
    const a = await mk(ctx, 'DupPlusA', '+15550400002', consented); const b = await mk(ctx, 'DupPlusB', '15550400002', consented);
    ctx.meta({ senderPhones: ['15550400002'] });
    await ctx.post(envelope(textMsg('15550400002', 'unsubscribe')));
  }, { approve: 'H1' });
  scenario('dup/spaced and 00-prefixed records, STOP via the Opt Out button', async (ctx) => {
    const a = await mk(ctx, 'DupSpace', '1 555 040 0003', consented); const b = await mk(ctx, 'Dup00', '0015550400003', consented); const c = await mk(ctx, 'DupPlain', '15550400003', consented);
    ctx.meta({ senderPhones: ['15550400003'] });
    await ctx.post(envelope(ibtn('15550400003', `optout_${F.pPlain._id}`, 'Opt Out')));
  }, { approve: 'H1' });
  scenario('dup/only a differently written record exists, STOP from the plain number', async (ctx) => {
    const a = await mk(ctx, 'DupOnlyPlus', '+15550400004', consented);
    ctx.meta({ senderPhones: ['15550400004'] });
    await ctx.post(envelope(textMsg('15550400004', 'STOP'), 'Dup Only Plus'));
  }, { approve: 'H1' });
  scenario('dup/START with duplicates (reinstatement is not part of H1)', async (ctx) => {
    const a = await mk(ctx, 'DupStartA', '15550400005', { ...optedOut }); const b = await mk(ctx, 'DupStartB', '15550400005', { ...optedOut });
    ctx.meta({ senderPhones: [] });
    await ctx.post(envelope(textMsg('15550400005', 'START')));
  });
  scenario('dup/promotion send to duplicates of one opted-out phone and one live record', async (ctx) => {
    const a = await mk(ctx, 'DupSendLive', '15550400006', consented); const b = await mk(ctx, 'DupSendOut', '+15550400006', optedOut);
    await ctx.run('send', () => ops().sendPromotion({ promotionId: F.pSmall._id, customerIds: ids(a, b), workspaceId: H.W }));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. DIRECT utils/whatsapp.js senders (the ~19 hard-coded "en" template sites live here), message nodes, /send-message
// ══════════════════════════════════════════════════════════════════════════════
describe('utils/whatsapp.js senders called directly', () => {
  const T = '15550990020';
  const P = () => ({ products: [F.p1, F.p2, F.p3].map((p) => p.toObject()), items: [F.p1, F.p3].map((p) => p.toObject()) });
  scenario('whatsapp/fixed templates: promo, loyalty, win-back, post purchase, points nudge, no show', async (ctx) => {
    const customer = { firstname: 'Direct', phone: T, loyaltyPoints: 260 };
    await ctx.run('promo', () => wa().sendPromoTemplate(T, customer, F.p1.toObject(), F.pPlain.toObject()));
    await ctx.run('loyalty', () => wa().sendLoyaltyTemplate(T, 'Direct', 260));
    await ctx.run('winback', () => wa().sendWinbackTemplate(T, 'Direct', 'flowid1', 'enrollid1'));
    await ctx.run('postPurchase', () => wa().sendPostPurchaseTemplate(T, 'Direct', 260, 'flowid2', 'enrollid2'));
    await ctx.run('pointsNudge', () => wa().sendPointsNudgeTemplate(T, 'Direct', 260, 'flowid3', 'enrollid3'));
    await ctx.run('noShow', () => wa().sendNoShowTemplate(T, 'Direct', 'Massage', 'svcid1', 'bookid1'));
    await ctx.run('noShowBlank', () => wa().sendNoShowTemplate(T, '', undefined, 'svcid1', 'bookid1'));
    await ctx.run('promoNoName', () => wa().sendPromoTemplate(T, {}, F.p2.toObject(), F.pSmall.toObject()));
  });
  scenario('whatsapp/utility and platform templates: consent request, OTP, team invite', async (ctx) => {
    await ctx.run('consent', () => wa().sendConsentRequestTemplate(T, 'Direct', 'cust1'));
    await ctx.run('consentBlank', () => wa().sendConsentRequestTemplate(T, '', 'cust2'));
    await ctx.run('otp', () => wa().sendOtpTemplate(T, '482913'));
    await ctx.run('invite', () => wa().sendInviteTemplate(T, 'Eng Fixture Shop'));
  });
  scenario('whatsapp/custom flow template and message-node follow-ups', async (ctx) => {
    await ctx.run('custom', () => wa().sendCustomFlowTemplate(T, 'waflow_flow_direct', ['Direct', 'Blue Shirt', 'SAR 20.00', 'Summer'], ['msgnode_a_0', 'msgnode_a_1']));
    await ctx.run('customNoButtons', () => wa().sendCustomFlowTemplate(T, 'waflow_flow_direct2', ['Direct'], []));
    await ctx.run('followUpButtons', () => wa().sendMessageNodeFollowUp(T, F.nN1, ['Direct']));
    await ctx.run('followUpText', async () => wa().sendMessageNodeFollowUp(T, { _id: 'n9', bodyText: 'Plain {{1}} and {{2}}', buttons: [] }, ['Direct', 'Two']));
  });
  scenario('whatsapp/announcements and catalogue messages', async (ctx) => {
    await ctx.run('announce', () => wa().sendPromoAnnouncement(T, { firstname: 'Direct' }, F.pPlain.toObject(), P().products));
    await ctx.run('announcePoints', () => wa().sendPointsPromoMessage(T, { firstname: 'Direct', loyaltyPoints: 300 }, F.pPoints.toObject(), P().items));
    await ctx.run('catalog', () => wa().sendCatalog(T, P().products, F.pPlain.toObject()));
    await ctx.run('catalogPoints', () => wa().sendCatalog(T, P().products, F.pPoints.toObject()));
    await ctx.run('catalogBrowse', () => wa().sendCatalog(T, P().products, null));
    await ctx.run('catalogText', () => wa().sendCatalog(T, F.bulk.map((p) => p.toObject()), F.pMany.toObject()));
    await ctx.run('catalogTextPoints', () => wa().sendCatalog(T, F.bulk.map((p) => p.toObject()), F.pPoints.toObject()));
    await ctx.run('categories', () => wa().sendCategories(T, wa().getCategories(P().products), F.pPlain.toObject()));
    await ctx.run('goodChoice', () => wa().sendGoodChoice(T, 'prod1'));
    await ctx.run('buildAnnouncement', async () => wa().buildPromoAnnouncementPayload({ firstname: 'Direct' }, F.pSvc.toObject(), [F.svcA.toObject(), F.svcB.toObject()]));
    await ctx.run('buildPoints', async () => wa().buildPointsPromoPayload({}, F.pPoints.toObject(), P().items));
  });
  scenario('whatsapp/product cards, carousel batches, variant picker and single product message', async (ctx) => {
    await ctx.run('cards', () => wa().sendProductCards(T, P().products, F.pPlain.toObject()));
    await ctx.run('cardsPoints', () => wa().sendProductCards(T, P().items, F.pPoints.toObject()));
    await ctx.run('carouselSmall', () => wa().sendProductCarousel(T, P().products, F.pPlain.toObject(), 0));
    await ctx.run('carouselBig', () => wa().sendProductCarousel(T, F.bulk.map((p) => p.toObject()), F.pMany.toObject(), 0));
    await ctx.run('carouselBatch2', () => wa().sendProductCarousel(T, F.bulk.map((p) => p.toObject()), F.pMany.toObject(), 10));
    await ctx.run('picker', () => wa().sendVariantPicker(T, F.p1.toObject(), F.pPlain.toObject()));
    await ctx.run('pickerPoints', () => wa().sendVariantPicker(T, F.p1.toObject(), F.pPoints.toObject()));
    await ctx.run('promoMessage', () => wa().sendPromoMessage(T, F.p1.toObject(), F.pPlain.toObject(), 250));
    await ctx.run('promoMessageNoPoints', () => wa().sendPromoMessage(T, F.p3.toObject(), F.pPlain.toObject(), 0));
  });
  scenario('whatsapp/service messages: slots, promo message, rebook, loyalty reminder', async (ctx) => {
    const slots = [F.slotA1, F.slotA2].map((s) => s.toObject());
    await ctx.run('slots', () => wa().sendServiceSlots(T, F.svcA.toObject(), slots, 'p1', false));
    await ctx.run('slotsFree', () => wa().sendServiceSlots(T, F.svcA.toObject(), slots, null, true));
    await ctx.run('slotsNone', () => wa().sendServiceSlots(T, F.svcA.toObject(), [], 'p1', false));
    await ctx.run('servicePromo', () => wa().sendServicePromoMessage(T, { firstname: 'Direct' }, F.svcA.toObject(), F.pSvc.toObject()));
    await ctx.run('servicePromoPoints', () => wa().sendServicePromoMessage(T, {}, F.svcA.toObject(), F.pSvcPoints.toObject()));
    await ctx.run('rebook', () => wa().sendRebookMessage(T, 'Direct', 'Massage', slots[0], 'svc1', 'book1'));
    await ctx.run('rebookNoSlot', () => wa().sendRebookMessage(T, 'Direct', 'Massage', null, 'svc1', 'book1'));
    await ctx.run('loyaltyReminder', () => wa().sendLoyaltyReminder(T, 'Direct', 640));
  });
  scenario('whatsapp/service message fallbacks when the interactive send is rejected', async (ctx) => {
    ctx.fail(isMsgType('interactive'), { times: 2, code: 131047 });
    await ctx.run('servicePromo', () => wa().sendServicePromoMessage(T, { firstname: 'Direct' }, F.svcA.toObject(), F.pSvc.toObject()));
    await ctx.run('rebook', () => wa().sendRebookMessage(T, 'Direct', 'Massage', null, 'svc1', 'book1'));
  });
  scenario('whatsapp/template management: create fixed templates, custom template, list, get, delete', async (ctx) => {
    for (const fn of ['createPromoTemplate', 'createLoyaltyTemplate', 'createWinbackTemplate', 'createPostPurchaseTemplate', 'createPointsNudgeTemplate', 'createNoShowTemplate', 'createOtpTemplate', 'createInviteTemplate', 'createConsentRequestTemplate']) {
      await ctx.run(fn, () => wa()[fn]());
    }
    await ctx.run('createCustom', () => wa().createTemplate('waflow_eng_custom', 'Hi {{1}}, your {{2}} is ready', 'MARKETING', ['Open', 'Later']));
    await ctx.run('createUtility', () => wa().createTemplate('waflow_eng_utility', 'Your code is ready', 'UTILITY', []));
    await ctx.run('list', () => wa().listTemplates());
    await ctx.run('get', () => wa().getTemplate('waflow_promo_v2'));
    await ctx.run('delete', () => wa().deleteTemplate('waflow_eng_custom'));
    await ctx.http('GET', '/api/whatsapp/templates');
    await ctx.http('POST', '/api/whatsapp/create-promo-template');
    await ctx.http('POST', '/api/whatsapp/create-winback-template');
    await ctx.http('DELETE', '/api/whatsapp/templates/waflow_eng_custom');
  });
});

describe('message nodes (template submission) and /send-message', () => {
  scenario('messagenode/submit entry template, refresh status, non-entry node, unknown node', async (ctx) => {
    const flow = await ops().createFlow({ name: 'Node flow', triggerType: 'inactive_customer', workspaceId: H.W });
    const entry = await ops().createMessageNode({ ownerType: 'flow', ownerId: flow._id, isEntryNode: true, bodyText: 'Hi {{1}}, we miss you', buttons: [{ position: 0, label: 'Shop', nextAction: { type: 'end_flow' } }, { position: 1, label: 'Later', nextAction: { type: 'end_flow' } }], workspaceId: H.W });
    const plain = await ops().createMessageNode({ ownerType: 'flow', ownerId: flow._id, bodyText: 'Follow up', depth: 1, buttons: [], workspaceId: H.W });
    await ctx.http('POST', `/api/message-nodes/${entry._id}/submit-template`);
    await ctx.http('POST', `/api/message-nodes/${entry._id}/refresh-status`);
    await ctx.http('POST', `/api/message-nodes/${plain._id}/submit-template`);
    await ctx.http('POST', `/api/message-nodes/${new mongoose.Types.ObjectId()}/refresh-status`);
    await ctx.http('GET', `/api/message-nodes/${entry._id}`);
  });
  scenario('send-message route: text, text with image + button tap, validation', async (ctx) => {
    await ctx.http('POST', '/send-message', { to: '15550990030', message: 'Hello from the dashboard' }, { noAuth: true });
    await ctx.http('POST', '/send-message', { to: '15550990030' }, { noAuth: true });
    await ctx.http('POST', '/send-message', undefined, { noAuth: true, attach: { name: 'images', buffer: Buffer.from('fakeimage'), filename: 'shirt.jpg' }, fields: { to: '15550990031', message: 'New arrival', productName: 'Linen Shirt', price: '29.5' } });
    const call = H.calls.find((cl) => cl.body && cl.body.interactive && cl.body.interactive.action && cl.body.interactive.action.buttons && /^int_/.test(cl.body.interactive.action.buttons[0].reply.id));
    if (call) await ctx.post(envelope(ibtn('15550990031', call.body.interactive.action.buttons[0].reply.id, 'Interested? 🛍️'), 'Image Buyer'));
    await ctx.http('POST', '/send-message', { to: '15550990030', message: 'rejected' }, { noAuth: true });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. CUSTOMER CREATION / IMPORT (names, consent) - B4 and B2 live here
// ══════════════════════════════════════════════════════════════════════════════
describe('customers: creation, consent and CSV import', () => {
  scenario('customers/create via the API: two-word name, consent box, no phone', async (ctx) => {
    await ctx.http('POST', '/api/customers', { firstname: 'Layla', lastname: 'Hassan', phone: '15550610001', marketingConsent: true });
    await ctx.http('POST', '/api/customers', { firstname: 'Noor', lastname: 'Ali' });
    await ctx.http('POST', '/api/customers', { firstname: 'Sami', lastname: 'Kareem', phone: '15550610004', marketingConsent: false, email: 'sami@example.test' });
  });
  scenario('customers/create via the API with a one-word name (B4: only flagged workspaces may change)', async (ctx) => {
    await ctx.http('POST', '/api/customers', { firstname: 'Madonna', phone: '15550610002' });
    await ctx.http('POST', '/api/customers', { firstname: 'Omar', lastname: '', phone: '15550610003' });
  }, { approve: 'B4' });
  scenario('customers/update strips consent fields; mark consented; lookups', async (ctx) => {
    const c = await ctx.cust('CustUp');
    await ctx.http('PUT', `/api/customers/${c._id}`, { firstname: 'CustUp2', marketingConsent: true, optedOut: false, address: '8 Update St' });
    await ctx.http('POST', `/api/customers/${c._id}/consent`);
    await ctx.http('GET', `/api/customers/${c._id}`);
    await ctx.http('GET', `/api/customers/${new mongoose.Types.ObjectId()}`);
    await ctx.http('POST', `/api/customers/${new mongoose.Types.ObjectId()}/consent`);
  });
  const csvJob = async (ctx, csv, attested) => {
    const up = await ctx.http('POST', '/api/imports', undefined, { attach: { name: 'file', buffer: Buffer.isBuffer(csv) ? csv : Buffer.from(csv, 'utf8'), filename: 'customers.csv' }, fields: { entityType: 'customer', marketingConsentAttested: attested ? 'true' : 'false' } });
    const id = up.body && up.body.id; if (!id) return;
    await ctx.http('PATCH', `/api/imports/${id}/mapping`, { columnMapping: up.body.columnMapping });
    await ctx.http('POST', `/api/imports/${id}/run`, {});
    await ctx.http('GET', `/api/imports/${id}`);
  };
  scenario('import/english customer CSV with consent attestation (one-word name, existing phone, bad rows)', async (ctx) => {
    await ctx.cust('ImportExisting', { phone: '966501110001' });
    await csvJob(ctx, 'Name,Phone,Email,Points\nAnna Smith,0501110002,anna@example.test,100\nLayla,+966501110003,,0\nBob Jones,966501110001,bob@example.test,50\nNo Phone,,x@y.test,5\nBad Email,0501110004,not-an-email,1\nMary Ann Lee,00966501110005,mary@example.test,250\n', true);
  });
  scenario('import/english customer CSV without attestation', async (ctx) => {
    await csvJob(ctx, 'Full Name,Mobile,Notes\nCarl Dunn,0501110006,vip\nDina,0501110007,\n', false);
  });
  scenario('import/arabic CSV without BOM and Windows-1256 encoded (B2 approved difference)', async (ctx) => {
    const sara = String.fromCodePoint(0x633, 0x627, 0x631, 0x629); const ali = String.fromCodePoint(0x639, 0x644, 0x64A);
    await csvJob(ctx, Buffer.from(`Name,Phone\n${sara} ${ali},0501110010\n`, 'utf8'), true);
    await csvJob(ctx, Buffer.concat([Buffer.from('Name,Phone\n'), Buffer.from([0xD3, 0xC7, 0xD1, 0xC9]), Buffer.from(',0501110011\n')]), true);
  }, { approve: 'B2' });
  scenario('import/arabic-indic digits and Arabic names (B2 approved difference)', async (ctx) => {
    await csvJob(ctx, `Name,Phone,Points\nSara Ali,\u{0660}\u{0665}\u{0660}\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667},\u{0661}\u{0660}\u{0660}\nOmar Said,0501110008,20\n`, true);
  }, { approve: 'B2' });
});

describe('GPT Actions surface (same operations behind a bearer key)', () => {
  scenario('gpt/send promotion, loyalty reminder, test send, order and booking messages', async (ctx) => {
    const key = process.env.GPT_API_KEY;
    const a = await ctx.cust('GptA', { ...consented, loyaltyPoints: 400, address: '1 Gpt St' }); const b = await ctx.cust('GptNoConsent', { loyaltyPoints: 400 });
    await ctx.http('POST', `/gpt-api/promotions/${F.pPlain._id}/send`, { customerIds: sids(a, b) }, { bearer: key });
    await ctx.http('POST', '/gpt-api/loyalty/remind', { customerIds: sids(a, b) }, { bearer: key });
    await ctx.http('POST', `/gpt-api/promotions/${F.pEntry._id}/test-send`, { phone: '15550990040' }, { bearer: key });
    await ctx.http('POST', '/gpt-api/orders', { customerId: String(a._id), items: [{ productId: String(F.p3._id), quantity: 1 }] }, { bearer: key });
    const slot = await Q('TimeSlot').create({ workspaceId: H.W, serviceId: F.svcA._id, date: '2030-06-01', startTime: '10:00', endTime: '11:00', capacity: 3, bookedCount: 1 });
    const bk = await Q('Booking').create({ workspaceId: H.W, serviceId: F.svcA._id, slotId: slot._id, customerId: a._id, phone: a.phone, customerName: 'Gpt A', status: 'confirmed', paymentType: 'cash', amount: 80 });
    await ctx.http('POST', `/gpt-api/bookings/${bk._id}/cancel`, {}, { bearer: key });
    await ctx.http('POST', `/gpt-api/promotions/${F.pPlain._id}/send`, { customerIds: sids(a) }, { bearer: 'wrong-key' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. COVERAGE ADDITIONS (validation pass): code paths the v8 coverage run of scenarios 1-9 showed were never executed.
//     Appended at the END so the labels and ordering of every earlier scenario are unchanged.
// ══════════════════════════════════════════════════════════════════════════════
describe('journey gaps found by the coverage audit', () => {
  // The inbox hook creates a customer for every inbound message EXCEPT when the WhatsApp profile name is a single word
  // (existing defect, B4 changes it for flagged workspaces only). That is the only way the "no profile" replies are reachable.
  scenario('journey/no customer record (one-word WhatsApp name): checkout, address reply and points checkout (B4: flagged workspaces may change)', async (ctx) => {
    const P = '15550888201'; const post = (m) => ctx.post(envelope(m, 'Layla'));
    await post(ibtn(P, `promo_${F.pPlain._id}`, 'Shop Now! 🛍️'));
    await post(ibtn(P, `cart_${F.p3._id}`, 'Add to Cart 🛒'));
    await post(ibtn(P, 'checkout', 'Checkout ✅'));
    state().pendingAddressReqs.set(P, 'cash');
    await post(textMsg(P, '5 Anonymous Street, Riyadh'));
    await post(ibtn(P, `promo_${F.pPoints._id}`, 'Shop Now! 💎'));
    await post(ibtn(P, `cart_${F.p3._id}`, 'Redeem 💎'));
    await post(ibtn(P, 'points_checkout', 'Redeem Points 💎'));
  }, { approve: 'B4J' });
  scenario('journey/service: the slot fills up between the slot pick and the pay-later tap', async (ctx) => {
    const c = await ctx.cust('SvcRace', consented);
    const slot = await Q('TimeSlot').create({ workspaceId: H.W, serviceId: F.svcA._id, date: '2030-07-01', startTime: '09:00', endTime: '10:00', capacity: 1, bookedCount: 0 });
    await ctx.post(envelope(ibtn(c.phone, `promo_${F.pSvc._id}`, 'Book Now! 📅')));
    await ctx.post(envelope(lrow(c.phone, `slot_${slot._id}`, '2030-07-01 · 09:00')));
    await Q('TimeSlot').updateOne({ _id: slot._id }, { bookedCount: 1 });
    await ctx.post(envelope(ibtn(c.phone, `paylater_${slot._id}`, 'Reserve, Pay in Person')));
    await ctx.post(envelope(ibtn(c.phone, `paylater_${slot._id}`, 'Reserve, Pay in Person')));
  });
  scenario('journey/bulk consent-request template quick reply: yes (known customer), yes (unknown id), yes (malformed id)', async (ctx) => {
    const c = await ctx.cust('QuickYes');
    await ctx.run('ask', () => ops().sendConsentRequests({ workspaceId: H.W, customerIds: ids(c) }));
    await ctx.post(envelope(tplBtn(c.phone, `consent_yes_${c._id}`, 'Yes, sign me up')));
    await ctx.post(envelope(tplBtn(c.phone, `consent_yes_${new mongoose.Types.ObjectId()}`, 'Yes, sign me up')));
    await ctx.post(envelope(tplBtn(c.phone, 'consent_yes_notanid', 'Yes, sign me up')));
  });
  scenario('journey/points: the balance is lower than the quoted cost at the YES (checkout, then service booking)', async (ctx) => {
    const c = await ctx.cust('PtsRace', { ...consented, loyaltyPoints: 100 });
    state().pendingPointsCheckouts.set(c.phone, { cart: [{ name: 'Widget', description: 'Gadgets' }], promotion: null, totalPointsCost: 5000, address: '1 Race St', workspaceId: H.W, campaignMessageId: null });
    await ctx.post(envelope(textMsg(c.phone, 'YES')));
    state().pendingServiceCheckouts.set(c.phone, { service: F.svcA.toObject(), slot: F.slotA1.toObject(), promotion: null, totalPointsCost: 5000, workspaceId: H.W });
    await ctx.post(envelope(textMsg(c.phone, 'yes')));
  });
  scenario('journey/cash: number selection with "all" and with out-of-range numbers', async (ctx) => {
    const c = await ctx.cust('JAll', consented);
    await ctx.post(envelope(tplBtn(c.phone, `promo_${F.pMany._id}`, 'Shop Now')));
    await ctx.post(envelope(textMsg(c.phone, '99, 0, abc')));
    await ctx.post(envelope(textMsg(c.phone, 'all')));
  });
  scenario('service/promotion send -> template tap -> slot -> Stripe attributes the CampaignMessage', async (ctx) => {
    const c = await ctx.cust('SvcAttr', consented);
    await ops().sendPromotion({ promotionId: F.pSvc._id, customerIds: [c._id], workspaceId: H.W });
    const cm = await ctx.cm(c);
    await ctx.post(envelope(tplBtn(c.phone, `promo_${F.pSvc._id}`, 'Book Now! 📅', cm.wamid)));
    await ctx.post(envelope(lrow(c.phone, `slot_${F.slotA2._id}`, '2030-01-16 · 10:00')));
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', lastPi()));
    await ctx.run('report', () => ops().getCampaignReport({ promotionId: F.pSvc._id, workspaceId: H.W }));
  });
  scenario('stripe: a payment without a pending order is turned into an order from the in-memory cart and credited to the campaign message', async (ctx) => {
    const c = await ctx.cust('StripeCart', { ...consented, address: '8 Fallback St' });
    await ops().sendPromotion({ promotionId: F.pPlain._id, customerIds: [c._id], workspaceId: H.W });
    const cm = await ctx.cm(c);
    state().carts.set(c.phone, [{ name: 'Cart Item One', description: 'Misc', priceAud: 25, pointsCost: 0 }, { name: 'Cart Item Two', priceAud: 12, pointsCost: 0 }]);
    const pi = { id: `pi_nopending_S${H.scenarioNo}`, amount: 3800, currency: 'sar', metadata: { buyerPhone: c.phone, subtotal: '37', shippingCost: '1', address: '8 Fallback St', promotionId: String(F.pPlain._id), campaignMessageId: String(cm._id) } };
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', pi));
    await ctx.stripeEvent(piEvent('payment_intent.succeeded', pi));
    await ctx.run('report', () => ops().getCampaignReport({ promotionId: F.pPlain._id, workspaceId: H.W }));
  });
  scenario('journey/nothing to show: promotion without products, flow browse and service promotion while the catalogue is switched off', async (ctx) => {
    const c = await ctx.cust('NoStock', consented);
    const empty = await Q('Promotion').create({ workspaceId: H.W, name: 'Empty Promo', customerType: 'cash', scope: 'products', discountPercent: 10 });
    const emptySvc = await Q('Promotion').create({ workspaceId: H.W, name: 'Empty Services', customerType: 'cash', scope: 'services', type: 'specific_services', discountPercent: 10 });
    const activeP = (await Q('Product').find({ workspaceId: H.W, active: true }, '_id').lean()).map((p) => p._id);
    const activeS = (await Q('Service').find({ workspaceId: H.W, active: { $ne: false } }, '_id').lean()).map((s) => s._id);
    try {
      await Q('Product').collection.updateMany({ _id: { $in: activeP } }, { $set: { active: false } });
      await Q('Service').collection.updateMany({ _id: { $in: activeS } }, { $set: { active: false } });
      await ctx.post(envelope(tplBtn(c.phone, `promo_${empty._id}`, 'Shop Now')));
      await ctx.post(envelope(tplBtn(c.phone, `promo_${F.pStoreWide._id}`, 'Shop Now')));
      await ctx.post(envelope(tplBtn(c.phone, `flowbrowse_${new mongoose.Types.ObjectId()}_${new mongoose.Types.ObjectId()}`, 'Shop Now')));
      await ctx.post(envelope(ibtn(c.phone, `promo_${emptySvc._id}`, 'Book Now! 📅')));
      await ctx.post(envelope(textMsg(c.phone, 'shop')));
    } finally {
      await Q('Product').collection.updateMany({ _id: { $in: activeP } }, { $set: { active: true } });
      await Q('Service').collection.updateMany({ _id: { $in: activeS } }, { $set: { active: true } });
    }
  });
});

describe('inbox, flow and builder gaps found by the coverage audit', () => {
  scenario('inbox/the same inbound WhatsApp message delivered twice is logged once', async (ctx) => {
    const c = await ctx.cust('InboxDup', consented);
    const m = textMsg(c.phone, 'Is my order ready?');
    await ctx.post(envelope(m, 'Inbox Dup'));
    await ctx.post(envelope(m, 'Inbox Dup'));
  });
  scenario('inbox/updateMessageStatus for manual sends: delivered, read, stale, failed (the webhook never reaches it for non-campaign wamids)', async (ctx) => {
    const c = await ctx.cust('InboxTicks', consented);
    await ctx.http('POST', `/api/inbox/conversations/${c._id}/messages`, { body: 'First staff message' });
    await ctx.http('POST', `/api/inbox/conversations/${c._id}/messages`, { body: 'Second staff message' });
    const [m1, m2] = await Q('WhatsAppMessage').find({ customer: c._id, direction: 'outbound' }).sort({ createdAt: 1, _id: 1 });
    await ctx.run('delivered', () => inboxMod().updateMessageStatus({ id: m1.wamid, status: 'delivered' }, H.W));
    await ctx.run('read', () => inboxMod().updateMessageStatus({ id: m1.wamid, status: 'read' }, H.W));
    await ctx.run('stale', () => inboxMod().updateMessageStatus({ id: m1.wamid, status: 'sent' }, H.W));
    await ctx.run('failed', () => inboxMod().updateMessageStatus({ id: m2.wamid, status: 'failed', errors: [{ code: 131049, title: 'Healthy ecosystem engagement' }] }, H.W));
    await ctx.run('unknown', () => inboxMod().updateMessageStatus({ id: 'wamid.NOSUCH', status: 'read' }, H.W));
    await ctx.run('otherWorkspace', () => inboxMod().updateMessageStatus({ id: m2.wamid, status: 'read' }, W2));
  });
  scenario('inbox and customers: conversation list, customer list and history reads (filtered to this scenario)', async (ctx) => {
    const c = await ctx.cust('ReadThread', { ...consented, loyaltyPoints: 77 });
    await ctx.post(envelope(textMsg(c.phone, 'Hello, reading test'), 'Read Thread'));
    await ctx.http('GET', '/api/inbox/conversations?search=ReadThread');
    await ctx.http('GET', '/api/inbox/conversations?search=ReadThread&filter=unread');
    await ctx.http('GET', '/api/customers?search=ReadThread');
    await ctx.http('GET', `/api/customers/${c._id}/whatsapp-history`);
    await ctx.http('GET', `/api/customers/${c._id}/bookings`);
  });
  scenario('flow/post_purchase_points: the order is refunded between enrolment and send', async (ctx) => {
    const c = await ctx.cust('PostRefundLate', { ...consented, loyaltyPoints: 120 });
    await Q('Order').create({ customer: c._id, workspaceId: H.W, items: [{ productName: 'Tee', category: 'Shirts', quantity: 1, unitPrice: 20 }], subtotal: 20, total: 20, status: 'confirmed', paymentStatus: 'paid', paidAt: D(5 / 24), loyaltyPointsEarned: 100 });
    const flow = await ops().createFlow({ name: 'Post refund late', triggerType: 'post_purchase_points', delayHours: 2, workspaceId: H.W });
    const live = await ops().activateFlow({ id: flow._id, workspaceId: H.W });
    await ctx.run('enroll', () => sched().enrollEligibleCustomers(live));
    await Q('Order').updateOne({ customer: c._id }, { paymentStatus: 'refunded' });
    await ctx.run('send', () => sched().sendPendingEnrollments(live));
    eachRetire(ctx);
  });
  scenario('whatsapp/builders not reached by the first suite: points announcement, picker with a base row, points carousel', async (ctx) => {
    const T = '15550990060';
    await ctx.run('announcePointsPromo', () => wa().sendPromoAnnouncement(T, { firstname: 'Direct' }, F.pPoints.toObject(), [F.p3, F.p4].map((p) => p.toObject())));
    await ctx.run('buildPointsService', async () => wa().buildPromoAnnouncementPayload({ firstname: 'Direct' }, F.pSvcPoints.toObject(), [F.svcA.toObject()]));
    await ctx.run('pickerBaseRow', () => wa().sendVariantPicker(T, { ...F.p1.toObject(), stock: 3 }, F.pPlain.toObject()));
    await ctx.run('pickerNoVariants', () => wa().sendVariantPicker(T, { ...F.p2.toObject(), variants: [] }, null));
    const pc = await Q('Promotion').create({ workspaceId: H.W, name: 'Points Carousel', customerType: 'points', pointsPrice: 120, scope: 'products', sendFormat: 'carousel', products: [F.p1._id, F.p4._id, F.p5._id] });
    const c = await ctx.cust('PtsCarousel', { ...consented, loyaltyPoints: 400 });
    await ctx.http('POST', `/api/promotions/${pc._id}/send`, { customerIds: sids(c) });
    await ctx.http('POST', `/api/promotions/${pc._id}/test-send`, { phone: T });
  });
});

describe('AI Mode tool layer (the confirm-gated actions call the same operations)', () => {
  scenario('ai tools: send_promotion, send_test_message, send_loyalty_reminders and list_customers', async (ctx) => {
    const tools = require('../../../ai/tools'); const run = (n, args) => ctx.run(n, () => tools.getTool(n).run(args, H.W));
    const a = await ctx.cust('AiToolA', { ...consented, loyaltyPoints: 300 }); const b = await ctx.cust('AiToolNoConsent', { loyaltyPoints: 300 });
    await run('send_promotion', { promotionId: String(F.pPlain._id), customerIds: sids(a, b) });
    await run('send_test_message', { promotionId: String(F.pEntry._id), phone: '15550990050' });
    await run('send_loyalty_reminders', { customerIds: sids(a, b) });
    await run('list_customers', { search: 'AiToolA', limit: 5 });
  });
});

describe('internal admin tool (staff-only customer lookup, correction and erasure)', () => {
  const basic = () => ({ noAuth: true, headers: { Authorization: `Basic ${Buffer.from(`${process.env.INTERNAL_ADMIN_USER}:${process.env.INTERNAL_ADMIN_PASSWORD}`).toString('base64')}` } });
  scenario('internaladmin/search, view, correct and anonymise a customer; wrong password', async (ctx) => {
    const c = await ctx.cust('AdminView', { ...consented, address: '3 Admin Rd', email: 'admin.view@example.test' });
    await ctx.http('GET', '/internal-admin/', undefined, basic());
    await ctx.http('GET', `/internal-admin/customers?q=${c.phone}`, undefined, basic());
    await ctx.http('GET', '/internal-admin/customers?q=admin.view@example.test', undefined, basic());
    await ctx.http('GET', `/internal-admin/customers/${c._id}`, undefined, basic());
    await ctx.http('POST', `/internal-admin/customers/${c._id}/correct`, { firstname: 'AdminFixed', phone: c.phone, email: 'admin.fixed@example.test' }, basic());
    await ctx.http('POST', `/internal-admin/customers/${c._id}/delete`, { reason: 'engineering test' }, basic());
    await ctx.http('GET', `/internal-admin/customers/${c._id}`, undefined, basic());
    await ctx.http('GET', '/internal-admin/customers?q=1', undefined, { noAuth: true, headers: { Authorization: `Basic ${Buffer.from('nobody:wrong').toString('base64')}` } });
    await ctx.http('GET', '/internal-admin/', undefined, { noAuth: true });
  });
  scenario('internaladmin/search with Arabic-Indic digits (B2: digits)', async (ctx) => {
    const c = await ctx.cust('AdminDigits', consented);
    const arabic = String(c.phone).split('').map((d) => String.fromCodePoint(0x660 + Number(d))).join('');
    await ctx.http('GET', `/internal-admin/customers?q=${encodeURIComponent(arabic)}`, undefined, basic());
  }, { approve: 'B2' });
});

describe('platform login (WhatsApp OTP) and team invites (WhatsApp invite template)', () => {
  scenario('auth/otp request + verify with formatted phone numbers, then an owner invites a phone number and the invitee logs in', async (ctx) => {
    const request = require('supertest'); const crypto = require('crypto');
    const spy = jest.spyOn(crypto, 'randomInt').mockReturnValue(424242);
    const verify = async (name, body) => { const r = await request(H.app).post('/api/auth/otp/verify').send(body); ctx.ret(name, { status: r.status, error: r.body.error, hasToken: !!r.body.token, role: r.body.role, workspace: r.body.workspace && r.body.workspace.name, chooseWorkspace: r.body.chooseWorkspace }); };
    try {
      await ctx.http('POST', '/api/auth/otp/request', { phone: '+966 50-123-0001' }, { noAuth: true });
      await ctx.http('POST', '/api/auth/otp/request', {}, { noAuth: true });
      await verify('verifyWrongCode', { phone: '966501230001', code: '000000' });
      await verify('verifyNoCode', { phone: '966501230001' });
      await verify('verifyOk', { phone: '(966) 501 230 001', code: '424242' });
      await verify('verifyAgain', { phone: '966501230001', code: '424242' });
      await ctx.http('POST', '/api/workspaces/me/invites', { contactType: 'phone', contact: '+966 50 123 0002', role: 'member' });
      await ctx.http('POST', '/api/workspaces/me/invites', { contactType: 'phone', contact: '966501230002' });
      await ctx.http('POST', '/api/workspaces/me/invites', { contactType: 'phone', contact: '' });
      await ctx.http('POST', '/api/workspaces/me/invites', { contactType: 'fax', contact: '1' });
      await ctx.http('POST', '/api/auth/otp/request', { phone: '966501230002' }, { noAuth: true });
      await verify('inviteeLogsIn', { phone: '966501230002', code: '424242' });
    } finally { spy.mockRestore(); }
  });
});

describe('new localisation collections', () => {
  test('writes nothing to any new collection unless the flag is on and not killed; English customers are never labelled Arabic', async () => {
    const db = mongoose.connection.db;
    const names = (await db.listCollections().toArray()).map((c) => c.name).filter((n) => NEW_COLLECTION_RE.test(n));
    const counts = {};
    for (const n of names) counts[n] = await db.collection(n).countDocuments();
    const slow = Object.entries(H.timings).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, ms]) => `${ms}ms ${n.slice(0, 70)}`);
    process.stdout.write(`[englishUnchanged2] slowest: ${JSON.stringify(slow)}
`);
    process.stdout.write(`[englishUnchanged2] mode flagOn=${FLAG_ON} kill=${KILL} record=${RECORD} scenarios=${H.scenarioNo} new-collection counts: ${JSON.stringify(counts)}\n`);
    const fixtureOnly = (n) => (n === 'localesettings' ? (FLAG_ON ? 2 : 0) : (n === 'customerlanguages' && FLAG_ON ? 2 : 0));
    for (const n of names) {
      if (FLAG_ON && !KILL) continue; // inference may legitimately write 'en' rows (checked below)
      expect({ [n]: counts[n] }).toEqual({ [n]: fixtureOnly(n) });
    }
    if (FLAG_ON) {
      const langs = await db.collection('customerlanguages').find({}).toArray();
      const customers = await db.collection('customers').find({}).toArray();
      const byId = Object.fromEntries(customers.map((c) => [String(c._id), c]));
      for (const l of langs) {
        if ([String(arabicBystander._id), String(arabicBystander2._id)].includes(String(l.customerId))) continue;
        expect(['en', 'unknown']).toContain(l.language);
        expect(byId[String(l.customerId)]).toBeDefined();
      }
      if (KILL) expect(langs.length).toBe(2);
    }
  });
});
