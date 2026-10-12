'use strict';
// CHARACTERISATION TEST: English (and non-text) WhatsApp webhook behaviour must be identical
// with and without the Arabic-localisation hooks in server.js.
//
// It boots the real server.js against the THROWAWAY mongod, POSTs realistic Meta webhook
// payloads, and records (a) every outbound WhatsApp/Graph call (axios adapter stub - nothing
// leaves the machine) and (b) the whole database state after every scenario, normalised
// (ids -> stable labels, dates -> <date>). It must run UNCHANGED on the pristine baseline
// backend and on the modified one:
//
//   ENG_RECORD=1  run on the BASELINE copy  -> writes englishUnchanged.golden.json
//   (default)     run on the MODIFIED copy  -> asserts the same outcomes as the golden
//
// Modes (env), all against the same golden:
//   ENG_FLAG=on             LocaleSettings.arabicEnabled=true for the workspace + an Arabic-language
//                           bystander customer (CustomerLanguage 'ar'); needs the modified code.
//   LOCALIZATION_DISABLED=1 the operational kill switch.
//   (neither)               flag off: NO document may be written to any new localisation collection.
//
// Always run with a FRESH database name (the test refuses a non-empty database), e.g.
//   node run-itest-target.mjs --target after --db waflow_loc_testeng_off1 -- tests/localization/integration/englishUnchanged.itest.js
const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const axios = require('axios');
const mongoose = require('mongoose');

// Stripe is only reached by the (existing) checkout flow; stub it so the cash-address path is
// deterministic and never needs the network.
let mockPiCounter = 0;
jest.mock('stripe', () => () => ({
  paymentIntents: { create: async () => ({ id: `pi_stub_${++mockPiCounter}` }) },
  webhooks: { constructEvent: () => { throw new Error('stub'); } },
}));

jest.setTimeout(60000);

const RECORD = process.env.ENG_RECORD === '1';
const FLAG_ON = process.env.ENG_FLAG === 'on';
const KILL = process.env.LOCALIZATION_DISABLED === '1' || process.env.LOCALIZATION_DISABLED === 'true';
const GOLDEN_FILE = process.env.ENG_GOLDEN_FILE || path.join(require('os').tmpdir(), 'englishUnchanged.golden.json'); // golden is large: kept OUT of the repo (set ENG_GOLDEN_FILE)
const NEW_COLLECTION_RE = /^(customerlanguages|localesettings|localizedcampaigns|localizedsends|localizedtemplates|localizationadminlogs|producttranslations|userlocalepreferences|localized)/i;

// ── outbound WhatsApp: record + canned replies ──────────────────────────────
let calls = [];
let wamidSeq = 0;
axios.defaults.adapter = async (config) => {
  let body = config.data;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep string */ } }
  calls.push({ method: String(config.method || '').toUpperCase(), url: String(config.url || ''), body: body === undefined ? null : body });
  const isMsg = /\/messages$/.test(String(config.url || ''));
  let data;
  if (String(config.method).toLowerCase() === 'get') data = config.responseType === 'arraybuffer' ? Buffer.from('x') : { data: [] };
  else if (isMsg) data = { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.STUB${++wamidSeq}` }] };
  else data = { id: `stub${++wamidSeq}` };
  return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};

// ── helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app;
let W; // workspace id
let msgSeq = 0;
let phoneSeq = 0;
const state = () => require('../../../utils/state');

function envelope(message, contactName) {
  return { object: 'whatsapp_business_account', entry: [{ id: '222222222222222', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '111111111111111' },
    contacts: [{ profile: { name: contactName || 'Test Contact' }, wa_id: message.from }],
    messages: [message],
  } }] }] };
}
const msgBase = (from) => ({ from, id: `wamid.IN${++msgSeq}`, timestamp: '1760000000' });
const textMsg = (from, body) => ({ ...msgBase(from), type: 'text', text: { body } });
const tplBtn = (from, payload, text, ctxId) => ({ ...msgBase(from), type: 'button', button: { payload, text: text || 'Button' }, ...(ctxId ? { context: { from: '15550000000', id: ctxId } } : {}) });
const ibtn = (from, id, title, ctxId) => ({ ...msgBase(from), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: title || 'Button' } }, ...(ctxId ? { context: { from: '15550000000', id: ctxId } } : {}) });
const statusPayload = (statuses) => ({ object: 'whatsapp_business_account', entry: [{ id: '222222222222222', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '111111111111111' }, statuses } }] }] });

// ── snapshot + normalisation ─────────────────────────────────────────────────
async function rawSnapshot() {
  const db = mongoose.connection.db;
  const out = {};
  const cols = (await db.listCollections().toArray()).map((c) => c.name).filter((n) => !NEW_COLLECTION_RE.test(n) && !n.startsWith('system.')).sort();
  for (const n of cols) out[n] = await db.collection(n).find({}).sort({ _id: 1 }).toArray();
  return out;
}

function buildIdMap(snap) {
  const map = new Map();
  for (const [coll, docs] of Object.entries(snap)) {
    docs.forEach((d, i) => {
      const label = coll === 'customers' && d.phone ? `customers:${d.phone}` : `${coll}#${i}`;
      map.set(String(d._id), label);
    });
  }
  return map;
}

