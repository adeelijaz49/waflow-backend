'use strict';
const crypto = require('crypto');
const { createFakeGraph } = require('../_fixtures');
const { createMetaGraphClient, getDefaultClient, MetaGraphError, sanitizeMessage, appSecretProof } = require('../../../shared/onboarding/metaClient');

const TOKEN = 'EAAFXTmerchantTOKEN_0123456789_abcdefghijklmnopqrstuvwxyz';
function make(graphOptions = {}, clientOptions = {}) {
  const g = createFakeGraph(graphOptions);
  const meta = createMetaGraphClient({ http: g.http, appId: g.ids.appId, appSecret: g.ids.appSecret, ...clientOptions });
  return { g, meta };
}
async function rejection(promise) {
  try { await promise; } catch (e) { return e; }
  throw new Error('expected a rejection');
}

describe('sanitizeMessage', () => {
  test('redacts tokens, bearer values, access_token=, EAA tokens, long ids and secrets', () => {
    const s = sanitizeMessage(`Bearer ${TOKEN} failed for access_token=${TOKEN}&x=1 on id 1098765432100001 EAA1234567890abcdefghij code=AQDsecret pin=123456`, ['AQDsecret']);
    expect(s).not.toContain(TOKEN);
    expect(s).not.toContain('1098765432100001');
    expect(s).not.toContain('AQDsecret');
    expect(s).not.toContain('123456');
    expect(s).not.toContain('EAA1234567890');
  });
  test('removes control and bidi characters, collapses whitespace and caps at 300 characters', () => {
    const s = sanitizeMessage(`a\u{0007}b\u{202E}c   d\n e${'x '.repeat(400)}`);
    expect(s).toMatch(/^a b c d e/);
    expect(Array.from(s).length).toBeLessThanOrEqual(300);
  });
  test('non-strings give an empty string and phone-like digit runs are hidden', () => {
    expect(sanitizeMessage(undefined)).toBe('');
    expect(sanitizeMessage({ a: 1 })).toBe('');
    expect(sanitizeMessage('call +966551234567 now')).not.toContain('966551234567');
  });
});

describe('exchangeCode', () => {
  test('GET /oauth/access_token with the app credentials as params and NO Authorization header', async () => {
    const { g, meta } = make();
    const r = await meta.exchangeCode('  CODE-ONE-VALUE ');
    expect(r).toEqual({ accessToken: g.ids.merchantToken, tokenType: 'bearer', expiresIn: 5183999 });
    const c = g.calls[0];
    expect(c.name).toBe('exchange');
    expect(c.method).toBe('GET');
    expect(c.params).toEqual({ client_id: g.ids.appId, client_secret: g.ids.appSecret, code: 'CODE-ONE-VALUE' });
    expect(c.authorization).toBeNull();
    expect(c.version).toBe('v25.0');
  });
  test('accepts a bare token string and a JSON body without expires_in', async () => {
    let { g, meta } = make({ exchangeStyle: 'text' });
    expect(await meta.exchangeCode('CODE-TEXT')).toEqual({ accessToken: g.ids.merchantToken, tokenType: null, expiresIn: null });
    ({ g, meta } = make({ exchangeStyle: 'noExpiry' }));
    expect(await meta.exchangeCode('CODE-NOEXP')).toMatchObject({ accessToken: g.ids.merchantToken, expiresIn: null });
  });
  test('redirect_uri only when ES_EXCHANGE_REDIRECT_URI is set', async () => {
    const old = process.env.ES_EXCHANGE_REDIRECT_URI;
    process.env.ES_EXCHANGE_REDIRECT_URI = 'https://app.example.test/cb';
    try {
      const { g, meta } = make({ expectRedirectUri: 'https://app.example.test/cb' });
      await meta.exchangeCode('CODE-REDIRECT');
      expect(g.calls[0].params.redirect_uri).toBe('https://app.example.test/cb');
    } finally { if (old === undefined) delete process.env.ES_EXCHANGE_REDIRECT_URI; else process.env.ES_EXCHANGE_REDIRECT_URI = old; }
    const { g, meta } = make();
    await meta.exchangeCode('CODE-NO-REDIRECT');
    expect(g.calls[0].params.redirect_uri).toBeUndefined();
  });
  test('a 400 becomes a MetaGraphError without the code or the app secret in it', async () => {
    const { g, meta } = make();
    g.scenarios.codeExpired();
    const err = await rejection(meta.exchangeCode('AQDsecretCodeValue12345'));
    expect(err).toBeInstanceOf(MetaGraphError);
    expect(err).toMatchObject({ name: 'MetaGraphError', httpStatus: 400, code: 100, kind: 'unknown', appCode: 'META_ERROR' });
    expect(JSON.stringify({ m: err.message, s: err.stack })).not.toContain('AQDsecretCodeValue12345');
    expect(err.message).not.toContain(g.ids.appSecret);
  });
  test('a used code is rejected by the fake; empty codes and missing credentials never reach the network', async () => {
    const { g, meta } = make();
    await meta.exchangeCode('CODE-TWICE');
    expect((await rejection(meta.exchangeCode('CODE-TWICE'))).httpStatus).toBe(400);
    const before = g.calls.length;
    expect((await rejection(meta.exchangeCode('   '))).kind).toBe('invalid');
    const noCreds = createMetaGraphClient({ http: g.http });
    const err = await rejection(noCreds.exchangeCode('CODE-X-123'));
    expect(err).toMatchObject({ kind: 'not_configured', appCode: 'META_NOT_CONFIGURED' });
    expect(g.calls).toHaveLength(before);
  });
});

