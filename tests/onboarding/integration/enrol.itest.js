'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database (suffix) so suites in one jest run never see each other's workspaces
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_enrol`;
assertThrowawayDb();

// Enrolment, auto-enrolment, R1, un-enrol and the admin safeguards against a REAL (throwaway) mongod.
const mongoose = require('mongoose');
const state = require('../../../shared/onboarding/state');
const Workspace = require('../../../models/Workspace');
const OnboardingState = require('../../../models/OnboardingState');
const OnboardingAdminLog = require('../../../models/OnboardingAdminLog');
const Customer = require('../../../models/Customer');

const ENV = ['ONBOARDING_FLOW', 'ONBOARDING_ENROL_FROM'];
const saved = {};
let oldest; let legacyMid; let fresh; let fresh2;
const noTrack = { track: async () => {} };

async function makeWorkspace(name, createdAt, completed) {
  const doc = { name, createdAt, updatedAt: createdAt, onboarding: { completed, currentStep: 1 } };
  const res = await Workspace.collection.insertOne(doc); // raw insert: full control of createdAt
  return String(res.insertedId);
}
const row = (id) => OnboardingState.findOne({ workspaceId: id }).lean();
const completed = async (id) => (await Workspace.findById(id).lean()).onboarding.completed;

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([OnboardingState.init(), OnboardingAdminLog.init()]);
  oldest = await makeWorkspace('Owner workspace', new Date('2026-01-01T00:00:00Z'), true);
  legacyMid = await makeWorkspace('Legacy mid', new Date('2026-06-01T00:00:00Z'), true);
  fresh = await makeWorkspace('Fresh signup', new Date('2026-10-14T00:00:00Z'), false);
  fresh2 = await makeWorkspace('Fresh signup 2', new Date('2026-10-14T01:00:00Z'), false);
});
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  state.clearCache();
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('legacy workspaces stay legacy', () => {
  test('flag off: nothing is enrolled, nothing written', async () => {
    expect(await state.autoEnrolIfEligible({ workspaceId: fresh }, noTrack)).toEqual({ enrolled: false, reason: 'flag_off' });
    expect(await OnboardingState.countDocuments({})).toBe(0);
    expect((await state.getGateState(fresh)).enrolled).toBe(false);
  });
  test('flag on, no cutover: no auto-enrolment', async () => {
    process.env.ONBOARDING_FLOW = 'on';
    expect((await state.autoEnrolIfEligible({ workspaceId: fresh }, noTrack)).reason).toBe('no_cutover');
    expect(await OnboardingState.countDocuments({})).toBe(0);
  });
  test('flag on, cutover far in the future (M1 mode): every workspace stays legacy', async () => {
    process.env.ONBOARDING_FLOW = 'on';
    process.env.ONBOARDING_ENROL_FROM = '2999-01-01T00:00:00Z';
    for (const id of [oldest, legacyMid, fresh, fresh2]) expect((await state.autoEnrolIfEligible({ workspaceId: id }, noTrack)).enrolled).toBe(false);
    expect(await OnboardingState.countDocuments({})).toBe(0);
    expect(await completed(fresh)).toBe(false); // R1 did not run
  });
});

describe('auto-enrolment rules (DB 3.2) with real data', () => {
  beforeEach(() => { process.env.ONBOARDING_FLOW = 'on'; process.env.ONBOARDING_ENROL_FROM = '2026-10-01T00:00:00Z'; });

  test('legacy and the oldest workspace are never auto-enrolled', async () => {
    for (const id of [oldest, legacyMid]) expect((await state.autoEnrolIfEligible({ workspaceId: id }, noTrack)).enrolled).toBe(false);
    expect(await OnboardingState.countDocuments({})).toBe(0);
    expect(await completed(legacyMid)).toBe(true);
  });
  test('a misconfigured cutover (earlier than the oldest workspace) refuses auto-enrolment', async () => {
    process.env.ONBOARDING_ENROL_FROM = '2025-06-01T00:00:00Z';
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await state.autoEnrolIfEligible({ workspaceId: fresh }, noTrack)).reason).toBe('misconfigured_cutover');
    expect(await OnboardingState.countDocuments({})).toBe(0);
    spy.mockRestore();
  });
  test('two simultaneous first requests -> exactly one sidecar row; R1 applies only to that workspace', async () => {
    const results = await Promise.all([
      state.autoEnrolIfEligible({ workspaceId: fresh }, noTrack),
      state.autoEnrolIfEligible({ workspaceId: fresh }, noTrack),
      state.autoEnrolIfEligible({ workspaceId: fresh }, noTrack),
    ]);
    expect(results.every((r) => r.enrolled)).toBe(true);
    expect(await OnboardingState.countDocuments({ workspaceId: fresh })).toBe(1);
    const r = await row(fresh);
    expect(r).toMatchObject({ enrolled: true, enrolledVia: 'auto_signup', enrolledBy: 'system', schemaVersion: 1 });
    expect(r.subscription.state).toBe('none');
    expect(r.steps.business.status).toBe('todo');
    expect(r.business.country).toBe('SA');
    expect(await completed(fresh)).toBe(true);         // R1 for the enrolled workspace
    expect(r.r1Applied).toBe(true);
    expect(await completed(fresh2)).toBe(false);       // untouched sibling
    expect(await completed(legacyMid)).toBe(true);
    expect((await state.getGateState(fresh)).enrolled).toBe(true);
    expect((await state.getGateState(fresh2)).enrolled).toBe(false);
  });
  test('the unique index really holds (a raw duplicate insert fails with E11000)', async () => {
    await expect(OnboardingState.collection.insertOne({ workspaceId: new mongoose.Types.ObjectId(fresh), enrolled: true })).rejects.toMatchObject({ code: 11000 });
  });
  test('a second workspace is enrolled independently; the first is unaffected', async () => {
    const before = await row(fresh);
    expect((await state.autoEnrolIfEligible({ workspaceId: fresh2 }, noTrack)).enrolled).toBe(true);
    expect(await completed(fresh2)).toBe(true);
    expect(JSON.stringify(await row(fresh))).toBe(JSON.stringify(before));
  });
});

describe('un-enrol (instant, nothing deleted)', () => {
  test('un-enrolling flips the gate immediately and keeps the document; auto-enrolment never re-enrols it', async () => {
    process.env.ONBOARDING_FLOW = 'on';
    process.env.ONBOARDING_ENROL_FROM = '2026-10-01T00:00:00Z';
    expect((await state.getGateState(fresh)).enrolled).toBe(true);
    const count = await OnboardingState.countDocuments({});
    const r = await state.unenrol({ workspaceId: fresh, by: 'cli:test', notes: 'rollback test' }, noTrack);
    expect(r.wasEnrolled).toBe(true);
    expect((await state.getGateState(fresh)).enrolled).toBe(false); // same process: cache invalidated
    expect(await OnboardingState.countDocuments({})).toBe(count);
    expect((await row(fresh)).enrolled).toBe(false);
    expect((await state.autoEnrolIfEligible({ workspaceId: fresh }, noTrack)).enrolled).toBe(false);
    expect((await row(fresh)).enrolled).toBe(false);
    const log = await OnboardingAdminLog.find({ workspaceId: fresh }).sort({ createdAt: 1 }).lean();
    expect(log.map((l) => l.action)).toEqual(['enrol', 'unenrol']);
    expect(log[1]).toMatchObject({ adminUser: 'cli:test', notes: 'rollback test' });
  });
  test('unenrolAll flips every enrolled row and clears the cache', async () => {
    expect((await state.getGateState(fresh2)).enrolled).toBe(true);
    const out = await state.unenrolAll({ by: 'cli:test' }, noTrack);
    expect(out.count).toBeGreaterThanOrEqual(1);
    expect(await OnboardingState.countDocuments({ enrolled: { $ne: false } })).toBe(0);
    expect((await state.getGateState(fresh2)).enrolled).toBe(false);
  });
});

describe('admin enrolment safeguards (real Customer data)', () => {
  test('the oldest workspace needs forceOldest', async () => {
    await expect(state.enrol({ workspaceId: oldest, by: 'cli:t' }, noTrack)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'OLDEST_WORKSPACE' } });
    expect(await OnboardingState.countDocuments({ workspaceId: oldest })).toBe(0);
    expect(await OnboardingAdminLog.countDocuments({ workspaceId: oldest })).toBe(0);
  });
  test('a workspace with existing data needs confirmExistingData; R1 only touches it once confirmed', async () => {
    await Customer.collection.insertOne({ workspaceId: new mongoose.Types.ObjectId(legacyMid), firstname: 'Existing', lastname: 'Customer', phone: '15550000001' });
    await expect(state.enrol({ workspaceId: legacyMid, by: 'cli:t' }, noTrack)).rejects.toMatchObject({ details: { reason: 'EXISTING_DATA' } });
    expect(await OnboardingState.countDocuments({ workspaceId: legacyMid })).toBe(0);
    const ok = await state.enrol({ workspaceId: legacyMid, by: 'cli:t', confirmExistingData: true, notes: 'pilot' }, noTrack);
    expect(ok).toMatchObject({ enrolled: true, alreadyEnrolled: false });
    expect(await completed(legacyMid)).toBe(true); // was already completed:true: R1 is a no-op
    expect(ok.r1Applied).toBe(false);
    await state.unenrol({ workspaceId: legacyMid, by: 'cli:t' }, noTrack);
  });
  test('dry run writes nothing', async () => {
    const before = await OnboardingAdminLog.countDocuments({});
    const r = await state.enrol({ workspaceId: fresh, by: 'cli:t', dryRun: true }, noTrack);
    expect(r.dryRun).toBe(true);
    expect(await OnboardingAdminLog.countDocuments({})).toBe(before);
  });
  test('enrol --activate, then deactivate and re-read through the real gate', async () => {
    const id = await makeWorkspace('Partner workspace', new Date('2026-10-14T02:00:00Z'), false);
    process.env.ONBOARDING_FLOW = 'on';
    const r = await state.enrol({ workspaceId: id, by: 'cli:t', activate: true, notes: 'Riyadh partner' }, noTrack);
    expect(r).toMatchObject({ enrolled: true, activated: true });
    expect((await state.getGateState(id, { fresh: true })).sub).toEqual({ state: 'active', source: 'admin' });
    const doc = await row(id);
    expect(doc.subscription).toMatchObject({ state: 'active', source: 'admin' });
    expect(doc.subscription.activatedAt).toBeInstanceOf(Date);
    expect(doc.subscription.admin).toMatchObject({ active: true, by: 'cli:t', notes: 'Riyadh partner' });
    await state.adminDeactivate({ workspaceId: id, by: 'cli:t' }, noTrack);
    expect((await state.getGateState(id)).sub).toEqual({ state: 'none', source: null });
    expect((await OnboardingAdminLog.find({ workspaceId: id }).sort({ createdAt: 1 }).lean()).map((l) => l.action)).toEqual(['enrol_activate', 'deactivate']);
  });
  test('recomputeSubscription with Stripe facts written the way B1-b will write them', async () => {
    const id = await makeWorkspace('Stripe workspace', new Date('2026-10-14T03:00:00Z'), false);
    await state.enrol({ workspaceId: id, by: 'cli:t' }, noTrack);
    await OnboardingState.updateOne({ workspaceId: id }, { $set: { 'subscription.stripe.status': 'active', 'subscription.stripe.subscriptionId': 'sub_test' } });
    expect(await state.recomputeSubscription(id, {}, noTrack)).toMatchObject({ changed: true, after: { state: 'active', source: 'stripe' } });
    await OnboardingState.updateOne({ workspaceId: id }, { $set: { 'subscription.stripe.status': 'past_due' } });
    expect(await state.recomputeSubscription(id, {}, noTrack)).toMatchObject({ changed: true, after: { state: 'past_due', source: null } });
    expect((await state.getGateState(id)).sub.state).toBe('past_due');
    const doc = await row(id);
    expect(doc.subscription.pastDueAt).toBeInstanceOf(Date);
    expect(await state.recomputeSubscription(id, {}, noTrack)).toMatchObject({ changed: false });
  });
  test('ensureConnection upserts one row; ensureState refuses a legacy workspace', async () => {
    const id = await makeWorkspace('Conn workspace', new Date('2026-10-14T04:00:00Z'), false);
    await expect(state.ensureConnection(id)).rejects.toMatchObject({ code: 'ONBOARDING_NOT_AVAILABLE' });
    await state.enrol({ workspaceId: id, by: 'cli:t' }, noTrack);
    const a = await state.ensureConnection(id);
    const [b, c] = await Promise.all([state.ensureConnection(id), state.ensureConnection(id)]);
    expect(String(a._id)).toBe(String(b._id));
    expect(String(a._id)).toBe(String(c._id));
    expect(a.status).toBe('not_connected');
    expect(a.tokenEncrypted).toBeUndefined();
    const WhatsAppConnection = require('../../../models/WhatsAppConnection');
    expect(await WhatsAppConnection.countDocuments({ workspaceId: id })).toBe(1);
    await expect(state.ensureState(legacyMid.replace(/.$/, '0'))).rejects.toMatchObject({ status: 404 });
  });
});
