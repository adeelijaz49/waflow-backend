'use strict';
const config = require('../../../shared/onboarding/config');

const KEYS = [
  'ONBOARDING_FLOW', 'ONBOARDING_LEGACY_SEND_POLICY', 'ONBOARDING_UNLOCK_AT', 'ONBOARDING_STRICT_LOCK', 'ONBOARDING_ENROL_FROM',
  'ONBOARDING_CHECKOUT', 'ONBOARDING_BILLING_PORTAL', 'ONBOARDING_ACCEPT_TRIALING', 'ONBOARDING_BILLING_RECONCILE_ON_DEMAND',
  'ONBOARDING_STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY', 'ONBOARDING_STRIPE_WEBHOOK_SECRET', 'ONBOARDING_STRIPE_WEBHOOK_SECRET_PREV',
  'ONBOARDING_STRIPE_PRICES', 'ONBOARDING_PLAN_LABELS', 'ONBOARDING_WEBHOOK_SIGNATURE', 'ONBOARDING_DROP_UNKNOWN_WABA',
  'ONBOARDING_SCHEDULER_INTERVAL_MS', 'ONBOARDING_STARTER_TEMPLATES', 'ONBOARDING_TEMPLATE_CEILING', 'ONBOARDING_SUPPORT_EMAIL',
  'ONBOARDING_SUPPORT_WHATSAPP', 'SUPPORT_DESK_EMAIL', 'ONBOARDING_ALLOW_SHARED_KEY', 'FRONTEND_URL', 'APP_URL',
];
const saved = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('enabled()', () => {
  test('default off', () => { expect(config.enabled()).toBe(false); });
  test.each(['on'])('exactly "%s" enables', (v) => { process.env.ONBOARDING_FLOW = v; expect(config.enabled()).toBe(true); });
  test.each(['ON', 'On', '1', 'true', 'yes', ' on', 'on ', '', 'off', 'enabled'])('"%s" does not enable', (v) => {
    process.env.ONBOARDING_FLOW = v;
    expect(config.enabled()).toBe(false);
  });
  test('read per call (no caching)', () => {
    expect(config.enabled()).toBe(false);
    process.env.ONBOARDING_FLOW = 'on';
    expect(config.enabled()).toBe(true);
    delete process.env.ONBOARDING_FLOW;
    expect(config.enabled()).toBe(false);
  });
});

