'use strict';
const express = require('express');
const request = require('supertest');
const testMessage = require('../../../shared/onboarding/testMessage');
const { OnbError } = require('../../../shared/onboarding/errors');
const { WS, WS2, USER, MERCHANT_TOKEN, PLATFORM_TOKEN, makeWorld, seedTemplate, flat, captureLogs } = require('./_b1eKit');
const { newId } = require('./_b0Store');

const ENV = ['WA_TOKEN', 'WA_PHONE_ID', 'ONBOARDING_LEGACY_SEND_POLICY'];
const SAVED = {};
beforeEach(() => { for (const k of ENV) { SAVED[k] = process.env[k]; delete process.env[k]; } process.env.WA_TOKEN = PLATFORM_TOKEN; process.env.WA_PHONE_ID = '999000111222'; });
afterEach(() => { for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

const approved = (w, key, language, extra = {}) => seedTemplate(w, {
  key, language, metaTemplateId: `${key}-${language}`, metaTemplateName: `wf_439011_${key}_${language}_v1`, metaStatus: 'APPROVED',
  metaStatusRaw: 'APPROVED', category: key === 'setup_test' || key === 'order_confirmation' ? 'UTILITY' : 'MARKETING', source: key === 'setup_test' ? 'setup_test' : 'library', ...extra,
});
const sends = (w) => w.client.calls.filter((c) => c.name === 'send');
const send = (w, args = {}, extraDeps = {}) => testMessage.sendTestMessage({ workspaceId: WS, userId: USER, ...args }, { ...w.deps, ...extraDeps });
/** Another user of the workspace with a login phone and a live Membership (role null = no membership: a removed member). */
function addUser(w, phone, role = 'member') {
  const id = newId();
  w.User.seed({ _id: id, ...(phone ? { phone } : { email: 'x@y.test' }) });
  if (role) w.Membership.seed({ userId: id, workspaceId: WS, role });
  return id;
}

describe('happy path: the requesting user\'s own login phone', () => {
  test('sends the approved test template from the merchant number with the MERCHANT token', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    const out = await send(w);
    expect(out).toEqual({ sent: true, to: '********4567', templateKey: 'setup_test' });
    const s = sends(w);
    expect(s).toHaveLength(1);
    expect(s[0].token).toBe(MERCHANT_TOKEN);
    expect(s[0].phoneId).toBe('P1');
    expect(s[0].args).toMatchObject({ to: '966501234567', name: 'wf_439011_setup_test_en_v1', languageCode: 'en' });
    expect(s[0].args.components || []).toEqual([]); // no variables, no buttons
    // never the platform credentials
    expect(flat(w.client.calls)).not.toContain(PLATFORM_TOKEN);
    expect(flat(w.client.calls)).not.toContain('999000111222');
    expect(w.vault.decrypt).toHaveBeenCalledWith(expect.any(String), { workspaceId: WS, purpose: 'token' });
  });

  test('the result stores only the masked number and a timestamp; the counters move', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    await send(w);
    expect(w.State.rows[0].firstPromotion).toMatchObject({ testMessageCount: 1, testPhoneMasked: '********4567', lastTestAt: w.clock.now() });
    expect(w.Event.rows).toHaveLength(1);
    expect(w.Event.rows[0]).toMatchObject({ type: 'notification', code: 'TEST_MESSAGE_SENT', reason: 'test_message' });
    expect(w.Event.rows[0].meta.h).toMatch(/^[0-9a-f]{24}$/);
    expect(w.Event.rows[0].meta.last4).toBe('4567');
  });

  test('no full number, token or code in the DB rows, the result, or the logs', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    let out;
    const lines = await captureLogs(async () => { out = await send(w); });
    const dump = flat([w.State.rows, w.Event.rows, w.Template.rows, out]) + lines.join('\n');
    expect(dump).not.toContain('966501234567');
    expect(dump).not.toContain('501234567');
    expect(dump).not.toContain(MERCHANT_TOKEN);
  });

  test('the Arabic UI language prefers the Arabic variant of the same template', async () => {
    const w = makeWorld({ uiLanguage: 'ar' });
    approved(w, 'setup_test', 'en');
    approved(w, 'setup_test', 'ar');
    await send(w);
    expect(sends(w)[0].args).toMatchObject({ name: 'wf_439011_setup_test_ar_v1', languageCode: 'ar' });
  });
});

