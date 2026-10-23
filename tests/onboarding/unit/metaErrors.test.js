'use strict';
const { classify, popupOutcome, TABLE, POPUP_CODES } = require('../../../shared/onboarding/metaErrors');
const { CODES } = require('../../../shared/onboarding/errors');

describe('classify: Graph codes (DB 6.3)', () => {
  test.each([
    [{ code: 190 }, 'reconnect', 'META_TOKEN_REVOKED', false],
    [{ code: 190, subcode: 458 }, 'reconnect', 'META_TOKEN_REVOKED', false],
    [{ code: 190, subcode: 460 }, 'reconnect', 'META_TOKEN_REVOKED', false],
    [{ code: 190, subcode: 463 }, 'reconnect', 'META_TOKEN_REVOKED', false],
    [{ code: 190, subcode: 467 }, 'reconnect', 'META_TOKEN_REVOKED', false],
    [{ code: 102 }, 'reconnect', 'META_TOKEN_REVOKED', false],
    [{ code: 10 }, 'permission', 'META_PERMISSION_MISSING', false],
    [{ code: 200 }, 'permission', 'META_PERMISSION_MISSING', false],
    [{ code: 250 }, 'permission', 'META_PERMISSION_MISSING', false],
    [{ code: 299 }, 'permission', 'META_PERMISSION_MISSING', false],
    [{ code: 4 }, 'retry', 'META_RATE_LIMITED', true],
    [{ code: 17 }, 'retry', 'META_RATE_LIMITED', true],
    [{ code: 32 }, 'retry', 'META_RATE_LIMITED', true],
    [{ code: 613 }, 'retry', 'META_RATE_LIMITED', true],
    [{ code: 80007 }, 'retry', 'META_RATE_LIMITED', true],
    [{ code: 130429 }, 'retry', 'META_RATE_LIMITED', true],
    [{ code: 131056 }, 'retry', 'META_RATE_LIMITED', true],
    [{ code: 133016 }, 'register_rate', 'CONNECT_REGISTER_RATE_LIMITED', false],
    [{ code: 100, subcode: 2388024 }, 'duplicate_template', 'META_ERROR', false],
    [{ code: 141002 }, 'template', 'META_ERROR', false],
  ])('%j -> %s / %s', (shape, kind, appCode, retryable) => {
    expect(classify(shape)).toMatchObject({ kind, appCode, retryable });
  });

  test('boundaries: 199 and 300 are not permission errors; plain 100 is unknown; unknown codes -> META_ERROR', () => {
    expect(classify({ code: 199 }).kind).toBe('unknown');
    expect(classify({ code: 300 }).kind).toBe('unknown');
    expect(classify({ code: 100 })).toMatchObject({ kind: 'unknown', appCode: 'META_ERROR' });
    expect(classify({ code: 100, subcode: 33 }).kind).toBe('unknown');
    expect(classify({ code: 99999 })).toMatchObject({ kind: 'unknown', appCode: 'META_ERROR', retryable: false });
  });

  test('unverified codes are flagged, and only those', () => {
    for (const code of [131042, 131031, 133010]) expect(classify({ code }).unverified).toBe(true);
    for (const code of [190, 102, 10, 200, 4, 17, 133016, 141002]) expect(classify({ code }).unverified).toBeUndefined();
    expect(classify({ code: 131042 }).kind).toBe('payment');
    expect(classify({ code: 131031 }).kind).toBe('locked');
    expect(classify({ code: 133010 }).kind).toBe('not_registered');
    expect(TABLE.filter((r) => r.unverified).map((r) => r.id).sort()).toEqual(['locked', 'not_registered', 'payment']);
  });

  test('accepts MetaGraphError-like objects, raw Graph bodies, axios-style responses and string codes', () => {
    expect(classify({ httpStatus: 400, code: 190, subcode: 463 }).kind).toBe('reconnect');
    expect(classify({ error: { code: 190, error_subcode: 463 } }).kind).toBe('reconnect');
    expect(classify({ status: 400, data: { error: { code: '133016' } } }).kind).toBe('register_rate');
    expect(classify({ code: '17' }).kind).toBe('retry');
    expect(classify({ error: { code: 100, error_subcode: '2388024' } }).kind).toBe('duplicate_template');
  });

  test('network failures and HTTP-only failures', () => {
    for (const code of ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']) {
      expect(classify({ code, message: 'x' })).toEqual({ kind: 'network', appCode: 'META_UNREACHABLE', retryable: true });
    }
    expect(classify({ networkCode: 'ETIMEDOUT' }).kind).toBe('network');
    expect(classify({ httpStatus: 503 })).toEqual({ kind: 'unknown', appCode: 'META_ERROR', retryable: true });
    expect(classify({ httpStatus: 429 })).toMatchObject({ kind: 'retry', appCode: 'META_RATE_LIMITED', retryable: true });
    expect(classify({ httpStatus: 400 }).retryable).toBe(false);
  });

  test('garbage in, unknown out (never throws)', () => {
    for (const v of [undefined, null, 'x', 7, [], {}, { code: {} }, { error: 'text' }]) {
      expect(classify(v)).toMatchObject({ kind: 'unknown', appCode: 'META_ERROR' });
    }
  });

  test('every appCode of the table is a catalogue code (so errors.respond can answer it)', () => {
    for (const row of TABLE) expect(CODES[row.appCode]).toBeDefined();
    expect(classify({ code: 4 }).appCode in CODES).toBe(true);
  });
});

