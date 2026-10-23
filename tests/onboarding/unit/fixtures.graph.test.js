'use strict';
// Unit tests for tests/onboarding/_fixtures/fakeGraph.js: the fake behaves exactly as documented.
// Pure, no DB, no network.

const { createFakeGraph, graphError, GRAPH_ORIGIN } = require('../_fixtures');

const BASE = GRAPH_ORIGIN + '/v25.0/';

function make(options) { return createFakeGraph(options); }

async function req(fake, method, path, { params, data, token, headers } = {}) {
  const h = Object.assign({}, headers || {});
  if (token) h.Authorization = 'Bearer ' + token;
  return fake.http.request({ method, url: BASE + path, params, data, headers: h, timeout: 20000, validateStatus: () => true });
}

describe('fakeGraph: happy path (default = healthy connected merchant)', () => {
  test('the whole connect sequence works end to end with the merchant token', async () => {
    const g = make();
    const { ids } = g;

    const ex = await req(g, 'GET', 'oauth/access_token', { params: { client_id: ids.appId, client_secret: ids.appSecret, code: 'ABC123CODE' } });
    expect(ex.status).toBe(200);
    expect(ex.data).toEqual({ access_token: ids.merchantToken, token_type: 'bearer', expires_in: 5183999 });
    expect(ex.headers['content-type']).toMatch(/json/);

    const dbg = await req(g, 'GET', 'debug_token', { params: { input_token: ids.merchantToken }, token: ids.appToken });
    expect(dbg.status).toBe(200);
    expect(dbg.data.data.is_valid).toBe(true);
    expect(dbg.data.data.expires_at).toBe(0);
    const mgmt = dbg.data.data.granular_scopes.find((s) => s.scope === 'whatsapp_business_management');
    expect(mgmt.target_ids).toEqual([ids.wabaId]);
    expect(dbg.data.data.scopes).toEqual(['whatsapp_business_management', 'whatsapp_business_messaging']);

    const phone = await req(g, 'GET', ids.phoneId, { token: ids.merchantToken, params: { fields: 'id,display_phone_number,verified_name,name_status,quality_rating,status,platform_type,is_on_biz_app,whatsapp_business_manager_messaging_limit,throughput,code_verification_status' } });
    expect(phone.status).toBe(200);
    expect(phone.data).toMatchObject({ id: ids.phoneId, display_phone_number: '+966 55 123 4567', verified_name: 'Acme Coffee', name_status: 'APPROVED', quality_rating: 'GREEN', status: 'CONNECTED', platform_type: 'CLOUD_API', is_on_biz_app: false, whatsapp_business_manager_messaging_limit: 'TIER_250', code_verification_status: 'VERIFIED' });
    expect(phone.data.throughput).toEqual({ level: 'STANDARD' });

    const list = await req(g, 'GET', ids.wabaId + '/phone_numbers', { token: ids.merchantToken, params: { fields: 'id,display_phone_number,verified_name,quality_rating,status,name_status' } });
    expect(list.data.data).toHaveLength(1);
    expect(list.data.data[0].id).toBe(ids.phoneId);
    expect(list.data.paging.cursors).toBeDefined();

    const reg = await req(g, 'POST', ids.phoneId + '/register', { token: ids.merchantToken, data: { messaging_product: 'whatsapp', pin: '123456' } });
    expect(reg.data).toEqual({ success: true });

    const sub = await req(g, 'POST', ids.wabaId + '/subscribed_apps', { token: ids.merchantToken });
    expect(sub.data).toEqual({ success: true });
    const subs = await req(g, 'GET', ids.wabaId + '/subscribed_apps', { token: ids.merchantToken });
    expect(subs.data.data[0].whatsapp_business_api_data).toMatchObject({ id: ids.appId, name: 'WaFlow' });

    const waba = await req(g, 'GET', ids.wabaId, { token: ids.merchantToken, params: { fields: 'id,name,currency,timezone_id,message_template_namespace,business_verification_status,health_status,whatsapp_business_manager_messaging_limit,ownership_type,country,status' } });
    expect(waba.data).toMatchObject({ id: ids.wabaId, currency: 'SAR', business_verification_status: 'verified', whatsapp_business_manager_messaging_limit: 'TIER_250' });
    expect(waba.data.health_status.can_send_message).toBe('AVAILABLE');
    expect(waba.data.primary_funding_id).toBeUndefined();

    const biz = await req(g, 'GET', ids.businessId, { token: ids.merchantToken, params: { fields: 'verification_status' } });
    expect(biz.data).toEqual({ verification_status: 'verified', id: ids.businessId });

    g.assertMerchantTokenOnly(ids.merchantToken);
    g.assertNeverUsedToken(ids.platformToken);
    g.assertNoForeignCalls();
  });

  test('options choose ids, display number, name_status, tier, verification and health', async () => {
    const g = make({ wabaId: 'W1', phoneId: 'P1', businessId: 'B1', displayNumber: '+966 50 000 9999', nameStatus: 'PENDING_REVIEW', tier: 'TIER_2K', verificationStatus: 'pending', health: 'LIMITED', primaryFundingId: 'FUND1', merchantToken: 'EAAcustomTokenForThisTestNotARealOne1234567890' });
    const t = g.ids.merchantToken;
    expect(t).toBe('EAAcustomTokenForThisTestNotARealOne1234567890');
    const p = await req(g, 'GET', 'P1', { token: t, params: { fields: 'display_phone_number,name_status,whatsapp_business_manager_messaging_limit' } });
    expect(p.data).toEqual({ id: 'P1', display_phone_number: '+966 50 000 9999', name_status: 'PENDING_REVIEW', whatsapp_business_manager_messaging_limit: 'TIER_2K' });
    const w = await req(g, 'GET', 'W1', { token: t, params: { fields: 'business_verification_status,health_status,primary_funding_id' } });
    expect(w.data.business_verification_status).toBe('pending');
    expect(w.data.primary_funding_id).toBe('FUND1');
    expect(w.data.health_status.can_send_message).toBe('LIMITED');
    expect(w.data.health_status.entities.find((e) => e.entity_type === 'PHONE_NUMBER').additional_info[0]).toMatch(/display name/);
  });

  test('health BLOCKED carries the documented error shape', async () => {
    const g = make({ health: 'BLOCKED' });
    const w = await req(g, 'GET', g.ids.wabaId, { token: g.ids.merchantToken, params: { fields: 'health_status' } });
    const waba = w.data.health_status.entities.find((e) => e.entity_type === 'WABA');
    expect(waba.can_send_message).toBe('BLOCKED');
    expect(waba.errors[0]).toEqual(expect.objectContaining({ error_code: 141002, error_description: expect.any(String), possible_solution: expect.any(String) }));
  });

  test('portfolio verification can differ from the WABA field', async () => {
    const g = make();
    g.setVerification('pending', { portfolio: 'not_verified' });
    const w = await req(g, 'GET', g.ids.wabaId, { token: g.ids.merchantToken, params: { fields: 'business_verification_status' } });
    const b = await req(g, 'GET', g.ids.businessId, { token: g.ids.merchantToken, params: { fields: 'verification_status' } });
    expect(w.data.business_verification_status).toBe('pending');
    expect(b.data.verification_status).toBe('not_verified');
  });

  test('client_whatsapp_business_accounts fallback lists the WABA', async () => {
    const g = make();
    const r = await req(g, 'GET', g.ids.businessId + '/client_whatsapp_business_accounts', { token: g.ids.merchantToken, params: { fields: 'id,name' } });
    expect(r.data.data[0].id).toBe(g.ids.wabaId);
  });
});