describe('recipient', () => {
  test.each([
    ['local number with a trunk zero', '0501234567', '966501234567'],
    ['E.164 with spaces', '+966 50 123 4567', '966501234567'],
    ['00 prefix', '00966501234567', '966501234567'],
    ['Arabic-Indic digits', '٠٥٠١٢٣٤٥٦٧', '966501234567'],
    ['bare national number', '501234567', '966501234567'],
    ['another country, explicit plus', '+971 50 123 4567', '971501234567'],
  ])('typed number: %s', async (label, typed, digits) => {
    const w = makeWorld({ userPhone: null });
    approved(w, 'setup_test', 'en');
    const out = await send(w, { to: typed });
    expect(sends(w)[0].args.to).toBe(digits);
    expect(out.to).toBe(`${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`);
  });

  test('uses the workspace default country code', async () => {
    const w = makeWorld({ userPhone: null, defaultCountryCode: '971' });
    approved(w, 'setup_test', 'en');
    await send(w, { to: '0501234567' });
    expect(sends(w)[0].args.to).toBe('971501234567');
  });

  test('an e-mail-login user with no number must type one', async () => {
    const w = makeWorld({ userPhone: null });
    approved(w, 'setup_test', 'en');
    await expect(send(w)).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', status: 422, details: { reason: 'PHONE_REQUIRED' } });
    expect(sends(w)).toHaveLength(0);
    expect(w.Event.rows).toHaveLength(0);
  });

  test.each([['123'], ['abc'], ['+'], ['12345678901234567890'], ['9'.repeat(16)], ['x'.repeat(60)], ['+966 (0) 5']])('invalid number %j -> 422 TEST_PHONE_INVALID, nothing sent or counted', async (typed) => {
    const w = makeWorld({ userPhone: null });
    approved(w, 'setup_test', 'en');
    await expect(send(w, { to: typed })).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', status: 422 });
    expect(sends(w)).toHaveLength(0);
    expect(w.Event.rows).toHaveLength(0);
    expect(w.State.rows[0].firstPromotion.testMessageCount).toBe(0);
  });

  test('review R2-03: a typed number never wins over the login phone: a stranger is refused (NOT_YOUR_NUMBER), the user\'s own number is fine in any notation', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    await expect(send(w, { to: '0555555555' })).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', status: 422, details: { reason: 'NOT_YOUR_NUMBER' } });
    expect(sends(w)).toHaveLength(0);
    expect(w.Event.rows).toHaveLength(0);
    expect(w.State.rows[0].firstPromotion.testMessageCount).toBe(0);
    await expect(send(w, { to: '0501234567' })).resolves.toMatchObject({ sent: true }); // the login phone itself, typed as a local number
    expect(sends(w)[0].args.to).toBe('966501234567');
  });

  test('the merchant\'s own business number is refused (Meta cannot message itself)', async () => {
    const w = makeWorld({ displayPhoneNumber: '+966 50 123 4567' });
    approved(w, 'setup_test', 'en');
    await expect(send(w)).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'SAME_AS_BUSINESS_NUMBER' } });
    expect(sends(w)).toHaveLength(0);
  });
});

describe('consent: an opted-out customer is never messaged', () => {
  test('opted-out Customer of this workspace -> 422, nothing sent, nothing counted', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    w.Customer.seed({ workspaceId: WS, phone: '966501234567', optedOut: true });
    await expect(send(w)).rejects.toMatchObject({ code: 'TEST_RECIPIENT_OPTED_OUT', status: 422 });
    expect(sends(w)).toHaveLength(0);
    expect(w.Event.rows).toHaveLength(0);
    expect(w.State.rows[0].firstPromotion.testMessageCount).toBe(0);
  });

  test('also when the typed number has another notation', async () => {
    const w = makeWorld({ userPhone: null });
    approved(w, 'setup_test', 'en');
    w.Customer.seed({ workspaceId: WS, phone: '966501234567', optedOut: true });
    await expect(send(w, { to: '050 123 4567' })).rejects.toMatchObject({ code: 'TEST_RECIPIENT_OPTED_OUT' });
  });

  test('a customer of ANOTHER workspace, or one who did not opt out, does not block', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    w.Customer.seed({ workspaceId: WS2, phone: '966501234567', optedOut: true });
    w.Customer.seed({ workspaceId: WS, phone: '966501234567', optedOut: false });
    await expect(send(w)).resolves.toMatchObject({ sent: true });
  });
});

