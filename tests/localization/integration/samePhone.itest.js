'use strict';
// H1 (approved global change #2) against a REAL MongoDB: a STOP / opt-out opts out EVERY record of the same workspace with
// the same normalised phone. Part A drives shared/localization/samePhone.js with the real models and the real consent
// functions; part B drives the three existing opt-out branches of server.js (typed STOP, template "optout_" quick reply,
// interactive "optout_" button) and the Arabic inbound hook through the real webhook, axios stubbed (nothing leaves the machine).
// Always a FRESH database name per run.
const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();

const request = require('supertest');
const axios = require('axios');
const mongoose = require('mongoose');

jest.mock('stripe', () => () => ({ paymentIntents: { create: async () => ({ id: 'pi_stub_1' }) }, webhooks: { constructEvent: () => { throw new Error('stub'); } } }));
jest.setTimeout(300000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Q = (m) => require(`../../../models/${m}`);

let calls = []; let wamidSeq = 0;
axios.defaults.adapter = async (config) => {
  let body = config.data;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep */ } }
  calls.push({ method: String(config.method || '').toUpperCase(), url: String(config.url || ''), body: body === undefined ? null : body });
  const isMsg = /\/messages$/.test(String(config.url || ''));
  const data = isMsg ? { messaging_product: 'whatsapp', messages: [{ id: `wamid.STUB${++wamidSeq}` }] } : { id: `stub${++wamidSeq}` };
  return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};

let app; let W; let msgSeq = 0; let seq = 0;
const msgBase = (from) => ({ from, id: `wamid.SP${++msgSeq}`, timestamp: '1760000000' });
const envelope = (message) => ({ object: 'whatsapp_business_account', entry: [{ id: '2', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '1' }, contacts: [{ profile: { name: 'Layla Tester' }, wa_id: message.from }], messages: [message] } }] }] });
const textMsg = (from, body) => ({ ...msgBase(from), type: 'text', text: { body } });
const tplBtn = (from, payload, text) => ({ ...msgBase(from), type: 'button', button: { payload, text } });
const ibtn = (from, id, title) => ({ ...msgBase(from), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
async function quiet() { await sleep(300); let last = -1; let stable = 0; for (let i = 0; i < 60 && stable < 3; i += 1) { if (calls.length === last) stable += 1; else { stable = 0; last = calls.length; } await sleep(100); } }
async function post(payload) { await request(app).post('/webhook').send(payload); await quiet(); }

const digitsOf = () => { seq += 1; return `96650${String(7000000 + seq * 13 + (Date.now() % 1000))}`.slice(0, 12); };
const consented = { marketingConsent: true, marketingConsentAt: new Date(), marketingConsentMethod: 'manual_staff_entry' };
const mk = (ws, phone, extra) => Q('Customer').create({ firstname: 'Layla', lastname: 'T', phone, workspaceId: ws, ...consented, ...(extra || {}) });
const events = (customerId) => Q('ConsentEvent').find({ customerId }).sort({ createdAt: 1 }).lean();
const reload = (c) => Q('Customer').findById(c._id).lean();

beforeAll(async () => {
  process.env.WA_TOKEN = process.env.WA_TOKEN || 'dummy';
  process.env.APP_URL = 'http://localhost:3999';
  process.env.LOCALIZATION_SEND_MODE = 'live_stubbed'; // the Arabic hook replies via transport.js: 'dry_run' would swallow them; axios is stubbed above
  jest.spyOn(console, 'log').mockImplementation(() => {});
  app = require('../../../server');
  await new Promise((resolve, reject) => { const t0 = Date.now(); const poll = () => (mongoose.connection.readyState === 1 ? resolve() : (Date.now() - t0 > 20000 ? reject(new Error('mongo not connected')) : setTimeout(poll, 100))); poll(); });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init().catch(() => {})));
  const db = mongoose.connection.db;
  if ((await db.collection('customers').countDocuments()) || (await db.collection('workspaces').countDocuments())) throw new Error('database is not fresh: use a new --db name for every run of samePhone.itest.js');
  W = (await Q('Workspace').create({ name: 'Same Phone Fixture (oldest = webhook workspace)' }))._id;
  await Q('Settings').create({ workspaceId: W, currency: 'SAR', merchantName: 'Same Phone Shop' });
});
afterAll(async () => { jest.restoreAllMocks(); });