function norm(value, idMap) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return '<date>';
  if (Buffer.isBuffer(value)) return '<buffer>';
  if (value && value._bsontype === 'ObjectId') return idMap.get(String(value)) || '<oid>';
  if (Array.isArray(value)) return value.map((v) => norm(v, idMap));
  if (typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value).sort()) { if (k === '__v') continue; o[k] = norm(value[k], idMap); }
    return o;
  }
  if (typeof value === 'string') return value.replace(/[0-9a-f]{24}/gi, (m) => idMap.get(m) || '<oid>');
  return value;
}

function normSnapshot(snap, idMap) {
  const out = {};
  for (const [coll, docs] of Object.entries(snap)) {
    const arr = docs.map((d) => norm(d, idMap)).map((d) => JSON.stringify(d)).sort();
    if (arr.length) out[coll] = arr.map((s) => JSON.parse(s));
  }
  return out;
}

async function settle() {
  await sleep(350);
  let last = null; let stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    const fp = JSON.stringify([calls.length, (await rawSnapshot())]);
    if (fp === last) stable++; else { stable = 0; last = fp; }
    await sleep(120);
  }
}

// ── scenario runner ──────────────────────────────────────────────────────────
const customerIds = {}; // label -> id string
async function cust(label, fields) {
  phoneSeq += 1;
  const phone = `1555010${String(phoneSeq).padStart(4, '0')}`;
  const c = await require('../../../models/Customer').create({ firstname: label, lastname: 'Eng', phone, workspaceId: W, ...(fields || {}) });
  customerIds[label] = String(c._id);
  return c;
}

const results = {};
// The webhook answers 200 first and processes asynchronously, so two back-to-back POSTs race each
// other (STOP then START could be handled in either order). Wait until the outbound calls go quiet
// after every POST so the scenario order is deterministic on both copies of the backend.
async function quiet() {
  await sleep(300);
  let last = -1; let stable = 0;
  for (let i = 0; i < 50 && stable < 3; i++) { if (calls.length === last) stable++; else { stable = 0; last = calls.length; } await sleep(100); }
}
async function post(payload) { await request(app).post('/webhook').send(payload); await quiet(); }

function scenario(name, fn) {
  test(name, async () => {
    const st = state();
    for (const m of Object.values(st)) if (m && typeof m.clear === 'function') m.clear();
    calls = []; wamidSeq = 0; mockPiCounter = 0;
    const ctx = { cust, post, settle };
    await fn(ctx);
    await settle();
    const snap = await rawSnapshot();
    const idMap = buildIdMap(snap);
    const record = { calls: norm(calls, idMap).map((c) => ({ ...c, body: c.body })), db: normSnapshot(snap, idMap) };
    // wamid stubs are sequential per scenario (reset above) so they are deterministic
    results[name] = JSON.parse(JSON.stringify(record));
    if (!RECORD) {
      const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));
      expect(golden[name]).toBeDefined();
      expect(results[name].calls).toEqual(golden[name].calls);
      expect(results[name].db).toEqual(golden[name].db);
    }
  });
}