describe('debugToken', () => {
  test('sends the app token as access_token (DEBUG_TOKEN_AUTH = query) and normalises the answer', async () => {
    const { g, meta } = make();
    const d = await meta.debugToken(g.ids.merchantToken);
    const c = g.calls[0];
    expect(c.name).toBe('debugToken');
    expect(c.params.access_token).toBe(g.ids.appToken);
    expect(c.params.input_token).toBe(g.ids.merchantToken);
    expect(c.tokenKind).toBe('app');
    expect(d).toMatchObject({ isValid: true, neverExpires: true, expiresAt: null, userId: 'SYSTEM_USER_FIXTURE_1', error: null });
    expect(d.wabaTargetIds).toEqual([g.ids.wabaId]);
    expect(d.granularScopes[0]).toEqual({ scope: 'whatsapp_business_management', targetIds: [g.ids.wabaId] });
    expect(d.dataAccessExpiresAt).toBeInstanceOf(Date);
    expect(d.is_valid).toBe(true);
  });
  test('a token that expires in the future gives a Date; an invalid token is data, not an exception', async () => {
    const { g, meta } = make({ tokenExpiresAtSec: Math.floor(Date.now() / 1000) + 5 * 86400 });
    const d = await meta.debugToken(g.ids.merchantToken);
    expect(d.expiresAt).toBeInstanceOf(Date);
    expect(d.neverExpires).toBe(false);
    g.scenarios.token190();
    const bad = await meta.debugToken(g.ids.merchantToken);
    expect(bad.isValid).toBe(false);
    expect(bad.error).toMatchObject({ code: 190, subcode: 463 });
  });
  test('several WABA targets are listed in Meta order, de-duplicated', async () => {
    const { g, meta } = make({ extraWabaIds: ['2222222222222222'] });
    expect((await meta.debugToken(g.ids.merchantToken)).wabaTargetIds).toEqual([g.ids.wabaId, '2222222222222222']);
  });
});