describe('fakeGraph: code exchange', () => {
  const ok = (g, code, extra) => req(g, 'GET', 'oauth/access_token', { params: Object.assign({ client_id: g.ids.appId, client_secret: g.ids.appSecret, code }, extra || {}) });

  test('bare-string and no-expires_in variants', async () => {
    const t = make({ exchangeStyle: 'text' });
    const r1 = await ok(t, 'C1CODE');
    expect(r1.status).toBe(200);
    expect(r1.data).toBe(t.ids.merchantToken);
    expect(r1.headers['content-type']).toMatch(/text\/plain/);
    const n = make({ exchangeStyle: 'noExpiry' });
    const r2 = await ok(n, 'C2CODE');
    expect(r2.data.expires_in).toBeUndefined();
    expect(r2.data.access_token).toBe(n.ids.merchantToken);
  });

  test('a code is single use, and an empty / missing code is rejected', async () => {
    const g = make();
    expect((await ok(g, 'ONCEONLY')).status).toBe(200);
    const again = await ok(g, 'ONCEONLY');
    expect(again.status).toBe(400);
    expect(again.data.error).toMatchObject({ code: 100, message: 'Invalid verification code format.' });
    expect((await ok(g, '')).status).toBe(400);
  });

  test('options.code pins the accepted code; wrong secret is rejected', async () => {
    const g = make({ code: 'THECODE' });
    expect((await ok(g, 'OTHER')).status).toBe(400);
    expect((await ok(g, 'THECODE')).status).toBe(200);
    const bad = await req(g, 'GET', 'oauth/access_token', { params: { client_id: g.ids.appId, client_secret: 'nope', code: 'THECODE' } });
    expect(bad.data.error.message).toMatch(/client secret/);
  });

  test('redirect_uri is demanded only when expectRedirectUri is set (400 100/36008)', async () => {
    const g = make({ expectRedirectUri: 'https://app.example.test/cb' });
    const miss = await ok(g, 'RC1');
    expect(miss.data.error).toMatchObject({ code: 100, error_subcode: 36008 });
    const hit = await ok(g, 'RC2', { redirect_uri: 'https://app.example.test/cb' });
    expect(hit.status).toBe(200);
    expect(g.lastCall('exchange').params.redirect_uri).toBe('https://app.example.test/cb');
  });

  test('scenario codeExpired: next exchange fails 400/100, the one after succeeds', async () => {
    const g = make();
    g.scenarios.codeExpired();
    const a = await ok(g, 'EXP1');
    expect(a.status).toBe(400);
    expect(a.data.error.code).toBe(100);
    expect(a.data.error.fbtrace_id).toBeDefined();
    expect((await ok(g, 'EXP1')).status).toBe(200);
  });

  test('scenario codeExpired({subcode36008}) uses the redirect_uri variant', async () => {
    const g = make();
    g.scenarios.codeExpired({ subcode36008: true });
    const a = await ok(g, 'EXP2');
    expect(a.data.error).toMatchObject({ code: 100, error_subcode: 36008 });
  });
});

describe('fakeGraph: debug_token', () => {
  test('unknown input token reports is_valid false with a 190 error (HTTP 200, like Graph)', async () => {
    const g = make();
    const r = await req(g, 'GET', 'debug_token', { params: { input_token: 'EAAnotOurs' }, token: g.ids.appToken });
    expect(r.status).toBe(200);
    expect(r.data.data.is_valid).toBe(false);
    expect(r.data.data.error.code).toBe(190);
  });

  test('without an app/merchant token it is a 190', async () => {
    const g = make();
    const r = await req(g, 'GET', 'debug_token', { params: { input_token: g.ids.merchantToken } });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe(190);
  });

  test('access_token query parameter works as an alternative to the header', async () => {
    const g = make();
    const r = await req(g, 'GET', 'debug_token', { params: { input_token: g.ids.merchantToken, access_token: g.ids.appToken } });
    expect(r.data.data.is_valid).toBe(true);
    expect(g.lastCall('debugToken').tokenSource).toBe('param');
  });

  test('60-day expiry, extra WABAs (most recent first) and reduced scopes', async () => {
    const g = make({ extraWabaIds: ['W_OTHER'] });
    g.setTokenExpiry(1900000000).setScopes(['whatsapp_business_messaging']);
    const r = await req(g, 'GET', 'debug_token', { params: { input_token: g.ids.merchantToken }, token: g.ids.appToken });
    expect(r.data.data.expires_at).toBe(1900000000);
    expect(r.data.data.scopes).toEqual(['whatsapp_business_messaging']);
    expect(r.data.data.granular_scopes).toEqual([{ scope: 'whatsapp_business_messaging', target_ids: [g.ids.wabaId, 'W_OTHER'] }]);
  });
});

