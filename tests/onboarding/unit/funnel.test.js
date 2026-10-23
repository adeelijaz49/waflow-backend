'use strict';
const analytics = require('../../../shared/onboarding/analytics');
const { createFakeModel } = require('./_b0Store');

const NOW = Date.parse('2026-10-15T12:00:00Z');
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const iso = (offsetMs) => new Date(NOW + offsetMs);
let n = 0;
const id = () => `507f1f77bcf86cd7994391${String(10 + (n += 1)).padStart(2, '0')}`;

const step = (status, startAgoMin, durMin) => {
  const s = { status };
  if (startAgoMin !== undefined) s.enteredAt = iso(-startAgoMin * MIN);
  if (durMin !== undefined) s.completedAt = iso(-(startAgoMin - durMin) * MIN);
  return s;
};

function seed() {
  const ids = { A: id(), B: id(), C: id(), D: id(), E: id(), F: id(), G: id() };
  const State = createFakeModel();
  const Conn = createFakeModel();
  State.seed({ workspaceId: ids.A, enrolled: true, subscription: { state: 'active' }, progress: { currentStep: 4, status: 'in_progress', lastActivityAt: iso(-2 * 60 * MIN) },
    steps: { business: step('done', 300, 15), number: step('done', 280, 10), connect: step('done', 200, 30), approvals: step('in_progress', 100), promotion: { status: 'todo' } } });
  State.seed({ workspaceId: ids.B, enrolled: true, subscription: { state: 'active' }, progress: { currentStep: 3, status: 'in_progress', lastActivityAt: iso(-10 * DAY) },
    steps: { business: step('done', 20000, 60), number: { status: 'skipped', enteredAt: iso(-19000 * MIN) }, connect: step('in_progress', 18000), approvals: { status: 'todo' }, promotion: { status: 'todo' } } });
  State.seed({ workspaceId: ids.C, enrolled: true, subscription: { state: 'pending' }, progress: { currentStep: 1, status: 'in_progress', lastActivityAt: iso(-8 * DAY) },
    steps: { business: step('in_progress', 12000), number: { status: 'todo' }, connect: { status: 'todo' }, approvals: { status: 'todo' }, promotion: { status: 'todo' } } });
  State.seed({ workspaceId: ids.D, enrolled: true, subscription: { state: 'past_due' }, progress: { currentStep: 5, status: 'completed', completedAt: iso(-30 * DAY), lastActivityAt: iso(-30 * DAY) },
    steps: { business: step('done', 60000, 30), number: step('done', 59000, 20), connect: step('done', 58000, 90), approvals: step('done', 57000, 5), promotion: step('done', 56000, 1) } });
  State.seed({ workspaceId: ids.E, enrolled: true, subscription: { state: 'cancelled' }, progress: { currentStep: 1, status: 'in_progress', lastActivityAt: iso(-1 * DAY) },
    steps: { business: { status: 'todo' } } });
  State.seed({ workspaceId: ids.F, enrolled: false, subscription: { state: 'active' }, progress: { currentStep: 1, lastActivityAt: iso(-30 * DAY) }, steps: { business: step('done', 100, 5) } });
  State.seed({ workspaceId: ids.G, enrolled: true, progress: { currentStep: 2, status: 'paused_number', lastActivityAt: iso(-6 * DAY - 23 * 60 * MIN) }, steps: {} });
  Conn.seed({ workspaceId: ids.A, status: 'connected' });
  Conn.seed({ workspaceId: ids.B, status: 'needs_attention' });
  Conn.seed({ workspaceId: ids.D, status: 'connected', needsReconnect: true });
  Conn.seed({ workspaceId: ids.E, status: 'reconnect_required' });
  Conn.seed({ workspaceId: ids.F, status: 'connected' }); // un-enrolled: must not be counted
  const calls = [];
  const OnboardingEvent = { aggregate: async (pipeline) => { calls.push(pipeline); return [
    { _id: 'CONNECT_PARTIAL', count: 4 }, { _id: 'ONB_SDK_BLOCKED', count: 9 }, { _id: 'CONNECT_CANCELLED', count: 4 }, { _id: null, count: 50 },
  ]; } };
  const connectionLevel = (c) => (!c ? 'not_connected' : c.needsReconnect || c.status === 'reconnect_required' ? 'reconnect_needed' : c.status === 'connected' ? 'connected' : 'needs_attention');
  return { ids, deps: { OnboardingState: State, WhatsAppConnection: Conn, OnboardingEvent, now: () => NOW, connectionLevel }, calls };
}

