'use strict';
// Shared world for the connect / connection integration suites (B1-c): a mini Express app with the REAL
// /api/onboarding router (default gates + real requireOnboardingAccess), the REAL connect module and REAL models on
// the throwaway mongod, with Meta Graph replaced by fakeGraph. Nothing here talks to a real service.
const express = require('express');
const mongoose = require('mongoose');
const { createFakeGraph, fixedClock, fakeRandom } = require('../_fixtures');
const { createMetaGraphClient } = require('../../../shared/onboarding/metaClient');
const rateLimit = require('../../../shared/onboarding/rateLimit');
const starterTemplates = require('../../../shared/onboarding/starterTemplates');
const state = require('../../../shared/onboarding/state');
const legal = require('../../../shared/legalAcceptance');
const Workspace = require('../../../models/Workspace');
const OnboardingState = require('../../../models/OnboardingState');
const WhatsAppConnection = require('../../../models/WhatsAppConnection');
const WhatsAppClaim = require('../../../models/WhatsAppClaim');
const Membership = require('../../../models/Membership');

const KEY_HEX = 'a1'.repeat(32);
const noTrack = { track: async () => {} };
const newId = () => String(new mongoose.Types.ObjectId());

const ENV = {
  ONBOARDING_FLOW: 'on',
  META_ES_APP_ID: 'APP_ID_FIXTURE',
  META_ES_CONFIG_ID: 'CONFIG_ID_FIXTURE',
  WA_APP_SECRET: 'APP_SECRET_FIXTURE_0123456789abcdef',
  WA_TOKEN_ENCRYPTION_KEY: KEY_HEX,
  AUTH_JWT_SECRET: 'jwt-secret-for-onboarding-tests',
};

function setEnv() {
  const saved = {};
  Object.keys(ENV).forEach((k) => { saved[k] = process.env[k]; process.env[k] = ENV[k]; });
  return () => Object.keys(saved).forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
}

async function makeWorkspace(name, createdAt = new Date('2026-10-10T00:00:00Z')) {
  const res = await Workspace.collection.insertOne({ name, createdAt, updatedAt: createdAt, onboarding: { completed: false, currentStep: 1 } });
  return String(res.insertedId);
}

let oldestReady = false;
/** The oldest workspace of a database is the owner's own and can never be enrolled: create it once. */
async function ensureOldest() {
  if (oldestReady) return;
  await makeWorkspace('Owner workspace (oldest)', new Date('2026-01-01T00:00:00Z'));
  oldestReady = true;
}

/** An enrolled, active, owner-ready tenant (steps 1-2 done, legal accepted). */
async function makeTenant(name, opts = {}) {
  await ensureOldest();
  const ws = await makeWorkspace(name);
  const owner = newId();
  const member = newId();
  await Membership.create([{ userId: owner, workspaceId: ws, role: 'owner' }, { userId: member, workspaceId: ws, role: 'member' }]);
  await state.enrol({ workspaceId: ws, by: 'cli:test' }, noTrack);
  const set = { 'subscription.state': 'active', 'subscription.source': 'admin' };
  if (opts.steps !== false) { set['steps.business.status'] = 'done'; set['steps.number.status'] = 'done'; }
  await OnboardingState.updateOne({ workspaceId: ws }, { $set: set });
  state.invalidate(ws);
  await legal.recordCombinedAcceptance({ userId: owner, workspaceId: ws, role: 'owner' });
  await legal.recordDpaAcceptance({ userId: owner, workspaceId: ws, role: 'owner' });
  return { ws, owner, member };
}

/**
 * @param {{graph?:object, graphOptions?:object, clock?:object}} [opts]
 */
let idSeq = 0;
/** Unique Meta ids per world: WhatsAppClaim is cross-tenant, so tests must not share a WABA or phone id by accident. */
function uniqueIds() {
  idSeq += 1;
  const n = String(Date.now()).slice(-9) + String(idSeq).padStart(3, '0');
  return { wabaId: `11${n}1`, phoneId: `11${n}2`, businessId: `11${n}3` };
}

function createWorld(opts = {}) {
  const graph = opts.graph || createFakeGraph({ ...uniqueIds(), ...(opts.graphOptions || {}) });
  const meta = createMetaGraphClient({ http: graph.http, appId: graph.ids.appId, appSecret: graph.ids.appSecret });
  const random = fakeRandom({ sequence: [482913] });
  const limiter = rateLimit.createLimiter();
  const outbox = [];
  // A completed connection hands the queued starter templates to Meta at once (connect.js, best effort, never awaited). A world that did
  // not ask for it records the call and does nothing: the real module would use the DEFAULT Graph client (axios) and these suites assert
  // the exact Graph calls of the connection itself. connectSubmit.itest.js runs the real submission against the same fakeGraph.
  const submitCalls = [];
  const starterRecorder = { ...starterTemplates, submitQueued: async (a) => { submitCalls.push(a); return { submitted: 0 }; } };
  const connectDeps = {
    meta, randomInt: random.randomInt, notify: async (a) => { outbox.push(a); return { created: true }; },
    starterTemplates: starterRecorder,
    ...(opts.clock ? { now: () => opts.clock.now() } : {}),
    ...(opts.connectDeps || {}),
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    try { req.user = JSON.parse(req.headers['x-test-user'] || '{}'); } catch (_) { req.user = {}; }
    next();
  });
  const router = require('../../../routes/onboarding').createRouter({
    routers: { connect: { connectDeps, limiter }, connection: { connectDeps, limiter, refreshDeps: undefined, ...(opts.connectionDeps || {}) } },
  });
  app.use('/api/onboarding', router);
  const asUser = (tenant, who = 'owner', role) => ({
    'x-test-user': JSON.stringify({ id: tenant[who], workspaceId: tenant.ws, role: role || (who === 'owner' ? 'owner' : 'member') }),
  });
  return { graph, meta, random, limiter, outbox, submitCalls, connectDeps, app, asUser };
}

/** Collect console output (never leaks secrets) for assertNoLeak. */
function spyConsole() {
  const lines = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const spies = methods.map((m) => jest.spyOn(console, m).mockImplementation((...a) => { lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); }));
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

module.exports = {
  uniqueIds, KEY_HEX, ENV, setEnv, noTrack, newId, makeWorkspace, makeTenant, createWorld, spyConsole, fixedClock,
  models: { Workspace, OnboardingState, WhatsAppConnection, WhatsAppClaim, Membership },
};