describe('fakeGraph: phone node, field negotiation, listing', () => {
  test('options.rejectFields: 400 code 100 naming the field; the core list still works', async () => {
    const g = make({ rejectFields: ['name_status'] });
    const t = g.ids.merchantToken;
    const bad = await req(g, 'GET', g.ids.phoneId, { token: t, params: { fields: 'id,verified_name,name_status,status' } });
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe(100);
    expect(bad.data.error.message).toContain('name_status');
    const core = await req(g, 'GET', g.ids.phoneId, { token: t, params: { fields: 'id,display_phone_number,verified_name,quality_rating,status' } });
    expect(core.status).toBe(200);
    expect(core.data.status).toBe('CONNECTED');
    // listing is negotiated the same way
    const listBad = await req(g, 'GET', g.ids.wabaId + '/phone_numbers', { token: t, params: { fields: 'id,name_status' } });
    expect(listBad.data.error.message).toContain('name_status');
  });

  test('fieldRejected() scenario applies to the WABA node and templates too', async () => {
    const g = make();
    g.scenarios.fieldRejected('health_status').scenarios.fieldRejected('rejected_reason');
    const w = await req(g, 'GET', g.ids.wabaId, { token: g.ids.merchantToken, params: { fields: 'id,health_status' } });
    expect(w.data.error.message).toContain('health_status');
    const t = await req(g, 'GET', g.ids.wabaId + '/message_templates', { token: g.ids.merchantToken, params: { fields: 'name,rejected_reason' } });
    expect(t.data.error.message).toContain('rejected_reason');
  });

  test('strict fields: an unknown field is a 400 naming it (account_review_status is not a WABA field)', async () => {
    const g = make();
    const r = await req(g, 'GET', g.ids.wabaId, { token: g.ids.merchantToken, params: { fields: 'id,account_review_status' } });
    expect(r.status).toBe(400);
    expect(r.data.error.message).toContain('account_review_status');
    const lenient = make({ strictFields: false });
    const r2 = await req(lenient, 'GET', lenient.ids.wabaId, { token: lenient.ids.merchantToken, params: { fields: 'id,account_review_status' } });
    expect(r2.status).toBe(200);
  });

  test('nameStatusMissing(): name_status and new_name_status are silently absent', async () => {
    const g = make();
    g.scenarios.nameStatusMissing();
    g.setPhone({ new_display_name: 'Acme Cafe', new_name_status: 'PENDING_REVIEW' });
    const r = await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken, params: { fields: 'id,verified_name,name_status,new_display_name,new_name_status' } });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ id: g.ids.phoneId, verified_name: 'Acme Coffee', new_display_name: 'Acme Cafe' });
  });

  test('no fields param gives Graph default fields', async () => {
    const g = make();
    const r = await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken });
    expect(Object.keys(r.data).sort()).toEqual(['display_phone_number', 'id', 'quality_rating', 'verified_name']);
  });

  test('finishOnlyWaba(): the WABA has no phone numbers; addPhone() restores one', async () => {
    const g = make();
    g.scenarios.finishOnlyWaba();
    const none = await req(g, 'GET', g.ids.wabaId + '/phone_numbers', { token: g.ids.merchantToken });
    expect(none.data.data).toEqual([]);
    expect((await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken })).status).toBe(400);
    g.addPhone();
    const one = await req(g, 'GET', g.ids.wabaId + '/phone_numbers', { token: g.ids.merchantToken });
    expect(one.data.data).toHaveLength(1);
  });

  test('several phones are listed newest onboarded first', async () => {
    const g = make({ phones: [{ verified_name: 'First' }, { verified_name: 'Second' }] });
    const r = await req(g, 'GET', g.ids.wabaId + '/phone_numbers', { token: g.ids.merchantToken, params: { fields: 'id,verified_name' } });
    expect(r.data.data.map((p) => p.verified_name)).toEqual(['Second', 'First']);
  });

  test('unknown node ids answer Graph-style 400 code 100 / subcode 33', async () => {
    const g = make();
    const r = await req(g, 'GET', 'nope123', { token: g.ids.merchantToken });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatchObject({ code: 100, error_subcode: 33, type: 'GraphMethodException' });
  });

  test('missing token is code 104, platform token is 190 and is recorded as platform', async () => {
    const g = make();
    const none = await req(g, 'GET', g.ids.phoneId);
    expect(none.data.error.code).toBe(104);
    const plat = await req(g, 'GET', g.ids.phoneId, { token: g.ids.platformToken });
    expect(plat.data.error.code).toBe(190);
    expect(g.lastCall('getPhone').tokenKind).toBe('platform');
    expect(() => g.assertNeverUsedToken(g.ids.platformToken)).toThrow(/forbidden token used/);
  });
});

describe('fakeGraph: register', () => {
  test('stores a 6-digit pin, flips PENDING to CONNECTED, records the call', async () => {
    const g = make({ phoneStatus: 'PENDING' });
    const t = g.ids.merchantToken;
    const r = await req(g, 'POST', g.ids.phoneId + '/register', { token: t, data: { messaging_product: 'whatsapp', pin: '482913' } });
    expect(r.data).toEqual({ success: true });
    const p = await req(g, 'GET', g.ids.phoneId, { token: t, params: { fields: 'status' } });
    expect(p.data.status).toBe('CONNECTED');
    expect(g.lastCall('register').data).toEqual({ messaging_product: 'whatsapp', pin: '482913' });
    expect(g.state.registerCount).toBe(1);
  });

  test('rejects a bad pin or a missing messaging_product (400 code 100)', async () => {
    const g = make();
    const t = g.ids.merchantToken;
    expect((await req(g, 'POST', g.ids.phoneId + '/register', { token: t, data: { messaging_product: 'whatsapp', pin: '12' } })).data.error.code).toBe(100);
    expect((await req(g, 'POST', g.ids.phoneId + '/register', { token: t, data: { pin: '123456' } })).data.error.code).toBe(100);
  });

  test('display name status NONE cannot register', async () => {
    const g = make({ nameStatus: 'NONE', phoneStatus: 'PENDING' });
    const r = await req(g, 'POST', g.ids.phoneId + '/register', { token: g.ids.merchantToken, data: { messaging_product: 'whatsapp', pin: '123456' } });
    expect(r.status).toBe(400);
    expect(g.state.phones[0].status).toBe('PENDING');
  });

  test('register133016(): next register is 400/133016, then it works', async () => {
    const g = make();
    g.scenarios.register133016();
    const body = { messaging_product: 'whatsapp', pin: '123456' };
    const a = await req(g, 'POST', g.ids.phoneId + '/register', { token: g.ids.merchantToken, data: body });
    expect(a.data.error.code).toBe(133016);
    const b = await req(g, 'POST', g.ids.phoneId + '/register', { token: g.ids.merchantToken, data: body });
    expect(b.data).toEqual({ success: true });
  });
});