describe('A. optOutSamePhone with the real models and the real consent functions', () => {
  const { optOutSamePhone } = require('../../../shared/localization/samePhone');
  const args = (from, over) => ({ workspaceId: W, from, method: 'whatsapp_stop_command', source: 'WhatsApp STOP reply', ...(over || {}) });

  test('every stored format of the number is opted out with its own ConsentEvent; the primary and other numbers are untouched', async () => {
    const d = digitsOf();
    const primary = await mk(W, d);
    const siblings = [await mk(W, `+${d}`), await mk(W, `00${d}`), await mk(W, `+${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`), await mk(W, `0${d.slice(3)}`), await mk(W, `(${d.slice(0, 3)}) ${d.slice(3)}`)];
    const arabicDigits = d.replace(/\d/g, (x) => String.fromCodePoint(0x0660 + Number(x)));
    siblings.push(await mk(W, arabicDigits));
    const other = await mk(W, digitsOf());
    const res = await optOutSamePhone(args(d, { exceptCustomerId: primary._id }));
    expect(res).toEqual({ matched: siblings.length, optedOut: siblings.length, failed: 0 });
    for (const s of siblings) {
      const row = await reload(s);
      expect(row.optedOut).toBe(true);
      expect(row.optedOutAt).toBeInstanceOf(Date);
      const ev = await events(s._id);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ type: 'consent_withdrawn', method: 'whatsapp_stop_command', source: 'WhatsApp STOP reply (same number, other customer record)' });
      expect(String(ev[0].workspaceId)).toBe(String(W));
    }
    expect((await reload(primary)).optedOut).toBeFalsy();
    expect(await events(primary._id)).toHaveLength(0);
    expect((await reload(other)).optedOut).toBeFalsy();
  });
  test('idempotent: a second STOP changes nothing and logs nothing', async () => {
    const d = digitsOf();
    const a = await mk(W, d); const b = await mk(W, `+${d}`);
    expect((await optOutSamePhone(args(d, { exceptCustomerId: a._id }))).optedOut).toBe(1);
    expect(await optOutSamePhone(args(d, { exceptCustomerId: a._id }))).toEqual({ matched: 0, optedOut: 0, failed: 0 });
    expect(await events(b._id)).toHaveLength(1);
  });
  test('other workspaces, erased records and non-matching numbers are never touched; demo records are included', async () => {
    const W2 = (await Q('Workspace').create({ name: 'Other tenant' }))._id;
    const d = digitsOf();
    const primary = await mk(W, d);
    const theirs = await mk(W2, `+${d}`);
    const erased = await mk(W, `+${d}`, { deletedAt: new Date(), deletionReason: 'erasure' });
    const demo = await mk(W, `00${d}`, { isDemo: true });
    const different = await mk(W, `${d.slice(0, -1)}${(Number(d.slice(-1)) + 1) % 10}`);
    const res = await optOutSamePhone(args(d, { exceptCustomerId: primary._id }));
    expect(res.optedOut).toBe(1);
    expect((await reload(theirs)).optedOut).toBeFalsy();
    expect((await reload(erased)).optedOut).toBeFalsy();
    expect((await reload(demo)).optedOut).toBe(true);
    expect((await reload(different)).optedOut).toBeFalsy();
    expect(await events(theirs._id)).toHaveLength(0);
  });
  test('no record for the exact phone (null primary): the stored "+" record is still opted out', async () => {
    const d = digitsOf();
    const stored = await mk(W, `+${d}`);
    expect(await optOutSamePhone(args(d, { exceptCustomerId: null }))).toEqual({ matched: 1, optedOut: 1, failed: 0 });
    expect((await reload(stored)).optedOut).toBe(true);
  });
  test('a legacy record that cannot pass validation (no last name) is still opted out, with its event logged first', async () => {
    const d = digitsOf();
    const primary = await mk(W, d);
    const legacyId = new mongoose.Types.ObjectId();
    await Q('Customer').collection.insertOne({ _id: legacyId, workspaceId: W, firstname: 'Legacy', phone: `+${d}`, optedOut: false, marketingConsent: true, createdAt: new Date(), updatedAt: new Date() });
    const res = await optOutSamePhone(args(d, { exceptCustomerId: primary._id }));
    expect(res).toEqual({ matched: 1, optedOut: 1, failed: 0 });
    expect((await Q('Customer').collection.findOne({ _id: legacyId })).optedOut).toBe(true);
    expect(await events(legacyId)).toHaveLength(1);
  });
  test('a workspace default country code makes a local number match its international twin', async () => {
    const W3 = (await Q('Workspace').create({ name: 'AU tenant' }))._id;
    await Q('Settings').create({ workspaceId: W3, currency: 'AUD', defaultCountryCode: '61' });
    const primary = await mk(W3, '61412345678'); const local = await mk(W3, '0412345678'); const saudi = await mk(W3, '966501234567');
    await optOutSamePhone({ workspaceId: W3, from: '61412345678', exceptCustomerId: primary._id, method: 'whatsapp_stop_command', source: 'x' });
    expect((await reload(local)).optedOut).toBe(true);
    expect((await reload(saudi)).optedOut).toBeFalsy();
  });
});

