'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_b1d_sig`; // this suite gets its OWN database
assertThrowawayDb();

// T-SIG-6 against the REAL server.js (hunks E1 + E3): the signature middleware reads the raw stream BEFORE
// express.json(); body-parser 2.x must then skip (no hang, no double parse), the legacy handler must see
// the payload intact and byte-identical, and with the flag off nothing changes. Two real apps are loaded:
// one booted with the flag ON (the onboarding hooks are mounted) and one booted with the flag UNSET.
// Dummy credentials only; the harness proxy is dead, so no real network.
const SECRET = 'APP_SECRET_FIXTURE_0123456789abcdef';
const PLATFORM_WABA = '5550001111';
const PLATFORM_PHONE = '5550002222';
process.env.ONBOARDING_FLOW = 'on';
process.env.WA_APP_SECRET = SECRET;
process.env.WA_WABA_ID = PLATFORM_WABA;
process.env.WA_PHONE_ID = PLATFORM_PHONE;
process.env.WA_TOKEN_ENCRYPTION_KEY = '23'.repeat(32);
delete process.env.ONBOARDING_WEBHOOK_SIGNATURE;
delete process.env.ONBOARDING_DROP_UNKNOWN_WABA;

const request = require('supertest');
const mongoose = require('mongoose');
const sig = require('../../../shared/onboarding/webhookSignature');
const wh = require('../../../shared/onboarding/webhookEvents');
const vault = require('../../../shared/onboarding/tokenVault');
const app = require('../../../server'); // flag ON at boot
const Conn = require('../../../models/WhatsAppConnection');
const Event = require('../../../models/OnboardingEvent');
const Inbound = require('../../../models/OnboardingInbound');
const Workspace = require('../../../models/Workspace');

let appOff; let mongooseOff;
const T = 1739321024;
const oid = () => String(new mongoose.Types.ObjectId());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await mongoose.connection.asPromise();
  await Promise.all([Conn.init(), Event.init(), Inbound.init()]);
  const createdAt = new Date('2026-01-01T00:00:00Z');
  await Workspace.collection.insertOne({ name: 'Owner workspace', createdAt, updatedAt: createdAt, onboarding: { completed: true, currentStep: 1 } });
  // the second app: booted with the flag UNSET (its own module registry and mongoose connection)
  const prev = process.env.ONBOARDING_FLOW;
  delete process.env.ONBOARDING_FLOW;
  jest.isolateModules(() => {
    mongooseOff = require('mongoose');
    appOff = require('../../../server');
  });
  process.env.ONBOARDING_FLOW = prev;
  await mongooseOff.connection.asPromise();
});
afterAll(async () => {
  await mongoose.disconnect();
  if (mongooseOff) await mongooseOff.disconnect();
});
beforeEach(() => { process.env.ONBOARDING_FLOW = 'on'; wh.clearMemo(); jest.spyOn(console, 'warn').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); });

const entry = (id, field, value, time = T) => ({ id, time, changes: [{ field, value }] });
const message = (phone, text) => ({ from: phone, id: `wamid.${phone}`, timestamp: '1739321024', type: 'text', text: { body: text } });
const platformMessage = (phone, text = 'مرحبا TSIG6 👋 hello') => entry(PLATFORM_WABA, 'messages', {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '15550783881', phone_number_id: PLATFORM_PHONE }, contacts: [{ profile: { name: 'Layla' }, wa_id: phone }], messages: [message(phone, text)],
});
const payload = (...entries) => ({ object: 'whatsapp_business_account', entry: entries });

/** POST the raw JSON; returns the response and the line the LEGACY handler logged for that message (if it ran). */
async function post(target, body, { signature = 'valid', phone, secret = SECRET } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const lines = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a); });
  const parse = jest.spyOn(JSON, 'parse');
  try {
    const req = request(target).post('/webhook').set('Content-Type', 'application/json');
    if (signature === 'valid') req.set('X-Hub-Signature-256', sig.computeSignature(raw, secret));
    else if (signature === 'wrong') req.set('X-Hub-Signature-256', sig.computeSignature(raw, 'wrong-secret'));
    const res = await Promise.race([req.send(raw), wait(5000).then(() => { throw new Error('request hung'); })]);
    let logged = null;
    if (phone) { for (let i = 0; i < 40 && !logged; i += 1) { logged = lines.find((l) => String(l[0]) === `Incoming from ${phone}:`) || null; if (!logged) await wait(25); } }
    return { res, logged: logged && logged[1], parses: parse.mock.calls.filter((c) => c[0] === raw).length };
  } finally { spy.mockRestore(); parse.mockRestore(); }
}