describe('template selection', () => {
  test('no APPROVED template -> 409 TEST_NO_APPROVED_TEMPLATE (pending / rejected do not count)', async () => {
    const w = makeWorld();
    seedTemplate(w, { key: 'setup_test', language: 'en', metaTemplateName: 'wf_439011_setup_test_en_v1', metaStatus: 'PENDING', source: 'setup_test' });
    seedTemplate(w, { key: 'comeback', language: 'en', metaTemplateName: 'wf_439011_comeback_en_v1', metaStatus: 'REJECTED' });
    await expect(send(w)).rejects.toMatchObject({ code: 'TEST_NO_APPROVED_TEMPLATE', status: 409, nextStep: 'approvals' });
    expect(sends(w)).toHaveLength(0);
    expect(w.Event.rows).toHaveLength(0);
  });

  test('review R2-03: only a UTILITY template is ever sent: the test template first, then another approved UTILITY one; a MARKETING one NEVER', async () => {
    const w = makeWorld();
    approved(w, 'comeback', 'en'); // MARKETING
    approved(w, 'promotion_weekend', 'en'); // MARKETING
    await expect(send(w)).rejects.toMatchObject({ code: 'TEST_NO_APPROVED_TEMPLATE', status: 409, nextStep: 'approvals' }); // a marketing-only workspace
    expect(sends(w)).toHaveLength(0);
    expect(w.Event.rows).toHaveLength(0);
    approved(w, 'order_confirmation', 'en');
    await send(w);
    expect(sends(w)[0].args.name).toBe('wf_439011_order_confirmation_en_v1');
    approved(w, 'setup_test', 'en');
    await send(w);
    expect(sends(w)[1].args.name).toBe('wf_439011_setup_test_en_v1');
    expect(sends(w).map((s) => s.args.name).join(',')).not.toMatch(/comeback|promotion_weekend/);
  });

  test('the category is what META reports: a test template re-categorised as MARKETING is not sent either; only UTILITY (any case) counts', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en', { category: 'MARKETING' });
    approved(w, 'welcome_optin', 'en');
    await expect(send(w)).rejects.toMatchObject({ code: 'TEST_NO_APPROVED_TEMPLATE' });
    approved(w, 'booking_confirmation', 'en', { category: 'utility' });
    await send(w);
    expect(sends(w)[0].args.name).toBe('wf_439011_booking_confirmation_en_v1');
  });

  test('a UTILITY library template is filled with sample values', async () => {
    const w = makeWorld();
    approved(w, 'order_confirmation', 'en');
    await send(w);
    const comps = sends(w)[0].args.components;
    const body = comps.find((c) => c.type === 'body');
    expect(body.parameters).toHaveLength(3); // name, order_id, amount
    expect(body.parameters.every((p) => p.type === 'text' && p.text)).toBe(true);
    expect(comps.filter((c) => c.type === 'button')).toEqual([]);
  });

  test('a UTILITY template with quick-reply buttons would carry INERT payloads (onbtest_*): no webhook branch handles them', async () => {
    const w = makeWorld();
    const real = require('../../../shared/localization/templateLibrary');
    const entry = real.getLibraryEntry('comeback');
    const library = { getLibraryEntry: (k) => (k === 'comeback' ? { ...entry, category: 'UTILITY' } : real.getLibraryEntry(k)), listLibraryStrings: real.listLibraryStrings };
    approved(w, 'comeback', 'en', { category: 'UTILITY' });
    await send(w, {}, { library });
    const buttons = sends(w)[0].args.components.filter((c) => c.type === 'button');
    expect(buttons).toEqual([{ type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'onbtest_opt_out' }] }]);
    for (const b of buttons) expect(b.parameters[0].payload).not.toMatch(/^(promo_|flowbrowse_|flownoshow_|msgnode_|consent_yes_|consent_no_|optout_|cart_|carouselsvc_|rebook_|paylater_|int_|more_|checkout)/);
  });

  test('tenant isolation: another workspace\'s approved template is never used', async () => {
    const w = makeWorld();
    w.Template.seed({ workspaceId: WS2, key: 'setup_test', language: 'en', metaTemplateName: 'wf_999999_setup_test_en_v1', metaStatus: 'APPROVED', source: 'setup_test' });
    await expect(send(w)).rejects.toMatchObject({ code: 'TEST_NO_APPROVED_TEMPLATE' });
  });
});

