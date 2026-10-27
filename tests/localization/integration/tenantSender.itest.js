const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// Per-customer WhatsApp number (utils/waTenant.js + utils/whatsapp.js + utils/whatsappCarousel.js + routes/whatsapp.js), against
// the throwaway mongod. Every outbound call is captured by an axios adapter stub (nothing leaves the machine); the stub records
// the method, URL, params, the Authorization token and the body of every Graph request, so the tests can prove WHICH phone id,
// WABA and token each request used.
//
// What is proven here:
//   * a customer without its own number sends from the platform phone id with the platform token, in exactly the old shapes
//   * a customer with its own number sends from ITS phone id with ITS decrypted token (never the platform one)
//   * two customers in the same process, sending at the same time, never mix
//   * a customer whose own number is broken gets an error - never the platform number - and nothing is sent at all
//   * OTP login and team invites always use the platform number, even inside a customer's context
//   * template create / list / get / delete use the customer's WABA; the per-template caches are per WABA
//   * media upload uses the customer's phone id; the carousel module follows the same sender
//   * template list paging, opts.footer / opts.language, the wa.me number of referral / Instagram links per customer
//   * the /api/whatsapp route gating (only when SUPER_ADMIN_CONTACTS is configured)
const PLATFORM_TOKEN = 'PLATFORM_TOKEN_ITEST';
const PLATFORM_PHONE = '111111111111111';
const PLATFORM_WABA = '222222222222222';
process.env.WA_TOKEN = PLATFORM_TOKEN;
process.env.WA_PHONE_ID = PLATFORM_PHONE;
process.env.WA_WABA_ID = PLATFORM_WABA;
process.env.WA_APP_ID = 'APPID_ITEST';
const TEST_KEY = 'ab'.repeat(32); // a throwaway 32-byte key (64 hex chars), never used for anything real
process.env.WA_TOKEN_ENCRYPTION_KEY = TEST_KEY;
delete process.env.WA_TOKEN_ENCRYPTION_KEY_PREV;
delete process.env.SUPER_ADMIN_CONTACTS;

const fx = require('./_fixtures');
process.env.LOCALIZATION_SEND_MODE = ''; // real (stubbed) HTTP, not dry-run
const axios = require('axios');
const request = require('supertest');
const express = require('express');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = [];
let wamidSeq = 0;
const state = { templatePages: {}, nextHost: 'graph.facebook.com', delayBy: null };