/** Meta ids are numeric strings (the webhook only looks up digit-only ids of 5 to 30 characters): unique per merchant of this run. */
let idSeq = 0;
function digitIds() {
  idSeq += 1;
  const n = String(Date.now()).slice(-9) + String(idSeq).padStart(3, '0');
  return { wabaId: `77${n}1`, phoneId: `77${n}2` };
}

async function merchant(over = {}) {
  const ws = oid();
  const { wabaId, phoneId } = digitIds();
  await Conn.create({
    workspaceId: ws, status: 'connected', ids: { wabaId, phoneNumberId: phoneId },
    tokenEncrypted: vault.encrypt('EAAFmerchantTOKEN_0123456789_abcdefghijklmnopqrstuvwxyz', { workspaceId: ws, purpose: 'token' }),
    webhook: { subscribed: true }, nextCheckAt: new Date('2027-01-01T00:00:00Z'), connectedAt: new Date('2026-10-01T00:00:00Z'), ...over,
  });
  return { ws, wabaId, phoneId, row: () => Conn.findOne({ workspaceId: ws }).lean() };
}
async function until(fn, ms = 3000) {
  for (let i = 0; i < ms / 25; i += 1) { const v = await fn(); if (v) return v; await wait(25); }
  return false;
}

describe('the real app boots with both hooks (sanity)', () => {
  test('GET / answers on both apps', async () => {
    expect((await request(app).get('/')).text).toBe('Waflow backend running');
    expect((await request(appOff).get('/')).text).toBe('Waflow backend running');
  });
});

describe('T-SIG-6: a valid signature leaves req.body intact; no hang, no double parse', () => {
  test('flag ON + valid signature: the legacy handler gets the exact message, the JSON is parsed exactly once', async () => {
    const phone = '966500010001';
    const body = payload(platformMessage(phone));
    const { res, logged, parses } = await post(app, body, { phone });
    expect(res.status).toBe(200);
    expect(logged).toBe(JSON.stringify(body.entry[0].changes[0].value.messages[0], null, 2));
    expect(logged).toContain('مرحبا TSIG6 👋 hello');
    expect(parses).toBe(1);
  });

  test('flag UNSET app: the same payload reaches the legacy handler untouched (express.json alone), also parsed once', async () => {
    delete process.env.ONBOARDING_FLOW;
    const phone = '966500010002';
    const body = payload(platformMessage(phone));
    const { res, logged, parses } = await post(appOff, body, { signature: 'none', phone });
    expect(res.status).toBe(200);
    expect(logged).toBe(JSON.stringify(body.entry[0].changes[0].value.messages[0], null, 2));
    expect(parses).toBe(1);
  });

  test('flag ON (valid signature) and flag OFF produce the byte-identical logged message for the same payload', async () => {
    const text = 'identical? مرحبا \u{1F44B}';
    const phoneA = '966500010003';
    const phoneB = '966500010003'; // same number: the logged text must be identical
    const body = payload(platformMessage(phoneA, text));
    const on = await post(app, body, { phone: phoneB });
    delete process.env.ONBOARDING_FLOW;
    const off = await post(appOff, body, { signature: 'none', phone: phoneB });
    expect(on.logged).toBeTruthy();
    expect(on.logged).toBe(off.logged);
  });

  test('a legacy platform payload is never rejected, whatever the signature: unsigned or wrong', async () => {
    for (const [signature, n] of [['none', 4], ['wrong', 5]]) {
      const phone = `96650001000${n}`;
      const body = payload(platformMessage(phone));
      const { res, logged } = await post(app, body, { signature, phone });
      expect(res.status).toBe(200);
      expect(logged).toBe(JSON.stringify(body.entry[0].changes[0].value.messages[0], null, 2));
    }
  });

  test('a payload with no entry id (every legacy test shape) passes in enforce mode and reaches the legacy handler', async () => {
    const phone = '966500010006';
    const body = { entry: [{ changes: [{ value: { metadata: { phone_number_id: PLATFORM_PHONE }, messages: [message(phone, 'no id here')] } }] }] };
    const { res, logged } = await post(app, body, { signature: 'none', phone });
    expect(res.status).toBe(200);
    expect(logged).toBe(JSON.stringify(body.entry[0].changes[0].value.messages[0], null, 2));
  });

  test('a large valid payload (about 1 MB) is read, verified and handed over without hanging', async () => {
    const phone = '966500010007';
    const big = platformMessage(phone, 'big');
    big.padding = 'x'.repeat(1024 * 1024);
    const { res, logged, parses } = await post(app, payload(big), { phone });
    expect(res.status).toBe(200);
    expect(logged).toBeTruthy();
    expect(parses).toBe(1);
  });

  test('malformed JSON with the flag on is a 400 (as express.json); with the flag off it is the same 400', async () => {
    const on = await post(app, '{"entry": [', { signature: 'none' });
    delete process.env.ONBOARDING_FLOW;
    const off = await post(appOff, '{"entry": [', { signature: 'none' });
    expect(on.res.status).toBe(400);
    expect(off.res.status).toBe(400);
  });
});