// ── fixtures ─────────────────────────────────────────────────────────────────
let svc; let slot; let products; let promo; let arabicBystander;
beforeAll(async () => {
  process.env.WA_TOKEN = process.env.WA_TOKEN || 'dummy';
  process.env.APP_URL = 'http://localhost:3999'; // appears in checkout links; identical on both copies
  app = require('../../../server');
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => (mongoose.connection.readyState === 1 ? resolve() : (Date.now() - t0 > 20000 ? reject(new Error('mongo not connected')) : setTimeout(poll, 100)));
    poll();
  });
  const nCustomers = await mongoose.connection.db.collection('customers').countDocuments();
  const nWorkspaces = await mongoose.connection.db.collection('workspaces').countDocuments();
  if (nCustomers || nWorkspaces) throw new Error('database is not fresh: use a new --db name for every run of englishUnchanged.itest.js');
  W = (await require('../../../models/Workspace').create({ name: 'English Unchanged Fixture' }))._id;
  svc = await require('../../../models/Service').create({ name: 'Massage', workspaceId: W, pointsPrice: 100 });
  slot = await require('../../../models/TimeSlot').create({ serviceId: svc._id, date: '2030-01-15', startTime: '09:00', endTime: '10:00', capacity: 2, workspaceId: W });
  products = [
    await require('../../../models/Product').create({ name: 'Blue Shirt', category: 'Shirts', basePrice: 25, workspaceId: W }),
    await require('../../../models/Product').create({ name: 'Red Hat', category: 'Hats', basePrice: 12, workspaceId: W }),
  ];
  promo = await require('../../../models/Promotion').create({ name: 'Summer Sale', scope: 'products', customerType: 'cash', products: products.map((p) => p._id), workspaceId: W });
  arabicBystander = await cust('ArabicBystander', { marketingConsent: true, marketingConsentAt: new Date(), marketingConsentMethod: 'manual_staff_entry' });
  if (FLAG_ON) {
    await require('../../../models/LocaleSettings').create({ workspaceId: W, arabicEnabled: true, arabicEnabledAt: new Date() });
    await require('../../../models/CustomerLanguage').create({ workspaceId: W, customerId: arabicBystander._id, language: 'ar', languageSource: 'merchant_set' });
  }
});

afterAll(async () => {
  if (RECORD) fs.writeFileSync(GOLDEN_FILE, JSON.stringify(results, null, 1));
});

const consented = { marketingConsent: true, marketingConsentAt: new Date(), marketingConsentMethod: 'manual_staff_entry' };

describe('English text with no pending state', () => {
  scenario('text/known customer chat', async ({ cust, post }) => { const c = await cust('Known', consented); await post(envelope(textMsg(c.phone, 'Hello, do you have any new offers this week?'))); });
  scenario('text/unknown number (Inbox creates a customer)', async ({ post }) => { await post(envelope(textMsg('15550999001', 'Hi, I saw your ad and want to know more about delivery'), 'New Lead')); });
  scenario('text/unknown number single word Hi', async ({ post }) => { await post(envelope(textMsg('15550999002', 'Hi'), 'Another Lead')); });
  scenario('text/english with the word cancel (no pending)', async ({ cust, post }) => { const c = await cust('Canceller', consented); await post(envelope(textMsg(c.phone, 'Please cancel my order, I changed my mind'))); });
  scenario('text/bare Cancel', async ({ cust, post }) => { const c = await cust('BareCancel', consented); await post(envelope(textMsg(c.phone, 'Cancel'))); });
  scenario('text/emoji and punctuation only', async ({ cust, post }) => { const c = await cust('Emoji', consented); await post(envelope(textMsg(c.phone, '👍'))); await post(envelope(textMsg(c.phone, '???'))); await post(envelope(textMsg(c.phone, 'Thanks! 🙏 See you soon'))); });
  scenario('text/digits and referral-style codes', async ({ cust, post }) => {
    const c = await cust('Codes', consented);
    await post(envelope(textMsg(c.phone, '12345')));
    await post(envelope(textMsg('15550999003', 'Hi! Code: IG-ABCD1234'), 'IG Lead'));
    await post(envelope(textMsg('15550999004', 'Hello, I would like to join. Code: 1A2B3C4D5E'), 'Ref Lead'));
  });
  scenario('text/empty and malformed bodies', async ({ cust, post }) => {
    const c = await cust('Malformed', consented);
    await post(envelope(textMsg(c.phone, '')));
    await post(envelope(textMsg(c.phone, '   ')));
    await post(envelope({ ...msgBase(c.phone), type: 'text' }));
  });
  scenario('text/english from an Arabic-language customer (plain Latin STOP and chat)', async ({ post }) => {
    await post(envelope(textMsg(arabicBystander.phone, 'Do you deliver to Riyadh on Fridays?')));
    await post(envelope(textMsg(arabicBystander.phone, 'STOP')));
    await post(envelope(textMsg(arabicBystander.phone, 'start')));
  });
});