describe('A2. cost control (review R4-1): exact spellings first, bounded fallback scan, 60 s cooldown', () => {
  const { optOutSamePhone, _resetForTests } = require('../../../shared/localization/samePhone');
  const args = (from, over) => ({ workspaceId: W, from, method: 'whatsapp_stop_command', source: 'WhatsApp STOP reply', ...(over || {}) });
  test('a repeated STOP within 60 s still sweeps every exact spelling (incl. national forms) but does not rescan the workspace for odd spellings', async () => {
    _resetForTests();
    const d = digitsOf();
    const primary = await mk(W, d);
    const spaced1 = await mk(W, `+${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`);
    const first = await optOutSamePhone(args(d, { exceptCustomerId: primary._id }));
    expect(first).toEqual({ matched: 1, optedOut: 1, failed: 0 }); // found by the fallback scan
    expect((await reload(spaced1)).optedOut).toBe(true);
    // new records appear (an import) and the number is STOPped again 1 s later
    const plus = await mk(W, `+${d}`); const local = await mk(W, `0${d.slice(3)}`); const bare = await mk(W, d.slice(3));
    const spaced2 = await mk(W, `${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`);
    const second = await optOutSamePhone(args(d, { exceptCustomerId: primary._id }));
    expect(second).toEqual({ matched: 3, optedOut: 3, failed: 0 });
    for (const c of [plus, local, bare]) expect((await reload(c)).optedOut).toBe(true);
    expect((await reload(spaced2)).optedOut).toBeFalsy(); // cooldown: the odd spelling waits for the next scan window
    _resetForTests();
    expect((await optOutSamePhone(args(d, { exceptCustomerId: primary._id }))).optedOut).toBe(1);
    expect((await reload(spaced2)).optedOut).toBe(true);
  });
});

