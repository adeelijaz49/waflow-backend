'use strict';
const { CODES, OnbError, respond, fail, isOnbError, statusFor, ACCESS_CODES } = require('../../../shared/onboarding/errors');

// DB design 4.7, verbatim.
const DB_CODES = [
  'ONBOARDING_NOT_AVAILABLE', 'SUBSCRIPTION_REQUIRED', 'PAYMENT_PENDING', 'PAYMENT_PAST_DUE', 'SUBSCRIPTION_CANCELLED',
  'WHATSAPP_NOT_CONNECTED', 'WHATSAPP_RECONNECT_REQUIRED', 'SENDING_NOT_AVAILABLE_YET', 'OWNER_ONLY', 'LEGAL_ACCEPTANCE_REQUIRED',
  'VALIDATION_FAILED', 'STEP_PREREQUISITE', 'NUMBER_PERSONAL_WARNING_REQUIRED', 'NUMBER_ALREADY_CONNECTED', 'RATE_LIMITED',
  'CHECKOUT_NOT_CONFIGURED', 'PLAN_UNKNOWN', 'BILLING_PORTAL_UNAVAILABLE', 'STRIPE_ERROR',
  'CONNECT_NOT_CONFIGURED', 'ENCRYPTION_NOT_CONFIGURED', 'CONNECT_IN_PROGRESS', 'CONNECT_ATTEMPT_INVALID', 'CONNECT_CODE_INVALID_OR_EXPIRED',
  'CONNECT_WABA_MISMATCH', 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT', 'CONNECT_NUMBER_REGISTERED_ELSEWHERE', 'CONNECT_VERIFICATION_FAILED',
  'CONNECT_CANCELLED', 'CONNECT_NO_FACEBOOK_ACCOUNT', 'CONNECT_COEXISTENCE_UNAVAILABLE', 'CONNECT_REGISTER_RATE_LIMITED', 'CONNECT_PARTIAL',
  'CONNECT_AMBIGUOUS_WABA',
  'META_UNREACHABLE', 'META_ERROR', 'META_TOKEN_REVOKED', 'META_PERMISSION_MISSING', 'META_RATE_LIMITED', 'META_NOT_CONFIGURED',
  'TEMPLATE_LIMIT_REACHED', 'TEMPLATE_REJECTED', 'TEST_RATE_LIMITED', 'TEST_NO_APPROVED_TEMPLATE', 'TEST_RECIPIENT_OPTED_OUT', 'TEST_PHONE_INVALID', 'TEST_NUMBER_LIMIT',
];

function fakeRes() {
  const res = { headers: {}, statusCode: null, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}

describe('catalogue', () => {
  test('contains every DB 4.7 code and only the recorded additions (INTERNAL_ERROR, NOT_A_MEMBER, NOT_IMPLEMENTED, SUBSCRIPTION_EXISTS)', () => {
    const keys = Object.keys(CODES);
    for (const c of DB_CODES) expect(keys).toContain(c);
    expect(keys.filter((k) => !DB_CODES.includes(k)).sort()).toEqual(['INTERNAL_ERROR', 'NOT_A_MEMBER', 'NOT_IMPLEMENTED', 'SUBSCRIPTION_EXISTS']);
    expect(DB_CODES).toHaveLength(47);
    expect(keys).toHaveLength(51);
    // review R2-05: a member who was REMOVED (the 30-day JWT still verifies) is refused with a 403 of its own
    expect(CODES.NOT_A_MEMBER).toEqual({ status: 403, nextStep: null, retryable: false, message: 'You are no longer a member of this workspace.' });
  });
  test('ruling 8: SUBSCRIPTION_EXISTS is 409, nextStep billing, not retryable, and its body can carry extra top-level keys', () => {
    expect(CODES.SUBSCRIPTION_EXISTS).toEqual({ status: 409, nextStep: 'billing', retryable: false, message: 'You already have a subscription.' });
    const e = new OnbError('SUBSCRIPTION_EXISTS', { extra: { subscription: { state: 'active' }, code: 'HIJACK', error: 'x' } });
    const res = fakeRes();
    respond(res, e);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'You already have a subscription.', code: 'SUBSCRIPTION_EXISTS', nextStep: 'billing', retryable: false, subscription: { state: 'active' } }); // standard keys can never be overwritten
  });
  test('every entry has an HTTP status that is not 401 and a message', () => {
    for (const [code, def] of Object.entries(CODES)) {
      expect(def.status).not.toBe(401);
      expect([402, 403, 404, 409, 422, 429, 500, 503]).toContain(def.status);
      expect(typeof def.message).toBe('string');
      expect(def.message.length).toBeGreaterThan(3);
      expect(typeof def.retryable).toBe('boolean');
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });
  test('access codes are 402 (except owner/legal 403 and not-available 404)', () => {
    for (const c of ACCESS_CODES) expect(statusFor(c)).toBe(402);
    expect(statusFor('OWNER_ONLY')).toBe(403);
    expect(statusFor('LEGAL_ACCEPTANCE_REQUIRED')).toBe(403);
    expect(statusFor('ONBOARDING_NOT_AVAILABLE')).toBe(404);
    expect(statusFor('RATE_LIMITED')).toBe(429);
    expect(statusFor('NOPE')).toBe(500);
  });
  test('catalogue is frozen', () => { expect(Object.isFrozen(CODES)).toBe(true); });
});