describe('env readers and defaults', () => {
  test('legacySendPolicy defaults to block', () => {
    expect(config.legacySendPolicy()).toBe('block');
    process.env.ONBOARDING_LEGACY_SEND_POLICY = 'platform_number';
    expect(config.legacySendPolicy()).toBe('platform_number');
    process.env.ONBOARDING_LEGACY_SEND_POLICY = 'garbage';
    expect(config.legacySendPolicy()).toBe('block');
  });
  test('unlockAt', () => {
    expect(config.unlockAt()).toBe('connected');
    process.env.ONBOARDING_UNLOCK_AT = 'finished';
    expect(config.unlockAt()).toBe('finished');
    process.env.ONBOARDING_UNLOCK_AT = 'x';
    expect(config.unlockAt()).toBe('connected');
  });
  test('enrolFrom: valid ISO only', () => {
    expect(config.enrolFrom()).toBeNull();
    process.env.ONBOARDING_ENROL_FROM = 'not a date';
    expect(config.enrolFrom()).toBeNull();
    process.env.ONBOARDING_ENROL_FROM = '2999-01-01T00:00:00Z';
    expect(config.enrolFrom().toISOString()).toBe('2999-01-01T00:00:00.000Z');
    process.env.ONBOARDING_ENROL_FROM = '1700000000000';
    expect(config.enrolFrom()).toBeNull();
  });
  test('R1 note: enrolFrom needs an explicit zone on a time (a zoneless date-time would be read in the server time zone) and a real calendar date', () => {
    const iso = (v) => { process.env.ONBOARDING_ENROL_FROM = v; const d = config.enrolFrom(); return d ? d.toISOString() : null; };
    // accepted: a date (UTC by the ISO rule), Z, an explicit offset, fractional seconds, no seconds
    expect(iso('2026-11-01')).toBe('2026-11-01T00:00:00.000Z');
    expect(iso('2026-11-01T00:00:00Z')).toBe('2026-11-01T00:00:00.000Z');
    expect(iso('2026-11-01T00:00Z')).toBe('2026-11-01T00:00:00.000Z');
    expect(iso('2026-11-01T03:00:00+03:00')).toBe('2026-11-01T00:00:00.000Z');
    expect(iso('2026-10-31T23:30:00-01:00')).toBe('2026-11-01T00:30:00.000Z');
    expect(iso('2026-11-01T00:00:00.250Z')).toBe('2026-11-01T00:00:00.250Z');
    expect(iso('  2026-11-01T00:00:00Z  ')).toBe('2026-11-01T00:00:00.000Z'); // surrounding blanks are trimmed by the env reader
    // refused (auto-enrolment stays OFF): no zone, impossible dates, odd shapes
    for (const bad of [
      '2026-11-01T00:00:00', '2026-11-01T00:00', '2026-11-01 00:00:00', '2026-11-01T00:00:00+0300', '2026-11-01T00:00:00+03',
      '2026-02-30', '2026-02-30T00:00:00Z', '2026-13-01', '2026-00-10', '2026-04-31', '2026-11-32',
      '2026-11-01T24:00:00Z', '2026-11-01T25:00:00Z', '2026-11-01T00:60:00Z', '2026-11-01T00:00:60Z',
      '26-11-01', '2026/11/01', '2026-11-1', '2026-11-01Z', 'tomorrow', '0', '"2026-11-01"',
    ]) expect([bad, iso(bad)]).toEqual([bad, null]);
    expect(iso('2028-02-29')).toBe('2028-02-29T00:00:00.000Z'); // a real leap day
    expect(iso('2027-02-29')).toBeNull();
  });
  test('platform ids: WA_WABA_ID / WA_PHONE_ID as trimmed strings, null when unset; isPlatformAccount compares strings only', () => {
    const saved = { w: process.env.WA_WABA_ID, p: process.env.WA_PHONE_ID };
    try {
      delete process.env.WA_WABA_ID; delete process.env.WA_PHONE_ID;
      expect(config.platformIds()).toEqual({ wabaId: null, phoneNumberId: null });
      expect(config.isPlatformAccount({ wabaId: '123', phoneNumberId: '456' })).toBe(false); // nothing configured: nothing is the platform
      expect(config.isPlatformAccount({})).toBe(false);
      process.env.WA_WABA_ID = ' 222222222222222 ';
      process.env.WA_PHONE_ID = '111111111111111';
      expect(config.platformIds()).toEqual({ wabaId: '222222222222222', phoneNumberId: '111111111111111' });
      expect(config.isPlatformAccount({ wabaId: '222222222222222' })).toBe(true);
      expect(config.isPlatformAccount({ wabaId: 222222222222222 })).toBe(true);
      expect(config.isPlatformAccount({ wabaId: ' 222222222222222' })).toBe(true);
      expect(config.isPlatformAccount({ phoneNumberId: '111111111111111' })).toBe(true);
      expect(config.isPlatformAccount({ wabaId: '999', phoneNumberId: '111111111111111' })).toBe(true); // either id is enough
      expect(config.isPlatformAccount({ wabaId: '222222222222222', phoneNumberId: '5' })).toBe(true);
      expect(config.isPlatformAccount({ wabaId: '999', phoneNumberId: '5' })).toBe(false);
      expect(config.isPlatformAccount({ wabaId: '2222222222222220' })).toBe(false); // not the same string
      expect(config.isPlatformAccount({ wabaId: '111111111111111' })).toBe(false); // the phone id is not a WABA id
      for (const bad of [undefined, null, '', 0, [], 'x', {}, { wabaId: '' }, { wabaId: null, phoneNumberId: undefined }]) expect(config.isPlatformAccount(bad)).toBe(false);
      process.env.WA_WABA_ID = '   ';
      expect(config.platformIds().wabaId).toBeNull();
      expect(config.isPlatformAccount({ wabaId: '' })).toBe(false);
    } finally {
      if (saved.w === undefined) delete process.env.WA_WABA_ID; else process.env.WA_WABA_ID = saved.w;
      if (saved.p === undefined) delete process.env.WA_PHONE_ID; else process.env.WA_PHONE_ID = saved.p;
    }
  });
  test('on/off switches default off, reconcileOnDemand defaults on', () => {
    expect([config.checkoutEnabled(), config.billingPortalEnabled(), config.acceptTrialing(), config.strictLock()]).toEqual([false, false, false, false]);
    expect(config.reconcileOnDemand()).toBe(true);
    process.env.ONBOARDING_CHECKOUT = 'on';
    process.env.ONBOARDING_BILLING_RECONCILE_ON_DEMAND = 'off';
    expect(config.checkoutEnabled()).toBe(true);
    expect(config.reconcileOnDemand()).toBe(false);
  });
  test('stripe key falls back to STRIPE_SECRET_KEY', () => {
    expect(config.stripeSecretKey()).toBeNull();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fallback';
    expect(config.stripeSecretKey()).toBe('sk_test_fallback');
    process.env.ONBOARDING_STRIPE_SECRET_KEY = 'sk_test_own';
    expect(config.stripeSecretKey()).toBe('sk_test_own');
  });
  test('webhook secrets list (current + prev), no empties', () => {
    expect(config.stripeWebhookSecrets()).toEqual([]);
    process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET = 'whsec_a';
    process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET_PREV = 'whsec_b';
    expect(config.stripeWebhookSecrets()).toEqual(['whsec_a', 'whsec_b']);
  });
  test('stripePrices / planLabels never throw on bad JSON', () => {
    process.env.ONBOARDING_STRIPE_PRICES = '{bad';
    expect(config.stripePrices()).toEqual({});
    process.env.ONBOARDING_STRIPE_PRICES = '["x"]';
    expect(config.stripePrices()).toEqual({});
    process.env.ONBOARDING_STRIPE_PRICES = JSON.stringify({ basic: 'price_1', 'bad key!': 'price_2', pro: 5 });
    expect(config.stripePrices()).toEqual({ basic: 'price_1' });
    process.env.ONBOARDING_PLAN_LABELS = JSON.stringify({ basic: { en: 'Basic', ar: 'x' } });
    expect(config.planLabels()).toEqual({ basic: { en: 'Basic', ar: 'x' } });
  });
  test('webhookSignatureMode follows the flag unless set', () => {
    expect(config.webhookSignatureMode()).toBe('off');
    process.env.ONBOARDING_FLOW = 'on';
    expect(config.webhookSignatureMode()).toBe('enforce');
    process.env.ONBOARDING_WEBHOOK_SIGNATURE = 'log';
    expect(config.webhookSignatureMode()).toBe('log');
    process.env.ONBOARDING_WEBHOOK_SIGNATURE = 'weird';
    expect(config.webhookSignatureMode()).toBe('enforce');
  });
  test('scheduler interval / template ceiling / starter keys defaults and bounds', () => {
    expect(config.schedulerIntervalMs()).toBe(600000);
    process.env.ONBOARDING_SCHEDULER_INTERVAL_MS = '5';
    expect(config.schedulerIntervalMs()).toBe(600000);
    process.env.ONBOARDING_SCHEDULER_INTERVAL_MS = '120000';
    expect(config.schedulerIntervalMs()).toBe(120000);
    expect(config.templateCeiling()).toBe(90);
    process.env.ONBOARDING_TEMPLATE_CEILING = '40';
    expect(config.templateCeiling()).toBe(40);
    expect(config.starterTemplateKeys()).toEqual(['welcome_optin', 'promotion_weekend', 'promotion_new_arrival', 'comeback', 'points_balance', 'order_confirmation', 'booking_confirmation']);
    process.env.ONBOARDING_STARTER_TEMPLATES = 'comeback, BAD KEY ,welcome_optin';
    expect(config.starterTemplateKeys()).toEqual(['comeback', 'welcome_optin']);
  });
  test('supportConfig: both null by default (UI falls back to /support)', () => {
    expect(config.supportConfig()).toEqual({ email: null, whatsapp: null, fallbackPath: '/support', deskEmail: null });
    process.env.ONBOARDING_SUPPORT_EMAIL = 'help@example.com';
    process.env.ONBOARDING_SUPPORT_WHATSAPP = '+966 50 123 4567';
    process.env.SUPPORT_DESK_EMAIL = 'desk@example.com';
    expect(config.supportConfig()).toEqual({ email: 'help@example.com', whatsapp: '966501234567', fallbackPath: '/support', deskEmail: 'desk@example.com' });
    process.env.ONBOARDING_SUPPORT_WHATSAPP = '12';
    expect(config.supportConfig().whatsapp).toBeNull();
  });
  test('allowSharedKey only for "1"', () => {
    expect(config.allowSharedKey()).toBe(false);
    process.env.ONBOARDING_ALLOW_SHARED_KEY = 'true';
    expect(config.allowSharedKey()).toBe(false);
    process.env.ONBOARDING_ALLOW_SHARED_KEY = '1';
    expect(config.allowSharedKey()).toBe(true);
  });
  test('frontendUrl / appUrl normalised', () => {
    expect(config.frontendUrl()).toBe('http://localhost:4200');
    process.env.FRONTEND_URL = 'app.example.com/';
    expect(config.frontendUrl()).toBe('https://app.example.com');
    process.env.APP_URL = 'https://api.example.com//';
    expect(config.appUrl()).toBe('https://api.example.com');
  });
});