axios.defaults.adapter = async (config) => {
  const h = config.headers;
  const header = (name) => (h && typeof h.get === 'function' ? h.get(name) : h && h[name]) || null;
  let body = config.data;
  if (body && typeof body.getBoundary === 'function') body = '<formdata>';
  else if (Buffer.isBuffer(body)) body = '<buffer>';
  else if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep */ } }
  const rec = {
    method: String(config.method || '').toUpperCase(), url: String(config.url || ''), body: body === undefined ? null : body,
    params: config.params || null, auth: header('Authorization'), contentType: header('Content-Type'),
  };
  calls.push(rec);
  if (state.delayBy && rec.body && rec.body.to) await sleep(state.delayBy(rec.body.to));

  const path = rec.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
  let data;
  if (rec.method === 'GET' && /\/message_templates$/.test(path)) {
    const waba = path.split('/').slice(-2)[0];
    const pages = state.templatePages[waba] || [[]];
    const pageNo = Number((/[?&]page=(\d+)/.exec(rec.url) || [0, 0])[1]);
    data = { data: pages[pageNo] || [] };
    if (pageNo + 1 < pages.length) data.paging = { cursors: { after: 'c' }, next: `https://${state.nextHost}/v25.0/${waba}/message_templates?page=${pageNo + 1}&access_token=SHOULD_NOT_MATTER` };
  } else if (rec.method === 'GET' && config.params && config.params.fields === 'display_phone_number') {
    data = { display_phone_number: '+971 4 000 0000', id: 'x' };
  } else if (rec.method === 'GET' && config.params && config.params.fields === 'whatsapp_business_account') {
    data = { whatsapp_business_account: { id: `WABA_OF_${path.split('/').pop()}` } };
  } else if (rec.method === 'GET' && /me\/whatsapp_business_accounts$/.test(path)) {
    data = { data: [{ id: PLATFORM_WABA }] };
  } else if (rec.method === 'GET' && config.responseType === 'arraybuffer') {
    return { data: Buffer.from('imgbytes'), status: 200, statusText: 'OK', headers: { 'content-type': 'image/png' }, config, request: {} };
  } else if (rec.method === 'GET') data = { data: [] };
  else if (rec.method === 'DELETE') data = { success: true };
  else if (/\/messages$/.test(path)) data = { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.T${++wamidSeq}_${Date.now()}` }] };
  else if (/\/media$/.test(path)) data = { id: `media_${path.split('/').slice(-2)[0]}` };
  else if (/\/uploads$/.test(path)) data = { id: 'upload:session1' };
  else if (/\/upload:session1$/.test(path)) data = { h: 'HANDLE1' };
  else data = { id: `stub${++wamidSeq}` };
  return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};

const reset = () => { calls.length = 0; state.templatePages = {}; state.nextHost = 'graph.facebook.com'; state.delayBy = null; };
const messages = () => calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.url));
const phoneIdOf = (c) => /\/v25\.0\/([^/]+)\/(?:messages|media)$/.exec(c.url)[1];
const wabaOf = (c) => /\/v25\.0\/([^/]+)\/message_templates/.exec(c.url)[1];
const templateCreates = () => calls.filter((c) => c.method === 'POST' && /\/message_templates$/.test(c.url));
const bearer = (token) => `Bearer ${token}`;

const mongoose = require('mongoose');
const Workspace = require('../../../models/Workspace');
const MessageNode = require('../../../models/MessageNode');
const ReferralPromotion = require('../../../models/ReferralPromotion');
const ReferralCode = require('../../../models/ReferralCode');
const TrackingLink = require('../../../models/TrackingLink');
const InstagramPost = require('../../../models/InstagramPost');
const tokenVault = require('../../../shared/onboarding/tokenVault');
const tokenManager = require('../../../utils/tokenManager');
const senderContext = require('../../../utils/senderContext');
const waTenant = require('../../../utils/waTenant');
const settingsCache = require('../../../utils/settingsCache');
const wa = require('../../../utils/whatsapp');
const carousel = require('../../../utils/whatsappCarousel');
const { requireAuth } = require('../../../middleware/requireAuth');

jest.setTimeout(120000);

let seq = 0;
const nextPhoneId = () => String(7000000000 + (Date.now() % 100000) * 100 + (++seq));
const msg = (to, text = 'hello') => ({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });

// A customer (workspace) with its own number: phone id + WABA + an encrypted token (decrypts back to `token`).
async function ownNumber({ token, waba, phoneId, display, over = {} } = {}) {
  const ws = await fx.makeWorkspace({ arabic: false });
  const id = String(ws.workspaceId);
  const w = {
    'whatsapp.phoneId': phoneId || nextPhoneId(),
    'whatsapp.wabaId': waba || `WABA_${fx.uniq()}`,
    'whatsapp.tokenEncrypted': tokenVault.encrypt(token || `TOKEN_${fx.uniq()}`, { workspaceId: id, purpose: 'token' }),
    'whatsapp.tokenIsValid': true,
    ...(display ? { 'whatsapp.displayPhoneNumber': display } : {}),
    ...over,
  };
  await Workspace.updateOne({ _id: ws.workspaceId }, { $set: w });
  waTenant.invalidate(id);
  const plain = token;
  return { ...ws, id, phoneId: w['whatsapp.phoneId'], waba: w['whatsapp.wabaId'], token: plain };
}
const inCtx = (ws, fn) => senderContext.run(String(ws.workspaceId || ws.id), fn);

beforeAll(async () => {
  await fx.connect();
  try { await Workspace.init(); } catch (e) { /* index build is best effort */ }
  for (const m of [MessageNode, ReferralPromotion, ReferralCode, TrackingLink, InstagramPost]) { try { await m.init(); } catch (e) { /* best effort */ } }
  await fx.makeWorkspace({ arabic: false, merchantName: 'Aroma Cafe' }); // the first Settings in this database feeds settingsCache
});
afterAll(async () => { await fx.disconnect(); });
beforeEach(() => { reset(); settingsCache.invalidate(); waTenant.invalidate(); });

describe('the schema', () => {
  test('the platform token in this test is what tokenManager reports (the stub compares against it)', () => {
    expect(tokenManager.getToken()).toBe(PLATFORM_TOKEN);
  });

  test('tokenEncrypted is never loaded by default; the partial unique index rejects a second workspace with the same phone id but allows many without one', async () => {
    const a = await ownNumber({ token: 'T-A' });
    const loaded = await Workspace.findById(a.workspaceId).lean();
    expect(loaded.whatsapp.tokenEncrypted).toBeUndefined();
    expect(loaded.whatsapp.phoneId).toBe(a.phoneId);
    const explicit = await Workspace.findById(a.workspaceId).select('+whatsapp.tokenEncrypted').lean();
    expect(typeof explicit.whatsapp.tokenEncrypted).toBe('string');

    const b = await fx.makeWorkspace({ arabic: false });
    await expect(Workspace.updateOne({ _id: b.workspaceId }, { $set: { 'whatsapp.phoneId': a.phoneId } })).rejects.toMatchObject({ code: 11000 });
    // workspaces with no number (the vast majority) never collide on "missing", and '' counts as missing
    const c = await Workspace.create({ name: `x-${fx.uniq()}`, whatsapp: { phoneId: '' } });
    const d = await Workspace.create({ name: `y-${fx.uniq()}` });
    expect(c.whatsapp.phoneId).toBeUndefined();
    expect(d._id).toBeTruthy();
  });

  test('a new workspace document is unchanged by the new fields (no whatsapp key is written)', async () => {
    const ws = await Workspace.create({ name: `plain-${fx.uniq()}` });
    const raw = await mongoose.connection.db.collection('workspaces').findOne({ _id: ws._id });
    expect(raw.whatsapp).toBeUndefined();
  });
});

describe('waPost: which number a message goes out from', () => {
  test('no context at all -> the platform phone id and token, in exactly the old request shape', async () => {
    const body = msg('15551230001');
    const out = await wa.waPost(body);
    expect(out.messages[0].id).toMatch(/^wamid\./);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST', url: `https://graph.facebook.com/v25.0/${PLATFORM_PHONE}/messages`, body, auth: bearer(PLATFORM_TOKEN), contentType: 'application/json',
    });
    expect(calls[0].params).toBeNull();
  });

  test('a customer WITHOUT its own number (inside its context) sends from the platform phone id with the platform token', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    await inCtx(ws, () => wa.waPost(msg('15551230002')));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://graph.facebook.com/v25.0/${PLATFORM_PHONE}/messages`);
    expect(calls[0].auth).toBe(bearer(PLATFORM_TOKEN));
  });

  test('a customer WITH its own number sends from ITS phone id with ITS decrypted token', async () => {
    const t = await ownNumber({ token: 'MEGASUN_SECRET_TOKEN' });
    const body = msg('15551230003', 'from megasun');
    await inCtx(t, () => wa.waPost(body));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `https://graph.facebook.com/v25.0/${t.phoneId}/messages`, body, auth: bearer('MEGASUN_SECRET_TOKEN') });
    expect(JSON.stringify(calls)).not.toContain(PLATFORM_TOKEN);
  });

  test('a number added inside the platform WABA (phone id only) sends from the tenant phone id with the platform token', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const phoneId = nextPhoneId();
    await Workspace.updateOne({ _id: ws.workspaceId }, { $set: { 'whatsapp.phoneId': phoneId } });
    waTenant.invalidate(ws.workspaceId);
    await inCtx(ws, () => wa.waPost(msg('15551230004')));
    expect(calls[0].url).toBe(`https://graph.facebook.com/v25.0/${phoneId}/messages`);
    expect(calls[0].auth).toBe(bearer(PLATFORM_TOKEN));
  });

  test('enabled:false puts a customer back on the platform number without deleting anything', async () => {
    const t = await ownNumber({ token: 'OFF_TOKEN' });
    await Workspace.updateOne({ _id: t.workspaceId }, { $set: { 'whatsapp.enabled': false } });
    waTenant.invalidate(t.id);
    await inCtx(t, () => wa.waPost(msg('15551230005')));
    expect(calls[0].url).toBe(`https://graph.facebook.com/v25.0/${PLATFORM_PHONE}/messages`);
    expect(calls[0].auth).toBe(bearer(PLATFORM_TOKEN));
  });

  test('two customers and the platform, sending at the same time in one process, never mix', async () => {
    const a = await ownNumber({ token: 'TOKEN_OF_A' });
    const b = await ownNumber({ token: 'TOKEN_OF_B' });
    const plain = await fx.makeWorkspace({ arabic: false });
    state.delayBy = (to) => (Number(to.slice(-2)) % 7) * 6; // interleave the requests
    const jobs = [];
    for (let i = 0; i < 6; i += 1) {
      jobs.push(inCtx(a, () => wa.waPost(msg(`1555000A0${i}`))));
      jobs.push(inCtx(b, () => wa.waPost(msg(`1555000B0${i}`))));
      jobs.push(inCtx(plain, () => wa.waPost(msg(`1555000C0${i}`))));
    }
    await Promise.all(jobs);
    expect(messages()).toHaveLength(18);
    for (const c of messages()) {
      const kind = c.body.to.slice(7, 8);
      const expected = { A: [a.phoneId, 'TOKEN_OF_A'], B: [b.phoneId, 'TOKEN_OF_B'], C: [PLATFORM_PHONE, PLATFORM_TOKEN] }[kind];
      expect([phoneIdOf(c), c.auth]).toEqual([expected[0], bearer(expected[1])]);
    }
  });

  test('a context that is entered (webhook style) and then awaited keeps its own number', async () => {
    const a = await ownNumber({ token: 'ENTER_TOKEN_A' });
    await new Promise((resolve, reject) => {
      senderContext.run(null, async () => {
        try {
          senderContext.enter(a.id);
          await sleep(5);
          await wa.waPost(msg('15551230006'));
          resolve();
        } catch (e) { reject(e); }
      });
    });
    expect(calls[0].url).toBe(`https://graph.facebook.com/v25.0/${a.phoneId}/messages`);
    expect(calls[0].auth).toBe(bearer('ENTER_TOKEN_A'));
  });
});

