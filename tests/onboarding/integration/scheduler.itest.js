'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_b1d_sch`; // this suite gets its OWN database
assertThrowawayDb();

// Real throwaway mongod: the real SchedulerLock model (lock behaviour), the real due-row query with its
// single-field sort, the real gate state (OnboardingState) that decides who is polled, and the real
// statusRefresh against fakeGraph. Modules owned by other engineers are injected fakes.
const mongoose = require('mongoose');
const { createFakeGraph } = require('../_fixtures');
const { rawGraphClient } = require('../unit/_b1dHelpers');
const sch = require('../../../shared/onboarding/scheduler');
const sr = require('../../../shared/onboarding/statusRefresh');
const stateMod = require('../../../shared/onboarding/state');
const vault = require('../../../shared/onboarding/tokenVault');
const { createNotifications } = require('../../../shared/onboarding/notifications');
const Conn = require('../../../models/WhatsAppConnection');
const OnbState = require('../../../models/OnboardingState');
const SchedulerLock = require('../../../models/SchedulerLock');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const oid = () => String(new mongoose.Types.ObjectId());

beforeAll(async () => {
  process.env.WA_TOKEN_ENCRYPTION_KEY = 'ef'.repeat(32);
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([Conn.init(), OnbState.init(), require('../../../models/OnboardingNotification').init(), require('../../../models/OnboardingEvent').init()]);
});
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(() => { stateMod.clearCache(); });

const g = createFakeGraph();
const emailSend = jest.fn(async () => ({ sent: true }));
const refreshDeps = { meta: rawGraphClient(g), notifications: createNotifications({ email: { sendNotificationEmail: emailSend } }), appId: g.ids.appId, paymentProbe: () => false, log: () => {} };

async function enrol(subState) {
  const ws = oid();
  if (subState) await OnbState.create({ workspaceId: ws, enrolled: true, subscription: { state: subState, source: 'admin' } });
  return ws;
}
async function connection(ws, over = {}) {
  return Conn.create({
    workspaceId: ws, status: 'connected', ids: { wabaId: g.ids.wabaId, phoneNumberId: g.ids.phoneId },
    tokenEncrypted: vault.encrypt(g.ids.merchantToken, { workspaceId: ws, purpose: 'token' }),
    webhook: { subscribed: true }, verification: { businessRaw: 'verified', mapped: 'done' }, displayName: { nameStatusRaw: 'APPROVED', mapped: 'done' },
    messagingLimit: { raw: 'TIER_250', tierNumber: 250 }, health: { canSend: 'AVAILABLE', issues: [] },
    nextCheckAt: new Date(Date.now() - 5 * MIN), ...over,
  });
}
const nextOf = async (ws) => new Date((await Conn.findOne({ workspaceId: ws }).lean()).nextCheckAt).getTime();

function makeDeps(over = {}) {
  const calls = [];
  const fake = (name, fn) => () => ({ [name]: jest.fn(async (...a) => { calls.push(name); return fn ? fn(...a) : {}; }) });
  const refreshed = [];
  return {
    calls, refreshed,
    deps: {
      SchedulerLock: () => SchedulerLock,
      Connection: () => Conn,
      state: () => stateMod,
      statusRefresh: () => ({ refreshConnection: async (ws, extra) => { refreshed.push(String(ws)); return sr.refreshConnection(ws, { ...refreshDeps, ...extra }); } }),
      starterTemplates: fake('submitQueued', async () => ({ submitted: 0 })),
      reminders: fake('runPathBReminders', async () => ({ sent: 0 })),
      notifications: fake('retryEmails', async () => ({ attempted: 0, sent: 0 })),
      connect: fake('resumeConnect', async () => ({})),
      billing: fake('reconcileSweep', async () => ({ checked: 0, changed: 0 })),
      approvals: () => require('../../../shared/onboarding/approvals'),
      enabled: () => true,
      log: jest.fn(),
      now: () => Date.now(),
      stepTimeoutMs: 20000,
      ...over,
    },
  };
}