describe('merchant payloads through the real server', () => {
  test('unsigned or wrongly signed: 403, nothing processed; valid: 200 and processed', async () => {
    const m = await merchant();
    const body = payload(entry(m.wabaId, 'account_update', { event: 'PARTNER_REMOVED' }));
    expect((await post(app, body, { signature: 'none' })).res.status).toBe(403);
    expect((await post(app, body, { signature: 'wrong' })).res.status).toBe(403);
    await wait(100);
    expect((await m.row()).needsReconnect).toBeFalsy();
    expect((await post(app, body)).res.status).toBe(200);
    const row = await until(async () => { const r = await m.row(); return r.needsReconnect ? r : null; });
    expect(row).toMatchObject({ needsReconnect: true, reconnectReason: 'PARTNER_REMOVED', status: 'reconnect_required' });
    expect(await until(async () => (await Inbound.countDocuments({ workspaceId: m.ws, status: 'done' })) === 1)).toBe(true);
  });

  test('a merchant message never reaches the legacy handler (no oldest-workspace leak): it is counted and dropped', async () => {
    const m = await merchant();
    const phone = '966500020001';
    const body = payload(entry(m.wabaId, 'messages', { metadata: { phone_number_id: m.phoneId }, contacts: [{ profile: { name: 'Sara' }, wa_id: phone }], messages: [message(phone, 'merchant customer text')] }));
    const { res, logged } = await post(app, body, { phone });
    expect(res.status).toBe(200);
    expect(logged).toBeNull();
    const ev = await until(async () => (await Event.findOne({ workspaceId: m.ws, type: 'webhook_dropped' }).lean()));
    expect(ev).toMatchObject({ code: 'WEBHOOK_MESSAGES_DROPPED' });
    expect(JSON.stringify(await Event.find({ workspaceId: m.ws }).lean())).not.toContain('merchant customer text');
  });

  test('a mixed signed payload (merchant entry FIRST): the merchant entry is processed, the legacy handler gets the platform message as entry[0]', async () => {
    const m = await merchant();
    const phone = '966500020002';
    const body = payload(entry(m.wabaId, 'account_update', { event: 'ACCOUNT_VIOLATION' }), platformMessage(phone));
    const { res, logged } = await post(app, body, { phone });
    expect(res.status).toBe(200);
    expect(logged).toBe(JSON.stringify(body.entry[1].changes[0].value.messages[0], null, 2));
    const row = await until(async () => { const r = await m.row(); return r.status === 'needs_attention' ? r : null; });
    expect(row.health.issues).toEqual([{ entityType: 'WABA', code: 'ACCOUNT_VIOLATION' }]);
  });

  test('the same merchant payload on the flag-UNSET app is NOT intercepted: it behaves exactly like today (legacy handler, no onboarding write)', async () => {
    const m = await merchant();
    delete process.env.ONBOARDING_FLOW;
    const phone = '966500020003';
    const body = payload(entry(m.wabaId, 'messages', { metadata: { phone_number_id: m.phoneId }, messages: [message(phone, 'legacy path')] }));
    const { res, logged } = await post(appOff, body, { signature: 'none', phone });
    expect(res.status).toBe(200);
    expect(logged).toBe(JSON.stringify(body.entry[0].changes[0].value.messages[0], null, 2)); // the existing single-workspace behaviour
    expect(await Event.countDocuments({ workspaceId: m.ws })).toBe(0);
  });

  test('log mode: an unsigned merchant event is accepted as a hint (no state change) and the legacy handler is not involved', async () => {
    process.env.ONBOARDING_WEBHOOK_SIGNATURE = 'log';
    try {
      const m = await merchant();
      const body = payload(entry(m.wabaId, 'account_update', { event: 'PARTNER_REMOVED' }));
      const { res } = await post(app, body, { signature: 'none' });
      expect(res.status).toBe(200);
      await wait(150);
      const row = await m.row();
      expect(row.needsReconnect).toBeFalsy();
      expect(new Date(row.nextCheckAt).getTime()).toBeLessThan(Date.now() + 5000); // hint: the poller will read the truth
    } finally { delete process.env.ONBOARDING_WEBHOOK_SIGNATURE; }
  });
});

