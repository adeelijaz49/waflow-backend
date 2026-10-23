'use strict';
const adapter = require('../../../shared/onboarding/stripeAdapter');
const { OnbError } = require('../../../shared/onboarding/errors');
const {
  createFakeStripe, makeSubscription, makeInvoice, makeCheckoutSession, signedEvent, TEST_WEBHOOK_SECRET,
} = require('../_fixtures');

const ENV_KEYS = ['FRONTEND_URL', 'ONBOARDING_STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY'];
const saved = {};
beforeEach(() => { ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); adapter._resetClient(); });
afterEach(() => { ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); adapter._resetClient(); });

describe('mapStripeStatus (DB table 4.2)', () => {
  test.each([
    ['active', 'active'],
    ['trialing', 'pending'],
    ['incomplete', 'pending'],
    ['incomplete_expired', 'none'],
    ['past_due', 'past_due'],
    ['unpaid', 'past_due'],
    ['paused', 'past_due'],
    ['canceled', 'cancelled'],
  ])('%s -> %s', (raw, state) => {
    expect(adapter.mapStripeStatus(raw, {}).state).toBe(state);
  });
  test('trialing stays pending (TRIAL_NOT_RECOGNISED) unless accepted AND a default payment method exists', () => {
    expect(adapter.mapStripeStatus('trialing', {})).toEqual({ state: 'pending', reason: 'TRIAL_NOT_RECOGNISED' });
    expect(adapter.mapStripeStatus('trialing', { acceptTrialing: true }).state).toBe('pending');
    expect(adapter.mapStripeStatus('trialing', { hasDefaultPaymentMethod: true }).state).toBe('pending');
    expect(adapter.mapStripeStatus('trialing', { acceptTrialing: true, hasDefaultPaymentMethod: true })).toEqual({ state: 'active', reason: 'TRIAL_ACCEPTED' });
  });
  test.each(['', undefined, null, 'whatever', 'ACTIVE_ISH'])('unknown status %p -> state null (never guess)', (raw) => {
    expect(adapter.mapStripeStatus(raw, {}).state).toBeNull();
  });
  test('works without a context argument', () => {
    expect(adapter.mapStripeStatus('active').state).toBe('active');
  });
});

describe('readPeriodEnd (current and basil shapes)', () => {
  const end = 1_800_000_000;
  test('current shape: on the subscription', () => {
    const sub = makeSubscription({ shape: 'current', currentPeriodEnd: end });
    expect(sub.items.data[0].current_period_end).toBeUndefined();
    expect(adapter.readPeriodEnd(sub)).toEqual(new Date(end * 1000));
  });
  test('basil shape: only on the items', () => {
    const sub = makeSubscription({ shape: 'basil', currentPeriodEnd: end });
    expect(sub.current_period_end).toBeUndefined();
    expect(adapter.readPeriodEnd(sub)).toEqual(new Date(end * 1000));
  });
  test('several items: the latest end wins', () => {
    const sub = makeSubscription({ shape: 'basil', items: [{ currentPeriodEnd: end }, { currentPeriodEnd: end + 500 }, { currentPeriodEnd: end - 500 }] });
    expect(adapter.readPeriodEnd(sub)).toEqual(new Date((end + 500) * 1000));
  });
  test('the subscription-level value wins over the items', () => {
    const sub = makeSubscription({ shape: 'basil', currentPeriodEnd: end });
    sub.current_period_end = end + 10;
    expect(adapter.readPeriodEnd(sub)).toEqual(new Date((end + 10) * 1000));
  });
  test('numeric strings are accepted; junk gives null', () => {
    expect(adapter.readPeriodEnd({ current_period_end: String(end) })).toEqual(new Date(end * 1000));
    for (const bad of [null, undefined, {}, { current_period_end: 'x' }, { current_period_end: 0 }, { current_period_end: -5 }, { items: { data: [{}] } }, { items: {} }, 'str', 42]) {
      expect(adapter.readPeriodEnd(bad)).toBeNull();
    }
  });
});