describe('a broken own number fails closed: an error, never the platform number, and nothing is sent', () => {
  async function brokenCases() {
    const garbage = await ownNumber({ token: 'G' });
    await Workspace.updateOne({ _id: garbage.workspaceId }, { $set: { 'whatsapp.tokenEncrypted': 'v1:AAAA.BBBB.CCCC' } });

    const movedFrom = await fx.makeWorkspace({ arabic: false });
    const moved = await ownNumber({ token: 'M' });
    await Workspace.updateOne({ _id: moved.workspaceId }, { $set: { 'whatsapp.tokenEncrypted': tokenVault.encrypt('M', { workspaceId: String(movedFrom.workspaceId), purpose: 'token' }) } }); // bound to ANOTHER workspace

    const flagged = await ownNumber({ token: 'F' });
    await Workspace.updateOne({ _id: flagged.workspaceId }, { $set: { 'whatsapp.tokenIsValid': false } });

    const otherWaba = await fx.makeWorkspace({ arabic: false }); // its own WABA but no token of its own
    await Workspace.updateOne({ _id: otherWaba.workspaceId }, { $set: { 'whatsapp.phoneId': nextPhoneId(), 'whatsapp.wabaId': 'SOMEONE_ELSES_WABA' } });
    [garbage, moved, flagged, otherWaba].forEach((w) => waTenant.invalidate(String(w.workspaceId)));
    return { garbage, moved, flagged, otherWaba };
  }

  test('undecryptable, moved-from-another-workspace, flagged invalid, and no-token-in-a-foreign-WABA all refuse to send', async () => {
    const cases = await brokenCases();
    for (const [name, ws] of Object.entries(cases)) {
      reset();
      const err = await inCtx(ws, () => wa.waPost(msg('15551239999'))).catch((e) => e);
      expect(err).toBeInstanceOf(waTenant.WhatsAppNumberUnavailable);
      expect({ name, code: err.code, status: err.status }).toEqual({ name, code: 'WHATSAPP_NUMBER_UNAVAILABLE', status: 409 });
      expect(calls).toHaveLength(0); // not a single request, in particular none to the platform number
    }
  });

  test('every other Graph helper refuses too (templates, lookups, media) - zero requests', async () => {
    const { garbage } = await brokenCases();
    const attempts = [
      () => wa.getWabaId(), () => wa.listTemplates(), () => wa.getTemplate('x'), () => wa.createPromoTemplate(), () => wa.createLoyaltyTemplate(),
      () => wa.createWinbackTemplate(), () => wa.createPostPurchaseTemplate(), () => wa.createPointsNudgeTemplate(), () => wa.createNoShowTemplate(),
      () => wa.createConsentRequestTemplate(), () => wa.createTemplate('n', 'Body', 'MARKETING'), () => wa.deleteTemplate('n'),
      () => wa.uploadFileBuffer(Buffer.from('x'), 'a.png', 'image/png'), () => wa.uploadMediaFromUrl('https://img.example.test/a.png'),
      () => wa.sendCustomFlowTemplate('1555', 'tpl', ['a'], []), () => carousel.createCarouselTemplate(2, ['https://img.example.test/a.png']),
    ];
    for (const attempt of attempts) {
      const err = await inCtx(garbage, attempt).catch((e) => e);
      expect(err).toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE' });
    }
    // the self-healing "ensure template exists" step never throws, but the send right after does - and nothing is posted
    await expect(inCtx(garbage, () => wa.sendLoyaltyTemplate('1555', 'Sam', 10))).rejects.toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE' });
    expect(calls).toHaveLength(0);
  });

  test('when the encryption key is missing a customer with a saved token cannot send (it does not fall back to the platform number)', async () => {
    const t = await ownNumber({ token: 'NEEDS_KEY' });
    delete process.env.WA_TOKEN_ENCRYPTION_KEY;
    try {
      await expect(inCtx(t, () => wa.waPost(msg('1555')))).rejects.toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE' });
      expect(calls).toHaveLength(0);
    } finally { process.env.WA_TOKEN_ENCRYPTION_KEY = TEST_KEY; }
  });

  test('after the number is repaired and the memo cleared, sending works again from that customer\'s number', async () => {
    const t = await ownNumber({ token: 'REPAIRED_TOKEN', over: { 'whatsapp.tokenIsValid': false } });
    await expect(inCtx(t, () => wa.waPost(msg('1555')))).rejects.toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE' });
    await Workspace.updateOne({ _id: t.workspaceId }, { $set: { 'whatsapp.tokenIsValid': true } });
    waTenant.invalidate(t.id);
    await inCtx(t, () => wa.waPost(msg('1555')));
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe(bearer('REPAIRED_TOKEN'));
  });
});