describe('popupOutcome (DB 6.3 + DECISIONS C3)', () => {
  const key = (code) => `onboarding.errors.${code}`;
  test('CANCEL without an error code, whatever the step -> CONNECT_CANCELLED', () => {
    for (const currentStep of [undefined, 'PHONE_NUMBER_SETUP', 'BUSINESS_INFO']) {
      expect(popupOutcome({ event: 'CANCEL', currentStep })).toEqual({ outcome: 'cancelled', code: 'CONNECT_CANCELLED', nextStep: 'connect', copyKey: key('CONNECT_CANCELLED') });
    }
  });
  test('NO_FACEBOOK -> CONNECT_NO_FACEBOOK_ACCOUNT', () => {
    expect(popupOutcome({ event: 'NO_FACEBOOK' })).toEqual({ outcome: 'no_facebook', code: 'CONNECT_NO_FACEBOOK_ACCOUNT', nextStep: 'connect', copyKey: key('CONNECT_NO_FACEBOOK_ACCOUNT') });
    expect(popupOutcome({ event: 'no_facebook', errorCode: 3441030 }).code).toBe('CONNECT_NO_FACEBOOK_ACCOUNT');
  });
  test.each([3441030, 3441049, 2655094, 2655082])('number registered elsewhere: %i -> number step', (errorCode) => {
    expect(popupOutcome({ event: 'ERROR', errorCode })).toEqual({ outcome: 'error', code: 'CONNECT_NUMBER_REGISTERED_ELSEWHERE', nextStep: 'number', copyKey: key('CONNECT_NUMBER_REGISTERED_ELSEWHERE') });
  });
  test.each([2388091, 2593039, 2388093, 2593037, 2494158])('verification problems: %i', (errorCode) => {
    expect(popupOutcome({ event: 'CANCEL', errorCode })).toMatchObject({ outcome: 'error', code: 'CONNECT_VERIFICATION_FAILED', nextStep: 'connect' });
  });
  test.each([3441042, 3441045, 4563015, 2655095])('coexistence: %i', (errorCode) => {
    expect(popupOutcome({ event: 'ERROR', errorCode })).toMatchObject({ code: 'CONNECT_COEXISTENCE_UNAVAILABLE', nextStep: 'number' });
  });
  test('error codes may arrive as numeric strings; unknown codes and a bare ERROR are a generic retry', () => {
    expect(popupOutcome({ event: 'ERROR', errorCode: '3441030' }).code).toBe('CONNECT_NUMBER_REGISTERED_ELSEWHERE');
    expect(popupOutcome({ event: 'ERROR', errorCode: 123 })).toMatchObject({ outcome: 'error', code: 'META_ERROR', nextStep: 'connect' });
    expect(popupOutcome({ event: 'ERROR' }).code).toBe('META_ERROR');
    expect(popupOutcome({ event: 'ERROR', errorCode: 'abc' }).code).toBe('META_ERROR');
    expect(popupOutcome({ event: 'CANCEL', errorCode: 'abc' }).code).toBe('CONNECT_CANCELLED');
  });
  test('malformed input never throws', () => {
    expect(popupOutcome(undefined).code).toBe('CONNECT_CANCELLED');
    expect(popupOutcome({}).code).toBe('CONNECT_CANCELLED');
  });
  test('every outcome code is a catalogue code and the code lists do not overlap', () => {
    const all = Object.values(POPUP_CODES).flat();
    expect(new Set(all).size).toBe(all.length);
    for (const c of ['CONNECT_CANCELLED', 'CONNECT_NO_FACEBOOK_ACCOUNT', 'CONNECT_NUMBER_REGISTERED_ELSEWHERE', 'CONNECT_VERIFICATION_FAILED', 'CONNECT_COEXISTENCE_UNAVAILABLE', 'META_ERROR']) expect(CODES[c]).toBeDefined();
  });
});
