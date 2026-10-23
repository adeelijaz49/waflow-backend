'use strict';
const analytics = require('../../../shared/onboarding/analytics');
const { createFakeModel } = require('./_b0Store');

const WS = '507f1f77bcf86cd799439011';

function setup(opts = {}) {
  const model = createFakeModel();
  let t = Date.UTC(2026, 9, 15, 10, 30, 0);
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const a = analytics.createAnalytics({ model, now: clock.now, ...opts });
  return { model, a, clock };
}

describe('sanitizeEvent', () => {
  const { sanitizeEvent } = analytics;
  test('unknown or missing type -> null (not written)', () => {
    expect(sanitizeEvent(null)).toBeNull();
    expect(sanitizeEvent({})).toBeNull();
    expect(sanitizeEvent({ type: 'login' })).toBeNull();
    expect(sanitizeEvent('step_enter')).toBeNull();
  });
  test('keeps whitelisted fields', () => {
    expect(sanitizeEvent({ type: 'step_fail', step: 'connect', code: 'ONB_SDK_BLOCKED', reason: 'popup_blocked', durationMs: 1234.4, meta: { path: 'A', attempt: 2, tier: 'TIER_1K' } }))
      .toEqual({ type: 'step_fail', step: 'connect', code: 'ONB_SDK_BLOCKED', reason: 'popup_blocked', durationMs: 1234, meta: { path: 'A', attempt: 2, tier: 'TIER_1K' } });
  });
  test('drops unknown step, bad codes, free-text reasons, bad durations', () => {
    const out = sanitizeEvent({ type: 'step_complete', step: 'checkout', code: 'lowercase', reason: 'Free Text With Caps and a phone 0501234567', durationMs: -5 });
    expect(out).toEqual({ type: 'step_complete' });
    expect(sanitizeEvent({ type: 'step_complete', durationMs: 86400001 })).toEqual({ type: 'step_complete' });
    expect(sanitizeEvent({ type: 'step_complete', reason: 'x'.repeat(81) })).toEqual({ type: 'step_complete' });
    expect(sanitizeEvent({ type: 'step_complete', code: 'A' })).toEqual({ type: 'step_complete' });
  });
  test('meta: only the whitelist, strings <= 40, never e-mails or phone-like values', () => {
    const out = sanitizeEvent({
      type: 'connect_result',
      meta: {
        path: 'B', usage: 'x'.repeat(41), tier: 'TIER_50', templateKey: 'welcome_optin', language: 'ar', attempt: 3,
        email: 'a@b.com', phone: '966501234567', name: 'Alice', token: 'EAAG',
      },
    });
    expect(out.meta).toEqual({ path: 'B', tier: 'TIER_50', templateKey: 'welcome_optin', language: 'ar', attempt: 3 });
    expect(sanitizeEvent({ type: 'admin', meta: { path: 'a@b.com', usage: '0501234567', tier: '9665012345678' } }).meta).toBeUndefined();
    expect(sanitizeEvent({ type: 'admin', meta: ['x'] }).meta).toBeUndefined();
  });
  test('no PII ever survives', () => {
    const out = JSON.stringify(sanitizeEvent({
      type: 'help_opened', step: 'number', reason: 'help',
      meta: { phone: '+966501234567', email: 'x@y.com', code: 'AQBabc', pin: '123456', name: 'Bob' },
      phone: '+966501234567', email: 'x@y.com', token: 'EAAGsecret', name: 'Bob', message: 'hello',
    }));
    for (const bad of ['966', 'x@y.com', 'EAAG', 'Bob', 'hello', 'AQB', '123456']) expect(out).not.toContain(bad);
  });
  test('constants', () => {
    expect(analytics.EVENT_TYPES).toHaveLength(14);
    expect(analytics.UI_FAIL_CODES).toEqual(['ONB_SDK_BLOCKED', 'ONB_SDK_TIMEOUT', 'ONB_POPUP_BLOCKED', 'ONB_IN_APP_BROWSER', 'ONB_NETWORK', 'ONB_CODE_HANDOFF_SLOW']);
    expect(analytics.CAPS).toEqual({ PER_WORKSPACE: 400, FAIL_TOTAL: 600, DROPPED_PER_WORKSPACE: 400 });
  });
});

