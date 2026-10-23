'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database (suffix) so suites in one jest run never see each other's workspaces
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_access`;
assertThrowawayDb();

// requireOnboardingAccess against REAL models (sidecar, Membership, LegalAcceptance) on the throwaway mongod.
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const state = require('../../../shared/onboarding/state');
const requireOnboardingAccess = require('../../../shared/onboarding/requireOnboardingAccess');
const Workspace = require('../../../models/Workspace');
const OnboardingState = require('../../../models/OnboardingState');
const Membership = require('../../../models/Membership');
const legal = require('../../../shared/legalAcceptance');

const noTrack = { track: async () => {} };
const ids = {};
let app;

const asUser = (user) => ({ 'x-test-user': JSON.stringify(user) });
async function makeWorkspace(name, createdAt) {
  const res = await Workspace.collection.insertOne({ name, createdAt, updatedAt: createdAt, onboarding: { completed: false, currentStep: 1 } });
  return String(res.insertedId);
}
const newId = () => String(new mongoose.Types.ObjectId());

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([OnboardingState.init(), Membership.init()]);
  ids.oldest = await makeWorkspace('Owner workspace', new Date('2026-01-01T00:00:00Z'));
  ids.legacy = await makeWorkspace('Legacy', new Date('2026-06-01T00:00:00Z'));
  ids.ws = await makeWorkspace('Enrolled', new Date('2026-10-10T00:00:00Z'));
  ids.owner = newId(); ids.member = newId(); ids.demoted = newId(); ids.stranger = newId();
  await Membership.create([
    { userId: ids.owner, workspaceId: ids.ws, role: 'owner' },
    { userId: ids.member, workspaceId: ids.ws, role: 'member' },
    { userId: ids.demoted, workspaceId: ids.ws, role: 'member' }, // JWT will still say owner (stale)
  ]);
  await state.enrol({ workspaceId: ids.ws, by: 'cli:test' }, noTrack);

  app = express();
  app.use((req, res, next) => { req.user = JSON.parse(req.headers['x-test-user'] || '{}'); next(); });
  const ok = (req, res) => res.json({ ok: true, gate: req.onboarding && req.onboarding.gate ? req.onboarding.gate.sub.state : null });
  app.get('/exempt', requireOnboardingAccess({ billingExempt: true }), ok);
  app.get('/a', requireOnboardingAccess(), ok);
  app.get('/o', requireOnboardingAccess({ ownerOnly: true }), ok);
  app.get('/l', requireOnboardingAccess({ ownerOnly: true, needsLegal: true }), ok);
});
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(() => state.clearCache());

const setSub = async (substate, source = null) => {
  await OnboardingState.updateOne({ workspaceId: ids.ws }, { $set: { 'subscription.state': substate, 'subscription.source': source } });
  state.invalidate(ids.ws);
};
const owner = () => ({ id: ids.owner, workspaceId: ids.ws, role: 'owner' });

describe('not enrolled -> 404 (the same answer as an unknown route)', () => {
  test.each(['/exempt', '/a', '/o', '/l'])('%s for a legacy workspace', async (path) => {
    const res = await request(app).get(path).set(asUser({ id: ids.owner, workspaceId: ids.legacy, role: 'owner' }));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ONBOARDING_NOT_AVAILABLE');
  });
  test('the oldest workspace too', async () => {
    expect((await request(app).get('/exempt').set(asUser({ id: ids.owner, workspaceId: ids.oldest, role: 'owner' }))).status).toBe(404);
  });
  test('an un-enrolled (enrolled:false) workspace is 404 as well', async () => {
    const id = await makeWorkspace('Un-enrolled', new Date('2026-10-11T00:00:00Z'));
    await state.enrol({ workspaceId: id, by: 'cli:test' }, noTrack);
    await state.unenrol({ workspaceId: id, by: 'cli:test' }, noTrack);
    expect((await request(app).get('/exempt').set(asUser({ id: ids.owner, workspaceId: id, role: 'owner' }))).status).toBe(404);
  });
});

describe('subscription matrix', () => {
  const CODES = { none: 'SUBSCRIPTION_REQUIRED', pending: 'PAYMENT_PENDING', past_due: 'PAYMENT_PAST_DUE', cancelled: 'SUBSCRIPTION_CANCELLED' };
  test.each(Object.entries(CODES))('%s: step routes -> 402 %s, billing-exempt routes pass', async (substate, code) => {
    await setSub(substate);
    for (const path of ['/a', '/o', '/l']) {
      const res = await request(app).get(path).set(asUser(owner()));
      expect(res.status).toBe(402);
      expect(res.body.code).toBe(code);
      expect(res.body.retry).toBeDefined();
    }
    const ex = await request(app).get('/exempt').set(asUser(owner()));
    expect(ex.status).toBe(200);
    expect(ex.body.gate).toBe(substate);
  });
  test('active (admin): step routes pass', async () => {
    await setSub('active', 'admin');
    const res = await request(app).get('/a').set(asUser(owner()));
    expect(res.status).toBe(200);
    expect(res.body.gate).toBe('active');
  });
});

describe('ownerOnly uses the LIVE Membership, not the JWT role', () => {
  beforeEach(() => setSub('active', 'admin'));
  test('owner passes (needs no legal for /o)', async () => {
    expect((await request(app).get('/o').set(asUser(owner()))).status).toBe(200);
  });
  test('member -> 403 OWNER_ONLY', async () => {
    const res = await request(app).get('/o').set(asUser({ id: ids.member, workspaceId: ids.ws, role: 'member' }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OWNER_ONLY');
  });
  test('a demoted owner with a stale JWT that still says owner -> 403', async () => {
    const res = await request(app).get('/o').set(asUser({ id: ids.demoted, workspaceId: ids.ws, role: 'owner' }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OWNER_ONLY');
  });
  test('a promoted member with a stale JWT that says member -> allowed', async () => {
    await Membership.updateOne({ userId: ids.demoted, workspaceId: ids.ws }, { $set: { role: 'owner' } });
    expect((await request(app).get('/o').set(asUser({ id: ids.demoted, workspaceId: ids.ws, role: 'member' }))).status).toBe(200);
    await Membership.updateOne({ userId: ids.demoted, workspaceId: ids.ws }, { $set: { role: 'member' } });
  });
  test('a user with no membership in this workspace -> 403; a malformed user id -> 403', async () => {
    expect((await request(app).get('/o').set(asUser({ id: ids.stranger, workspaceId: ids.ws, role: 'owner' }))).status).toBe(403);
    expect((await request(app).get('/o').set(asUser({ id: 'not-an-object-id', workspaceId: ids.ws, role: 'owner' }))).status).toBe(403);
  });
  test('an owner of ANOTHER workspace cannot use this workspace\'s owner routes through a spoofed token workspace', async () => {
    const other = await makeWorkspace('Other enrolled', new Date('2026-10-12T00:00:00Z'));
    await state.enrol({ workspaceId: other, by: 'cli:test' }, noTrack);
    await OnboardingState.updateOne({ workspaceId: other }, { $set: { 'subscription.state': 'active', 'subscription.source': 'admin' } });
    state.invalidate(other);
    // ids.owner owns ids.ws but has no membership in `other`
    expect((await request(app).get('/o').set(asUser({ id: ids.owner, workspaceId: other, role: 'owner' }))).status).toBe(403);
  });
});

describe('needsLegal (connect only): server-side legal acceptance', () => {
  beforeEach(() => setSub('active', 'admin'));
  test('owner who has not accepted -> 403 LEGAL_ACCEPTANCE_REQUIRED', async () => {
    const res = await request(app).get('/l').set(asUser(owner()));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
  });
  test('combined terms accepted but the DPA is not -> still 403 for the owner', async () => {
    await legal.recordCombinedAcceptance({ userId: ids.owner, workspaceId: ids.ws, role: 'owner' });
    expect((await request(app).get('/l').set(asUser(owner()))).body.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
  });
  test('everything accepted -> allowed', async () => {
    await legal.recordDpaAcceptance({ userId: ids.owner, workspaceId: ids.ws, role: 'owner' });
    expect((await request(app).get('/l').set(asUser(owner()))).status).toBe(200);
  });
  test('legal is checked after owner: a member gets OWNER_ONLY, not a legal error', async () => {
    expect((await request(app).get('/l').set(asUser({ id: ids.member, workspaceId: ids.ws, role: 'member' }))).body.code).toBe('OWNER_ONLY');
  });
  test('a new owner (no acceptance) is blocked even though the workspace DPA is on file', async () => {
    const second = newId();
    await Membership.create({ userId: second, workspaceId: ids.ws, role: 'owner' });
    expect((await request(app).get('/l').set(asUser({ id: second, workspaceId: ids.ws, role: 'owner' }))).body.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
  });
});

describe('tenant isolation', () => {
  test('the workspace id in the body/query/headers is ignored: only the token workspace counts', async () => {
    await setSub('none');
    const res = await request(app).get(`/a?workspaceId=${ids.legacy}`).set({ ...asUser(owner()), 'x-workspace-id': ids.legacy });
    expect(res.status).toBe(402); // judged on ids.ws (enrolled, unpaid), not the legacy id in the query
    const res2 = await request(app).get(`/a?workspaceId=${ids.ws}`).set(asUser({ id: ids.owner, workspaceId: ids.legacy, role: 'owner' }));
    expect(res2.status).toBe(404); // judged on the legacy token workspace
  });
});
