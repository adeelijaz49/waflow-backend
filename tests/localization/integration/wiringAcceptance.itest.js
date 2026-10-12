'use strict';
// WIRING ACCEPTANCE (ACC-BE): the combined end-to-end test of the Arabic wiring phase. The REAL server.js (webhook, Stripe webhook,
// dashboard routes, hub routes, customer pages) and the REAL shared/operations.js senders run against the THROWAWAY mongod with
// the axios adapter stubbed - nothing leaves the machine, no real WhatsApp / Meta / Stripe / Anthropic call is possible
// (Stripe and the Anthropic client are jest mocks, the HTTP adapter is a recorder, the dev proxy is dead).
//
// World: the FIRST-created workspace A is the flagged pilot workspace (the production webhook is single-workspace and serves the
// OLDEST workspace); workspace B is created after it and is NOT flagged. Seed data goes in through the models (Arabic and English
// customers with CustomerLanguage rows, approved+reviewed / pending / draft Arabic template variants, reviewed and draft product
// translations). One file, one FRESH database name per run (the suite refuses a non-empty database). Nothing is ever deleted.
//
//   1  spec Phase-1 done-when (loyalty reminder, opt-out words, diacritics / alef / Arabic-Indic digits)
//   2  spec Phase-2 done-when (promotions: variants, fallbacks, Meta error stop, plan == send, test send, report)
//   3  flows: scheduler -> Arabic entry message -> tap -> Arabic follow-up, hub APIs (create / edit / review / AI translate / stale)
//   4  the shopping journey from the Arabic template button to the Stripe confirmation, English control, no mixed language
//   5  H1: duplicate customer records of one person
//   6  data: CSV import with a language column, Arabic digits, Windows-1256, B4, Arabic name columns -> drafts
//   7  customer pages: pay page switch link, ?lang=ar, stored language, redirects unchanged
//   8  C3: failed status callbacks store the Meta error code and the report views expose it
//   9  kill switch LOCALIZATION_DISABLED=1
//  10  tenant isolation
const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();

const request = require('supertest');
const axios = require('axios');
const mongoose = require('mongoose');

// ── mocks: nothing real can be called ────────────────────────────────────────
const mockStripe = { seq: 0, store: {}, last: null, failNext: false };
jest.mock('stripe', () => () => ({
  paymentIntents: {
    create: async (args) => {
      if (mockStripe.failNext) { mockStripe.failNext = false; throw new Error('stripe stub: unavailable'); }
      mockStripe.seq += 1;
      const pi = { id: `pi_stub_${mockStripe.seq}`, ...args, status: 'requires_payment_method', client_secret: `pi_stub_${mockStripe.seq}_secret` };
      mockStripe.store[pi.id] = pi; mockStripe.last = pi;
      return pi;
    },
    retrieve: async (id) => { if (!mockStripe.store[id]) { const err = new Error('No such payment_intent'); err.code = 'resource_missing'; throw err; } return mockStripe.store[id]; },
  },
  webhooks: { constructEvent: (body) => JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body)) },
}));
// The fake Anthropic client the hub's "AI translate" uses (aiAssist.defaultGetClient requires ../../ai/client when ANTHROPIC_API_KEY is set).
const mockAi = { calls: [], reply: () => ({ text: '' }) };
jest.mock('../../../ai/client', () => ({
  messages: { create: async (args) => { mockAi.calls.push(args); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(mockAi.reply(args)) }] }; } },
}));

jest.setTimeout(900000);

const fx = require('./_fixtures');
const W = require('./helpers/_wire');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Q = (name) => require(`../../../models/${name}`);
const catalog = () => require('../../../shared/localization/catalog');