describe('limits (counted in the DB)', () => {
  test('5 per hour per workspace, then 429 TEST_RATE_LIMITED with Retry-After; fresh again after the hour', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    for (let i = 0; i < 5; i += 1) { await send(w); w.clock.advance(60 * 1000); }
    const err = await send(w).catch((e) => e);
    expect(err).toBeInstanceOf(OnbError);
    expect(err).toMatchObject({ code: 'TEST_RATE_LIMITED', status: 429, retryable: true });
    expect(err.retryAfterSec).toBeGreaterThan(0);
    expect(err.retryAfterSec).toBeLessThanOrEqual(3600);
    expect(sends(w)).toHaveLength(5);
    expect(w.Event.rows.filter((e) => e.code === 'TEST_MESSAGE_VOID')).toHaveLength(1);
    expect(w.Event.rows.filter((e) => e.code === 'TEST_MESSAGE_SENT')).toHaveLength(5);
    w.clock.advance(60 * 60 * 1000);
    await expect(send(w)).resolves.toMatchObject({ sent: true });
  });

  test('the limit is per workspace', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    for (let i = 0; i < 5; i += 1) await send(w);
    // another workspace's events do not count here (and vice versa)
    w.Event.seed({ workspaceId: WS2, type: 'notification', code: 'TEST_MESSAGE_SENT', at: w.clock.now() });
    await expect(send(w)).rejects.toMatchObject({ code: 'TEST_RATE_LIMITED' });
  });

  test('2 distinct numbers per workspace lifetime: the third is TEST_NUMBER_LIMIT; a known number can be reused', async () => {
    const w = makeWorld({ userPhone: '0501111111' });
    approved(w, 'setup_test', 'en');
    const second = addUser(w, '0502222222');
    const third = addUser(w, '0503333333');
    await send(w);
    await send(w, { userId: second });
    expect(w.State.rows[0].firstPromotion.testMessageCount).toBe(2);
    await expect(send(w, { userId: third })).rejects.toMatchObject({ code: 'TEST_NUMBER_LIMIT', status: 409 });
    expect(sends(w)).toHaveLength(2);
    expect(w.State.rows[0].firstPromotion.testMessageCount).toBe(2);
    // the same user (the same number) again is not a new number
    await expect(send(w)).resolves.toMatchObject({ sent: true });
    expect(w.State.rows[0].firstPromotion.testMessageCount).toBe(2);
    // the refused attempt left only a VOID row
    expect(w.Event.rows.filter((e) => e.code === 'TEST_MESSAGE_VOID')).toHaveLength(1);
  });

  test('without the server secret the distinct numbers are told apart by their last 4 digits only (no hash is stored)', async () => {
    const w = makeWorld({ userPhone: '0501111111', hmacSecret: null });
    approved(w, 'setup_test', 'en');
    const second = addUser(w, '0502222222');
    const third = addUser(w, '0503333333');
    await send(w);
    await send(w, { userId: second });
    await expect(send(w, { userId: third })).rejects.toMatchObject({ code: 'TEST_NUMBER_LIMIT' });
    await expect(send(w)).resolves.toMatchObject({ sent: true }); // known by its last 4 digits
    for (const e of w.Event.rows.filter((x) => x.code === 'TEST_MESSAGE_SENT')) expect(e.meta).toEqual({ last4: expect.stringMatching(/^\d{4}$/) });
  });

  test('a failed Meta call does not use up a number or a rate slot', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    w.client.failNext.push({ name: 'send', err: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), times: 3 });
    for (let i = 0; i < 3; i += 1) await expect(send(w)).rejects.toMatchObject({ code: 'META_UNREACHABLE' });
    expect(w.State.rows[0].firstPromotion.testMessageCount).toBe(0);
    expect(w.Event.rows.filter((e) => e.code === 'TEST_MESSAGE_FAILED')).toHaveLength(3);
    for (let i = 0; i < 5; i += 1) await send(w); // all 5 slots still free
    expect(w.State.rows[0].firstPromotion.testMessageCount).toBe(1);
  });

  test('a burst of simultaneous requests never sends more than 5', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    const results = await Promise.allSettled(Array.from({ length: 9 }, () => send(w)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBeLessThanOrEqual(5);
    expect(sends(w)).toHaveLength(ok);
    for (const r of results.filter((x) => x.status === 'rejected')) expect(r.reason.code).toBe('TEST_RATE_LIMITED');
  });

  test('the lifetime number limit can be lifted by an admin (counter) without touching anything else', async () => {
    const w = makeWorld({ userPhone: '0501111111' });
    approved(w, 'setup_test', 'en');
    const second = addUser(w, '0502222222');
    const third = addUser(w, '0503333333');
    await send(w);
    await send(w, { userId: second });
    await expect(send(w, { userId: third })).rejects.toMatchObject({ code: 'TEST_NUMBER_LIMIT' });
    w.State.rows[0].firstPromotion.testMessageCount = 1;
    await expect(send(w, { userId: third })).resolves.toMatchObject({ sent: true });
  });
});