describe('fakeGraph: subscribed_apps', () => {
  test('POST / GET / DELETE round trip; default is already subscribed', async () => {
    const g = make({ subscribed: false });
    const t = g.ids.merchantToken;
    expect((await req(g, 'GET', g.ids.wabaId + '/subscribed_apps', { token: t })).data).toEqual({ data: [] });
    await req(g, 'POST', g.ids.wabaId + '/subscribed_apps', { token: t });
    expect((await req(g, 'GET', g.ids.wabaId + '/subscribed_apps', { token: t })).data.data).toHaveLength(1);
    expect((await req(g, 'DELETE', g.ids.wabaId + '/subscribed_apps', { token: t })).data).toEqual({ success: true });
    expect((await req(g, 'GET', g.ids.wabaId + '/subscribed_apps', { token: t })).data.data).toEqual([]);
    expect(make().state.subscribed.has(make().ids.wabaId)).toBe(true);
  });

  test('a body with override_callback_uri is stored and listed (so a test can prove none was sent)', async () => {
    const g = make({ subscribed: false });
    await req(g, 'POST', g.ids.wabaId + '/subscribed_apps', { token: g.ids.merchantToken, data: { override_callback_uri: 'https://x.example.test/h', verify_token: 'v' } });
    const l = await req(g, 'GET', g.ids.wabaId + '/subscribed_apps', { token: g.ids.merchantToken });
    expect(l.data.data[0].override_callback_uri).toBe('https://x.example.test/h');
    expect(g.callsTo('subscribe')[0].data.override_callback_uri).toBeDefined();
  });

  test.each([[undefined, 200], [{ code: 190 }, 190], [{ code: 100 }, 100]])('subscribeFails(%j) -> error code %i then success', async (opts, code) => {
    const g = make({ subscribed: false });
    g.scenarios.subscribeFails(opts);
    const a = await req(g, 'POST', g.ids.wabaId + '/subscribed_apps', { token: g.ids.merchantToken });
    expect(a.status).toBe(400);
    expect(a.data.error.code).toBe(code);
    expect((await req(g, 'GET', g.ids.wabaId + '/subscribed_apps', { token: g.ids.merchantToken })).data.data).toEqual([]);
    expect((await req(g, 'POST', g.ids.wabaId + '/subscribed_apps', { token: g.ids.merchantToken })).status).toBe(200);
  });

  test('an unknown WABA id is a Graph 400 code 100', async () => {
    const g = make();
    const r = await req(g, 'POST', 'W_UNKNOWN/subscribed_apps', { token: g.ids.merchantToken });
    expect(r.data.error.code).toBe(100);
  });
});

describe('fakeGraph: display name', () => {
  test('POST new_display_name -> pending; approve/decline helpers; edit limit', async () => {
    const g = make();
    const t = g.ids.merchantToken;
    expect((await req(g, 'POST', g.ids.phoneId, { token: t, data: { new_display_name: 'Acme Cafe' } })).data).toEqual({ success: true });
    const pending = await req(g, 'GET', g.ids.phoneId, { token: t, params: { fields: 'verified_name,new_display_name,new_name_status' } });
    expect(pending.data).toMatchObject({ verified_name: 'Acme Coffee', new_display_name: 'Acme Cafe', new_name_status: 'PENDING_REVIEW' });
    g.approveDisplayName();
    const done = await req(g, 'GET', g.ids.phoneId, { token: t, params: { fields: 'verified_name,name_status,new_display_name' } });
    expect(done.data).toEqual({ id: g.ids.phoneId, verified_name: 'Acme Cafe', name_status: 'APPROVED' });
    await req(g, 'POST', g.ids.phoneId, { token: t, data: { new_display_name: 'Bad Name' } });
    g.declineDisplayName();
    expect(g.state.phones[0].name_status).toBe('DECLINED');
  });

  test('empty name is 400; maxNameEdits is enforced with a generic 400', async () => {
    const g = make({ maxNameEdits: 2 });
    const t = g.ids.merchantToken;
    expect((await req(g, 'POST', g.ids.phoneId, { token: t, data: { new_display_name: '  ' } })).status).toBe(400);
    await req(g, 'POST', g.ids.phoneId, { token: t, data: { new_display_name: 'One' } });
    await req(g, 'POST', g.ids.phoneId, { token: t, data: { new_display_name: 'Two' } });
    const third = await req(g, 'POST', g.ids.phoneId, { token: t, data: { new_display_name: 'Three' } });
    expect(third.status).toBe(400);
  });
});

