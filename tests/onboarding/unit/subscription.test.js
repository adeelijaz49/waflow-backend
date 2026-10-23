'use strict';
const sub = require('../../../shared/onboarding/subscription');

describe('mapRawStatus (DB 4.2)', () => {
  const T = [
    ['active', 'active'], ['incomplete', 'pending'], ['incomplete_expired', 'none'],
    ['past_due', 'past_due'], ['unpaid', 'past_due'], ['paused', 'past_due'], ['canceled', 'cancelled'],
  ];
  test.each(T)('%s -> %s', (raw, state) => { expect(sub.mapRawStatus(raw).state).toBe(state); });
  test('trialing is pending (TRIAL_NOT_RECOGNISED) by default', () => {
    expect(sub.mapRawStatus('trialing')).toEqual({ state: 'pending', reason: 'TRIAL_NOT_RECOGNISED' });
    expect(sub.mapRawStatus('trialing', { acceptTrialing: true })).toEqual({ state: 'pending', reason: 'TRIAL_NOT_RECOGNISED' }); // no card on file
    expect(sub.mapRawStatus('trialing', { hasDefaultPaymentMethod: true })).toEqual({ state: 'pending', reason: 'TRIAL_NOT_RECOGNISED' }); // flag off
  });
  test('trialing is active ONLY with the flag AND a default payment method (D2)', () => {
    expect(sub.mapRawStatus('trialing', { acceptTrialing: true, hasDefaultPaymentMethod: true }).state).toBe('active');
  });
  test('unknown / missing status -> null state (never guess)', () => {
    for (const raw of ['frozen', '', undefined, null, 'ACTIVE_X']) expect(sub.mapRawStatus(raw).state).toBeNull();
  });
  test('case-insensitive on the raw status', () => {
    expect(sub.mapRawStatus('ACTIVE').state).toBe('active');
  });
});

describe('effectiveState (DB 4.3 matrix: admin x stripe)', () => {
  const stripeStatuses = [undefined, 'active', 'trialing', 'incomplete', 'incomplete_expired', 'past_due', 'unpaid', 'paused', 'canceled'];
  const expectedStripeState = { undefined: 'none', active: 'active', trialing: 'pending', incomplete: 'pending', incomplete_expired: 'none', past_due: 'past_due', unpaid: 'past_due', paused: 'past_due', canceled: 'cancelled' };
  const cases = [];
  for (const st of stripeStatuses) for (const adminActive of [false, true]) cases.push([st, adminActive]);

  test.each(cases)('stripe %s, admin.active %s', (status, adminActive) => {
    const out = sub.effectiveState({ stripe: status ? { status, subscriptionId: 'sub_1' } : {}, admin: { active: adminActive } }, { acceptTrialing: false });
    const stripeState = expectedStripeState[status];
    if (stripeState === 'active') expect(out).toEqual({ state: 'active', source: 'stripe' });
    else if (adminActive) expect(out).toEqual({ state: 'active', source: 'admin' });
    else expect(out.state).toBe(stripeState);
    if (!adminActive && stripeState !== 'active') expect(out.source).toBeNull();
  });

  test('admin activation is never downgraded by Stripe past_due / cancelled', () => {
    for (const status of ['past_due', 'canceled', 'unpaid']) {
      expect(sub.effectiveState({ stripe: { status }, admin: { active: true } })).toEqual({ state: 'active', source: 'admin' });
    }
  });
  test('Stripe active wins as the source when both are active', () => {
    expect(sub.effectiveState({ stripe: { status: 'active' }, admin: { active: true } }).source).toBe('stripe');
  });
  test('no subscription data -> none', () => {
    expect(sub.effectiveState(undefined)).toEqual({ state: 'none', source: null });
    expect(sub.effectiveState({})).toEqual({ state: 'none', source: null });
  });
  test('a started checkout with no Stripe subscription yet is pending', () => {
    expect(sub.effectiveState({ stripe: { checkoutStartedAt: new Date() } }).state).toBe('pending');
    expect(sub.effectiveState({ stripe: { checkoutStartedAt: new Date(), subscriptionId: 'sub_1', status: 'incomplete_expired' } }).state).toBe('none');
  });
  test('trialing + accept flag + card -> active/stripe; flag from env when not passed', () => {
    const s = { stripe: { status: 'trialing', hasDefaultPaymentMethod: true } };
    expect(sub.effectiveState(s, { acceptTrialing: true })).toMatchObject({ state: 'active', source: 'stripe' });
    expect(sub.effectiveState(s, { acceptTrialing: false }).state).toBe('pending');
    delete process.env.ONBOARDING_ACCEPT_TRIALING;
    expect(sub.effectiveState(s).state).toBe('pending');
  });
  test('an unknown raw Stripe status keeps the stored non-active state, never grants access', () => {
    expect(sub.effectiveState({ state: 'past_due', source: null, stripe: { status: 'brand_new_status' } }).state).toBe('past_due');
    expect(sub.effectiveState({ state: 'active', source: 'admin', stripe: { status: 'brand_new_status' } }).state).toBe('none');
    expect(sub.effectiveState({ state: 'active', source: 'stripe', stripe: { status: 'brand_new_status' } }).state).toBe('none');
  });
});

describe('transitionPatch', () => {
  const now = new Date('2026-10-15T10:00:00Z');
  test('no change -> nothing to write (idempotent)', () => {
    expect(sub.transitionPatch({ state: 'active', source: 'stripe' }, { state: 'active', source: 'stripe' }, now)).toEqual({ changed: false, set: {} });
    expect(sub.transitionPatch({ state: 'none' }, { state: 'none', source: null }, now).changed).toBe(false);
    expect(sub.transitionPatch(undefined, { state: 'none', source: null }, now).changed).toBe(false);
  });
  test('-> active sets activatedAt', () => {
    expect(sub.transitionPatch({ state: 'pending', source: null }, { state: 'active', source: 'stripe' }, now)).toEqual({
      changed: true,
      set: { 'subscription.state': 'active', 'subscription.source': 'stripe', 'subscription.changedAt': now, 'subscription.activatedAt': now },
    });
  });
  test('-> past_due / cancelled set their own timestamps', () => {
    expect(sub.transitionPatch({ state: 'active', source: 'stripe' }, { state: 'past_due', source: null }, now).set['subscription.pastDueAt']).toBe(now);
    expect(sub.transitionPatch({ state: 'past_due', source: null }, { state: 'cancelled', source: null }, now).set['subscription.cancelledAt']).toBe(now);
  });
  test('a source change inside active does not re-stamp activatedAt', () => {
    const out = sub.transitionPatch({ state: 'active', source: 'admin' }, { state: 'active', source: 'stripe' }, now);
    expect(out.changed).toBe(true);
    expect(out.set['subscription.activatedAt']).toBeUndefined();
    expect(out.set['subscription.source']).toBe('stripe');
  });
  test('active -> none by admin deactivation clears the source', () => {
    const out = sub.transitionPatch({ state: 'active', source: 'admin' }, { state: 'none', source: null }, now);
    expect(out.set['subscription.state']).toBe('none');
    expect(out.set['subscription.source']).toBeNull();
  });
});