describe('the lock (existing SchedulerLock model, fixed _id)', () => {
  test('one winner at a time; the lock expires after interval - 30 s; the document is the only one written', async () => {
    let t = Date.now();
    const { deps } = makeDeps({ now: () => t });
    expect(await sch.acquireLock(deps, 10 * MIN)).toBe(true);
    expect(await sch.acquireLock(deps, 10 * MIN)).toBe(false);
    const doc = await SchedulerLock.findById('onboardingScheduler').lean();
    expect(doc).toBeTruthy();
    expect(new Date(doc.lockedUntil).getTime()).toBe(t + 10 * MIN - 30 * 1000);
    t += 9 * MIN;
    expect(await sch.acquireLock(deps, 10 * MIN)).toBe(false);
    t += 61 * 1000;
    expect(await sch.acquireLock(deps, 10 * MIN)).toBe(true);
    expect(await SchedulerLock.countDocuments({ _id: 'onboardingScheduler' })).toBe(1);
  });
  test('two ticks racing for the lock run ONE sweep', async () => {
    await SchedulerLock.updateOne({ _id: 'onboardingScheduler' }, { $set: { lockedUntil: new Date(0) } });
    const { deps, calls } = makeDeps();
    await Promise.all([sch.tick(deps, 10 * MIN), sch.tick(deps, 10 * MIN)]);
    expect(calls.filter((c) => c === 'reconcileSweep')).toHaveLength(1);
  });
});

describe('sweep 1 with real rows, the real gate state and the real refresh', () => {
  test('active and past_due are refreshed; cancelled / none / pending / not-enrolled are deferred 1 h and not polled; a row due later is untouched', async () => {
    const [active, pastDue, cancelled, none, pending, legacy] = await Promise.all(['active', 'past_due', 'cancelled', 'none', 'pending', null].map(enrol));
    for (const ws of [active, pastDue, cancelled, none, pending, legacy]) await connection(ws);
    const later = await enrol('active');
    const laterAt = new Date(Date.now() + 30 * MIN);
    await connection(later, { nextCheckAt: laterAt });
    const { deps, refreshed } = makeDeps();
    const t0 = Date.now();
    const res = await sch.sweepConnections(deps, t0);
    const mine = [active, pastDue, cancelled, none, pending, legacy, later];
    expect(refreshed.filter((w) => mine.includes(w)).sort()).toEqual([active, pastDue].sort());
    expect(res.failed).toBe(0);
    for (const ws of [cancelled, none, pending, legacy]) {
      const n = await nextOf(ws);
      expect(n).toBeGreaterThanOrEqual(t0 + HOUR);
      expect(n).toBeLessThan(t0 + HOUR + 5000);
      expect((await Conn.findOne({ workspaceId: ws }).lean()).lastStatusCheckAt).toBeUndefined(); // never refreshed
    }
    expect(await nextOf(later)).toBe(laterAt.getTime());
    for (const ws of [active, pastDue]) {
      const r = await Conn.findOne({ workspaceId: ws }).lean();
      expect(r.lastStatusCheckAt).toBeInstanceOf(Date);
      expect(new Date(r.nextCheckAt).getTime()).toBeGreaterThan(t0); // the schedule moved forward
    }
  });

  test('at most 20 refreshes per tick; the rest is picked up by the next tick; oldest first', async () => {
    const ws = [];
    for (let i = 0; i < 25; i += 1) { const w = await enrol('active'); ws.push(w); await connection(w, { nextCheckAt: new Date(Date.now() - (60 - i) * HOUR) }); }
    const { deps, refreshed } = makeDeps();
    await sch.sweepConnections(deps, Date.now());
    const first = refreshed.filter((w) => ws.includes(w));
    expect(first).toHaveLength(20);
    expect(first).toEqual(ws.slice(0, 20)); // single-field sort on nextCheckAt: the oldest 20, in order
    await sch.sweepConnections(deps, Date.now());
    expect(refreshed.filter((w) => ws.includes(w)).sort()).toEqual([...ws].sort());
  });

  test('reconnect_required / disconnected rows are never selected', async () => {
    const a = await enrol('active'); const b = await enrol('active');
    await connection(a, { status: 'reconnect_required', needsReconnect: true });
    await connection(b, { status: 'disconnected' });
    const { deps, refreshed } = makeDeps();
    await sch.sweepConnections(deps, Date.now());
    expect(refreshed).not.toContain(a);
    expect(refreshed).not.toContain(b);
  });

  test('a row flagged needsReconnect but still "connected" is pushed 6 h out by the refresh (no hot loop)', async () => {
    const ws = await enrol('active');
    await connection(ws, { needsReconnect: true });
    const { deps, refreshed } = makeDeps();
    const t0 = Date.now();
    await sch.sweepConnections(deps, t0);
    expect(refreshed).toContain(ws);
    expect(g.callsTo('getWaba')).toBeDefined();
    expect(await nextOf(ws)).toBeGreaterThanOrEqual(t0 + 6 * HOUR - 5000);
  });

  test('rows with no schedule at all are picked up', async () => {
    const ws = await enrol('active');
    await connection(ws, { nextCheckAt: undefined });
    const { deps, refreshed } = makeDeps();
    await sch.sweepConnections(deps, Date.now());
    expect(refreshed).toContain(ws);
    expect(await nextOf(ws)).toBeGreaterThan(Date.now());
  });
});