describe('fakeGraph: templates', () => {
  const body = (name, language, extra) => Object.assign({ name, language, category: 'UTILITY', allow_category_change: true, components: [{ type: 'BODY', text: 'Hello {{1}}', example: { body_text: [['Sara']] } }] }, extra || {});
  const create = (g, b) => req(g, 'POST', g.ids.wabaId + '/message_templates', { token: g.ids.merchantToken, data: b });

  test('create returns { id, status: PENDING, category }; list shows it with summary', async () => {
    const g = make();
    const r = await create(g, body('waflow_welcome_ar', 'ar'));
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ id: expect.stringMatching(/^\d+$/), status: 'PENDING', category: 'UTILITY' });
    const l = await req(g, 'GET', g.ids.wabaId + '/message_templates', { token: g.ids.merchantToken, params: { fields: 'name,language,status,category,id,quality_score', limit: 100 } });
    expect(l.data.data).toEqual([{ id: r.data.id, name: 'waflow_welcome_ar', language: 'ar', status: 'PENDING', category: 'UTILITY', quality_score: { score: 'UNKNOWN' } }]);
    expect(l.data.summary).toEqual({ total_count: 1, message_template_count: 1, message_template_limit: 250, are_translations_complete: false });
  });

  test('duplicate name in the same language is 400 code 100 / 2388024; another language is fine', async () => {
    const g = make();
    await create(g, body('hello_world', 'en'));
    const dup = await create(g, body('hello_world', 'en'));
    expect(dup.status).toBe(400);
    expect(dup.data.error).toMatchObject({ code: 100, error_subcode: 2388024 });
    expect((await create(g, body('hello_world', 'ar'))).status).toBe(200);
  });

  test('duplicateTemplate() forces the duplicate error once even for a fresh name', async () => {
    const g = make();
    g.scenarios.duplicateTemplate();
    expect((await create(g, body('fresh_one', 'en'))).data.error.error_subcode).toBe(2388024);
    expect((await create(g, body('fresh_one', 'en'))).status).toBe(200);
  });

  test('validation: name regex, ar_SA is not a language, category, BODY text, hyphenated language', async () => {
    const g = make();
    expect((await create(g, body('Bad-Name', 'en'))).data.error.code).toBe(100);
    expect((await create(g, body('ok_name', 'ar_SA'))).data.error.code).toBe(100);
    expect((await create(g, body('ok_name', 'en-US'))).data.error.code).toBe(100);
    expect((await create(g, body('ok_name', 'en', { category: 'PROMO' }))).data.error.code).toBe(100);
    expect((await create(g, body('ok_name', 'en', { components: [{ type: 'HEADER', text: 'x' }] }))).data.error.code).toBe(100);
    expect(g.templates()).toHaveLength(0);
  });

  test('missing whatsapp_business_management scope: create is 200 permission error', async () => {
    const g = make({ scopes: ['whatsapp_business_messaging'] });
    const r = await create(g, body('perm_test', 'en'));
    expect(r.data.error.code).toBe(200);
  });

  test('recategorized(): the response and the stored category become MARKETING', async () => {
    const g = make();
    g.scenarios.recategorized('MARKETING');
    const r = await create(g, body('promoish', 'en'));
    expect(r.data.category).toBe('MARKETING');
    expect(g.templates()[0].category).toBe('MARKETING');
    expect((await create(g, body('plain_one', 'en'))).data.category).toBe('UTILITY');
  });

  test('setTemplateStatus progression, rejected reason, status filter and webhook envelope', async () => {
    const g = make();
    await create(g, body('t_one', 'en'));
    await create(g, body('t_two', 'en'));
    g.setTemplateStatus('t_one', 'en', 'APPROVED');
    const rej = g.setTemplateStatus('t_two', 'en', 'REJECTED', 'INCORRECT_CATEGORY');
    expect(rej.rejected_reason).toBe('INCORRECT_CATEGORY');
    const approved = await req(g, 'GET', g.ids.wabaId + '/message_templates', { token: g.ids.merchantToken, params: { status: 'APPROVED', fields: 'name,status' } });
    expect(approved.data.data.map((r) => r.name)).toEqual(['t_one']);
    const withReason = await req(g, 'GET', g.ids.wabaId + '/message_templates', { token: g.ids.merchantToken, params: { status: 'REJECTED', fields: 'name,rejected_reason' } });
    expect(withReason.data.data[0].rejected_reason).toBe('INCORRECT_CATEGORY');
    expect(() => g.setTemplateStatus('t_one', 'en', 'WHATEVER')).toThrow(/unknown status/);
    expect(() => g.setTemplateStatus('missing', 'en', 'APPROVED')).toThrow(/no template/);
    const hook = g.webhook.templateStatus('t_two', 'en', 'REJECTED', 'INCORRECT_CATEGORY');
    expect(hook.entry[0]).toMatchObject({ id: g.ids.wabaId, changes: [{ field: 'message_template_status_update', value: { event: 'REJECTED', message_template_name: 't_two', reason: 'INCORRECT_CATEGORY' } }] });
    g.approveAllTemplates();
    expect(g.templates().find((t) => t.name === 't_two').status).toBe('REJECTED');
  });

  test('pagination: limit pages, paging.next points at the Graph origin and can be followed', async () => {
    const g = make();
    for (let i = 0; i < 5; i += 1) await create(g, body('tpl_' + i, 'en'));
    const p1 = await req(g, 'GET', g.ids.wabaId + '/message_templates', { token: g.ids.merchantToken, params: { limit: 2, fields: 'name' } });
    expect(p1.data.data.map((r) => r.name)).toEqual(['tpl_0', 'tpl_1']);
    expect(p1.data.paging.next.startsWith(GRAPH_ORIGIN + '/v25.0/' + g.ids.wabaId + '/message_templates?')).toBe(true);
    expect(p1.data.paging.next).not.toMatch(/access_token/);
    const p2 = await g.http.request({ method: 'GET', url: p1.data.paging.next, headers: { Authorization: 'Bearer ' + g.ids.merchantToken } });
    expect(p2.data.data.map((r) => r.name)).toEqual(['tpl_2', 'tpl_3']);
    expect(g.lastCall('listTemplates').viaPaging).toBe(true);
    const p3 = await g.http.request({ method: 'GET', url: p2.data.paging.next, headers: { Authorization: 'Bearer ' + g.ids.merchantToken } });
    expect(p3.data.data.map((r) => r.name)).toEqual(['tpl_4']);
    expect(p3.data.paging.next).toBeUndefined();
  });

  test('pagingOrigin option: a client that follows a foreign origin is recorded and gets a network error', async () => {
    const g = make({ pagingOrigin: 'https://evil.example.test' });
    for (let i = 0; i < 3; i += 1) await create(g, body('e_' + i, 'en'));
    const p1 = await req(g, 'GET', g.ids.wabaId + '/message_templates', { token: g.ids.merchantToken, params: { limit: 1 } });
    expect(p1.data.paging.next.startsWith('https://evil.example.test/')).toBe(true);
    expect(g.foreignCalls()).toHaveLength(0);
    g.assertNoForeignCalls();
    await expect(g.http.request({ method: 'GET', url: p1.data.paging.next })).rejects.toMatchObject({ code: 'ENOTFOUND' });
    expect(g.foreignCalls()).toHaveLength(1);
    expect(() => g.assertNoForeignCalls()).toThrow(/non-Graph origin/);
  });

  test('pagingNextIncludesToken puts access_token in next (as real Graph does) and the follow-up is exempt from the leak scan', async () => {
    const g = make({ pagingNextIncludesToken: true });
    for (let i = 0; i < 2; i += 1) await create(g, body('k_' + i, 'en'));
    const p1 = await req(g, 'GET', g.ids.wabaId + '/message_templates', { token: g.ids.merchantToken, params: { limit: 1 } });
    expect(p1.data.paging.next).toContain('access_token=');
    await g.http.request({ method: 'GET', url: p1.data.paging.next });
    expect(g.lastCall('listTemplates').token).toBe(g.ids.merchantToken);
    expect(g.lastCall('listTemplates').tokenSource).toBe('param');
    expect(g.findLeaks([g.ids.merchantToken].concat([]))).toEqual([]);
  });

  test('delete by name removes every language; unknown name is 400', async () => {
    const g = make();
    await create(g, body('gone_soon', 'en'));
    await create(g, body('gone_soon', 'ar'));
    const r = await req(g, 'DELETE', g.ids.wabaId + '/message_templates', { token: g.ids.merchantToken, params: { name: 'gone_soon' } });
    expect(r.data).toEqual({ success: true });
    expect(g.templates()).toHaveLength(0);
    expect((await req(g, 'DELETE', g.ids.wabaId + '/message_templates', { token: g.ids.merchantToken, params: { name: 'gone_soon' } })).status).toBe(400);
  });
});