describe('funnel numbers on seeded data', () => {
  let f; let ctx;
  beforeAll(async () => { ctx = seed(); f = await analytics.funnel(ctx.deps); });

  test('totals count enrolled workspaces only', () => {
    expect(f.enrolled).toBe(6); // F is un-enrolled
    expect(f.completed).toBe(1);
    expect(f.generatedAt).toBe(new Date(NOW).toISOString());
    expect(f.truncated).toBe(false);
    expect(f.warnings).toEqual([]);
  });
  test('per step: entered / completed / skipped', () => {
    expect(f.steps.business).toMatchObject({ entered: 4, completed: 3, skipped: 0 }); // A B C D entered, C only in progress; E todo
    expect(f.steps.number).toMatchObject({ entered: 3, completed: 2, skipped: 1 });    // A D done, B skipped
    expect(f.steps.connect).toMatchObject({ entered: 3, completed: 2, skipped: 0 });   // A D done, B in progress
    expect(f.steps.approvals).toMatchObject({ entered: 2, completed: 1, skipped: 0 }); // A in progress, D done
    expect(f.steps.promotion).toMatchObject({ entered: 1, completed: 1, skipped: 0 });
    expect(Object.keys(f.steps)).toEqual(['business', 'number', 'connect', 'approvals', 'promotion']);
  });
  test('median minutes between enteredAt and completedAt of the completed steps', () => {
    expect(f.steps.business.medianMinutes).toBe(30);  // 15, 60, 30
    expect(f.steps.number.medianMinutes).toBe(15);    // 10, 20
    expect(f.steps.connect.medianMinutes).toBe(60);   // 30, 90
    expect(f.steps.approvals.medianMinutes).toBe(5);
    expect(f.steps.promotion.medianMinutes).toBe(1);
  });
  test('drop-off: stuck on currentStep with lastActivityAt older than 7 days (finished and recent workspaces excluded)', () => {
    expect(f.steps.business.dropOff).toBe(1);   // C (8 days)
    expect(f.steps.connect.dropOff).toBe(1);    // B (10 days)
    expect(f.steps.number.dropOff).toBe(0);     // G is paused 6d23h: not yet
    expect(f.steps.approvals.dropOff).toBe(0);  // A is active
    expect(f.steps.promotion.dropOff).toBe(0);  // D finished long ago: not a drop-off
  });
  test('subscription state counts (a missing state is "none")', () => {
    expect(f.subscription).toEqual({ none: 1, pending: 1, active: 2, past_due: 1, cancelled: 1 });
  });
  test('connection level counts (an enrolled workspace without a row is not_connected; un-enrolled rows ignored)', () => {
    expect(f.connection).toEqual({ connected: 1, needs_attention: 1, reconnect_needed: 2, not_connected: 2 });
  });
  test('top failure codes: simple $match + $group only, ordered in memory, ties alphabetical, null codes dropped', () => {
    expect(f.failureCodes).toEqual([{ code: 'ONB_SDK_BLOCKED', count: 9 }, { code: 'CONNECT_CANCELLED', count: 4 }, { code: 'CONNECT_PARTIAL', count: 4 }]);
    const pipeline = ctx.calls[0];
    expect(pipeline.map((s) => Object.keys(s)[0])).toEqual(['$match', '$group']);
    expect(pipeline[0].$match.type.$in.sort()).toEqual(['connect_result', 'step_fail']);
  });
});

