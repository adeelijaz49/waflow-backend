'use strict';
const sch = require('../../../shared/onboarding/scheduler');
const { createFakeModel } = require('./_b0Store');

const { startOnboardingScheduler, stopOnboardingScheduler, runOnboardingSweep, acquireLock, tick, LOCK_ID } = sch;
const NOW = Date.parse('2026-10-15T09:00:00Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const WS = (n) => `507f1f77bcf86cd7994390${String(n).padStart(2, '0')}`;

function makeLock({ renewed = null, createError = null } = {}) {
  return {
    findOneAndUpdate: jest.fn(async () => renewed),
    create: jest.fn(async () => { if (createError) throw createError; return {}; }),
  };
}
const load = (mod, name) => () => { if (mod instanceof Error) throw mod; if (!mod) throw new Error(`Cannot find module ${name}`); return mod; };

/** Fully injected deps: nothing real is ever required. */
function makeDeps(over = {}) {
  const order = [];
  const lock = over.lock || makeLock();
  const Connection = over.Connection || createFakeModel();
  const gate = over.gate || {};
  const sr = over.sr === undefined ? { refreshConnection: jest.fn(async (ws) => { order.push('connections'); return { level: 'connected', ws }; }) } : over.sr;
  const state = over.state === undefined ? { getGateState: jest.fn(async (ws) => gate[ws] || { enrolled: true, sub: { state: 'active' } }) } : over.state;
  const starterTemplates = over.starterTemplates === undefined
    ? {
      pollStatuses: jest.fn(async () => { order.push('templates'); return { workspaces: 1, checked: 2, changed: 1, skipped: 0, errors: 0, submit: { submitted: 2 } }; }),
      submitQueued: jest.fn(async () => ({ submitted: 7 })),
    }
    : over.starterTemplates;
  const reminders = over.reminders === undefined ? { runPathBReminders: jest.fn(async () => { order.push('pathB'); return { sent: 1 }; }) } : over.reminders;
  const notifications = over.notifications === undefined ? { retryEmails: jest.fn(async () => { order.push('emails'); return { attempted: 1, sent: 1 }; }) } : over.notifications;
  const connect = over.connect === undefined ? { resumeConnect: jest.fn(async () => { order.push('resume'); return { status: 'connected' }; }) } : over.connect;
  const billing = over.billing === undefined ? { reconcileSweep: jest.fn(async () => { order.push('billing'); return { checked: 3, changed: 1 }; }) } : over.billing;
  const approvals = over.approvals === undefined ? { reRegisterDueNames: jest.fn(async () => { order.push('displayName'); return { checked: 1, registered: 1 }; }) } : over.approvals;
  const deps = {
    SchedulerLock: () => lock,
    Connection: () => Connection,
    statusRefresh: load(sr, 'statusRefresh'),
    state: load(state, 'state'),
    starterTemplates: load(starterTemplates, 'starterTemplates'),
    reminders: load(reminders, 'reminders'),
    notifications: load(notifications, 'notifications'),
    connect: load(connect, 'connect'),
    billing: load(billing, 'billing'),
    approvals: load(approvals, 'approvals'),
    enabled: over.enabled || (() => true),
    log: jest.fn(),
    now: () => NOW,
    stepTimeoutMs: over.stepTimeoutMs || 2000,
  };
  return { deps, lock, Connection, sr, state, starterTemplates, reminders, notifications, connect, billing, approvals, order };
}

const conn = (Connection, n, over = {}) => Connection.seed({
  workspaceId: WS(n), status: 'connected', nextCheckAt: new Date(NOW - n * MIN), ...over,
});

afterEach(() => stopOnboardingScheduler(() => {}));

describe('acquireLock (copy of the localisation scheduler)', () => {
  test('renews an expired lock with returnDocument:after and TTL = interval - 30s', async () => {
    const { deps, lock } = makeDeps({ lock: makeLock({ renewed: { _id: LOCK_ID } }) });
    expect(await acquireLock(deps, 600000)).toBe(true);
    const [filter, update, opts] = lock.findOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe('onboardingScheduler');
    expect(LOCK_ID).toBe('onboardingScheduler');
    expect(filter.lockedUntil.$lt).toEqual(new Date(NOW));
    expect(update.$set.lockedUntil).toEqual(new Date(NOW + 570000));
    expect(opts).toEqual({ returnDocument: 'after' });
    expect(lock.create).not.toHaveBeenCalled();
  });
  test('creates the lock when none exists; loses to a live lock (duplicate key)', async () => {
    const a = makeDeps();
    expect(await acquireLock(a.deps, 600000)).toBe(true);
    expect(a.lock.create).toHaveBeenCalledTimes(1);
    expect(a.lock.create.mock.calls[0][0]._id).toBe('onboardingScheduler');
    const b = makeDeps({ lock: makeLock({ createError: Object.assign(new Error('dup'), { code: 11000 }) }) });
    expect(await acquireLock(b.deps, 600000)).toBe(false);
  });
  test('the TTL never drops below one second; other database errors propagate', async () => {
    const a = makeDeps();
    await acquireLock(a.deps, 5000);
    expect(a.lock.create.mock.calls[0][0].lockedUntil).toEqual(new Date(NOW + 1000));
    const { deps } = makeDeps({ lock: makeLock({ createError: Object.assign(new Error('boom'), { code: 1 }) }) });
    await expect(acquireLock(deps, 600000)).rejects.toThrow('boom');
  });
  test('uses the EXISTING SchedulerLock model (no new collection)', () => {
    const real = sch.realDeps();
    expect(Object.keys(real)).toEqual(expect.arrayContaining(['SchedulerLock', 'Connection', 'statusRefresh', 'state', 'starterTemplates', 'reminders', 'notifications', 'connect', 'billing', 'approvals', 'enabled', 'log', 'now']));
    for (const k of ['SchedulerLock', 'Connection', 'statusRefresh', 'state', 'starterTemplates', 'reminders', 'notifications', 'connect', 'billing', 'approvals']) expect(typeof real[k]).toBe('function');
  });
});

describe('runOnboardingSweep', () => {
  test('runs the seven steps in order and reports what each did', async () => {
    const env = makeDeps();
    conn(env.Connection, 1);
    const res = await runOnboardingSweep(env.deps);
    expect(env.order).toEqual(['connections', 'templates', 'pathB', 'emails', 'billing', 'displayName']);
    expect(res).toMatchObject({
      skipped: false,
      connections: { scanned: 1, refreshed: 1, deferred: 0, failed: 0 },
      templates: { mode: 'poll', workspaces: 1, submitted: 2, polled: 2, failed: 0 },
      pathB: { sent: 1 }, emails: { attempted: 1, sent: 1 }, billing: { checked: 3, changed: 1 }, displayName: { checked: 1, registered: 1 },
    });
    expect(res.resume).toEqual({ checked: 0, resumed: 0, failed: 0 });
    expect(env.reminders.runPathBReminders).toHaveBeenCalledWith({ now: new Date(NOW) });
    expect(env.notifications.retryEmails).toHaveBeenCalledWith({ now: new Date(NOW), limit: 20 });
    expect(env.billing.reconcileSweep).toHaveBeenCalledWith({ now: new Date(NOW) });
    expect(env.approvals.reRegisterDueNames).toHaveBeenCalledWith({ now: NOW });
  });
  test('the flag off skips everything (no module is even loaded)', async () => {
    const env = makeDeps({ enabled: () => false });
    const spy = jest.fn();
    env.deps.statusRefresh = spy;
    expect(await runOnboardingSweep(env.deps)).toMatchObject({ skipped: true, connections: null, billing: null });
    expect(spy).not.toHaveBeenCalled();
    expect(env.reminders.runPathBReminders).not.toHaveBeenCalled();
  });
  test('missing modules are tolerated and logged; the other steps still run', async () => {
    const env = makeDeps({ reminders: null, billing: null, approvals: new Error('syntax error') });
    conn(env.Connection, 1);
    const res = await runOnboardingSweep(env.deps);
    expect(res.pathB).toBeNull();
    expect(res.billing).toBeNull();
    expect(res.displayName).toBeNull();
    expect(res.connections).not.toBeNull();
    expect(env.notifications.retryEmails).toHaveBeenCalled();
    expect(env.deps.log).toHaveBeenCalledWith('reminders unavailable:', expect.stringContaining('Cannot find module'));
    expect(env.deps.log).toHaveBeenCalledWith('approvals unavailable:', 'syntax error');
  });
  test('a module without the expected function is ignored', async () => {
    const env = makeDeps({ reminders: {}, notifications: {}, billing: {}, approvals: {}, connect: {}, sr: {}, starterTemplates: {} });
    const res = await runOnboardingSweep(env.deps);
    expect(res).toMatchObject({ skipped: false, pathB: null, emails: null, billing: null, displayName: null });
  });
  test('a throwing step is caught, logged and does not stop the next step', async () => {
    const reminders = { runPathBReminders: jest.fn(async () => { throw new Error('mail down'); }) };
    const env = makeDeps({ reminders });
    const res = await runOnboardingSweep(env.deps);
    expect(res.pathB).toBeNull();
    expect(env.notifications.retryEmails).toHaveBeenCalled();
    expect(env.billing.reconcileSweep).toHaveBeenCalled();
    expect(env.deps.log).toHaveBeenCalledWith('path B reminders failed:', 'mail down');
  });
  test('a step that never finishes is cut off after the step timeout and the sweep continues', async () => {
    const billing = { reconcileSweep: jest.fn(() => new Promise(() => {})) };
    const env = makeDeps({ billing, stepTimeoutMs: 30 });
    const res = await runOnboardingSweep(env.deps);
    expect(res.billing).toBeNull();
    expect(env.deps.log).toHaveBeenCalledWith('billing reconcile timed out after 30 ms');
    expect(env.approvals.reRegisterDueNames).toHaveBeenCalled();
  });
  test('a database failure inside a sweep (Connection.find rejects) is contained', async () => {
    const Connection = createFakeModel();
    Connection.failWith = new Error('db gone');
    const env = makeDeps({ Connection });
    const res = await runOnboardingSweep(env.deps);
    expect(res.connections).toBeNull();
    expect(res.pathB).toEqual({ sent: 1 });
  });
  test('never throws, even with absurd deps', async () => {
    await expect(runOnboardingSweep({ enabled: () => true, now: () => NOW, log: () => { throw new Error('log failed'); } })).resolves.toBeDefined();
  });
});

describe('sweep 1: connections due, only for active|past_due subscriptions', () => {
  test('refreshes due rows oldest first, leaves future rows alone, single-field sort on nextCheckAt, limit 20', async () => {
    const env = makeDeps();
    conn(env.Connection, 3, { nextCheckAt: new Date(NOW - 3 * MIN) });
    conn(env.Connection, 1, { nextCheckAt: new Date(NOW - 30 * MIN) });
    conn(env.Connection, 2, { nextCheckAt: new Date(NOW + 5 * MIN) });
    const sorts = [];
    const origFind = env.Connection.find;
    env.Connection.find = (f) => { const q = origFind(f); const origSort = q.sort; q.sort = (s) => { sorts.push(s); return origSort(s); }; return q; };
    const res = await sch.sweepConnections(env.deps, NOW);
    expect(env.sr.refreshConnection.mock.calls.map((c) => c[0])).toEqual([WS(1), WS(3)]);
    expect(res).toMatchObject({ refreshed: 2, deferred: 0 });
    expect(sorts).toEqual([{ nextCheckAt: 1 }]);
    const filter = env.Connection.calls.find((c) => c[0] === 'find')[1];
    expect(filter.status.$in).toEqual(['connected', 'needs_attention', 'waba_only', 'connecting']);
    expect(filter.nextCheckAt.$lte).toEqual(new Date(NOW));
    expect(Object.keys(filter).sort()).toEqual(['nextCheckAt', 'status']);
  });
  test.each(['disconnected', 'not_connected', 'reconnect_required', 'error'])('status %s is never selected', async (status) => {
    const env = makeDeps();
    conn(env.Connection, 1, { status });
    await sch.sweepConnections(env.deps, NOW);
    expect(env.sr.refreshConnection).not.toHaveBeenCalled();
  });
  test.each(['connected', 'needs_attention', 'waba_only', 'connecting'])('status %s is selected', async (status) => {
    const env = makeDeps();
    conn(env.Connection, 1, { status });
    await sch.sweepConnections(env.deps, NOW);
    expect(env.sr.refreshConnection).toHaveBeenCalledTimes(1);
  });
  test('cancelled / none / pending / un-enrolled workspaces are NOT polled: the row is deferred 1 h instead (no starvation)', async () => {
    const gate = {
      [WS(1)]: { enrolled: true, sub: { state: 'cancelled' } }, [WS(2)]: { enrolled: true, sub: { state: 'none' } },
      [WS(3)]: { enrolled: true, sub: { state: 'pending' } }, [WS(4)]: { enrolled: false }, [WS(5)]: { enrolled: true, sub: { state: 'active' } },
      [WS(6)]: { enrolled: true, sub: { state: 'past_due' } },
    };
    const env = makeDeps({ gate });
    for (let n = 1; n <= 6; n += 1) conn(env.Connection, n);
    const res = await sch.sweepConnections(env.deps, NOW);
    expect(env.sr.refreshConnection.mock.calls.map((c) => c[0]).sort()).toEqual([WS(5), WS(6)]);
    expect(res).toMatchObject({ refreshed: 2, deferred: 4 });
    for (const row of env.Connection.rows.filter((r) => [WS(1), WS(2), WS(3), WS(4)].includes(r.workspaceId))) {
      expect(new Date(row.nextCheckAt).getTime()).toBe(NOW + HOUR);
    }
    // the next tick (before the hour is over) does not look at the deferred rows again
    env.sr.refreshConnection.mockClear();
    env.state.getGateState.mockClear();
    await sch.sweepConnections(env.deps, NOW + 10 * MIN);
    expect(env.sr.refreshConnection.mock.calls.map((c) => c[0]).sort()).toEqual([WS(5), WS(6)]);
    expect(env.state.getGateState).toHaveBeenCalledTimes(2);
  });
  test('after a reactivation the deferred row is polled again within the hour', async () => {
    const gate = { [WS(1)]: { enrolled: true, sub: { state: 'cancelled' } } };
    const env = makeDeps({ gate });
    conn(env.Connection, 1);
    await sch.sweepConnections(env.deps, NOW);
    gate[WS(1)] = { enrolled: true, sub: { state: 'active' } };
    await sch.sweepConnections(env.deps, NOW + HOUR + MIN);
    expect(env.sr.refreshConnection).toHaveBeenCalledTimes(1);
  });
  test('a gate lookup error counts as "not eligible" (never polls on doubt)', async () => {
    const env = makeDeps({ state: { getGateState: jest.fn(async () => { throw new Error('db'); }) } });
    conn(env.Connection, 1);
    const res = await sch.sweepConnections(env.deps, NOW);
    expect(res.deferred).toBe(1);
    expect(env.sr.refreshConnection).not.toHaveBeenCalled();
  });
  test('a failing refresh is logged, the row is retried in 15 min, and the sweep continues with the next row', async () => {
    const env = makeDeps();
    env.sr.refreshConnection.mockImplementationOnce(async () => { throw Object.assign(new Error('graph exploded'), { code: 'X' }); });
    conn(env.Connection, 1, { nextCheckAt: new Date(NOW - 20 * MIN) });
    conn(env.Connection, 2, { nextCheckAt: new Date(NOW - 10 * MIN) });
    const res = await sch.sweepConnections(env.deps, NOW);
    expect(res).toMatchObject({ refreshed: 1, failed: 1 });
    expect(new Date(env.Connection.rows[0].nextCheckAt).getTime()).toBe(NOW + 15 * MIN);
    expect(env.deps.log).toHaveBeenCalledWith('refresh failed:', 'X', 'graph exploded');
  });
  test('at most 20 refreshes per tick, however many rows are due', async () => {
    const env = makeDeps();
    for (let n = 1; n <= 45; n += 1) conn(env.Connection, n);
    env.sr.refreshConnection.mockImplementation(async (ws) => { // like the real refresh: the schedule moves forward
      const row = env.Connection.rows.find((r) => r.workspaceId === ws); row.nextCheckAt = new Date(NOW + HOUR);
    });
    const res = await sch.sweepConnections(env.deps, NOW);
    expect(res.refreshed).toBe(20);
    expect(env.sr.refreshConnection).toHaveBeenCalledTimes(20);
    await sch.sweepConnections(env.deps, NOW);
    expect(env.sr.refreshConnection).toHaveBeenCalledTimes(40);
  });
  test('ineligible rows at the head of the queue never starve the eligible ones behind them', async () => {
    const gate = {};
    const env = makeDeps({ gate });
    for (let n = 1; n <= 30; n += 1) { gate[WS(n)] = { enrolled: true, sub: { state: 'cancelled' } }; conn(env.Connection, n); } // the 30 oldest rows
    conn(env.Connection, 99, { nextCheckAt: new Date(NOW - 1 * MIN) });
    await sch.sweepConnections(env.deps, NOW);
    expect(env.sr.refreshConnection.mock.calls.map((c) => c[0])).toContain(WS(99));
  });
  test('rows that never got a schedule are due too', async () => {
    const env = makeDeps();
    conn(env.Connection, 1, { nextCheckAt: undefined });
    const res = await sch.sweepConnections(env.deps, NOW);
    expect(res.refreshed).toBe(1);
  });
  test('the same row is never handled twice in one sweep, even when the refresh does not move its schedule', async () => {
    const env = makeDeps();
    for (let n = 1; n <= 5; n += 1) conn(env.Connection, n);
    await sch.sweepConnections(env.deps, NOW);
    expect(env.sr.refreshConnection).toHaveBeenCalledTimes(5);
  });
  test('the refresh is invoked with the workspace id as a string and throwOnFailure:false (no connection document is passed)', async () => {
    const env = makeDeps();
    conn(env.Connection, 1);
    await sch.sweepConnections(env.deps, NOW);
    expect(env.sr.refreshConnection).toHaveBeenCalledWith(WS(1), { throwOnFailure: false });
  });
});

describe('sweep 2: starter templates', () => {
  test('B1-e pollStatuses({ now }) is called ONCE per tick (it polls and submits the queue itself); submitQueued is not used', async () => {
    const env = makeDeps();
    conn(env.Connection, 1); conn(env.Connection, 2);
    const res = await sch.sweepTemplates(env.deps, NOW);
    expect(env.starterTemplates.pollStatuses).toHaveBeenCalledTimes(1);
    expect(env.starterTemplates.pollStatuses).toHaveBeenCalledWith({ now: new Date(NOW) });
    expect(env.starterTemplates.submitQueued).not.toHaveBeenCalled();
    expect(res).toEqual({ mode: 'poll', workspaces: 1, submitted: 2, polled: 2, failed: 0 });
    expect(env.Connection.calls).toHaveLength(0); // the global job needs no connection query here
  });
  test('the other export names of the poll are accepted too (pollPending, refreshStatuses)', async () => {
    for (const name of ['pollPending', 'refreshStatuses']) {
      const fn = jest.fn(async () => ({ workspaces: 3, checked: 4, errors: 1 }));
      const env = makeDeps({ starterTemplates: { [name]: fn } });
      expect(await sch.sweepTemplates(env.deps, NOW)).toEqual({ mode: 'poll', workspaces: 3, submitted: 0, polled: 4, failed: 1 });
      expect(fn).toHaveBeenCalledWith({ now: new Date(NOW) });
    }
  });
  test('a failing poll is logged and counted, never thrown; an empty answer is tolerated', async () => {
    const a = makeDeps({ starterTemplates: { pollStatuses: jest.fn(async () => { throw Object.assign(new Error('boom'), { code: 'X' }); }) } });
    expect(await sch.sweepTemplates(a.deps, NOW)).toMatchObject({ mode: 'poll', failed: 1 });
    expect(a.deps.log).toHaveBeenCalledWith('template poll failed:', 'X', 'boom');
    const b = makeDeps({ starterTemplates: { pollStatuses: jest.fn(async () => undefined) } });
    expect(await sch.sweepTemplates(b.deps, NOW)).toEqual({ mode: 'poll', workspaces: 0, submitted: 0, polled: 0, failed: 0 });
  });
  test('module unavailable -> an empty result, no query; neither export -> logged and skipped', async () => {
    const env = makeDeps({ starterTemplates: null });
    conn(env.Connection, 1);
    expect(await sch.sweepTemplates(env.deps, NOW)).toEqual({ mode: null, workspaces: 0, submitted: 0, polled: 0, failed: 0 });
    const none = makeDeps({ starterTemplates: {} });
    expect(await sch.sweepTemplates(none.deps, NOW)).toMatchObject({ mode: null });
    expect(none.deps.log).toHaveBeenCalledWith('starterTemplates.submitQueued missing: skipped');
  });

  describe('fallback without a poll export: submitQueued per connected workspace', () => {
    test('connected / needs_attention workspaces with an eligible subscription get submitQueued({workspaceId, max:5})', async () => {
      const gate = { [WS(3)]: { enrolled: true, sub: { state: 'cancelled' } } };
      const sq = jest.fn(async () => ({ submitted: 2 }));
      const env = makeDeps({ gate, starterTemplates: { submitQueued: sq } });
      conn(env.Connection, 1); conn(env.Connection, 2, { status: 'needs_attention' }); conn(env.Connection, 3);
      conn(env.Connection, 4, { status: 'waba_only' }); conn(env.Connection, 5, { needsReconnect: true }); conn(env.Connection, 6, { status: 'disconnected' });
      const res = await sch.sweepTemplates(env.deps, NOW);
      expect(sq.mock.calls.map((c) => c[0])).toEqual([{ workspaceId: WS(1), max: 5 }, { workspaceId: WS(2), max: 5 }]);
      expect(res).toEqual({ mode: 'per_workspace', workspaces: 2, submitted: 4, polled: 0, failed: 0 });
      expect(env.deps.log).toHaveBeenCalledWith(expect.stringContaining('status poll export missing'));
    });
    test('a failing workspace is logged and counted; the others continue', async () => {
      const sq = jest.fn(async () => ({ submitted: 1 }));
      sq.mockImplementationOnce(async () => { throw Object.assign(new Error('NOT_IMPLEMENTED'), { code: 'NOT_IMPLEMENTED' }); });
      const env = makeDeps({ starterTemplates: { submitQueued: sq } });
      conn(env.Connection, 1); conn(env.Connection, 2);
      const res = await sch.sweepTemplates(env.deps, NOW);
      expect(res).toMatchObject({ workspaces: 2, failed: 1, submitted: 1 });
      expect(env.deps.log).toHaveBeenCalledWith('template submit failed:', 'NOT_IMPLEMENTED', 'NOT_IMPLEMENTED');
    });
    test('an id cursor rotates through more workspaces than one tick handles (25 per tick), then wraps', async () => {
      const sq = jest.fn(async () => ({ submitted: 1 }));
      const env = makeDeps({ starterTemplates: { submitQueued: sq } });
      // ids are ISO strings here only because the in-memory store compares $gt on dates (real ObjectIds compare natively)
      for (let n = 1; n <= 30; n += 1) conn(env.Connection, n, { _id: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z` });
      const seen = () => sq.mock.calls.map((c) => c[0].workspaceId);
      await sch.sweepTemplates(env.deps, NOW);
      expect(seen()).toHaveLength(25);
      await sch.sweepTemplates(env.deps, NOW);
      expect(seen()).toHaveLength(30); // the remaining 5, cursor reset
      await sch.sweepTemplates(env.deps, NOW);
      expect(seen()).toHaveLength(55); // wrapped around: starts over
      expect(new Set(seen().slice(0, 30)).size).toBe(30);
    });
  });
});

describe('sweep 5: stuck "connecting" resumed once', () => {
  const stuck = (env, n, over = {}) => env.Connection.seed({
    workspaceId: WS(n), status: 'connecting', tokenEncrypted: 'v1:x', connectedByUserId: 'u1', connectAttempt: { id: `att${n}` }, updatedAt: new Date(NOW - 10 * MIN), ...over,
  });
  test('resumes a stuck attempt with the stored user once per attempt', async () => {
    const env = makeDeps();
    stuck(env, 1);
    const res = await sch.sweepResume(env.deps, NOW);
    expect(res).toEqual({ checked: 1, resumed: 1, failed: 0 });
    expect(env.connect.resumeConnect).toHaveBeenCalledWith({ workspaceId: WS(1), userId: 'u1', system: true });
    await sch.sweepResume(env.deps, NOW + 10 * MIN);
    expect(env.connect.resumeConnect).toHaveBeenCalledTimes(1); // once
    env.Connection.rows[0].connectAttempt = { id: 'att-new' };
    await sch.sweepResume(env.deps, NOW + 20 * MIN);
    expect(env.connect.resumeConnect).toHaveBeenCalledTimes(2); // a new attempt is a new chance
  });
  test('integration finding I1a: the age is the last connect activity (usedAt / lastError.at), not updatedAt, which the connections sweep bumps in the same tick', async () => {
    const env = makeDeps();
    // updatedAt is fresh (a reschedule write of sweep 1) but the attempt has been stuck for 10 minutes
    stuck(env, 1, { updatedAt: new Date(NOW - 1000), connectAttempt: { id: 'a1', usedAt: new Date(NOW - 10 * MIN) }, lastError: { code: 'CONNECT_PARTIAL', at: new Date(NOW - 9 * MIN) } });
    // a genuinely recent failure (30 s ago) is left alone even though updatedAt is old
    stuck(env, 2, { updatedAt: new Date(NOW - 10 * MIN), connectAttempt: { id: 'a2', usedAt: new Date(NOW - 10 * MIN) }, lastError: { code: 'CONNECT_PARTIAL', at: new Date(NOW - 30 * 1000) } });
    const res = await sch.sweepResume(env.deps, NOW);
    expect(res.resumed).toBe(1);
    expect(env.connect.resumeConnect).toHaveBeenCalledTimes(1);
    expect(env.connect.resumeConnect).toHaveBeenCalledWith({ workspaceId: WS(1), userId: 'u1', system: true });
  });
  test('leaves recent attempts (< 2 min), locked rows and rows without a token alone', async () => {
    const env = makeDeps();
    stuck(env, 1, { updatedAt: new Date(NOW - 30 * 1000) });
    stuck(env, 2, { connectLockUntil: new Date(NOW + MIN) });
    stuck(env, 3, { tokenEncrypted: undefined });
    stuck(env, 4, { status: 'connected' });
    const res = await sch.sweepResume(env.deps, NOW);
    expect(res.resumed).toBe(0);
    expect(env.connect.resumeConnect).not.toHaveBeenCalled();
  });
  test('a failing resume is logged and counted, and it is not retried either', async () => {
    const env = makeDeps();
    env.connect.resumeConnect.mockRejectedValue(Object.assign(new Error('CONNECT_PARTIAL'), { code: 'CONNECT_PARTIAL' }));
    stuck(env, 1, { connectedByUserId: undefined });
    expect(await sch.sweepResume(env.deps, NOW)).toMatchObject({ failed: 1, resumed: 0 });
    expect(env.connect.resumeConnect).toHaveBeenCalledWith({ workspaceId: WS(1), userId: null, system: true });
    await sch.sweepResume(env.deps, NOW + 10 * MIN);
    expect(env.connect.resumeConnect).toHaveBeenCalledTimes(1);
    expect(env.deps.log).toHaveBeenCalledWith('resume failed:', 'CONNECT_PARTIAL', 'CONNECT_PARTIAL');
  });
  test('stopOnboardingScheduler forgets what was resumed (a fresh start begins afresh)', async () => {
    const env = makeDeps();
    stuck(env, 1);
    await sch.sweepResume(env.deps, NOW);
    stopOnboardingScheduler(() => {});
    await sch.sweepResume(env.deps, NOW);
    expect(env.connect.resumeConnect).toHaveBeenCalledTimes(2);
  });
});

describe('tick', () => {
  test('sweeps only when the lock is won', async () => {
    const won = makeDeps();
    await tick(won.deps, 600000);
    expect(won.billing.reconcileSweep).toHaveBeenCalledTimes(1);
    const lost = makeDeps({ lock: makeLock({ createError: Object.assign(new Error('dup'), { code: 11000 }) }) });
    await tick(lost.deps, 600000);
    expect(lost.billing.reconcileSweep).not.toHaveBeenCalled();
  });
  test('lock errors are caught, never rejected', async () => {
    const { deps } = makeDeps({ lock: makeLock({ createError: Object.assign(new Error('db gone'), { code: 5 }) }) });
    await expect(tick(deps, 600000)).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('tick error:', 'db gone');
  });
});

describe('startOnboardingScheduler', () => {
  let saved;
  beforeEach(() => { saved = process.env.ONBOARDING_SCHEDULER_INTERVAL_MS; delete process.env.ONBOARDING_SCHEDULER_INTERVAL_MS; });
  afterEach(() => { if (saved === undefined) delete process.env.ONBOARDING_SCHEDULER_INTERVAL_MS; else process.env.ONBOARDING_SCHEDULER_INTERVAL_MS = saved; });

  test('flag off: returns null, starts no timer and touches nothing (the E4 hunk is inert)', () => {
    const env = makeDeps({ enabled: () => false });
    const setIntervalFn = jest.fn();
    expect(startOnboardingScheduler({ deps: env.deps, setIntervalFn })).toBeNull();
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(env.lock.findOneAndUpdate).not.toHaveBeenCalled();
    expect(env.lock.create).not.toHaveBeenCalled();
  });
  test('called with no argument and the flag unset (as the server hunk does): null, no timer', () => {
    const saved2 = process.env.ONBOARDING_FLOW;
    delete process.env.ONBOARDING_FLOW;
    try {
      expect(startOnboardingScheduler()).toBeNull();
    } finally { if (saved2 !== undefined) process.env.ONBOARDING_FLOW = saved2; }
  });
  test('is idempotent, unref()s the timer and uses the 10 minute default', () => {
    const { deps } = makeDeps();
    const handle = { unref: jest.fn() };
    const setIntervalFn = jest.fn(() => handle);
    expect(sch.DEFAULT_INTERVAL_MS).toBe(600000);
    expect(startOnboardingScheduler({ deps, setIntervalFn })).toBe(handle);
    expect(startOnboardingScheduler({ deps, setIntervalFn })).toBe(handle);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn.mock.calls[0][1]).toBe(600000);
    expect(handle.unref).toHaveBeenCalledTimes(1);
  });
  test('honours an explicit intervalMs and the env interval, ignores junk values', () => {
    const { deps } = makeDeps();
    const setIntervalFn = jest.fn(() => ({ unref() {} }));
    startOnboardingScheduler({ intervalMs: 120000, deps, setIntervalFn });
    expect(setIntervalFn.mock.calls[0][1]).toBe(120000);
    stopOnboardingScheduler(() => {});
    startOnboardingScheduler({ intervalMs: 5, deps, setIntervalFn });
    expect(setIntervalFn.mock.calls[1][1]).toBe(600000);
    stopOnboardingScheduler(() => {});
    process.env.ONBOARDING_SCHEDULER_INTERVAL_MS = '90000';
    startOnboardingScheduler({ deps, setIntervalFn });
    expect(setIntervalFn.mock.calls[2][1]).toBe(90000);
  });
  test('accepts a deps object directly (INTERFACES: startOnboardingScheduler(deps?))', () => {
    const { deps } = makeDeps();
    const handle = { unref() {} };
    const timerSpy = jest.spyOn(global, 'setInterval').mockReturnValue(handle);
    try {
      expect(startOnboardingScheduler(deps)).toBe(handle);
    } finally { timerSpy.mockRestore(); }
  });
  test('the first tick runs immediately and the interval callback ticks again (lock-guarded)', async () => {
    const { deps, billing } = makeDeps();
    let cb;
    startOnboardingScheduler({ deps, setIntervalFn: (fn) => { cb = fn; return { unref() {} }; } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(billing.reconcileSweep).toHaveBeenCalledTimes(1);
    cb();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(billing.reconcileSweep).toHaveBeenCalledTimes(2);
  });
  test('stopOnboardingScheduler clears the timer so a later start begins afresh', () => {
    const { deps } = makeDeps();
    const handle = { unref() {} };
    const setIntervalFn = jest.fn(() => handle);
    startOnboardingScheduler({ deps, setIntervalFn });
    const clearFn = jest.fn();
    stopOnboardingScheduler(clearFn);
    expect(clearFn).toHaveBeenCalledWith(handle);
    startOnboardingScheduler({ deps, setIntervalFn });
    expect(setIntervalFn).toHaveBeenCalledTimes(2);
  });
});

describe('nothing happens at require time', () => {
  test('requiring the scheduler registers no model, starts no timer and reads no env', () => {
    jest.isolateModules(() => {
      const mongoose = require('mongoose');
      const modelSpy = jest.spyOn(mongoose, 'model');
      const timerSpy = jest.spyOn(global, 'setInterval');
      const mod = require('../../../shared/onboarding/scheduler');
      expect(typeof mod.startOnboardingScheduler).toBe('function');
      expect(modelSpy).not.toHaveBeenCalled();
      expect(timerSpy).not.toHaveBeenCalled();
      modelSpy.mockRestore(); timerSpy.mockRestore();
    });
  });
});