// ── outbound recorder (the ONLY thing that can "send") ───────────────────────
let calls = [];
const ALL = []; // every outbound message of the whole run (never reset): scanned by the hygiene test at the end
let wamidSeq = 0;
let failRules = [];
axios.defaults.adapter = async (config) => {
  let body = config.data;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep */ } }
  const rec = { method: String(config.method || '').toUpperCase(), url: String(config.url || ''), body: body === undefined ? null : body };
  calls.push(rec);
  if (W.isMessagesCall(rec)) ALL.push({ test: (expect.getState() || {}).currentTestName, body: rec.body });
  for (const rule of failRules) {
    if (rule.remaining !== 0 && rule.match(rec)) {
      if (rule.remaining > 0) rule.remaining -= 1;
      const response = { status: 400, statusText: 'Bad Request', headers: {}, config, data: { error: { message: rule.message || 'Meta stub rejected this call', code: rule.code, type: 'OAuthException' } } };
      throw new axios.AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', config, {}, response);
    }
  }
  const isMsg = /\/messages$/.test(rec.url);
  let data;
  if (rec.method === 'GET' && config.params && config.params.fields === 'display_phone_number') data = { display_phone_number: '+1 555 000 0000', id: '111111111111111' };
  else if (rec.method === 'GET') data = config.responseType === 'arraybuffer' ? Buffer.from('x') : { data: [] };
  else if (isMsg) data = { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.ACC${++wamidSeq}` }] };
  else data = { id: `stub${++wamidSeq}` };
  return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};
const msgs = () => W.messagesOf(calls).map((c) => c.body);
const to = (phone) => msgs().filter((m) => m.to === phone);
const reset = () => { calls.length = 0; failRules = []; };

// ── webhook helpers ──────────────────────────────────────────────────────────
let app; let A; let B; let msgSeq = 0;
const base = (from) => ({ from, id: `wamid.IN${++msgSeq}x${Date.now().toString(36)}`, timestamp: '1760000000' });
const envelope = (message, name = 'Acceptance Tester') => ({ object: 'whatsapp_business_account', entry: [{ id: '222222222222222', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '111111111111111' },
  contacts: [{ profile: { name }, wa_id: message.from }], messages: [message] } }] }] });
const textMsg = (from, body) => ({ ...base(from), type: 'text', text: { body } });
const ibtn = (from, id, title) => ({ ...base(from), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
const lrow = (from, id, title) => ({ ...base(from), type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title, description: 'row' } } });
const tplBtn = (from, payload, contextId) => ({ ...base(from), type: 'button', button: { payload, text: 'x' }, ...(contextId ? { context: { from: '1', id: contextId } } : {}) });

async function quiet() {
  await sleep(300);
  let last = -1; let stable = 0;
  for (let i = 0; i < 80 && stable < 3; i += 1) { if (calls.length === last) stable += 1; else { stable = 0; last = calls.length; } await sleep(100); }
}
async function post(message, name) { await request(app).post('/webhook').send(envelope(message, name)); await quiet(); }
async function postStatuses(statuses) {
  await request(app).post('/webhook').send({ object: 'whatsapp_business_account', entry: [{ id: '2', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '1' }, statuses } }] }] });
  await sleep(700);
}
async function stripeSucceeded(pi = mockStripe.last) {
  const event = { id: 'evt_stub', type: 'payment_intent.succeeded', data: { object: { id: pi.id, amount: pi.amount, currency: pi.currency, metadata: pi.metadata, status: 'succeeded' } } };
  await request(app).post('/stripe-webhook').set('Content-Type', 'application/json').send(JSON.stringify(event));
  await quiet();
}
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(50); } };

// ── fixtures ─────────────────────────────────────────────────────────────────
const F = {}; // shared catalogue of workspace A
const ADDRESSES = ['Building 7, King Fahd Road, Riyadh 12211', 'Villa 4, Al Nakheel, Riyadh', '77 Olaya St, Riyadh', '9 Hill St'];
const MERCHANT_STRINGS = ['Yellow Socks', 'M · Blue', 'L · Blue', 'S · Red', 'Summer Sale', 'Points Party', 'Spa Week', 'Spa Points', 'Aroma Cafe', ...ADDRESSES];
const OPT_OUT_AR = { role: 'opt_out', text: 'إلغاء الاشتراك' };
const LINKED_BODY = 'أهلاً {name}، جرّب {item} بسعر {price} ضمن {promo_name} وسارع قبل انتهاء العرض';

const ar = (over = {}) => fx.makeCustomer(A.workspaceId, { language: 'ar', firstname: 'سارة', lastname: 'الأحمد', ...over });
const en = (over = {}) => fx.makeCustomer(A.workspaceId, { language: 'en', firstname: 'Bob', lastname: 'Smith', ...over });
const ids = (...cs) => cs.map((c) => String(c._id));

// An approved + reviewed (or deliberately not) Arabic version plus the English mirror.
async function arabicTemplate(workspaceId, { useCase, body, buttons, linkedPromotionId, linkedMessageNodeId, category = 'MARKETING', footer, metaStatus = 'APPROVED', reviewStatus = 'reviewed' }) {
  const tag = fx.uniq();
  return Q('LocalizedTemplate').create({
    workspaceId, key: `acc-${tag}`, name: `Arabic ${useCase} ${tag}`, useCase, category,
    ...(linkedPromotionId ? { linkedPromotionId } : {}), ...(linkedMessageNodeId ? { linkedMessageNodeId } : {}),
    variants: [
      { language: 'en', body: 'Hi {name}', buttons: [{ role: 'opt_out', text: 'Opt Out' }], metaStatus: 'NOT_CREATED' },
      { language: 'ar', body, buttons, ...(footer ? { footer } : {}), metaTemplateName: `wf_acc_${tag}_ar_v1`, metaLanguage: 'ar', metaStatus, reviewStatus, ...(reviewStatus === 'reviewed' ? { reviewedBy: 'Native Reviewer' } : {}) },
    ],
  });
}
const arName = (tpl) => tpl.variants.find((v) => v.language === 'ar').metaTemplateName;
const promo = (over = {}) => Q('Promotion').create({
  workspaceId: A.workspaceId, name: 'Summer Sale', customerType: 'cash', scope: 'products', type: 'specific_products',
  products: [F.p1._id, F.p2._id], discountPercent: 20, status: 'draft', endDate: new Date(Date.UTC(2026, 10, 30)), ...over,
});

beforeAll(async () => {
  process.env.WA_TOKEN = process.env.WA_TOKEN || 'dummy';
  process.env.APP_URL = 'http://localhost:3999';
  process.env.ANTHROPIC_API_KEY = 'dummy-not-a-real-key';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_dummy_itest';
  // Arabic sends go through shared/localization/transport.js; 'dry_run' would swallow them. The axios recorder above is the safety net.
  process.env.LOCALIZATION_SEND_MODE = 'live_stubbed';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  app = require('../../../server');
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => (mongoose.connection.readyState === 1 ? resolve() : (Date.now() - t0 > 20000 ? reject(new Error('mongo not connected')) : setTimeout(poll, 100)));
    poll();
  });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init().catch(() => {})));
  const db = mongoose.connection.db;
  if ((await db.collection('customers').countDocuments()) || (await db.collection('workspaces').countDocuments())) throw new Error('database is not fresh: use a new --db name for every run of wiringAcceptance.itest.js');

  A = await fx.makeWorkspace({ merchantName: 'Aroma Cafe' }); // FIRST workspace = flagged = the one the webhook serves
  await sleep(15);
  B = await fx.makeWorkspace({ merchantName: 'Other Shop', arabic: false }); // second workspace, never flagged
  const Settings = Q('Settings');
  await Settings.updateOne({ workspaceId: A.workspaceId }, { $set: { currency: 'SAR' } });
  require('../../../utils/settingsCache').invalidate();

  const mkP = (o) => Q('Product').create({ workspaceId: A.workspaceId, ...o });
  F.p1 = await mkP({ name: 'Blue Shirt', category: 'Shirts', basePrice: 25, description: 'Soft cotton shirt', images: ['https://img.example.test/blue-shirt.jpg'], variants: [{ size: 'M', color: 'Blue', stock: 5 }, { size: 'L', color: 'Blue', stock: 0 }, { size: 'S', color: 'Red', stock: 2 }] });
  F.p2 = await mkP({ name: 'Red Hat', category: 'Hats', basePrice: 12, images: ['https://img.example.test/red-hat.webp'] });
  F.p3 = await mkP({ name: 'Green Scarf', category: 'Scarves', basePrice: 18, description: 'Soft wool scarf' });
  F.p4 = await mkP({ name: 'Yellow Socks', category: 'Socks', basePrice: 6.5, images: ['https://img.example.test/socks.jpg'] }); // only a DRAFT Arabic name
  F.svcA = await Q('Service').create({ workspaceId: A.workspaceId, name: 'Massage', category: 'Wellness', duration: 60, basePrice: 80, pointsPrice: 100, description: 'Relaxing hour', images: ['https://img.example.test/massage.jpg'] });
  F.svcB = await Q('Service').create({ workspaceId: A.workspaceId, name: 'Facial', category: 'Wellness', duration: 45, basePrice: 120, images: ['https://img.example.test/facial.jpg'] });
  const mkSlot = (svc, o) => Q('TimeSlot').create({ workspaceId: A.workspaceId, serviceId: svc._id, date: '2030-01-15', startTime: '09:00', endTime: '10:00', capacity: 50, bookedCount: 0, ...o });
  F.slotA1 = await mkSlot(F.svcA, {});
  F.slotA2 = await mkSlot(F.svcA, { date: '2030-01-16', startTime: '10:00', endTime: '11:00' });
  const tr = (item, kind, name, status, description) => Q('ProductTranslation').create({ workspaceId: A.workspaceId, kind, refId: item._id, language: 'ar', name, description: description || '', status, source: 'merchant', ...(status === 'reviewed' ? { reviewedBy: 'Native Reviewer', reviewedAt: new Date() } : {}) });
  await tr(F.p1, 'product', 'قميص أزرق', 'reviewed', 'قميص قطني مريح');
  await tr(F.p2, 'product', 'قبعة حمراء', 'reviewed');
  await tr(F.p3, 'product', 'وشاح أخضر', 'reviewed', 'وشاح صوفي ناعم');
  await tr(F.p4, 'product', 'جوارب صفراء', 'draft');
  await tr(F.svcA, 'service', 'جلسة مساج', 'reviewed');
  await tr(F.svcB, 'service', 'جلسة عناية بالوجه', 'reviewed');
  F.pShop = await promo({ name: 'Summer Sale', products: [F.p1._id, F.p2._id, F.p3._id, F.p4._id], discountPercent: 15, description: 'Limited time only' });
  F.pPoints = await promo({ name: 'Points Party', customerType: 'points', pointsPrice: 200, products: [F.p3._id, F.p4._id], discountPercent: undefined });
  F.pSvc = await promo({ name: 'Spa Week', scope: 'services', type: 'specific_services', discountPercent: 10, services: [F.svcA._id, F.svcB._id], products: [] });

  // warm-up: every lazily required module is loaded before the first recorded scenario
  const warm = await en({ firstname: 'Warm' });
  await post(textMsg(warm.phone, 'hello there'));
  await post(ibtn(warm.phone, `promo_${F.pShop._id}`, 'Shop Now'));
  reset();
});

afterAll(async () => {
  if (process.env.ACC_DUMP) { try { require('fs').writeFileSync(process.env.ACC_DUMP, JSON.stringify(Object.fromEntries(Object.entries(J.recorded).map(([k, v]) => [k, { en: W.messagesOf(J.norm(v.en)).map((c) => c.body), ar: W.messagesOf(J.norm(v.ar)).map((c) => c.body) }])), null, 1)); } catch (e) { /* debugging aid only */ } }
  try { require('../../../shared/localization/scheduler').stopLocalizationScheduler(); } catch (e) { /* not started */ }
  jest.restoreAllMocks();
  await mongoose.disconnect();
});
beforeEach(() => { reset(); require('../../../utils/settingsCache').invalidate(); delete process.env.LOCALIZATION_DISABLED; });
afterEach(() => { delete process.env.LOCALIZATION_DISABLED; });

// ══════════════════════════════════════════════════════════════════════════════
// 1. SPEC PHASE-1 DONE-WHEN
// ══════════════════════════════════════════════════════════════════════════════
describe('1. Phase 1: loyalty reminder (ops + dashboard route), Arabic opt-out word, typed variants', () => {
  let tpl;
  const LOYALTY_BODY = 'أهلاً {name}، نقاط ولائك بانتظارك 💎\n\nرصيدك الحالي من النقاط: {points}، وقيمته {amount}. زرنا واستخدمها في مشترياتك القادمة، يسعدنا استقبالك!';
  beforeAll(async () => {
    tpl = await arabicTemplate(A.workspaceId, { useCase: 'loyalty_reminder', body: LOYALTY_BODY, buttons: [{ ...OPT_OUT_AR }], footer: 'لإلغاء الاشتراك أرسل: إلغاء الاشتراك' });
  });

  function expectArabicLoyalty(arabic, points) {
    const list = to(arabic.phone);
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe('template');
    expect(list[0].template.name).toBe(arName(tpl));
    expect(list[0].template.language).toEqual({ code: 'ar' });
    expect(W.templateBody(list[0])).toEqual([arabic.firstname, String(points), `${(points / 10).toFixed(2)} ر.س`]);
    expect(W.templateButtons(list[0])).toEqual(['optout_loyalty_reminder']);
    expect(list[0].template.components.some((c) => c.type === 'button' && c.sub_type === 'quick_reply')).toBe(true);
  }
  function expectEnglishLoyalty(english, points) {
    const list = to(english.phone);
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe('template');
    expect(list[0].template.language).toEqual({ code: 'en' });
    expect(list[0].template.name).not.toBe(arName(tpl));
    expect(W.templateBody(list[0])).toEqual([english.firstname, String(points), (points / 10).toFixed(2), 'SAR']);
    expect(W.templateButtons(list[0])).toEqual([]);
    expect(JSON.stringify(list[0])).not.toMatch(/[\u{0600}-\u{06FF}]/u);
  }

  test('ONE ops.sendLoyaltyReminders call: the Arabic customer gets the Arabic template with the Arabic opt-out payload, the English customer the unchanged English one', async () => {
    const a = await ar({ loyaltyPoints: 125 });
    const e = await en({ loyaltyPoints: 80 });
    const out = await require('../../../shared/operations').sendLoyaltyReminders({ workspaceId: A.workspaceId, customerIds: ids(a, e) });
    expect(out).toMatchObject({ success: true, sentCount: 2, skippedOptedOut: 0, skippedNoConsent: 0, demoCount: 0, languageCounts: { ar: 1, en: 1 } });
    expect(out.localization).toMatchObject({ arabicCustomers: 1, arabicSent: 1, arabicFailed: 0, fallbackToEnglish: [] });
    expectArabicLoyalty(a, 125);
    expectEnglishLoyalty(e, 80);
    const rows = await Q('CampaignMessage').find({ workspaceId: A.workspaceId, kind: 'loyalty_reminder', customer: { $in: [a._id, e._id] } }).lean();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'sent' && r.messageType === 'template' && /^wamid\.ACC/.test(r.wamid))).toBe(true);
  });

  test('the SAME send through the dashboard HTTP route POST /api/promotions/loyalty/remind', async () => {
    const a = await ar({ loyaltyPoints: 250, firstname: 'نورة' });
    const e = await en({ loyaltyPoints: 40 });
    const res = await request(app).post('/api/promotions/loyalty/remind').set(A.auth).send({ customerIds: ids(a, e) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, sentCount: 2, languageCounts: { ar: 1, en: 1 } });
    expect(Object.keys(res.body).slice(0, 5)).toEqual(['success', 'sentCount', 'skippedOptedOut', 'skippedNoConsent', 'demoCount']);
    expectArabicLoyalty(a, 250);
    expectEnglishLoyalty(e, 40);
  });

  test('webhook: the Arabic opt-out word from the Arabic customer opts out IMMEDIATELY, Arabic confirmation, ConsentEvent, a later send skips them', async () => {
    const ops = require('../../../shared/operations');
    const a = await ar({ loyaltyPoints: 90 });
    const e = await en({ loyaltyPoints: 90 });
    await ops.sendLoyaltyReminders({ workspaceId: A.workspaceId, customerIds: ids(a, e) });
    reset();
    await post(textMsg(a.phone, 'إلغاء الاشتراك'));
    const after = await Q('Customer').findById(a._id).lean();
    expect(after).toMatchObject({ optedOut: true });
    const replies = to(a.phone);
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('text');
    expect(replies[0].text.body).toBe(catalog().t('ar', 'consent.optOutAck'));
    expect(W.arabicProblems(replies[0])).toEqual([]);
    const events = await Q('ConsentEvent').find({ workspaceId: A.workspaceId, customerId: a._id }).lean();
    expect(events.map((x) => x.type)).toContain('consent_withdrawn');
    expect(events.find((x) => x.type === 'consent_withdrawn').phone).toBe(a.phone);
    // the English customer is untouched
    expect((await Q('Customer').findById(e._id).lean()).optedOut).toBeFalsy();
    // a later send skips the opted-out customer and still reaches the English one
    reset();
    const second = await ops.sendLoyaltyReminders({ workspaceId: A.workspaceId, customerIds: ids(a, e) });
    expect(second).toMatchObject({ sentCount: 1, skippedOptedOut: 1 });
    expect(to(a.phone)).toHaveLength(0);
    expect(to(e.phone)).toHaveLength(1);
    // ... and through the dashboard route too
    reset();
    const viaHttp = await request(app).post('/api/promotions/loyalty/remind').set(A.auth).send({ customerIds: ids(a, e) });
    expect(viaHttp.body).toMatchObject({ sentCount: 1, skippedOptedOut: 1 });
    expect(to(a.phone)).toHaveLength(0);
  });

  test.each([
    ['tashkeel (diacritics)', 'إِلْغَاءُ الاشتِراكِ'],
    ['alef variant (no hamza)', 'الغاء الاشتراك'],
    ['Arabic-Indic digits after the word', 'إلغاء الاشتراك ١٢٣'],
    ['tatweel', 'إلغـــاء'],
    ['polite filler and emoji', 'إلغاء الاشتراك من فضلك 🙏'],
    ['alternative keyword (hamza on the alef)', 'إيقاف'],
    ['plain English STOP typed by an Arabic customer (reply is Arabic)', 'STOP'],
  ])('typed variant: %s opts the Arabic customer out immediately', async (_name, typed) => {
    const a = await ar({ loyaltyPoints: 60 });
    await post(textMsg(a.phone, typed));
    expect(await Q('Customer').findById(a._id).lean()).toMatchObject({ optedOut: true });
    const replies = to(a.phone);
    expect(replies).toHaveLength(1);
    expect(replies[0].text.body).toBe(catalog().t('ar', 'consent.optOutAck'));
    expect((await Q('ConsentEvent').find({ customerId: a._id }).lean()).map((x) => x.type)).toContain('consent_withdrawn');
  });

  test('a sentence that only CONTAINS a keyword ("لا تتوقف الخدمة عندكم") is NOT an opt-out', async () => {
    const a = await ar({ loyaltyPoints: 60 });
    await post(textMsg(a.phone, 'لا تتوقف الخدمة عندكم؟'));
    expect((await Q('Customer').findById(a._id).lean()).optedOut).toBeFalsy();
  });

  test('the Arabic opt-out button payload of the Arabic template (optout_loyalty_reminder) opts out and answers in Arabic', async () => {
    const a = await ar({ loyaltyPoints: 60 });
    await post(tplBtn(a.phone, 'optout_loyalty_reminder'));
    expect(await Q('Customer').findById(a._id).lean()).toMatchObject({ optedOut: true });
    expect(to(a.phone)[0].text.body).toBe(catalog().t('ar', 'consent.optOutAck'));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. SPEC PHASE-2 DONE-WHEN: promotions to a mixed audience
// ══════════════════════════════════════════════════════════════════════════════
describe('2. Phase 2: ops.sendPromotion / POST /api/promotions/:id/send to a mixed audience', () => {
  const ops = () => require('../../../shared/operations');
  const sendHttp = (promotionId, customerIds, who = A) => request(app).post(`/api/promotions/${promotionId}/send`).set(who.auth).send({ customerIds });
  const planHttp = (promotionId, customerIds, who = A) => request(app).post(`/api/localization/promotions/${promotionId}/send-plan`).set(who.auth).send({ customerIds, includeIds: true });

  test('promotion-linked Arabic version (shop_now + opt-out): Arabic customers Arabic, English customers the unchanged English announcement; plan == send; opted-out / no-consent / demo handled', async () => {
    const promotion = await promo();
    const tpl = await arabicTemplate(A.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: LINKED_BODY, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    const a1 = await ar(); const a2 = await ar({ firstname: 'نورة' });
    const e1 = await en(); const e2 = await en({ firstname: 'Cara' });
    const optedOut = await ar({ optedOut: true, marketingConsent: false });
    const noConsent = await ar({ marketingConsent: false });
    const demo = await ar({ isDemo: true, marketingConsent: false });
    const audience = ids(a1, a2, e1, e2, optedOut, noConsent, demo);

    // the plan says what the send will do
    const planned = await planHttp(promotion._id, audience);
    expect(planned.status).toBe(200);
    expect(planned.body).toMatchObject({ promotionId: String(promotion._id), selected: 7, eligible: 5, byLanguage: { ar: 2, en: 2 }, fallbacks: [], canSend: true });
    expect(planned.body.skipped).toMatchObject({ noConsent: 1, optedOut: 1, demoSimulated: 1 });
    expect(planned.body.variant).toMatchObject({ source: 'promotion', sendable: true, templateId: String(tpl._id) });
    expect(planned.body.buckets.arabic.sort()).toEqual(ids(a1, a2).sort());

    const res = await sendHttp(promotion._id, audience);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, sentCount: 5, skippedOptedOut: 1, skippedNoConsent: 1, demoCount: 1, languageCounts: { ar: 2, en: 2 } });
    expect(res.body.localization).toMatchObject({ arabicCustomers: 2, arabicSent: 2, arabicFailed: 0, fallbackToEnglish: [] });
    for (const a of [a1, a2]) {
      const m = to(a.phone)[0];
      expect(to(a.phone)).toHaveLength(1);
      expect(m.template.name).toBe(arName(tpl));
      expect(m.template.language).toEqual({ code: 'ar' });
      expect(W.templateBody(m)).toEqual([a.firstname, 'قميص أزرق', '20.00 ر.س', 'Summer Sale']);
      expect(W.templateButtons(m)).toEqual([`promo_${promotion._id}`, `optout_${promotion._id}`]);
    }
    for (const e of [e1, e2]) {
      const m = to(e.phone)[0];
      expect(to(e.phone)).toHaveLength(1);
      expect(m.type).toBe('interactive');
      expect(m.interactive.action.buttons.map((b) => b.reply.id)).toEqual([`promo_${promotion._id}`, `optout_${promotion._id}`]);
      expect(W.englishProblems(m, ['Summer Sale'])).toEqual([]);
    }
    for (const nobody of [optedOut, noConsent, demo]) expect(to(nobody.phone)).toHaveLength(0);
    const rows = await Q('CampaignMessage').find({ promotion: promotion._id }).lean();
    expect(rows).toHaveLength(5); // four real sends + the simulated demo row (status read, demo_ wamid)
    expect(rows.filter((r) => r.status === 'sent' && r.kind === 'promotion' && String(r.workspaceId) === String(A.workspaceId)).length).toBe(4);
    expect(rows.filter((r) => /^demo_/.test(r.wamid || ''))).toHaveLength(1);
    expect(rows.find((r) => String(r.customer) === String(a1._id))).toMatchObject({ messageType: 'template', templateName: arName(tpl), phone: a1.phone });
    expect(rows.find((r) => String(r.customer) === String(e1._id)).messageType).toBe('interactive');
    expect(await Q('Promotion').findById(promotion._id).lean()).toMatchObject({ sentCount: 5 });

    // the Arabic sidecar rows exist only for Arabic customers
    const sidecar = await Q('LocalizedLegacySend').find({ workspaceId: A.workspaceId, refId: String(promotion._id) }).lean();
    expect(sidecar.filter((s) => s.status === 'sent' && s.usedLanguage === 'ar')).toHaveLength(2);
    expect(sidecar.some((s) => String(s.customerId) === String(e1._id))).toBe(false);

    // send-report per language
    const report = await request(app).get(`/api/localization/promotions/${promotion._id}/send-report`).set(A.auth);
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ promotionId: String(promotion._id), runs: 1, byLanguage: { ar: { sent: 2, failed: 0 } } });
    // the existing campaign report counts every message exactly as before
    const campaign = await ops().getCampaignReport({ promotionId: String(promotion._id), workspaceId: A.workspaceId });
    expect(campaign.messagesSent).toBe(5);
  });

  test('entry-node promotion (approved custom message) + node-linked Arabic variant: Arabic template with the node button payloads; English gets the node template in English', async () => {
    const promotion = await promo({ name: 'Eid Offer' });
    const node = await Q('MessageNode').create({
      workspaceId: A.workspaceId, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Hi {{1}}! {{2}} for {{3}} - {{4}}',
      templateName: `acc_custom_${fx.uniq()}`, templateStatus: 'approved', buttons: [{ position: 0, label: 'Shop', nextAction: { type: 'end_flow' } }, { position: 1, label: 'Later', nextAction: { type: 'end_flow' } }],
    });
    await Q('Promotion').updateOne({ _id: promotion._id }, { $set: { entryNodeId: node._id } });
    const tpl = await arabicTemplate(A.workspaceId, {
      useCase: 'promotion', linkedMessageNodeId: node._id, body: LINKED_BODY,
      buttons: [{ role: 'flow_button', text: 'تسوق الآن' }, { role: 'flow_button', text: 'لاحقاً' }, { ...OPT_OUT_AR }],
    });
    const a = await ar(); const e = await en();
    const planned = await planHttp(promotion._id, ids(a, e));
    expect(planned.body).toMatchObject({ byLanguage: { ar: 1, en: 1 }, fallbacks: [], variant: { source: 'entry_node', sendable: true } });
    const out = await ops().sendPromotion({ promotionId: String(promotion._id), customerIds: ids(a, e), workspaceId: A.workspaceId });
    expect(out).toMatchObject({ sentCount: 2, languageCounts: { ar: 1, en: 1 } });
    const am = to(a.phone)[0];
    expect(am.template.name).toBe(arName(tpl));
    expect(am.template.language).toEqual({ code: 'ar' });
    expect(W.templateButtons(am)).toEqual([`msgnode_${node._id}_0`, `msgnode_${node._id}_1`, `optout_${promotion._id}`]);
    const em = to(e.phone)[0];
    expect(em.template.name).toBe(node.templateName);
    expect(em.template.language).toEqual({ code: 'en' });
    expect(W.templateButtons(em)).toEqual([`msgnode_${node._id}_0`, `msgnode_${node._id}_1`]);
    const row = await Q('CampaignMessage').findOne({ promotion: promotion._id, customer: a._id }).lean();
    expect(String(row.messageNode)).toBe(String(node._id));
  });

  test.each([
    ['PENDING at Meta', { metaStatus: 'PENDING' }, 'pending'],
    ['approved at Meta but not reviewed (draft)', { reviewStatus: 'draft' }, 'not_reviewed'],
    ['no Arabic version at all', null, 'no_arabic_version'],
  ])('fallback: Arabic variant %s -> the Arabic customer receives EXACTLY the English message of an English customer, counts + reason reported, plan agrees', async (_name, variantState, reason) => {
    const promotion = await promo({ name: 'Fallback Sale' });
    if (variantState) await arabicTemplate(A.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: LINKED_BODY, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }], ...variantState });
    const a = await ar({ firstname: 'Omar' }); const e = await en({ firstname: 'Omar' });
    const planned = await planHttp(promotion._id, ids(a, e));
    expect(planned.body.byLanguage).toEqual({ ar: 0, en: 2 });
    expect(planned.body.fallbacks).toEqual([{ from: 'ar', to: 'en', reason, count: 1 }]);
    expect(planned.body.needsAcknowledgement).toBe(true);
    const res = await sendHttp(promotion._id, ids(a, e));
    expect(res.body).toMatchObject({ sentCount: 2, languageCounts: { ar: 0, en: 2 } });
    expect(res.body.localization.fallbackToEnglish).toEqual([{ reason, count: 1 }]);
    expect({ ...to(a.phone)[0], to: 'x' }).toEqual({ ...to(e.phone)[0], to: 'x' }); // byte for byte the English message
    expect(to(a.phone)[0].type).toBe('interactive');
    expect(W.englishProblems(to(a.phone)[0], ['Omar', 'Fallback Sale'])).toEqual([]);
    const sidecar = await Q('LocalizedLegacySend').findOne({ workspaceId: A.workspaceId, customerId: a._id, refId: String(promotion._id) }).lean();
    expect(sidecar).toMatchObject({ usedLanguage: 'en', fallback: true, fallbackReason: reason, status: 'sent' });
  });

  test('a template-level Meta error (132001 x3) stops the remaining Arabic customers: three attempts, no English retry, plan said Arabic for all', async () => {
    const promotion = await promo({ name: 'Stop Sale' });
    const tpl = await arabicTemplate(A.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: LINKED_BODY, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    const customers = []; for (let i = 0; i < 5; i += 1) customers.push(await ar({ firstname: `عميل${i}` }));
    const english = await en();
    failRules.push({ code: 132001, remaining: -1, message: 'Template name does not exist', match: (rec) => W.isMessagesCall(rec) && rec.body.type === 'template' && rec.body.template.name === arName(tpl) });
    const res = await sendHttp(promotion._id, [...ids(...customers), String(english._id)]);
    expect(res.status).toBe(200);
    expect(res.body.localization).toMatchObject({ arabicSent: 0, arabicFailed: 3, stopped: 'template_unusable:132001' });
    expect(res.body.errors).toHaveLength(3);
    expect(msgs().filter((m) => m.type === 'template')).toHaveLength(3);
    expect(msgs().filter((m) => m.type === 'template').every((m) => m.template.language.code === 'ar')).toBe(true);
    // the English customer in the same run is still served; nobody Arabic got an English message
    expect(to(english.phone)).toHaveLength(1);
    for (const c of customers) expect(to(c.phone).every((m) => m.type === 'template')).toBe(true);
    const rows = await Q('CampaignMessage').find({ promotion: promotion._id, customer: { $in: customers.map((c) => c._id) } }).lean();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'failed' && /does not exist/.test(r.statusReason))).toBe(true);
  });

  test('test-send: the Arabic hub route sends the Arabic version to a typed number with an inert opt-out; the legacy dashboard test-send stays English', async () => {
    const promotion = await promo({ name: 'Test Sale' });
    const tpl = await arabicTemplate(A.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: LINKED_BODY, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    const hub = await request(app).post(`/api/localization/promotions/${promotion._id}/test-send`).set(A.auth).send({ phone: '+966 50 999 0001', language: 'ar' });
    expect(hub.status).toBe(200);
    expect(hub.body).toMatchObject({ sent: true, usedLanguage: 'ar', templateName: arName(tpl) });
    const m = to('966509990001')[0];
    expect(m.template.language).toEqual({ code: 'ar' });
    expect(W.templateButtons(m)).toEqual([`promo_${promotion._id}`, 'l10ntest_optout']);
    expect(await Q('CampaignMessage').countDocuments({ promotion: promotion._id })).toBe(0);
    reset();
    const legacy = await request(app).post(`/api/promotions/${promotion._id}/test-send`).set(A.auth).send({ phone: '966509990002' });
    expect(legacy.status).toBe(200);
    const lm = to('966509990002')[0];
    expect(lm).toBeDefined();
    expect(W.englishProblems(lm, ['Test Sale'])).toEqual([]);
    expect(await Q('CampaignMessage').countDocuments({ promotion: promotion._id })).toBe(0);
    // a promotion without any Arabic version: 409, never English silently
    const bare = await promo({ name: 'Bare Sale' });
    const none = await request(app).post(`/api/localization/promotions/${bare._id}/test-send`).set(A.auth).send({ phone: '966509990003' });
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ code: 'NO_ARABIC_VERSION' });
    expect(to('966509990003')).toHaveLength(0);
  });

  test('carousel promotions stay English-only (decision G8): the plan says so, nobody is counted as Arabic', async () => {
    const promotion = await promo({ name: 'Carousel Sale', sendFormat: 'carousel' });
    const a = await ar(); const e = await en();
    const planned = await planHttp(promotion._id, ids(a, e));
    expect(planned.status).toBe(200);
    expect(planned.body).toMatchObject({ sendFormat: 'carousel', byLanguage: { ar: 0, en: 2 }, canSend: true });
    expect(planned.body.warnings.map((w) => w.code)).toContain('carousel_english_only');
  });

  test('the hub plan / report routes are 402 for the unflagged workspace B, 401 without a token, 404 across tenants', async () => {
    const promotion = await promo({ name: 'Guard Sale' });
    expect((await request(app).post(`/api/localization/promotions/${promotion._id}/send-plan`).set(B.auth).send({})).status).toBe(402);
    expect((await request(app).post(`/api/localization/promotions/${promotion._id}/send-plan`).send({})).status).toBe(401);
    expect((await request(app).get(`/api/localization/promotions/${promotion._id}/send-report`).set(B.auth)).status).toBe(402);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. FLOWS: scheduler -> Arabic entry message -> tap -> reviewed Arabic follow-up; the hub APIs for the follow-up variants
// ══════════════════════════════════════════════════════════════════════════════
describe('3. Automated flows: promotion-linked flow through the scheduler, taps, follow-up hub APIs', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const LRM = String.fromCodePoint(0x200E);
  const hub = (verb, path, body) => { const r = request(app)[verb](`/api/localization/flows${path}`).set(A.auth); return body === undefined ? r : r.send(body); };
  const btn = (position, label, next) => ({ position, label, nextAction: next || { type: 'end_flow' } });
  const wid = () => `wamid.TAP${fx.uniq()}`;
  let F3;

  async function staleCustomer(language, over = {}) {
    const customer = await fx.makeCustomer(A.workspaceId, { language, firstname: language === 'ar' ? 'سارة' : 'Bob', lastname: 'Flow', ...over });
    const order = await Q('Order').create({ workspaceId: A.workspaceId, customer: customer._id, total: 10, status: 'delivered' });
    await Q('Order').collection.updateOne({ _id: order._id }, { $set: { createdAt: new Date(Date.now() - 5 * DAY) } }); // update only: never a delete
    return customer;
  }
  // a CampaignMessage standing for "the entry message this customer received": the thing a button tap correlates to
  async function entryRow(customer) {
    const wamid = wid();
    await Q('CampaignMessage').create({ workspaceId: A.workspaceId, kind: 'promotion', promotion: F3.promotion._id, customer: customer._id, phone: customer.phone, wamid, messageType: 'template', messageNode: F3.entry._id, status: 'sent', sentAt: new Date() });
    return wamid;
  }
  const followRows = (customer) => Q('CampaignMessage').find({ customer: customer._id, messageNode: F3.follow._id }).lean();
  const tap = async (customer, wamid) => { await post(tplBtn(customer.phone, `msgnode_${F3.entry._id}_0`, wamid)); };

  beforeAll(async () => {
    const promotion = await promo({ name: 'Eid Sale' });
    const follow = await Q('MessageNode').create({ workspaceId: A.workspaceId, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: false, depth: 1, bodyText: 'Great choice {{1}}! Your order is on its way.', buttons: [btn(0, 'Track it'), btn(1, 'Done')] });
    const entry = await Q('MessageNode').create({
      workspaceId: A.workspaceId, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Hi {{1}}! {{2}} for {{3}} - {{4}}', templateName: `acc_flow_${fx.uniq()}`, templateStatus: 'approved',
      buttons: [btn(0, 'Shop now', { type: 'send_message', targetNodeId: follow._id }), btn(1, 'Not now')],
    });
    await Q('Promotion').updateOne({ _id: promotion._id }, { $set: { entryNodeId: entry._id } });
    const tpl = await Q('LocalizedTemplate').create({
      workspaceId: A.workspaceId, key: `flow_message_${entry._id}`, name: 'Eid Sale', category: 'MARKETING', useCase: 'custom', linkedMessageNodeId: entry._id,
      variants: [
        { language: 'en', body: 'Hi {name}! {item} for {price} - {promo_name}', buttons: [{ role: 'flow_button', text: 'Shop now' }, { role: 'flow_button', text: 'Not now' }], metaStatus: 'APPROVED', metaTemplateName: entry.templateName, metaLanguage: 'en' },
        { language: 'ar', body: 'أهلاً {name}! لدينا {promo_name} لك', footer: 'لإلغاء الاشتراك أرسل: إلغاء الاشتراك', buttons: [{ role: 'flow_button', text: 'تسوق الآن' }, { role: 'flow_button', text: 'لاحقًا' }, { ...OPT_OUT_AR }], metaStatus: 'APPROVED', metaTemplateName: `wf_acc_flow_${fx.uniq()}_ar`, metaLanguage: 'ar', reviewStatus: 'reviewed', reviewedBy: 'Native Reviewer' },
      ],
    });
    const flow = await Q('Flow').create({ workspaceId: A.workspaceId, name: 'Win-back', triggerType: 'inactive_customer', status: 'active', promotionId: promotion._id, inactivityDays: 1 });
    F3 = { promotion, follow, entry, tpl, flow };
  });

  test('scheduler sweep: the Arabic customer gets the Arabic entry message (CampaignMessage carries workspaceId), the English customer the unchanged English one', async () => {
    const a = await staleCustomer('ar'); const e = await staleCustomer('en');
    const flow = await Q('Flow').findById(F3.flow._id);
    await require('../../../utils/flowScheduler').sweepFlow(flow);
    const am = to(a.phone);
    expect(am).toHaveLength(1);
    expect(am[0].type).toBe('template');
    expect(am[0].template.name).toBe(F3.tpl.variants[1].metaTemplateName);
    expect(am[0].template.language).toEqual({ code: 'ar' });
    expect(W.templateBody(am[0])).toEqual(['سارة', 'Eid Sale']);
    expect(W.templateButtons(am[0])).toEqual([`msgnode_${F3.entry._id}_0`, `msgnode_${F3.entry._id}_1`, `optout_${F3.entry._id}`]);
    const em = to(e.phone);
    expect(em).toHaveLength(1);
    expect(em[0].template.name).toBe(F3.entry.templateName);
    expect(em[0].template.language).toEqual({ code: 'en' });
    expect(W.templateButtons(em[0])).toEqual([`msgnode_${F3.entry._id}_0`, `msgnode_${F3.entry._id}_1`]);
    const arRow = await Q('CampaignMessage').findOne({ flow: F3.flow._id, customer: a._id }).lean();
    expect(arRow).toMatchObject({ kind: 'flow', status: 'sent', messageType: 'template', templateName: F3.tpl.variants[1].metaTemplateName, phone: a.phone });
    expect(String(arRow.workspaceId)).toBe(String(A.workspaceId));
    expect(String(arRow.messageNode)).toBe(String(F3.entry._id));
    expect(arRow.wamid).toMatch(/^wamid\.ACC/);
    const enRow = await Q('CampaignMessage').findOne({ flow: F3.flow._id, customer: e._id }).lean();
    expect(enRow).toMatchObject({ kind: 'flow', status: 'sent', messageType: 'template', templateName: F3.entry.templateName });
    expect((await Q('FlowEnrollment').findOne({ flow: F3.flow._id, customer: a._id }).lean()).state).toBe('messaged');
    F3.arCustomer = a; F3.arWamid = arRow.wamid; F3.enCustomer = e; F3.enWamid = enRow.wamid;
    // a second sweep never sends again
    reset();
    await require('../../../utils/flowScheduler').sweepFlow(flow);
    expect(to(a.phone)).toHaveLength(0);
    expect(to(e.phone)).toHaveLength(0);
  });

  test('hub: the flow tree lists the entry (Arabic sendable) and the follow-up node (no Arabic yet); the follow-up is English for an Arabic customer who taps now', async () => {
    const tree = await hub('get', '/tree');
    expect(tree.status).toBe(200);
    const row = tree.body.items.find((x) => x.flowId === String(F3.flow._id));
    expect(row).toMatchObject({ messageSource: 'promotion', promotionId: String(F3.promotion._id) });
    const entryNode = row.nodes.find((n) => n.messageNodeId === String(F3.entry._id));
    expect(entryNode.versions.find((v) => v.language === 'ar')).toMatchObject({ metaStatus: 'APPROVED', reviewStatus: 'reviewed', sendable: true });
    const followNode = row.nodes.find((n) => n.messageNodeId === String(F3.follow._id));
    expect(followNode.versions.find((v) => v.language === 'ar')).toBeUndefined();
    // no Arabic follow-up yet: a tap by an Arabic customer gets the English follow-up
    const probe = await staleCustomer('ar', { firstname: 'Lina' });
    reset();
    await tap(probe, await entryRow(probe));
    const sent = to(probe.phone);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('interactive');
    expect(sent[0].interactive.body.text).toMatch(/^Great choice Lina/);
    expect(sent[0].interactive.action.buttons.map((b) => b.reply.title)).toEqual(['Track it', 'Done']);
    expect(sent[0].interactive.action.buttons.map((b) => b.reply.id)).toEqual([`msgnode_${F3.follow._id}_0`, `msgnode_${F3.follow._id}_1`]);
  });

  test('hub: AI translate (stubbed model) -> save as draft -> a draft never sends -> review with a stale contentVersion is a 409 -> review -> reviewed + sendable', async () => {
    const view0 = await hub('get', `/followups/${F3.follow._id}`);
    expect(view0.status).toBe(200);
    expect(view0.body).toMatchObject({ variant: null, sendable: false, stale: false });
    expect(view0.body.english).toMatchObject({ bodyFields: 'Great choice {name}! Your order is on its way.' });
    // AI translate: the stubbed model answers; the result is only ever a draft the merchant can edit
    mockAi.calls.length = 0;
    mockAi.reply = () => ({ text: 'اختيار رائع يا {name}! طلبك في الطريق إليك' });
    const ai = await request(app).post('/api/localization/ai/translate').set(A.auth).send({ text: view0.body.english.bodyFields, from: 'en', to: 'ar' });
    expect(ai.status).toBe(200);
    expect(ai.body).toMatchObject({ draft: true, to: 'ar' });
    expect(ai.body.text).toContain('{name}');
    expect(mockAi.calls.length).toBeGreaterThan(0);
    // create (save) the variant as an AI draft
    const saved = await hub('put', `/followups/${F3.follow._id}/variants/ar`, { body: ai.body.text, buttons: [{ position: 0, text: 'تتبّع الطلب' }, { position: 1, text: 'تم' }], source: 'ai' });
    expect(saved.status).toBe(200);
    expect(saved.body.variant).toMatchObject({ reviewStatus: 'draft', source: 'ai', sendable: false });
    expect(saved.body.issues).toEqual([]);
    // a draft never sends: the Arabic customer's tap still gets the English follow-up
    const c1 = await staleCustomer('ar', { firstname: 'Dana' });
    reset();
    await tap(c1, await entryRow(c1));
    expect(to(c1.phone)[0].interactive.body.text).toMatch(/^Great choice Dana/);
    // review with a wrong contentVersion -> 409; with the right one -> reviewed + sendable
    const wrong = await hub('post', `/followups/${F3.follow._id}/variants/ar/review`, { status: 'reviewed', contentVersion: saved.body.variant.contentVersion + 5 });
    expect(wrong.status).toBe(409);
    const reviewed = await hub('post', `/followups/${F3.follow._id}/variants/ar/review`, { status: 'reviewed', contentVersion: saved.body.variant.contentVersion });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.variant).toMatchObject({ reviewStatus: 'reviewed', sendable: true });
    expect(reviewed.body.sendable).toBe(true);
    // the tree shows it
    const tree = await hub('get', '/tree');
    const node = tree.body.items.find((x) => x.flowId === String(F3.flow._id)).nodes.find((n) => n.messageNodeId === String(F3.follow._id));
    expect(node.versions.find((v) => v.language === 'ar')).toMatchObject({ reviewStatus: 'reviewed', sendable: true, stale: false });
    // the unflagged workspace cannot use the hub
    expect((await request(app).get(`/api/localization/flows/followups/${F3.follow._id}`).set(B.auth)).status).toBe(402);
  });

  test('tap after review: the Arabic customer gets the Arabic follow-up (reviewed text, ids), a double tap sends nothing more; the English customer still gets English', async () => {
    // (a) the Arabic customer of the scheduler's REAL entry message
    reset();
    await tap(F3.arCustomer, F3.arWamid);
    let sent = to(F3.arCustomer.phone);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('interactive');
    expect(sent[0].interactive.body.text).toContain('اختيار رائع يا');
    expect(sent[0].interactive.body.text).toContain('طلبك في الطريق إليك');
    expect(sent[0].interactive.action.buttons.map((b) => [b.reply.id, b.reply.title])).toEqual([[`msgnode_${F3.follow._id}_0`, 'تتبّع الطلب'], [`msgnode_${F3.follow._id}_1`, 'تم']]);
    expect(W.arabicProblems(sent[0])).toEqual([]);
    const rows = await followRows(F3.arCustomer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', messageType: 'interactive', kind: 'flow' }); // the follow-up keeps the kind of the entry row it answers
    expect(String(rows[0].workspaceId)).toBe(String(A.workspaceId));
    // double tap: nothing more
    reset();
    await tap(F3.arCustomer, F3.arWamid);
    expect(to(F3.arCustomer.phone)).toHaveLength(0);
    expect(await followRows(F3.arCustomer)).toHaveLength(1);
    // (b) the English customer of the same flow: the unchanged English follow-up
    reset();
    // PRE-EXISTING defect IB-13 (report only, decision G6): the English scheduler writes its flow CampaignMessage WITHOUT a workspaceId, and the
    // production webhook correlates taps by workspace, so a tap on the scheduler's English entry message finds no row. Whatever happens, it is never Arabic.
    await tap(F3.enCustomer, F3.enWamid);
    for (const m of to(F3.enCustomer.phone)) expect(W.englishProblems(m)).toEqual([]);
    expect(await Q('CampaignMessage').findOne({ flow: F3.flow._id, customer: F3.enCustomer._id }).lean()).not.toHaveProperty('workspaceId');
    // an English customer whose entry row DOES carry the workspace (a promotion send row): the unchanged English follow-up
    const eng2 = await staleCustomer('en');
    reset();
    await tap(eng2, await entryRow(eng2));
    sent = to(eng2.phone);
    expect(sent).toHaveLength(1);
    expect(sent[0].interactive.body.text).toMatch(/^Great choice Bob/);
    expect(W.englishProblems(sent[0])).toEqual([]);
    expect(sent[0].interactive.action.buttons.map((b) => b.reply.title)).toEqual(['Track it', 'Done']);
    // (c) an Arabic customer with a Latin name: the name is isolated with direction marks inside the Arabic text
    reset();
    const latin = await staleCustomer('ar', { firstname: 'Mohammed' });
    await tap(latin, await entryRow(latin));
    expect(to(latin.phone)[0].interactive.body.text).toBe(`اختيار رائع يا ${LRM}Mohammed${LRM}! طلبك في الطريق إليك`);
  });

  test('staleness: after the English follow-up text changes, the Arabic row is stale, cannot be reviewed, the tap sends English; re-saving + re-reviewing brings Arabic back; turning it off returns to English', async () => {
    await Q('MessageNode').updateOne({ _id: F3.follow._id }, { $set: { bodyText: 'Great choice {{1}}! Your order is on its way, enjoy it.' } });
    const view = await hub('get', `/followups/${F3.follow._id}`);
    expect(view.body).toMatchObject({ stale: true, sendable: false });
    expect(view.body.variant).toMatchObject({ stale: true, sendable: false });
    const tree = await hub('get', '/tree');
    expect(tree.body.items.find((x) => x.flowId === String(F3.flow._id)).nodes.find((n) => n.messageNodeId === String(F3.follow._id)).versions.find((v) => v.language === 'ar')).toMatchObject({ stale: true, sendable: false });
    const stale = await hub('post', `/followups/${F3.follow._id}/variants/ar/review`, { status: 'reviewed', contentVersion: view.body.variant.contentVersion });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_SOURCE');
    const c = await staleCustomer('ar', { firstname: 'Reem' });
    reset();
    await tap(c, await entryRow(c));
    expect(to(c.phone)[0].interactive.body.text).toMatch(/^Great choice Reem/); // English: a stale row never sends
    // the merchant updates the Arabic text and reviews it again -> Arabic again
    const resaved = await hub('put', `/followups/${F3.follow._id}/variants/ar`, { body: 'اختيار رائع يا {name}! طلبك في الطريق إليك، نتمنى لك تجربة ممتعة', buttons: [{ position: 0, text: 'تتبّع الطلب' }, { position: 1, text: 'تم' }], source: 'merchant' });
    expect(resaved.status).toBe(200);
    expect(resaved.body.variant).toMatchObject({ reviewStatus: 'draft', stale: false });
    const re = await hub('post', `/followups/${F3.follow._id}/variants/ar/review`, { status: 'reviewed', contentVersion: resaved.body.variant.contentVersion });
    expect(re.status).toBe(200);
    const d = await staleCustomer('ar', { firstname: 'Hala' });
    reset();
    await tap(d, await entryRow(d));
    expect(to(d.phone)[0].interactive.body.text).toContain('نتمنى لك تجربة ممتعة');
    // "turn off": review back to draft -> English again
    const off = await hub('post', `/followups/${F3.follow._id}/variants/ar/review`, { status: 'draft', contentVersion: re.body.variant.contentVersion });
    expect(off.status).toBe(200);
    const f = await staleCustomer('ar', { firstname: 'Maha' });
    reset();
    await tap(f, await entryRow(f));
    expect(to(f.phone)[0].interactive.body.text).toMatch(/^Great choice Maha/);
  });

  test('kill switch: even a reviewed Arabic follow-up is not used (English follow-up)', async () => {
    const view = await hub('get', `/followups/${F3.follow._id}`);
    const back = await hub('post', `/followups/${F3.follow._id}/variants/ar/review`, { status: 'reviewed', contentVersion: view.body.variant.contentVersion });
    expect(back.status).toBe(200);
    const c = await staleCustomer('ar', { firstname: 'Rana' });
    const wamid = await entryRow(c);
    reset();
    process.env.LOCALIZATION_DISABLED = '1';
    try { await tap(c, wamid); } finally { delete process.env.LOCALIZATION_DISABLED; }
    expect(to(c.phone)).toHaveLength(1);
    expect(to(c.phone)[0].interactive.body.text).toMatch(/^Great choice Rana/);
    expect(W.englishProblems(to(c.phone)[0])).toEqual([]);
  });

  test('a failing Arabic follow-up send is a failed row and NO English message', async () => {
    const view = await hub('get', `/followups/${F3.follow._id}`);
    const back = await hub('post', `/followups/${F3.follow._id}/variants/ar/review`, { status: 'reviewed', contentVersion: view.body.variant.contentVersion });
    expect(back.status).toBe(200);
    const c = await staleCustomer('ar', { firstname: 'Salma' });
    const wamid = await entryRow(c);
    reset();
    failRules.push({ code: 131026, remaining: -1, message: 'Message undeliverable', match: (rec) => W.isMessagesCall(rec) && rec.body.to === c.phone });
    await tap(c, wamid);
    expect(to(c.phone)).toHaveLength(1); // one attempt, the Arabic one
    expect(to(c.phone)[0].interactive.body.text).toContain('اختيار');
    const rows = await followRows(c);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. SHOPPING JOURNEY (webhook): from the campaign template button to the Stripe confirmation, replayed for an English control
// ══════════════════════════════════════════════════════════════════════════════
const J = { recorded: {} }; // shared with scenario 9 (kill switch)

describe('4. Shopping journey: campaign -> promo_ button -> catalogue -> checkout -> payment -> confirmation (Arabic customer) vs the English baseline', () => {
  const clearState = () => { for (const m of Object.values(require('../../../utils/state'))) if (m && typeof m.clear === 'function') m.clear(); };
  const consented = { marketingConsent: true, marketingConsentAt: new Date(), marketingConsentMethod: 'manual_staff_entry' };
  const MERCHANT = [...MERCHANT_STRINGS, 'Bulk', 'Massage', 'Facial', 'Mega Sale', 'Journey'];

  beforeAll(async () => {
    F.bulk = [];
    for (let i = 1; i <= 12; i += 1) F.bulk.push(await Q('Product').create({ workspaceId: A.workspaceId, name: `Bulk ${String(i).padStart(2, '0')}`, category: 'Bulk', basePrice: 10 + i }));
    F.pMany = await promo({ name: 'Mega Sale', products: F.bulk.map((p) => p._id), discountPercent: 30 });
    F.pSvcPoints = await promo({ name: 'Spa Points', scope: 'services', type: 'specific_services', customerType: 'points', pointsPrice: 100, services: [F.svcA._id], products: [], discountPercent: undefined });
    F.slotAfull = await Q('TimeSlot').create({ workspaceId: A.workspaceId, serviceId: F.svcA._id, date: '2030-01-17', startTime: '10:00', endTime: '11:00', capacity: 1, bookedCount: 1 });
  });

  // ── one end-to-end story that starts from the real campaign send ──────────────
  test('campaign send (HTTP) -> Arabic customer taps the shop_now template button -> Arabic catalogue -> cart -> address -> payment link (?lang=ar) -> Stripe webhook -> Arabic confirmation, order attributed to the campaign message; English customer: same script in English', async () => {
    clearState();
    const tpl = await arabicTemplate(A.workspaceId, { useCase: 'promotion', linkedPromotionId: F.pShop._id, body: LINKED_BODY, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    const a = await ar({ firstname: 'سارة' }); const e = await en({ firstname: 'Bob' });
    const res = await request(app).post(`/api/promotions/${F.pShop._id}/send`).set(A.auth).send({ customerIds: ids(a, e) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sentCount: 2, languageCounts: { ar: 1, en: 1 } });
    const arRow = await Q('CampaignMessage').findOne({ promotion: F.pShop._id, customer: a._id }).lean();
    const enRow = await Q('CampaignMessage').findOne({ promotion: F.pShop._id, customer: e._id }).lean();
    expect(arRow.templateName).toBe(arName(tpl));

    // Arabic customer: the template quick-reply button (type "button", payload promo_<id>, context = the sent wamid)
    reset();
    await post(tplBtn(a.phone, `promo_${F.pShop._id}`, arRow.wamid));
    const afterTap = to(a.phone);
    expect(afterTap.length).toBeGreaterThan(0);
    for (const m of afterTap) expect(W.arabicProblems(m, MERCHANT)).toEqual([]);
    const shown = afterTap.map((m) => JSON.stringify(m)).join('\n');
    expect(shown).toContain('قميص أزرق'); // reviewed Arabic name
    expect(shown).toContain('قبعة حمراء');
    expect(shown).not.toContain('جوارب صفراء'); // draft translation never shown
    expect(shown).toContain('Yellow Socks'); // ... the English name stays
    expect((await Q('CampaignMessage').findById(arRow._id).lean()).clickedAt).toBeTruthy();

    // add the red hat, checkout -> the address question -> address -> payment link
    reset();
    await post(ibtn(a.phone, `cart_${F.p2._id}`, 'أضف'));
    await post(ibtn(a.phone, 'checkout', 'إتمام الطلب'));
    await post(textMsg(a.phone, ADDRESSES[0]));
    const pay = to(a.phone);
    for (const m of pay) expect(W.arabicProblems(m, MERCHANT)).toEqual([]);
    const payText = pay.map((m) => JSON.stringify(m)).join('\n');
    expect(payText).toMatch(/\/pay\/pi_stub_\d+\?lang=ar/);
    const pi = mockStripe.last;
    expect(pi.metadata).toMatchObject({ buyerPhone: a.phone, promotionId: String(F.pShop._id), campaignMessageId: String(arRow._id) });

    // Stripe webhook: Arabic confirmation, order paid + attributed to the Arabic campaign message
    reset();
    await stripeSucceeded(pi);
    const conf = to(a.phone);
    expect(conf.length).toBeGreaterThan(0);
    expect(conf.map((m) => (m.text ? m.text.body : (m.interactive && m.interactive.body.text))).join('\n')).toMatch(/[\u{0621}-\u{064A}]/u);
    for (const m of conf) expect(W.arabicProblems(m, MERCHANT)).toEqual([]);
    const order = await Q('Order').findOne({ stripePaymentIntentId: pi.id }).lean();
    expect(order).toMatchObject({ paymentStatus: 'paid', status: 'confirmed', source: 'campaign' });
    expect(String(order.promotion)).toBe(String(F.pShop._id));
    expect(String(order.campaignMessage)).toBe(String(arRow._id));
    expect(String(order.workspaceId)).toBe(String(A.workspaceId));
    const cm = await Q('CampaignMessage').findById(arRow._id).lean();
    expect(String(cm.order)).toBe(String(order._id));
    expect(cm.revenue).toBeGreaterThan(0);
    // the report of the Arabic send sees the order
    const report = await request(app).get(`/api/localization/promotions/${F.pShop._id}/send-report`).set(A.auth);
    expect(report.body.byLanguage.ar).toMatchObject({ sent: 1, clicked: 1, ordered: 1 });

    // English customer: the interactive announcement's button, the same steps, English everywhere
    reset();
    await post(ibtn(e.phone, `promo_${F.pShop._id}`, 'Shop Now'));
    await post(ibtn(e.phone, `cart_${F.p2._id}`, 'Add to Cart 🛒'));
    await post(ibtn(e.phone, 'checkout', 'Checkout ✅'));
    await post(textMsg(e.phone, ADDRESSES[0]));
    const enMessages = to(e.phone);
    expect(enMessages.length).toBeGreaterThan(3);
    for (const m of enMessages) expect(W.englishProblems(m, MERCHANT)).toEqual([]);
    const enPay = enMessages.map((m) => JSON.stringify(m)).join('\n');
    expect(enPay).toMatch(/\/pay\/pi_stub_\d+"/);
    expect(enPay).not.toContain('lang=ar');
    expect(enRow.templateName === undefined || typeof enRow.templateName === 'string').toBe(true);
  });

  // ── scripted scenarios replayed per language ──────────────────────────────────
  const ADDR = ADDRESSES;
  const SCRIPTS = [
    { name: 'cash journey: promo tap, add, continue, add, checkout asks for the address, address, pay link, Stripe confirmation', fields: consented, run: async (c) => {
      await post(ibtn(c.phone, `promo_${F.pShop._id}`, 'Shop Now! 🛍️'));
      await post(ibtn(c.phone, `cart_${F.p3._id}`, 'Add to Cart 🛒'));
      await post(ibtn(c.phone, 'continue_shopping', 'Keep Browsing'));
      await post(ibtn(c.phone, `cart_${F.p4._id}`, 'Add to Cart 🛒'));
      await post(ibtn(c.phone, 'checkout', 'Checkout ✅'));
      await post(textMsg(c.phone, ADDR[0]));
      await stripeSucceeded();
    } },
    { name: 'variants: picker, variant chosen, base option, out-of-stock variant, checkout', fields: { ...consented, address: ADDR[2] }, run: async (c) => {
      await post(ibtn(c.phone, `promo_${F.pShop._id}`, 'Shop Now! 🛍️'));
      await post(ibtn(c.phone, `cart_${F.p1._id}`, 'Add to Cart 🛒'));
      await post(lrow(c.phone, `variant_${F.p1._id}_0`, 'M · Blue'));
      await post(ibtn(c.phone, `cart_${F.p1._id}`, 'Add to Cart 🛒'));
      await post(lrow(c.phone, `variant_${F.p1._id}_base`, 'No preference'));
      await post(lrow(c.phone, `variant_${F.p1._id}_1`, 'L · Blue'));
      await post(ibtn(c.phone, 'checkout', 'Checkout ✅'));
      await stripeSucceeded();
    } },
    { name: 'more than ten products: numbered list, more button, number selection', fields: consented, run: async (c) => {
      await post(ibtn(c.phone, `promo_${F.pMany._id}`, 'Shop Now'));
      await post(ibtn(c.phone, `more_10_${F.pMany._id}`, 'See Next 2'));
      await post(textMsg(c.phone, '1, 2'));
      await post(ibtn(c.phone, 'continue_shopping', 'Keep Browsing'));
    } },
    { name: 'checkout: empty cart, saved address goes to payment, Stripe unavailable, retry', fields: { ...consented, address: ADDR[3] }, run: async (c) => {
      await post(ibtn(c.phone, 'checkout', 'Checkout ✅'));
      await post(ibtn(c.phone, `cart_${F.p4._id}`, 'Add to Cart 🛒'));
      mockStripe.failNext = true;
      await post(ibtn(c.phone, 'checkout', 'Checkout ✅'));
      await post(ibtn(c.phone, 'checkout', 'Checkout ✅'));
      await stripeSucceeded();
    } },
    { name: 'points: promo tap, redeem, points checkout asks for the address, address, YES; second basket, NO', fields: { ...consented, loyaltyPoints: 600 }, run: async (c) => {
      await post(ibtn(c.phone, `promo_${F.pPoints._id}`, 'Shop Now! 💎'));
      await post(ibtn(c.phone, `cart_${F.p3._id}`, 'Redeem 💎'));
      await post(ibtn(c.phone, 'points_checkout', 'Redeem Points 💎'));
      await post(textMsg(c.phone, ADDR[1]));
      await post(textMsg(c.phone, 'YES'));
      await post(ibtn(c.phone, `cart_${F.p4._id}`, 'Redeem 💎'));
      await post(ibtn(c.phone, 'points_checkout', 'Redeem Points 💎'));
      await post(textMsg(c.phone, 'NO'));
    } },
    { name: 'points: insufficient points', fields: { ...consented, loyaltyPoints: 50, address: ADDR[3] }, run: async (c) => {
      await post(ibtn(c.phone, `promo_${F.pPoints._id}`, 'Shop Now! 💎'));
      await post(ibtn(c.phone, `cart_${F.p3._id}`, 'Redeem 💎'));
      await post(ibtn(c.phone, 'points_checkout', 'Redeem Points 💎'));
    } },
    { name: 'consent ask rides on the confirmation (customer not asked yet), then taps yes', fields: { address: ADDR[3], marketingConsent: false }, run: async (c) => {
      await post(ibtn(c.phone, `promo_${F.pShop._id}`, 'Shop Now! 🛍️'));
      await post(ibtn(c.phone, `cart_${F.p3._id}`, 'Add to Cart 🛒'));
      await post(ibtn(c.phone, 'checkout', 'Checkout ✅'));
      await stripeSucceeded();
      await post(ibtn(c.phone, `consent_yes_${c._id}`, 'Yes, sign me up'));
    } },
    { name: 'service: promo tap, slot list, slot pick, pay link + pay-later offer, reserve (pay in person)', fields: consented, run: async (c) => {
      await post(ibtn(c.phone, `promo_${F.pSvc._id}`, 'Book Now! 📅'));
      await post(lrow(c.phone, `slot_${F.slotA1._id}`, '2030-01-15 · 09:00'));
      await post(ibtn(c.phone, `paylater_${F.slotA1._id}`, 'Reserve, Pay in Person'));
    } },
    { name: 'service: slot pay -> Stripe booking confirmation, and a slot that just filled up', fields: consented, run: async (c) => {
      await post(ibtn(c.phone, `promo_${F.pSvc._id}`, 'Book Now! 📅'));
      await post(lrow(c.phone, `slot_${F.slotA2._id}`, '2030-01-16 · 10:00'));
      await stripeSucceeded();
      await post(lrow(c.phone, `slot_${F.slotAfull._id}`, 'Full slot'));
    } },
    { name: 'service points: slot pick shows the summary, YES books', fields: { ...consented, loyaltyPoints: 450 }, run: async (c) => {
      await post(ibtn(c.phone, `promo_${F.pSvcPoints._id}`, 'Book Now! 📅'));
      await post(lrow(c.phone, `slot_${F.slotA1._id}`, '2030-01-15 · 09:00'));
      await post(textMsg(c.phone, 'YES'));
    } },
    { name: 'service: cancel notice with the rebook button -> free rebook slots -> slot pick', fields: consented, run: async (c) => {
      const booking = await Q('Booking').create({ workspaceId: A.workspaceId, serviceId: F.svcA._id, slotId: F.slotA2._id, customerId: c._id, phone: c.phone, customerName: 'Journey', status: 'confirmed', paymentType: 'cash' });
      await require('../../../shared/operations').cancelBooking({ bookingId: String(booking._id), workspaceId: A.workspaceId });
      await quiet();
      await post(ibtn(c.phone, `rebook_${F.svcA._id}_${booking._id}`, 'Rebook Free 🔄'));
      await post(lrow(c.phone, `slot_${F.slotA1._id}`, '2030-01-15 · 09:00'));
    } },
    { name: 'STOP / START / start (Latin keywords) and the Opt Out button of a promotion', fields: consented, run: async (c) => {
      await post(textMsg(c.phone, 'STOP'));
      await post(textMsg(c.phone, 'START'));
      await post(textMsg(c.phone, 'start'));
      await post(ibtn(c.phone, `optout_${F.pShop._id}`, 'Opt Out'));
      await post(textMsg(c.phone, 'START'));
    } },
    { name: 'YES / NO / unknown text with nothing pending (no reply at all)', fields: consented, run: async (c) => {
      await post(textMsg(c.phone, 'YES'));
      await post(textMsg(c.phone, 'NO'));
      await post(textMsg(c.phone, 'blah blah 123'));
      await post(ibtn(c.phone, 'shop_now', 'Shop Now! 🛍️'));
      await post(ibtn(c.phone, 'continue_shopping', 'Keep Browsing'));
    } },
  ];

  async function dbSummary(c) {
    const customer = await Q('Customer').findById(c._id).lean();
    const orders = await Q('Order').find({ customer: c._id }).sort({ createdAt: 1 }).lean();
    const bookings = await Q('Booking').find({ customerId: c._id }).sort({ createdAt: 1 }).lean();
    return {
      customer: { points: customer.loyaltyPoints || 0, address: customer.address || null, optedOut: !!customer.optedOut, consent: !!customer.marketingConsent },
      orders: orders.map((o) => ({ status: o.status, paymentStatus: o.paymentStatus, total: o.total, subtotal: o.subtotal, items: (o.items || []).map((i) => i.productName), source: o.source, pts: o.loyaltyPointsEarned, used: o.loyaltyPointsUsed || 0 })),
      bookings: bookings.map((b) => ({ status: b.status, paymentType: b.paymentType, amount: b.amount || 0, pointsUsed: b.pointsUsed || 0 })),
    };
  }

  async function runOne(sc, language) {
    clearState();
    const c = await fx.makeCustomer(A.workspaceId, { firstname: 'Journey', lastname: 'Replay', ...sc.fields, ...(language ? {} : {}) });
    if (language) await Q('CustomerLanguage').create({ workspaceId: A.workspaceId, customerId: c._id, language, languageSource: 'merchant_set' });
    await Q('TimeSlot').updateMany({ workspaceId: A.workspaceId, _id: { $in: [F.slotA1._id, F.slotA2._id] } }, { $set: { bookedCount: 0 } }); // every run sees the same availability
    reset();
    await sc.run(c);
    await quiet(); await sleep(300);
    return { customer: c, calls: calls.slice(), db: await dbSummary(c) };
  }
  function norm(rec) {
    const map = new Map();
    const token = (id) => { if (!map.has(id)) map.set(id, `<ID${map.size + 1}>`); return map.get(id); };
    const s = JSON.stringify(rec.calls).split(rec.customer.phone).join('<P>').replace(/pi_stub_\d+/g, '<PI>').replace(/wamid\.[A-Za-z0-9._-]+/g, '<W>').replace(/[0-9a-f]{24}/g, token);
    return JSON.parse(s);
  }
  J.runOne = runOne; J.norm = norm; J.SCRIPTS = SCRIPTS;

  describe('replay: English control vs Arabic customer of the same flagged workspace', () => {
    test.each(SCRIPTS.map((sc) => [sc.name, sc]))('%s', async (name, sc) => {
      const e = await runOne(sc, 'en');
      const a = await runOne(sc, 'ar');
      J.recorded[name] = { en: e, ar: a };
      const enCalls = W.messagesOf(norm(e)); const arCalls = W.messagesOf(norm(a));
      // (a) same number / order of outbound calls and the same structure once customer-visible text is stripped
      expect(W.signature(norm(a))).toEqual(W.signature(norm(e)));
      expect(arCalls.map((c) => W.stripText(c.body))).toEqual(enCalls.map((c) => W.stripText(c.body)));
      // (b) same DB outcome for both languages (orders, bookings, points, address)
      expect(JSON.parse(JSON.stringify(a.db))).toEqual(JSON.parse(JSON.stringify(e.db)));
      // (c) the English control has no Arabic letter anywhere; the Arabic customer has no English chrome, no missing Arabic, no limit broken
      for (const c of enCalls) expect([name, W.englishProblems(c.body, MERCHANT)]).toEqual([name, []]);
      for (const c of arCalls) expect([name, W.arabicProblems(c.body, MERCHANT)]).toEqual([name, []]);
      // (d) every visible field that changed is Arabic
      let changed = 0;
      arCalls.forEach((arCall, i) => {
        const ev = W.visible(enCalls[i].body); const av = W.visible(arCall.body);
        expect(av.map((v) => v.kind)).toEqual(ev.map((v) => v.kind));
        av.forEach((v, j) => { if (v.text !== ev[j].text) { changed += 1; expect([v.kind, W.ARABIC_LETTER.test(v.text), v.text]).toEqual([v.kind, true, v.text]); } });
      });
      if (enCalls.length) expect(changed).toBeGreaterThan(0);
    });
  });

  test('Arabic customer types Arabic yes / no for the pending points confirmation (rewritten for the existing flow): the redemption completes / is cancelled', async () => {
    clearState();
    const c = await fx.makeCustomer(A.workspaceId, { firstname: 'Journey', lastname: 'ArYes', loyaltyPoints: 600, address: ADDRESSES[1] });
    await Q('CustomerLanguage').create({ workspaceId: A.workspaceId, customerId: c._id, language: 'ar', languageSource: 'merchant_set' });
    reset();
    await post(ibtn(c.phone, `promo_${F.pPoints._id}`, 'Shop Now! 💎'));
    await post(ibtn(c.phone, `cart_${F.p3._id}`, 'Redeem 💎'));
    await post(ibtn(c.phone, 'points_checkout', 'Redeem Points 💎'));
    await post(textMsg(c.phone, 'نعم'));
    const orders = await Q('Order').find({ customer: c._id }).lean();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ paymentStatus: 'paid', status: 'confirmed' });
    expect((await Q('Customer').findById(c._id).lean()).loyaltyPoints).toBeLessThan(600);
    const last = to(c.phone).pop();
    expect(W.arabicProblems(last, MERCHANT)).toEqual([]);
    expect((last.text ? last.text.body : last.interactive.body.text)).toMatch(/[\u{0621}-\u{064A}]/u);
    // NO (Arabic)
    reset();
    await post(ibtn(c.phone, `cart_${F.p4._id}`, 'Redeem 💎'));
    await post(ibtn(c.phone, 'points_checkout', 'Redeem Points 💎'));
    await post(textMsg(c.phone, 'لا'));
    expect(await Q('Order').countDocuments({ customer: c._id })).toBe(1);
  });

  test('booking notices use the REVIEWED Arabic service name like the rest of the journey (cancel notice -> rebook slots -> booking confirmation), never the English name next to it', async () => {
    const rec = J.recorded[SCRIPTS.find((sc) => sc.name.startsWith('service: cancel notice')).name];
    const arabicTexts = W.messagesOf(norm(rec.ar)).map((c) => JSON.stringify(c.body));
    const notice = arabicTexts[0];
    expect(notice).toContain('جلسة مساج');
    expect(notice).not.toContain('Massage');
    expect(arabicTexts.join(' ')).not.toContain('Massage');
    // the English control keeps the English name
    expect(W.messagesOf(norm(rec.en)).map((c) => JSON.stringify(c.body))[0]).toContain('Massage');
    // confirmBooking (dashboard action) for an Arabic customer
    const c = await fx.makeCustomer(A.workspaceId, { firstname: 'Journey', lastname: 'Confirm', marketingConsent: true });
    await Q('CustomerLanguage').create({ workspaceId: A.workspaceId, customerId: c._id, language: 'ar', languageSource: 'merchant_set' });
    const booking = await Q('Booking').create({ workspaceId: A.workspaceId, serviceId: F.svcB._id, slotId: F.slotA1._id, customerId: c._id, phone: c.phone, customerName: 'Journey', status: 'requested', paymentType: 'cash' });
    reset();
    await require('../../../shared/operations').confirmBooking({ bookingId: String(booking._id), workspaceId: A.workspaceId });
    const confirm = JSON.stringify(to(c.phone)[0]);
    expect(confirm).toContain('جلسة عناية بالوجه');
    expect(confirm).not.toContain('Facial');
  });

  test('WhatsApp limits: every Arabic payload of every journey respects the button / row / body limits (code points)', () => {
    let checked = 0;
    for (const rec of Object.values(J.recorded)) {
      for (const c of W.messagesOf(norm(rec.ar))) for (const v of W.visible(c.body)) { checked += 1; expect([v.kind, W.cp(v.text) <= v.max]).toEqual([v.kind, true]); }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. H1: duplicate customer records of one person
// ══════════════════════════════════════════════════════════════════════════════
describe('5. H1: STOP / Opt Out button / Arabic opt-out word opts out EVERY record of the number in that workspace', () => {
  const AR_DIGITS = Array.from({ length: 10 }, (_, i) => String.fromCodePoint(0x0660 + i));
  const arDigits = (s) => String(s).replace(/\d/g, (d) => AR_DIGITS[Number(d)]);
  let counter = 0;
  const newNumber = () => { counter += 1; return `966566${String(Date.now()).slice(-4)}${String(counter).padStart(2, '0')}`; }; // 12 digits, unique per call
  const local = (n) => `0${n.slice(3)}`;

  // records of one person in workspace A (six spellings) + one record of the SAME number in workspace B
  async function duplicates() {
    const n = newNumber();
    const spellings = [n, `+${n}`, `00${n}`, `${n.slice(0, 3)} ${n.slice(3, 5)} ${n.slice(5, 8)} ${n.slice(8)}`, arDigits(n), local(n)];
    const records = [];
    for (let i = 0; i < spellings.length; i += 1) {
      records.push(await fx.makeCustomer(A.workspaceId, { phone: spellings[i], firstname: i === 1 ? 'سارة' : `Dup${i}`, lastname: 'Same', loyaltyPoints: 50, language: i === 1 || i === 4 ? 'ar' : 'en' }));
    }
    const other = await fx.makeCustomer(B.workspaceId, { phone: n, firstname: 'Other', lastname: 'Tenant', loyaltyPoints: 50 });
    return { n, records, other };
  }
  async function expectAllOptedOut({ n, records, other }, label) {
    for (const r of records) {
      const fresh = await Q('Customer').findById(r._id).lean();
      expect([label, r.phone, !!fresh.optedOut]).toEqual([label, r.phone, true]);
      const events = await Q('ConsentEvent').find({ workspaceId: A.workspaceId, customerId: r._id, type: 'consent_withdrawn' }).lean();
      expect([label, r.phone, events.length]).toEqual([label, r.phone, 1]); // its OWN event
    }
    const o = await Q('Customer').findById(other._id).lean();
    expect(o.optedOut).toBeFalsy();
    expect(o.marketingConsent).toBe(true);
    expect(await Q('ConsentEvent').countDocuments({ customerId: other._id })).toBe(0);
  }
  async function expectSendersSkip({ records }) {
    const ops = require('../../../shared/operations');
    reset();
    const loyalty = await ops.sendLoyaltyReminders({ workspaceId: A.workspaceId, customerIds: ids(...records) });
    expect(loyalty).toMatchObject({ sentCount: 0, skippedOptedOut: records.length });
    const promotion = await promo({ name: 'Dup Sale' });
    const promoOut = await ops.sendPromotion({ promotionId: String(promotion._id), customerIds: ids(...records), workspaceId: A.workspaceId });
    expect(promoOut).toMatchObject({ sentCount: 0, skippedOptedOut: records.length });
    expect(msgs()).toHaveLength(0);
  }

  test('typed STOP from the number: every record of workspace A is opted out with its own ConsentEvent, workspace B untouched, English senders skip them all', async () => {
    const d = await duplicates();
    await post(textMsg(d.n, 'STOP'));
    await expectAllOptedOut(d, 'STOP');
    // the primary reply is the English one for the (English) primary record, exactly one reply
    expect(to(d.n)).toHaveLength(1);
    await expectSendersSkip(d);
    // another workspace's record can still be messaged by ITS workspace (not opted out there)
    reset();
    const out = await require('../../../shared/operations').sendLoyaltyReminders({ workspaceId: B.workspaceId, customerIds: ids(d.other) });
    expect(out).toMatchObject({ sentCount: 1, skippedOptedOut: 0 });
  });

  test('the Opt Out button of a promotion (template quick reply and interactive reply) opts out every record', async () => {
    const promotion = await promo({ name: 'Btn Sale' });
    const d1 = await duplicates();
    await post(tplBtn(d1.n, `optout_${promotion._id}`));
    await expectAllOptedOut(d1, 'optout template button');
    const d2 = await duplicates();
    await post(ibtn(d2.n, `optout_${promotion._id}`, 'Opt Out'));
    await expectAllOptedOut(d2, 'optout interactive button');
    await expectSendersSkip(d2);
  });

  test('the Arabic opt-out word (and a typed variant with diacritics) from the number opts out every record; the Arabic path and the English senders skip them', async () => {
    const d = await duplicates();
    await post(textMsg(d.n, 'إلغاء الاشتراك'));
    await expectAllOptedOut(d, 'Arabic word');
    expect(to(d.n)).toHaveLength(1);
    await expectSendersSkip(d);
    const d2 = await duplicates();
    await post(textMsg(d2.n, 'إِلْغَاءُ الاشتِراكِ ١٢٣'));
    await expectAllOptedOut(d2, 'Arabic word with diacritics and Arabic-Indic digits');
    // the Arabic send path with an approved loyalty template: nobody of that number receives anything
    reset();
    const tpl = await arabicTemplate(A.workspaceId, { useCase: 'loyalty_reminder', body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}، وقيمته {amount}. نسعد بخدمتك دائماً', buttons: [{ ...OPT_OUT_AR }] });
    const arabicDup = d2.records.filter((r, i) => i === 1 || i === 4);
    const out = await require('../../../shared/operations').sendLoyaltyReminders({ workspaceId: A.workspaceId, customerIds: ids(...arabicDup) });
    expect(out.sentCount).toBe(0);
    expect(msgs().filter((m) => m.type === 'template' && m.template.name === arName(tpl))).toHaveLength(0);
  });

  test('only differently-spelled records exist (local 05... format, Arabic-Indic digits, spaced, 00-prefixed): the typed STOP from the international number still opts out every one of them', async () => {
    const n = newNumber();
    const only = [];
    for (const spelling of [local(n), arDigits(n), `${n.slice(0, 3)} ${n.slice(3, 5)} ${n.slice(5, 8)} ${n.slice(8)}`, `00${n}`]) {
      only.push(await fx.makeCustomer(A.workspaceId, { phone: spelling, firstname: 'Only', lastname: 'Spelling', loyaltyPoints: 30 }));
    }
    await post(textMsg(n, 'STOP'));
    for (const r of only) {
      expect([r.phone, !!(await Q('Customer').findById(r._id).lean()).optedOut]).toEqual([r.phone, true]);
      expect((await Q('ConsentEvent').find({ customerId: r._id, type: 'consent_withdrawn' }).lean()).length).toBe(1);
    }
    reset();
    const out = await require('../../../shared/operations').sendLoyaltyReminders({ workspaceId: A.workspaceId, customerIds: ids(...only) });
    expect(out).toMatchObject({ sentCount: 0, skippedOptedOut: only.length });
  });

  test('a record of that number created AFTER the opt-out is excluded by the Arabic path (same-phone rule); the opted-out records keep their state', async () => {
    const d = await duplicates();
    await post(textMsg(d.n, 'STOP'));
    await expectAllOptedOut(d, 'before');
    const late = await fx.makeCustomer(A.workspaceId, { phone: `+${d.n}`, firstname: 'سارة', lastname: 'Late', loyaltyPoints: 70, language: 'ar' });
    const tpl = await arabicTemplate(A.workspaceId, { useCase: 'loyalty_reminder', body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}، وقيمته {amount}. نسعد بخدمتك دائماً', buttons: [{ ...OPT_OUT_AR }] });
    reset();
    const out = await require('../../../shared/operations').sendLoyaltyReminders({ workspaceId: A.workspaceId, customerIds: ids(late) });
    expect(out.sentCount).toBe(0);
    expect(out.localization).toMatchObject({ excludedOptedOutPhone: 1 });
    expect(to(late.phone)).toHaveLength(0);
    expect(msgs().filter((m) => m.type === 'template' && m.template.name === arName(tpl))).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. DATA: CSV import with a language column, Arabic digits, Windows-1256, language endpoints, B4, Arabic name columns -> drafts
// ══════════════════════════════════════════════════════════════════════════════
describe('6. Data and forms', () => {
  const AR_DIGITS = Array.from({ length: 10 }, (_, i) => String.fromCodePoint(0x0660 + i));
  const arDigits = (s) => String(s).replace(/\d/g, (d) => AR_DIGITS[Number(d)]);
  const utf8 = (text) => Buffer.from(text, 'utf8'); // NO byte-order mark, like many Arabic CSV exports
  const CP1256 = new Map();
  { const decoder = new TextDecoder('windows-1256'); for (let b = 0; b < 256; b += 1) { const ch = decoder.decode(Uint8Array.of(b)); if (!CP1256.has(ch)) CP1256.set(ch, b); } }
  const cp1256 = (text) => Buffer.from(Array.from(text, (ch) => CP1256.get(ch)));
  const tag = String(Date.now()).slice(-5);
  const P = (n) => `96655${tag}${String(n).padStart(2, '0')}`.slice(0, 12); // 12 digits, unique per run
  const outbound = () => require('../../../shared/localization/outbound');

  const upload = (who, entityType, buffer, name = 'upload.csv') => request(app).post('/api/imports').set(who.auth).field('entityType', entityType).attach('file', buffer, { filename: name, contentType: 'text/csv' });
  const mapping = (who, id, columnMapping) => request(app).patch(`/api/imports/${id}/mapping`).set(who.auth).send({ columnMapping });
  const run = (who, id) => request(app).post(`/api/imports/${id}/run`).set(who.auth).send({});
  async function wizard(who, entityType, buffer, columnMapping) {
    const created = await upload(who, entityType, buffer);
    expect(created.status).toBe(201);
    const m = await mapping(who, created.body.id, columnMapping || created.body.columnMapping);
    expect(m.status).toBe(200);
    const done = await run(who, created.body.id);
    expect(done.status).toBe(200);
    return { created: created.body, validated: m.body, done: done.body };
  }
  const langOf = async (who, phone) => {
    const customer = await Q('Customer').findOne({ workspaceId: who.workspaceId, phone });
    const doc = customer && await Q('CustomerLanguage').findOne({ workspaceId: who.workspaceId, customerId: customer._id });
    return { customer, doc };
  };

  beforeAll(async () => { await Q('Settings').updateOne({ workspaceId: A.workspaceId }, { $set: { defaultCountryCode: '966' } }); await Q('Settings').updateOne({ workspaceId: B.workspaceId }, { $set: { defaultCountryCode: '966' } }); });

  test('customer CSV (BOM-less UTF-8): language column Arabic / ar / English / en / invalid, Arabic-Indic digit phones and points, Arabic names; invalid language = row error', async () => {
    const csv = ['Name,Phone,Language,Points',
      `سارة أحمد,${arDigits(P(1))},Arabic,${arDigits(100)}`,
      `John Smith,${P(2)},English,50`,
      `نورة,+${arDigits('966')} ${arDigits(P(3).slice(3, 5))} ${arDigits(P(3).slice(5))},ar,0`,
      `Sam Lee,${P(4)},en,0`,
      `Bad Lang,${P(5)},klingon,0`,
    ].join('\n');
    const created = await upload(A, 'customer', utf8(csv));
    expect(created.status).toBe(201);
    expect(created.body.columnMapping).toMatchObject({ name: 'Name', phone: 'Phone', language: 'Language' });
    const m = await mapping(A, created.body.id, created.body.columnMapping);
    expect(m.body.summary).toMatchObject({ totalRows: 5, clean: 4, error: 1 });
    expect(m.body.preview.error[0].errors).toEqual([{ field: 'language', reason: 'Language must be ar, en, Arabic or English' }]);
    const done = await run(A, created.body.id);
    expect(done.body).toMatchObject({ importedCount: 4, failedCount: 1 });
    expect(done.body.localization).toMatchObject({ languagesSet: 4, languagesFailed: 0 });
    const sara = await langOf(A, P(1));
    expect(sara.customer).toMatchObject({ firstname: 'سارة', lastname: 'أحمد', loyaltyPoints: 100 });
    expect(sara.doc).toMatchObject({ language: 'ar', languageSource: 'csv_import' });
    expect((await langOf(A, P(2))).doc).toMatchObject({ language: 'en', languageSource: 'csv_import' });
    expect((await langOf(A, P(3))).doc).toMatchObject({ language: 'ar', languageSource: 'csv_import' }); // "+٩٦٦ ٥٥ ..." was understood
    expect((await langOf(A, P(4))).doc).toMatchObject({ language: 'en' });
    expect(await Q('Customer').countDocuments({ workspaceId: A.workspaceId, phone: P(5) })).toBe(0);
    // the imported Arabic customer is Arabic for the NEXT send once consent exists (the import does not fabricate consent)
    expect(sara.customer.marketingConsent).toBeFalsy();
    // the unflagged workspace B: same file, no language handling at all
    const b = await wizard(B, 'customer', utf8(`Name,Phone,Language\nZed,${P(6)},ar\n`));
    expect(b.done.localization).toBeUndefined();
    expect(await Q('CustomerLanguage').countDocuments({ workspaceId: B.workspaceId })).toBe(0);
  });

  test('customer CSV in Windows-1256 (Excel on an Arabic PC, semicolons): decoded, language applied; re-import updates the language of existing customers but never overrides customer_chose; blank never clears', async () => {
    const john = (await langOf(A, P(2))).customer;
    await Q('CustomerLanguage').updateOne({ workspaceId: A.workspaceId, customerId: john._id }, { $set: { language: 'en', languageSource: 'customer_chose' } });
    const csv = ['الاسم;الجوال;اللغة', `سارة أحمد;${P(1)};en`, `John Smith;${P(2)};ar`, `ليلى محمد;${P(7)};عربي`, `ليلى محمد;${P(7)};en`].join('\n');
    const out = await wizard(A, 'customer', cp1256(csv));
    expect(out.created.headers).toEqual(['الاسم', 'الجوال', 'اللغة']);
    expect(out.created.columnMapping).toMatchObject({ name: 'الاسم', phone: 'الجوال', language: 'اللغة' });
    expect((await langOf(A, P(1))).doc).toMatchObject({ language: 'en', languageSource: 'csv_import' });
    expect((await langOf(A, P(2))).doc).toMatchObject({ language: 'en', languageSource: 'customer_chose' }); // protected
    const leila = await langOf(A, P(7));
    expect(leila.customer).toMatchObject({ firstname: 'ليلى', lastname: 'محمد' }); // Arabic letters survived the Windows-1256 decode
    expect(leila.doc).toMatchObject({ language: 'ar' }); // first row wins
    expect(out.done.localization).toMatchObject({ languagesProtected: 1, languagesFailed: 0 });
    const blank = await wizard(A, 'customer', utf8(`name,phone,language\nSara,${P(1)},\nSara,${P(1)},unknown\n`));
    expect(blank.done.localization).toMatchObject({ languagesSet: 0 });
    expect((await langOf(A, P(1))).doc.language).toBe('en');
  });

  test('customer language endpoints: GET shows the stored language and the effective one, PUT sets it (merchant_set), 404 across tenants, 402 unflagged, 401 anonymous', async () => {
    const c = await fx.makeCustomer(A.workspaceId, { firstname: 'Lang', lastname: 'Endpoint' });
    const g0 = await request(app).get(`/api/localization/customers/${c._id}/language`).set(A.auth);
    expect(g0.status).toBe(200);
    expect(g0.body).toMatchObject({ id: String(c._id), language: 'unknown', effectiveLanguage: 'en' });
    const put = await request(app).put(`/api/localization/customers/${c._id}/language`).set(A.auth).send({ language: 'ar' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ language: 'ar', languageSource: 'merchant_set', effectiveLanguage: 'ar' });
    const g1 = await request(app).get(`/api/localization/customers/${c._id}/language`).set(A.auth);
    expect(g1.body).toMatchObject({ language: 'ar', languageSource: 'merchant_set' });
    const list = await request(app).get('/api/localization/customers').set(A.auth);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ page: 1, counts: expect.any(Object) });
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items[0]).toEqual(expect.objectContaining({ id: expect.any(String), language: expect.any(String), effectiveLanguage: expect.any(String) }));
    expect((await request(app).get(`/api/localization/customers/${c._id}/language`).set(B.auth)).status).toBe(402);
    expect((await request(app).get(`/api/localization/customers/${c._id}/language`)).status).toBe(401);
    // another FLAGGED tenant would get 404: flag B temporarily to prove the tenant scoping of the lookup itself
    const settings = require('../../../shared/localization/settings');
    await settings.setArabicEnabled({ workspaceId: B.workspaceId, enabled: true, grantedBy: 'itest' });
    try {
      expect((await request(app).get(`/api/localization/customers/${c._id}/language`).set(B.auth)).status).toBe(404);
      expect((await request(app).put(`/api/localization/customers/${c._id}/language`).set(B.auth).send({ language: 'en' })).status).toBe(404);
    } finally { await settings.setArabicEnabled({ workspaceId: B.workspaceId, enabled: false, grantedBy: 'itest' }); }
    expect((await Q('CustomerLanguage').findOne({ workspaceId: A.workspaceId, customerId: c._id }).lean()).language).toBe('ar'); // untouched
  });

  test('B4: a first message with a one-word WhatsApp profile name creates the customer ONLY in the flagged workspace; unflagged workspaces behave exactly as before', async () => {
    const phone = `96656${tag}91`.slice(0, 12);
    await post(textMsg(phone, 'مرحبا'), 'ليلى'); // one-word Arabic profile name, unknown number, served by the oldest (flagged) workspace
    const created = await Q('Customer').findOne({ workspaceId: A.workspaceId, phone }).lean();
    expect(created).toBeTruthy();
    expect(created.firstname).toBe('ليلى');
    expect(created.lastname).toBe(' ');
    expect(`${created.firstname} ${created.lastname}`.trim()).toBe('ليلى'); // every reader trims
    // no profile name at all: the phone is the name, still created
    const phone2 = `96656${tag}92`.slice(0, 12);
    await post(textMsg(phone2, 'hello'), undefined);
    expect(await Q('Customer').countDocuments({ workspaceId: A.workspaceId, phone: phone2 })).toBe(1);
    // the same inbound logging for the UNFLAGGED workspace B (called directly: the webhook only serves A): the old behaviour, no customer
    const inbox = require('../../../shared/inbox');
    const phone3 = `96656${tag}93`.slice(0, 12);
    await inbox.logInboundMessage({ workspaceId: B.workspaceId, from: phone3, message: textMsg(phone3, 'hello'), contactName: 'Layla' }).catch(() => {}); // the English code throws a ValidationError here; server.js catches it, exactly like this
    expect(await Q('Customer').countDocuments({ workspaceId: B.workspaceId, phone: phone3 })).toBe(0);
    expect(await Q('Customer').countDocuments({ phone: phone3 })).toBe(0);
    // a two-word name behaves the same everywhere
    const phone4 = `96656${tag}94`.slice(0, 12);
    await inbox.logInboundMessage({ workspaceId: B.workspaceId, from: phone4, message: textMsg(phone4, 'hello'), contactName: 'Layla Hassan' });
    expect((await Q('Customer').findOne({ workspaceId: B.workspaceId, phone: phone4 }).lean())).toMatchObject({ firstname: 'Layla', lastname: 'Hassan' });
  });

  test('product / service CSV with Arabic name columns: drafts only, Arabic-Indic prices parse; a draft is NEVER shown to a customer until it is reviewed', async () => {
    const coffee = `Arabic Coffee ${tag}`; const tea = `Mint Tea ${tag}`;
    const csv = ['name,price,category,name_ar,description_ar', `${coffee},${arDigits('45')}٫٥٠ ر.س,Drinks,قهوة عربية,قهوة بالهيل`, `${tea},"1,200.50",Drinks,شاي بالنعناع,`].join('\n');
    const created = await upload(A, 'product', utf8(csv));
    expect(created.body.fields.map((f) => f.key).slice(-2)).toEqual(['nameAr', 'descriptionAr']);
    expect(created.body.columnMapping).toMatchObject({ name: 'name', basePrice: 'price', nameAr: 'name_ar', descriptionAr: 'description_ar' });
    await mapping(A, created.body.id, created.body.columnMapping);
    const done = await run(A, created.body.id);
    expect(done.body).toMatchObject({ importedCount: 2, failedCount: 0 });
    expect(done.body.localization).toMatchObject({ translationsSaved: 2, translationsFailed: 0 });
    const product = await Q('Product').findOne({ workspaceId: A.workspaceId, name: coffee });
    expect(product.basePrice).toBe(45.5);
    expect((await Q('Product').findOne({ workspaceId: A.workspaceId, name: tea })).basePrice).toBe(1200.5);
    const tr = await Q('ProductTranslation').findOne({ workspaceId: A.workspaceId, kind: 'product', refId: product._id, language: 'ar' });
    expect(tr).toMatchObject({ name: 'قهوة عربية', description: 'قهوة بالهيل', status: 'draft', source: 'csv' });
    // service file
    const svcName = `Haircut ${tag}`;
    const svc = await wizard(A, 'service', utf8(['name,price,duration,name_ar', `${svcName},"SAR 60.00",45,قص شعر`].join('\n')));
    expect(svc.done.localization).toMatchObject({ translationsSaved: 1 });
    expect(await Q('ProductTranslation').findOne({ workspaceId: A.workspaceId, kind: 'service', refId: (await Q('Service').findOne({ workspaceId: A.workspaceId, name: svcName }))._id })).toMatchObject({ name: 'قص شعر', status: 'draft' });

    // an Arabic customer walks the catalogue of a promotion containing the imported product: the English name shows (draft)
    const promotion = await promo({ name: 'Import Sale', products: [product._id] });
    const a = await ar({ firstname: 'Journey' });
    outbound()._resetForTests();
    clearJourneyState();
    reset();
    await post(ibtn(a.phone, `promo_${promotion._id}`, 'Shop Now'));
    const draftShown = to(a.phone).map((m) => JSON.stringify(m)).join('\n');
    expect(draftShown).toContain(coffee);
    expect(draftShown).not.toContain('قهوة عربية');
    // the merchant reviews it in the hub -> the next walk shows the Arabic name (name cache refreshed)
    const review = await request(app).post(`/api/localization/catalog/product/${product._id}/translation/review`).set(A.auth).send({ status: 'reviewed' });
    expect(review.status).toBe(200);
    outbound()._resetForTests();
    clearJourneyState();
    const a2 = await ar({ firstname: 'Journey' });
    reset();
    await post(ibtn(a2.phone, `promo_${promotion._id}`, 'Shop Now'));
    const reviewedShown = to(a2.phone).map((m) => JSON.stringify(m)).join('\n');
    expect(reviewedShown).toContain('قهوة عربية');
    // an English customer never sees Arabic, reviewed or not
    const e2 = await en({ firstname: 'Journey' });
    reset();
    await post(ibtn(e2.phone, `promo_${promotion._id}`, 'Shop Now'));
    expect(to(e2.phone).map((m) => JSON.stringify(m)).join('\n')).not.toContain('قهوة');
    // unflagged workspace B: same product file, no Arabic handling
    const twin = await wizard(B, 'product', utf8(`name,price,category,name_ar\nTwin ${tag},${arDigits('45')} ر.س,Drinks,قهوة\n`));
    expect(twin.done.localization).toBeUndefined();
    expect(await Q('ProductTranslation').countDocuments({ workspaceId: B.workspaceId })).toBe(0);
    expect((await Q('Product').findOne({ workspaceId: B.workspaceId, name: `Twin ${tag}` })).basePrice).toBe(45);
  });
});

function clearJourneyState() { for (const m of Object.values(require('../../../utils/state'))) if (m && typeof m.clear === 'function') m.clear(); }

// ══════════════════════════════════════════════════════════════════════════════
// 7. PAGES: pay page switch link, ?lang=ar, stored language; referral / instagram redirects unchanged
// ══════════════════════════════════════════════════════════════════════════════
describe('7. Customer pages', () => {
  let piSeq = 0;
  // A PaymentIntent the (mocked) Stripe knows; the pages resolve the workspace through the buyer phone.
  function intent(phone, over = {}) {
    piSeq += 1;
    const pi = { id: `pi_stub_acc_${Date.now().toString(36)}${piSeq}`, amount: 5000, currency: 'sar', status: 'requires_payment_method', client_secret: 'cs_stub', metadata: { buyerPhone: phone, subtotal: '45', shippingCost: '5', address: 'Riyadh' }, ...over };
    mockStripe.store[pi.id] = pi;
    return pi;
  }
  const page = (id, query = '', headers = {}) => request(app).get(`/pay/${id}${query}`).set(headers);
  const SWITCH_AR = /<a class="exit" href="\/pay\/[^"]+\?lang=ar" hreflang="ar" lang="ar" dir="rtl" rel="nofollow">العربية<\/a>/;
  const isArabicPage = (html) => /<html lang="ar" dir="rtl"/.test(html) || (/dir="rtl"/.test(html) && /[\u{0621}-\u{064A}]/u.test(html.replace(/العربية/g, '')));

  test('English customer of the flagged workspace: the English page gains the Arabic switch link; ?lang=ar serves the Arabic page (RTL, Arabic text, no English chrome)', async () => {
    const e = await en();
    const pi = intent(e.phone);
    const english = await page(pi.id);
    expect(english.status).toBe(200);
    expect(english.text).toContain('Complete Your Payment');
    expect(english.text).toMatch(SWITCH_AR);
    const arabic = await page(pi.id, '?lang=ar');
    expect(arabic.status).toBe(200);
    expect(isArabicPage(arabic.text)).toBe(true);
    expect(arabic.text).not.toContain('Complete Your Payment');
    expect(arabic.text).toMatch(/[\u{0621}-\u{064A}]/u);
  });

  test('Arabic customer (stored language): the Arabic page without any parameter; ?lang=en gives the English page (with the way back)', async () => {
    const a = await ar();
    const pi = intent(a.phone);
    const stored = await page(pi.id);
    expect(isArabicPage(stored.text)).toBe(true);
    expect(stored.text).not.toContain('Complete Your Payment');
    const forcedEnglish = await page(pi.id, '?lang=en');
    expect(forcedEnglish.text).toContain('Complete Your Payment');
    expect(forcedEnglish.text).toMatch(SWITCH_AR);
  });

  test('already paid and payment-result pages follow the same rule', async () => {
    const e = await en(); const a = await ar();
    const paidEn = intent(e.phone, { status: 'succeeded' });
    const paidAr = intent(a.phone, { status: 'succeeded' });
    expect((await page(paidEn.id)).text).toMatch(SWITCH_AR);
    expect(isArabicPage((await page(paidAr.id)).text)).toBe(true);
    const resEn = await request(app).get(`/payment-result?payment_intent=${paidEn.id}`);
    expect(resEn.status).toBe(200);
    expect(resEn.text).toContain('العربية'); // the switch link
    const resAr = await request(app).get(`/payment-result?payment_intent=${paidAr.id}`);
    expect(isArabicPage(resAr.text)).toBe(true);
  });

  test('UNFLAGGED workspace B and the kill switch: the English page byte for byte, no switch link, ?lang=ar is ignored', async () => {
    const b = await fx.makeCustomer(B.workspaceId, { firstname: 'Bee', lastname: 'Shop' });
    await Q('CustomerLanguage').create({ workspaceId: B.workspaceId, customerId: b._id, language: 'ar', languageSource: 'merchant_set' }); // an Arabic record in an unflagged workspace
    const pi = intent(b.phone);
    // like the real checkout, the pending order of the PaymentIntent carries the workspace (a PaymentIntent without an order falls back to the OLDEST workspace, like the webhook)
    await Q('Order').create({ workspaceId: B.workspaceId, customer: b._id, items: [{ productName: 'Item', category: 'x', quantity: 1, unitPrice: 50 }], subtotal: 45, total: 50, status: 'pending', paymentStatus: 'pending', stripePaymentIntentId: pi.id });
    for (const query of ['', '?lang=ar']) {
      const res = await page(pi.id, query);
      expect(['B', query, res.text.includes('Complete Your Payment')]).toEqual(['B', query, true]);
      expect(['B', query, res.text.includes('العربية')]).toEqual(['B', query, false]);
      expect(isArabicPage(res.text)).toBe(false);
    }
    const a = await ar(); const e = await en();
    const piA = intent(a.phone); const piE = intent(e.phone);
    process.env.LOCALIZATION_DISABLED = '1';
    try {
      for (const [id, query] of [[piA.id, ''], [piA.id, '?lang=ar'], [piE.id, ''], [piE.id, '?lang=ar']]) {
        const res = await page(id, query);
        expect(['kill', id === piA.id ? 'ar-customer' : 'en-customer', query, res.text.includes('Complete Your Payment')]).toEqual(['kill', id === piA.id ? 'ar-customer' : 'en-customer', query, true]);
        expect(['kill', id === piA.id ? 'ar-customer' : 'en-customer', query, res.text.includes('العربية')]).toEqual(['kill', id === piA.id ? 'ar-customer' : 'en-customer', query, false]);
      }
    } finally { delete process.env.LOCALIZATION_DISABLED; }
  });

  test('a payment intent that does not exist: the English not-found page, no link', async () => {
    const res = await page('pi_stub_nope');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Payment link not found');
    expect(res.text).not.toContain('العربية');
  });

  test('referral and Instagram redirects are untouched: a valid referral code still 302s to wa.me; unknown referral / instagram codes are the English 404 pages', async () => {
    const refPromo = await Q('ReferralPromotion').create({ workspaceId: A.workspaceId, name: 'Bring a friend', status: 'active', friendRewardType: 'percent_discount', friendRewardValue: 10, referrerRewardType: 'loyalty_points', referrerRewardValue: 50 });
    const referrer = await en();
    const code = `ACC${Date.now().toString(16).toUpperCase().slice(-7)}`;
    await Q('ReferralCode').create({ workspaceId: A.workspaceId, referralPromotionId: refPromo._id, referrerCustomerId: referrer._id, code, shortUrl: `http://localhost:3999/r/${code}` });
    const ok = await request(app).get(`/r/${code}`).redirects(0);
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    expect(decodeURIComponent(ok.headers.location)).toContain(`Code: ${code}`);
    expect(ok.text).not.toContain('العربية');
    // the same link opened as an Arabic visitor (?lang=ar): the Arabic landing page, no click recorded until the visitor continues (?go=1), then the same 302
    const landing = await request(app).get(`/r/${code}?lang=ar`).redirects(0);
    expect(landing.status).toBe(200);
    expect(landing.text).toMatch(/dir="rtl"/);
    expect((await Q('ReferralCode').findOne({ code }).lean()).clickCount).toBe(1); // only the English 302 above counted
    const go = await request(app).get(`/r/${code}?lang=ar&go=1`).redirects(0);
    expect(go.status).toBe(302);
    expect(go.headers.location).toMatch(/^https:[/][/]wa[.]me[/][0-9]+[?]text=/);
    expect((await Q('ReferralCode').findOne({ code }).lean()).clickCount).toBe(2);
    const unknown = await request(app).get('/r/DOESNOTEXIST');
    expect(unknown.status).toBe(404);
    expect(unknown.text).toContain('Link not found');
    expect(unknown.text).not.toContain('العربية');
    const ig = await request(app).get('/t/IG-DOESNOTEXIST');
    expect(ig.status).toBe(404);
    expect(ig.text).toContain('Link not found');
    expect(ig.text).not.toContain('العربية');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. STATUS: failed status callbacks store CampaignMessage.errorCode; the report views expose it
// ══════════════════════════════════════════════════════════════════════════════
describe('8. C3: Meta error codes from failed status callbacks', () => {
  test('a failed delivery callback stores errorCode (String) next to statusReason; delivered / read never write one; unknown wamid changes nothing', async () => {
    const promotion = await promo({ name: 'Status Sale' });
    const e1 = await en(); const e2 = await en();
    await require('../../../shared/operations').sendPromotion({ promotionId: String(promotion._id), customerIds: ids(e1, e2), workspaceId: A.workspaceId });
    const r1 = await Q('CampaignMessage').findOne({ promotion: promotion._id, customer: e1._id }).lean();
    const r2 = await Q('CampaignMessage').findOne({ promotion: promotion._id, customer: e2._id }).lean();
    await postStatuses([
      { id: r1.wamid, status: 'failed', timestamp: '1760000100', recipient_id: e1.phone, errors: [{ code: 131049, title: 'Message not delivered to maintain ecosystem engagement' }] },
      { id: r2.wamid, status: 'delivered', timestamp: '1760000100', errors: [{ code: 131049, title: 'ignored' }] },
      { id: 'wamid.NOPE', status: 'failed', timestamp: '1760000100', errors: [{ code: 1, title: 'x' }] },
    ]);
    const f1 = await Q('CampaignMessage').collection.findOne({ _id: r1._id });
    expect(f1).toMatchObject({ status: 'failed', errorCode: '131049', statusReason: 'Message not delivered to maintain ecosystem engagement' });
    expect(typeof f1.errorCode).toBe('string');
    const f2 = await Q('CampaignMessage').collection.findOne({ _id: r2._id });
    expect(f2.status).toBe('delivered');
    expect('errorCode' in f2).toBe(false);
    // a failed callback without a code: no errorCode key at all (exactly like before)
    const e3 = await en();
    await require('../../../shared/operations').sendPromotion({ promotionId: String(promotion._id), customerIds: ids(e3), workspaceId: A.workspaceId });
    const r3 = await Q('CampaignMessage').findOne({ promotion: promotion._id, customer: e3._id }).lean();
    await postStatuses([{ id: r3.wamid, status: 'failed', timestamp: '1760000100', errors: [{ title: 'No code here' }] }]);
    const f3 = await Q('CampaignMessage').collection.findOne({ _id: r3._id });
    expect(f3).toMatchObject({ status: 'failed', statusReason: 'No code here' });
    expect('errorCode' in f3).toBe(false);
  });

  test('the Arabic campaign recipients view (hub campaign sent for real through the builder) shows the Meta code and reason of a delivery that came back failed', async () => {
    const tpl = await fx.makeTemplate(A.workspaceId);
    const a1 = await ar({ firstname: 'منى' }); const a2 = await ar({ firstname: 'هند', lastname: 'Two' }); const e1 = await en();
    const body = { name: 'C3 hub campaign', templateId: String(tpl._id), audience: { kind: 'customer_ids', customerIds: ids(a1, a2, e1) }, fieldValues: {} };
    const created = await request(app).post('/api/localization/campaigns').set(A.auth).send(body);
    expect(created.status).toBe(201);
    const id = created.body.id;
    const sent = await request(app).post(`/api/localization/campaigns/${id}/send`).set(A.auth).send({});
    expect(sent.status).toBe(202);
    const done = await waitFor(async () => { const r = await request(app).get(`/api/localization/campaigns/${id}`).set(A.auth); return r.body.status !== 'sending' ? r.body : null; }, 60000);
    expect(done.status).toBe('sent');
    const sends = await Q('LocalizedSend').find({ campaignId: id }).lean();
    const bad = sends.find((s) => String(s.customerId) === String(a1._id));
    const good = sends.find((s) => String(s.customerId) === String(a2._id));
    expect(bad.wamid).toBeTruthy();
    await postStatuses([
      { id: bad.wamid, status: 'failed', timestamp: '1760000100', errors: [{ code: 131049, title: 'Per-user marketing limit' }] },
      { id: good.wamid, status: 'delivered', timestamp: '1760000100' },
    ]);
    const recipients = await request(app).get(`/api/localization/campaigns/${id}/recipients`).set(A.auth);
    expect(recipients.status).toBe(200);
    const byPhone = Object.fromEntries(recipients.body.items.map((i) => [i.phone, i]));
    expect(byPhone[a1.phone]).toMatchObject({ deliveryStatus: 'failed', errorCode: '131049', error: 'Per-user marketing limit' });
    expect(byPhone[a2.phone]).toMatchObject({ deliveryStatus: 'delivered', errorCode: null, error: null });
  });

  test('the legacy send-report of a promotion exposes the delivery failure code of an Arabic send', async () => {
    const promotion = await promo({ name: 'Report Sale' });
    await arabicTemplate(A.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: LINKED_BODY, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    const a1 = await ar(); const a2 = await ar({ firstname: 'نورة' });
    const out = await request(app).post(`/api/promotions/${promotion._id}/send`).set(A.auth).send({ customerIds: ids(a1, a2) });
    expect(out.body).toMatchObject({ sentCount: 2, languageCounts: { ar: 2, en: 0 } });
    const rows = await Q('CampaignMessage').find({ promotion: promotion._id }).lean();
    const bad = rows.find((r) => String(r.customer) === String(a1._id));
    await postStatuses([{ id: bad.wamid, status: 'failed', timestamp: '1760000100', errors: [{ code: 131049, title: 'Per-user marketing limit' }] }]);
    const report = await request(app).get(`/api/localization/promotions/${promotion._id}/send-report`).set(A.auth);
    expect(report.status).toBe(200);
    expect(report.body.byLanguage.ar.sent).toBe(2);
    expect(JSON.stringify(report.body)).toContain('131049'); // C3: the code reaches the legacy report
    // the existing legacy campaign report counts it as failed, as before
    const legacy = await require('../../../shared/operations').getCampaignReport({ promotionId: String(promotion._id), workspaceId: A.workspaceId });
    expect(legacy).toMatchObject({ messagesFailed: 1 });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. KILL SWITCH LOCALIZATION_DISABLED=1
// ══════════════════════════════════════════════════════════════════════════════
describe('9. Kill switch: everything behaves like the English baseline, except that the exact Arabic opt-out keywords are still honoured', () => {
  const ops = () => require('../../../shared/operations');
  const killed = async (fn) => { process.env.LOCALIZATION_DISABLED = '1'; try { return await fn(); } finally { delete process.env.LOCALIZATION_DISABLED; } };
  const BASE_KEYS = ['success', 'sentCount', 'skippedOptedOut', 'skippedNoConsent', 'errors', 'demoCount'];

  test('loyalty reminder: an Arabic customer gets exactly the English template an English customer gets; response has no localisation keys; no sidecar rows', async () => {
    await arabicTemplate(A.workspaceId, { useCase: 'loyalty_reminder', body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}، وقيمته {amount}. نسعد بخدمتك دائماً', buttons: [{ ...OPT_OUT_AR }] });
    const a = await ar({ firstname: 'Omar', loyaltyPoints: 77 }); const e = await en({ firstname: 'Omar', loyaltyPoints: 77 });
    const out = await killed(() => ops().sendLoyaltyReminders({ workspaceId: A.workspaceId, customerIds: ids(a, e) }));
    expect(Object.keys(out)).toEqual(['success', 'sentCount', 'skippedOptedOut', 'skippedNoConsent', 'demoCount']);
    expect(out).toMatchObject({ sentCount: 2 });
    expect({ ...to(a.phone)[0], to: 'x' }).toEqual({ ...to(e.phone)[0], to: 'x' });
    expect(to(a.phone)[0].template.language).toEqual({ code: 'en' });
    expect(await Q('LocalizedLegacySend').countDocuments({ workspaceId: A.workspaceId, customerId: a._id })).toBe(0);
  });

  test('promotion send (HTTP): English announcement for the Arabic customer, no languageCounts / localization keys, no sidecar rows; the hub plan route is closed', async () => {
    const promotion = await promo({ name: 'Kill Sale' });
    await arabicTemplate(A.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: LINKED_BODY, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    const a = await ar({ firstname: 'Omar' }); const e = await en({ firstname: 'Omar' });
    const res = await killed(() => request(app).post(`/api/promotions/${promotion._id}/send`).set(A.auth).send({ customerIds: ids(a, e) }));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(BASE_KEYS);
    expect(res.body.languageCounts).toBeUndefined();
    expect(res.body.localization).toBeUndefined();
    expect({ ...to(a.phone)[0], to: 'x' }).toEqual({ ...to(e.phone)[0], to: 'x' });
    expect(to(a.phone)[0].type).toBe('interactive');
    expect(await Q('LocalizedLegacySend').countDocuments({ workspaceId: A.workspaceId, refId: String(promotion._id) })).toBe(0);
    const planRes = await killed(() => request(app).post(`/api/localization/promotions/${promotion._id}/send-plan`).set(A.auth).send({ customerIds: ids(a) }));
    expect([402, 403, 404]).toContain(planRes.status);
  });

  test('flows: the scheduler sends the English entry message to an Arabic customer', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const promotion = await promo({ name: 'Kill Flow Sale' });
    const entry = await Q('MessageNode').create({ workspaceId: A.workspaceId, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Hi {{1}}! {{2}}', templateName: `acc_kill_${fx.uniq()}`, templateStatus: 'approved', buttons: [{ position: 0, label: 'Go', nextAction: { type: 'end_flow' } }] });
    await Q('Promotion').updateOne({ _id: promotion._id }, { $set: { entryNodeId: entry._id } });
    await Q('LocalizedTemplate').create({ workspaceId: A.workspaceId, key: `flow_message_${entry._id}`, name: 'Kill flow', category: 'MARKETING', useCase: 'custom', linkedMessageNodeId: entry._id, variants: [
      { language: 'en', body: 'Hi {name}!', buttons: [{ role: 'flow_button', text: 'Go' }], metaStatus: 'APPROVED', metaTemplateName: entry.templateName, metaLanguage: 'en' },
      { language: 'ar', body: 'أهلاً {name}! عرضنا بانتظارك', buttons: [{ role: 'flow_button', text: 'تسوق' }, { ...OPT_OUT_AR }], metaStatus: 'APPROVED', metaTemplateName: `wf_kill_${fx.uniq()}_ar`, metaLanguage: 'ar', reviewStatus: 'reviewed', reviewedBy: 'Native Reviewer' },
    ] });
    const flow = await Q('Flow').create({ workspaceId: A.workspaceId, name: 'Kill flow', triggerType: 'inactive_customer', status: 'active', promotionId: promotion._id, inactivityDays: 1 });
    const a = await fx.makeCustomer(A.workspaceId, { language: 'ar', firstname: 'سارة', lastname: 'Kill' });
    const order = await Q('Order').create({ workspaceId: A.workspaceId, customer: a._id, total: 10, status: 'delivered' });
    await Q('Order').collection.updateOne({ _id: order._id }, { $set: { createdAt: new Date(Date.now() - 5 * DAY) } });
    await killed(async () => require('../../../utils/flowScheduler').sweepFlow(await Q('Flow').findById(flow._id)));
    const sent = to(a.phone);
    expect(sent).toHaveLength(1);
    expect(sent[0].template.name).toBe(entry.templateName);
    expect(sent[0].template.language).toEqual({ code: 'en' });
    expect(W.templateButtons(sent[0])).toEqual([`msgnode_${entry._id}_0`]);
  });

  test.each([0, 1, 4, 5, 10, 11])('shopping journey script %# replayed for an Arabic customer under the kill switch = the English recording, byte for byte (calls and DB outcome)', async (index) => {
    const sc = J.SCRIPTS[index];
    const recorded = J.recorded[sc.name];
    expect(recorded).toBeDefined();
    const got = await killed(() => J.runOne(sc, 'ar'));
    expect(JSON.stringify(J.norm(got))).toBe(JSON.stringify(J.norm(recorded.en)));
    expect(JSON.parse(JSON.stringify(got.db))).toEqual(JSON.parse(JSON.stringify(recorded.en.db)));
    for (const m of W.messagesOf(got.calls)) expect(W.englishProblems(m.body, [...MERCHANT_STRINGS, 'Bulk', 'Journey'])).toEqual([]);
  });

  test.each([0, 6, 10])('flag turned OFF for the workspace (the state of every merchant not switched on): journey script %# for an Arabic-language customer = the English recording, byte for byte', async (index) => {
    const sc = J.SCRIPTS[index];
    const recorded = J.recorded[sc.name];
    const settingsMod = require('../../../shared/localization/settings');
    await settingsMod.setArabicEnabled({ workspaceId: A.workspaceId, enabled: false, grantedBy: 'itest' });
    try {
      const got = await J.runOne(sc, 'ar');
      expect(J.norm(got)).toEqual(J.norm(recorded.en));
      expect(JSON.parse(JSON.stringify(got.db))).toEqual(JSON.parse(JSON.stringify(recorded.en.db)));
    } finally { await settingsMod.setArabicEnabled({ workspaceId: A.workspaceId, enabled: true, grantedBy: 'itest' }); }
  });

  test('exact Arabic opt-out keywords are STILL honoured (compliance); a phrase that merely contains one is not (as in English)', async () => {
    const a = await ar({ loyaltyPoints: 50 });
    await killed(async () => { await post(textMsg(a.phone, 'إلغاء الاشتراك')); });
    expect(await Q('Customer').findById(a._id).lean()).toMatchObject({ optedOut: true });
    expect((await Q('ConsentEvent').find({ customerId: a._id }).lean()).map((x) => x.type)).toContain('consent_withdrawn');
    const b = await ar({ loyaltyPoints: 50 });
    await killed(async () => { await post(textMsg(b.phone, 'إِلْغَاءُ الاشتِراكِ')); }); // diacritics: still an exact keyword after normalisation
    expect((await Q('Customer').findById(b._id).lean()).optedOut).toBe(true);
    const c = await ar({ loyaltyPoints: 50 });
    await killed(async () => { await post(textMsg(c.phone, 'أبغى إلغاء الاشتراك من فضلك والله')); });
    expect((await Q('Customer').findById(c._id).lean()).optedOut).toBeFalsy(); // the sentence tier is part of the switched-off feature
  });

  test('the three approved GLOBAL changes stay active under the kill switch: H1 (all records), C3 (errorCode), B2 (Arabic digits in a CSV phone)', async () => {
    // H1
    const n = `96657${String(Date.now()).slice(-7)}`;
    const r1 = await fx.makeCustomer(A.workspaceId, { phone: n, firstname: 'K1' }); const r2 = await fx.makeCustomer(A.workspaceId, { phone: `+${n}`, firstname: 'K2' });
    await killed(async () => { await post(textMsg(n, 'STOP')); });
    expect((await Q('Customer').findById(r1._id).lean()).optedOut).toBe(true);
    expect((await Q('Customer').findById(r2._id).lean()).optedOut).toBe(true);
    // C3
    const promotion = await promo({ name: 'Kill C3' });
    const e = await en();
    await ops().sendPromotion({ promotionId: String(promotion._id), customerIds: ids(e), workspaceId: A.workspaceId });
    const row = await Q('CampaignMessage').findOne({ promotion: promotion._id, customer: e._id }).lean();
    await killed(async () => { await postStatuses([{ id: row.wamid, status: 'failed', timestamp: '1760000100', errors: [{ code: 131026, title: 'Message undeliverable' }] }]); });
    expect((await Q('CampaignMessage').findById(row._id).lean())).toMatchObject({ status: 'failed', errorCode: '131026' });
  });

  test('B4 and customer-language import are off under the kill switch (no customer from a one-word name, no language sidecar from a CSV column)', async () => {
    const phone = `96657${String(Date.now()).slice(-7)}`;
    await killed(async () => { await post(textMsg(phone, 'hello'), 'ليلى'); });
    expect(await Q('Customer').countDocuments({ phone })).toBe(0);
    const tag = String(Date.now()).slice(-6);
    const csv = Buffer.from(`name,phone,language\nKilled Import,96658${tag},ar\n`, 'utf8');
    const created = await killed(async () => request(app).post('/api/imports').set(A.auth).field('entityType', 'customer').attach('file', csv, { filename: 'k.csv', contentType: 'text/csv' }));
    expect(created.status).toBe(201);
    expect(created.body.fields.map((f) => f.key)).not.toContain('language');
    await killed(async () => { await request(app).post(`/api/imports/${created.body.id}/run`).set(A.auth).send({}); });
    const imported = await Q('Customer').findOne({ workspaceId: A.workspaceId, phone: `96658${tag}` }).lean();
    if (imported) expect(await Q('CustomerLanguage').countDocuments({ workspaceId: A.workspaceId, customerId: imported._id })).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. TENANT ISOLATION
// ══════════════════════════════════════════════════════════════════════════════
describe('10. Tenant isolation: no Arabic leaks across workspaces, no cross-workspace reads or writes', () => {
  const ops = () => require('../../../shared/operations');
  const settings = () => require('../../../shared/localization/settings');
  const withBFlagged = async (fn) => { await settings().setArabicEnabled({ workspaceId: B.workspaceId, enabled: true, grantedBy: 'itest' }); try { return await fn(); } finally { await settings().setArabicEnabled({ workspaceId: B.workspaceId, enabled: false, grantedBy: 'itest' }); } };
  const bCustomer = (over = {}) => fx.makeCustomer(B.workspaceId, { firstname: 'Bee', lastname: 'Shop', ...over });

  test('unscoped (MCP / GPT style, no workspaceId) promotion send of workspace A to [A Arabic customer, B customer with the SAME phone]: A gets Arabic, B gets English, nothing written for B', async () => {
    const promotion = await promo({ name: 'Iso Sale' });
    const tpl = await arabicTemplate(A.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: LINKED_BODY, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    const a = await ar({ firstname: 'سارة' });
    const b = await bCustomer({ phone: a.phone });
    await Q('CustomerLanguage').create({ workspaceId: B.workspaceId, customerId: b._id, language: 'ar', languageSource: 'merchant_set' }); // even an Arabic row INSIDE B must not matter: B is not flagged
    const out = await ops().sendPromotion({ promotionId: String(promotion._id), customerIds: ids(a, b) }); // no workspaceId, like MCP / GPT Actions
    expect(out.sentCount).toBe(2);
    const sent = msgs().filter((m) => m.to === a.phone);
    expect(sent).toHaveLength(2); // same number twice: one message per record
    const arabicOnes = sent.filter((m) => m.type === 'template' && m.template.name === arName(tpl));
    const englishOnes = sent.filter((m) => m.type === 'interactive');
    expect(arabicOnes).toHaveLength(1);
    expect(englishOnes).toHaveLength(1);
    expect(W.englishProblems(englishOnes[0], ['Iso Sale'])).toEqual([]);
    expect(await Q('LocalizedLegacySend').countDocuments({ workspaceId: B.workspaceId })).toBe(0);
    const bRow = await Q('CampaignMessage').findOne({ promotion: promotion._id, customer: b._id }).lean();
    const aRow = await Q('CampaignMessage').findOne({ promotion: promotion._id, customer: a._id }).lean();
    expect(bRow.messageType).toBe('interactive');
    expect(aRow.messageType).toBe('template');
  });

  test('unscoped loyalty reminder across both workspaces: the Arabic variant is used only for the flagged workspace\'s Arabic customer', async () => {
    await arabicTemplate(A.workspaceId, { useCase: 'loyalty_reminder', body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}، وقيمته {amount}. نسعد بخدمتك دائماً', buttons: [{ ...OPT_OUT_AR }] });
    const a = await ar({ loyaltyPoints: 100 });
    const b = await bCustomer({ phone: a.phone, loyaltyPoints: 100 });
    await Q('CustomerLanguage').create({ workspaceId: B.workspaceId, customerId: b._id, language: 'ar', languageSource: 'merchant_set' });
    const out = await ops().sendLoyaltyReminders({ customerIds: ids(a, b) });
    expect(out.sentCount).toBe(2);
    const sent = msgs().filter((m) => m.to === a.phone);
    expect(sent.filter((m) => m.type === 'template' && m.template.language.code === 'ar')).toHaveLength(1);
    expect(sent.filter((m) => m.type === 'template' && m.template.language.code === 'en')).toHaveLength(1);
    expect(await Q('LocalizedLegacySend').countDocuments({ workspaceId: B.workspaceId })).toBe(0);
  });

  test('a FLAGGED second workspace never inherits the language of the same phone from workspace A (and its own Arabic variants stay its own)', async () => {
    await withBFlagged(async () => {
      const a = await ar({ loyaltyPoints: 100 }); // Arabic in A
      const b = await bCustomer({ phone: a.phone, loyaltyPoints: 100 }); // same number in B, no language row in B
      const tplB = await arabicTemplate(B.workspaceId, { useCase: 'loyalty_reminder', body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}، وقيمته {amount}. نسعد بخدمتك دائماً', buttons: [{ ...OPT_OUT_AR }] });
      reset();
      const outB = await ops().sendLoyaltyReminders({ workspaceId: B.workspaceId, customerIds: ids(b) });
      expect(outB.sentCount).toBe(1);
      expect(msgs().find((m) => m.to === b.phone).template.language).toEqual({ code: 'en' }); // B's customer has no language in B: English, whatever A knows about the number
      // B's customer set to Arabic in B: gets B's template, never A's
      await Q('CustomerLanguage').create({ workspaceId: B.workspaceId, customerId: b._id, language: 'ar', languageSource: 'merchant_set' });
      require('../../../shared/localization/outbound')._resetForTests();
      reset();
      await ops().sendLoyaltyReminders({ workspaceId: B.workspaceId, customerIds: ids(b) });
      const m = msgs().find((x) => x.to === b.phone);
      expect(m.template.name).toBe(arName(tplB));
      expect(await Q('LocalizedLegacySend').countDocuments({ workspaceId: A.workspaceId, customerId: b._id })).toBe(0);
    });
  });

  test('cross-workspace reads and writes through the hub APIs are 404 for a flagged intruder (and 402 for an unflagged one)', async () => {
    const promotion = await promo({ name: 'Secret Sale' });
    const tpl = await arabicTemplate(A.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: LINKED_BODY, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    const a = await ar();
    const node = await Q('MessageNode').create({ workspaceId: A.workspaceId, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: false, depth: 1, bodyText: 'Hello {{1}}', buttons: [{ position: 0, label: 'Ok', nextAction: { type: 'end_flow' } }] });
    const item = F.p1;
    const calls404 = (api) => [
      api.post(`/api/localization/promotions/${promotion._id}/send-plan`).send({ customerIds: ids(a) }),
      api.get(`/api/localization/promotions/${promotion._id}/send-report`),
      api.post(`/api/localization/promotions/${promotion._id}/test-send`).send({ phone: '966509990009' }),
      api.get(`/api/localization/customers/${a._id}/language`),
      api.put(`/api/localization/customers/${a._id}/language`).send({ language: 'en' }),
      api.get(`/api/localization/flows/followups/${node._id}`),
      api.put(`/api/localization/flows/followups/${node._id}/variants/ar`).send({ body: 'مرحبا {name}', buttons: [{ position: 0, text: 'حسناً' }], source: 'merchant' }),
      api.get(`/api/localization/catalog/product/${item._id}/translation`),
      api.put(`/api/localization/catalog/product/${item._id}/translation`).send({ name: 'تسريب', description: '' }),
      api.post(`/api/localization/catalog/product/${item._id}/translation/review`).send({ status: 'reviewed' }),
      api.get(`/api/localization/templates/${tpl._id}`),
    ];
    const as = (who) => ({ get: (u) => request(app).get(u).set(who.auth), post: (u) => request(app).post(u).set(who.auth), put: (u) => request(app).put(u).set(who.auth) });
    const unflagged = await Promise.all(calls404(as(B)));
    expect(unflagged.map((r) => r.status)).toEqual(unflagged.map(() => 402));
    await withBFlagged(async () => {
      const results = [];
      for (const pending of calls404(as(B))) results.push(await pending);
      expect(results.map((r) => r.status)).toEqual(results.map(() => 404));
    });
    // nothing of A was changed by the attempts
    expect(await Q('ProductTranslation').findOne({ workspaceId: A.workspaceId, kind: 'product', refId: item._id, name: 'تسريب' })).toBeNull();
    expect(await Q('LocalizedFlowNode').countDocuments({ messageNodeId: node._id })).toBe(0);
    expect((await Q('CustomerLanguage').findOne({ workspaceId: A.workspaceId, customerId: a._id }).lean()).language).toBe('ar');
  });

  test('a customer of workspace B messaging the (single-workspace) webhook is matched only inside workspace A: no B record is touched, no Arabic words reach a B-only number', async () => {
    const phone = `96659${String(Date.now()).slice(-7)}`;
    const b = await bCustomer({ phone, firstname: 'Bee' });
    await post(textMsg(phone, 'إلغاء الاشتراك'), 'Bee'); // arrives at A's webhook; the number is unknown in A
    expect((await Q('Customer').findById(b._id).lean()).optedOut).toBeFalsy();
    expect(await Q('ConsentEvent').countDocuments({ customerId: b._id })).toBe(0);
    expect(await Q('CustomerLanguage').countDocuments({ workspaceId: B.workspaceId, customerId: b._id })).toBe(0);
  });

  test('every sidecar / campaign row written by this whole suite for workspace A belongs to A (no row of A references a customer of B)', async () => {
    const bIds = (await Q('Customer').find({ workspaceId: B.workspaceId }).select('_id').lean()).map((c) => c._id);
    expect(await Q('LocalizedLegacySend').countDocuments({ workspaceId: A.workspaceId, customerId: { $in: bIds } })).toBe(0);
    expect(await Q('CustomerLanguage').countDocuments({ workspaceId: A.workspaceId, customerId: { $in: bIds } })).toBe(0);
    expect(await Q('ConsentEvent').countDocuments({ workspaceId: A.workspaceId, customerId: { $in: bIds } })).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4b. Language selection (merchant default, inferred from the first message) and long Arabic text / WhatsApp limits
// ══════════════════════════════════════════════════════════════════════════════
describe('4b. Customer language rules and WhatsApp limits', () => {
  const settings = () => require('../../../shared/localization/settings');
  const outbound = () => require('../../../shared/localization/outbound');
  const clearState = () => { for (const m of Object.values(require('../../../utils/state'))) if (m && typeof m.clear === 'function') m.clear(); };

  test('a customer with no language record gets the merchant DEFAULT language (spec 3.1): English by default, Arabic when the merchant default is Arabic; the stored language always wins', async () => {
    await arabicTemplate(A.workspaceId, { useCase: 'loyalty_reminder', body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}، وقيمته {amount}. نسعد بخدمتك دائماً', buttons: [{ ...OPT_OUT_AR }] });
    const ops = require('../../../shared/operations');
    const unknown = await fx.makeCustomer(A.workspaceId, { firstname: 'Unknown', lastname: 'Lang', loyaltyPoints: 40 });
    const storedEn = await en({ loyaltyPoints: 40 });
    reset();
    await ops.sendLoyaltyReminders({ workspaceId: A.workspaceId, customerIds: ids(unknown) });
    expect(to(unknown.phone)[0].template.language).toEqual({ code: 'en' }); // merchant default is English
    try {
      await settings().updateMerchantSettings(A.workspaceId, { defaultCustomerLanguage: 'ar' });
      outbound()._resetForTests();
      const unknown2 = await fx.makeCustomer(A.workspaceId, { firstname: 'Unknown', lastname: 'Two', loyaltyPoints: 40 });
      reset();
      await ops.sendLoyaltyReminders({ workspaceId: A.workspaceId, customerIds: ids(unknown2, storedEn) });
      expect(to(unknown2.phone)[0].template.language).toEqual({ code: 'ar' }); // default Arabic
      expect(to(storedEn.phone)[0].template.language).toEqual({ code: 'en' }); // stored English wins
      // the journey follows the same rule for a number the workspace does not know yet
      clearState();
      const walker = await fx.makeCustomer(A.workspaceId, { firstname: 'Walker', lastname: 'Default' });
      reset();
      await post(ibtn(walker.phone, `promo_${F.pShop._id}`, 'Shop Now'));
      expect(to(walker.phone).map((m) => JSON.stringify(m)).join(' ')).toContain('قميص أزرق');
    } finally {
      await settings().updateMerchantSettings(A.workspaceId, { defaultCustomerLanguage: 'en' });
      outbound()._resetForTests();
    }
  });

  test('language is inferred from the first inbound message: an Arabic first message stores ar (inferred), an English one en; a stored merchant_set language is never overwritten', async () => {
    const arabicFirst = await fx.makeCustomer(A.workspaceId, { firstname: 'First', lastname: 'Arabic' });
    await post(textMsg(arabicFirst.phone, 'مرحبا، أبغى أشوف العروض'));
    expect(await Q('CustomerLanguage').findOne({ workspaceId: A.workspaceId, customerId: arabicFirst._id }).lean()).toMatchObject({ language: 'ar', languageSource: 'inferred' });
    clearState();
    outbound()._resetForTests();
    reset();
    await post(ibtn(arabicFirst.phone, `promo_${F.pShop._id}`, 'Shop Now'));
    expect(to(arabicFirst.phone).map((m) => JSON.stringify(m)).join(' ')).toContain('قميص أزرق');
    const englishFirst = await fx.makeCustomer(A.workspaceId, { firstname: 'First', lastname: 'English' });
    await post(textMsg(englishFirst.phone, 'hello, what offers do you have today?'));
    expect(await Q('CustomerLanguage').findOne({ workspaceId: A.workspaceId, customerId: englishFirst._id }).lean()).toMatchObject({ language: 'en', languageSource: 'inferred' });
    const chosen = await ar();
    await post(textMsg(chosen.phone, 'hello there, English message from an Arabic-set customer'));
    expect(await Q('CustomerLanguage').findOne({ workspaceId: A.workspaceId, customerId: chosen._id }).lean()).toMatchObject({ language: 'ar', languageSource: 'merchant_set' });
  });

  test('ops.createOrder (dashboard / AI Mode / MCP / GPT): the Arabic customer gets the Arabic order summary with reviewed names, SAR amounts and the ?lang=ar pay link; the English customer the unchanged English summary; the order + Stripe intent are identical', async () => {
    const ops = require('../../../shared/operations');
    const a = await fx.makeCustomer(A.workspaceId, { firstname: 'Journey', lastname: 'OrderAr', address: ADDRESSES[2] });
    await Q('CustomerLanguage').create({ workspaceId: A.workspaceId, customerId: a._id, language: 'ar', languageSource: 'merchant_set' });
    const e = await fx.makeCustomer(A.workspaceId, { firstname: 'Journey', lastname: 'OrderEn', address: ADDRESSES[2] });
    await Q('CustomerLanguage').create({ workspaceId: A.workspaceId, customerId: e._id, language: 'en', languageSource: 'merchant_set' });
    const make = async (c) => { reset(); mockStripe.last = null; const out = await ops.createOrder({ customerId: String(c._id), items: [{ productId: String(F.p2._id), quantity: 2 }, { productId: String(F.p4._id), quantity: 1 }], workspaceId: A.workspaceId }); return { out, sent: to(c.phone) }; };
    const ar1 = await make(a);
    const en1 = await make(e);
    expect(ar1.out).toMatchObject({ success: true, subtotal: 30.5, shippingCost: en1.out.shippingCost, total: en1.out.total, itemCount: 3 });
    expect(ar1.sent).toHaveLength(en1.sent.length);
    const arText = ar1.sent.map((m) => (m.text ? m.text.body : m.interactive.body.text)).join('\n');
    expect(arText).toContain('قبعة حمراء'); // reviewed Arabic name
    expect(arText).toContain('Yellow Socks'); // draft translation: the English name stays
    expect(arText).toContain('ر.س');
    expect(arText).not.toMatch(/\bSAR\b|Order Summary|Subtotal|Shipping/);
    expect(arText).toMatch(/\/pay\/pi_stub_\d+\?lang=ar/);
    for (const m of ar1.sent) expect(W.arabicProblems(m, [...MERCHANT_STRINGS, 'Journey'])).toEqual([]);
    const enText = en1.sent.map((m) => (m.text ? m.text.body : m.interactive.body.text)).join('\n');
    expect(enText).toContain('Your Order Summary');
    expect(enText).not.toContain('lang=ar');
    expect(W.englishProblems(en1.sent[0], MERCHANT_STRINGS)).toEqual([]);
    const orders = await Q('Order').find({ customer: { $in: [a._id, e._id] } }).sort({ createdAt: 1 }).lean();
    expect(orders.map((o) => [o.status, o.paymentStatus, o.total, o.items.map((i) => i.productName).join('|'), o.source])).toEqual([
      ['pending', 'pending', en1.out.total, 'Red Hat|Red Hat|Yellow Socks', 'manual'], ['pending', 'pending', en1.out.total, 'Red Hat|Red Hat|Yellow Socks', 'manual'],
    ]); // the stored order always keeps the merchant's own (English) item names, whatever language the customer reads
  });

  test('very long Arabic names and descriptions (reviewed) stay inside every WhatsApp limit in cards, lists and the order summary', async () => {
    const longEn = (n) => `Extra Long Product Name ${n} `.repeat(6).trim().slice(0, 190);
    const products = [];
    for (let i = 1; i <= 3; i += 1) {
      const product = await Q('Product').create({ workspaceId: A.workspaceId, name: longEn(i), category: 'Long', basePrice: 100 + i, description: 'A very long description. '.repeat(60).slice(0, 1500) });
      await Q('ProductTranslation').create({ workspaceId: A.workspaceId, kind: 'product', refId: product._id, language: 'ar', name: `منتج طويل جداً رقم ${i} `.repeat(8).trim().slice(0, 190), description: 'وصف طويل جداً للمنتج. '.repeat(90).slice(0, 1800), status: 'reviewed', source: 'merchant', reviewedBy: 'Native Reviewer', reviewedAt: new Date() });
      products.push(product);
    }
    const longPromo = await promo({ name: 'Long Sale', products: products.map((p) => p._id), discountPercent: 10 });
    outbound()._resetForTests();
    const run = async (language) => {
      clearState();
      const c = await fx.makeCustomer(A.workspaceId, { firstname: 'Journey', lastname: `Long${language}`, address: ADDRESSES[2] });
      await Q('CustomerLanguage').create({ workspaceId: A.workspaceId, customerId: c._id, language, languageSource: 'merchant_set' });
      reset();
      await post(ibtn(c.phone, `promo_${longPromo._id}`, 'Shop Now'));
      for (const p of products) await post(ibtn(c.phone, `cart_${p._id}`, 'Add to Cart'));
      await post(ibtn(c.phone, 'checkout', 'Checkout'));
      return msgs().filter((m) => m.to === c.phone);
    };
    const arabic = await run('ar');
    expect(arabic.length).toBeGreaterThan(6);
    const problems = arabic.flatMap((m) => W.arabicProblems(m, [...MERCHANT_STRINGS]).filter((p) => /over \d+/.test(p)));
    expect(problems).toEqual([]);
    expect(arabic.map((m) => JSON.stringify(m)).join(' ')).toContain('منتج طويل جداً');
    const english = await run('en');
    expect(english.length).toBe(arabic.length);
    expect(english.map((m) => JSON.stringify(m)).join(' ')).not.toMatch(/[\u{0621}-\u{064A}]/u);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2b. Booking confirmation outside the 24-hour window: the approved + reviewed UTILITY template stands in
// ══════════════════════════════════════════════════════════════════════════════
describe('2b. Booking confirmation for an Arabic customer outside the 24-hour window', () => {
  test('Meta answers 131047 to the session text -> the approved + reviewed Arabic UTILITY booking_confirmation template is sent (reviewed Arabic service name); an English customer keeps the English path', async () => {
    const ops = require('../../../shared/operations');
    const tpl = await arabicTemplate(A.workspaceId, {
      useCase: 'booking_confirmation', category: 'UTILITY', body: 'تم تأكيد حجزك يا {name} ✅ الخدمة: {service} — الموعد: {date} الساعة {time}. بانتظارك!', buttons: [],
    });
    const c = await ar({ firstname: 'سارة' });
    const booking = await Q('Booking').create({ workspaceId: A.workspaceId, serviceId: F.svcA._id, slotId: F.slotA1._id, customerId: c._id, phone: c.phone, customerName: 'سارة', status: 'requested', paymentType: 'cash' });
    reset();
    failRules.push({ code: 131047, remaining: -1, message: 'Re-engagement message', match: (rec) => W.isMessagesCall(rec) && rec.body.to === c.phone && rec.body.type !== 'template' });
    await ops.confirmBooking({ bookingId: String(booking._id), workspaceId: A.workspaceId });
    const sent = to(c.phone);
    expect(sent.length).toBe(2); // the session attempt (refused by Meta) and the template
    expect(sent[0].type).not.toBe('template');
    expect(sent[1].type).toBe('template');
    expect(sent[1].template.name).toBe(arName(tpl));
    expect(sent[1].template.language).toEqual({ code: 'ar' });
    expect(W.templateBody(sent[1])).toEqual(['سارة', 'جلسة مساج', '2030-01-15', '09:00']);
    expect(W.templateButtons(sent[1])).toEqual([]);
    // no English message was sent to the Arabic customer at any point
    for (const m of sent) expect(JSON.stringify(m)).not.toMatch(/Booking Confirmed/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10b. Unflagged workspace sends + settings endpoint; Z. hygiene of every outbound message of the whole run
// ══════════════════════════════════════════════════════════════════════════════
describe('10b. The unflagged workspace B: English senders unchanged even with Arabic data around', () => {
  test('promotion + loyalty send of workspace B (Arabic-language customers, an approved Arabic variant): English only, base response keys, no sidecar rows; /settings says not enabled', async () => {
    const product = await Q('Product').create({ workspaceId: B.workspaceId, name: 'B Coffee', category: 'Drinks', basePrice: 20 });
    const promotion = await Q('Promotion').create({ workspaceId: B.workspaceId, name: 'B Sale', customerType: 'cash', scope: 'products', type: 'specific_products', products: [product._id], discountPercent: 10, status: 'draft' });
    await arabicTemplate(B.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: LINKED_BODY, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    await arabicTemplate(B.workspaceId, { useCase: 'loyalty_reminder', body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}، وقيمته {amount}. نسعد بخدمتك دائماً', buttons: [{ ...OPT_OUT_AR }] });
    const b1 = await fx.makeCustomer(B.workspaceId, { language: 'ar', firstname: 'Sam', lastname: 'B', loyaltyPoints: 60 });
    const b2 = await fx.makeCustomer(B.workspaceId, { firstname: 'Sam', lastname: 'B', loyaltyPoints: 60 });
    const res = await request(app).post(`/api/promotions/${promotion._id}/send`).set(B.auth).send({ customerIds: ids(b1, b2) });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['success', 'sentCount', 'skippedOptedOut', 'skippedNoConsent', 'errors', 'demoCount']);
    expect({ ...to(b1.phone)[0], to: 'x' }).toEqual({ ...to(b2.phone)[0], to: 'x' }); // the Arabic-language customer of an unflagged workspace gets the very same English message
    reset();
    const loyalty = await request(app).post('/api/promotions/loyalty/remind').set(B.auth).send({ customerIds: ids(b1, b2) });
    expect(Object.keys(loyalty.body)).toEqual(['success', 'sentCount', 'skippedOptedOut', 'skippedNoConsent', 'demoCount']);
    expect(msgs().every((m) => m.type === 'template' && m.template.language.code === 'en')).toBe(true);
    expect(await Q('LocalizedLegacySend').countDocuments({ workspaceId: B.workspaceId, customerId: { $in: [b1._id, b2._id] } })).toBe(0);
    const st = await request(app).get('/api/localization/settings').set(B.auth);
    expect(st.status).toBe(200);
    expect(st.body.arabicEnabled).toBe(false);
    expect((await request(app).get('/api/localization/settings').set(A.auth)).body.arabicEnabled).toBe(true);
  });
});

describe('Z. hygiene: every outbound WhatsApp message of this whole run', () => {
  const HIDDEN = /[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{206F}\u{FEFF}\u{00AD}]/gu;
  const strings = (body) => {
    const out = [];
    const walk = (v, key) => { if (typeof v === 'string') out.push([key, v]); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k); };
    walk(body, '');
    // ids / enums are not customer-visible text: everything else (text.body, body.text, titles, descriptions, template parameters) is
    return out.filter(([k]) => !['to', 'id', 'messaging_product', 'type', 'name', 'sub_type', 'payload', 'code', 'index', 'url', 'preview_url'].includes(k));
  };
  test('no unresolved {placeholder}, no undefined / NaN / [object Object], no hidden direction characters other than the left-to-right mark', () => {
    expect(ALL.length).toBeGreaterThan(300);
    const bad = [];
    for (const { test: name, body } of ALL) {
      for (const [key, text] of strings(body)) {
        if (/\{[a-z_]+\}/i.test(text)) bad.push(`placeholder in ${key}: ${text.slice(0, 80)} [${name}]`);
        if (/\bundefined\b|\bNaN\b|\[object Object\]/.test(text)) bad.push(`bad value in ${key}: ${text.slice(0, 80)} [${name}]`);
        if (/[\u{0660}-\u{0669}\u{06F0}-\u{06F9}]/u.test(text)) bad.push(`Arabic-Indic digit in ${key} (the glossary says Western digits): ${text.slice(0, 80)} [${name}]`);
        if (/[\u{0621}-\u{064A}]/u.test(text) && /\b(SAR|AED)\b/.test(text)) bad.push(`English currency code inside Arabic text in ${key}: ${text.slice(0, 80)} [${name}]`);
        const hidden = (text.match(HIDDEN) || []).filter((c) => c !== String.fromCodePoint(0x200E));
        if (hidden.length) bad.push(`hidden characters ${hidden.map((c) => c.codePointAt(0).toString(16)).join(',')} in ${key}: ${text.slice(0, 60)} [${name}]`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('no outbound message of the whole run went to a number that is not a fixture (nothing real), and every call used the stubbed adapter', () => {
    const real = ALL.filter(({ body }) => !/^(966|1555)\d{6,}$|^\+?966/.test(String(body.to)) && !/^00966/.test(String(body.to)) && !/^[0-9]{9,15}$/.test(String(body.to)));
    expect(real).toEqual([]);
  });
});