describe('fakeGraph: messages', () => {
  const tplMsg = (to, name, lang) => ({ messaging_product: 'whatsapp', to, type: 'template', template: { name, language: { code: lang || 'en' }, components: [] } });

  test('template sends are recorded with the token used', async () => {
    const g = make();
    const r = await req(g, 'POST', g.ids.phoneId + '/messages', { token: g.ids.merchantToken, data: tplMsg('966551234567', 'hello_world') });
    expect(r.status).toBe(200);
    expect(r.data.messages[0].id).toMatch(/^wamid\./);
    expect(r.data.contacts[0]).toEqual({ input: '966551234567', wa_id: '966551234567' });
    expect(g.sentMessages()).toEqual([expect.objectContaining({ to: '966551234567', phoneId: g.ids.phoneId, token: g.ids.merchantToken, template: expect.objectContaining({ name: 'hello_world' }) })]);
  });

  test('the platform token cannot send on the merchant phone (190) and is visible to assertions', async () => {
    const g = make();
    const r = await req(g, 'POST', g.ids.phoneId + '/messages', { token: g.ids.platformToken, data: tplMsg('966551234567', 'x') });
    expect(r.data.error.code).toBe(190);
    expect(g.sentMessages()).toHaveLength(0);
    expect(g.tokensUsed().platform).toEqual([g.ids.platformToken]);
  });

  test('validation, unregistered phone, enforceApproved and paymentMissing()', async () => {
    const g = make({ enforceApproved: true });
    const t = g.ids.merchantToken;
    expect((await req(g, 'POST', g.ids.phoneId + '/messages', { token: t, data: tplMsg('abc', 'x') })).data.error.code).toBe(100);
    expect((await req(g, 'POST', g.ids.phoneId + '/messages', { token: t, data: tplMsg('966551234567', 'unknown_tpl') })).data.error.code).toBe(132001);
    await req(g, 'POST', g.ids.wabaId + '/message_templates', { token: t, data: { name: 'known_tpl', language: 'en', category: 'UTILITY', components: [{ type: 'BODY', text: 'hi' }] } });
    expect((await req(g, 'POST', g.ids.phoneId + '/messages', { token: t, data: tplMsg('966551234567', 'known_tpl') })).data.error.code).toBe(132001);
    g.setTemplateStatus('known_tpl', 'en', 'APPROVED');
    g.scenarios.paymentMissing();
    expect((await req(g, 'POST', g.ids.phoneId + '/messages', { token: t, data: tplMsg('966551234567', 'known_tpl') })).data.error.code).toBe(131042);
    expect((await req(g, 'POST', g.ids.phoneId + '/messages', { token: t, data: tplMsg('966551234567', 'known_tpl') })).status).toBe(200);
    const g2 = make({ phoneStatus: 'PENDING' });
    expect((await req(g2, 'POST', g2.ids.phoneId + '/messages', { token: g2.ids.merchantToken, data: tplMsg('966551234567', 'x') })).data.error.code).toBe(133010);
  });
});

describe('fakeGraph: request_code / verify_code', () => {
  test('SMS|VOICE then a 6-digit code', async () => {
    const g = make({ codeVerificationStatus: 'NOT_VERIFIED' });
    const t = g.ids.merchantToken;
    expect((await req(g, 'POST', g.ids.phoneId + '/request_code', { token: t, data: { code_method: 'FAX', language: 'en_US' } })).status).toBe(400);
    expect((await req(g, 'POST', g.ids.phoneId + '/request_code', { token: t, data: { code_method: 'SMS', language: 'en_US' } })).data).toEqual({ success: true });
    expect((await req(g, 'POST', g.ids.phoneId + '/verify_code', { token: t, params: { code: '12' } })).status).toBe(400);
    expect((await req(g, 'POST', g.ids.phoneId + '/verify_code', { token: t, params: { code: '123456' } })).data).toEqual({ success: true });
    expect(g.state.phones[0].code_verification_status).toBe('VERIFIED');
  });
});

