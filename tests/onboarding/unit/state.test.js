'use strict';
const state = require('../../../shared/onboarding/state');
const { OnbError } = require('../../../shared/onboarding/errors');
const { createFakeModel } = require('./_b0Store');

const BEL = String.fromCharCode(7);
const OLD_ID = '507f1f77bcf86cd799439001';   // the oldest workspace (owner / webhook workspace)
const NEW_ID = '507f1f77bcf86cd799439002';   // a fresh self-serve signup
const MID_ID = '507f1f77bcf86cd799439003';   // legacy-looking workspace created before the cutover
const OFF_ID = '507f1f77bcf86cd799439004';

const ENV = ['ONBOARDING_FLOW', 'ONBOARDING_ENROL_FROM', 'ONBOARDING_UNLOCK_AT', 'ONBOARDING_LEGACY_SEND_POLICY', 'ONBOARDING_ACCEPT_TRIALING'];
const saved = {};
beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } state.clearCache(); });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function makeDeps(over = {}) {
  let t = Date.parse('2026-10-15T10:00:00Z');
  const clock = { now: () => new Date(t), advance: (ms) => { t += ms; } };
  const deps = {
    OnboardingState: createFakeModel({
      unique: [['workspaceId']],
      defaults: { enrolled: true, 'subscription.state': 'none', 'subscription.source': null, 'steps.connect.status': 'todo', 'progress.status': 'in_progress' },
    }),
    WhatsAppConnection: createFakeModel({ unique: [['workspaceId']] }),
    OnboardingAdminLog: createFakeModel(),
    Workspace: createFakeModel(),
    Customer: createFakeModel(),
    Order: createFakeModel(),
    Promotion: createFakeModel(),
    now: clock.now,
    track: jest.fn(async () => {}),
    ...over,
  };
  deps.Workspace.seed({ _id: OLD_ID, name: 'Owner', createdAt: new Date('2026-01-01T00:00:00Z'), onboarding: { completed: true } });
  deps.Workspace.seed({ _id: MID_ID, name: 'Mid', createdAt: new Date('2026-06-01T00:00:00Z'), onboarding: { completed: false } });
  deps.Workspace.seed({ _id: NEW_ID, name: 'Fresh', createdAt: new Date('2026-10-14T00:00:00Z'), onboarding: { completed: false } });
  return { deps, clock };
}
const stateRow = (deps, id) => deps.OnboardingState.rows.find((r) => String(r.workspaceId) === id);
const ws = (deps, id) => deps.Workspace.rows.find((r) => r._id === id);

describe('buildGateState (pure)', () => {
  test('absent / un-enrolled -> { enrolled:false }', () => {
    expect(state.buildGateState(null, null)).toEqual({ enrolled: false });
    expect(state.buildGateState({ enrolled: false, subscription: { state: 'active' } }, null)).toEqual({ enrolled: false });
  });
  test('shape of an enrolled workspace', () => {
    const g = state.buildGateState({ enrolled: true, subscription: { state: 'active', source: 'admin' }, steps: { connect: { status: 'done' } }, progress: {} }, { status: 'connected', needsReconnect: false, extra: 1 });
    expect(g).toEqual({
      enrolled: true, sub: { state: 'active', source: 'admin' }, conn: { status: 'connected', needsReconnect: false },
      locked: false, unlockAt: 'connected', completed: false, connectDone: true, legacyPolicy: 'block',
    });
  });
  test('locked: until step 3 is done (default) or the flow is finished (unlockAt=finished); always while unpaid', () => {
    const base = { enrolled: true, subscription: { state: 'active' }, steps: { connect: { status: 'todo' } }, progress: {} };
    expect(state.buildGateState(base, null).locked).toBe(true);
    expect(state.buildGateState({ ...base, steps: { connect: { status: 'done' } } }, null).locked).toBe(false);
    expect(state.buildGateState({ ...base, subscription: { state: 'pending' }, steps: { connect: { status: 'done' } } }, null).locked).toBe(true);
    process.env.ONBOARDING_UNLOCK_AT = 'finished';
    const done = { ...base, steps: { connect: { status: 'done' } } };
    expect(state.buildGateState(done, null)).toMatchObject({ locked: true, unlockAt: 'finished' });
    expect(state.buildGateState({ ...done, progress: { completedAt: new Date() } }, null)).toMatchObject({ locked: false, completed: true });
  });
  test('missing nested data defaults safely; legacyPolicy follows the env', () => {
    const g = state.buildGateState({ enrolled: true }, null);
    expect(g.sub).toEqual({ state: 'none', source: null });
    expect(g.conn).toBeNull();
    process.env.ONBOARDING_LEGACY_SEND_POLICY = 'platform_number';
    expect(state.buildGateState({ enrolled: true }, null).legacyPolicy).toBe('platform_number');
  });
});