describe('readSubscriptionIdFromInvoice (current and basil shapes)', () => {
  test('current: invoice.subscription', () => {
    const inv = makeInvoice({ shape: 'current', subscription: 'sub_abc' });
    expect(inv.parent).toBeUndefined();
    expect(adapter.readSubscriptionIdFromInvoice(inv)).toBe('sub_abc');
  });
  test('basil: invoice.parent.subscription_details.subscription', () => {
    const inv = makeInvoice({ shape: 'basil', subscription: 'sub_abc' });
    expect(inv.subscription).toBeUndefined();
    expect(adapter.readSubscriptionIdFromInvoice(inv)).toBe('sub_abc');
  });
  test('expanded objects and the line-item fallback', () => {
    expect(adapter.readSubscriptionIdFromInvoice({ subscription: { id: 'sub_x' } })).toBe('sub_x');
    expect(adapter.readSubscriptionIdFromInvoice({ parent: { subscription_details: { subscription: { id: 'sub_y' } } } })).toBe('sub_y');
    expect(adapter.readSubscriptionIdFromInvoice({ lines: { data: [{ parent: { subscription_item_details: { subscription: 'sub_z' } } }] } })).toBe('sub_z');
    expect(adapter.readSubscriptionIdFromInvoice({ lines: { data: [{ subscription: 'sub_w' }] } })).toBe('sub_w');
  });
  test('a one-off invoice (no subscription) and junk give null', () => {
    for (const bad of [null, undefined, {}, makeInvoice({ subscription: null }), { subscription: 12 }, { subscription: 'sub with space' }, 'x']) {
      expect(adapter.readSubscriptionIdFromInvoice(bad)).toBeNull();
    }
  });
});

describe('small readers', () => {
  test('idOf / readCustomerId / readPriceId', () => {
    expect(adapter.idOf('cus_1')).toBe('cus_1');
    expect(adapter.idOf({ id: 'cus_2' })).toBe('cus_2');
    expect(adapter.idOf({})).toBeNull();
    expect(adapter.idOf('')).toBeNull();
    expect(adapter.idOf(5)).toBeNull();
    expect(adapter.readCustomerId({ customer: { id: 'cus_3' } })).toBe('cus_3');
    expect(adapter.readCustomerId(null)).toBeNull();
    expect(adapter.readPriceId(makeSubscription({ priceId: 'price_9' }))).toBe('price_9');
    expect(adapter.readPriceId({})).toBeNull();
  });
  test('hasDefaultPaymentMethod', () => {
    expect(adapter.hasDefaultPaymentMethod(makeSubscription({}))).toBe(true);
    expect(adapter.hasDefaultPaymentMethod(makeSubscription({ defaultPaymentMethod: null }))).toBe(false);
    expect(adapter.hasDefaultPaymentMethod({ default_payment_method: { id: 'pm_1' } })).toBe(true);
    expect(adapter.hasDefaultPaymentMethod({ customer: { invoice_settings: { default_payment_method: 'pm_2' } } })).toBe(true);
    expect(adapter.hasDefaultPaymentMethod(null)).toBe(false);
  });
});

describe('extractPrefill', () => {
  test('custom field + customer_details + planCode', () => {
    const s = makeCheckoutSession({ email: 'owner@example.test', businessName: 'Acme Sweets', metadata: { planCode: 'standard' } });
    expect(adapter.extractPrefill(s)).toEqual({ email: 'owner@example.test', businessName: 'Acme Sweets', planCode: 'standard' });
  });
  test('the unverified name_collection paths are read only when present', () => {
    const viaDetails = makeCheckoutSession({ businessName: 'Via Details', businessNameVia: 'customer_details' });
    expect(adapter.extractPrefill(viaDetails).businessName).toBe('Via Details');
    expect(adapter.extractPrefill({ collected_information: { business_name: 'Collected' } }).businessName).toBe('Collected');
  });
  test('customer_email is the fallback; invalid e-mail and phone-like values are dropped', () => {
    expect(adapter.extractPrefill({ customer_details: null, customer_email: 'a@b.co' }).email).toBe('a@b.co');
    expect(adapter.extractPrefill({ customer_details: { email: '+966501234567' } }).email).toBeNull();
    expect(adapter.extractPrefill({ customer_details: { email: 'not-an-email' } }).email).toBeNull();
  });
  test('control and bidi characters are stripped, lengths bounded, planCode charset enforced', () => {
    const evil = ['Bad', String.fromCharCode(0), 'Name', String.fromCodePoint(0x202e), 'x'.repeat(200)].join('');
    const p = adapter.extractPrefill({ custom_fields: [{ key: 'business_name', text: { value: evil } }], metadata: { planCode: 'bad code!' } });
    expect(p.businessName.length).toBeLessThanOrEqual(80);
    expect(p.businessName).not.toMatch(/[\x00-\x1f]/);
    expect(p.businessName).not.toContain(String.fromCodePoint(0x202e));
    expect(p.planCode).toBeNull();
  });
  test('junk input', () => {
    expect(adapter.extractPrefill(null)).toEqual({ email: null, businessName: null, planCode: null });
    expect(adapter.extractPrefill({ custom_fields: 'x' })).toEqual({ email: null, businessName: null, planCode: null });
  });
});