describe('constants', () => {
  test('industry keys are the locked C9 list', () => {
    expect(config.INDUSTRY_KEYS).toEqual(['restaurant', 'salon_beauty', 'fashion', 'grocery', 'electronics', 'health', 'fitness', 'home_furniture', 'services', 'other']);
  });
  test('step keys / indexes', () => {
    expect(config.STEP_KEYS).toEqual(['business', 'number', 'connect', 'approvals', 'promotion']);
    expect(config.STEP_INDEX).toEqual({ business: 1, number: 2, connect: 3, approvals: 4, promotion: 5 });
    expect(config.NEXT_STEPS).toEqual(['business', 'number', 'connect', 'approvals', 'customers', 'products', 'promotion']);
    expect(config.COUNTRY_CODES).toEqual(['SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'OTHER']);
  });
  test('constants are frozen', () => {
    expect(Object.isFrozen(config.INDUSTRY_KEYS)).toBe(true);
    expect(Object.isFrozen(config.STEP_KEYS)).toBe(true);
  });
});

describe('maskPhone / scrub / safeLog', () => {
  test('maskPhone keeps the last 4 digits', () => {
    expect(config.maskPhone('+966501234567')).toBe('********4567');
    expect(config.maskPhone('050 123 4567')).toBe('******4567');
    expect(config.maskPhone('123')).toBe('****');
    expect(config.maskPhone(undefined)).toBe('****');
    expect(config.maskPhone('966501234567')).not.toContain('96650123');
  });
  test('scrub masks phone numbers inside strings and objects', () => {
    const out = config.scrub({ msg: 'call +966501234567 now', nested: { n: ['9665 0123 4567'] } });
    expect(JSON.stringify(out)).not.toContain('501234567');
    expect(out.msg).toContain('4567');
  });
  test('scrub does not mangle ObjectIds or short numbers', () => {
    const id = '507f1f77bcf86cd799439011';
    expect(config.scrub(`workspace ${id} attempt 3 at 2026-10-15`)).toBe(`workspace ${id} attempt 3 at 2026-10-15`);
  });
  test('scrub drops token-like values and secret-named keys', () => {
    const token = 'EAAG' + 'x'.repeat(60);
    expect(config.scrub(`bad ${token} end`)).toBe('bad [redacted] end');
    const out = config.scrub({ accessToken: 'abc', code: 'AQBxyz123authcode', pin: '123456', note: 'ok', clientSecret: 's' });
    expect(out).toEqual({ accessToken: '[redacted]', code: '[redacted]', pin: '[redacted]', note: 'ok', clientSecret: '[redacted]' });
  });
  test('scrub keeps catalogue codes in a "code" key', () => {
    expect(config.scrub({ code: 'META_ERROR' })).toEqual({ code: 'META_ERROR' });
  });
  test('scrub reduces Errors to code + message', () => {
    const e = new Error('failed for +966501234567');
    e.code = 'X_CODE';
    e.stack = 'SECRET STACK';
    const out = config.scrub(e);
    expect(out.code).toBe('X_CODE');
    expect(out.message).not.toContain('501234567');
    expect(JSON.stringify(out)).not.toContain('STACK');
  });
  test('safeLog masks args and never throws', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    config.safeLog('warn', '[t]', 'phone +966501234567', { token: 'zzz' });
    const printed = JSON.stringify(spy.mock.calls);
    expect(printed).not.toContain('501234567');
    expect(printed).not.toContain('zzz');
    spy.mockRestore();
    const cyc = {}; cyc.self = cyc;
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => config.safeLog('nonexistent-level', '[t]', cyc)).not.toThrow();
    logSpy.mockRestore();
  });
});