describe('getGateState: cache, negative cache, stale-if-error, fail-open', () => {
  test('legacy workspace (no sidecar) -> { enrolled:false }, cached 60 s', async () => {
    const { deps, clock } = makeDeps();
    expect(await state.getGateState(NEW_ID, { deps })).toEqual({ enrolled: false });
    expect(await state.getGateState(NEW_ID, { deps })).toEqual({ enrolled: false });
    expect(deps.OnboardingState.calls.filter((c) => c[0] === 'findOne')).toHaveLength(1);
    clock.advance(59000);
    await state.getGateState(NEW_ID, { deps });
    expect(deps.OnboardingState.calls.filter((c) => c[0] === 'findOne')).toHaveLength(1);
    clock.advance(2000);
    await state.getGateState(NEW_ID, { deps });
    expect(deps.OnboardingState.calls.filter((c) => c[0] === 'findOne')).toHaveLength(2);
  });
  test('enrolled workspace cached 30 s; connection read only when enrolled', async () => {
    const { deps, clock } = makeDeps();
    deps.OnboardingState.seed({ workspaceId: NEW_ID, enrolled: true, subscription: { state: 'active', source: 'admin' }, steps: { connect: { status: 'done' } } });
    deps.WhatsAppConnection.seed({ workspaceId: NEW_ID, status: 'connected', needsReconnect: false });
    const g = await state.getGateState(NEW_ID, { deps });
    expect(g).toMatchObject({ enrolled: true, sub: { state: 'active' }, conn: { status: 'connected' } });
    await state.getGateState(NEW_ID, { deps });
    expect(deps.OnboardingState.calls.filter((c) => c[0] === 'findOne')).toHaveLength(1);
    clock.advance(31000);
    await state.getGateState(NEW_ID, { deps });
    expect(deps.OnboardingState.calls.filter((c) => c[0] === 'findOne')).toHaveLength(2);
    await state.getGateState(OLD_ID, { deps });
    expect(deps.WhatsAppConnection.calls.filter((c) => c[1] && String(c[1].workspaceId) === OLD_ID)).toHaveLength(0);
  });
  test('fresh:true bypasses the cache; invalidate() forces a re-read', async () => {
    const { deps } = makeDeps();
    await state.getGateState(NEW_ID, { deps });
    deps.OnboardingState.seed({ workspaceId: NEW_ID, enrolled: true, subscription: { state: 'active' } });
    expect((await state.getGateState(NEW_ID, { deps })).enrolled).toBe(false);          // cached negative
    expect((await state.getGateState(NEW_ID, { deps, fresh: true })).enrolled).toBe(true);
    stateRow(deps, NEW_ID).enrolled = false;
    expect((await state.getGateState(NEW_ID, { deps })).enrolled).toBe(true);           // cached positive
    state.invalidate(NEW_ID);
    expect((await state.getGateState(NEW_ID, { deps })).enrolled).toBe(false);          // un-enrol is instant after invalidate
  });
  test('invalid ids never hit the database', async () => {
    const { deps } = makeDeps();
    for (const bad of [undefined, null, '', 'x', '123', { a: 1 }]) expect(await state.getGateState(bad, { deps })).toEqual({ enrolled: false });
    expect(deps.OnboardingState.calls).toHaveLength(0);
  });
  test('stale-if-error: serves the last value for up to 10 minutes, then fails open', async () => {
    const { deps, clock } = makeDeps();
    deps.OnboardingState.seed({ workspaceId: NEW_ID, enrolled: true, subscription: { state: 'none' } });
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await state.getGateState(NEW_ID, { deps })).enrolled).toBe(true);
    deps.OnboardingState.failWith = new Error('db down');
    clock.advance(31000); // cache expired -> lookup -> error -> stale value
    const stale = await state.getGateState(NEW_ID, { deps });
    expect(stale).toMatchObject({ enrolled: true, stale: true, sub: { state: 'none' } });
    clock.advance(9 * 60 * 1000);
    expect((await state.getGateState(NEW_ID, { deps })).stale).toBe(true);
    clock.advance(2 * 60 * 1000); // > 10 min after the last good read
    expect(await state.getGateState(NEW_ID, { deps })).toEqual({ enrolled: false });
    spy.mockRestore();
  });
  test('nothing cached + database error -> fail-open and ONE log line per minute', async () => {
    const { deps, clock } = makeDeps();
    deps.OnboardingState.failWith = new Error('db down');
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 5; i += 1) expect(await state.getGateState(NEW_ID, { deps })).toEqual({ enrolled: false });
    expect(spy).toHaveBeenCalledTimes(1);
    clock.advance(61000);
    await state.getGateState(NEW_ID, { deps });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
  test('a failed read does not poison the cache: the next success is cached normally', async () => {
    const { deps } = makeDeps();
    deps.OnboardingState.failWith = new Error('db down');
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await state.getGateState(NEW_ID, { deps });
    deps.OnboardingState.failWith = null;
    deps.OnboardingState.seed({ workspaceId: NEW_ID, enrolled: true });
    expect((await state.getGateState(NEW_ID, { deps })).enrolled).toBe(true);
    spy.mockRestore();
  });
});

