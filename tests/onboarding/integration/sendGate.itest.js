'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database (suffix) so suites in one jest run never see each other's workspaces
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_sendgate`;
assertThrowawayDb();

// sendGate.flowBlocked: the visible trail (once per workspace/code/UTC day) and the flow-scheduler hunk (E5),
// against REAL models on the throwaway mongod. No WhatsApp call is possible: no flow here has an enrolment.
process.env.ONBOARDING_FLOW = 'on';
delete process.env.ONBOARDING_LEGACY_SEND_POLICY;

const mongoose = require('mongoose');
const state = require('../../../shared/onboarding/state');
const sendGate = require('../../../shared/onboarding/sendGate');
const Workspace = require('../../../models/Workspace');
const Flow = require('../../../models/Flow');
const SchedulerLock = require('../../../models/SchedulerLock');
const OnboardingState = require('../../../models/OnboardingState');
const OnboardingNotification = require('../../../models/OnboardingNotification');
const OnboardingEvent = require('../../../models/OnboardingEvent');
const WhatsAppConnection = require('../../../models/WhatsAppConnection');

const noTrack = { track: async () => {} };
let legacyWs; let blockedWs; let allowedWs;

async function makeWorkspace(name, createdAt) {
  const res = await Workspace.collection.insertOne({ name, createdAt, updatedAt: createdAt, onboarding: { completed: false, currentStep: 1 } });
  return String(res.insertedId);
}

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([OnboardingState.init(), OnboardingNotification.init(), OnboardingEvent.init(), WhatsAppConnection.init()]);
  await makeWorkspace('Owner workspace', new Date('2026-01-01T00:00:00Z'));
  legacyWs = await makeWorkspace('Legacy', new Date('2026-06-01T00:00:00Z'));
  blockedWs = await makeWorkspace('Blocked (enrolled, unpaid)', new Date('2026-10-10T00:00:00Z'));
  allowedWs = await makeWorkspace('Allowed (platform_number pilot)', new Date('2026-10-11T00:00:00Z'));
  await state.enrol({ workspaceId: blockedWs, by: 'cli:test' }, noTrack);
  await state.enrol({ workspaceId: allowedWs, by: 'cli:test', activate: true, notes: 'pilot' }, noTrack);
  await WhatsAppConnection.updateOne({ workspaceId: allowedWs }, { $set: { status: 'connected', needsReconnect: false }, $setOnInsert: { workspaceId: allowedWs } }, { upsert: true });
});
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(() => { state.clearCache(); process.env.ONBOARDING_FLOW = 'on'; delete process.env.ONBOARDING_LEGACY_SEND_POLICY; });

const events = (ws) => OnboardingEvent.find({ workspaceId: ws, type: 'send_blocked' }).lean();
const notes = (ws) => OnboardingNotification.find({ workspaceId: ws, kind: 'sending_paused' }).lean();

describe('flowBlocked', () => {
  test('flag off: false, nothing written', async () => {
    process.env.ONBOARDING_FLOW = 'off';
    expect(await sendGate.flowBlocked({ workspaceId: blockedWs })).toBe(false);
    expect(await notes(blockedWs)).toHaveLength(0);
  });
  test('legacy workspace: false, nothing written', async () => {
    expect(await sendGate.flowBlocked({ workspaceId: legacyWs })).toBe(false);
    expect(await notes(legacyWs)).toHaveLength(0);
    expect(await events(legacyWs)).toHaveLength(0);
  });
  test('enrolled + unpaid: true, and the visible trail is written ONCE per workspace/code/UTC day', async () => {
    const day1 = { now: () => new Date('2026-10-15T08:00:00Z') };
    expect(await sendGate.flowBlocked({ workspaceId: blockedWs }, day1)).toBe(true);
    expect(await sendGate.flowBlocked({ workspaceId: blockedWs }, { now: () => new Date('2026-10-15T23:59:00Z') })).toBe(true);
    expect(await sendGate.flowBlocked({ workspaceId: blockedWs }, day1)).toBe(true);
    const n1 = await notes(blockedWs);
    expect(n1).toHaveLength(1);
    expect(n1[0]).toMatchObject({ dedupeKey: 'send_blocked:SUBSCRIPTION_REQUIRED:2026-10-15', severity: 'warning', titleKey: 'onboarding.notify.sending_paused.title', actionPath: '/setup' });
    expect(n1[0].params).toEqual({ code: 'SUBSCRIPTION_REQUIRED' });
    const e1 = await events(blockedWs);
    expect(e1).toHaveLength(1);
    expect(e1[0]).toMatchObject({ code: 'SUBSCRIPTION_REQUIRED', step: 'billing' });
    // next UTC day -> a new trail
    expect(await sendGate.flowBlocked({ workspaceId: blockedWs }, { now: () => new Date('2026-10-16T00:00:30Z') })).toBe(true);
    expect(await notes(blockedWs)).toHaveLength(2);
    expect(await events(blockedWs)).toHaveLength(2);
  });
  test('a different code on the same day is a separate trail (past_due)', async () => {
    await OnboardingState.updateOne({ workspaceId: blockedWs }, { $set: { 'subscription.state': 'past_due' } });
    state.invalidate(blockedWs);
    const now = () => new Date('2026-10-15T09:00:00Z');
    expect(await sendGate.flowBlocked({ workspaceId: blockedWs }, { now })).toBe(true);
    const keys = (await notes(blockedWs)).map((n) => n.dedupeKey).sort();
    expect(keys).toContain('send_blocked:PAYMENT_PAST_DUE:2026-10-15');
    await OnboardingState.updateOne({ workspaceId: blockedWs }, { $set: { 'subscription.state': 'none' } });
    state.invalidate(blockedWs);
  });
  test('active + connected + policy block (default) -> blocked with SENDING_NOT_AVAILABLE_YET', async () => {
    expect(await sendGate.flowBlocked({ workspaceId: allowedWs }, { now: () => new Date('2026-10-15T08:00:00Z') })).toBe(true);
    expect((await notes(allowedWs))[0].dedupeKey).toBe('send_blocked:SENDING_NOT_AVAILABLE_YET:2026-10-15');
  });
  test('active + connected + policy platform_number -> allowed (false), no trail', async () => {
    process.env.ONBOARDING_LEGACY_SEND_POLICY = 'platform_number';
    state.clearCache();
    const before = (await notes(allowedWs)).length;
    expect(await sendGate.flowBlocked({ workspaceId: allowedWs })).toBe(false);
    expect((await notes(allowedWs)).length).toBe(before);
  });
  test('checkSending / assertSendingAllowed against the real gate', async () => {
    expect(await sendGate.checkSending(legacyWs)).toEqual({ allowed: true });
    expect(await sendGate.checkSending(blockedWs)).toEqual({ allowed: false, code: 'SUBSCRIPTION_REQUIRED', status: 402, nextStep: 'billing' });
    await expect(sendGate.assertSendingAllowed(blockedWs)).rejects.toMatchObject({ status: 402, code: 'SUBSCRIPTION_REQUIRED' });
    await expect(sendGate.assertSendingAllowed(legacyWs)).resolves.toBeUndefined();
  });
});

describe('utils/flowScheduler.js hunk E5 (runSweep)', () => {
  test('a flow of a blocked workspace is skipped (not swept, nothing consumed); legacy and allowed flows are swept as before', async () => {
    process.env.ONBOARDING_LEGACY_SEND_POLICY = 'platform_number';
    state.clearCache();
    const mk = (workspaceId, name) => Flow.create({ workspaceId, name, triggerType: 'inactive_customer', inactivityDays: 60, templateName: 'winback', status: 'active' });
    // under platform_number the blocked (unpaid) workspace is still blocked by its subscription
    const [fLegacy, fBlocked, fAllowed] = await Promise.all([mk(legacyWs, 'legacy flow'), mk(blockedWs, 'blocked flow'), mk(allowedWs, 'allowed flow')]);
    await SchedulerLock.updateOne({ _id: 'flowScheduler' }, { $set: { lockedUntil: new Date(0) } }).catch(() => {});
    const scheduler = require('../../../utils/flowScheduler');
    await scheduler.runSweep();
    const get = (f) => Flow.findById(f._id).lean();
    expect((await get(fLegacy)).lastRunAt).toBeInstanceOf(Date);
    expect((await get(fAllowed)).lastRunAt).toBeInstanceOf(Date);
    expect((await get(fBlocked)).lastRunAt).toBeUndefined();
  });
  test('with the flag off every active flow is swept (no change to the existing scheduler)', async () => {
    process.env.ONBOARDING_FLOW = 'off';
    const f = await Flow.create({ workspaceId: blockedWs, name: 'blocked flow, flag off', triggerType: 'inactive_customer', inactivityDays: 60, templateName: 'winback', status: 'active' });
    await SchedulerLock.updateOne({ _id: 'flowScheduler' }, { $set: { lockedUntil: new Date(0) } });
    await require('../../../utils/flowScheduler').runSweep();
    expect((await Flow.findById(f._id).lean()).lastRunAt).toBeInstanceOf(Date);
  });
});