describe('track', () => {
  test('writes a sanitized row with a timestamp', async () => {
    const { a, model } = setup();
    await a.track(WS, { type: 'status_change', step: 'approvals', code: 'VERIFICATION_DONE', meta: { tier: 'TIER_250' }, email: 'leak@x.com' });
    expect(model.rows).toHaveLength(1);
    const row = model.rows[0];
    expect(row.workspaceId).toBe(WS);
    expect(row.type).toBe('status_change');
    expect(row.email).toBeUndefined();
    expect(row.at).toBeInstanceOf(Date);
  });
  test('invalid input is silently dropped (never throws)', async () => {
    const { a, model } = setup();
    await a.track('not-an-id', { type: 'step_enter' });
    await a.track(WS, { type: 'bogus' });
    await a.track(undefined, undefined);
    expect(model.rows).toHaveLength(0);
  });
  test('never throws or rejects when the database fails', async () => {
    const { a, model } = setup();
    model.failWith = new Error('db down');
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(a.track(WS, { type: 'admin', reason: 'x' })).resolves.toBeUndefined();
    spy.mockRestore();
  });
  test('step_enter is coalesced: one per step per UTC hour', async () => {
    const { a, model, clock } = setup();
    await a.track(WS, { type: 'step_enter', step: 'business' });
    await a.track(WS, { type: 'step_enter', step: 'business' });
    await a.track(WS, { type: 'step_enter', step: 'number' });
    expect(model.rows.filter((r) => r.type === 'step_enter')).toHaveLength(2);
    clock.advance(60 * 60 * 1000);
    await a.track(WS, { type: 'step_enter', step: 'business' });
    expect(model.rows.filter((r) => r.type === 'step_enter')).toHaveLength(3);
  });
  test('step_enter coalescing also holds across instances (DB check)', async () => {
    const { a, model, clock } = setup();
    await a.track(WS, { type: 'step_enter', step: 'business' });
    const b = analytics.createAnalytics({ model, now: clock.now });
    await b.track(WS, { type: 'step_enter', step: 'business' });
    expect(model.rows.filter((r) => r.type === 'step_enter')).toHaveLength(1);
  });
  test('write caps: 400 rows, then only step_fail/send_blocked up to 600, then nothing', async () => {
    const { a, model } = setup();
    for (let i = 0; i < 400; i += 1) model.seed({ workspaceId: WS, type: 'notification', at: new Date() });
    await a.track(WS, { type: 'notification', reason: 'late' });
    await a.track(WS, { type: 'step_complete', step: 'business' });
    expect(model.rows).toHaveLength(400);
    await a.track(WS, { type: 'step_fail', step: 'connect', code: 'CONNECT_PARTIAL' });
    await a.track(WS, { type: 'send_blocked', code: 'PAYMENT_PAST_DUE' });
    expect(model.rows).toHaveLength(402);
    for (let i = 0; i < 198; i += 1) model.seed({ workspaceId: WS, type: 'step_fail' });
    a._resetMemo();
    await a.track(WS, { type: 'step_fail', step: 'connect', code: 'CONNECT_PARTIAL' });
    await a.track(WS, { type: 'send_blocked', code: 'PAYMENT_PAST_DUE' });
    expect(model.rows).toHaveLength(600);
  });
  test('R7-09: past the 400 budget the priority types keep writing (step_fail, send_blocked, status_change, payment_state, connect_result) until 600; the rest stops', async () => {
    const { a, model } = setup();
    expect(analytics.CAPS).toMatchObject({ PER_WORKSPACE: 400, FAIL_TOTAL: 600 });
    for (let i = 0; i < 400; i += 1) model.seed({ workspaceId: WS, type: 'notification', at: new Date() });
    await a.track(WS, { type: 'notification', reason: 'late' });
    await a.track(WS, { type: 'help_opened', step: 'number' });
    await a.track(WS, { type: 'template_status', code: 'TEMPLATE_APPROVED' });
    expect(model.rows).toHaveLength(400);
    await a.track(WS, { type: 'status_change', step: 'connect', code: 'RECONNECT_TOKEN_REVOKED' });
    await a.track(WS, { type: 'payment_state', step: 'billing', code: 'SUB_ACTIVE' });
    await a.track(WS, { type: 'connect_result', step: 'connect', reason: 'connected' });
    await a.track(WS, { type: 'step_fail', step: 'connect', code: 'CONNECT_PARTIAL' });
    await a.track(WS, { type: 'send_blocked', code: 'PAYMENT_PAST_DUE' });
    expect(model.rows.slice(400).map((r) => r.type)).toEqual(['status_change', 'payment_state', 'connect_result', 'step_fail', 'send_blocked']);
    for (let i = 0; i < 195; i += 1) model.seed({ workspaceId: WS, type: 'notification' });
    a._resetMemo();
    await a.track(WS, { type: 'status_change', step: 'connect', code: 'LEVEL_CONNECTED' }); // 600 reached: nothing at all
    expect(model.rows).toHaveLength(600);
  });
  test('R7-09: webhook_dropped rows are NOT part of the budget (400 of them do not stop a status_change)', async () => {
    const { a, model } = setup();
    for (let i = 0; i < 400; i += 1) model.seed({ workspaceId: WS, type: 'webhook_dropped', code: 'WEBHOOK_MESSAGES_DROPPED', at: new Date(0) });
    for (let i = 0; i < 399; i += 1) model.seed({ workspaceId: WS, type: 'step_complete', step: 'business', at: new Date() });
    await a.track(WS, { type: 'notification', reason: 'the_400th_budget_row' });
    expect(model.rows).toHaveLength(800); // written: the 400 dropped rows were not counted (counted, they would have stopped it)
    await a.track(WS, { type: 'notification', reason: 'over_budget' });
    expect(model.rows).toHaveLength(800); // now the budget really is used up
    await a.track(WS, { type: 'status_change', step: 'connect', code: 'RECONNECT_TOKEN_REVOKED' });
    expect(model.rows).toHaveLength(801); // and a status change is still recorded
  });
  test('R7-09: webhook_dropped is one row per workspace, code and UTC day (also across instances), outside the budget, with its own cap of 400', async () => {
    const { a, model, clock } = setup();
    const drop = { type: 'webhook_dropped', code: 'WEBHOOK_MESSAGES_DROPPED', reason: 'merchant_inbox_not_enabled', meta: { attempt: 5 } };
    await a.track(WS, drop);
    await a.track(WS, drop);
    await a.track(WS, { ...drop, code: 'WEBHOOK_DISCONNECTED_DROPPED', reason: 'disconnected_waba' });
    expect(model.rows.map((r) => r.code)).toEqual(['WEBHOOK_MESSAGES_DROPPED', 'WEBHOOK_DISCONNECTED_DROPPED']);
    const other = analytics.createAnalytics({ model, now: clock.now });
    await other.track(WS, drop); // another instance / a restart: the database says it was written today
    expect(model.rows).toHaveLength(2);
    clock.advance(24 * 60 * 60 * 1000); // the next UTC day
    await a.track(WS, drop);
    expect(model.rows.filter((r) => r.code === 'WEBHOOK_MESSAGES_DROPPED')).toHaveLength(2);
    for (let i = 0; i < 400; i += 1) model.seed({ workspaceId: WS, type: 'webhook_dropped', code: 'WEBHOOK_MESSAGES_DROPPED', at: new Date(0) });
    clock.advance(24 * 60 * 60 * 1000);
    const before = model.rows.length;
    await a.track(WS, drop);
    expect(model.rows).toHaveLength(before); // its own hard cap: the collection cannot grow without bound
  });
  test('the cap is per workspace', async () => {
    const { a, model } = setup();
    for (let i = 0; i < 400; i += 1) model.seed({ workspaceId: WS, type: 'notification' });
    const other = '507f1f77bcf86cd799439099';
    await a.track(other, { type: 'step_complete', step: 'business' });
    expect(model.rows.filter((r) => String(r.workspaceId) === other)).toHaveLength(1);
  });
  test('the count is memoised for a minute (one countDocuments per minute)', async () => {
    const { a, model, clock } = setup();
    await a.track(WS, { type: 'notification' });
    await a.track(WS, { type: 'notification' });
    await a.track(WS, { type: 'notification' });
    expect(model.calls.filter((c) => c[0] === 'countDocuments')).toHaveLength(1);
    clock.advance(61000);
    await a.track(WS, { type: 'notification' });
    expect(model.calls.filter((c) => c[0] === 'countDocuments')).toHaveLength(2);
  });
  test('module-level track() with injected deps and exported helpers exist', async () => {
    const model = createFakeModel();
    await analytics.track(WS, { type: 'admin', reason: 'enrolled_admin' }, { model });
    expect(model.rows).toHaveLength(1);
    expect(typeof analytics._resetMemo).toBe('function');
  });
});
