'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_b1d_wh`; // this suite gets its OWN database
assertThrowawayDb();

// Real throwaway mongod and REAL models: the merchant-WABA event handlers end to end (WhatsAppConnection,
// OnboardingInbound ledger with its string _id, OnboardingNotification unique keys, OnboardingEvent counters),
// fakeGraph for the "refresh" events. The E3 hunk of server.js is reproduced verbatim in a mini app so the
// interplay "intercept removes merchant entries, the legacy handler sees the rest" is proven with real code.
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { createFakeGraph } = require('../_fixtures');
const { rawGraphClient } = require('../unit/_b1dHelpers');
const wh = require('../../../shared/onboarding/webhookEvents');
const sr = require('../../../shared/onboarding/statusRefresh');
const sig = require('../../../shared/onboarding/webhookSignature');
const vault = require('../../../shared/onboarding/tokenVault');
const { createNotifications } = require('../../../shared/onboarding/notifications');
const Conn = require('../../../models/WhatsAppConnection');
const Inbound = require('../../../models/OnboardingInbound');
const Notification = require('../../../models/OnboardingNotification');
const Event = require('../../../models/OnboardingEvent');

const SECRET = 'APP_SECRET_FIXTURE_0123456789abcdef';
const PLATFORM_WABA = '5550001111';
const PLATFORM_PHONE = '5550002222';
const T = 1739321024;
const oid = () => String(new mongoose.Types.ObjectId());
const sha = (e) => `meta:${crypto.createHash('sha256').update(JSON.stringify(e)).digest('hex')}`;

