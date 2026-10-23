'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database so suites in one jest run never see each other's workspaces
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_sched`;
assertThrowawayDb();

// SCHEDULER WIRING (task I1a): the onboarding scheduler's seven sweeps run with the REAL owner modules (statusRefresh,
// starterTemplates, reminders, notifications, connect, billing, approvals, state) over seeded sandbox data on the
// throwaway mongod. The only fakes are the external ports: fakeGraph (Meta), fakeStripe, fakeResend (e-mail). They are
// injected through thin wrappers around the module thunks of scheduler.realDeps(), exactly the way production uses them
// without the wrappers (real Graph client / real Stripe / real Resend). No real network (the proxy is dead on purpose).
const mongoose = require('mongoose');
const H = require('./_connectHarness');
const { enrolledTenant, fullWorld, connectedTenant, flat, nextCode } = require('./_crossHarness');
const { createFakeStripe, makeSubscription, createFakeSend, fixedClock } = require('../_fixtures');
const scheduler = require('../../../shared/onboarding/scheduler');
const state = require('../../../shared/onboarding/state');
const statusRefresh = require('../../../shared/onboarding/statusRefresh');
const starterTemplates = require('../../../shared/onboarding/starterTemplates');
const reminders = require('../../../shared/onboarding/reminders');
const notifications = require('../../../shared/onboarding/notifications');
const connectMod = require('../../../shared/onboarding/connect');
const billing = require('../../../shared/onboarding/billing');
const approvals = require('../../../shared/onboarding/approvals');
const vault = require('../../../shared/onboarding/tokenVault');
const SchedulerLock = require('../../../models/SchedulerLock');
const OnboardingTemplate = require('../../../models/OnboardingTemplate');
const OnboardingNotification = require('../../../models/OnboardingNotification');

const { WhatsAppConnection, OnboardingState, WhatsAppClaim, Membership } = H.models;
jest.setTimeout(120000);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
let restoreEnv;
const connRow = (ws) => WhatsAppConnection.findOne({ workspaceId: ws }).select('+tokenEncrypted +pinEncrypted').lean();
const stateRow = (ws) => OnboardingState.findOne({ workspaceId: ws }).lean();

beforeAll(async () => {
  restoreEnv = H.setEnv();
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([OnboardingState.init(), WhatsAppConnection.init(), WhatsAppClaim.init(), Membership.init(), OnboardingTemplate.init(), OnboardingNotification.init()]);
});
afterAll(async () => { restoreEnv(); scheduler.stopOnboardingScheduler(); await mongoose.disconnect(); });
beforeEach(() => { state.clearCache(); });

/**
 * Scheduler deps over the REAL modules with the external ports injected.
 * @param {object} w a fullWorld (graph + meta)
 * @param {{stripe?:object, mail?:object, nowMs?:number}} [opts]
 */
function schedulerDeps(w, opts = {}) {
  const mail = opts.mail || createFakeSend();
  const stripe = opts.stripe || createFakeStripe({ clock: fixedClock() });
  const clock = { t: opts.nowMs || Date.now() };
  const logs = [];
  const mailDeps = { send: mail.send, resolveRecipient: async () => ({ to: 'owner@shop.example.test', language: 'en' }) };
  const notif = notifications.createNotifications({ emailDeps: mailDeps });
  const connectDeps = { ...w.connectDeps };
  const refreshDeps = w.refreshDeps;
  const real = scheduler.realDeps();
  const calls = { statusRefresh: 0, starterTemplates: 0, reminders: 0, notifications: 0, connect: 0, billing: 0, approvals: 0 };
  const deps = {
    ...real,
    now: () => clock.t,
    log: (...a) => logs.push(a.map(String).join(' ')),
    stepTimeoutMs: 60000,
    statusRefresh: () => { calls.statusRefresh += 1; return { ...statusRefresh, refreshConnection: (id, d) => statusRefresh.refreshConnection(id, { ...(d || {}), ...refreshDeps }) }; },
    starterTemplates: () => { calls.starterTemplates += 1; return { ...starterTemplates, pollStatuses: (o) => starterTemplates.pollStatuses(o, { metaClient: w.meta }) }; },
    reminders: () => { calls.reminders += 1; return { runPathBReminders: (o) => reminders.runPathBReminders(o, { notify: notif.notify }) }; },
    notifications: () => { calls.notifications += 1; return notif; },
    connect: () => { calls.connect += 1; return { resumeConnect: (a) => connectMod.resumeConnect(a, connectDeps) }; },
    billing: () => { calls.billing += 1; return { reconcileSweep: (o) => billing.reconcileSweep(o, { stripe }) }; },
    approvals: () => { calls.approvals += 1; return { reRegisterDueNames: (o) => approvals.reRegisterDueNames(o, { meta: w.meta }) }; },
  };
  return { deps, mail, stripe, clock, logs, notif, calls };
}

/** A tenant that is only ENROLLED (no activation) for the Stripe reconcile sweep. */
async function enrolledOnly(name) {
  await H.makeTenant('Sched oldest guard');
  const ws = await H.makeWorkspace(name);
  await state.enrol({ workspaceId: ws, by: 'cli:test' }, H.noTrack);
  return ws;
}

describe('sweep 1: connections due for a refresh', () => {
  test('a connected row that is due is refreshed through the real statusRefresh + metaClient; an ineligible subscription is deferred one hour without a Graph call', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'SchedConn');
    await t.complete();
    const idle = await connectedTenant(fullWorld(), 'SchedIdle'); // never connected: not part of the sweep
    expect(idle.ws).toBeTruthy();
    // a second merchant whose subscription went away: deferred, not polled
    const w2 = fullWorld();
    const t2 = await connectedTenant(w2, 'SchedDeferred');
    await t2.complete();
    await state.adminDeactivate({ workspaceId: t2.ws, by: 'cli:test', notes: 'sched test' }, H.noTrack);
    const past = new Date(Date.now() - 5 * MIN);
    await WhatsAppConnection.updateOne({ workspaceId: t.ws }, { $set: { nextCheckAt: past, lastStatusCheckAt: new Date(Date.now() - DAY) } });
    await WhatsAppConnection.updateOne({ workspaceId: t2.ws }, { $set: { nextCheckAt: past } });
    w.graph.reset();
    w2.graph.reset();
    const sd = schedulerDeps(w);
    const res = await scheduler.runOnboardingSweep(sd.deps);
    expect(res.skipped).toBe(false);
    expect(res.connections).toMatchObject({ failed: 0 });
    expect(res.connections.refreshed).toBeGreaterThanOrEqual(1);
    expect(res.connections.deferred).toBeGreaterThanOrEqual(1);
    const names = w.graph.calls.map((c) => c.name);
    for (const n of ['debugToken', 'getWaba', 'getPhone', 'listSubscribed']) expect(names).toContain(n);
    w.graph.assertMerchantTokenOnly(w.graph.ids.merchantToken);
    const row = await connRow(t.ws);
    expect(new Date(row.lastStatusCheckAt).getTime()).toBeGreaterThan(Date.now() - MIN);
    expect(new Date(row.nextCheckAt).getTime()).toBeGreaterThan(Date.now() + 10 * MIN);
    expect(row.status).toBe('connected');
    expect(row.checkFailures).toBe(0);
    // the deferred merchant: no Graph call at all, the next check is pushed an hour out
    expect(w2.graph.calls).toHaveLength(0);
    expect(new Date((await connRow(t2.ws)).nextCheckAt).getTime()).toBeGreaterThan(Date.now() + 55 * MIN);
    expect(sd.logs.filter((l) => /failed|unavailable/.test(l))).toEqual([]);
  });
});

describe('sweep 2: starter template submission and status poll (starterTemplates.pollStatuses)', () => {
  test('queued rows are submitted (<= 5 per tick), later statuses are polled and applied, approvals row 5 follows', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'SchedTemplates');
    await t.complete(); // connect.js seeds the starter set AND hands the first 5 to Meta at once (the immediate submission), 3 stay queued
    expect(await OnboardingTemplate.countDocuments({ workspaceId: t.ws, metaTemplateId: { $ne: null } })).toBe(5);
    const sd = schedulerDeps(w);
    const first = await scheduler.runOnboardingSweep(sd.deps);
    expect(first.templates).toMatchObject({ mode: 'poll' });
    expect(first.templates.submitted).toBeGreaterThanOrEqual(1); // the tick submits what is still queued
    expect(first.templates.submitted).toBeLessThanOrEqual(5 * 3 + 5); // bounded per tick (other test tenants share the database)
    const submittedFirst = await OnboardingTemplate.countDocuments({ workspaceId: t.ws, metaTemplateId: { $ne: null } });
    expect(submittedFirst).toBe(8); // 5 from the connect + the 3 the tick found in the queue: every English template exactly once
    const created = w.graph.callsTo('createTemplate').filter((c) => c.status === 200).map((c) => c.data.name);
    expect(new Set(created).size).toBe(created.length);
    expect(created.length).toBeGreaterThanOrEqual(submittedFirst);
    w.graph.assertMerchantTokenOnly(w.graph.ids.merchantToken);
    // Meta approves everything; two hours later the poll reads the statuses and the rest of the queue goes out
    w.graph.approveAllTemplates();
    sd.clock.t += 2 * HOUR;
    const second = await scheduler.runOnboardingSweep(sd.deps);
    expect(second.templates.polled).toBeGreaterThanOrEqual(1);
    const rows = await OnboardingTemplate.find({ workspaceId: t.ws, source: 'library', language: 'en' }).lean();
    expect(rows.filter((r) => r.metaStatus === 'APPROVED').length).toBeGreaterThanOrEqual(1);
    expect(await OnboardingNotification.countDocuments({ workspaceId: t.ws, kind: 'template_approved' })).toBeGreaterThanOrEqual(1);
    const view = await approvals.buildApprovals(t.ws);
    const tpl = view.rows.find((r) => r.key === 'templates');
    expect(tpl.counts.approved).toBeGreaterThanOrEqual(1);
    expect(tpl.counts.total).toBe(7);
  });
});

describe('sweeps 3 and 4: Path B reminders and e-mail retries', () => {
  test('a number-less merchant paused for two days gets reminder 1 (in-app + mail) exactly once; the next one waits for the schedule', async () => {
    const w = fullWorld();
    const t = await enrolledTenant('SchedPathB');
    await w.put(t, '/business', { name: 'Path B Shop', country: 'SA', industry: 'grocery' });
    expect((await w.post(t, '/number/path', { hasNumber: false })).body.path).toBe('B');
    expect((await stateRow(t.ws)).progress.status).toBe('paused_number');
    await OnboardingState.updateOne({ workspaceId: t.ws }, { $set: { 'number.pausedAt': new Date(Date.now() - 2 * DAY) } });
    const sd = schedulerDeps(w);
    const res = await scheduler.runOnboardingSweep(sd.deps);
    expect(res.pathB.sent).toBeGreaterThanOrEqual(1);
    const note = await OnboardingNotification.findOne({ workspaceId: t.ws, kind: 'pathb_reminder' }).lean();
    expect(note.dedupeKey).toBe('pathb_reminder:1');
    expect(note.emailSentAt).toBeTruthy();
    expect(sd.mail.sent.length).toBeGreaterThanOrEqual(1);
    expect((await stateRow(t.ws)).number.reminderCount).toBe(1);
    // an immediate second sweep sends nothing more for this merchant; reminder 2 is due 3 days after the pause
    await scheduler.runOnboardingSweep(sd.deps);
    expect(await OnboardingNotification.countDocuments({ workspaceId: t.ws, kind: 'pathb_reminder' })).toBe(1);
    sd.clock.t += 2 * DAY;
    await scheduler.runOnboardingSweep(sd.deps);
    expect(await OnboardingNotification.countDocuments({ workspaceId: t.ws, kind: 'pathb_reminder' })).toBe(2);
    // numberReady stops them
    await w.post(t, '/number/ready');
    sd.clock.t += 10 * DAY;
    await scheduler.runOnboardingSweep(sd.deps);
    expect(await OnboardingNotification.countDocuments({ workspaceId: t.ws, kind: 'pathb_reminder' })).toBe(2);
  });

  test('a notification mail that failed is retried by the sweep (notifications.retryEmails) and delivered once', async () => {
    const w = fullWorld();
    const t = await enrolledTenant('SchedRetry');
    const mail = createFakeSend({ failFirst: 1, failWith: { statusCode: 503 } });
    const sd = schedulerDeps(w, { mail });
    const r = await sd.notif.notify({ workspaceId: t.ws, kind: 'reconnect_needed', dedupeKey: 'sched:retry:1', params: { reason: 'TOKEN_REVOKED' }, email: true, severity: 'action', actionPath: '/setup/connect' });
    await r.emailPromise;
    expect((await OnboardingNotification.findOne({ workspaceId: t.ws, dedupeKey: 'sched:retry:1' }).lean()).emailSentAt).toBeFalsy();
    const res = await scheduler.runOnboardingSweep(sd.deps);
    expect(res.emails.attempted).toBeGreaterThanOrEqual(1);
    expect(res.emails.sent).toBeGreaterThanOrEqual(1);
    const row = await OnboardingNotification.findOne({ workspaceId: t.ws, dedupeKey: 'sched:retry:1' }).lean();
    expect(row.emailSentAt).toBeTruthy();
    expect(mail.sent).toHaveLength(1);
    await scheduler.runOnboardingSweep(sd.deps);
    expect(mail.sent).toHaveLength(1); // delivered once
  });
});

describe('sweep 5: a stuck "connecting" attempt is resumed once', () => {
  test('a run that stopped at a transient failure is resumed from the stored token by the sweep (no second code exchange)', async () => {
    const w = fullWorld({ graphOptions: { phoneStatus: 'PENDING' } });
    w.graph.scenarios.networkDrop({ code: 'ETIMEDOUT', match: 'subscribe' });
    const t = await connectedTenant(w, 'SchedResume');
    const failed = await t.complete();
    expect(failed.body.code).toBe('CONNECT_PARTIAL');
    expect((await connRow(t.ws)).status).toBe('connecting');
    // stuck for a while: backdate the last connect activity past the 2 minute threshold (raw write: no timestamp bump). NOT
    // updatedAt: sweep 1 of the same tick reschedules a connecting row and that write bumps updatedAt (found by this test)
    const old = new Date(Date.now() - 10 * MIN);
    await WhatsAppConnection.collection.updateOne({ workspaceId: new mongoose.Types.ObjectId(t.ws) }, { $set: { 'connectAttempt.usedAt': old, 'lastError.at': old, connectLockUntil: null } });
    const exchangesBefore = w.graph.callsTo('exchange').length;
    const sd = schedulerDeps(w);
    const res = await scheduler.runOnboardingSweep(sd.deps);
    expect(res.resume.resumed).toBeGreaterThanOrEqual(1);
    expect(w.graph.callsTo('exchange')).toHaveLength(exchangesBefore); // the single-use code is never exchanged again
    const row = await connRow(t.ws);
    expect(row.status).toBe('connected');
    expect((await stateRow(t.ws)).steps.connect.status).toBe('done');
    expect((await state.getGateState(t.ws)).connectDone).toBe(true);
    // once per attempt per process: a second sweep does not touch a healthy connection again through resume
    const again = await scheduler.runOnboardingSweep(sd.deps);
    expect(again.resume.resumed).toBe(0);
  });

  test('a connection that finished without a number (waba_only) is handed over by the connection refresh once the number exists', async () => {
    const w = fullWorld({ graphOptions: { phoneStatus: 'PENDING' } });
    w.graph.scenarios.finishOnlyWaba();
    const t = await connectedTenant(w, 'SchedWabaOnly', 'FINISH_ONLY_WABA');
    expect((await t.complete()).body.status).toBe('waba_only');
    w.graph.addPhone(); // the merchant added the number in Meta in the meantime
    await WhatsAppConnection.updateOne({ workspaceId: t.ws }, { $set: { nextCheckAt: new Date(Date.now() - MIN) } });
    const sd = schedulerDeps(w);
    const res = await scheduler.runOnboardingSweep(sd.deps);
    expect(res.connections.failed).toBe(0);
    const row = await connRow(t.ws);
    expect(row.status).toBe('connected');
    expect(row.ids.phoneNumberId).toBe(w.graph.ids.phoneId);
    expect((await stateRow(t.ws)).steps.connect.status).toBe('done');
    expect((await connRow(t.ws)).connectSteps.register.status).toBe('done');
  });
});

describe('sweep 6: Stripe reconcile (billing.reconcileSweep)', () => {
  test('a pending workspace whose subscription Stripe now reports as active is activated, and the gate cache follows', async () => {
    const ws = await enrolledOnly('SchedStripe');
    const stripe = createFakeStripe({ clock: fixedClock() });
    stripe.setSubscription(makeSubscription({ id: 'sub_sched_1', status: 'active' }));
    await OnboardingState.updateOne({ workspaceId: ws }, { $set: {
      'subscription.state': 'pending', 'subscription.source': 'stripe',
      'subscription.stripe.subscriptionId': 'sub_sched_1', 'subscription.stripe.status': 'incomplete',
      'subscription.stripe.lastSyncedAt': new Date(Date.now() - 2 * HOUR),
    } });
    state.invalidate(ws);
    expect((await state.getGateState(ws)).sub.state).toBe('pending');
    const sd = schedulerDeps(fullWorld(), { stripe });
    const res = await scheduler.runOnboardingSweep(sd.deps);
    expect(res.billing.checked).toBeGreaterThanOrEqual(1);
    expect(res.billing.changed).toBeGreaterThanOrEqual(1);
    expect(stripe.callsTo('subscriptions.retrieve').map((c) => c.args.id)).toContain('sub_sched_1');
    const row = await stateRow(ws);
    expect(row.subscription).toMatchObject({ state: 'active', source: 'stripe' });
    expect((await state.getGateState(ws)).sub.state).toBe('active');
  });
});

describe('sweep 7: display-name re-registration with the stored PIN', () => {
  test('within 14 days of an approval the number is registered again with the PIN stored at connect time (decrypted only here, sent only to Graph)', async () => {
    const w = fullWorld({ graphOptions: { phoneStatus: 'PENDING' } });
    const t = await connectedTenant(w, 'SchedRename');
    expect((await t.complete()).status).toBe(200);
    const stored = await connRow(t.ws);
    const pin = vault.decrypt(stored.pinEncrypted, { workspaceId: t.ws, purpose: 'pin' });
    await WhatsAppConnection.updateOne({ workspaceId: t.ws }, { $set: {
      'displayName.decision': 'APPROVED', 'displayName.newName': 'Fresh Shop Name', 'displayName.mapped': 'done', 'displayName.checkedAt': new Date(Date.now() - HOUR),
    } });
    const registersBefore = w.graph.callsTo('register').length;
    const sd = schedulerDeps(w);
    const res = await scheduler.runOnboardingSweep(sd.deps);
    expect(res.displayName.registered).toBeGreaterThanOrEqual(1);
    const registers = w.graph.callsTo('register');
    expect(registers.length).toBe(registersBefore + 1);
    expect(registers[registers.length - 1].data).toEqual({ messaging_product: 'whatsapp', pin });
    w.graph.assertMerchantTokenOnly(w.graph.ids.merchantToken);
    expect(sd.logs.join('\n')).not.toContain(pin);
  });
});

describe('the lock and the flag', () => {
  test('flag off: the sweep is skipped and nothing is touched', async () => {
    const w = fullWorld();
    const sd = schedulerDeps(w);
    const res = await scheduler.runOnboardingSweep({ ...sd.deps, enabled: () => false });
    expect(res).toMatchObject({ skipped: true, connections: null, templates: null, pathB: null, emails: null, resume: null, billing: null, displayName: null });
    expect(Object.values(sd.calls).reduce((a, b) => a + b, 0)).toBe(0);
    expect(w.graph.calls).toHaveLength(0);
  });

  test('the lock is honoured: a live lock held by another instance means tick() runs no sweep; an expired one is taken over', async () => {
    const w = fullWorld();
    const sd = schedulerDeps(w);
    const long = 10 * MIN;
    // another instance holds a live lock
    await SchedulerLock.findOneAndUpdate({ _id: scheduler.LOCK_ID }, { $set: { lockedAt: new Date(), lockedUntil: new Date(Date.now() + HOUR) } }, { upsert: true });
    expect(await scheduler.acquireLock(sd.deps, long)).toBe(false);
    expect(await scheduler.tick(sd.deps, long)).toBeNull();
    expect(Object.values(sd.calls).reduce((a, b) => a + b, 0)).toBe(0);
    // the lock expired: this instance takes it, runs ONE sweep, and a competitor right after is refused
    await SchedulerLock.updateOne({ _id: scheduler.LOCK_ID }, { $set: { lockedUntil: new Date(Date.now() - MIN) } });
    const ran = await scheduler.tick(sd.deps, long);
    expect(ran).toMatchObject({ skipped: false });
    expect(sd.calls.statusRefresh).toBeGreaterThan(0);
    expect(await scheduler.acquireLock(sd.deps, long)).toBe(false);
    expect(await scheduler.tick(sd.deps, long)).toBeNull();
  });

  test('startOnboardingScheduler: flag off = null (no timer); flag on = one unref-able interval (injected), stop clears it', () => {
    const w = fullWorld();
    const sd = schedulerDeps(w);
    expect(scheduler.startOnboardingScheduler({ ...sd.deps, enabled: () => false })).toBeNull();
    const handle = { unref: jest.fn() };
    const setIntervalFn = jest.fn(() => handle);
    // a live lock keeps the immediate first tick from sweeping while this test inspects the timer wiring
    const started = scheduler.startOnboardingScheduler({ intervalMs: 600000, deps: { ...sd.deps, SchedulerLock: () => ({ findOneAndUpdate: async () => null, create: async () => { const e = new Error('dup'); e.code = 11000; throw e; } }) }, setIntervalFn });
    expect(started).toBe(handle);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn.mock.calls[0][1]).toBe(600000);
    expect(handle.unref).toHaveBeenCalled();
    expect(scheduler.startOnboardingScheduler({ intervalMs: 600000, deps: sd.deps, setIntervalFn })).toBe(handle); // idempotent
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    const clear = jest.fn();
    scheduler.stopOnboardingScheduler(clear);
    expect(clear).toHaveBeenCalledWith(handle);
  });
});

describe('one whole tick', () => {
  test('all seven sweeps report in one run (none skipped, none failed) and no log line leaks a secret', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'SchedWhole');
    await t.complete();
    const sd = schedulerDeps(w);
    const res = await scheduler.runOnboardingSweep(sd.deps);
    for (const key of ['connections', 'templates', 'pathB', 'emails', 'resume', 'billing', 'displayName']) expect(res[key]).not.toBeNull();
    expect(res.skipped).toBe(false);
    expect(sd.logs.filter((l) => /timed out|failed|unavailable|missing/.test(l))).toEqual([]);
    expect(sd.logs.join('\n')).not.toContain(w.graph.ids.merchantToken);
    expect(sd.calls).toEqual({ statusRefresh: expect.any(Number), starterTemplates: expect.any(Number), reminders: expect.any(Number), notifications: expect.any(Number), connect: expect.any(Number), billing: expect.any(Number), approvals: expect.any(Number) });
    for (const k of Object.keys(sd.calls)) expect(sd.calls[k]).toBeGreaterThan(0);
  });
});