describe('OTP login and team invites are WaFlow\'s own messages: always the platform number', () => {
  test('sendOtpTemplate inside a customer context with its own number: template lookup, creation and send all use the platform sender', async () => {
    const t = await ownNumber({ token: 'TENANT_TOKEN_OTP', waba: 'TENANT_WABA_OTP' });
    await inCtx(t, () => wa.sendOtpTemplate('15551230010', '123456'));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.auth).toBe(bearer(PLATFORM_TOKEN));
      expect(c.url).not.toContain(t.phoneId);
      expect(c.url).not.toContain('TENANT_WABA_OTP');
    }
    const send = messages();
    expect(send).toHaveLength(1);
    expect(send[0].url).toBe(`https://graph.facebook.com/v25.0/${PLATFORM_PHONE}/messages`);
    expect(send[0].body.template.name).toBe('waflow_login_otp');
    expect(send[0].body.template.components[0].parameters[0].text).toBe('123456');
  });

  test('sendInviteTemplate likewise; and the customer context is intact afterwards', async () => {
    const t = await ownNumber({ token: 'TENANT_TOKEN_INV', waba: 'TENANT_WABA_INV' });
    await inCtx(t, async () => {
      await wa.sendInviteTemplate('15551230011', 'Acme');
      expect(senderContext.currentWorkspaceId()).toBe(t.id);
      await wa.waPost(msg('15551230012'));
    });
    const [invite, normal] = messages();
    expect(invite.url).toBe(`https://graph.facebook.com/v25.0/${PLATFORM_PHONE}/messages`);
    expect(invite.auth).toBe(bearer(PLATFORM_TOKEN));
    expect(invite.body.template.name).toBe('waflow_team_invite');
    expect(normal.url).toBe(`https://graph.facebook.com/v25.0/${t.phoneId}/messages`);
    expect(normal.auth).toBe(bearer('TENANT_TOKEN_INV'));
  });

  test('OTP still works for a customer whose own number is BROKEN (login must never depend on a customer\'s number)', async () => {
    const t = await ownNumber({ token: 'BROKEN', over: { 'whatsapp.tokenIsValid': false } });
    await inCtx(t, () => wa.sendOtpTemplate('15551230013', '654321'));
    expect(messages()).toHaveLength(1);
    expect(messages()[0].url).toBe(`https://graph.facebook.com/v25.0/${PLATFORM_PHONE}/messages`);
  });

  test('with no context at all (the real OTP request) it is the platform number', async () => {
    await wa.sendOtpTemplate('15551230014', '111222');
    expect(messages()[0].url).toBe(`https://graph.facebook.com/v25.0/${PLATFORM_PHONE}/messages`);
  });
});