describe('opt-out / opt-in keywords (English)', () => {
  scenario('stop/Stop mixed case', async ({ cust, post }) => { const c = await cust('StopMixed', consented); await post(envelope(textMsg(c.phone, 'Stop'))); });
  scenario('stop/padded STOP', async ({ cust, post }) => { const c = await cust('StopPadded', consented); await post(envelope(textMsg(c.phone, '  STOP  '))); });
  scenario('stop/unsubscribe lower case', async ({ cust, post }) => { const c = await cust('Unsub', consented); await post(envelope(textMsg(c.phone, 'unsubscribe'))); });
  scenario('stop/unknown number', async ({ post }) => { await post(envelope(textMsg('15550999010', 'STOP'), 'Stopper')); });
  scenario('stop/same wamid delivered twice', async ({ cust, post }) => { const c = await cust('StopTwice', consented); const m = textMsg(c.phone, 'STOP'); await post(envelope(m)); await post(envelope(m)); });
  scenario('stop/then START reinstates a prior consent', async ({ cust, post }) => { const c = await cust('StopStart', consented); await post(envelope(textMsg(c.phone, 'Stop'))); await post(envelope(textMsg(c.phone, 'START'))); });
  scenario('start/never consented, lower case', async ({ cust, post }) => { const c = await cust('StartNever'); await post(envelope(textMsg(c.phone, 'start'))); });
  scenario('start/subscribe keyword', async ({ cust, post }) => { const c = await cust('SubscribeKw', { ...consented, optedOut: true, optedOutAt: new Date() }); await post(envelope(textMsg(c.phone, 'Subscribe'))); });
  scenario('stop/while a points checkout is pending', async ({ cust, post }) => {
    const c = await cust('StopPending', { ...consented, loyaltyPoints: 500 });
    state().pendingPointsCheckouts.set(c.phone, { cart: [{ name: 'Widget', description: 'Gadgets' }], promotion: null, totalPointsCost: 50, address: '1 Test St', workspaceId: W, campaignMessageId: null });
    await post(envelope(textMsg(c.phone, 'STOP')));
    await post(envelope(textMsg(c.phone, 'yes')));
  });
});

describe('YES/NO replies in pending states', () => {
  const serviceState = (c, pts) => state().pendingServiceCheckouts.set(c.phone, { service: svc, slot, promotion: null, totalPointsCost: pts, workspaceId: W });
  const pointsState = (c, pts) => state().pendingPointsCheckouts.set(c.phone, { cart: [{ name: 'Widget', description: 'Gadgets' }], promotion: null, totalPointsCost: pts, address: '1 Test St, Sydney NSW 2000', workspaceId: W, campaignMessageId: null });

  scenario('service booking/YES with enough points', async ({ cust, post }) => { const c = await cust('SvcYes', { loyaltyPoints: 500 }); serviceState(c, 100); await post(envelope(textMsg(c.phone, 'YES'))); });
  scenario('service booking/lower-case yes padded, consented customer', async ({ cust, post }) => { const c = await cust('SvcYesLower', { ...consented, loyaltyPoints: 500 }); serviceState(c, 100); await post(envelope(textMsg(c.phone, '  yes '))); });
  scenario('service booking/YES insufficient points', async ({ cust, post }) => { const c = await cust('SvcPoor', { loyaltyPoints: 10 }); serviceState(c, 100); await post(envelope(textMsg(c.phone, 'Yes'))); });
  scenario('service booking/NO', async ({ cust, post }) => { const c = await cust('SvcNo', { loyaltyPoints: 500 }); serviceState(c, 100); await post(envelope(textMsg(c.phone, 'No'))); });
  scenario('service booking/unrelated text keeps waiting', async ({ cust, post }) => { const c = await cust('SvcMaybe', { loyaltyPoints: 500 }); serviceState(c, 100); await post(envelope(textMsg(c.phone, 'maybe later, can I cancel?'))); await post(envelope(textMsg(c.phone, 'yes'))); });
  scenario('points checkout/YES', async ({ cust, post }) => { const c = await cust('PtsYes', { loyaltyPoints: 500 }); pointsState(c, 50); await post(envelope(textMsg(c.phone, 'YES'))); });
  scenario('points checkout/yes consented customer', async ({ cust, post }) => { const c = await cust('PtsYesC', { ...consented, loyaltyPoints: 500 }); pointsState(c, 50); await post(envelope(textMsg(c.phone, 'yes'))); });
  scenario('points checkout/YES insufficient points', async ({ cust, post }) => { const c = await cust('PtsPoor', { loyaltyPoints: 5 }); pointsState(c, 50); await post(envelope(textMsg(c.phone, 'YES'))); });
  scenario('points checkout/NO', async ({ cust, post }) => { const c = await cust('PtsNo', { loyaltyPoints: 500 }); pointsState(c, 50); await post(envelope(textMsg(c.phone, 'NO'))); });
  scenario('points checkout/yes please is consumed and ignored', async ({ cust, post }) => { const c = await cust('PtsPlease', { loyaltyPoints: 500 }); pointsState(c, 50); await post(envelope(textMsg(c.phone, 'yes please'))); await post(envelope(textMsg(c.phone, 'I want to cancel this'))); });
});