describe('edge cases', () => {
  test('drop-off boundary: exactly 7 days is not a drop-off, 7 days and 1 ms is', async () => {
    const State = createFakeModel();
    State.seed({ workspaceId: id(), enrolled: true, progress: { currentStep: 2, lastActivityAt: new Date(NOW - 7 * DAY) }, steps: {} });
    State.seed({ workspaceId: id(), enrolled: true, progress: { currentStep: 2, lastActivityAt: new Date(NOW - 7 * DAY - 1) }, steps: {} });
    const f = await analytics.funnel({ OnboardingState: State, WhatsAppConnection: createFakeModel(), OnboardingEvent: { aggregate: async () => [] }, now: () => NOW, connectionLevel: () => 'not_connected' });
    expect(f.steps.number.dropOff).toBe(1);
  });
  test('(i) the TEST_MESSAGE_* bookkeeping rows of testMessage.js (type notification) are never funnel data, whatever the query returns', async () => {
    const rows = [{ _id: 'TEST_MESSAGE_SENT', count: 50 }, { _id: 'TEST_MESSAGE_FAILED', count: 7 }, { _id: 'TEST_MESSAGE_VOID', count: 3 }, { _id: 'CONNECT_PARTIAL', count: 2 }];
    const f = await analytics.funnel({ OnboardingState: createFakeModel(), WhatsAppConnection: createFakeModel(), OnboardingEvent: { aggregate: async () => rows }, now: () => NOW });
    expect(f.failureCodes).toEqual([{ code: 'CONNECT_PARTIAL', count: 2 }]);
  });
  test('no data at all: zeros and nulls, no failure', async () => {
    const f = await analytics.funnel({ OnboardingState: createFakeModel(), WhatsAppConnection: createFakeModel(), OnboardingEvent: { aggregate: async () => [] }, now: () => NOW });
    expect(f.enrolled).toBe(0);
    expect(f.steps.business).toEqual({ entered: 0, completed: 0, skipped: 0, medianMinutes: null, dropOff: 0 });
    expect(f.failureCodes).toEqual([]);
    expect(f.subscription).toEqual({ none: 0, pending: 0, active: 0, past_due: 0, cancelled: 0 });
    expect(f.connection).toEqual({ connected: 0, needs_attention: 0, reconnect_needed: 0, not_connected: 0 });
  });
  test('top failure codes are limited to 10', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ _id: `CODE_${String(i).padStart(2, '0')}`, count: i + 1 }));
    const f = await analytics.funnel({ OnboardingState: createFakeModel(), WhatsAppConnection: createFakeModel(), OnboardingEvent: { aggregate: async () => rows }, now: () => NOW });
    expect(f.failureCodes).toHaveLength(10);
    expect(f.failureCodes[0]).toEqual({ code: 'CODE_14', count: 15 });
  });
  test('a failing aggregation or connection read degrades that panel only and says so', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const State = createFakeModel();
    State.seed({ workspaceId: id(), enrolled: true, subscription: { state: 'active' }, progress: { currentStep: 1, lastActivityAt: new Date(NOW) }, steps: {} });
    const Conn = createFakeModel({ failWith: new Error('conn down') });
    const f = await analytics.funnel({ OnboardingState: State, WhatsAppConnection: Conn, OnboardingEvent: { aggregate: async () => { throw new Error('agg down'); } }, now: () => NOW });
    expect(f.enrolled).toBe(1);
    expect(f.subscription.active).toBe(1);
    expect(f.failureCodes).toEqual([]);
    expect(f.warnings.sort()).toEqual(['connection_levels_unavailable', 'failure_codes_unavailable']);
    warn.mockRestore();
  });
  test('the state read itself failing propagates to the admin caller', async () => {
    await expect(analytics.funnel({ OnboardingState: createFakeModel({ failWith: new Error('db down') }) })).rejects.toThrow('db down');
  });
  test('truncates at 5000 workspaces and flags it', async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({ workspaceId: String(i).padStart(24, '0'), subscription: { state: 'active' }, progress: { currentStep: 1 }, steps: {} }));
    const State = { find: () => ({ select: () => ({ limit: () => ({ lean: async () => rows }) }) }) };
    const f = await analytics.funnel({ OnboardingState: State, WhatsAppConnection: createFakeModel(), OnboardingEvent: { aggregate: async () => [] }, now: () => NOW });
    expect(f.enrolled).toBe(5000);
    expect(f.truncated).toBe(true);
    expect(f.warnings).toContain('truncated_at_5000_workspaces');
  });
  test('without an injected level function the local mapping is used when statusRefresh is unavailable', async () => {
    let fresh;
    jest.isolateModules(() => {
      jest.doMock('../../../shared/onboarding/statusRefresh', () => ({ connectionLevel: () => { throw new Error('NOT_IMPLEMENTED'); } }));
      fresh = require('../../../shared/onboarding/analytics');
    });
    const State = createFakeModel();
    const Conn = createFakeModel();
    const a = id(); const b = id();
    State.seed({ workspaceId: a, enrolled: true, progress: { currentStep: 1 }, steps: {} });
    State.seed({ workspaceId: b, enrolled: true, progress: { currentStep: 1 }, steps: {} });
    Conn.seed({ workspaceId: a, status: 'connected' });
    const f = await fresh.funnel({ OnboardingState: State, WhatsAppConnection: Conn, OnboardingEvent: { aggregate: async () => [] }, now: () => NOW });
    expect(f.connection).toEqual({ connected: 1, needs_attention: 0, reconnect_needed: 0, not_connected: 1 });
    jest.dontMock('../../../shared/onboarding/statusRefresh');
  });
});

describe('existing exports are intact', () => {
  test('track / sanitizeEvent / createAnalytics / constants still exported next to funnel', () => {
    for (const k of ['track', 'sanitizeEvent', 'createAnalytics', '_resetMemo', 'EVENT_TYPES', 'EVENT_STEPS', 'UI_EVENT_TYPES', 'UI_FAIL_CODES', 'CAPS', 'funnel']) expect(analytics[k]).toBeDefined();
    expect(typeof analytics.funnel).toBe('function');
  });
});
