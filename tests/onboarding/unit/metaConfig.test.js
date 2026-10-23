'use strict';
const m = require('../../../shared/onboarding/metaConfig');

const ENV = ['WA_GRAPH_VERSION', 'ES_EXCHANGE_REDIRECT_URI', 'ES_EXTRAS', 'META_PAYMENT_PROBE', 'META_PAYMENT_HELP_URL', 'META_PAYMENT_SETTINGS_URL', 'META_SECURITY_CENTER_URL', 'META_APPSECRET_PROOF', 'META_ES_APP_ID', 'META_ES_CONFIG_ID', 'WA_APP_ID'];
const saved = {};
beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('graph base', () => {
  test('defaults to v25.0 and follows WA_GRAPH_VERSION per call', () => {
    expect(m.GRAPH_VERSION()).toBe('v25.0');
    expect(m.GRAPH_BASE()).toBe('https://graph.facebook.com/v25.0');
    process.env.WA_GRAPH_VERSION = 'v26.0';
    expect(m.GRAPH_BASE()).toBe('https://graph.facebook.com/v26.0');
  });
  test('redirect uri is omitted (null) unless configured; debug_token uses the query form', () => {
    expect(m.EXCHANGE_REDIRECT_URI()).toBeNull();
    process.env.ES_EXCHANGE_REDIRECT_URI = 'https://example.com/cb';
    expect(m.EXCHANGE_REDIRECT_URI()).toBe('https://example.com/cb');
    expect(m.DEBUG_TOKEN_AUTH).toBe('query');
  });
  test('ES_EXTRAS defaults to {} and survives bad JSON', () => {
    expect(m.ES_EXTRAS()).toEqual({});
    process.env.ES_EXTRAS = '{"setup":{},"featureType":""}';
    expect(m.ES_EXTRAS()).toEqual({ setup: {}, featureType: '' });
    process.env.ES_EXTRAS = '{bad';
    expect(m.ES_EXTRAS()).toEqual({});
    process.env.ES_EXTRAS = '[1]';
    expect(m.ES_EXTRAS()).toEqual({});
  });
  test('app id prefers META_ES_APP_ID, falls back to WA_APP_ID; config id optional', () => {
    expect(m.metaEsAppId()).toBeNull();
    process.env.WA_APP_ID = '111';
    expect(m.metaEsAppId()).toBe('111');
    process.env.META_ES_APP_ID = '222';
    expect(m.metaEsAppId()).toBe('222');
    expect(m.metaEsConfigId()).toBeNull();
    process.env.META_ES_CONFIG_ID = 'cfg';
    expect(m.metaEsConfigId()).toBe('cfg');
  });
});

describe('field lists (DB 6.1)', () => {
  test('phone fields', () => {
    expect(m.PHONE_FIELDS_CORE).toBe('id,display_phone_number,verified_name,quality_rating,status');
    expect(m.PHONE_FIELDS_FULL.split(',')).toEqual(expect.arrayContaining(['name_status', 'new_display_name', 'new_name_status', 'platform_type', 'is_on_biz_app', 'throughput']));
    for (const f of m.PHONE_FIELDS_CORE.split(',')) expect(m.PHONE_FIELDS_FULL.split(',')).toContain(f);
  });
  test('WABA fields add primary_funding_id only with the payment probe', () => {
    expect(m.WABA_FIELDS()).not.toContain('primary_funding_id');
    process.env.META_PAYMENT_PROBE = 'on';
    expect(m.paymentProbe()).toBe(true);
    expect(m.WABA_FIELDS()).toContain('primary_funding_id');
  });
  test('merchant webhook fields', () => {
    expect(m.MERCHANT_WEBHOOK_FIELDS).toEqual(['account_update', 'phone_number_name_update', 'phone_number_quality_update', 'business_capability_update', 'account_alerts', 'message_template_status_update', 'template_category_update', 'messages']);
  });
});