describe('delivery address free text', () => {
  const cart = [{ name: 'Blue Shirt', priceAud: 25, description: 'Shirts', pointsCost: 100 }];
  scenario('address/cash checkout stores the text verbatim', async ({ cust, post }) => {
    const c = await cust('AddrCash', consented); state().carts.set(c.phone, cart); state().pendingAddressReqs.set(c.phone, 'cash');
    await post(envelope(textMsg(c.phone, 'Unit 4/55 Smith St, Parramatta NSW 2150')));
  });
  scenario('address/points checkout then YES', async ({ cust, post }) => {
    const c = await cust('AddrPts', { loyaltyPoints: 500 }); state().carts.set(c.phone, cart); state().pendingAddressReqs.set(c.phone, 'points');
    await post(envelope(textMsg(c.phone, '12 George Street, Sydney NSW 2000')));
    await settle();
    await post(envelope(textMsg(c.phone, 'YES')));
  });
  scenario('address/empty cart', async ({ cust, post }) => { const c = await cust('AddrEmpty', consented); state().pendingAddressReqs.set(c.phone, 'cash'); await post(envelope(textMsg(c.phone, '1 Some Road'))); });
  scenario('address/reply is the English word cancel', async ({ cust, post }) => {
    const c = await cust('AddrCancel', consented); state().carts.set(c.phone, cart); state().pendingAddressReqs.set(c.phone, 'cash');
    await post(envelope(textMsg(c.phone, 'cancel')));
  });
  scenario('address/reply is a Yes (still just an address)', async ({ cust, post }) => {
    const c = await cust('AddrYes', consented); state().carts.set(c.phone, cart); state().pendingAddressReqs.set(c.phone, 'cash');
    await post(envelope(textMsg(c.phone, 'Yes')));
  });
});

describe('catalogue text selection', () => {
  const setCatalog = (c) => state().pendingCatalogs.set(c.phone, { products: products.map((p) => p.toObject()), promotion: null, batchStart: 0, campaignMessageId: null });
  scenario('catalog/number selection', async ({ cust, post }) => { const c = await cust('CatNum', consented); setCatalog(c); await post(envelope(textMsg(c.phone, '1'))); });
  scenario('catalog/list of numbers', async ({ cust, post }) => { const c = await cust('CatList', consented); setCatalog(c); await post(envelope(textMsg(c.phone, '1, 2'))); });
  scenario('catalog/all', async ({ cust, post }) => { const c = await cust('CatAll', consented); setCatalog(c); await post(envelope(textMsg(c.phone, 'All'))); });
  scenario('catalog/chatter is ignored', async ({ cust, post }) => { const c = await cust('CatChat', consented); setCatalog(c); await post(envelope(textMsg(c.phone, 'do you have this in green? cancel the others'))); });
});