describe('merchant calls', () => {
  test('the merchant token is in the Authorization header only, never in the URL, params or body', async () => {
    const { g, meta } = make({ phoneStatus: 'PENDING' });
    const wabaId = g.ids.wabaId;
    const phoneId = g.ids.phoneId;
    await meta.getPhone(g.ids.merchantToken, phoneId);
    await meta.listPhones(g.ids.merchantToken, wabaId);
    await meta.registerPhone(g.ids.merchantToken, phoneId, '123456');
    await meta.subscribeApp(g.ids.merchantToken, wabaId);
    await meta.listSubscribedApps(g.ids.merchantToken, wabaId);
    await meta.getWaba(g.ids.merchantToken, wabaId);
    await meta.getBusiness(g.ids.merchantToken, g.ids.businessId);
    await meta.listTemplates(g.ids.merchantToken, wabaId);
    await meta.unsubscribeApp(g.ids.merchantToken, wabaId);
    expect(g.calls).toHaveLength(9);
    g.calls.forEach((c) => {
      expect(c.authorization).toBe(`Bearer ${g.ids.merchantToken}`);
      expect(c.tokenSource).toBe('header');
      expect(c.url).not.toContain(g.ids.merchantToken);
      expect(JSON.stringify(c.params)).not.toContain(g.ids.merchantToken);
      expect(JSON.stringify(c.data || {})).not.toContain(g.ids.merchantToken);
    });
    g.assertMerchantTokenOnly(g.ids.merchantToken);
    g.assertNeverUsedToken(g.ids.platformToken);
    expect(g.assertNoLeak([g.ids.merchantToken], [])).toBe(true);
  });
  test('wire shapes (AU4 mock contract)', async () => {
    const { g, meta } = make({ phoneStatus: 'PENDING' });
    const t = g.ids.merchantToken;
    await meta.getPhone(t, g.ids.phoneId);
    expect(g.lastCall().params.fields).toBe('id,display_phone_number,verified_name,name_status,new_display_name,new_name_status,quality_rating,code_verification_status,status,platform_type,is_on_biz_app,whatsapp_business_manager_messaging_limit,throughput');
    await meta.registerPhone(t, g.ids.phoneId, 482913);
    expect(g.lastCall()).toMatchObject({ method: 'POST', path: `${g.ids.phoneId}/register`, data: { messaging_product: 'whatsapp', pin: '482913' } });
    await meta.subscribeApp(t, g.ids.wabaId);
    expect(g.lastCall()).toMatchObject({ method: 'POST', path: `${g.ids.wabaId}/subscribed_apps` });
    expect(g.lastCall().data).toBeUndefined();
    const subs = await meta.listSubscribedApps(t, g.ids.wabaId);
    expect(subs.appIds).toEqual([g.ids.appId]);
    expect(subs.apps[0]).toMatchObject({ id: g.ids.appId, name: 'WaFlow' });
    await meta.getWaba(t, g.ids.wabaId);
    expect(g.lastCall().params.fields).toBe('id,name,currency,message_template_namespace,business_verification_status,health_status,whatsapp_business_manager_messaging_limit,ownership_type,country,status');
    const biz = await meta.getBusiness(t, g.ids.businessId);
    expect(biz.verificationStatus).toBe('verified');
    await meta.setDisplayName(t, g.ids.phoneId, '  New Cafe ');
    expect(g.lastCall()).toMatchObject({ method: 'POST', data: { new_display_name: 'New Cafe' } });
    await meta.unsubscribeApp(t, g.ids.wabaId);
    expect(g.lastCall()).toMatchObject({ method: 'DELETE', path: `${g.ids.wabaId}/subscribed_apps` });
    g.calls.forEach((c) => { expect(c.version).toBe('v25.0'); expect(c.timeout).toBe(20000); });
  });
  test('the http port receives validateStatus: () => true and the client timeout', async () => {
    const seen = [];
    const http = { request: async (cfg) => { seen.push(cfg); return { status: 200, data: { success: true }, headers: {} }; } };
    const meta = createMetaGraphClient({ http, appId: 'A', appSecret: 'S', timeoutMs: 1234 });
    await meta.subscribeApp(TOKEN, '123456');
    expect(seen[0].validateStatus()).toBe(true);
    expect(seen[0].validateStatus(500)).toBe(true);
    expect(seen[0].timeout).toBe(1234);
    expect(seen[0].url).toBe('https://graph.facebook.com/v25.0/123456/subscribed_apps');
  });
  test('normalised phone and WABA objects keep the raw Graph fields and add camelCase aliases', async () => {
    const { g, meta } = make();
    const p = await meta.getPhone(g.ids.merchantToken, g.ids.phoneId);
    expect(p).toMatchObject({ id: g.ids.phoneId, displayPhoneNumber: '+966 55 123 4567', display_phone_number: '+966 55 123 4567', last4: '4567', verifiedName: 'Acme Coffee', nameStatus: 'APPROVED', status: 'CONNECTED', platformType: 'CLOUD_API', isOnBizApp: false, messagingLimit: 'TIER_250', fieldsDegraded: false });
    const w = await meta.getWaba(g.ids.merchantToken, g.ids.wabaId);
    expect(w).toMatchObject({ businessVerificationStatus: 'verified', business_verification_status: 'verified', fieldsDegraded: false });
    expect(w.healthStatus.canSend).toBe('AVAILABLE');
    expect(w.healthStatus.entities[0]).toMatchObject({ entityType: 'WABA', canSend: 'AVAILABLE' });
    g.setHealth('BLOCKED');
    const blocked = await meta.getWaba(g.ids.merchantToken, g.ids.wabaId);
    expect(blocked.healthStatus.entities[0].errors[0]).toMatchObject({ code: 141002 });
  });
  test('listPhones returns an array (with non-enumerable rows) and tolerates a WABA with no phone', async () => {
    const { g, meta } = make();
    const rows = await meta.listPhones(g.ids.merchantToken, g.ids.wabaId);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows.rows).toBe(rows);
    expect(JSON.parse(JSON.stringify(rows))).toHaveLength(1);
    g.scenarios.finishOnlyWaba();
    expect(await meta.listPhones(g.ids.merchantToken, g.ids.wabaId)).toHaveLength(0);
  });
  test('missing name_status is tolerated (null)', async () => {
    const { g, meta } = make();
    g.scenarios.nameStatusMissing();
    const p = await meta.getPhone(g.ids.merchantToken, g.ids.phoneId);
    expect(p.nameStatus).toBeNull();
    expect(p.fieldsDegraded).toBe(false);
  });
  test('sendTemplateMessage sends the template shape and returns the message id', async () => {
    const { g, meta } = make();
    const r = await meta.sendTemplateMessage(g.ids.merchantToken, g.ids.phoneId, { to: '+966551234567', name: 'setup_test', languageCode: 'en', components: [{ type: 'body', parameters: [] }] });
    expect(r).toEqual({ messageId: 'wamid.FIXTURE0001', waId: '966551234567' });
    expect(g.lastCall().data).toEqual({ messaging_product: 'whatsapp', to: '966551234567', type: 'template', template: { name: 'setup_test', language: { code: 'en' }, components: [{ type: 'body', parameters: [] }] } });
    expect((await rejection(meta.sendTemplateMessage(g.ids.merchantToken, g.ids.phoneId, { to: 'abc', name: 'x', languageCode: 'en' }))).kind).toBe('invalid');
  });
  test('submitTemplate / getTemplate / listTemplates', async () => {
    const { g, meta } = make();
    const payload = { name: 'wf_abc123_welcome_en_v1', language: 'en', category: 'UTILITY', allow_category_change: true, components: [{ type: 'BODY', text: 'Hello {{1}}', example: { body_text: [['Sam']] } }] };
    const r = await meta.submitTemplate(g.ids.merchantToken, g.ids.wabaId, payload);
    expect(r).toMatchObject({ status: 'PENDING', category: 'UTILITY' });
    expect(g.lastCall().data).toEqual(payload);
    const dup = await rejection(meta.submitTemplate(g.ids.merchantToken, g.ids.wabaId, payload));
    expect(dup).toMatchObject({ kind: 'duplicate_template', code: 100, subcode: 2388024 });
    const one = await meta.getTemplate(g.ids.merchantToken, g.ids.wabaId, { name: payload.name, language: 'en' });
    expect(one).toMatchObject({ id: r.id, name: payload.name, status: 'PENDING', qualityScore: 'UNKNOWN' });
    expect(await meta.getTemplate(g.ids.merchantToken, g.ids.wabaId, { name: 'nope', language: 'en' })).toBeNull();
    // by id: a plain node GET with the template fields (the fake does not model template nodes, so a stub answers)
    const seen = [];
    const stub = createMetaGraphClient({ http: { request: async (cfg) => { seen.push(cfg); return { status: 200, data: { id: '1689556908129832', name: 'wf_x', language: 'en', status: 'APPROVED', category: 'UTILITY', quality_score: { score: 'GREEN' } }, headers: {} }; } }, appId: 'A', appSecret: 'S' });
    const byId = await stub.getTemplate(TOKEN, '12345', { id: '1689556908129832' });
    expect(byId).toMatchObject({ id: '1689556908129832', status: 'APPROVED', qualityScore: 'GREEN' });
    expect(seen[0].url).toBe('https://graph.facebook.com/v25.0/1689556908129832');
    expect(seen[0].params.fields).toBe('name,language,status,category,id,quality_score');
    expect(g.assertNoForeignCalls()).toBe(true);
  });
});