describe('mappings tolerate unknown values', () => {
  test.each([['verified', 'done'], ['pending', 'waiting'], ['pending_submission', 'waiting'], ['not_verified', 'needs_you'], ['pending_need_more_info', 'needs_you'], ['rejected', 'needs_you'],
    ['failed', 'needs_you'], ['expired', 'needs_you'], ['revoked', 'needs_you'], ['ineligible', 'needs_you'], ['VERIFIED', 'done'], ['something_new', 'unknown'], [undefined, 'unknown'], [null, 'unknown']])('verification %s -> %s', (raw, mapped) => {
    expect(m.mapVerification(raw)).toBe(mapped);
  });
  test.each([['APPROVED', 'done'], ['AVAILABLE_WITHOUT_REVIEW', 'done'], ['PENDING_REVIEW', 'waiting'], ['DECLINED', 'needs_you'], ['EXPIRED', 'needs_you'], ['NONE', 'needs_you'], ['approved', 'done'], ['NEW_ONE', 'unknown'], [undefined, 'unknown']])('name status %s -> %s', (raw, mapped) => {
    expect(m.mapNameStatus(raw)).toBe(mapped);
  });
  test('name rejection keys are i18n keys in the onboarding namespace', () => {
    expect(Object.keys(m.NAME_REJECTION_KEYS)).toEqual(['NAME_EMPLOYEE_ISSUE', 'NAME_INDIVIDUAL_ISSUE', 'NAME_ENDCLIENT_NOTRELATED', 'NAME_FORMAT_UNACCEPTABLE', 'NAME_NOT_CONSISTENT', 'UNKNOWN']);
    for (const v of Object.values(m.NAME_REJECTION_KEYS)) expect(v).toMatch(/^onboarding\.approvals\.nameRejection\./);
  });
  test('tiers: enums, integers, unlimited and unknown', () => {
    expect(m.tierFromRaw('TIER_50')).toEqual({ raw: 'TIER_50', tierNumber: 50 });
    expect(m.tierFromRaw('TIER_1K')).toEqual({ raw: 'TIER_1K', tierNumber: 1000 });
    expect(m.tierFromRaw('TIER_100K')).toEqual({ raw: 'TIER_100K', tierNumber: 100000 });
    expect(m.tierFromRaw('TIER_UNLIMITED')).toEqual({ raw: 'TIER_UNLIMITED', tierNumber: null });
    expect(m.tierFromRaw('UNTIERED')).toEqual({ raw: 'UNTIERED', tierNumber: null });
    expect(m.tierFromRaw(2000)).toEqual({ raw: '2000', tierNumber: 2000 });
    expect(m.tierFromRaw('250')).toEqual({ raw: '250', tierNumber: 250 });
    expect(m.tierFromRaw('TIER_FUTURE')).toEqual({ raw: 'TIER_FUTURE', tierNumber: null });
    expect(m.tierFromRaw(undefined)).toEqual({ raw: null, tierNumber: null });
    expect(m.tierFromRaw('x'.repeat(100)).raw).toHaveLength(40);
  });
});

describe('urls and misc constants', () => {
  test('https defaults, overridable by env', () => {
    for (const fn of [m.META_PAYMENT_HELP_URL, m.META_PAYMENT_SETTINGS_URL, m.META_SECURITY_CENTER_URL, m.META_WHATSAPP_MANAGER_URL]) expect(fn()).toMatch(/^https:\/\//);
    process.env.META_PAYMENT_HELP_URL = 'https://example.com/help';
    expect(m.META_PAYMENT_HELP_URL()).toBe('https://example.com/help');
  });
  test('constants', () => {
    expect(m.REGISTER_PIN_LENGTH).toBe(6);
    expect(m.REQUEST_TIMEOUT_MS).toBe(20000);
    expect(m.DISPLAY_NAME_EDITS_PER_30D).toBe(10);
    expect(m.APPSECRET_PROOF_ON()).toBe(false);
    process.env.META_APPSECRET_PROOF = 'on';
    expect(m.APPSECRET_PROOF_ON()).toBe(true);
  });
  test('every constant carries a confidence tag (unverified ones are explicit)', () => {
    expect(m.CONFIDENCE.EXCHANGE_REDIRECT_URI).toBe('UNVERIFIED');
    expect(m.CONFIDENCE.PAYMENT_METHOD_API).toMatch(/NONE/);
    for (const k of ['GRAPH_VERSION', 'PHONE_FIELDS_FULL', 'NAME_STATUS_MAP', 'TIER_MAP', 'META_SECURITY_CENTER_URL', 'DISPLAY_NAME_LIMITS']) expect(m.CONFIDENCE[k]).toBeTruthy();
  });
});

describe('defaultHttp (the Graph port)', () => {
  test('resolves { status, data, headers } for ANY http status', async () => {
    const axios = require('axios');
    const spy = jest.spyOn(axios, 'request').mockResolvedValue({ status: 400, data: { error: { code: 100 } }, headers: { 'x-a': '1' }, config: {} });
    const out = await m.defaultHttp().request({ method: 'GET', url: 'https://graph.facebook.com/x', validateStatus: () => false });
    expect(out).toEqual({ status: 400, data: { error: { code: 100 } }, headers: { 'x-a': '1' } });
    expect(spy.mock.calls[0][0].validateStatus()).toBe(true);
    spy.mockRestore();
  });
  test('network failures reject with { code, message }', async () => {
    const axios = require('axios');
    const spy = jest.spyOn(axios, 'request').mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await expect(m.defaultHttp().request({ method: 'GET', url: 'https://x' })).rejects.toEqual({ code: 'ECONNRESET', message: 'socket hang up' });
    spy.mockRestore();
  });
});