describe('pending consent ask', () => {
  scenario('consent ask pending/English chat', async ({ cust, post }) => { const c = await cust('AskChat', { marketingConsentAskedAt: new Date() }); await post(envelope(textMsg(c.phone, 'Thanks for the order, how long will delivery take?'))); });
  scenario('consent ask pending/Yes and No typed in English', async ({ cust, post }) => {
    const c = await cust('AskYesNo', { marketingConsentAskedAt: new Date() });
    await post(envelope(textMsg(c.phone, 'Yes'))); await post(envelope(textMsg(c.phone, 'No'))); await post(envelope(textMsg(c.phone, 'ok sure')));
  });
  scenario('consent ask pending/the word cancel', async ({ cust, post }) => { const c = await cust('AskCancel', { marketingConsentAskedAt: new Date() }); await post(envelope(textMsg(c.phone, 'cancel'))); await post(envelope(textMsg(c.phone, 'Please cancel my subscription'))); });
  scenario('consent ask pending/STOP', async ({ cust, post }) => { const c = await cust('AskStop', { marketingConsentAskedAt: new Date() }); await post(envelope(textMsg(c.phone, 'STOP'))); });
  scenario('consent ask pending/START', async ({ cust, post }) => { const c = await cust('AskStart', { marketingConsentAskedAt: new Date() }); await post(envelope(textMsg(c.phone, 'START'))); });
});

describe('button taps and callbacks', () => {
  let cmSeq = 0;
  const mkCm = async (c, extra) => require('../../../models/CampaignMessage').create({
    kind: 'promotion', promotion: promo._id, customer: c._id, phone: c.phone, wamid: `wamid.CM${++cmSeq}`, messageType: 'interactive',
    status: 'sent', sentAt: new Date(), workspaceId: W, ...(extra || {}),
  });
  scenario('tap/interactive consent_yes_', async ({ cust, post }) => { const c = await cust('TapYes', { marketingConsentAskedAt: new Date() }); await post(envelope(ibtn(c.phone, `consent_yes_${c._id}`, 'Yes, sign me up'))); });
  scenario('tap/interactive consent_no_', async ({ cust, post }) => { const c = await cust('TapNo', { marketingConsentAskedAt: new Date() }); await post(envelope(ibtn(c.phone, `consent_no_${c._id}`, 'No thanks'))); });
  scenario('tap/interactive optout_', async ({ cust, post }) => { const c = await cust('TapOptout', consented); await post(envelope(ibtn(c.phone, `optout_${promo._id}`, 'Opt Out'))); });
  scenario('tap/template consent_yes_ with click correlation', async ({ cust, post }) => {
    const c = await cust('TplYes', { marketingConsentAskedAt: new Date() }); const cm = await mkCm(c, { kind: 'consent_request', messageType: 'template' });
    await post(envelope(tplBtn(c.phone, `consent_yes_${c._id}`, 'Yes', cm.wamid)));
  });
  scenario('tap/template consent_no_', async ({ cust, post }) => { const c = await cust('TplNo', { marketingConsentAskedAt: new Date() }); await post(envelope(tplBtn(c.phone, `consent_no_${c._id}`, 'No'))); });
  scenario('tap/template optout_ resolves the latest send', async ({ cust, post }) => { const c = await cust('TplOptout', consented); await mkCm(c); await post(envelope(tplBtn(c.phone, `optout_${promo._id}`, 'Opt Out'))); });
  scenario('tap/consent_yes_ for an unknown id', async ({ cust, post }) => { const c = await cust('TapGhost'); await post(envelope(ibtn(c.phone, 'consent_yes_64b64b64b64b64b64b64b64b', 'Yes'))); });
  scenario('tap/interactive promo_ shows the catalogue', async ({ cust, post }) => { const c = await cust('PromoTap', consented); const cm = await mkCm(c); await post(envelope(ibtn(c.phone, `promo_${promo._id}`, 'Shop Now', cm.wamid))); });
  scenario('tap/template promo_', async ({ cust, post }) => { const c = await cust('PromoTplTap', consented); const cm = await mkCm(c, { messageType: 'template' }); await post(envelope(tplBtn(c.phone, `promo_${promo._id}`, 'Shop Now', cm.wamid))); });
  scenario('tap/promo_ then a catalogue number', async ({ cust, post }) => { const c = await cust('PromoThenNum', consented); await post(envelope(ibtn(c.phone, `promo_${promo._id}`, 'Shop Now'))); await settle(); await post(envelope(textMsg(c.phone, '2'))); });
  scenario('tap/checkout with an empty cart and continue_shopping', async ({ cust, post }) => {
    const c = await cust('Checkout', consented); await post(envelope(ibtn(c.phone, 'checkout', 'Checkout'))); await post(envelope(ibtn(c.phone, 'continue_shopping', 'Continue')));
  });
  scenario('tap/cart_ product add to cart', async ({ cust, post }) => { const c = await cust('CartTap', consented); await post(envelope(ibtn(c.phone, `cart_${products[0]._id}`, 'Add to Cart'))); });
  scenario('status/sent then delivered then read then stale delivered', async ({ cust, post }) => {
    const c = await cust('Status', consented); const cm = await mkCm(c);
    await post(statusPayload([{ id: cm.wamid, status: 'delivered', timestamp: '1760000100', recipient_id: c.phone }])); await settle();
    await post(statusPayload([{ id: cm.wamid, status: 'read', timestamp: '1760000200', recipient_id: c.phone }])); await settle();
    await post(statusPayload([{ id: cm.wamid, status: 'delivered', timestamp: '1760000300', recipient_id: c.phone }]));
  });
  scenario('status/failed with error and unknown wamid', async ({ cust, post }) => {
    const c = await cust('StatusFail', consented); const cm = await mkCm(c);
    await post(statusPayload([{ id: cm.wamid, status: 'failed', timestamp: '1760000100', recipient_id: c.phone, errors: [{ code: 131026, title: 'Message undeliverable' }] }, { id: 'wamid.NOPE', status: 'delivered', timestamp: '1760000100' }]));
  });
});