describe('appsecret_proof', () => {
  test('added to merchant calls when enabled (HMAC-SHA256 of the token), never to debug_token', async () => {
    const { g, meta } = make({}, { appSecretProof: true });
    await meta.getWaba(g.ids.merchantToken, g.ids.wabaId);
    await meta.debugToken(g.ids.merchantToken);
    const expected = crypto.createHmac('sha256', g.ids.appSecret).update(g.ids.merchantToken).digest('hex');
    expect(g.callsTo('getWaba')[0].params.appsecret_proof).toBe(expected);
    expect(appSecretProof(g.ids.merchantToken, g.ids.appSecret)).toBe(expected);
    expect(g.callsTo('debugToken')[0].params.appsecret_proof).toBeUndefined();
  });
  test('off by default', async () => {
    const { g, meta } = make();
    await meta.getWaba(g.ids.merchantToken, g.ids.wabaId);
    expect(g.lastCall().params.appsecret_proof).toBeUndefined();
  });
});

describe('field negotiation', () => {
  test('a 400 code 100 naming a requested field retries ONCE with the core list and flags fieldsDegraded', async () => {
    const { g, meta } = make();
    g.scenarios.fieldRejected('name_status');
    const p = await meta.getPhone(g.ids.merchantToken, g.ids.phoneId);
    expect(g.callsTo('getPhone')).toHaveLength(2);
    expect(g.callsTo('getPhone')[0].status).toBe(400);
    expect(g.callsTo('getPhone')[1].params.fields).toBe('id,display_phone_number,verified_name,quality_rating,status');
    expect(p.fieldsDegraded).toBe(true);
    expect(p.verifiedName).toBe('Acme Coffee');
    expect(p.nameStatus).toBeNull();
  });
  test('the same for getWaba and listPhones', async () => {
    const { g, meta } = make();
    g.scenarios.fieldRejected('ownership_type');
    const w = await meta.getWaba(g.ids.merchantToken, g.ids.wabaId);
    expect(w.fieldsDegraded).toBe(true);
    expect(g.callsTo('getWaba')).toHaveLength(2);
    expect(g.callsTo('getWaba')[1].params.fields).toBe('id,name,currency,business_verification_status,health_status');
    g.reset();
    g.scenarios.fieldRejected('throughput');
    const rows = await meta.listPhones(g.ids.merchantToken, g.ids.wabaId, 'id,throughput');
    expect(rows.fieldsDegraded).toBe(true);
    expect(g.callsTo('listPhones')).toHaveLength(2);
  });
  test('no retry for an unrelated 400, for a missing object (subcode 33) or when the core list itself fails', async () => {
    const { g, meta } = make();
    g.on({ name: 'getPhone' }, () => ({ status: 400, data: { error: { code: 100, message: '(#100) Tried accessing nonexisting field (something_else) on node type (Phone)' } } }), { times: 1 });
    expect((await rejection(meta.getPhone(g.ids.merchantToken, g.ids.phoneId))).code).toBe(100);
    expect(g.callsTo('getPhone')).toHaveLength(1);
    g.reset();
    const err = await rejection(meta.getPhone(g.ids.merchantToken, '999999999999'));
    expect(err).toMatchObject({ code: 100, subcode: 33 });
    expect(g.callsTo('getNode')).toHaveLength(1);
    g.reset();
    g.scenarios.fieldRejected('status'); // part of the core list: the retry fails too
    expect((await rejection(meta.getPhone(g.ids.merchantToken, g.ids.phoneId))).code).toBe(100);
    expect(g.callsTo('getPhone')).toHaveLength(2);
  });
  test('an explicit core field list is never retried', async () => {
    const { g, meta } = make();
    g.scenarios.fieldRejected('quality_rating');
    await rejection(meta.getPhone(g.ids.merchantToken, g.ids.phoneId, 'id,display_phone_number,verified_name,quality_rating,status'));
    expect(g.callsTo('getPhone')).toHaveLength(1);
  });
});