describe('getState / ensureState / ensureConnection', () => {
  test('getState: null when absent or un-enrolled', async () => {
    const { deps } = makeDeps();
    expect(await state.getState(NEW_ID, deps)).toBeNull();
    deps.OnboardingState.seed({ workspaceId: NEW_ID, enrolled: false });
    expect(await state.getState(NEW_ID, deps)).toBeNull();
    expect(await state.getState('bad', deps)).toBeNull();
  });
  test('ensureState throws ONBOARDING_NOT_AVAILABLE (404) and never creates an enrolment', async () => {
    const { deps } = makeDeps();
    await expect(state.ensureState(NEW_ID, deps)).rejects.toMatchObject({ code: 'ONBOARDING_NOT_AVAILABLE', status: 404 });
    expect(deps.OnboardingState.rows).toHaveLength(0);
    deps.OnboardingState.seed({ workspaceId: NEW_ID, enrolled: true });
    expect((await state.ensureState(NEW_ID, deps)).workspaceId).toBe(NEW_ID);
  });
  test('ensureConnection upserts one row for an enrolled workspace only', async () => {
    const { deps } = makeDeps();
    await expect(state.ensureConnection(NEW_ID, deps)).rejects.toBeInstanceOf(OnbError);
    expect(deps.WhatsAppConnection.rows).toHaveLength(0);
    deps.OnboardingState.seed({ workspaceId: NEW_ID, enrolled: true });
    const a = await state.ensureConnection(NEW_ID, deps);
    const b = await state.ensureConnection(NEW_ID, deps);
    expect(String(a._id)).toBe(String(b._id));
    expect(deps.WhatsAppConnection.rows).toHaveLength(1);
  });
});