describe('fakeGraph: scenarios', () => {
  test.each([4, 17])('rateLimited(%i): the next call fails with that code, then normal', async (code) => {
    const g = make();
    g.scenarios.rateLimited(code);
    const a = await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken });
    expect(a.status).toBe(400);
    expect(a.data.error.code).toBe(code);
    expect((await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken })).status).toBe(200);
  });

  test('rateLimited with match and status options', async () => {
    const g = make();
    g.scenarios.rateLimited(80007, { match: 'getWaba', status: 429, times: 2 });
    expect((await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken })).status).toBe(200);
    expect((await req(g, 'GET', g.ids.wabaId, { token: g.ids.merchantToken })).status).toBe(429);
    expect((await req(g, 'GET', g.ids.wabaId, { token: g.ids.merchantToken })).status).toBe(429);
    expect((await req(g, 'GET', g.ids.wabaId, { token: g.ids.merchantToken })).status).toBe(200);
  });

  test('networkDrop(): rejects with { code, message } and the call is still recorded', async () => {
    const g = make();
    g.scenarios.networkDrop();
    await expect(req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken })).rejects.toMatchObject({ code: 'ECONNRESET', message: expect.any(String) });
    expect(g.lastCall().networkError).toBe('ECONNRESET');
    expect(g.lastCall().status).toBeUndefined();
    g.scenarios.networkDrop({ code: 'ETIMEDOUT', match: 'listPhones' });
    await expect(req(g, 'GET', g.ids.wabaId + '/phone_numbers', { token: g.ids.merchantToken })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect((await req(g, 'GET', g.ids.wabaId + '/phone_numbers', { token: g.ids.merchantToken })).status).toBe(200);
  });

  test('permissionMissing(200): next merchant-token call is a 200 permission error; default targets merchant calls only', async () => {
    const g = make();
    g.scenarios.permissionMissing(200);
    // an exchange (no merchant token) does not consume it
    expect((await req(g, 'GET', 'oauth/access_token', { params: { client_id: g.ids.appId, client_secret: g.ids.appSecret, code: 'PM1CODE' } })).status).toBe(200);
    const a = await req(g, 'POST', g.ids.wabaId + '/subscribed_apps', { token: g.ids.merchantToken });
    expect(a.data.error.code).toBe(200);
    expect((await req(g, 'POST', g.ids.wabaId + '/subscribed_apps', { token: g.ids.merchantToken })).status).toBe(200);
  });

  test('token190(): every merchant call is 190/463 until reset; debug_token says is_valid false', async () => {
    const g = make();
    g.scenarios.token190();
    for (let i = 0; i < 3; i += 1) {
      const r = await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken });
      expect(r.data.error).toMatchObject({ code: 190, error_subcode: 463 });
    }
    const dbg = await req(g, 'GET', 'debug_token', { params: { input_token: g.ids.merchantToken }, token: g.ids.appToken });
    expect(dbg.data.data.is_valid).toBe(false);
    expect(dbg.data.data.error).toMatchObject({ code: 190, subcode: 463 });
    g.reset();
    expect((await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken })).status).toBe(200);
  });

  test('token190({times:1}) and happy() both bound or clear the scenario', async () => {
    const g = make();
    g.scenarios.token190({ times: 1 });
    expect((await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken })).status).toBe(400);
    expect((await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken })).status).toBe(200);
    g.scenarios.token190();
    g.scenarios.rateLimited(4);
    expect(g.pending().length).toBeGreaterThan(0);
    g.scenarios.happy();
    expect(g.pending()).toEqual([]);
    expect((await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken })).status).toBe(200);
  });

  test('failNext by endpoint name with several response shapes', async () => {
    const g = make();
    const t = g.ids.merchantToken;
    g.failNext('getPhone', { code: 100, message: 'boom' });
    const a = await req(g, 'GET', g.ids.phoneId, { token: t });
    expect(a.status).toBe(400);
    expect(a.data.error.message).toBe('boom');
    g.failNext('getWaba', { status: 503, data: { error: { code: 2, message: 'temporarily unavailable', type: 'OAuthException' } } });
    const b = await req(g, 'GET', g.ids.wabaId, { token: t });
    expect(b.status).toBe(503);
    expect(b.data.error.code).toBe(2);
    g.failNext('listPhones', { networkError: 'ECONNABORTED' }, { times: 2 });
    await expect(req(g, 'GET', g.ids.wabaId + '/phone_numbers', { token: t })).rejects.toMatchObject({ code: 'ECONNABORTED' });
    await expect(req(g, 'GET', g.ids.wabaId + '/phone_numbers', { token: t })).rejects.toMatchObject({ code: 'ECONNABORTED' });
    expect((await req(g, 'GET', g.ids.wabaId + '/phone_numbers', { token: t })).status).toBe(200);
  });

  test('on(): custom responder, can fall through by returning undefined, and can be removed', async () => {
    const g = make();
    const t = g.ids.merchantToken;
    const off = g.on({ name: 'getPhone' }, (call) => (call.params.fields === 'status' ? { status: 200, data: { id: call.id, status: 'FLAGGED_FAKE' } } : undefined));
    expect((await req(g, 'GET', g.ids.phoneId, { token: t, params: { fields: 'status' } })).data.status).toBe('FLAGGED_FAKE');
    expect((await req(g, 'GET', g.ids.phoneId, { token: t, params: { fields: 'status' } })).data.status).toBe('FLAGGED_FAKE');
    expect((await req(g, 'GET', g.ids.phoneId, { token: t, params: { fields: 'quality_rating' } })).data.quality_rating).toBe('GREEN');
    off();
    expect((await req(g, 'GET', g.ids.phoneId, { token: t, params: { fields: 'status' } })).data.status).toBe('CONNECTED');
  });

  test('graphError builds the AU4 error body', () => {
    const e = graphError({ code: 100, subcode: 2388024, message: 'm', title: 'T', userMsg: 'U' });
    expect(e.status).toBe(400);
    expect(e.data.error).toEqual({ message: 'm', type: 'OAuthException', code: 100, error_subcode: 2388024, error_user_title: 'T', error_user_msg: 'U', fbtrace_id: expect.any(String) });
  });
});

describe('fakeGraph: call recording', () => {
  test('records method, path without version, merged params, data, and the raw Authorization header', async () => {
    const g = make();
    await g.http.request({
      method: 'post',
      url: BASE + g.ids.phoneId + '/register?x=1',
      params: { y: '2' },
      data: { messaging_product: 'whatsapp', pin: '654321' },
      headers: { authorization: 'Bearer ' + g.ids.merchantToken },
      timeout: 1234,
      validateStatus: () => true,
    });
    const c = g.calls[0];
    expect(c).toMatchObject({ seq: 1, name: 'register', method: 'POST', path: g.ids.phoneId + '/register', version: 'v25.0', origin: GRAPH_ORIGIN, params: { x: '1', y: '2' }, data: { messaging_product: 'whatsapp', pin: '654321' }, authorization: 'Bearer ' + g.ids.merchantToken, token: g.ids.merchantToken, tokenKind: 'merchant', tokenSource: 'header', timeout: 1234, status: 200 });
  });

  test('relative urls resolve against the Graph base; form-encoded string bodies are parsed', async () => {
    const g = make();
    await g.http.request({ method: 'POST', url: g.ids.phoneId + '/request_code', data: 'code_method=SMS&language=en_US', headers: { Authorization: 'Bearer ' + g.ids.merchantToken } });
    expect(g.lastCall('requestCode').data).toEqual({ code_method: 'SMS', language: 'en_US' });
    expect(g.lastCall('requestCode').status).toBe(200);
  });

  test('the http convenience methods and unknown paths / methods', async () => {
    const g = make();
    const r = await g.http.get(BASE + 'nonsense/a/b/c', { headers: { Authorization: 'Bearer ' + g.ids.merchantToken } });
    expect(r.data.error.code).toBe(2500);
    const bad = await g.http.request({ method: 'GET', url: BASE + g.ids.phoneId + '/register', headers: { Authorization: 'Bearer ' + g.ids.merchantToken } });
    expect(bad.status).toBe(400);
  });

  test('every status resolves (never rejects) even with a validateStatus that would reject', async () => {
    const g = make();
    const r = await g.http.request({ method: 'GET', url: BASE + g.ids.phoneId, headers: {}, validateStatus: (s) => s < 300 });
    expect(r.status).toBe(400);
  });

  test('responses are copies: mutating one does not change the fake', async () => {
    const g = make();
    const a = await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken, params: { fields: 'verified_name' } });
    a.data.verified_name = 'HACKED';
    const b = await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken, params: { fields: 'verified_name' } });
    expect(b.data.verified_name).toBe('Acme Coffee');
  });

  test('reset() clears calls (same array), scenarios and state', async () => {
    const g = make();
    const callsRef = g.calls;
    await create(g);
    g.scenarios.rateLimited(4);
    g.setTier('TIER_10K');
    g.reset();
    expect(g.calls).toBe(callsRef);
    expect(callsRef).toHaveLength(0);
    expect(g.pending()).toEqual([]);
    const r = await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken, params: { fields: 'whatsapp_business_manager_messaging_limit' } });
    expect(r.data.whatsapp_business_manager_messaging_limit).toBe('TIER_250');

    async function create(fk) {
      return req(fk, 'POST', fk.ids.wabaId + '/message_templates', { token: fk.ids.merchantToken, data: { name: 'x_y', language: 'en', category: 'UTILITY', components: [{ type: 'BODY', text: 'hi' }] } });
    }
  });

  test('session() builds the Embedded Signup browser payloads', () => {
    const g = make();
    expect(g.session()).toEqual({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { phone_number_id: g.ids.phoneId, waba_id: g.ids.wabaId, business_id: g.ids.businessId } });
    expect(g.session('FINISH_ONLY_WABA').data).toEqual({ waba_id: g.ids.wabaId, business_id: g.ids.businessId });
    expect(g.session('CANCEL').data.current_step).toBe('PHONE_NUMBER_SETUP');
  });

  test('webhook.sign matches an independent HMAC-SHA256 of the raw body', () => {
    const g = make();
    const raw = JSON.stringify(g.webhook.envelope('account_update', { event: 'PARTNER_REMOVED' }));
    const expected = 'sha256=' + require('crypto').createHmac('sha256', g.ids.appSecret).update(raw).digest('hex');
    expect(g.webhook.sign(raw)).toBe(expected);
    expect(g.webhook.sign(raw, 'other')).not.toBe(expected);
  });
});