describe('paging.next stays on the Graph origin', () => {
  async function withTemplates(graphOptions) {
    const { g, meta } = make(graphOptions);
    for (let i = 0; i < 3; i += 1) {
      await meta.submitTemplate(g.ids.merchantToken, g.ids.wabaId, { name: `wf_t${i}`, language: 'en', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello' }] });
    }
    return { g, meta };
  }
  test('follows paging.next on graph.facebook.com and returns every page', async () => {
    const { g, meta } = await withTemplates({});
    const rows = await meta.listTemplates(g.ids.merchantToken, g.ids.wabaId, { limit: 1 });
    expect(rows).toHaveLength(3);
    expect(rows.truncated).toBe(false);
    expect(rows.summary).toMatchObject({ message_template_limit: 250 });
    expect(g.callsTo('listTemplates').filter((c) => c.viaPaging)).toHaveLength(2);
    g.assertNoForeignCalls();
  });
  test('a foreign paging.next is rejected: no request leaves for it, the result is flagged truncated', async () => {
    const { g, meta } = await withTemplates({ pagingOrigin: 'https://evil.example.test' });
    const rows = await meta.listTemplates(g.ids.merchantToken, g.ids.wabaId, { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows.truncated).toBe(true);
    expect(g.foreignCalls()).toHaveLength(0);
    g.assertNoForeignCalls();
  });
  test('a token embedded in paging.next is stripped and the header is used instead', async () => {
    const { g, meta } = await withTemplates({ pagingNextIncludesToken: true });
    await meta.listTemplates(g.ids.merchantToken, g.ids.wabaId, { limit: 1 });
    g.callsTo('listTemplates').filter((c) => c.viaPaging === false || c.params.after).forEach((c) => {
      expect(c.url).not.toContain(g.ids.merchantToken);
      expect(c.params.access_token).toBeUndefined();
      expect(c.authorization).toBe(`Bearer ${g.ids.merchantToken}`);
    });
    expect(g.callsTo('listTemplates').length).toBeGreaterThanOrEqual(3);
  });
  test('maxPages bounds the walk', async () => {
    const { g, meta } = await withTemplates({});
    const rows = await meta.listTemplates(g.ids.merchantToken, g.ids.wabaId, { limit: 1, maxPages: 2 });
    expect(rows).toHaveLength(2);
    expect(rows.truncated).toBe(true);
  });
});

describe('failures', () => {
  test('133016 on register carries the register_rate kind and never the PIN', async () => {
    const { g, meta } = make({ phoneStatus: 'PENDING' });
    g.scenarios.register133016();
    const err = await rejection(meta.registerPhone(g.ids.merchantToken, g.ids.phoneId, '654321'));
    expect(err).toMatchObject({ httpStatus: 400, code: 133016, kind: 'register_rate', appCode: 'CONNECT_REGISTER_RATE_LIMITED', retryable: false });
    expect(`${err.message} ${err.stack}`).not.toContain('654321');
    expect(err.fbtraceId).toBe('FakeTrace133016');
  });
  test('190 is a reconnect error; 200 a permission error; 17 retryable', async () => {
    const { g, meta } = make();
    g.scenarios.token190({ times: 1 });
    expect(await rejection(meta.getWaba(g.ids.merchantToken, g.ids.wabaId))).toMatchObject({ code: 190, subcode: 463, kind: 'reconnect', appCode: 'META_TOKEN_REVOKED' });
    g.scenarios.permissionMissing(200);
    expect((await rejection(meta.getWaba(g.ids.merchantToken, g.ids.wabaId))).kind).toBe('permission');
    g.scenarios.rateLimited(17);
    expect(await rejection(meta.getWaba(g.ids.merchantToken, g.ids.wabaId))).toMatchObject({ kind: 'retry', retryable: true });
  });
  test('network failures become kind network / META_UNREACHABLE', async () => {
    const { g, meta } = make();
    for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED']) {
      g.scenarios.networkDrop({ code });
      const err = await rejection(meta.getWaba(g.ids.merchantToken, g.ids.wabaId));
      expect(err).toMatchObject({ kind: 'network', appCode: 'META_UNREACHABLE', retryable: true, networkCode: code, httpStatus: null });
    }
    const raw = createMetaGraphClient({ http: { request: async () => { throw { code: 'WEIRD', message: `socket failed for ${TOKEN}` }; } }, appId: 'A', appSecret: 'S' }); // eslint-disable-line no-throw-literal
    const err = await rejection(raw.getWaba(TOKEN, '12345'));
    expect(err.kind).toBe('network');
    expect(err.message).not.toContain(TOKEN);
  });
  test('Graph error text is sanitised: tokens, long ids and the call secrets never survive', async () => {
    const hostile = `Invalid token ${TOKEN} for object 1098765432100001 phone +966551234567`;
    const http = { request: async () => ({ status: 400, data: { error: { code: 100, message: hostile, fbtrace_id: 'ABC123' } }, headers: {} }) };
    const meta = createMetaGraphClient({ http, appId: 'A', appSecret: 'S' });
    const err = await rejection(meta.getWaba(TOKEN, '12345'));
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain('1098765432100001');
    expect(err.message).not.toContain('966551234567');
    expect(err.fbtraceId).toBe('ABC123');
    // an invalid trace id is dropped
    const http2 = { request: async () => ({ status: 500, data: { error: { code: 1, message: 'x', fbtrace_id: 'bad trace id with spaces' } }, headers: {} }) };
    const err2 = await rejection(createMetaGraphClient({ http: http2, appId: 'A', appSecret: 'S' }).getWaba(TOKEN, '12345'));
    expect(err2.fbtraceId).toBeNull();
    expect(err2).toMatchObject({ httpStatus: 500, kind: 'unknown', retryable: true });
  });
  test('a non-JSON 5xx still gives a MetaGraphError', async () => {
    const meta = createMetaGraphClient({ http: { request: async () => ({ status: 502, data: '<html>bad gateway</html>', headers: {} }) }, appId: 'A', appSecret: 'S' });
    const err = await rejection(meta.subscribeApp(TOKEN, '12345'));
    expect(err).toMatchObject({ httpStatus: 502, code: null, kind: 'unknown', appCode: 'META_ERROR', retryable: true });
  });
  test('success:false is an error; a body without success is accepted', async () => {
    const meta = createMetaGraphClient({ http: { request: async () => ({ status: 200, data: { success: false }, headers: {} }) }, appId: 'A', appSecret: 'S' });
    expect((await rejection(meta.subscribeApp(TOKEN, '12345'))).name).toBe('MetaGraphError');
  });
});

describe('input validation (nothing reaches the network)', () => {
  test('bad ids, tokens, pins and names are refused locally', async () => {
    const { g, meta } = make();
    const t = g.ids.merchantToken;
    for (const id of ['../oauth/access_token', 'a/b', '', 'x'.repeat(80), undefined, null, { a: 1 }]) {
      expect((await rejection(meta.getWaba(t, id))).kind).toBe('invalid');
    }
    for (const token of [undefined, '', 'short', 12345]) expect((await rejection(meta.getWaba(token, '12345'))).kind).toBe('invalid');
    for (const pin of ['12345', '1234567', 'abcdef', '', undefined, '12 456']) expect((await rejection(meta.registerPhone(t, '12345', pin))).kind).toBe('invalid');
    for (const name of ['', '   ', 'x'.repeat(600), undefined]) expect((await rejection(meta.setDisplayName(t, '12345', name))).kind).toBe('invalid');
    expect((await rejection(meta.submitTemplate(t, '12345', null))).kind).toBe('invalid');
    expect((await rejection(meta.getTemplate(t, '12345', {}))).kind).toBe('invalid');
    expect(g.calls).toHaveLength(0);
  });
});

describe('no logging, lazy defaults, default client', () => {
  test('the client never writes to the console, even on failures', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    try {
      const { g, meta } = make();
      g.scenarios.codeExpired();
      await rejection(meta.exchangeCode('CODE-FOR-LOG-TEST'));
      g.scenarios.token190({ times: 1 });
      await rejection(meta.getWaba(g.ids.merchantToken, g.ids.wabaId));
      await meta.getWaba(g.ids.merchantToken, g.ids.wabaId);
      spies.forEach((s) => expect(s).not.toHaveBeenCalled());
    } finally { spies.forEach((s) => s.mockRestore()); }
  });
  test('createMetaGraphClient needs no http at creation time (lazy default) and exposes the app id', () => {
    const meta = createMetaGraphClient({ appId: 'APP1', appSecret: 'S' });
    expect(meta.appId).toBe('APP1');
    expect(typeof meta.exchangeCode).toBe('function');
    for (const m of ['exchangeCode', 'debugToken', 'getPhone', 'listPhones', 'registerPhone', 'subscribeApp', 'listSubscribedApps', 'unsubscribeApp', 'getWaba', 'getBusiness', 'setDisplayName', 'submitTemplate', 'listTemplates', 'getTemplate', 'sendTemplateMessage']) {
      expect(typeof meta[m]).toBe('function');
    }
  });
  test('getDefaultClient reads the environment lazily and rebuilds when it changes', () => {
    const keep = { a: process.env.META_ES_APP_ID, s: process.env.WA_APP_SECRET, m: process.env.META_ES_APP_SECRET };
    delete process.env.META_ES_APP_SECRET;
    process.env.META_ES_APP_ID = 'APP-ENV-1';
    process.env.WA_APP_SECRET = 'secret-env-1';
    try {
      const a = getDefaultClient();
      expect(a.appId).toBe('APP-ENV-1');
      expect(getDefaultClient()).toBe(a);
      process.env.WA_APP_SECRET = 'secret-env-2';
      expect(getDefaultClient()).not.toBe(a);
    } finally {
      for (const [k, v] of [['META_ES_APP_ID', keep.a], ['WA_APP_SECRET', keep.s], ['META_ES_APP_SECRET', keep.m]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});