describe('connection requirements', () => {
  test.each([
    ['no connection', { connStatus: null }, 'WHATSAPP_NOT_CONNECTED'],
    ['connecting', { connStatus: 'connecting' }, 'WHATSAPP_NOT_CONNECTED'],
    ['WABA only (no phone number yet)', { connStatus: 'waba_only' }, 'WHATSAPP_NOT_CONNECTED'],
    ['needs reconnect', { needsReconnect: true }, 'WHATSAPP_RECONNECT_REQUIRED'],
    ['undecryptable token', { vaultFails: true }, 'WHATSAPP_RECONNECT_REQUIRED'],
  ])('%s -> %s, nothing sent or counted', async (label, opts, code) => {
    const w = makeWorld(opts);
    approved(w, 'setup_test', 'en');
    await expect(send(w)).rejects.toMatchObject({ code });
    expect(w.client.calls).toHaveLength(0);
    expect(w.Event.rows).toHaveLength(0);
  });

  test('needs_attention still sends (the token works)', async () => {
    const w = makeWorld({ connStatus: 'needs_attention' });
    approved(w, 'setup_test', 'en');
    await expect(send(w)).resolves.toMatchObject({ sent: true });
  });

  test('a workspace without a sidecar state is not available', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    w.State.rows.length = 0;
    await expect(send(w)).rejects.toMatchObject({ code: 'ONBOARDING_NOT_AVAILABLE', status: 404 });
  });
});

describe('Meta failures', () => {
  test('a revoked token flips the connection (connect.reportGraphError) and answers WHATSAPP_RECONNECT_REQUIRED', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    const e = Object.assign(new Error('Session has expired'), { code: 190, subcode: 463 });
    w.client.failNext.push({ name: 'send', err: e });
    await expect(send(w)).rejects.toMatchObject({ code: 'WHATSAPP_RECONNECT_REQUIRED', nextStep: 'connect' });
    expect(w.connect.reportGraphError).toHaveBeenCalledTimes(1);
    expect(w.connect.reportGraphError.mock.calls[0][0]).toBe(WS);
  });

  test.each([
    ['rate limited', { code: 4 }, 'META_RATE_LIMITED'],
    ['permission', { code: 200 }, 'META_PERMISSION_MISSING'],
    ['network', { code: 'ECONNRESET' }, 'META_UNREACHABLE'],
    ['anything else', { code: 131026 }, 'META_ERROR'],
  ])('%s -> %s', async (label, shape, code) => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    w.client.failNext.push({ name: 'send', err: Object.assign(new Error('boom'), shape) });
    await expect(send(w)).rejects.toMatchObject({ code });
    expect(w.connect.reportGraphError).not.toHaveBeenCalled();
  });

  test('metaErrors.classify drives the answer when available', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    w.client.failNext.push({ name: 'send', err: new Error('boom') });
    const metaErrors = { classify: jest.fn(() => ({ kind: 'permission', appCode: 'META_PERMISSION_MISSING', retryable: false })) };
    await expect(send(w, {}, { metaErrors })).rejects.toMatchObject({ code: 'META_PERMISSION_MISSING' });
    expect(metaErrors.classify).toHaveBeenCalled();
  });

  test('an error message that carries the token or the number never reaches the OnbError or the logs', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    w.client.failNext.push({ name: 'send', err: Object.assign(new Error(`failed for 966501234567 with ${MERCHANT_TOKEN}`), { code: 131026 }) });
    let err;
    const lines = await captureLogs(async () => { err = await send(w).catch((e) => e); });
    expect(err.code).toBe('META_ERROR');
    expect(flat({ m: err.message, d: err.details, c: err.code })).not.toMatch(/966501234567|EAAFXT/);
    expect(lines.join('\n')).not.toMatch(/966501234567|EAAFXT/);
    expect(flat(w.Event.rows)).not.toContain('966501234567');
  });
});

