'use strict';
const gate = require('../../../shared/onboarding/gate');

const conn = (status, needsReconnect = false) => ({ status, needsReconnect });
const enrolled = (state, connection, extra = {}) => ({ enrolled: true, sub: { state, source: null }, conn: connection, locked: false, unlockAt: 'connected', legacyPolicy: 'block', ...extra });

describe('evaluate: not enrolled', () => {
  test('always allowed (legacy workspaces are never gated)', () => {
    expect(gate.evaluate({ enrolled: false })).toEqual({ allowed: true });
    expect(gate.evaluate(null)).toEqual({ allowed: true });
    expect(gate.evaluate(undefined, 'block')).toEqual({ allowed: true });
    expect(gate.evaluate({ enrolled: false }, { kind: 'send', policy: 'block' })).toEqual({ allowed: true });
  });
});

describe('evaluate: DB 4.4 table', () => {
  const table = [
    ['none', null, 'block', 'SUBSCRIPTION_REQUIRED'],
    ['pending', null, 'block', 'PAYMENT_PENDING'],
    ['past_due', conn('connected'), 'platform_number', 'PAYMENT_PAST_DUE'],
    ['cancelled', conn('connected'), 'platform_number', 'SUBSCRIPTION_CANCELLED'],
    ['active', null, 'block', 'WHATSAPP_NOT_CONNECTED'],
    ['active', conn('not_connected'), 'platform_number', 'WHATSAPP_NOT_CONNECTED'],
    ['active', conn('connecting'), 'platform_number', 'WHATSAPP_NOT_CONNECTED'],
    ['active', conn('waba_only'), 'platform_number', 'WHATSAPP_NOT_CONNECTED'],
    ['active', conn('disconnected'), 'platform_number', 'WHATSAPP_NOT_CONNECTED'],
    ['active', conn('error'), 'platform_number', 'WHATSAPP_NOT_CONNECTED'],
    ['active', conn('some_future_status'), 'platform_number', 'WHATSAPP_NOT_CONNECTED'],
    ['active', conn('reconnect_required'), 'platform_number', 'WHATSAPP_RECONNECT_REQUIRED'],
    ['active', conn('connected', true), 'platform_number', 'WHATSAPP_RECONNECT_REQUIRED'],
    ['active', conn('needs_attention', true), 'platform_number', 'WHATSAPP_RECONNECT_REQUIRED'],
    ['active', conn('connected'), 'block', 'SENDING_NOT_AVAILABLE_YET'],
    ['active', conn('needs_attention'), 'block', 'SENDING_NOT_AVAILABLE_YET'],
  ];
  test.each(table)('sub %s, conn %j, policy %s -> %s', (state, connection, policy, code) => {
    const r = gate.evaluate(enrolled(state, connection), { policy });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe(code);
    expect(r.status).toBe(402);
    expect(r.retry).toEqual(expect.objectContaining({ checkout: expect.any(Boolean), billingPortal: expect.any(Boolean), reconnect: expect.any(Boolean) }));
  });
  test('connected (and needs_attention) + platform_number -> allowed', () => {
    expect(gate.evaluate(enrolled('active', conn('connected')), { policy: 'platform_number' })).toEqual({ allowed: true });
    expect(gate.evaluate(enrolled('active', conn('needs_attention')), 'platform_number')).toEqual({ allowed: true });
  });
  test('the policy defaults to gateState.legacyPolicy, then to the env/default (block)', () => {
    expect(gate.evaluate(enrolled('active', conn('connected'), { legacyPolicy: 'platform_number' })).allowed).toBe(true);
    expect(gate.evaluate(enrolled('active', conn('connected'), { legacyPolicy: undefined })).code).toBe('SENDING_NOT_AVAILABLE_YET');
  });
  test('needs_attention never blocks by itself (Meta enforces its own limits)', () => {
    expect(gate.evaluate(enrolled('active', conn('needs_attention')), 'platform_number').allowed).toBe(true);
  });
  test('retry flags and nextStep per code', () => {
    const get = (state, connection, policy = 'block') => gate.evaluate(enrolled(state, connection), { policy });
    expect(get('none', null).retry).toEqual({ checkout: true, billingPortal: false, reconnect: false });
    expect(get('none', null).nextStep).toBe('billing');
    expect(get('pending', null).retry).toEqual({ checkout: false, billingPortal: false, reconnect: false });
    expect(get('past_due', null).retry).toEqual({ checkout: false, billingPortal: true, reconnect: false });
    expect(get('cancelled', null).retry).toEqual({ checkout: true, billingPortal: true, reconnect: false });
    expect(get('active', conn('reconnect_required')).retry).toEqual({ checkout: false, billingPortal: false, reconnect: true });
    expect(get('active', conn('reconnect_required')).nextStep).toBe('connect');
    expect(get('active', conn('connected')).nextStep).toBeNull();
  });
  test('an unknown subscription value on an enrolled workspace is denied', () => {
    expect(gate.evaluate(enrolled('weird', conn('connected')), 'platform_number').code).toBe('SUBSCRIPTION_REQUIRED');
    expect(gate.evaluate({ enrolled: true, sub: undefined, conn: null }).code).toBe('SUBSCRIPTION_REQUIRED');
  });
});

describe('kind: connect (Instagram connect/publish routes)', () => {
  test('checks the subscription only', () => {
    expect(gate.evaluate(enrolled('active', null), { kind: 'connect' })).toEqual({ allowed: true });
    expect(gate.evaluate(enrolled('active', conn('connected')), { kind: 'connect', policy: 'block' })).toEqual({ allowed: true });
    expect(gate.evaluate(enrolled('none', null), { kind: 'connect' }).code).toBe('SUBSCRIPTION_REQUIRED');
    expect(gate.evaluate(enrolled('past_due', conn('connected')), { kind: 'connect' }).code).toBe('PAYMENT_PAST_DUE');
  });
});

describe('helpers', () => {
  test('subscriptionDenial', () => {
    expect(gate.subscriptionDenial('active')).toBeNull();
    expect(gate.subscriptionDenial('none').code).toBe('SUBSCRIPTION_REQUIRED');
    expect(gate.subscriptionDenial('pending').code).toBe('PAYMENT_PENDING');
    expect(gate.subscriptionDenial('past_due').code).toBe('PAYMENT_PAST_DUE');
    expect(gate.subscriptionDenial('cancelled').code).toBe('SUBSCRIPTION_CANCELLED');
    expect(gate.SUBSCRIPTION_CODES).toEqual({ none: 'SUBSCRIPTION_REQUIRED', pending: 'PAYMENT_PENDING', past_due: 'PAYMENT_PAST_DUE', cancelled: 'SUBSCRIPTION_CANCELLED' });
  });
  test('connectionDenial / isConnectedLike', () => {
    expect(gate.connectionDenial(null)).toBe('WHATSAPP_NOT_CONNECTED');
    expect(gate.connectionDenial(conn('connected'))).toBeNull();
    expect(gate.connectionDenial(conn('connected', true))).toBe('WHATSAPP_RECONNECT_REQUIRED');
    expect(gate.isConnectedLike(conn('needs_attention'))).toBe(true);
    expect(gate.isConnectedLike(conn('needs_attention', true))).toBe(false);
    expect(gate.isConnectedLike(null)).toBe(false);
  });
  test('evaluate is pure: it does not mutate its input', () => {
    const gs = enrolled('active', conn('connected'));
    const copy = JSON.stringify(gs);
    gate.evaluate(gs, 'block');
    expect(JSON.stringify(gs)).toBe(copy);
  });
});