describe('verifyEvent (signature, rolling secrets)', () => {
  const OLD = 'whsec_previous_dummy_secret_not_real_9876543210';
  const body = (o) => signedEvent(o);
  const evt = (extra) => ({ type: 'invoice.paid', object: makeInvoice({}), ...extra });

  test('valid signature returns the event', () => {
    const s = body(evt());
    const e = adapter.verifyEvent(s.body, s.header, { secrets: [TEST_WEBHOOK_SECRET] });
    expect(e.id).toBe(s.event.id);
    expect(e.type).toBe('invoice.paid');
  });
  test('a string body works too', () => {
    const s = body(evt());
    expect(adapter.verifyEvent(s.payload, s.header, { secrets: [TEST_WEBHOOK_SECRET] }).id).toBe(s.event.id);
  });
  test('wrong secret -> WEBHOOK_SIGNATURE_INVALID', () => {
    const s = body(evt({ secret: 'whsec_somebody_else_dummy' }));
    expect(() => adapter.verifyEvent(s.body, s.header, { secrets: [TEST_WEBHOOK_SECRET] })).toThrow(expect.objectContaining({ code: 'WEBHOOK_SIGNATURE_INVALID' }));
  });
  test('rolling secrets: the previous secret still verifies, in either list position', () => {
    const s = body(evt({ secret: OLD }));
    expect(adapter.verifyEvent(s.body, s.header, { secrets: [TEST_WEBHOOK_SECRET, OLD] }).id).toBe(s.event.id);
    expect(adapter.verifyEvent(s.body, s.header, { secrets: [OLD, TEST_WEBHOOK_SECRET] }).id).toBe(s.event.id);
  });
  test('a retired secret that is no longer configured is rejected', () => {
    const s = body(evt({ secret: OLD }));
    expect(() => adapter.verifyEvent(s.body, s.header, { secrets: [TEST_WEBHOOK_SECRET] })).toThrow(expect.objectContaining({ code: 'WEBHOOK_SIGNATURE_INVALID' }));
  });
  test('missing or blank header -> WEBHOOK_SIGNATURE_MISSING', () => {
    const s = body(evt());
    for (const h of [undefined, null, '', '   ']) {
      expect(() => adapter.verifyEvent(s.body, h, { secrets: [TEST_WEBHOOK_SECRET] })).toThrow(expect.objectContaining({ code: 'WEBHOOK_SIGNATURE_MISSING' }));
    }
  });
  test('tampered body -> invalid', () => {
    const s = body(evt());
    const tampered = Buffer.from(s.payload.replace('invoice.paid', 'invoice.xaid'), 'utf8');
    expect(() => adapter.verifyEvent(tampered, s.header, { secrets: [TEST_WEBHOOK_SECRET] })).toThrow(expect.objectContaining({ code: 'WEBHOOK_SIGNATURE_INVALID' }));
  });
  test('a stale delivery (header timestamp outside the tolerance) is rejected', () => {
    const s = body(evt({ timestamp: Math.floor(Date.now() / 1000) - 3600 }));
    expect(() => adapter.verifyEvent(s.body, s.header, { secrets: [TEST_WEBHOOK_SECRET] })).toThrow(expect.objectContaining({ code: 'WEBHOOK_SIGNATURE_INVALID' }));
  });
  test('an already parsed body (express.json ran first) is refused, not verified', () => {
    const s = body(evt());
    expect(() => adapter.verifyEvent(JSON.parse(s.payload), s.header, { secrets: [TEST_WEBHOOK_SECRET] })).toThrow(expect.objectContaining({ code: 'WEBHOOK_BODY_INVALID' }));
    expect(() => adapter.verifyEvent(Buffer.alloc(0), s.header, { secrets: [TEST_WEBHOOK_SECRET] })).toThrow(expect.objectContaining({ code: 'WEBHOOK_BODY_INVALID' }));
  });
  test('no secrets configured -> WEBHOOK_SECRET_MISSING (empty strings do not count)', () => {
    const s = body(evt());
    for (const secrets of [undefined, [], ['', null]]) {
      expect(() => adapter.verifyEvent(s.body, s.header, { secrets })).toThrow(expect.objectContaining({ code: 'WEBHOOK_SECRET_MISSING' }));
    }
  });
  test('uses an injected client when given (the fake wraps the real offline helper)', () => {
    const fake = createFakeStripe({});
    const s = fake.signedEvent(evt());
    expect(adapter.verifyEvent(s.body, s.header, { secrets: [fake.webhookSecret], stripe: fake }).id).toBe(s.event.id);
  });
  test('the thrown error never contains the secret', () => {
    const s = body(evt({ secret: 'whsec_somebody_else_dummy' }));
    try { adapter.verifyEvent(s.body, s.header, { secrets: [TEST_WEBHOOK_SECRET] }); } catch (err) {
      expect(JSON.stringify([err.message, err.code])).not.toContain(TEST_WEBHOOK_SECRET);
    }
  });
});