let saved;
beforeAll(async () => {
  saved = { f: process.env.ONBOARDING_FLOW, w: process.env.WA_WABA_ID, p: process.env.WA_PHONE_ID, s: process.env.WA_APP_SECRET, k: process.env.WA_TOKEN_ENCRYPTION_KEY };
  process.env.ONBOARDING_FLOW = 'on';
  process.env.WA_WABA_ID = PLATFORM_WABA;
  process.env.WA_PHONE_ID = PLATFORM_PHONE;
  process.env.WA_APP_SECRET = SECRET;
  process.env.WA_TOKEN_ENCRYPTION_KEY = '01'.repeat(32);
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([Conn.init(), Inbound.init(), Notification.init(), Event.init()]);
});
afterAll(async () => {
  for (const [k, v] of [['ONBOARDING_FLOW', saved.f], ['WA_WABA_ID', saved.w], ['WA_PHONE_ID', saved.p], ['WA_APP_SECRET', saved.s], ['WA_TOKEN_ENCRYPTION_KEY', saved.k]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await mongoose.disconnect();
});
beforeEach(() => { wh.clearMemo(); jest.spyOn(console, 'warn').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

/** Meta ids are numeric strings (the webhook only looks up digit-only ids of 5 to 30 characters): unique per merchant of this run. */
let idSeq = 0;
function digitIds() {
  idSeq += 1;
  const n = String(Date.now()).slice(-9) + String(idSeq).padStart(3, '0');
  return { wabaId: `77${n}1`, phoneId: `77${n}2` };
}

/** A merchant with its own fake Graph. */
async function merchant(over = {}, graph = {}) {
  const ws = oid();
  const { wabaId, phoneId } = digitIds();
  const g = createFakeGraph({ wabaId, phoneId, ...graph });
  const emailSend = jest.fn(async () => ({ sent: true }));
  const deps = { meta: rawGraphClient(g), notifications: createNotifications({ email: { sendNotificationEmail: emailSend } }), appId: g.ids.appId, paymentProbe: () => false, log: () => {}, sync: true };
  await Conn.create({
    workspaceId: ws, status: 'connected', ids: { wabaId, phoneNumberId: phoneId },
    display: { verifiedName: 'Acme Coffee', last4: '4567' },
    tokenEncrypted: vault.encrypt(g.ids.merchantToken, { workspaceId: ws, purpose: 'token' }),
    webhook: { subscribed: true }, verification: { businessRaw: 'verified', mapped: 'done' }, displayName: { nameStatusRaw: 'APPROVED', mapped: 'done' },
    messagingLimit: { raw: 'TIER_250', tierNumber: 250 }, health: { canSend: 'AVAILABLE', issues: [] }, payment: { status: 'unknown' },
    nextCheckAt: new Date('2027-01-01T00:00:00Z'), connectedAt: new Date('2026-10-01T00:00:00Z'), ...over,
  });
  const row = () => Conn.findOne({ workspaceId: ws }).lean();
  const ev = wh.createWebhookEvents(deps);
  return { ws, wabaId, phoneId, g, deps, emailSend, row, ev };
}
const entry = (id, field, value, time = T) => ({ id, time, changes: [{ field, value }] });
const req = (entries, metaSignature) => ({ body: { object: 'whatsapp_business_account', entry: entries }, metaSignature });
const notes = (ws, kind) => Notification.find({ workspaceId: ws, ...(kind ? { kind } : {}) }).lean();
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };

describe('signed events change the stored state', () => {
  test('PARTNER_REMOVED: needsReconnect, one notification + e-mail, ledger row keyed by the entry hash, entries emptied', async () => {
    const m = await merchant();
    const e = entry(m.wabaId, 'account_update', { event: 'PARTNER_REMOVED', waba_info: { waba_id: m.wabaId, owner_business_id: '1', partner_app_id: '2' } });
    const r = req([e], 'valid');
    expect(await m.ev.intercept(r)).toBe(true);
    expect(r.body.entry).toEqual([]);
    await settle();
    const row = await m.row();
    expect(row).toMatchObject({ needsReconnect: true, reconnectReason: 'PARTNER_REMOVED', status: 'reconnect_required' });
    expect(await notes(m.ws, 'reconnect_needed')).toHaveLength(1);
    expect(m.emailSend).toHaveBeenCalledTimes(1);
    const ledger = await Inbound.findById(sha(e)).lean();
    expect(ledger).toMatchObject({ source: 'meta', type: 'entry', status: 'done', attempts: 1, outcome: 'account_update:reconnect' });
    expect(String(ledger.workspaceId)).toBe(m.ws);
    expect(ledger.finishedAt).toBeInstanceOf(Date);
  });

  test('duplicates: the same entry delivered twice AT THE SAME TIME is processed once (real E11000 on the string _id)', async () => {
    const m = await merchant();
    const e = entry(m.wabaId, 'account_update', { event: 'ACCOUNT_VIOLATION' });
    await Promise.all([m.ev.intercept(req([e], 'valid')), m.ev.intercept(req([JSON.parse(JSON.stringify(e))], 'valid'))]);
    expect(await Inbound.countDocuments({ _id: sha(e) })).toBe(1);
    expect(await notes(m.ws, 'account_alert')).toHaveLength(1);
    expect((await m.row()).health.issues).toEqual([{ entityType: 'WABA', code: 'ACCOUNT_VIOLATION' }]);
  });

  test('display name decided + tiers + alerts on one connection, each through its field handler', async () => {
    const m = await merchant({ displayName: { mapped: 'waiting', newName: 'Acme Cafe', newNameStatusRaw: 'PENDING_REVIEW', nameStatusRaw: 'APPROVED' } });
    await m.ev.intercept(req([entry(m.wabaId, 'phone_number_name_update', { decision: 'APPROVED', requested_verified_name: 'Acme Cafe', display_phone_number: '15550783881' })], 'valid'));
    await m.ev.intercept(req([entry(m.wabaId, 'business_capability_update', { max_daily_conversations_per_business: 'TIER_2K' }, T + 1)], 'valid'));
    await m.ev.intercept(req([entry(m.wabaId, 'phone_number_quality_update', { current_limit: 'TIER_10K', event: 'THROUGHPUT_UPGRADE' }, T + 2)], 'valid'));
    await m.ev.intercept(req([entry(m.wabaId, 'account_alerts', { entity_type: 'BUSINESS', entity_id: '1', alert_info: { alert_severity: 'CRITICAL', alert_status: 'ACTIVE', alert_type: 'OBA_REJECTED', alert_description: 'text' } }, T + 3)], 'valid'));
    const row = await m.row();
    expect(row.displayName).toMatchObject({ mapped: 'done', decision: 'APPROVED', newName: 'Acme Cafe' });
    expect(row.display.verifiedName).toBe('Acme Cafe');
    expect(row.messagingLimit).toMatchObject({ raw: 'TIER_10K', tierNumber: 10000 });
    expect(row.health.issues).toEqual([{ entityType: 'BUSINESS', code: 'OBA_REJECTED' }]);
    expect((await notes(m.ws)).map((n) => n.kind).sort()).toEqual(['account_alert', 'display_name_decided', 'messaging_limit_changed', 'messaging_limit_changed']);
    expect(await Inbound.countDocuments({ workspaceId: m.ws, status: 'done' })).toBe(4);
  });

  test('a rejection stores a whitelisted reason and puts the connection in needs_attention', async () => {
    const m = await merchant({ displayName: { mapped: 'waiting', newName: 'Bad', newNameStatusRaw: 'PENDING_REVIEW', nameStatusRaw: 'APPROVED' } });
    await m.ev.intercept(req([entry(m.wabaId, 'phone_number_name_update', { decision: 'REJECTED', requested_verified_name: 'Bad', rejection_reason: 'NAME_FORMAT_UNACCEPTABLE' })], 'valid'));
    const row = await m.row();
    expect(row.displayName).toMatchObject({ mapped: 'needs_you', decision: 'REJECTED', rejectionReason: 'NAME_FORMAT_UNACCEPTABLE' });
    expect(row.status).toBe('needs_attention');
  });

  test('ACCOUNT_RECONNECTED reads the truth from Graph with the merchant token only', async () => {
    const m = await merchant({}, { tier: 'TIER_100K' });
    await m.ev.intercept(req([entry(m.wabaId, 'account_update', { event: 'ACCOUNT_RECONNECTED' })], 'valid'));
    expect(m.g.callsTo('getWaba')).toHaveLength(1);
    m.g.assertMerchantTokenOnly(m.g.ids.merchantToken);
    expect((await m.row()).messagingLimit).toMatchObject({ raw: 'TIER_100K', tierNumber: 100000 });
  });

  test('the matching by phone_number_id works against the real index', async () => {
    const m = await merchant();
    const r = req([entry('9900000000000031', 'phone_number_quality_update', { current_limit: 'TIER_2K', metadata: { phone_number_id: m.phoneId } })], 'valid');
    expect(await m.ev.intercept(r)).toBe(true);
    expect((await m.row()).messagingLimit.raw).toBe('TIER_2K');
  });
});

describe('template status events through the real starterTemplates (B1-e)', () => {
  const Template = require('../../../models/OnboardingTemplate');
  let available = true;
  try { require('../../../shared/onboarding/starterTemplates').STARTER_KEYS.length; } catch (_) { available = false; }
  const run = available ? test : test.skip;

  run('an APPROVED event updates the template row once and notifies once; a replay and a later REJECTED for another template work', async () => {
    await Template.init();
    const m = await merchant();
    const mk = (key, id, status) => Template.create({ workspaceId: m.ws, key, language: 'en', source: 'library', metaTemplateName: `wf_${m.ws.slice(-6)}_${key}_en_v1`, metaTemplateId: id, metaStatus: status, metaStatusRaw: status });
    await mk('welcome_optin', '9001', 'PENDING');
    await mk('comeback', '9002', 'PENDING');
    const ev = (event, id, name, extra = {}, time = T) => entry(m.wabaId, 'message_template_status_update', { event, message_template_id: Number(id), message_template_name: name, message_template_language: 'en', message_template_category: 'UTILITY', ...extra }, time);
    const nameOf = (key) => `wf_${m.ws.slice(-6)}_${key}_en_v1`;
    const approved = ev('APPROVED', '9001', nameOf('welcome_optin'));
    await m.ev.intercept(req([approved], 'valid'));
    await m.ev.intercept(req([JSON.parse(JSON.stringify(approved))], 'valid')); // Meta retry
    await m.ev.intercept(req([ev('REJECTED', '9002', nameOf('comeback'), { reason: 'INVALID_FORMAT', rejection_info: { reason: 'INVALID_FORMAT', recommendation: 'Remove the emoji' } }, T + 1)], 'valid'));
    const rows = await Template.find({ workspaceId: m.ws }).sort({ key: 1 }).lean();
    expect(rows.map((r) => [r.key, r.metaStatus])).toEqual([['comeback', 'REJECTED'], ['welcome_optin', 'APPROVED']]);
    expect(rows[0].rejectedReason).toBe('INVALID_FORMAT');
    const kinds = (await notes(m.ws)).map((n) => n.kind).sort();
    expect(kinds).toEqual(['template_approved', 'template_approved', 'template_rejected']); // the template, the "first approved" milestone, the rejection
    expect(await Inbound.countDocuments({ workspaceId: m.ws, status: 'done' })).toBe(2);
  });
});

describe('unsigned events are hints only', () => {
  test.each(['absent', 'invalid', 'unconfigured', undefined])('signature %p: only nextCheckAt changes, nothing is notified, tracked or written to the connection', async (signature) => {
    const m = await merchant();
    const before = await m.row();
    for (const [field, value] of [
      ['account_update', { event: 'PARTNER_REMOVED' }], ['account_update', { event: 'ACCOUNT_VIOLATION' }],
      ['phone_number_name_update', { decision: 'REJECTED', requested_verified_name: 'Forged' }],
      ['phone_number_quality_update', { current_limit: 'TIER_100K' }],
      ['account_alerts', { alert_info: { alert_severity: 'CRITICAL', alert_status: 'ACTIVE', alert_type: 'OBA_REJECTED' } }],
    ]) {
      expect(await m.ev.intercept(req([entry(m.wabaId, field, value, T + Math.floor(Math.random() * 1e6))], signature))).toBe(true);
    }
    const after = await m.row();
    expect(new Date(after.nextCheckAt).getTime()).toBeLessThan(Date.now() + 5000);
    expect(new Date(after.nextCheckAt).getTime()).toBeGreaterThan(Date.now() - 60000); // the poller will look at it now
    const strip = (r) => { const { nextCheckAt, updatedAt, ...rest } = r; return rest; };
    expect(strip(after)).toEqual(strip(before));
    expect(await notes(m.ws)).toHaveLength(0);
    expect(await Event.countDocuments({ workspaceId: m.ws })).toBe(0);
    expect(m.g.calls).toHaveLength(0);
  });
});

describe('messages are acknowledged and dropped with a counter', () => {
  test('removed from the body, one webhook_dropped OnboardingEvent, nothing stored', async () => {
    const m = await merchant();
    const r = req([entry(m.wabaId, 'messages', { metadata: { phone_number_id: m.phoneId }, contacts: [{ profile: { name: 'Layla' } }], messages: [{ from: '966500000001', id: 'wamid.SECRET', text: { body: 'customer secret text' } }] })], 'valid');
    expect(await m.ev.intercept(r)).toBe(true);
    expect(r.body.entry).toEqual([]);
    await m.ev.intercept(req([entry(m.wabaId, 'messages', { messages: [{ text: { body: 'again' } }] }, T + 1)], 'valid'));
    const events = await Event.find({ workspaceId: m.ws }).lean();
    expect(events).toHaveLength(1); // the second one is only counted in memory (5 minute flush)
    expect(events[0]).toMatchObject({ type: 'webhook_dropped', code: 'WEBHOOK_MESSAGES_DROPPED', reason: 'merchant_inbox_not_enabled' });
    expect(await Inbound.countDocuments({ workspaceId: m.ws })).toBe(0);
    const dump = JSON.stringify([events, await m.row(), await notes(m.ws)]);
    for (const secret of ['customer secret text', '966500000001', 'Layla', 'wamid.SECRET']) expect(dump).not.toContain(secret);
  });
});

describe('a disconnected WABA stays matched and is dropped', () => {
  test('never reaches the legacy handler, never changes the row', async () => {
    const m = await merchant({ status: 'disconnected' });
    const r = req([entry(m.wabaId, 'account_update', { event: 'PARTNER_REMOVED' })], 'valid');
    expect(await m.ev.intercept(r)).toBe(true);
    expect(r.body.entry).toEqual([]);
    expect((await m.row()).needsReconnect).toBeFalsy();
    expect((await Event.find({ workspaceId: m.ws }).lean()).map((e) => e.code)).toEqual(['WEBHOOK_DISCONNECTED_DROPPED']);
  });
});

describe('the E3 hunk, verbatim, in a mini app (real intercept)', () => {
  function makeApp(deps) {
    const app = express();
    const earlyMounts = require('../../../shared/onboarding/earlyMounts');
    earlyMounts.mount(app, express); // E1
    app.use(express.json());
    const legacy = [];
    // eslint-disable-next-line no-undef
    app.post('/webhook', async (req, res) => {
      res.sendStatus(200);
      try { const ob = { enabled: wh.enabled, intercept: (r) => wh.intercept(r, deps) }; if (ob.enabled() && await ob.intercept(req)) return; } catch (_) { /* fail open: existing flow */ } // WhatsApp onboarding: merchant-WABA events only
      legacy.push(JSON.parse(JSON.stringify(req.body)));
    });
    return { app, legacy };
  }
  const signed = (app, body, secret = SECRET) => {
    const raw = JSON.stringify(body);
    return request(app).post('/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig.computeSignature(raw, secret)).send(raw);
  };

  test('a signed mixed payload: the merchant entry is processed here, the legacy handler sees ONLY the platform entry (even when the merchant entry comes first)', async () => {
    const m = await merchant();
    const { app, legacy } = makeApp(m.deps);
    const platform = entry(PLATFORM_WABA, 'messages', { metadata: { phone_number_id: PLATFORM_PHONE }, messages: [{ from: '966500000009', id: 'wamid.P', type: 'text', text: { body: 'platform hello' } }] });
    const res = await signed(app, { object: 'whatsapp_business_account', entry: [entry(m.wabaId, 'account_update', { event: 'PARTNER_REMOVED' }), platform] });
    expect(res.status).toBe(200);
    for (let i = 0; i < 20 && !legacy.length; i += 1) await new Promise((r) => setTimeout(r, 10));
    await settle();
    expect(legacy).toHaveLength(1);
    expect(legacy[0].entry).toEqual([platform]);
    expect((await m.row()).needsReconnect).toBe(true);
  });

  test('a merchant-only payload never reaches the legacy handler', async () => {
    const m = await merchant();
    const { app, legacy } = makeApp(m.deps);
    await signed(app, { object: 'whatsapp_business_account', entry: [entry(m.wabaId, 'messages', { messages: [{ text: { body: 'x' } }] })] });
    await new Promise((r) => setTimeout(r, 100));
    expect(legacy).toHaveLength(0);
  });

  test('a platform payload with an unknown WABA stays with the legacy handler, untouched', async () => {
    const m = await merchant();
    const { app, legacy } = makeApp(m.deps);
    const body = { object: 'whatsapp_business_account', entry: [entry('UNKNOWN_WABA', 'messages', { metadata: { phone_number_id: 'ZZZ' }, statuses: [] })] };
    const raw = JSON.stringify(body);
    // enforce mode: a payload touching another WABA must be signed; sign it as Meta would
    const res = await request(app).post('/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig.computeSignature(raw, SECRET)).send(raw);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(legacy).toEqual([body]);
  });

  test('an unsigned merchant payload is rejected with 403 before any processing (enforce)', async () => {
    const m = await merchant();
    const { app, legacy } = makeApp(m.deps);
    const body = { object: 'whatsapp_business_account', entry: [entry(m.wabaId, 'account_update', { event: 'PARTNER_REMOVED' })] };
    const res = await request(app).post('/webhook').set('Content-Type', 'application/json').send(JSON.stringify(body));
    expect(res.status).toBe(403);
    expect((await m.row()).needsReconnect).toBeFalsy();
    expect(legacy).toHaveLength(0);
  });

  test('log mode lets an unsigned merchant event through as a hint (no state change)', async () => {
    process.env.ONBOARDING_WEBHOOK_SIGNATURE = 'log';
    try {
      const m = await merchant();
      const { app, legacy } = makeApp(m.deps);
      const body = { object: 'whatsapp_business_account', entry: [entry(m.wabaId, 'account_update', { event: 'PARTNER_REMOVED' })] };
      const res = await request(app).post('/webhook').set('Content-Type', 'application/json').send(JSON.stringify(body));
      expect(res.status).toBe(200);
      await settle();
      expect((await m.row()).needsReconnect).toBeFalsy();
      expect(legacy).toHaveLength(0);
    } finally { delete process.env.ONBOARDING_WEBHOOK_SIGNATURE; }
  });
});

describe('fail-open and isolation', () => {
  test('flag off: intercept resolves false and the DB is not touched', async () => {
    const m = await merchant();
    process.env.ONBOARDING_FLOW = 'off';
    try {
      const r = req([entry(m.wabaId, 'account_update', { event: 'PARTNER_REMOVED' })], 'valid');
      expect(await m.ev.intercept(r)).toBe(false);
      expect(r.body.entry).toHaveLength(1);
      expect(await Inbound.countDocuments({ workspaceId: m.ws })).toBe(0);
    } finally { process.env.ONBOARDING_FLOW = 'on'; }
  });
  test('an event for workspace A never touches workspace B', async () => {
    const a = await merchant();
    const b = await merchant();
    await a.ev.intercept(req([entry(a.wabaId, 'account_update', { event: 'PARTNER_REMOVED' })], 'valid'));
    expect((await a.row()).needsReconnect).toBe(true);
    expect((await b.row()).needsReconnect).toBeFalsy();
    expect(sr.snapshot(await b.row()).level).toBe('connected');
  });
});

describe('R7-06 on the real database: one WABA id carried by two connection rows (handed over between workspaces)', () => {
  /** A disconnected row that still holds the ids (a disconnect keeps them) and was written BEFORE the live one: the first row a plain findOne would return. */
  async function handedOver() {
    const { wabaId, phoneId } = digitIds();
    const oldWs = oid();
    await Conn.create({ workspaceId: oldWs, status: 'disconnected', ids: { wabaId, phoneNumberId: phoneId }, disconnectedAt: new Date('2026-09-01T00:00:00Z'), nextCheckAt: null });
    const live = await merchant({ ids: { wabaId, phoneNumberId: phoneId } });
    return { wabaId, phoneId, oldWs, live };
  }

  test('the LIVE row receives the event; the older disconnected row is never touched', async () => {
    const { wabaId, oldWs, live } = await handedOver();
    expect((await Conn.find({ 'ids.wabaId': wabaId }).lean())).toHaveLength(2);
    const e = entry(wabaId, 'account_update', { event: 'PARTNER_REMOVED' });
    const r = req([e], 'valid');
    expect(await live.ev.intercept(r)).toBe(true);
    expect(r.body.entry).toEqual([]);
    await settle();
    expect(await live.row()).toMatchObject({ needsReconnect: true, reconnectReason: 'PARTNER_REMOVED', status: 'reconnect_required' });
    const old = await Conn.findOne({ workspaceId: oldWs }).lean();
    expect(old.status).toBe('disconnected');
    expect(old.needsReconnect).not.toBe(true);
    expect(await notes(String(oldWs))).toHaveLength(0);
    expect(await Event.countDocuments({ workspaceId: oldWs })).toBe(0);
  });

  test('the same by phone number id (an entry whose own id is unknown, its metadata names the handed-over number)', async () => {
    const { phoneId, live } = await handedOver();
    const e = entry('990000000000099', 'account_update', { event: 'PARTNER_REMOVED', metadata: { phone_number_id: phoneId } });
    expect(await live.ev.intercept(req([e], 'valid'))).toBe(true);
    await settle();
    expect((await live.row()).needsReconnect).toBe(true);
  });

  test('only when EVERY match is disconnected is the entry dropped (counted for that workspace, nothing else changes)', async () => {
    const { wabaId, phoneId } = digitIds();
    const a = oid();
    const b = oid();
    await Conn.create({ workspaceId: a, status: 'disconnected', ids: { wabaId, phoneNumberId: phoneId }, nextCheckAt: null });
    await Conn.create({ workspaceId: b, status: 'not_connected', ids: { wabaId, phoneNumberId: phoneId }, nextCheckAt: null });
    const ev = wh.createWebhookEvents({ meta: {}, appId: 'x', log: () => {}, sync: true });
    const r = req([entry(wabaId, 'account_update', { event: 'PARTNER_REMOVED' })], 'valid');
    expect(await ev.intercept(r)).toBe(true);
    expect(r.body.entry).toEqual([]);
    await settle();
    for (const ws of [a, b]) expect((await Conn.findOne({ workspaceId: ws }).lean()).needsReconnect).not.toBe(true);
    const dropped = await Event.find({ type: 'webhook_dropped', workspaceId: { $in: [a, b] } }).lean();
    expect(dropped).toHaveLength(1);
    expect(dropped[0].code).toBe('WEBHOOK_DISCONNECTED_DROPPED');
  });
});