describe('templates use the customer\'s WABA and token', () => {
  test('create*Template / createTemplate / list / get / delete go to the customer\'s WABA with its token', async () => {
    const t = await ownNumber({ token: 'TENANT_TOKEN_TPL', waba: 'TENANT_WABA_TPL' });
    state.templatePages.TENANT_WABA_TPL = [[{ name: 'only_in_tenant_waba', status: 'APPROVED' }]];
    await inCtx(t, async () => {
      await wa.createPromoTemplate(); await wa.createLoyaltyTemplate(); await wa.createWinbackTemplate(); await wa.createPostPurchaseTemplate();
      await wa.createPointsNudgeTemplate(); await wa.createNoShowTemplate(); await wa.createConsentRequestTemplate(); await wa.createOtpTemplate();
      await wa.createInviteTemplate(); await wa.createTemplate('custom_one', 'Hi {{1}}, hello', 'UTILITY', ['Yes']);
      expect(await wa.getWabaId()).toBe('TENANT_WABA_TPL');
      expect((await wa.listTemplates()).map((x) => x.name)).toEqual(['only_in_tenant_waba']);
      expect(await wa.getTemplate('only_in_tenant_waba')).toMatchObject({ status: 'APPROVED' });
      expect(await wa.getTemplate('missing_one')).toBeNull();
      await wa.deleteTemplate('only_in_tenant_waba');
    });
    expect(templateCreates()).toHaveLength(10);
    for (const c of calls) {
      expect(c.auth).toBe(bearer('TENANT_TOKEN_TPL'));
      expect(c.url).toContain('/TENANT_WABA_TPL/message_templates');
    }
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del.params).toEqual({ name: 'only_in_tenant_waba' });
  });

  test('platform request shapes stay exactly as before: list, get, create, delete', async () => {
    state.templatePages[PLATFORM_WABA] = [[{ name: 'waflow_promo_v2' }]];
    await wa.listTemplates();
    await wa.getTemplate('waflow_promo_v2');
    await wa.createLoyaltyTemplate();
    await wa.deleteTemplate('old_one');
    const [list, get, create, del] = calls;
    const listUrl = `https://graph.facebook.com/v25.0/${PLATFORM_WABA}/message_templates`;
    expect(list).toMatchObject({ method: 'GET', url: listUrl, auth: bearer(PLATFORM_TOKEN), contentType: 'application/json' });
    expect(list.params).toEqual({ limit: 100, fields: 'name,status,category,language,components,rejected_reason,quality_score' });
    expect(get).toMatchObject({ method: 'GET', url: listUrl });
    expect(get.params).toEqual(list.params);
    expect(create).toMatchObject({ method: 'POST', url: listUrl, auth: bearer(PLATFORM_TOKEN) });
    expect(create.body).toEqual({
      name: 'waflow_loyalty', language: 'en', category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'Hi {{1}}! 💎 You have *{{2}} loyalty points* worth {{3}} {{4}}.\n\nPop in and use them on your next purchase — we\'d love to see you! 🛍️', example: { body_text: [['Sarah', 'Blue T-Shirt', '20', 'SAR 45.00']] } },
        { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
      ],
    });
    expect(del).toMatchObject({ method: 'DELETE', url: listUrl, auth: bearer(PLATFORM_TOKEN) });
    expect(del.params).toEqual({ name: 'old_one' });
    expect(calls).toHaveLength(4); // getTemplate found it on the first page: no further request
  });

  test('createTemplate: footer and language default to today\'s values and can be overridden (omitting the footer too)', async () => {
    await wa.createTemplate('t_default', 'Hello {{1}} there', 'MARKETING', ['A', 'B']);
    await wa.createTemplate('t_custom', 'Hello {{1}} there', 'MARKETING', ['A'], { footer: 'Custom footer', language: 'ar' });
    await wa.createTemplate('t_nofooter', 'Hello {{1}} there', 'UTILITY', [], { footer: null });
    await wa.createTemplate('t_langonly', 'Hello {{1}} there', 'UTILITY', [], { language: 'en_GB' });
    const [d, c, n, l] = templateCreates().map((x) => x.body);
    expect(d).toEqual({
      name: 't_default', language: 'en', category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'Hello {{1}} there', example: { body_text: [['Sarah']] } },
        { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'A' }, { type: 'QUICK_REPLY', text: 'B' }] },
      ],
    });
    expect(c.language).toBe('ar');
    expect(c.components[1]).toEqual({ type: 'FOOTER', text: 'Custom footer' });
    expect(n.components.map((x) => x.type)).toEqual(['BODY']);
    expect(l.language).toBe('en_GB');
    expect(l.components[1]).toEqual({ type: 'FOOTER', text: 'Reply STOP to unsubscribe' });
  });

  test('sendCustomFlowTemplate: language defaults to en and can be set', async () => {
    await wa.sendCustomFlowTemplate('15551230020', 'tpl_a', ['Sam'], ['p0', 'p1']);
    await wa.sendCustomFlowTemplate('15551230021', 'tpl_b', ['Sam'], ['p0'], { language: 'ar' });
    await wa.sendCustomFlowTemplate('15551230022', 'tpl_c', ['Sam'], [], {});
    const m = messages().map((c) => c.body);
    expect(m[0].template.language).toEqual({ code: 'en' });
    expect(m[0].template.components[1]).toEqual({ type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'p0' }] });
    expect(m[1].template.language).toEqual({ code: 'ar' });
    expect(m[2].template.language).toEqual({ code: 'en' });
  });

  test('the "known template" caches are per WABA: a template present in one WABA is not assumed present in another', async () => {
    const t1 = await ownNumber({ token: 'T1', waba: 'WABA_ONE' });
    const t2 = await ownNumber({ token: 'T2', waba: 'WABA_TWO' });
    state.templatePages[PLATFORM_WABA] = [[{ name: 'waflow_loyalty' }]]; // exists on the platform WABA only
    state.templatePages.WABA_ONE = [[]];
    state.templatePages.WABA_TWO = [[]];

    await wa.sendLoyaltyTemplate('15551230030', 'Sam', 100); // platform: found, cached
    expect(templateCreates()).toHaveLength(0);

    await inCtx(t1, () => wa.sendLoyaltyTemplate('15551230031', 'Sam', 100)); // WABA_ONE: missing -> created THERE with ITS token
    expect(templateCreates().map((c) => [wabaOf(c), c.auth])).toEqual([['WABA_ONE', bearer('T1')]]);

    const before = calls.length;
    await inCtx(t1, () => wa.sendLoyaltyTemplate('15551230032', 'Sam', 100)); // cached for WABA_ONE: only the send
    expect(calls.length - before).toBe(1);

    await inCtx(t2, () => wa.sendLoyaltyTemplate('15551230033', 'Sam', 100)); // WABA_TWO has its own empty list: created there
    expect(templateCreates().map((c) => wabaOf(c))).toEqual(['WABA_ONE', 'WABA_TWO']);

    const b2 = calls.length;
    await wa.sendLoyaltyTemplate('15551230034', 'Sam', 100); // platform still cached
    expect(calls.length - b2).toBe(1);

    const sends = messages();
    expect(sends.map((c) => phoneIdOf(c))).toEqual([PLATFORM_PHONE, t1.phoneId, t1.phoneId, t2.phoneId, PLATFORM_PHONE]);
  });

  test('the carousel template cache is per WABA too, and its creation + resumable upload use the customer\'s token and WABA', async () => {
    const t1 = await ownNumber({ token: 'CAR_T1', waba: 'CAR_WABA_1' });
    state.templatePages[PLATFORM_WABA] = [[{ name: 'waflow_carousel_2' }]];
    state.templatePages.CAR_WABA_1 = [[]];

    await carousel.ensureCarouselTemplateExists(2, ['https://img.example.test/a.png']); // platform: exists
    expect(templateCreates()).toHaveLength(0);
    await inCtx(t1, () => carousel.ensureCarouselTemplateExists(2, ['https://img.example.test/a.png'])); // CAR_WABA_1: created
    const created = templateCreates();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ auth: bearer('CAR_T1') });
    expect(wabaOf(created[0])).toBe('CAR_WABA_1');
    // resumable upload (2 cards -> 2 sessions) used the customer's token both ways
    const starts = calls.filter((c) => /\/APPID_ITEST\/uploads$/.test(c.url));
    expect(starts).toHaveLength(2);
    expect(starts.every((c) => c.params.access_token === 'CAR_T1')).toBe(true);
    const puts = calls.filter((c) => /\/upload:session1$/.test(c.url));
    expect(puts.every((c) => c.auth === 'OAuth CAR_T1')).toBe(true);
    // and the second call is cached for that WABA
    const n = calls.length;
    await inCtx(t1, () => carousel.ensureCarouselTemplateExists(2, ['https://img.example.test/a.png']));
    expect(calls.length).toBe(n);
  });

  test('the carousel module on the platform sender: same requests as before (platform token everywhere)', async () => {
    state.templatePages[PLATFORM_WABA] = [[]];
    await carousel.createCarouselTemplate(2, ['https://img.example.test/a.png']);
    const starts = calls.filter((c) => /\/APPID_ITEST\/uploads$/.test(c.url));
    expect(starts[0].params).toMatchObject({ file_type: 'image/png', access_token: PLATFORM_TOKEN });
    const create = templateCreates()[0];
    expect(create.url).toBe(`https://graph.facebook.com/v25.0/${PLATFORM_WABA}/message_templates`);
    expect(create.auth).toBe(bearer(PLATFORM_TOKEN));
    expect(create.contentType).toBe('application/json');
  });

  test('a customer with its own token and no stored WABA: the WABA is read from ITS number with ITS token (not the platform WABA)', async () => {
    const t = await ownNumber({ token: 'NO_WABA_TOKEN' });
    await Workspace.updateOne({ _id: t.workspaceId }, { $unset: { 'whatsapp.wabaId': '' } });
    waTenant.invalidate(t.id);
    await inCtx(t, () => wa.listTemplates());
    const lookup = calls[0];
    expect(lookup).toMatchObject({ method: 'GET', url: `https://graph.facebook.com/v25.0/${t.phoneId}`, auth: bearer('NO_WABA_TOKEN') });
    expect(calls[1].url).toBe(`https://graph.facebook.com/v25.0/WABA_OF_${t.phoneId}/message_templates`);
    expect(calls[1].url).not.toContain(PLATFORM_WABA);
  });
});