describe('OnbError', () => {
  test('defaults come from the catalogue', () => {
    const e = new OnbError('PAYMENT_PAST_DUE');
    expect(e).toBeInstanceOf(Error);
    expect(isOnbError(e)).toBe(true);
    expect(e.status).toBe(402);
    expect(e.code).toBe('PAYMENT_PAST_DUE');
    expect(e.nextStep).toBe('billing');
    expect(e.retryable).toBe(false);
  });
  test('options override', () => {
    const e = new OnbError('VALIDATION_FAILED', { message: 'name too short', status: 400, nextStep: 'business', retryable: true, details: { field: 'name' }, retry: { checkout: true } });
    expect(e.message).toBe('name too short');
    expect(e.status).toBe(400);
    expect(e.nextStep).toBe('business');
    expect(e.retryable).toBe(true);
    expect(e.details).toEqual({ field: 'name' });
    expect(e.retry).toEqual({ checkout: true });
  });
  test('unknown code becomes INTERNAL_ERROR', () => {
    const e = new OnbError('MADE_UP');
    expect(e.code).toBe('INTERNAL_ERROR');
    expect(e.status).toBe(500);
  });
  test('fail() throws', () => {
    expect(() => fail('OWNER_ONLY')).toThrow(OnbError);
  });
});

describe('respond', () => {
  test('writes { error, code, nextStep, retryable } with the status', () => {
    const res = fakeRes();
    respond(res, new OnbError('WHATSAPP_NOT_CONNECTED'));
    expect(res.statusCode).toBe(402);
    expect(res.body).toEqual({ error: CODES.WHATSAPP_NOT_CONNECTED.message, code: 'WHATSAPP_NOT_CONNECTED', nextStep: 'connect', retryable: false });
  });
  test('omits nextStep when null; includes details and retry', () => {
    const res = fakeRes();
    respond(res, new OnbError('SENDING_NOT_AVAILABLE_YET', { retry: { checkout: false, billingPortal: false, reconnect: false }, details: { a: 1 } }));
    expect(res.body.nextStep).toBeUndefined();
    expect(res.body.retry).toEqual({ checkout: false, billingPortal: false, reconnect: false });
    expect(res.body.details).toEqual({ a: 1 });
  });
  test('never answers 401: it becomes 403', () => {
    const res = fakeRes();
    respond(res, new OnbError('OWNER_ONLY', { status: 401 }));
    expect(res.statusCode).toBe(403);
  });
  test('Retry-After header for retryAfterSec', () => {
    const res = fakeRes();
    respond(res, new OnbError('RATE_LIMITED', { retryAfterSec: 12.2 }));
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('13');
  });
  test('an unexpected error becomes a generic 500 and leaks nothing', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();
    respond(res, new Error('db password is hunter2 for +966501234567'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Something went wrong', code: 'INTERNAL_ERROR', retryable: true });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('501234567');
    spy.mockRestore();
  });
  test('NOT_IMPLEMENTED stubs map to 503', () => {
    const res = fakeRes();
    const err = new Error('x'); err.code = 'NOT_IMPLEMENTED';
    respond(res, err);
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('NOT_IMPLEMENTED');
  });
  test('ENCRYPTION_NOT_CONFIGURED from the vault maps to its catalogue entry', () => {
    const res = fakeRes();
    const { EncryptionNotConfigured } = require('../../../shared/onboarding/tokenVault');
    respond(res, new EncryptionNotConfigured());
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('ENCRYPTION_NOT_CONFIGURED');
  });
  test('does not write twice when headers were already sent', () => {
    const res = fakeRes();
    res.headersSent = true;
    respond(res, new OnbError('OWNER_ONLY'));
    expect(res.body).toBeNull();
  });
});