describe('B. through the real webhook (server.js branches + the Arabic hook)', () => {
  const reply = (phone) => calls.filter((c) => /\/messages$/.test(c.url) && c.body && c.body.to === phone && c.body.type === 'text').map((c) => c.body.text.body);
  const catalog = require('../../../shared/localization/catalog');
  beforeEach(() => { calls = []; for (const m of Object.values(require('../../../utils/state'))) if (m && typeof m.clear === 'function') m.clear(); });

  test('typed STOP: the sender record AND the "+" duplicate are opted out, the English reply is unchanged', async () => {
    const d = digitsOf();
    const primary = await mk(W, d); const dup = await mk(W, `+${d}`); const other = await mk(W, digitsOf());
    await post(envelope(textMsg(d, 'STOP')));
    expect((await reload(primary)).optedOut).toBe(true);
    expect((await reload(dup)).optedOut).toBe(true);
    expect((await reload(other)).optedOut).toBeFalsy();
    expect((await events(dup._id)).map((e) => [e.type, e.method])).toEqual([['consent_withdrawn', 'whatsapp_stop_command']]);
    expect(reply(d)).toEqual([catalog.t('en', 'consent.optOutAck')]);
  });
  test('STOP from a number stored ONLY as "+..." (no exact match): the record is opted out and the reply still goes out', async () => {
    const d = digitsOf();
    const only = await mk(W, `+${d}`);
    await post(envelope(textMsg(d, 'unsubscribe')));
    expect((await reload(only)).optedOut).toBe(true);
    expect(reply(d)).toEqual([catalog.t('en', 'consent.optOutAck')]);
  });
  test('template "optout_" quick reply sweeps the duplicates', async () => {
    const d = digitsOf();
    const primary = await mk(W, d); const dup = await mk(W, `00${d}`);
    const promoId = new mongoose.Types.ObjectId();
    await post(envelope(tplBtn(d, `optout_${promoId}`, 'Opt Out')));
    expect((await reload(primary)).optedOut).toBe(true);
    expect((await reload(dup)).optedOut).toBe(true);
    expect((await events(dup._id))[0]).toMatchObject({ method: 'whatsapp_optout_button' });
    expect((await events(dup._id))[0].source).toContain(`Opt Out button on promotion ${promoId}`);
  });
  test('interactive "optout_" button sweeps the duplicates, also when the sender has no record of its own spelling', async () => {
    const d = digitsOf();
    const dup = await mk(W, `+${d}`);
    await post(envelope(ibtn(d, `optout_${new mongoose.Types.ObjectId()}`, 'Opt Out')));
    expect((await reload(dup)).optedOut).toBe(true);
  });
  test('Arabic typed STOP (the localisation hook) sweeps the duplicates and replies in Arabic', async () => {
    const d = digitsOf();
    const primary = await mk(W, d); const dup = await mk(W, `+${d}`);
    await require('../../../shared/localization/settings').setArabicEnabled({ workspaceId: W, enabled: true, grantedBy: 'itest' });
    await post(envelope(textMsg(d, 'توقف')));
    expect((await reload(primary)).optedOut).toBe(true);
    expect((await reload(dup)).optedOut).toBe(true);
    expect(reply(d)).toEqual([catalog.t('ar', 'consent.optOutAck')]);
  });
  test('START reinstates ONLY the record the sender phone resolves to; the sibling stays opted out (restrictive default)', async () => {
    const d = digitsOf();
    const primary = await mk(W, d); const dup = await mk(W, `+${d}`);
    await post(envelope(textMsg(d, 'STOP')));
    await post(envelope(textMsg(d, 'START')));
    expect((await reload(primary)).optedOut).toBe(false);
    expect((await reload(dup)).optedOut).toBe(true);
  });
  test('a different workspace with the same number is never touched by the webhook sweep', async () => {
    const W2 = (await Q('Workspace').create({ name: 'Another tenant' }))._id;
    const d = digitsOf();
    const mine = await mk(W, d); const theirs = await mk(W2, `+${d}`);
    await post(envelope(textMsg(d, 'STOP')));
    expect((await reload(mine)).optedOut).toBe(true);
    expect((await reload(theirs)).optedOut).toBeFalsy();
  });
});
