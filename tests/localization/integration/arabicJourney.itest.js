'use strict';
// ARABIC SHOPPING JOURNEY (design D3 section 10): the real server.js webhook + Stripe webhook against the THROWAWAY mongod,
// axios adapter stubbed (nothing leaves the machine). The same journey scenarios are replayed for an ENGLISH customer
// (control) and an ARABIC customer of the same flagged workspace, and the outbound WhatsApp calls are compared:
//   (a) same number and order of calls,
//   (b) identical payload structure once every customer-visible text field is stripped (ids, types, button counts, rows),
//   (c) every text field that changed is Arabic, and no English chrome word survives in the Arabic run,
//   (d) all WhatsApp limits hold,
//   (e) product names / descriptions come from REVIEWED ProductTranslation rows only (a draft one stays English),
//   (f) the kill switch, the flag turned off, and an English customer all get the English payloads byte for byte.
// DRIFT TEST: every text/interactive payload the English journey sends must match a catalogued shape (or be on the explicit
// allow-list below) - an edited English string in server.js / utils/whatsapp.js fails CI here instead of silently staying English.
// Always a FRESH database name per run (the suite refuses a non-empty one).
const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();

const request = require('supertest');
const axios = require('axios');
const mongoose = require('mongoose');

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
    retrieve: async (id) => { if (!mockStripe.store[id]) throw new Error('No such payment_intent'); return mockStripe.store[id]; },
  },
  webhooks: { constructEvent: (body) => JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body)) },
}));