describe('template list paging', () => {
  test('without paging.next exactly ONE request is made (the old behaviour)', async () => {
    state.templatePages[PLATFORM_WABA] = [[{ name: 'a' }, { name: 'b' }]];
    expect((await wa.listTemplates()).map((x) => x.name)).toEqual(['a', 'b']);
    expect(calls).toHaveLength(1);
  });

  test('with paging.next the following pages are fetched, in order, with the same token', async () => {
    state.templatePages[PLATFORM_WABA] = [[{ name: 'p0a' }], [{ name: 'p1a' }], [{ name: 'p2a' }]];
    expect((await wa.listTemplates()).map((x) => x.name)).toEqual(['p0a', 'p1a', 'p2a']);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.auth)).toEqual(Array(3).fill(bearer(PLATFORM_TOKEN)));
    expect(calls[1].url).toContain('page=1');
    expect(calls[2].url).toContain('page=2');
  });

  test('getTemplate finds a template beyond the first page and stops as soon as it has it', async () => {
    state.templatePages[PLATFORM_WABA] = [[{ name: 'p0a' }], [{ name: 'target', status: 'PENDING' }], [{ name: 'never_fetched' }]];
    expect(await wa.getTemplate('target')).toMatchObject({ status: 'PENDING' });
    expect(calls).toHaveLength(2);
    expect(await wa.getTemplate('absent')).toBeNull();
  });

  test('a paging.next that does not point at Graph is never followed (the token must not travel elsewhere)', async () => {
    state.nextHost = 'evil.example.test';
    state.templatePages[PLATFORM_WABA] = [[{ name: 'a' }], [{ name: 'b' }]];
    expect((await wa.listTemplates()).map((x) => x.name)).toEqual(['a']);
    expect(calls).toHaveLength(1);
  });

  test('listTemplates({ name }) adds the Graph name filter; plain listTemplates() does not', async () => {
    await wa.listTemplates({ name: 'waflow_flow_abc' });
    await wa.listTemplates();
    expect(calls[0].params).toEqual({ limit: 100, fields: 'name,status,category,language,components,rejected_reason,quality_score', name: 'waflow_flow_abc' });
    expect(calls[1].params.name).toBeUndefined();
  });
});

describe('media upload', () => {
  test('uploadFileBuffer / uploadMediaFromUrl use the customer\'s phone id and token', async () => {
    const t = await ownNumber({ token: 'MEDIA_TOKEN' });
    const ids = await inCtx(t, async () => [
      await wa.uploadFileBuffer(Buffer.from('abc'), 'a.png', 'image/png'),
      await wa.uploadMediaFromUrl('https://img.example.test/p.png'),
    ]);
    expect(ids).toEqual([`media_${t.phoneId}`, `media_${t.phoneId}`]);
    const uploads = calls.filter((c) => /\/media$/.test(c.url));
    expect(uploads).toHaveLength(2);
    for (const u of uploads) {
      expect(u.url).toBe(`https://graph.facebook.com/v25.0/${t.phoneId}/media`);
      expect(u.auth).toBe(bearer('MEDIA_TOKEN'));
      expect(u.body).toBe('<formdata>');
    }
    // the image itself is fetched without any WhatsApp credential
    const download = calls.find((c) => c.url === 'https://img.example.test/p.png');
    expect(download.auth).toBeNull();
  });

  test('on the platform sender the upload is exactly what it was (platform phone id + token)', async () => {
    const id = await wa.uploadFileBuffer(Buffer.from('abc'), 'a.png', 'image/png');
    expect(id).toBe(`media_${PLATFORM_PHONE}`);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `https://graph.facebook.com/v25.0/${PLATFORM_PHONE}/media`, auth: bearer(PLATFORM_TOKEN) });
  });
});

describe('the wa.me number of referral and Instagram links is per customer', () => {
  async function referralFor(workspaceId) {
    const promo = await ReferralPromotion.create({ workspaceId, name: 'Refer', status: 'active' });
    const code = fx.uniq().replace(/[^a-z0-9]/gi, '').slice(0, 10).toUpperCase().padEnd(10, 'A');
    await ReferralCode.create({ workspaceId, referralPromotionId: promo._id, code, shortUrl: `https://x.test/c/${code}` });
    return code;
  }
  async function trackingFor(workspaceId) {
    const post = await InstagramPost.create({ workspaceId, socialAccountId: new mongoose.Types.ObjectId(), name: 'Post', promotionCode: `IG-${fx.uniq()}` });
    const code = `trk${fx.uniq()}`;
    await TrackingLink.create({ workspaceId, instagramPostId: post._id, code, shortUrl: `https://x.test/t/${code}` });
    return code;
  }
  const referrals = require('../../../shared/referrals');
  const instagram = require('../../../shared/instagram');

  test('a customer with a saved display number: the link points to ITS number, with no Graph call at all', async () => {
    const t = await ownNumber({ token: 'REF_T', display: '+966 50 123 4567' });
    const r = await referrals.recordClickAndGetRedirect({ code: await referralFor(t.workspaceId), source: 'qr', medium: 'qr_code' });
    expect(r.waLink.startsWith('https://wa.me/966501234567?text=')).toBe(true);
    const ig = await instagram.recordClickAndGetRedirect({ code: await trackingFor(t.workspaceId) });
    expect(ig.waLink.startsWith('https://wa.me/966501234567?text=')).toBe(true);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0);
  });

  test('a customer with its own number but no saved display number: read once from Graph with ITS phone id and token, then cached', async () => {
    const t = await ownNumber({ token: 'REF_T2' });
    const code = await referralFor(t.workspaceId);
    const r1 = await referrals.recordClickAndGetRedirect({ code });
    expect(r1.waLink.startsWith('https://wa.me/97140000000?text=')).toBe(true);
    const lookups = calls.filter((c) => c.method === 'GET');
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toMatchObject({ url: `https://graph.facebook.com/v25.0/${t.phoneId}`, auth: bearer('REF_T2') });
    await referrals.recordClickAndGetRedirect({ code });
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  test('a customer without its own number keeps the platform number lookup exactly as before (platform phone id + token)', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const ig = await instagram.recordClickAndGetRedirect({ code: await trackingFor(ws.workspaceId) });
    expect(ig.waLink).toBeTruthy();
    const lookup = calls.find((c) => c.method === 'GET' && c.params && c.params.fields === 'display_phone_number');
    if (lookup) expect(lookup).toMatchObject({ url: `https://graph.facebook.com/v25.0/${PLATFORM_PHONE}`, auth: bearer(PLATFORM_TOKEN) });
  });

  test('a customer whose own number is broken gets NO link (never a link to the platform number)', async () => {
    const t = await ownNumber({ token: 'BROKEN_REF', over: { 'whatsapp.tokenIsValid': false } });
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {}); // the expected "could not resolve" log lines
    const r = await referrals.recordClickAndGetRedirect({ code: await referralFor(t.workspaceId) });
    expect(r.waLink).toBeNull();
    const ig = await instagram.recordClickAndGetRedirect({ code: await trackingFor(t.workspaceId) });
    expect(ig.waLink).toBeNull();
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0);
    expect(quiet).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
  });
});