describe('recomputeSubscription', () => {
  test('writes the transition once and stamps activatedAt; idempotent afterwards', async () => {
    const { deps } = makeDeps();
    deps.OnboardingState.seed({ workspaceId: NEW_ID, enrolled: true, subscription: { state: 'pending', source: null, stripe: { status: 'active', subscriptionId: 'sub_1' } } });
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await state.recomputeSubscription(NEW_ID, {}, deps);
    expect(r).toEqual({ changed: true, before: { state: 'pending', source: null }, after: { state: 'active', source: 'stripe' } });
    const row = stateRow(deps, NEW_ID);
    expect(row.subscription.state).toBe('active');
    expect(row.subscription.activatedAt).toBeInstanceOf(Date);
    const again = await state.recomputeSubscription(NEW_ID, {}, deps);
    expect(again.changed).toBe(false);
    spy.mockRestore();
  });
  test('invalidates the gate cache', async () => {
    const { deps } = makeDeps();
    deps.OnboardingState.seed({ workspaceId: NEW_ID, enrolled: true, subscription: { state: 'none', stripe: {} } });
    expect((await state.getGateState(NEW_ID, { deps })).sub.state).toBe('none');
    stateRow(deps, NEW_ID).subscription.stripe = { status: 'past_due', subscriptionId: 's' };
    await state.recomputeSubscription(NEW_ID, {}, deps);
    expect((await state.getGateState(NEW_ID, { deps })).sub.state).toBe('past_due');
  });
  test('unknown workspace -> unchanged; bad id -> validation error', async () => {
    const { deps } = makeDeps();
    expect(await state.recomputeSubscription(NEW_ID, {}, deps)).toEqual({ changed: false, before: null, after: null });
    await expect(state.recomputeSubscription('x', {}, deps)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('enrol', () => {
  test('admin enrolment of a clean workspace: sidecar row, R1 applied, admin log written first', async () => {
    const { deps } = makeDeps();
    const r = await state.enrol({ workspaceId: NEW_ID, by: 'cli:adeel', notes: 'pilot', via: 'admin' }, deps);
    expect(r).toMatchObject({ ok: true, dryRun: false, alreadyEnrolled: false, enrolled: true, r1Applied: true, activated: false, warnings: [] });
    const row = stateRow(deps, NEW_ID);
    expect(row).toMatchObject({ enrolled: true, enrolledVia: 'admin', enrolledBy: 'cli:adeel', schemaVersion: 1, r1Applied: true });
    expect(row.subscription.state).toBe('none');
    expect(ws(deps, NEW_ID).onboarding.completed).toBe(true);
    expect(deps.OnboardingAdminLog.rows).toHaveLength(1);
    expect(deps.OnboardingAdminLog.rows[0]).toMatchObject({ action: 'enrol', adminUser: 'cli:adeel', notes: 'pilot' });
  });
  test('R1 touches ONLY the enrolled workspace', async () => {
    const { deps } = makeDeps();
    await state.enrol({ workspaceId: NEW_ID, by: 'a' }, deps);
    expect(ws(deps, MID_ID).onboarding.completed).toBe(false);
    expect(ws(deps, OLD_ID).onboarding.completed).toBe(true);
  });
  test('R1 failure is soft: enrolment still succeeds', async () => {
    const { deps } = makeDeps();
    deps.Workspace.updateOne = async () => { throw new Error('write failed'); };
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await state.enrol({ workspaceId: NEW_ID, by: 'a' }, deps);
    expect(r.enrolled).toBe(true);
    expect(r.r1Applied).toBe(false);
    spy.mockRestore();
  });
  test('safeguard: the OLDEST workspace needs --force-oldest', async () => {
    const { deps } = makeDeps();
    await expect(state.enrol({ workspaceId: OLD_ID, by: 'a' }, deps)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'OLDEST_WORKSPACE' } });
    expect(deps.OnboardingState.rows).toHaveLength(0);
    expect(deps.OnboardingAdminLog.rows).toHaveLength(0);
    const r = await state.enrol({ workspaceId: OLD_ID, by: 'a', forceOldest: true }, deps);
    expect(r.enrolled).toBe(true);
    expect(r.warnings).toContain('oldest_workspace_forced');
  });
  test.each(['Customer', 'Order', 'Promotion'])('safeguard: existing %s data needs --confirm-existing-data', async (model) => {
    const { deps } = makeDeps();
    deps[model].seed({ workspaceId: MID_ID });
    await expect(state.enrol({ workspaceId: MID_ID, by: 'a' }, deps)).rejects.toMatchObject({ details: { reason: 'EXISTING_DATA' } });
    expect(deps.OnboardingState.rows).toHaveLength(0);
    const r = await state.enrol({ workspaceId: MID_ID, by: 'a', confirmExistingData: true }, deps);
    expect(r.enrolled).toBe(true);
    expect(r.warnings).toContain('existing_data_confirmed');
  });
  test('safeguard: createdAt before ENROL_FROM counts as existing data', async () => {
    process.env.ONBOARDING_ENROL_FROM = '2026-10-01T00:00:00Z';
    const { deps } = makeDeps();
    await expect(state.enrol({ workspaceId: MID_ID, by: 'a' }, deps)).rejects.toMatchObject({ details: { reason: 'EXISTING_DATA', reasons: ['created_before_cutover'] } });
    expect((await state.enrol({ workspaceId: NEW_ID, by: 'a' }, deps)).enrolled).toBe(true); // created after the cutover
  });
  test('both safeguards report the oldest workspace first', async () => {
    const { deps } = makeDeps();
    deps.Customer.seed({ workspaceId: OLD_ID });
    await expect(state.enrol({ workspaceId: OLD_ID, by: 'a' }, deps)).rejects.toMatchObject({ details: { reason: 'OLDEST_WORKSPACE' } });
    await expect(state.enrol({ workspaceId: OLD_ID, by: 'a', forceOldest: true }, deps)).rejects.toMatchObject({ details: { reason: 'EXISTING_DATA' } });
  });
  test('dry run writes nothing (not even the log) but still enforces safeguards', async () => {
    const { deps } = makeDeps();
    const r = await state.enrol({ workspaceId: NEW_ID, by: 'a', dryRun: true }, deps);
    expect(r).toMatchObject({ ok: true, dryRun: true, alreadyEnrolled: false, enrolled: false });
    expect(deps.OnboardingState.rows).toHaveLength(0);
    expect(deps.OnboardingAdminLog.rows).toHaveLength(0);
    expect(ws(deps, NEW_ID).onboarding.completed).toBe(false);
    await expect(state.enrol({ workspaceId: OLD_ID, by: 'a', dryRun: true }, deps)).rejects.toMatchObject({ details: { reason: 'OLDEST_WORKSPACE' } });
  });
  test('log-before-mutate: a failing log row means NOTHING changed', async () => {
    const { deps } = makeDeps();
    deps.OnboardingAdminLog.failWith = new Error('log write failed');
    await expect(state.enrol({ workspaceId: NEW_ID, by: 'a' }, deps)).rejects.toThrow('log write failed');
    expect(deps.OnboardingState.rows).toHaveLength(0);
    expect(ws(deps, NEW_ID).onboarding.completed).toBe(false);
  });
  test('enrolling twice is idempotent (no second row, no second log row)', async () => {
    const { deps } = makeDeps();
    await state.enrol({ workspaceId: NEW_ID, by: 'a' }, deps);
    const again = await state.enrol({ workspaceId: NEW_ID, by: 'a' }, deps);
    expect(again).toMatchObject({ alreadyEnrolled: true, enrolled: true, r1Applied: false });
    expect(deps.OnboardingState.rows).toHaveLength(1);
    expect(deps.OnboardingAdminLog.rows).toHaveLength(1);
  });
  test('--activate enrols AND activates in one step (log row action enrol_activate)', async () => {
    const { deps } = makeDeps();
    const r = await state.enrol({ workspaceId: NEW_ID, by: 'a', activate: true, notes: 'Riyadh partner' }, deps);
    expect(r.activated).toBe(true);
    const row = stateRow(deps, NEW_ID);
    expect(row.subscription).toMatchObject({ state: 'active', source: 'admin' });
    expect(row.subscription.admin).toMatchObject({ active: true, by: 'a', notes: 'Riyadh partner' });
    expect(deps.OnboardingAdminLog.rows.map((x) => x.action)).toEqual(['enrol_activate']);
  });
  test('validation: bad id, unknown workspace', async () => {
    const { deps } = makeDeps();
    await expect(state.enrol({ workspaceId: 'zzz' }, deps)).rejects.toMatchObject({ details: { reason: 'INVALID_WORKSPACE_ID' } });
    await expect(state.enrol({ workspaceId: '507f1f77bcf86cd7994399ff' }, deps)).rejects.toMatchObject({ details: { reason: 'WORKSPACE_NOT_FOUND' } });
  });
  test('control characters are stripped from by/notes before they reach the log', async () => {
    const { deps } = makeDeps();
    await state.enrol({ workspaceId: NEW_ID, by: 'cli:a\nb', notes: `x${BEL}y` }, deps);
    const row = deps.OnboardingAdminLog.rows[0];
    expect(row.adminUser).toBe('cli:ab');
    expect(row.notes).toBe('x y');
  });
  test('the gate sees the enrolment immediately (cache invalidated)', async () => {
    const { deps } = makeDeps();
    expect((await state.getGateState(NEW_ID, { deps })).enrolled).toBe(false);
    await state.enrol({ workspaceId: NEW_ID, by: 'a' }, deps);
    expect((await state.getGateState(NEW_ID, { deps })).enrolled).toBe(true);
  });
});

describe('unenrol / unenrolAll', () => {
  test('un-enrol keeps the document, is logged, and is instant', async () => {
    const { deps } = makeDeps();
    await state.enrol({ workspaceId: NEW_ID, by: 'a' }, deps);
    expect((await state.getGateState(NEW_ID, { deps })).enrolled).toBe(true);
    const r = await state.unenrol({ workspaceId: NEW_ID, by: 'a' }, deps);
    expect(r).toEqual({ ok: true, dryRun: false, wasEnrolled: true });
    expect(stateRow(deps, NEW_ID)).toMatchObject({ enrolled: false, unenrolledBy: 'a' });
    expect(deps.OnboardingState.rows).toHaveLength(1);
    expect((await state.getGateState(NEW_ID, { deps })).enrolled).toBe(false);
    expect(deps.OnboardingAdminLog.rows.map((x) => x.action)).toEqual(['enrol', 'unenrol']);
  });
  test('un-enrolling a legacy workspace is a no-op without a log row; dry run writes nothing', async () => {
    const { deps } = makeDeps();
    expect(await state.unenrol({ workspaceId: NEW_ID, by: 'a' }, deps)).toEqual({ ok: true, dryRun: false, wasEnrolled: false });
    expect(deps.OnboardingAdminLog.rows).toHaveLength(0);
    await state.enrol({ workspaceId: NEW_ID, by: 'a' }, deps);
    expect(await state.unenrol({ workspaceId: NEW_ID, by: 'a', dryRun: true }, deps)).toEqual({ ok: true, dryRun: true, wasEnrolled: true });
    expect(stateRow(deps, NEW_ID).enrolled).toBe(true);
  });
  test('re-enrolment after un-enrolment keeps the same document', async () => {
    const { deps } = makeDeps();
    await state.enrol({ workspaceId: NEW_ID, by: 'a' }, deps);
    await state.unenrol({ workspaceId: NEW_ID, by: 'a' }, deps);
    const r = await state.enrol({ workspaceId: NEW_ID, by: 'a' }, deps);
    expect(r.alreadyEnrolled).toBe(false);
    expect(deps.OnboardingState.rows).toHaveLength(1);
    expect(stateRow(deps, NEW_ID)).toMatchObject({ enrolled: true });
    expect(stateRow(deps, NEW_ID).unenrolledAt).toBeUndefined();
  });
  test('unenrolAll flips every enrolled row, logs each, keeps rows, clears the cache', async () => {
    const { deps } = makeDeps();
    await state.enrol({ workspaceId: NEW_ID, by: 'a' }, deps);
    await state.enrol({ workspaceId: MID_ID, by: 'a', confirmExistingData: true }, deps);
    expect((await state.getGateState(MID_ID, { deps })).enrolled).toBe(true);
    expect(await state.unenrolAll({ by: 'a', dryRun: true }, deps)).toEqual({ ok: true, dryRun: true, count: 2 });
    expect(await state.unenrolAll({ by: 'a' }, deps)).toEqual({ ok: true, dryRun: false, count: 2 });
    expect(deps.OnboardingState.rows.every((r) => r.enrolled === false)).toBe(true);
    expect(deps.OnboardingState.rows).toHaveLength(2);
    expect((await state.getGateState(MID_ID, { deps })).enrolled).toBe(false);
    expect(deps.OnboardingAdminLog.rows.filter((x) => x.action === 'unenrol')).toHaveLength(2);
  });
});

describe('adminActivate / adminDeactivate', () => {
  async function enrolled(deps) { await state.enrol({ workspaceId: NEW_ID, by: 'a' }, deps); }
  test('activation needs notes and an enrolled workspace', async () => {
    const { deps } = makeDeps();
    await expect(state.adminActivate({ workspaceId: NEW_ID, by: 'a', notes: 'x' }, deps)).rejects.toMatchObject({ details: { reason: 'NOT_ENROLLED' } });
    await enrolled(deps);
    await expect(state.adminActivate({ workspaceId: NEW_ID, by: 'a', notes: '  ' }, deps)).rejects.toMatchObject({ details: { reason: 'NOTES_REQUIRED' } });
  });
  test('activate -> active/admin, logged first; deactivate -> back to none; Stripe facts untouched', async () => {
    const { deps } = makeDeps();
    await enrolled(deps);
    const a = await state.adminActivate({ workspaceId: NEW_ID, by: 'a', notes: 'Riyadh partner' }, deps);
    expect(a).toMatchObject({ ok: true, before: { state: 'none', source: null }, after: { state: 'active', source: 'admin' } });
    expect((await state.getGateState(NEW_ID, { deps })).sub).toEqual({ state: 'active', source: 'admin' });
    expect(deps.OnboardingAdminLog.rows.map((x) => x.action)).toEqual(['enrol', 'activate']);
    const d = await state.adminDeactivate({ workspaceId: NEW_ID, by: 'a', notes: 'ended' }, deps);
    expect(d.after).toEqual({ state: 'none', source: null });
    expect(stateRow(deps, NEW_ID).subscription.admin.active).toBe(false);
    expect((await state.getGateState(NEW_ID, { deps })).sub.state).toBe('none');
  });
  test('admin activation survives Stripe past_due; deactivation then reveals the Stripe state', async () => {
    const { deps } = makeDeps();
    await enrolled(deps);
    stateRow(deps, NEW_ID).subscription.stripe = { status: 'past_due', subscriptionId: 's1' };
    await state.adminActivate({ workspaceId: NEW_ID, by: 'a', notes: 'partner' }, deps);
    expect(stateRow(deps, NEW_ID).subscription).toMatchObject({ state: 'active', source: 'admin' });
    const d = await state.adminDeactivate({ workspaceId: NEW_ID, by: 'a' }, deps);
    expect(d.after).toEqual({ state: 'past_due', source: null });
  });
  test('dry run predicts without writing', async () => {
    const { deps } = makeDeps();
    await enrolled(deps);
    const r = await state.adminActivate({ workspaceId: NEW_ID, by: 'a', notes: 'x', dryRun: true }, deps);
    expect(r).toMatchObject({ dryRun: true, after: { state: 'active', source: 'admin' } });
    expect(stateRow(deps, NEW_ID).subscription.state).toBe('none');
    expect(deps.OnboardingAdminLog.rows).toHaveLength(1); // only the enrolment
  });
  test('log-before-mutate on activation', async () => {
    const { deps } = makeDeps();
    await enrolled(deps);
    deps.OnboardingAdminLog.failWith = new Error('log write failed');
    await expect(state.adminActivate({ workspaceId: NEW_ID, by: 'a', notes: 'x' }, deps)).rejects.toThrow('log write failed');
    expect(stateRow(deps, NEW_ID).subscription.state).toBe('none');
    expect(stateRow(deps, NEW_ID).subscription.admin).toBeUndefined();
  });
});

describe('autoEnrolIfEligible (DB 3.2 rule 2)', () => {
  const on = () => { process.env.ONBOARDING_FLOW = 'on'; process.env.ONBOARDING_ENROL_FROM = '2026-10-01T00:00:00Z'; };

  test('flag off / no cutover -> nothing, nothing read', async () => {
    const { deps } = makeDeps();
    expect(await state.autoEnrolIfEligible({ workspaceId: NEW_ID }, deps)).toEqual({ enrolled: false, reason: 'flag_off' });
    process.env.ONBOARDING_FLOW = 'on';
    expect(await state.autoEnrolIfEligible({ workspaceId: NEW_ID }, deps)).toEqual({ enrolled: false, reason: 'no_cutover' });
    process.env.ONBOARDING_ENROL_FROM = 'garbage';
    expect((await state.autoEnrolIfEligible({ workspaceId: NEW_ID }, deps)).reason).toBe('no_cutover');
    expect(deps.OnboardingState.calls).toHaveLength(0);
    expect(deps.Workspace.calls).toHaveLength(0);
  });
  test('a fresh signup after the cutover is enrolled (R1 applied, by system, via auto_signup)', async () => {
    on();
    const { deps } = makeDeps();
    expect(await state.autoEnrolIfEligible({ workspaceId: NEW_ID }, deps)).toEqual({ enrolled: true, reason: 'eligible' });
    expect(stateRow(deps, NEW_ID)).toMatchObject({ enrolled: true, enrolledVia: 'auto_signup', enrolledBy: 'system', r1Applied: true });
    expect(ws(deps, NEW_ID).onboarding.completed).toBe(true);
  });
  test.each([
    ['completed:true (every legacy workspace)', (deps) => { ws(deps, NEW_ID).onboarding.completed = true; }, 'completed'],
    ['created before the cutover', (deps) => { ws(deps, NEW_ID).createdAt = new Date('2026-09-30T23:59:59Z'); }, 'before_cutover'],
    ['already has a sidecar that is un-enrolled (never auto re-enrolled)', (deps) => { deps.OnboardingState.seed({ workspaceId: NEW_ID, enrolled: false }); }, 'unenrolled'],
    ['already enrolled', (deps) => { deps.OnboardingState.seed({ workspaceId: NEW_ID, enrolled: true }); }, 'already_enrolled'],
  ])('not eligible: %s', async (_name, arrange, reason) => {
    on();
    const { deps } = makeDeps();
    arrange(deps);
    const r = await state.autoEnrolIfEligible({ workspaceId: NEW_ID }, deps);
    expect(r).toEqual({ enrolled: false, reason });
    expect(deps.OnboardingState.rows.filter((x) => x.enrolled === true && x.enrolledVia)).toHaveLength(0);
  });
  test('the OLDEST workspace is never auto-enrolled, even if completed:false and created after the cutover', async () => {
    process.env.ONBOARDING_FLOW = 'on';
    process.env.ONBOARDING_ENROL_FROM = '2026-01-01T00:00:00Z';
    const { deps } = makeDeps();
    ws(deps, OLD_ID).onboarding.completed = false;
    expect((await state.autoEnrolIfEligible({ workspaceId: OLD_ID }, deps)).reason).toBe('oldest_workspace');
    expect(deps.OnboardingState.rows).toHaveLength(0);
  });
  test('misconfiguration guard: ENROL_FROM earlier than the oldest workspace refuses auto-enrolment and logs once', async () => {
    process.env.ONBOARDING_FLOW = 'on';
    process.env.ONBOARDING_ENROL_FROM = '2025-01-01T00:00:00Z'; // before the oldest workspace (2026-01-01)
    const { deps, clock } = makeDeps();
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await state.autoEnrolIfEligible({ workspaceId: NEW_ID }, deps)).reason).toBe('misconfigured_cutover');
    expect((await state.autoEnrolIfEligible({ workspaceId: MID_ID }, deps)).reason).toBe('misconfigured_cutover');
    expect(deps.OnboardingState.rows).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(1);
    clock.advance(1000);
    spy.mockRestore();
  });
  test('negatives are memoised (no database reads on the repeat)', async () => {
    on();
    const { deps } = makeDeps();
    ws(deps, NEW_ID).onboarding.completed = true;
    await state.autoEnrolIfEligible({ workspaceId: NEW_ID }, deps);
    const before = deps.Workspace.calls.length + deps.OnboardingState.calls.length;
    await state.autoEnrolIfEligible({ workspaceId: NEW_ID }, deps);
    expect(deps.Workspace.calls.length + deps.OnboardingState.calls.length).toBe(before);
  });
  test('two simultaneous first requests -> exactly one sidecar row (E11000 handled), R1 once', async () => {
    on();
    const { deps } = makeDeps();
    const [a, b] = await Promise.all([
      state.autoEnrolIfEligible({ workspaceId: NEW_ID }, deps),
      state.autoEnrolIfEligible({ workspaceId: NEW_ID }, deps),
    ]);
    expect(deps.OnboardingState.rows.filter((r) => String(r.workspaceId) === NEW_ID)).toHaveLength(1);
    expect([a.enrolled, b.enrolled]).toEqual([true, true]);
    expect(ws(deps, NEW_ID).onboarding.completed).toBe(true);
    expect(deps.OnboardingAdminLog.rows.filter((r) => r.action === 'enrol')).toHaveLength(1); // only the winner writes the audit row
    expect(deps.track.mock.calls.filter((c) => c[1].reason === 'enrolled_auto')).toHaveLength(1);
  });
  test('an error never throws (returns reason error)', async () => {
    on();
    const { deps } = makeDeps();
    deps.Workspace.failWith = new Error('db down');
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(state.autoEnrolIfEligible({ workspaceId: NEW_ID }, deps)).resolves.toEqual({ enrolled: false, reason: 'error' });
    spy.mockRestore();
  });
  test('invalid id', async () => {
    on();
    const { deps } = makeDeps();
    expect((await state.autoEnrolIfEligible({ workspaceId: 'bad' }, deps)).reason).toBe('invalid_workspace');
    expect((await state.autoEnrolIfEligible(undefined, deps)).reason).toBe('invalid_workspace');
  });
});

describe('getOldestWorkspace', () => {
  test('returns the earliest-created workspace, memoised for 10 minutes unless fresh', async () => {
    const { deps, clock } = makeDeps();
    expect(String((await state.getOldestWorkspace({ deps }))._id)).toBe(OLD_ID);
    const calls = () => deps.Workspace.calls.filter((c) => c[0] === 'findOne').length;
    await state.getOldestWorkspace({ deps });
    expect(calls()).toBe(1);
    await state.getOldestWorkspace({ deps, fresh: true });
    expect(calls()).toBe(2);
    clock.advance(11 * 60 * 1000);
    await state.getOldestWorkspace({ deps });
    expect(calls()).toBe(3);
  });
});