describe('sweep 5 (resume) and sweep 2 (templates) with real rows', () => {
  test('a stuck connecting attempt with a stored token is resumed once; recent / token-less rows are left alone', async () => {
    const stuck = await enrol('active'); const fresh = await enrol('active'); const noToken = await enrol('active');
    const mk = (ws, over) => connection(ws, { status: 'connecting', connectAttempt: { id: `att-${ws.slice(-6)}` }, connectedByUserId: 'u1', ...over });
    await mk(stuck, {}); await mk(fresh, {}); await mk(noToken, { tokenEncrypted: undefined });
    await Conn.collection.updateOne({ workspaceId: new mongoose.Types.ObjectId(stuck) }, { $set: { updatedAt: new Date(Date.now() - 10 * MIN) } });
    await Conn.collection.updateOne({ workspaceId: new mongoose.Types.ObjectId(noToken) }, { $set: { updatedAt: new Date(Date.now() - 10 * MIN) } });
    let resumeCalls = [];
    const { deps } = makeDeps({ connect: () => ({ resumeConnect: async (a) => { resumeCalls.push(a); return {}; } }) });
    await sch.sweepResume(deps, Date.now());
    const mine = resumeCalls.filter((c) => [stuck, fresh, noToken].includes(c.workspaceId));
    expect(mine).toEqual([{ workspaceId: stuck, userId: 'u1', system: true }]);
    resumeCalls = [];
    await sch.sweepResume(deps, Date.now());
    expect(resumeCalls.filter((c) => c.workspaceId === stuck)).toHaveLength(0); // once
  });

  test('the template sweep walks the connected workspaces by _id with a cursor and skips ineligible subscriptions', async () => {
    const ok = []; const cancelled = [];
    for (let i = 0; i < 12; i += 1) { const w = await enrol(i % 4 === 0 ? 'cancelled' : 'active'); (i % 4 === 0 ? cancelled : ok).push(w); await connection(w); }
    const seen = new Set();
    const { deps } = makeDeps({ starterTemplates: () => ({ submitQueued: async ({ workspaceId, max }) => { expect(max).toBe(5); seen.add(workspaceId); return { submitted: 1 }; } }) });
    for (let i = 0; i < 20 && ok.some((w) => !seen.has(w)); i += 1) await sch.sweepTemplates(deps, Date.now());
    expect(ok.every((w) => seen.has(w))).toBe(true);
    expect(cancelled.some((w) => seen.has(w))).toBe(false);
  });
});

describe('the whole sweep', () => {
  test('flag off: nothing runs and nothing is read', async () => {
    const { deps, calls, refreshed } = makeDeps({ enabled: () => false });
    const res = await sch.runOnboardingSweep(deps);
    expect(res.skipped).toBe(true);
    expect(calls).toEqual([]);
    expect(refreshed).toEqual([]);
  });
  test('a sweep writes only to the onboarding collections and the lock', async () => {
    const ws = await enrol('active');
    await connection(ws);
    const { deps } = makeDeps();
    await sch.runOnboardingSweep(deps);
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    const allowed = /^(whatsappconnections|onboarding[a-z]*|schedulerlocks|whatsappclaims|system\..*)$/;
    expect(names.filter((n) => !allowed.test(n))).toEqual([]);
  });
});