describe('ruling 1: only a POSITIVE merchant match with a bad signature is rejected (real server, real lookup)', () => {
  test('an UNKNOWN WABA (no merchant owns it, not the platform) with no or a wrong signature reaches the legacy handler untouched', async () => {
    for (const [signature, n] of [['none', 1], ['wrong', 2]]) {
      const phone = `96650003000${n}`;
      const body = payload(entry('777000111222', 'messages', {
        metadata: { phone_number_id: PLATFORM_PHONE }, contacts: [{ profile: { name: 'Layla' }, wa_id: phone }], messages: [message(phone, 'unknown waba ' + n)],
      }));
      const { res, logged } = await post(app, body, { signature, phone });
      expect(res.status).toBe(200);
      expect(logged).toBe(JSON.stringify(body.entry[0].changes[0].value.messages[0], null, 2));
    }
  });

  test('a mis-set WA_WABA_ID or WA_APP_SECRET cannot break the platform payload: it still reaches the legacy handler, byte-identical', async () => {
    const savedWaba = process.env.WA_WABA_ID;
    const savedSecret = process.env.WA_APP_SECRET;
    try {
      process.env.WA_WABA_ID = '999888777666'; // not the id Meta sends: the platform entry now looks like an unknown WABA
      const phoneA = '966500030003';
      const bodyA = payload(platformMessage(phoneA));
      const a = await post(app, bodyA, { signature: 'none', phone: phoneA });
      expect(a.res.status).toBe(200);
      expect(a.logged).toBe(JSON.stringify(bodyA.entry[0].changes[0].value.messages[0], null, 2));
      process.env.WA_WABA_ID = savedWaba;
      process.env.WA_APP_SECRET = 'definitely-not-the-meta-secret-0123456789';
      const phoneB = '966500030004';
      const bodyB = payload(platformMessage(phoneB));
      const b = await post(app, bodyB, { signature: 'valid', phone: phoneB, secret: SECRET }); // signed with the real secret: invalid for the server
      expect(b.res.status).toBe(200);
      expect(b.logged).toBe(JSON.stringify(bodyB.entry[0].changes[0].value.messages[0], null, 2));
    } finally {
      process.env.WA_WABA_ID = savedWaba;
      process.env.WA_APP_SECRET = savedSecret;
    }
  });

  test('a merchant payload (matched by its phone_number_id only) with a bad signature is a 403; with a good signature the handler runs with req.body intact and express.json does not hang', async () => {
    const m = await merchant();
    const body = payload(entry('555123000999', 'account_update', { event: 'PARTNER_REMOVED', metadata: { phone_number_id: m.phoneId } }));
    // the entry id is unknown, but the phone id inside the change belongs to the merchant connection
    body.entry[0].changes[0].value.metadata = { phone_number_id: m.phoneId };
    expect((await post(app, body, { signature: 'none' })).res.status).toBe(403);
    expect((await post(app, body, { signature: 'wrong' })).res.status).toBe(403);
    const ok = await post(app, body);
    expect(ok.res.status).toBe(200);
    expect(ok.parses).toBe(1);
    const row = await until(async () => { const r = await m.row(); return r.needsReconnect ? r : null; });
    expect(row).toMatchObject({ needsReconnect: true, reconnectReason: 'PARTNER_REMOVED' });
  });

  test('a mixed unsigned payload (platform entry + an unknown WABA entry) passes: nobody owns the unknown one', async () => {
    const phone = '966500030005';
    const body = payload(platformMessage(phone), entry('777000111333', 'account_update', { event: 'ACCOUNT_VIOLATION' }));
    const { res, logged } = await post(app, body, { signature: 'none', phone });
    expect(res.status).toBe(200);
    expect(logged).toBe(JSON.stringify(body.entry[0].changes[0].value.messages[0], null, 2));
  });

  test('log mode never rejects a merchant payload (no signature), enforce rejects it: same payload, both modes', async () => {
    const m = await merchant();
    const body = payload(entry(m.wabaId, 'account_update', { event: 'ACCOUNT_VIOLATION' }));
    expect((await post(app, body, { signature: 'none' })).res.status).toBe(403);
    process.env.ONBOARDING_WEBHOOK_SIGNATURE = 'log';
    try { expect((await post(app, body, { signature: 'none' })).res.status).toBe(200); } finally { delete process.env.ONBOARDING_WEBHOOK_SIGNATURE; }
  });
});