describe('/api/whatsapp route gating (only when SUPER_ADMIN_CONTACTS is configured)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp', requireAuth, require('../../../routes/whatsapp'));
  const as = (ws, role = 'owner') => ({ Authorization: `Bearer ${fx.tokenFor({ userId: ws.user._id, workspaceId: ws.workspaceId, role })}` });
  let staff; let owner; let tenantOwner; let inPlatformWaba;
  const savedContacts = process.env.SUPER_ADMIN_CONTACTS;

  beforeAll(async () => {
    staff = await fx.makeWorkspace({ arabic: false });
    owner = await fx.makeWorkspace({ arabic: false });
    tenantOwner = await ownNumber({ token: 'ROUTE_TENANT_TOKEN', waba: 'ROUTE_TENANT_WABA' });
    inPlatformWaba = await fx.makeWorkspace({ arabic: false });
    await Workspace.updateOne({ _id: inPlatformWaba.workspaceId }, { $set: { 'whatsapp.phoneId': nextPhoneId() } });
    waTenant.invalidate(String(inPlatformWaba.workspaceId));
  });
  afterEach(() => { if (savedContacts === undefined) delete process.env.SUPER_ADMIN_CONTACTS; else process.env.SUPER_ADMIN_CONTACTS = savedContacts; });
  const configure = () => { process.env.SUPER_ADMIN_CONTACTS = staff.user.email; };

  // No super admins configured (the setup before customers are onboarded): the OLDEST workspace is the account that owned the
  // platform, so its people keep everything they had; a customer's workspace is just a customer.
  const asOldest = async (role = 'owner') => {
    const oldest = await Workspace.findOne().sort({ createdAt: 1 }).select('_id').lean();
    return { Authorization: `Bearer ${fx.tokenFor({ userId: owner.user._id, workspaceId: oldest._id, role })}` };
  };

  test('legacy: with no super admins configured the OLDEST workspace\'s people can still create and delete templates (unchanged for the platform owner)', async () => {
    delete process.env.SUPER_ADMIN_CONTACTS;
    const created = await request(app).post('/api/whatsapp/create-promo-template').set(await asOldest());
    expect(created.status).toBe(200);
    const del = await request(app).delete('/api/whatsapp/templates/old_one').set(await asOldest('member'));
    expect(del.status).toBe(200);
    expect(calls.filter((c) => c.method === 'POST' || c.method === 'DELETE')).toHaveLength(2);
    expect(calls.every((c) => c.auth === bearer(PLATFORM_TOKEN))).toBe(true);
  });

  test('with no super admins configured a customer\'s workspace gets NO platform rights: its owner cannot create, delete or refresh (403, nothing sent)', async () => {
    delete process.env.SUPER_ADMIN_CONTACTS;
    const oldest = await Workspace.findOne().sort({ createdAt: 1 }).select('_id').lean();
    expect(String(oldest._id)).not.toBe(String(owner.workspaceId)); // `owner` really is a customer here, not the oldest account
    for (const [method, path] of [['post', '/create-promo-template'], ['post', '/create-winback-template'], ['post', '/create-no-show-template'],
      ['delete', '/templates/waflow_login_otp'], ['post', '/refresh-token']]) {
      const res = await request(app)[method](`/api/whatsapp${path}`).set(as(owner));
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    expect(calls).toHaveLength(0);
  });

  test('with no super admins configured a customer with its OWN number and WABA may still manage its own templates (owner only)', async () => {
    delete process.env.SUPER_ADMIN_CONTACTS;
    const ok = await request(app).post('/api/whatsapp/create-loyalty-template').set(as(tenantOwner));
    expect(ok.status).toBe(200);
    expect(calls[0]).toMatchObject({ url: 'https://graph.facebook.com/v25.0/ROUTE_TENANT_WABA/message_templates', auth: bearer('ROUTE_TENANT_TOKEN') });
    reset();
    const denied = await request(app).post('/api/whatsapp/create-loyalty-template').set(as(tenantOwner, 'member'));
    expect(denied.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('an act-as session is never the "oldest workspace" staff, even inside the oldest workspace', async () => {
    delete process.env.SUPER_ADMIN_CONTACTS;
    const oldest = await Workspace.findOne().sort({ createdAt: 1 }).select('_id').lean();
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET, ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');
    const token = jwt.sign({ sub: String(owner.user._id), workspaceId: String(oldest._id), role: 'owner', sa: true, actAs: true }, JWT_SECRET, { expiresIn: '1h', issuer: ISSUER, audience: AUDIENCE });
    const res = await request(app).post('/api/whatsapp/create-promo-template').set({ Authorization: `Bearer ${token}` });
    expect([401, 403]).toContain(res.status); // rejected (the allowlist is empty, so the act-as token itself is refused) - never a template created
    expect(calls).toHaveLength(0);
  });

  test('configured: a super admin working INSIDE a customer on the shared number is not platform staff there - 403 on create, delete and refresh, nothing sent; inside a customer with its OWN number they manage that customer\'s own account', async () => {
    configure(); // so the act-as token below is accepted: the allowlist names the person
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET, ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');
    const actAs = (ws) => ({ Authorization: `Bearer ${jwt.sign({ sub: String(staff.user._id), workspaceId: String(ws.workspaceId), role: 'owner', sa: true, actAs: true }, JWT_SECRET, { expiresIn: '1h', issuer: ISSUER, audience: AUDIENCE })}` });

    // the token itself works (a read goes through), so the 403s below are the rule itself and not a rejected session
    const read = await request(app).get('/api/whatsapp/token-status').set(actAs(owner));
    expect(read.status).toBe(200);
    reset();
    for (const [method, path] of [['post', '/create-promo-template'], ['post', '/create-no-show-template'], ['delete', '/templates/waflow_login_otp'], ['post', '/refresh-token']]) {
      const res = await request(app)[method](`/api/whatsapp${path}`).set(actAs(owner));
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    expect(calls).toHaveLength(0); // not one request to Meta

    // the same person outside any customer may (platform staff), and inside a customer that has its own account they act as its owner
    expect((await request(app).delete('/api/whatsapp/templates/old_one').set(as(staff))).status).toBe(200);
    reset();
    const inOwn = await request(app).post('/api/whatsapp/create-loyalty-template').set(actAs(tenantOwner));
    expect(inOwn.status).toBe(200);
    expect(calls[0]).toMatchObject({ url: 'https://graph.facebook.com/v25.0/ROUTE_TENANT_WABA/message_templates', auth: bearer('ROUTE_TENANT_TOKEN') });
  });

  test('configured: a normal owner on the platform number may not create, delete or refresh (403, nothing sent)', async () => {
    configure();
    for (const [method, path] of [['post', '/create-promo-template'], ['post', '/create-loyalty-template'], ['post', '/create-winback-template'],
      ['post', '/create-post-purchase-template'], ['post', '/create-points-nudge-template'], ['post', '/create-no-show-template'],
      ['delete', '/templates/waflow_login_otp'], ['post', '/refresh-token']]) {
      const res = await request(app)[method](`/api/whatsapp${path}`).set(as(owner));
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    expect(calls).toHaveLength(0);
  });

  test('configured: a super admin may (platform sender, platform token)', async () => {
    configure();
    const res = await request(app).delete('/api/whatsapp/templates/old_one').set(as(staff));
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `https://graph.facebook.com/v25.0/${PLATFORM_WABA}/message_templates`, auth: bearer(PLATFORM_TOKEN) });
    const created = await request(app).post('/api/whatsapp/create-no-show-template').set(as(staff));
    expect(created.status).toBe(200);
  });

  test('configured: the owner of a customer with its OWN number may manage templates - in its own WABA with its own token; a plain member may not', async () => {
    configure();
    const ok = await request(app).post('/api/whatsapp/create-loyalty-template').set(as(tenantOwner));
    expect(ok.status).toBe(200);
    expect(calls[0]).toMatchObject({ url: 'https://graph.facebook.com/v25.0/ROUTE_TENANT_WABA/message_templates', auth: bearer('ROUTE_TENANT_TOKEN') });
    const del = await request(app).delete('/api/whatsapp/templates/x').set(as(tenantOwner));
    expect(del.status).toBe(200);
    reset();
    const denied = await request(app).post('/api/whatsapp/create-loyalty-template').set(as(tenantOwner, 'member'));
    expect(denied.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('configured: a customer whose number sits INSIDE the platform WABA gets no template rights there (it is the platform\'s account)', async () => {
    configure();
    const res = await request(app).delete('/api/whatsapp/templates/waflow_promo_v2').set(as(inPlatformWaba));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('configured: refresh-token for a customer with its own token does not touch the platform token', async () => {
    configure();
    const res = await request(app).post('/api/whatsapp/refresh-token').set(as(tenantOwner));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own access token/i);
  });

  test('configured: a broken own number answers 409 with a plain message (and no token anywhere in the response)', async () => {
    configure();
    const broken = await ownNumber({ token: 'BROKEN_ROUTE_TOKEN', over: { 'whatsapp.tokenIsValid': false } });
    const res = await request(app).get('/api/whatsapp/templates').set(as(broken));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WHATSAPP_NUMBER_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('BROKEN_ROUTE_TOKEN');
    expect(calls).toHaveLength(0);
  });

  test('configured: GET /templates for a non-admin on the platform WABA shows only the templates of the workspace\'s own message nodes; a super admin sees all', async () => {
    configure();
    state.templatePages[PLATFORM_WABA] = [[{ name: 'waflow_login_otp' }, { name: 'other_customers_template' }, { name: 'waflow_flow_mine' }, { name: 'waflow_promo_v2' }]];
    await MessageNode.create({ workspaceId: owner.workspaceId, ownerType: 'promotion', ownerId: new mongoose.Types.ObjectId(), bodyText: 'Hi', templateName: 'waflow_flow_mine', templateStatus: 'approved' });
    await MessageNode.create({ workspaceId: staff.workspaceId, ownerType: 'promotion', ownerId: new mongoose.Types.ObjectId(), bodyText: 'Hi', templateName: 'other_customers_template', templateStatus: 'approved' });
    const mine = await request(app).get('/api/whatsapp/templates').set(as(owner));
    expect(mine.status).toBe(200);
    expect(mine.body.templates.map((t) => t.name)).toEqual(['waflow_flow_mine']);
    const inWaba = await request(app).get('/api/whatsapp/templates').set(as(inPlatformWaba));
    expect(inWaba.body.templates).toEqual([]);
    const all = await request(app).get('/api/whatsapp/templates').set(as(staff));
    expect(all.body.templates.map((t) => t.name).sort()).toEqual(['other_customers_template', 'waflow_flow_mine', 'waflow_login_otp', 'waflow_promo_v2']);
    // a customer in its OWN WABA lists its own WABA unfiltered
    state.templatePages.ROUTE_TENANT_WABA = [[{ name: 'tenant_a' }, { name: 'tenant_b' }]];
    const own = await request(app).get('/api/whatsapp/templates').set(as(tenantOwner));
    expect(own.body.templates.map((t) => t.name)).toEqual(['tenant_a', 'tenant_b']);
  });

  test('legacy: with no super admins configured GET /templates is unfiltered for the OLDEST workspace, and filtered to its own message nodes for a customer', async () => {
    delete process.env.SUPER_ADMIN_CONTACTS;
    state.templatePages[PLATFORM_WABA] = [[{ name: 'a' }, { name: 'b' }, { name: 'legacy_mode_mine' }]];
    await MessageNode.create({ workspaceId: owner.workspaceId, ownerType: 'promotion', ownerId: new mongoose.Types.ObjectId(), bodyText: 'Hi', templateName: 'legacy_mode_mine', templateStatus: 'approved' });
    const platformOwner = await request(app).get('/api/whatsapp/templates').set(await asOldest());
    expect(platformOwner.body.templates.map((t) => t.name)).toEqual(['a', 'b', 'legacy_mode_mine']);
    const customer = await request(app).get('/api/whatsapp/templates').set(as(owner));
    expect(customer.status).toBe(200);
    expect(customer.body.templates.map((t) => t.name)).toEqual(['legacy_mode_mine']);
  });

  test('GET /token-status: the platform token status for everyone on the platform number; a customer\'s own token reports its saved status, never a token', async () => {
    const platform = await request(app).get('/api/whatsapp/token-status').set(as(owner));
    expect(platform.status).toBe(200);
    expect(platform.body).toEqual(tokenManager.getStatus());
    await Workspace.updateOne({ _id: tenantOwner.workspaceId }, { $set: { 'whatsapp.tokenIsValid': true, 'whatsapp.tokenCheckedAt': new Date('2026-10-01T10:00:00Z') } });
    waTenant.invalidate(tenantOwner.id);
    const own = await request(app).get('/api/whatsapp/token-status').set(as(tenantOwner));
    expect(own.body).toMatchObject({ source: 'tenant', isValid: true, checkedAt: '2026-10-01T10:00:00.000Z' });
    expect(JSON.stringify(own.body)).not.toContain('ROUTE_TENANT_TOKEN');
  });
});
