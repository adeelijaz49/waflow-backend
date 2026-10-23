'use strict';
// Shared world of the cross-module and scheduler-wiring suites (task I1a): tenants that go through the REAL enrolment +
// admin activation, and a mini app with EVERY onboarding router wired to the same Graph fake. Not a test file.
const express = require('express');
const request = require('supertest');
const H = require('./_connectHarness');
const state = require('../../../shared/onboarding/state');
const rateLimit = require('../../../shared/onboarding/rateLimit');
const { createFakeGraph, createFakeSend, fakeRandom } = require('../_fixtures');
const { createMetaGraphClient } = require('../../../shared/onboarding/metaClient');
const connectMod = require('../../../shared/onboarding/connect');
const emailMod = require('../../../shared/onboarding/email');
const starterTemplates = require('../../../shared/onboarding/starterTemplates');

const { Membership } = H.models;
const BUSINESS = { name: 'Cross Test Shop', country: 'SA', industry: 'fashion' };
const flat = (s) => Object.assign({ event: s.event }, s.data);
let codeSeq = 0;
const nextCode = () => `AQDcrossSECRET${String(++codeSeq).padStart(4, '0')}valueXYZ`;

/** A tenant that goes through the REAL enrolment + admin activation (no step shortcuts). */
async function enrolledTenant(name) {
  await H.makeTenant('Cross oldest guard'); // makes sure an older workspace exists
  const ws = await H.makeWorkspace(name);
  const owner = H.newId();
  const member = H.newId();
  await Membership.create([{ userId: owner, workspaceId: ws, role: 'owner' }, { userId: member, workspaceId: ws, role: 'member' }]);
  await state.enrol({ workspaceId: ws, by: 'cli:test' }, H.noTrack);
  await state.adminActivate({ workspaceId: ws, by: 'cli:test', notes: 'cross-module test activation' }, H.noTrack);
  const legal = require('../../../shared/legalAcceptance');
  await legal.recordCombinedAcceptance({ userId: owner, workspaceId: ws, role: 'owner' });
  await legal.recordDpaAcceptance({ userId: owner, workspaceId: ws, role: 'owner' });
  state.invalidate(ws);
  return { ws, owner, member };
}

function fullWorld(opts = {}) {
  const graph = opts.graph || createFakeGraph({ ...H.uniqueIds(), ...(opts.graphOptions || {}) });
  const meta = createMetaGraphClient({ http: graph.http, appId: graph.ids.appId, appSecret: graph.ids.appSecret });
  const random = fakeRandom({ sequence: [482913] });
  const limiter = rateLimit.createLimiter();
  const mail = createFakeSend();
  // the immediate template submission of a completed connect runs the REAL submitQueued against the same Graph fake (never the default client)
  const connectDeps = { meta, randomInt: random.randomInt, starterTemplates: { ...starterTemplates, submitQueued: (a) => starterTemplates.submitQueued(a, { metaClient: meta }) } };
  const refreshDeps = {
    meta,
    connect: {
      reportGraphError: (ws, err) => connectMod.reportGraphError(ws, err, connectDeps),
      resumeConnect: (a) => connectMod.resumeConnect(a, connectDeps),
    },
  };
  const supportMail = { sendSupportEmail: (request) => emailMod.sendSupportEmail(request, { send: mail.send, supportConfig: () => ({ email: 'help@desk.example.test', deskEmail: null }) }) };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { try { req.user = JSON.parse(req.headers['x-test-user'] || '{}'); } catch (_) { req.user = {}; } next(); });
  app.use('/api/onboarding', require('../../../routes/onboarding').createRouter({
    routers: {
      connect: { connectDeps, limiter },
      connection: { connectDeps, limiter, refreshDeps },
      templates: { moduleDeps: { metaClient: meta }, rateLimitDeps: { limiter } },
      number: { email: supportMail },
      test: { moduleDeps: { metaClient: meta }, rateLimitDeps: { limiter } },
    },
  }));
  const asUser = (tenant, who = 'owner') => ({ 'x-test-user': JSON.stringify({ id: tenant[who], workspaceId: tenant.ws, role: who === 'owner' ? 'owner' : 'member' }) });
  const get = (t, path, who = 'owner') => request(app).get(`/api/onboarding${path}`).set(asUser(t, who));
  const post = (t, path, body = {}, who = 'owner') => request(app).post(`/api/onboarding${path}`).set(asUser(t, who)).send(body);
  const put = (t, path, body = {}, who = 'owner') => request(app).put(`/api/onboarding${path}`).set(asUser(t, who)).send(body);
  return { app, graph, meta, mail, limiter, connectDeps, refreshDeps, get, post, put, asUser };
}

/** enrol -> activate -> business -> number (Path A) -> connect config through the API; returns the tenant. */
async function connectedTenant(w, name, session = 'FINISH') {
  const t = await enrolledTenant(name);
  expect((await w.put(t, '/business', BUSINESS)).status).toBe(200);
  expect((await w.post(t, '/number/path', { hasNumber: true, usage: 'unused' })).status).toBe(200);
  const cfg = await w.get(t, '/connect/config');
  expect(cfg.status).toBe(200);
  t.attemptId = cfg.body.attemptId;
  // the answer first, then the background template submission of a completed connect has finished (tests stay deterministic)
  t.complete = async (body = {}) => {
    const res = await w.post(t, '/connect/complete', { attemptId: t.attemptId, code: nextCode(), session: flat(w.graph.session(session)), ...body });
    await connectMod._internal.idle();
    return res;
  };
  return t;
}


module.exports = { enrolledTenant, fullWorld, connectedTenant, BUSINESS, flat, nextCode };