describe('Meta callbacks through the real server (mount.js at /onboarding-meta)', () => {
  const crypto = require('crypto');
  const signedRequest = (payload) => {
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}.${p}`;
  };
  const fbUser = () => `FB${Date.now()}${Math.floor(Math.random() * 1e6)}`;

  test('deauthorize: the connection of that Facebook user is flagged reconnect_required (DEAUTHORIZED); an unsigned or tampered request is a 400', async () => {
    const userId = fbUser();
    const m = await merchant();
    await Conn.updateOne({ workspaceId: m.ws }, { $set: { 'ids.metaUserId': userId } });
    const sr = signedRequest({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: userId });
    expect((await request(app).post('/onboarding-meta/deauthorize').type('form').send({ signed_request: `${sr}x` })).status).toBe(400);
    expect((await m.row()).needsReconnect).toBeFalsy();
    const res = await request(app).post('/onboarding-meta/deauthorize').type('form').send({ signed_request: sr });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await m.row()).toMatchObject({ needsReconnect: true, reconnectReason: 'DEAUTHORIZED', status: 'reconnect_required' });
  });

  test('data-deletion: a row is recorded (nothing deleted), the answer carries url + confirmation_code, and the status page reads it', async () => {
    const userId = fbUser();
    const m = await merchant();
    await Conn.updateOne({ workspaceId: m.ws }, { $set: { 'ids.metaUserId': userId } });
    const sr = signedRequest({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: userId });
    const res = await request(app).post('/onboarding-meta/data-deletion').type('form').send({ signed_request: sr });
    expect(res.status).toBe(200);
    expect(res.body.confirmation_code).toMatch(/^[a-f0-9]{24}$/);
    expect(res.body.url).toContain(`/onboarding-meta/deletion-status?code=${res.body.confirmation_code}`);
    const row = await Inbound.findById(`metacb:${res.body.confirmation_code}`).lean();
    expect(row).toMatchObject({ type: 'data_deletion', status: 'processing' });
    expect(String(row.workspaceId)).toBe(m.ws);
    expect(await Conn.countDocuments({ workspaceId: m.ws })).toBe(1); // nothing deleted
    const page = await request(app).get(`/onboarding-meta/deletion-status?code=${res.body.confirmation_code}`).set('Accept', 'text/html');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Status: received');
  });

  test('flag UNSET app: the callbacks answer exactly like unknown routes (404)', async () => {
    delete process.env.ONBOARDING_FLOW;
    const a = await request(appOff).post('/onboarding-meta/deauthorize').type('form').send({ signed_request: 'x' });
    const b = await request(appOff).post('/zzz-not-a-route/deauthorize').type('form').send({ signed_request: 'x' });
    expect(a.status).toBe(404);
    expect(a.status).toBe(b.status);
    expect(a.text.replace('/onboarding-meta/deauthorize', 'X')).toBe(b.text.replace('/zzz-not-a-route/deauthorize', 'X'));
  });
});

describe('amplification bounds of the public webhook (reviews R2-02 / R1-F1), real server and real database', () => {
  const compact = (i) => ({ id: String(880000000000 + i), time: 1, changes: [] }); // a Meta-shaped entry of ~45 bytes with an id nobody owns
  const bodyOf = (n, make = compact) => payload(...Array.from({ length: n }, (_, i) => make(i)));
  /** The lookups of merchant connections by an id of the payload (WABA or phone number id). */
  const spyLookups = () => {
    const spy = jest.spyOn(Conn, 'find');
    return {
      ids: () => spy.mock.calls.map((c) => c[0]).filter((f) => f && (f['ids.wabaId'] !== undefined || f['ids.phoneNumberId'] !== undefined))
        .map((f) => String(f['ids.wabaId'] !== undefined ? f['ids.wabaId'] : f['ids.phoneNumberId'])),
    };
  };

  test.each([500, 2000])('an UNSIGNED payload of %i entries (under 100 kB) causes at most 20 lookups, no ledger row, and is answered like any platform payload', async (n) => {
    const body = bodyOf(n);
    expect(JSON.stringify(body).length).toBeLessThan(100 * 1024);
    const lookups = spyLookups();
    const ledgerBefore = await Inbound.countDocuments({});
    const { res } = await post(app, body, { signature: 'none' });
    expect(res.status).toBe(200);
    const ids = lookups.ids();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(20);
    expect(new Set(ids).size).toBe(ids.length); // each id once
    expect(await Inbound.countDocuments({})).toBe(ledgerBefore);
  });

  test('a WRONG signature is as unsigned as none: the first 20 entries only, however large the (3 MB capped) body is', async () => {
    const body = bodyOf(3000);
    expect(JSON.stringify(body).length).toBeGreaterThan(100 * 1024); // allowed: a signature header is present
    const lookups = spyLookups();
    const { res } = await post(app, body, { signature: 'wrong' });
    expect(res.status).toBe(200);
    expect(lookups.ids().length).toBeLessThanOrEqual(20);
  });

  test('a merchant entry BEYOND the first 20 of an unsigned payload is never looked at, never processed and never claimed; the same entry FIRST is the 403 it always was', async () => {
    const m = await merchant();
    const junk = Array.from({ length: 24 }, (_, i) => compact(i));
    const theirs = entry(m.wabaId, 'account_update', { event: 'PARTNER_REMOVED' });
    const lookups = spyLookups();
    const far = await post(app, payload(...junk, theirs), { signature: 'none' });
    expect(far.res.status).toBe(200); // nothing in the examined slice is a merchant: it passes to the legacy handler exactly as before
    expect(lookups.ids()).not.toContain(m.wabaId);
    await wait(150);
    const row = await m.row();
    expect(row.needsReconnect).toBeFalsy();
    expect(new Date(row.nextCheckAt).getTime()).toBeGreaterThan(Date.now() + 86400000); // not even a hint
    expect(await Inbound.countDocuments({ workspaceId: m.ws })).toBe(0);
    const first = await post(app, payload(theirs, ...junk), { signature: 'none' });
    expect(first.res.status).toBe(403);
  });

  test('a VALID signature earns the 1,000-entry cap and every DISTINCT id is looked up exactly once (3,000 entries, 1,500 ids -> the first 1,000 entries = 500 ids)', async () => {
    const pairs = Array.from({ length: 3000 }, (_, i) => compact(Math.floor(i / 2) + 5000)); // each id twice in a row
    const body = payload(...pairs);
    expect(JSON.stringify(body).length).toBeGreaterThan(100 * 1024);
    const lookups = spyLookups();
    const { res } = await post(app, body); // valid signature
    expect(res.status).toBe(200); // hunk E3 answers 200 first and handles the entries afterwards: wait for the background work to finish
    expect(await until(async () => lookups.ids().length >= 500, 30000)).toBe(true);
    await wait(400);
    const ids = lookups.ids();
    expect(ids).toHaveLength(500);
    expect(new Set(ids).size).toBe(500);
    expect(ids).toContain(String(880000000000 + 5000));
    expect(ids).not.toContain(String(880000000000 + 5000 + 500)); // the 501st id lies beyond the 1,000th entry
  });

  test('an UNSIGNED body over 100 kB is left to the legacy parser, which answers exactly as it does with the flag off (413), with no lookup at all', async () => {
    const raw = JSON.stringify(bodyOf(10000));
    expect(raw.length).toBeGreaterThan(100 * 1024);
    const lookups = spyLookups();
    const on = await post(app, raw, { signature: 'none' });
    const off = await post(appOff, raw, { signature: 'none' });
    expect(on.res.status).toBe(413);
    expect(off.res.status).toBe(413);
    expect(on.res.text).toBe(off.res.text);
    expect(lookups.ids()).toHaveLength(0);
  });

  test('only digit-only ids of 5 to 30 characters are ever looked up (no regex or operator injection through the entry id)', async () => {
    const body = payload(
      entry('{"$ne":null}', 'account_update', {}), entry('abc12345', 'account_update', {}), entry('1234', 'account_update', {}), entry('9'.repeat(31), 'account_update', {}),
      entry('$where', 'account_update', {}), entry('1234567890', 'account_update', {}),
    );
    const lookups = spyLookups();
    const { res } = await post(app, body, { signature: 'none' });
    expect(res.status).toBe(200);
    expect(lookups.ids()).toEqual(['1234567890']);
  });
});

describe('R1-F2 on the real server: everything that is not conforming JSON is answered exactly as with the flag off', () => {
  const zlib = require('zlib');
  const meta = JSON.stringify(payload(platformMessage('966500040001', 'r1f2 platform text')));
  const firstLine = (text) => { const m = /<pre>([^<]*?)<br>/.exec(String(text)); return m ? m[1] : String(text); };
  // [name, headers, body]; the same bytes go to the app booted with the flag on and to the app booted with it unset
  const CASES = [
    ['urlencoded form', { 'Content-Type': 'application/x-www-form-urlencoded' }, Buffer.from('a=1&b=2')],
    ['text/plain garbage', { 'Content-Type': 'text/plain' }, Buffer.from('not json at all')],
    ['octet-stream bytes', { 'Content-Type': 'application/octet-stream' }, Buffer.from([0, 1, 2, 3, 254, 255])],
    ['gzip-encoded JSON', { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, zlib.gzipSync(Buffer.from(meta))],
    ['deflate-encoded JSON', { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate' }, zlib.deflateSync(Buffer.from(meta))],
    ['unknown Content-Encoding br', { 'Content-Type': 'application/json', 'Content-Encoding': 'br' }, Buffer.from(meta)],
    ['charset iso-8859-1', { 'Content-Type': 'application/json; charset=iso-8859-1' }, Buffer.from(meta)],
    ['BOM-prefixed JSON', { 'Content-Type': 'application/json' }, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(meta)])],
    ['malformed JSON', { 'Content-Type': 'application/json' }, Buffer.from('{"entry": [')],
    ['JSON primitive', { 'Content-Type': 'application/json' }, Buffer.from('5')],
    ['empty JSON body', { 'Content-Type': 'application/json' }, Buffer.alloc(0)],
    ['valid Meta-style payload', { 'Content-Type': 'application/json' }, Buffer.from(meta)],
  ];
  async function send(target, headers, body, flagOn) {
    if (flagOn) process.env.ONBOARDING_FLOW = 'on'; else delete process.env.ONBOARDING_FLOW;
    try {
      const req = request(target).post('/webhook').set(headers);
      return await Promise.race([req.send(body), wait(5000).then(() => { throw new Error('request hung'); })]);
    } finally { process.env.ONBOARDING_FLOW = 'on'; }
  }

  test.each(CASES.map((c) => [c[0], c]))('%s: same status and same answer with the flag on and unset', async (_name, [, headers, body]) => {
    const on = await send(app, headers, body, true);
    const off = await send(appOff, headers, body, false);
    expect(on.status).toBe(off.status);
    expect(on.headers['content-type']).toBe(off.headers['content-type']);
    if (on.status >= 400) expect(firstLine(on.text)).toBe(firstLine(off.text)); // the error page lists its own stack frames: the message is what must match
    else expect(on.text).toBe(off.text);
  });

  test('the table is not vacuous: it contains answers of 200, 400 and 415', async () => {
    const seen = new Set();
    for (const [, headers, body] of CASES) seen.add((await send(appOff, headers, body, false)).status);
    expect([...seen].sort()).toEqual(expect.arrayContaining([200, 400, 415]));
  });
});