describe('fakeGraph: assertNoLeak redaction rules', () => {
  const CODE = 'AQDsecretAuthCode0123456789';
  const PIN = '482913';

  async function connectOnce(g) {
    await req(g, 'GET', 'oauth/access_token', { params: { client_id: g.ids.appId, client_secret: g.ids.appSecret, code: CODE } });
    await req(g, 'GET', 'debug_token', { params: { input_token: g.ids.merchantToken }, token: g.ids.appToken });
    await req(g, 'POST', g.ids.phoneId + '/register', { token: g.ids.merchantToken, data: { messaging_product: 'whatsapp', pin: PIN } });
    await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken, params: { fields: 'status' } });
  }

  test('protocol-mandated places (code in exchange, pin in register body, token in Authorization, input_token) are not leaks', async () => {
    const g = make();
    await connectOnce(g);
    expect(g.assertNoLeak([CODE, PIN, g.ids.merchantToken, g.ids.appSecret])).toBe(true);
  });

  test('the same secrets in a path, another param, another body field or a header ARE leaks (and are not printed)', async () => {
    const g = make();
    await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken, params: { fields: 'status', note: CODE } });
    expect(() => g.assertNoLeak([CODE])).toThrow(/secret #0 .* getPhone params\.note/);
    try { g.assertNoLeak([CODE]); } catch (e) { expect(e.message).not.toContain(CODE); }

    const g2 = make();
    await req(g2, 'POST', g2.ids.wabaId + '/subscribed_apps', { token: g2.ids.merchantToken, data: { debug: PIN } });
    expect(g2.findLeaks([PIN])).toEqual([expect.stringContaining('data.debug')]);

    const g3 = make();
    await req(g3, 'GET', g3.ids.phoneId, { token: g3.ids.merchantToken, headers: { 'x-trace': PIN } });
    expect(g3.findLeaks([PIN])[0]).toContain('header.x-trace');

    const g4 = make();
    await g4.http.request({ method: 'GET', url: BASE + g4.ids.phoneId + '?access_token=' + g4.ids.merchantToken + '&fields=status', headers: {} });
    expect(g4.findLeaks([g4.ids.merchantToken])).toEqual([]); // token via access_token param IS the protocol carrier
    const g5 = make();
    await req(g5, 'GET', g5.ids.phoneId, { token: g5.ids.merchantToken, params: { fields: 'status', leak: g5.ids.merchantToken } });
    expect(g5.findLeaks([g5.ids.merchantToken])[0]).toContain('params.leak');
  });

  test('the code in a url query other than the exchange param is a leak; PIN in the path is a leak', async () => {
    const g = make();
    await g.http.request({ method: 'GET', url: BASE + g.ids.phoneId + '?fields=status&trace=' + CODE, headers: { Authorization: 'Bearer ' + g.ids.merchantToken } });
    const leaks = g.findLeaks([CODE]);
    expect(leaks.some((l) => l.includes(' url'))).toBe(true);
    const g2 = make();
    await g2.http.request({ method: 'GET', url: BASE + PIN + 'x', headers: {} });
    expect(g2.findLeaks([PIN]).some((l) => l.includes('path'))).toBe(true);
  });

  test('only the secrets passed in are scanned; extra log lines are scanned with no exemption; short secrets refused', async () => {
    const g = make();
    await connectOnce(g);
    expect(g.findLeaks(['NOT-THERE-AT-ALL'])).toEqual([]);
    expect(g.findLeaks([CODE], ['connected ok', { phone: '***4567' }])).toEqual([]);
    expect(g.findLeaks([CODE], ['exchange failed for code ' + CODE])[0]).toContain('extra[0]');
    expect(g.findLeaks([PIN], [new Error('register failed pin ' + PIN)])[0]).toContain('extra[0]');
    expect(() => g.assertNoLeak(['abc'])).toThrow(/too short/);
    expect(() => g.assertNoLeak([''])).toThrow(/too short/);
  });

  test('assertMerchantTokenOnly flags a merchant-scoped call carrying another token', async () => {
    const g = make();
    await req(g, 'GET', g.ids.phoneId, { token: g.ids.merchantToken });
    expect(g.assertMerchantTokenOnly(g.ids.merchantToken)).toBe(true);
    await req(g, 'GET', g.ids.phoneId, { token: g.ids.platformToken });
    expect(() => g.assertMerchantTokenOnly(g.ids.merchantToken)).toThrow(/without the merchant token/);
  });
});