describe('other message types', () => {
  scenario('other/image, sticker, reaction, location, unsupported', async ({ cust, post }) => {
    const c = await cust('Other', consented);
    await post(envelope({ ...msgBase(c.phone), type: 'image', image: { id: 'media1', mime_type: 'image/jpeg', caption: 'my receipt' } }));
    await post(envelope({ ...msgBase(c.phone), type: 'sticker', sticker: { id: 'media2' } }));
    await post(envelope({ ...msgBase(c.phone), type: 'reaction', reaction: { message_id: 'wamid.X', emoji: '👍' } }));
    await post(envelope({ ...msgBase(c.phone), type: 'location', location: { latitude: 1, longitude: 2 } }));
    await post(envelope({ ...msgBase(c.phone), type: 'unsupported' }));
  });
  scenario('other/payload with no messages and no statuses', async ({ post }) => { await post({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {} }] }] }); await post({}); });
});

describe('new localisation collections', () => {
  test('writes nothing to any new collection unless the flag is on and not killed', async () => {
    const db = mongoose.connection.db;
    const names = (await db.listCollections().toArray()).map((c) => c.name).filter((n) => NEW_COLLECTION_RE.test(n));
    const counts = {};
    for (const n of names) counts[n] = await db.collection(n).countDocuments();
    // eslint-disable-next-line no-console
    console.log(`[englishUnchanged] mode flagOn=${FLAG_ON} kill=${KILL} record=${RECORD} new-collection counts:`, JSON.stringify(counts));
    const fixtureOnly = (n) => (n === 'localesettings' ? (FLAG_ON ? 1 : 0) : (n === 'customerlanguages' && FLAG_ON ? 1 : 0));
    for (const n of names) {
      if (FLAG_ON && !KILL) continue; // inference may legitimately write 'en' rows (checked below)
      expect({ [n]: counts[n] }).toEqual({ [n]: fixtureOnly(n) });
    }
    if (FLAG_ON) {
      const langs = await db.collection('customerlanguages').find({}).toArray();
      const customers = await db.collection('customers').find({}).toArray();
      const byId = Object.fromEntries(customers.map((c) => [String(c._id), c]));
      for (const l of langs) {
        if (String(l.customerId) === String(arabicBystander._id)) continue;
        expect(['en', 'unknown']).toContain(l.language); // an English customer is never labelled Arabic
        expect(byId[String(l.customerId)]).toBeDefined();
      }
      if (KILL) expect(langs.length).toBe(1); // kill switch: only the seeded bystander row
    }
  });
});