describe('routes (mini app)', () => {
  const { createRouter } = require('../../../routes/onboarding/test');
  const freshLimiter = () => ({ limiter: require('../../../shared/onboarding/rateLimit').createLimiter() });
  const pass = (req, res, next) => next(); // the live membership gate has its own tests below (and in requireOnboardingAccess)
  const mkApp = (w, user = { id: USER, workspaceId: WS, role: 'owner' }, extra = {}) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = user; next(); });
    app.use(createRouter({ moduleDeps: w.deps, rateLimitDeps: freshLimiter(), memberGate: pass, ...extra }));
    return app;
  };

  test('POST /test-message: own phone by default; the frontend field is "phone"; a stranger number is refused (review R2-03)', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    const a = await request(mkApp(w)).post('/test-message').send({});
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ sent: true, to: '********4567', templateKey: 'setup_test' });
    const b = await request(mkApp(w)).post('/test-message').send({ phone: '0555555555' });
    expect(b.status).toBe(422);
    expect(b.body).toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'NOT_YOUR_NUMBER' } });
    expect(JSON.stringify(b.body)).not.toMatch(/555555555/);
    const c = await request(mkApp(w)).post('/test-message').send({ to: '0555555555' });
    expect(c.status).toBe(422);
    const d = await request(mkApp(w)).post('/test-message').send({ phone: '0501234567' }); // the user's own number, typed
    expect(d.status).toBe(200);
    expect(sends(w).map((x) => x.args.to)).toEqual(['966501234567', '966501234567']);
  });

  test('errors become the standard JSON body with the right status; the number is never echoed', async () => {
    const w = makeWorld({ userPhone: null });
    const none = await request(mkApp(w)).post('/test-message').send({});
    expect(none.status).toBe(422);
    expect(none.body).toMatchObject({ code: 'TEST_PHONE_INVALID' });
    const noTemplate = await request(mkApp(w)).post('/test-message').send({ phone: '0501234567' });
    expect(noTemplate.status).toBe(409);
    expect(noTemplate.body).toMatchObject({ code: 'TEST_NO_APPROVED_TEMPLATE', nextStep: 'approvals' });
    expect(JSON.stringify(noTemplate.body)).not.toMatch(/501234567/);
    approved(w, 'setup_test', 'en');
    for (let i = 0; i < 5; i += 1) await request(mkApp(w)).post('/test-message').send({ phone: '0501234567' });
    const limited = await request(mkApp(w)).post('/test-message').send({ phone: '0501234567' });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('TEST_RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  test('the workspace and user come from the token, never from the body', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    const app = mkApp(w, { id: 'someoneelse', workspaceId: WS2, role: 'owner' });
    const res = await request(app).post('/test-message').send({ workspaceId: WS, userId: USER });
    expect(res.status).toBe(402); // WS2 has no connection: the body ids are ignored
    expect(res.body.code).toBe('WHATSAPP_NOT_CONNECTED');
    expect(sends(w)).toHaveLength(0);
  });

  test('a non-string phone is ignored, not coerced', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    const res = await request(mkApp(w)).post('/test-message').send({ phone: { $ne: null } });
    expect(res.status).toBe(200);
    expect(sends(w)[0].args.to).toBe('966501234567');
  });

  test('stub module -> 503 NOT_IMPLEMENTED JSON', async () => {
    const stub = { sendTestMessage: () => { const e = new Error('later'); e.code = 'NOT_IMPLEMENTED'; e.status = 503; throw e; } };
    const w = makeWorld();
    const res = await request(mkApp(w, undefined, { testMessage: stub })).post('/test-message').send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NOT_IMPLEMENTED');
  });
});