describe('buildCheckoutParams (DB 4.9)', () => {
  test('exact payload', () => {
    process.env.FRONTEND_URL = 'https://app.example.test/';
    const p = adapter.buildCheckoutParams({ workspaceId: '507f1f77bcf86cd799439011', planCode: 'standard', priceId: 'price_abc', email: 'owner@example.test' });
    const meta = { workspaceId: '507f1f77bcf86cd799439011', planCode: 'standard', waflow_purpose: 'merchant_subscription' };
    expect(p).toEqual({
      mode: 'subscription',
      line_items: [{ price: 'price_abc', quantity: 1 }],
      client_reference_id: '507f1f77bcf86cd799439011',
      metadata: meta,
      subscription_data: { metadata: meta },
      customer_email: 'owner@example.test',
      custom_fields: [{ key: 'business_name', label: { type: 'custom', custom: 'Business name' }, type: 'text' }],
      payment_method_collection: 'always',
      success_url: 'https://app.example.test/setup?checkout=return',
      cancel_url: 'https://app.example.test/setup?checkout=cancel',
    });
  });
  test('the metadata objects are separate copies', () => {
    const p = adapter.buildCheckoutParams({ workspaceId: 'w', planCode: 'p', priceId: 'x' });
    expect(p.metadata).not.toBe(p.subscription_data.metadata);
  });
  test('customer_email only when a valid e-mail is known (never a phone number)', () => {
    for (const email of [undefined, null, '', '+966501234567', '966501234567', 'no-at-sign']) {
      const p = adapter.buildCheckoutParams({ workspaceId: 'w', planCode: 'p', priceId: 'x', email });
      expect(Object.prototype.hasOwnProperty.call(p, 'customer_email')).toBe(false);
    }
  });
  test('defaults to the local frontend url', () => {
    const p = adapter.buildCheckoutParams({ workspaceId: 'w', planCode: 'p', priceId: 'x' });
    expect(p.success_url).toBe('http://localhost:4200/setup?checkout=return');
  });
  test('the stripe fake accepts the payload (mode, line_items, success_url present)', async () => {
    const fake = createFakeStripe({});
    const s = await fake.checkout.sessions.create(adapter.buildCheckoutParams({ workspaceId: 'w', planCode: 'p', priceId: 'x' }));
    expect(s.url).toMatch(/^https:\/\//);
  });
});

describe('getStripeClient', () => {
  test('an injected client is returned as is', () => {
    const fake = {};
    expect(adapter.getStripeClient({ stripe: fake })).toBe(fake);
  });
  test('no key -> CHECKOUT_NOT_CONFIGURED', () => {
    expect(() => adapter.getStripeClient({})).toThrow(OnbError);
    expect(() => adapter.getStripeClient()).toThrow(expect.objectContaining({ code: 'CHECKOUT_NOT_CONFIGURED', status: 503 }));
  });
  test('a configured key builds (and caches) a real client without opening a socket', () => {
    process.env.ONBOARDING_STRIPE_SECRET_KEY = 'sk_test_dummy_unit';
    const a = adapter.getStripeClient();
    expect(typeof a.checkout.sessions.create).toBe('function');
    expect(typeof a.subscriptions.retrieve).toBe('function');
    expect(adapter.getStripeClient()).toBe(a);
    process.env.ONBOARDING_STRIPE_SECRET_KEY = 'sk_test_dummy_other';
    expect(adapter.getStripeClient()).not.toBe(a);
  });
  test('falls back to STRIPE_SECRET_KEY', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_fallback';
    expect(typeof adapter.getStripeClient().webhooks.constructEvent).toBe('function');
  });
});

describe('classifyStripeError', () => {
  test('request and credential problems are config; connection and server problems are transient', () => {
    const fake = createFakeStripe({});
    expect(adapter.classifyStripeError({ type: 'StripeInvalidRequestError' })).toBe('config');
    expect(adapter.classifyStripeError({ rawType: 'invalid_request_error' })).toBe('config');
    expect(adapter.classifyStripeError({ type: 'StripeAuthenticationError' })).toBe('config');
    expect(adapter.classifyStripeError({ type: 'StripeConnectionError' })).toBe('transient');
    expect(adapter.classifyStripeError({ type: 'StripeRateLimitError' })).toBe('transient');
    expect(adapter.classifyStripeError(new Error('x'))).toBe('transient');
    expect(adapter.classifyStripeError(null)).toBe('transient');
    expect(fake).toBeTruthy();
  });
});