jest.setTimeout(900000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Q = (m) => require(`../../../models/${m}`);
const state = () => require('../../../utils/state');
const catalog = () => require('../../../shared/localization/catalog');
const { createMatcher, entriesFromCatalog } = require('../../../shared/localization/journeyMatcher');

// ── outbound stub ────────────────────────────────────────────────────────────
let calls = [];
let wamidSeq = 0;
axios.defaults.adapter = async (config) => {
  let body = config.data;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep */ } }
  calls.push({ method: String(config.method || '').toUpperCase(), url: String(config.url || ''), body: body === undefined ? null : body });
  const isMsg = /\/messages$/.test(String(config.url || ''));
  let data;
  if (String(config.method).toLowerCase() === 'get') data = config.responseType === 'arraybuffer' ? Buffer.from('x') : { data: [] };
  else if (isMsg) data = { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.STUB${++wamidSeq}` }] };
  else data = { id: `stub${++wamidSeq}` };
  return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};

// ── webhook helpers ──────────────────────────────────────────────────────────
let app; let W; let msgSeq = 0; let phoneSeq = 0;
const msgBase = (from) => ({ from, id: `wamid.AJ${++msgSeq}`, timestamp: '1760000000' });
const envelope = (message) => ({ object: 'whatsapp_business_account', entry: [{ id: '222222222222222', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '111111111111111' },
  contacts: [{ profile: { name: 'Journey Tester' }, wa_id: message.from }], messages: [message] } }] }] });
const textMsg = (from, body) => ({ ...msgBase(from), type: 'text', text: { body } });
const ibtn = (from, id, title) => ({ ...msgBase(from), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
const lrow = (from, id, title) => ({ ...msgBase(from), type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title, description: 'row' } } });

async function quiet() {
  await sleep(300);
  let last = -1; let stable = 0;
  for (let i = 0; i < 60 && stable < 3; i += 1) { if (calls.length === last) stable += 1; else { stable = 0; last = calls.length; } await sleep(100); }
}
async function post(payload) { await request(app).post('/webhook').send(payload); await quiet(); }
async function stripeSucceeded() {
  const pi = mockStripe.last;
  const event = { id: 'evt_stub', type: 'payment_intent.succeeded', data: { object: { id: pi.id, amount: pi.amount, currency: pi.currency, metadata: pi.metadata, status: 'succeeded' } } };
  await request(app).post('/stripe-webhook').set('Content-Type', 'application/json').send(JSON.stringify(event));
  await quiet();
}
const io = { post, stripeSucceeded };

// ── fixtures ─────────────────────────────────────────────────────────────────
const F = {};
const ADDRESSES = ['Building 7, King Fahd Road, Riyadh 12211', 'Villa 4, Al Nakheel, Riyadh', '77 Olaya St, Riyadh', '9 Hill St'];
const MERCHANT_STRINGS = ['Blue Shirt', 'Red Hat', 'Green Scarf', 'Yellow Socks', 'Black Belt', 'Bulk', 'Massage', 'Facial', 'Summer Sale', 'Points Party', 'Spa Week', 'Spa Points', 'Mega Sale',
  'M · Blue', 'L · Blue', 'S · Red', 'Soft cotton shirt', 'Soft wool scarf', ...ADDRESSES];
const consented = { marketingConsent: true, marketingConsentAt: new Date(), marketingConsentMethod: 'manual_staff_entry' };

async function mkCustomer(label, language, fields) {
  phoneSeq += 1;
  const phone = `1555030${String(phoneSeq).padStart(4, '0')}`;
  const c = await Q('Customer').create({ firstname: label, lastname: 'Journey', phone, workspaceId: W, ...(fields || {}) });
  if (language) await Q('CustomerLanguage').create({ workspaceId: W, customerId: c._id, language, languageSource: 'merchant_set' });
  return c;
}

beforeAll(async () => {
  process.env.WA_TOKEN = process.env.WA_TOKEN || 'dummy';
  process.env.APP_URL = 'http://localhost:3999';
  // The Arabic inbound hook replies through shared/localization/transport.js; 'dry_run' (the sandbox default) would swallow those replies. The axios adapter above is the safety net: nothing leaves the machine.
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
  if ((await db.collection('customers').countDocuments()) || (await db.collection('workspaces').countDocuments())) throw new Error('database is not fresh: use a new --db name for every run of arabicJourney.itest.js');

  // the webhook serves the OLDEST workspace: this is it
  W = (await Q('Workspace').create({ name: 'Arabic Journey Fixture' }))._id;
  await Q('Settings').create({ workspaceId: W, currency: 'SAR', merchantName: 'Journey Shop' });
  await require('../../../shared/localization/settings').setArabicEnabled({ workspaceId: W, enabled: true, grantedBy: 'itest' });

  const mkP = (o) => Q('Product').create({ workspaceId: W, ...o });
  F.p1 = await mkP({ name: 'Blue Shirt', category: 'Shirts', basePrice: 25, description: 'Soft cotton shirt', images: ['https://img.example.test/blue-shirt.jpg'], variants: [{ size: 'M', color: 'Blue', stock: 5 }, { size: 'L', color: 'Blue', stock: 0 }, { size: 'S', color: 'Red', stock: 2 }] });
  F.p2 = await mkP({ name: 'Red Hat', category: 'Hats', basePrice: 12, images: ['https://img.example.test/red-hat.webp'] });
  F.p3 = await mkP({ name: 'Green Scarf', category: 'Scarves', basePrice: 18, description: 'Soft wool scarf' });
  F.p4 = await mkP({ name: 'Yellow Socks', category: 'Socks', basePrice: 6.5, images: ['https://img.example.test/socks.jpg'] });
  F.p5 = await mkP({ name: 'Black Belt', category: 'Belts', basePrice: 30, images: ['https://img.example.test/belt.jpg'] });
  F.bulk = [];
  for (let i = 1; i <= 12; i += 1) F.bulk.push(await mkP({ name: `Bulk ${String(i).padStart(2, '0')}`, category: 'Bulk', basePrice: 10 + i }));
  F.svcA = await Q('Service').create({ workspaceId: W, name: 'Massage', category: 'Wellness', duration: 60, basePrice: 80, pointsPrice: 100, description: 'Relaxing hour', images: ['https://img.example.test/massage.jpg'] });
  F.svcB = await Q('Service').create({ workspaceId: W, name: 'Facial', category: 'Wellness', duration: 45, basePrice: 120, images: ['https://img.example.test/facial.jpg'] });
  const mkSlot = (svc, o) => Q('TimeSlot').create({ workspaceId: W, serviceId: svc._id, date: '2030-01-15', startTime: '09:00', endTime: '10:00', capacity: 50, bookedCount: 0, ...o });
  F.slotA1 = await mkSlot(F.svcA, {});
  F.slotA2 = await mkSlot(F.svcA, { date: '2030-01-16', startTime: '10:00', endTime: '11:00' });
  F.slotAfull = await mkSlot(F.svcA, { date: '2030-01-17', startTime: '10:00', endTime: '11:00', capacity: 1, bookedCount: 1 });
  const mkPromo = (o) => Q('Promotion').create({ workspaceId: W, customerType: 'cash', scope: 'products', ...o });
  const pid = (...ps) => ps.map((p) => p._id);
  F.pPlain = await mkPromo({ name: 'Summer Sale', discountPercent: 15, description: 'Limited time only', products: pid(F.p1, F.p2, F.p3, F.p4, F.p5) });
  F.pMany = await mkPromo({ name: 'Mega Sale', discountPercent: 30, products: F.bulk.map((p) => p._id) });
  F.pPoints = await mkPromo({ name: 'Points Party', customerType: 'points', pointsPrice: 200, products: pid(F.p3, F.p4) });
  F.pSvc = await mkPromo({ name: 'Spa Week', scope: 'services', type: 'specific_services', discountPercent: 10, services: pid(F.svcA, F.svcB) });
  F.pSvcPoints = await mkPromo({ name: 'Spa Points', scope: 'services', type: 'specific_services', customerType: 'points', pointsPrice: 100, services: pid(F.svcA) });

  // REVIEWED Arabic names (and one description); a DRAFT-only name for the scarf must never reach a customer
  const tr = (item, kind, name, status, description) => Q('ProductTranslation').create({ workspaceId: W, kind, refId: item._id, language: 'ar', name, description: description || '', status, source: 'merchant' });
  await tr(F.p1, 'product', 'قميص أزرق', 'reviewed', 'قميص قطني مريح');
  await tr(F.p2, 'product', 'قبعة حمراء', 'reviewed');
  await tr(F.p3, 'product', 'وشاح أخضر', 'draft');
  await tr(F.svcA, 'service', 'جلسة مساج', 'reviewed');

  // warm-up so every lazily required module is loaded before the first recorded scenario
  const warm = await mkCustomer('Warm', 'en', consented);
  await post(envelope(textMsg(warm.phone, 'hello there')));
  await post(envelope(ibtn(warm.phone, `promo_${F.pPlain._id}`, 'Shop Now')));
});

afterAll(async () => {
  if (process.env.AJ_DUMP) require('fs').writeFileSync(process.env.AJ_DUMP, JSON.stringify(Object.fromEntries(Object.entries(recorded).map(([k, v]) => [k, { en: messagesOf(norm(v.en)).map((c) => c.body), ar: messagesOf(norm(v.ar)).map((c) => c.body) }])), null, 1));
  jest.restoreAllMocks();
});

// ── scenarios: (customer fields, steps) replayed per customer language ────────
const J = [
  { name: 'cash journey: promo tap, add, continue, add, checkout asks address, address, pay link, Stripe confirmation', fields: consented, run: async (c) => {
    await post(envelope(ibtn(c.phone, `promo_${F.pPlain._id}`, 'Shop Now! 🛍️')));
    await post(envelope(ibtn(c.phone, `cart_${F.p3._id}`, 'Add to Cart 🛒')));
    await post(envelope(ibtn(c.phone, 'continue_shopping', 'Keep Browsing')));
    await post(envelope(ibtn(c.phone, `cart_${F.p4._id}`, 'Add to Cart 🛒')));
    await post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
    await post(envelope(textMsg(c.phone, ADDRESSES[0])));
    await stripeSucceeded();
  } },
  { name: 'cash journey: reviewed names (Blue Shirt, Red Hat) and the draft-only scarf', fields: { ...consented, address: ADDRESSES[2] }, run: async (c) => {
    await post(envelope(ibtn(c.phone, `promo_${F.pPlain._id}`, 'Shop Now! 🛍️')));
    await post(envelope(ibtn(c.phone, `cart_${F.p2._id}`, 'Add to Cart 🛒')));
    await post(envelope(ibtn(c.phone, `cart_${F.p3._id}`, 'Add to Cart 🛒')));
    await post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
    await stripeSucceeded();
  } },
  { name: 'variants: picker, variant chosen, base option, out-of-stock variant', fields: consented, run: async (c) => {
    await post(envelope(ibtn(c.phone, `promo_${F.pPlain._id}`, 'Shop Now! 🛍️')));
    await post(envelope(ibtn(c.phone, `cart_${F.p1._id}`, 'Add to Cart 🛒')));
    await post(envelope(lrow(c.phone, `variant_${F.p1._id}_0`, 'M · Blue')));
    await post(envelope(ibtn(c.phone, `cart_${F.p1._id}`, 'Add to Cart 🛒')));
    await post(envelope(lrow(c.phone, `variant_${F.p1._id}_base`, 'No preference')));
    await post(envelope(lrow(c.phone, `variant_${F.p1._id}_1`, 'L · Blue')));
    await post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
  } },
  { name: 'more than ten products: numbered list, more button, number selection', fields: consented, run: async (c) => {
    await post(envelope(ibtn(c.phone, `promo_${F.pMany._id}`, 'Shop Now')));
    await post(envelope(ibtn(c.phone, `more_10_${F.pMany._id}`, 'See Next 2')));
    await post(envelope(textMsg(c.phone, '1, 2')));
    await post(envelope(ibtn(c.phone, 'continue_shopping', 'Keep Browsing')));
  } },
  { name: 'checkout: empty cart, saved address goes to payment, Stripe unavailable, no profile', fields: { ...consented, address: ADDRESSES[3] }, run: async (c) => {
    await post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
    await post(envelope(ibtn(c.phone, `cart_${F.p4._id}`, 'Add to Cart 🛒')));
    mockStripe.failNext = true;
    await post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
    await post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
    await stripeSucceeded();
  } },
  { name: 'points: promo tap, redeem, points checkout asks address, address, YES; then NO', fields: { ...consented, loyaltyPoints: 600 }, run: async (c) => {
    await post(envelope(ibtn(c.phone, `promo_${F.pPoints._id}`, 'Shop Now! 💎')));
    await post(envelope(ibtn(c.phone, `cart_${F.p3._id}`, 'Redeem 💎')));
    await post(envelope(ibtn(c.phone, 'points_checkout', 'Redeem Points 💎')));
    await post(envelope(textMsg(c.phone, ADDRESSES[1])));
    await post(envelope(textMsg(c.phone, 'YES')));
    await post(envelope(ibtn(c.phone, `cart_${F.p4._id}`, 'Redeem 💎')));
    await post(envelope(ibtn(c.phone, 'points_checkout', 'Redeem Points 💎')));
    await post(envelope(textMsg(c.phone, 'NO')));
  } },
  { name: 'points: insufficient points', fields: { ...consented, loyaltyPoints: 50, address: ADDRESSES[3] }, run: async (c) => {
    await post(envelope(ibtn(c.phone, `promo_${F.pPoints._id}`, 'Shop Now! 💎')));
    await post(envelope(ibtn(c.phone, `cart_${F.p3._id}`, 'Redeem 💎')));
    await post(envelope(ibtn(c.phone, 'points_checkout', 'Redeem Points 💎')));
  } },
  { name: 'consent ask rides on the confirmation (customer not yet asked), then taps yes', fields: { address: ADDRESSES[3] }, run: async (c) => {
    await post(envelope(ibtn(c.phone, `promo_${F.pPlain._id}`, 'Shop Now! 🛍️')));
    await post(envelope(ibtn(c.phone, `cart_${F.p3._id}`, 'Add to Cart 🛒')));
    await post(envelope(ibtn(c.phone, 'checkout', 'Checkout ✅')));
    await stripeSucceeded();
    await post(envelope(ibtn(c.phone, `consent_yes_${c._id}`, 'Yes, sign me up')));
  } },
  { name: 'service: promo tap, slot list, slot pick, pay link + pay-later offer, reserve', fields: consented, run: async (c) => {
    await post(envelope(ibtn(c.phone, `promo_${F.pSvc._id}`, 'Book Now! 📅')));
    await post(envelope(lrow(c.phone, `slot_${F.slotA1._id}`, '2030-01-15 · 09:00')));
    await post(envelope(ibtn(c.phone, `paylater_${F.slotA1._id}`, 'Reserve, Pay in Person')));
  } },
  { name: 'service: slot pay -> Stripe booking confirmation, and a slot that just filled up', fields: consented, run: async (c) => {
    await post(envelope(ibtn(c.phone, `promo_${F.pSvc._id}`, 'Book Now! 📅')));
    await post(envelope(lrow(c.phone, `slot_${F.slotA2._id}`, '2030-01-16 · 10:00')));
    await stripeSucceeded();
    await post(envelope(lrow(c.phone, `slot_${F.slotAfull._id}`, 'Full slot')));
  } },
  { name: 'service points: slot pick shows the summary, YES books', fields: { ...consented, loyaltyPoints: 450 }, run: async (c) => {
    await post(envelope(ibtn(c.phone, `promo_${F.pSvcPoints._id}`, 'Book Now! 📅')));
    await post(envelope(lrow(c.phone, `slot_${F.slotA1._id}`, '2030-01-15 · 09:00')));
    await post(envelope(textMsg(c.phone, 'YES')));
  } },
  { name: 'opt-out / opt-in typed in Latin (the existing branches)', fields: consented, run: async (c) => {
    await post(envelope(textMsg(c.phone, 'STOP')));
    await post(envelope(textMsg(c.phone, 'START')));
    await post(envelope(textMsg(c.phone, 'start')));
  } },
  { name: 'opt-out button on a promotion', fields: consented, run: async (c) => {
    await post(envelope(ibtn(c.phone, `optout_${F.pPlain._id}`, 'Opt Out')));
  } },
  { name: 'cart / address edge replies: empty cart text, happy shopping', fields: consented, run: async (c) => {
    await post(envelope(ibtn(c.phone, 'shop_now', 'Shop Now! 🛍️')));
    await post(envelope(ibtn(c.phone, 'continue_shopping', 'Keep Browsing')));
  } },
];

// ── run + normalise ──────────────────────────────────────────────────────────
const recorded = {}; // name -> { en, ar }

async function runOne(sc, language) {
  const st = state();
  for (const m of Object.values(st)) if (m && typeof m.clear === 'function') m.clear();
  const c = await mkCustomer(`${sc.name.slice(0, 12)}-${language}`, language, sc.fields);
  await Q('TimeSlot').updateMany({ workspaceId: W, _id: { $in: [F.slotA1._id, F.slotA2._id] } }, { $set: { bookedCount: 0 } }); // every run sees the same availability
  calls = []; wamidSeq = 0;
  await sc.run(c);
  await quiet(); await sleep(300);
  return { customer: c, calls: calls.slice() };
}

function norm(rec) {
  const s = JSON.stringify(rec.calls)
    .split(rec.customer.phone).join('<P>').split(String(rec.customer._id)).join('<C>')
    .replace(/pi_stub_\d+/g, '<PI>').replace(/wamid\.STUB\d+/g, '<W>');
  return JSON.parse(s);
}

const messagesOf = (list) => list.filter((c) => /\/messages$/.test(c.url) && c.body && c.body.messaging_product === 'whatsapp');

// every customer-visible string of a payload, with its limit
function visible(p) {
  const out = [];
  if (p.type === 'text') { out.push({ kind: 'text', text: p.text.body, max: 4096 }); return out; }
  if (p.type !== 'interactive') return out;
  const it = p.interactive;
  if (it.header && it.header.text) out.push({ kind: 'header', text: it.header.text, max: 60 });
  if (it.body) out.push({ kind: 'body', text: it.body.text, max: 1024 });
  if (it.footer) out.push({ kind: 'footer', text: it.footer.text, max: 60 });
  if (it.type === 'button') it.action.buttons.forEach((b) => out.push({ kind: 'button', text: b.reply.title, max: 20 }));
  if (it.type === 'list') {
    out.push({ kind: 'listButton', text: it.action.button, max: 20 });
    it.action.sections.forEach((s) => { out.push({ kind: 'section', text: s.title, max: 24 }); s.rows.forEach((r) => { out.push({ kind: 'rowTitle', text: r.title, max: 24 }); if (r.description) out.push({ kind: 'rowDesc', text: r.description, max: 72 }); }); });
  }
  return out;
}
function stripText(p) {
  const c = JSON.parse(JSON.stringify(p));
  if (c.type === 'text') c.text.body = '<t>';
  if (c.type === 'interactive') {
    const it = c.interactive;
    if (it.header && it.header.text !== undefined) it.header.text = '<t>';
    if (it.body) it.body.text = '<t>';
    if (it.footer) it.footer.text = '<t>';
    if (it.action && it.action.buttons) it.action.buttons.forEach((b) => { b.reply.title = '<t>'; });
    if (it.action && it.action.button) it.action.button = '<t>';
    if (it.action && it.action.sections) it.action.sections.forEach((s) => { s.title = '<t>'; s.rows.forEach((r) => { r.title = '<t>'; if (r.description) r.description = '<t>'; }); });
  }
  return c;
}
const cp = (s) => Array.from(s).length;
const ARABIC_LETTER = /[\u{0621}-\u{064A}]/u;
const CHROME = /\b(Sorry|Checkout|Cart|Subtotal|Shipping|Total|Delivering|securely|added|Keep|Browsing|Browse|Redeem|Prices|Tap|Booked|Please|points|pts|OFF|was|worth|Choose|Options|View|Slots|Reply|STOP|START|unsubscribed|subscribed)\b/;
function withoutMerchantText(s) {
  let out = s.replace(/https?:\/\/\S+/g, ' ');
  for (const m of MERCHANT_STRINGS) out = out.split(m).join(' ');
  return out.replace(/\bBulk \d+\b/g, ' ');
}

// ══════════════════════════════════════════════════════════════════════════════
describe('journey replay: English customer (control) vs Arabic customer of the same flagged workspace', () => {
  test.each(J.map((sc) => [sc.name, sc]))('%s', async (name, sc) => {
    const en = await runOne(sc, 'en');
    const ar = await runOne(sc, 'ar');
    recorded[name] = { en, ar };
    const enCalls = messagesOf(norm(en)); const arCalls = messagesOf(norm(ar));
    expect(enCalls.length).toBeGreaterThan(0);

    // (a) same number / order of calls (all outbound calls, not just messages)
    expect(norm(ar).map((c) => `${c.method} ${c.url} ${(c.body && c.body.type) || ''}`)).toEqual(norm(en).map((c) => `${c.method} ${c.url} ${(c.body && c.body.type) || ''}`));
    // (b) identical structure once the customer-visible text is stripped
    expect(arCalls.map((c) => stripText(c.body))).toEqual(enCalls.map((c) => stripText(c.body)));

    let changed = 0;
    arCalls.forEach((arCall, i) => {
      const enVis = visible(enCalls[i].body); const arVis = visible(arCall.body);
      expect(arVis.map((v) => v.kind)).toEqual(enVis.map((v) => v.kind));
      arVis.forEach((v, j) => {
        // (d) limits
        expect([v.kind, cp(v.text) <= v.max, v.text]).toEqual([v.kind, true, v.text]);
        const same = v.text === enVis[j].text;
        if (!same) { changed += 1; expect([v.kind, ARABIC_LETTER.test(v.text), v.text]).toEqual([v.kind, true, v.text]); } // (c) a changed field is Arabic
        // (c) no English chrome survives in the Arabic run (merchant text is allowed to stay as the merchant typed it)
        const rest = withoutMerchantText(v.text);
        expect([v.kind, CHROME.test(rest), v.text]).toEqual([v.kind, false, v.text]);
      });
    });
    expect(changed).toBeGreaterThan(0);

    // the English customer got the English payloads (nothing Arabic)
    for (const c of enCalls) for (const v of visible(c.body)) expect([v.kind, ARABIC_LETTER.test(withoutMerchantText(v.text)), v.text]).toEqual([v.kind, false, v.text]);
  });
});

describe('names come from REVIEWED translations only', () => {
  test('reviewed Arabic names and the description are used; the draft-only scarf and unnamed items stay English', () => {
    const cash = recorded['cash journey: reviewed names (Blue Shirt, Red Hat) and the draft-only scarf'];
    expect(cash).toBeDefined();
    const arText = messagesOf(norm(cash.ar)).flatMap((c) => visible(c.body).map((v) => v.text)).join('\n');
    expect(arText).toContain('قبعة حمراء');
    expect(arText).toContain('Green Scarf'); // draft translation: never shown to a customer
    expect(arText).not.toContain('وشاح أخضر');
    const enText = messagesOf(norm(cash.en)).flatMap((c) => visible(c.body).map((v) => v.text)).join('\n');
    expect(enText).toContain('Red Hat');
    expect(enText).not.toContain('قبعة');
    const first = recorded['cash journey: promo tap, add, continue, add, checkout asks address, address, pay link, Stripe confirmation'];
    const firstAr = messagesOf(norm(first.ar)).flatMap((c) => visible(c.body).map((v) => v.text)).join('\n');
    expect(firstAr).toContain('قميص أزرق');
    expect(firstAr).toContain('قميص قطني مريح'); // the reviewed Arabic description replaces the English one
    expect(firstAr).not.toContain('Soft cotton shirt');
    expect(firstAr).toContain('Green Scarf');
    const variantsRun = recorded['variants: picker, variant chosen, base option, out-of-stock variant'];
    expect(messagesOf(norm(variantsRun.ar)).map((c) => JSON.stringify(c.body)).join('\n')).toContain('قميص أزرق');
    const svc = recorded['service: promo tap, slot list, slot pick, pay link + pay-later offer, reserve'];
    expect(messagesOf(norm(svc.ar)).map((c) => JSON.stringify(c.body)).join('\n')).toContain('جلسة مساج');
  });
  test('the pay link of an Arabic customer carries ?lang=ar, an English customer does not', () => {
    const run = recorded['cash journey: promo tap, add, continue, add, checkout asks address, address, pay link, Stripe confirmation'];
    const links = (rec) => messagesOf(norm(rec)).flatMap((c) => visible(c.body).map((v) => v.text)).join('\n').match(/http:\/\/localhost:3999\/pay\/\S+/g) || [];
    expect(links(run.ar).length).toBeGreaterThan(0);
    links(run.ar).forEach((l) => expect(l).toMatch(/\?lang=ar$/));
    links(run.en).forEach((l) => expect(l).not.toMatch(/lang=/));
  });
  test('consent carrier: the Arabic confirmation carries the Arabic consent ask and Arabic buttons', () => {
    const run = recorded['consent ask rides on the confirmation (customer not yet asked), then taps yes'];
    const carriers = messagesOf(norm(run.ar)).filter((c) => c.body.type === 'interactive' && /^consent_yes_/.test(((c.body.interactive.action || {}).buttons || [])[0] ? c.body.interactive.action.buttons[0].reply.id : ''));
    expect(carriers.length).toBeGreaterThan(0);
    const b = carriers[0].body.interactive;
    expect(b.action.buttons.map((x) => x.reply.title)).toEqual([catalog().t('ar', 'consent.buttonOptIn'), catalog().t('ar', 'consent.buttonDecline')]);
    expect(b.body.text).toContain(catalog().t('ar', 'consent.askSuffix'));
  });
  test('opt-out / opt-in replies to the Arabic customer are the Arabic catalogue strings', () => {
    const run = recorded['opt-out / opt-in typed in Latin (the existing branches)'];
    const texts = messagesOf(norm(run.ar)).map((c) => c.body.text && c.body.text.body);
    expect(texts).toContain(catalog().t('ar', 'consent.optOutAck'));
    expect(texts).toContain(catalog().t('ar', 'consent.startAck'));
    const enTexts = messagesOf(norm(run.en)).map((c) => c.body.text && c.body.text.body);
    expect(enTexts).toContain(catalog().t('en', 'consent.optOutAck'));
  });
});

describe('English payloads byte for byte: kill switch, flag off', () => {
  const pick = [J[0], J[2], J[5], J[8], J[11]];
  const enCalls = {};
  test('control: the English runs of the picked scenarios', () => {
    for (const sc of pick) { expect(recorded[sc.name]).toBeDefined(); enCalls[sc.name] = JSON.stringify(norm(recorded[sc.name].en)); }
  });
  test.each(pick.map((sc) => [sc.name, sc]))('LOCALIZATION_DISABLED=1: an Arabic customer gets exactly the English calls - %s', async (name, sc) => {
    process.env.LOCALIZATION_DISABLED = '1';
    try {
      const ar = await runOne(sc, 'ar');
      expect(JSON.stringify(norm(ar))).toBe(JSON.stringify(norm(recorded[name].en)));
    } finally { delete process.env.LOCALIZATION_DISABLED; }
  });
  test.each(pick.slice(0, 3).map((sc) => [sc.name, sc]))('flag turned off for the workspace: an Arabic customer gets exactly the English calls - %s', async (name, sc) => {
    const settings = require('../../../shared/localization/settings');
    await settings.setArabicEnabled({ workspaceId: W, enabled: false, grantedBy: 'itest' });
    try {
      const ar = await runOne(sc, 'ar');
      expect(JSON.stringify(norm(ar))).toBe(JSON.stringify(norm(recorded[name].en)));
    } finally { await settings.setArabicEnabled({ workspaceId: W, enabled: true, grantedBy: 'itest' }); }
  });
  test('flag back on: Arabic again (the snapshot follows the admin action)', async () => {
    const ar = await runOne(J[11], 'ar');
    const texts = messagesOf(norm(ar)).map((c) => c.body.text && c.body.text.body);
    expect(texts).toContain(catalog().t('ar', 'consent.optOutAck'));
  });
});

describe('DRIFT TEST: every English journey message is a catalogued shape (or explicitly allow-listed)', () => {
  // Messages that are intentionally NOT localised by this mechanism (each with its reason). Keep this list short and honest.
  const ALLOW = [
    // (none expected from the webhook journey: merchant text, first-contact sends and node follow-ups are not part of these scenarios)
  ];
  const matcher = createMatcher(entriesFromCatalog(catalog()));
  const ctx = { names: { name: (k, raw) => raw, byId: () => null, description: (k, n, d) => d }, payUrl: (u) => u };
  test('all recorded English payloads match a shape', () => {
    const unmatched = [];
    let total = 0;
    for (const [name, rec] of Object.entries(recorded)) {
      for (const c of messagesOf(norm(rec.en))) {
        if (c.body.type !== 'text' && c.body.type !== 'interactive') continue;
        total += 1;
        if (matcher.localize(c.body, ctx)) continue;
        if (ALLOW.some((fn) => fn(c.body))) continue;
        unmatched.push(`${name}: ${JSON.stringify(c.body).slice(0, 300)}`);
      }
    }
    expect(total).toBeGreaterThan(60);
    expect(unmatched).toEqual([]);
  });
});
