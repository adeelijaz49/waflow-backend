'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database so suites in one jest run never see each other's workspaces
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_cross`;
assertThrowawayDb();

// CROSS-MODULE integration (task I1a): the matrix items that deserve a real database. REAL modules everywhere
// (steps, state, connect, statusRefresh, approvals, starterTemplates, notifications, analytics, routes) on the
// throwaway mongod; Meta Graph = fakeGraph, e-mail = fakeResend. Nothing here talks to a real service.
const request = require('supertest');
const mongoose = require('mongoose');
const H = require('./_connectHarness');
const { enrolledTenant, fullWorld, connectedTenant, BUSINESS, flat, nextCode } = require('./_crossHarness');
const state = require('../../../shared/onboarding/state');
const steps = require('../../../shared/onboarding/steps');
const vault = require('../../../shared/onboarding/tokenVault');
const webhookEvents = require('../../../shared/onboarding/webhookEvents');
const Customer = require('../../../models/Customer');
const OnboardingEvent = require('../../../models/OnboardingEvent');
const OnboardingNotification = require('../../../models/OnboardingNotification');
const OnboardingTemplate = require('../../../models/OnboardingTemplate');

const { WhatsAppConnection, WhatsAppClaim, OnboardingState, Membership } = H.models;
jest.setTimeout(90000);

let restoreEnv;
const connRow = (ws) => WhatsAppConnection.findOne({ workspaceId: ws }).select('+tokenEncrypted +pinEncrypted').lean();
const stateRow = (ws) => OnboardingState.findOne({ workspaceId: ws }).lean();

beforeAll(async () => {
  restoreEnv = H.setEnv();
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([OnboardingState.init(), WhatsAppConnection.init(), WhatsAppClaim.init(), Membership.init(), OnboardingNotification.init(), OnboardingTemplate.init(), OnboardingEvent.init()]);
});
afterAll(async () => { restoreEnv(); await mongoose.disconnect(); });
beforeEach(() => { state.clearCache(); webhookEvents.clearMemo(); });

function world(opts = {}) {
  const w = H.createWorld(opts);
  const get = (t, path, who = 'owner') => request(w.app).get(`/api/onboarding${path}`).set(w.asUser(t, who));
  const post = (t, path, body = {}, who = 'owner') => request(w.app).post(`/api/onboarding${path}`).set(w.asUser(t, who)).send(body);
  const put = (t, path, body = {}, who = 'owner') => request(w.app).put(`/api/onboarding${path}`).set(w.asUser(t, who)).send(body);
  return { ...w, get, post, put };
}


describe('(e) Path A completion marks Step 2 done so that GET /connect/config passes', () => {
  const branches = [
    ['unused number', { hasNumber: true, usage: 'unused' }],
    ['personal number (warning acknowledged)', { hasNumber: true, usage: 'personal', acknowledgeRemoval: true }],
    ['business app, coexistence', { hasNumber: true, usage: 'business_app', businessAppChoice: 'coexistence' }],
    ['business app, migrate', { hasNumber: true, usage: 'business_app', businessAppChoice: 'migrate' }],
    ['landline', { hasNumber: true, usage: 'landline' }],
  ];
  test.each(branches)('enrol -> admin-activate -> PUT /business -> POST /number/path (%s) -> GET /connect/config 200', async (label, answer) => {
    const w = world();
    const t = await enrolledTenant(`PathA ${label}`);
    // before step 1 and 2 the connect config is refused
    expect((await w.get(t, '/connect/config')).status).toBe(409);
    const biz = await w.put(t, '/business', BUSINESS);
    expect(biz.status).toBe(200);
    expect(biz.body.steps.business.status).toBe('done');
    expect(biz.body.nextStep).toBe('number');
    expect((await w.get(t, '/connect/config')).body.code).toBe('STEP_PREREQUISITE'); // step 2 still open
    const path = await w.post(t, '/number/path', answer);
    expect(path.status).toBe(200);
    expect(path.body).toMatchObject({ path: 'A', nextStep: 'connect' });
    const row = await stateRow(t.ws);
    expect(row.steps.number.status).toBe('done');
    expect(row.progress.status).toBe('in_progress');
    const cfg = await w.get(t, '/connect/config');
    expect(cfg.status).toBe(200);
    expect(cfg.body).toMatchObject({ enabled: true, reconnect: null });
    const st = await w.get(t, '/state');
    expect(st.body).toMatchObject({ view: 'setup', nextStep: 'connect' });
    expect(st.body.steps.business.status).toBe('done');
    expect(st.body.steps.number.status).toBe('done');
    expect(st.body.steps.connect.status).toBe('todo');
  });

  test('Path B (no number yet) keeps Step 2 open: connect config is refused until "I have my number"', async () => {
    const w = world();
    const t = await enrolledTenant('PathB');
    await w.put(t, '/business', BUSINESS);
    const path = await w.post(t, '/number/path', { hasNumber: false });
    expect(path.body).toMatchObject({ path: 'B', nextStep: 'number' });
    expect((await stateRow(t.ws)).progress.status).toBe('paused_number');
    expect((await w.get(t, '/connect/config')).body.code).toBe('STEP_PREREQUISITE');
    const ready = await w.post(t, '/number/ready');
    expect(ready.body).toMatchObject({ path: 'B', numberReady: true, nextStep: 'connect' });
    expect((await stateRow(t.ws)).steps.number.status).toBe('done');
    expect((await w.get(t, '/connect/config')).status).toBe(200);
  });
});

describe('(f) the nextStep progression after connect, step transitions written by the right modules', () => {
  test('connect (connect.js) -> approvals offered once (approvals.touchProgress) -> customers -> products (prompts) -> promotion (firstPromotion) -> done', async () => {
    const w = world();
    const t = await enrolledTenant('Progression');
    await w.put(t, '/business', BUSINESS);
    await w.post(t, '/number/path', { hasNumber: true, usage: 'unused' });
    const cfg = await w.get(t, '/connect/config');
    expect(cfg.status).toBe(200);
    const done = await w.post(t, '/connect/complete', { attemptId: cfg.body.attemptId, code: nextCode(), session: flat(w.graph.session('FINISH')) });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'connected', nextStep: 'approvals' });

    // step 3 written by connect.js (via steps.markStep), the connection summary comes from statusRefresh.snapshot
    let st = (await w.get(t, '/state')).body;
    expect(st.steps.connect.status).toBe('done');
    expect(st.nextStep).toBe('approvals');
    expect(st.steps.approvals.status).toBe('todo');
    expect(st.connection).toMatchObject({ level: 'connected' });
    expect(st.progress.status).toBe('in_progress');
    expect(st.view).toBe('setup');
    expect(st.progress.completedAt).toBeNull();

    // approvals is offered ONCE: its first view (approvals.touchProgress) moves step 4 to in_progress, then the flow moves on
    const appr = await w.get(t, '/approvals');
    expect(appr.status).toBe(200);
    st = (await w.get(t, '/state')).body;
    expect(st.steps.approvals.status).toBe('in_progress');
    expect(st.nextStep).toBe('customers');

    // prompts: step transitions by routes/prompts (never blocking, skipped is fine)
    const pc = await w.post(t, '/prompts/customers', { state: 'skipped' });
    expect(pc.body).toMatchObject({ kind: 'customers', state: 'skipped', nextStep: 'products' });
    const pp = await w.post(t, '/prompts/products', { state: 'skipped' });
    expect(pp.body).toMatchObject({ kind: 'products', state: 'skipped', nextStep: 'promotion' });
    st = (await w.get(t, '/state')).body;
    expect(st.nextStep).toBe('promotion');
    expect(st.view).toBe('setup');

    // promotion: written by firstPromotion.setFirstPromotionState (via steps.markStep); everything done -> finished
    const fp = await w.post(t, '/first-promotion/state', { state: 'skipped' });
    expect(fp.status).toBe(200);
    st = (await w.get(t, '/state')).body;
    expect(st.steps.promotion.status).toBe('skipped');
    expect(st.nextStep).toBeNull();
    expect(st.view).toBe('done');
    expect(st.progress.status).toBe('completed');
    expect(st.progress.completedAt).toBeTruthy();
    // the unlock point (connected) was reached at step 3 already
    expect(st.locked).toBe(false);
  });

  test('answering a prompt first (without opening approvals) also moves a never-opened approvals step off todo', async () => {
    const w = world();
    const t = await enrolledTenant('PromptFirst');
    await w.put(t, '/business', BUSINESS);
    await w.post(t, '/number/path', { hasNumber: true, usage: 'unused' });
    const cfg = await w.get(t, '/connect/config');
    await w.post(t, '/connect/complete', { attemptId: cfg.body.attemptId, code: nextCode(), session: flat(w.graph.session('FINISH')) });
    await w.post(t, '/prompts/customers', { state: 'skipped' });
    expect((await stateRow(t.ws)).steps.approvals.status).toBe('in_progress');
  });
});

describe('ruling 5: erased customers never count', () => {
  test('a customer with deletedAt cannot make the customers prompt done; /state counts and the hand-off audience skip it', async () => {
    const w = world();
    const t = await enrolledTenant('Erased');
    await Customer.collection.insertOne({ workspaceId: new mongoose.Types.ObjectId(t.ws), firstname: 'Gone', lastname: 'Person', phone: '966500099001', marketingConsent: true, deletedAt: new Date('2026-10-01T00:00:00Z'), createdAt: new Date(), updatedAt: new Date() });
    expect((await w.post(t, '/prompts/customers', { state: 'done' })).status).toBe(422);
    expect((await w.get(t, '/state')).body.prompts.counts.customers).toBe(0);
    await Customer.collection.insertOne({ workspaceId: new mongoose.Types.ObjectId(t.ws), firstname: 'Real', lastname: 'Person', phone: '966500099002', marketingConsent: true, createdAt: new Date(), updatedAt: new Date() });
    expect((await w.get(t, '/state')).body.prompts.counts.customers).toBe(1);
    expect((await w.post(t, '/prompts/customers', { state: 'done' })).status).toBe(200);
    const fpModule = require('../../../shared/onboarding/firstPromotion');
    const fp = await fpModule.getFirstPromotion({ workspaceId: t.ws, userId: t.owner });
    expect(fp.suggestion.audience).toEqual({ optedIn: 1, total: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------
// A world with EVERY router wired to the SAME Graph fake (the Graph client is injected through each router's
// module deps; the owner modules themselves are the real ones).
// ---------------------------------------------------------------------------------------------------------
const express = require('express');
const rateLimit = require('../../../shared/onboarding/rateLimit');
const { createFakeGraph, createFakeSend, fakeRandom } = require('../_fixtures');
const { createMetaGraphClient } = require('../../../shared/onboarding/metaClient');
const connectMod = require('../../../shared/onboarding/connect');
const statusRefresh = require('../../../shared/onboarding/statusRefresh');
const starterTemplates = require('../../../shared/onboarding/starterTemplates');
const notifications = require('../../../shared/onboarding/notifications');
const emailMod = require('../../../shared/onboarding/email');
const analytics = require('../../../shared/onboarding/analytics');

describe('(g) the connection answers expose status and level; the connect step is readable as the UI reads it', () => {
  test('connect/complete (also its replay), connect/resume and GET /connection answer with status AND level; /state step 3 is done', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'StatusLevel');
    const code = nextCode();
    const done = await t.complete({ code });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'connected', level: 'connected', nextStep: 'approvals' });
    expect(done.body.connection).toMatchObject({ status: 'connected' });
    const replay = await t.complete({ code });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'connected', level: 'connected' });
    const resumed = await w.post(t, '/connect/resume');
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: 'connected', level: 'connected' });
    const conn = await w.get(t, '/connection');
    expect(conn.body).toMatchObject({ status: 'connected', level: 'connected', causeCode: null, causePath: null, cause: null });
    expect(conn.body.numberMasked).toMatch(/\*+\d{4}$/);
    expect(JSON.stringify(conn.body)).not.toContain(w.graph.ids.merchantToken);
    const st = (await w.get(t, '/state')).body;
    expect(st.steps.connect.status).toBe('done');
    expect(st.connection).toMatchObject({ level: 'connected', causeCode: null, causePath: null });
    expect(st.connection.checkedAt).toBeTruthy();
    // a resume of a connected workspace after the level changed answers with the CURRENT level, not the stored one
    await WhatsAppConnection.updateOne({ workspaceId: t.ws }, { $set: { status: 'needs_attention', 'health.canSend': 'LIMITED' } });
    const later = await w.post(t, '/connect/resume');
    expect(later.body).toMatchObject({ status: 'needs_attention', level: 'needs_attention' });
  });

  test('FINISH_ONLY_WABA: answers waba_only/needs_attention and /state step 3 reads waba_only (not done), cause NUMBER_PENDING', async () => {
    const w = fullWorld({ graphOptions: { phoneStatus: 'PENDING' } });
    w.graph.scenarios.finishOnlyWaba();
    const t = await connectedTenant(w, 'WabaOnlyView', 'FINISH_ONLY_WABA');
    const done = await t.complete();
    expect(done.body).toMatchObject({ status: 'waba_only', level: 'needs_attention', nextStep: 'connect' });
    const st = (await w.get(t, '/state')).body;
    expect(st.steps.connect.status).toBe('waba_only');
    expect(st.nextStep).toBe('connect');
    expect(st.connection).toMatchObject({ level: 'needs_attention', causeCode: 'NUMBER_PENDING', causePath: '/setup/connect' });
    expect((await stateRow(t.ws)).steps.connect.status).toBe('todo'); // the STORED status is untouched (the gate reads it)
    expect((await w.get(t, '/connection')).body).toMatchObject({ status: 'waba_only', level: 'needs_attention', causeCode: 'NUMBER_PENDING' });
  });

  test('a run stopped at a failed step reads partial (503 CONNECT_PARTIAL), resume completes it and the step reads done', async () => {
    const w = fullWorld({ graphOptions: { phoneStatus: 'PENDING' } });
    w.graph.scenarios.networkDrop({ code: 'ETIMEDOUT', match: 'subscribe' });
    const t = await connectedTenant(w, 'PartialView');
    const failed = await t.complete();
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('CONNECT_PARTIAL');
    expect(failed.body.details).toMatchObject({ resumable: true, step: 'subscribe' });
    let st = (await w.get(t, '/state')).body;
    expect(st.steps.connect.status).toBe('partial');
    expect(st.connection.level).toBeNull(); // connecting is "not connected" for the UI level
    // the Embedded Signup problem lives on the connection row; /state and the Help context must show it (found by I1a)
    expect(st.lastError).toMatchObject({ code: 'META_UNREACHABLE', step: 'connect' });
    const help = await w.get(t, '/help-context');
    expect(help.body.lastError.code).toBe('META_UNREACHABLE');
    expect(help.body.prefilledText).toContain('META_UNREACHABLE');
    const resumed = await w.post(t, '/connect/resume');
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: 'connected', level: 'connected' });
    st = (await w.get(t, '/state')).body;
    expect(st.steps.connect.status).toBe('done');
    expect(st.lastError).toBeNull(); // a successful run clears it
  });

  test('POST /connection/refresh: 429 carries a Retry-After header (seconds) on the second call within the minute', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'RefreshLimit');
    await t.complete();
    const first = await w.post(t, '/connection/refresh');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'connected', level: 'connected' });
    const second = await w.post(t, '/connection/refresh');
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('RATE_LIMITED');
    expect(Number(second.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(second.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  test('disconnect/request impactKeys are limited to sending | templates | number', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'ImpactKeys');
    await t.complete();
    const req = await w.post(t, '/connection/disconnect/request');
    expect(req.status).toBe(200);
    expect(req.body.impactKeys.length).toBeGreaterThan(0);
    for (const k of req.body.impactKeys) expect(['sending', 'templates', 'number']).toContain(k);
    expect(req.body.impactKeys).toEqual(expect.arrayContaining(['sending', 'templates', 'number']));
  });

  test('GET /templates rows carry blockedReason (Arabic rows of an English-only merchant: arabic_not_reviewed or legal)', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'BlockedReason');
    await t.complete(); // seeds the starter set (connect.js -> starterTemplates.seedStarterTemplates)
    const res = await w.get(t, '/templates');
    expect(res.status).toBe(200);
    expect(res.body.templates.length).toBeGreaterThan(0);
    for (const row of res.body.templates) expect(Object.prototype.hasOwnProperty.call(row, 'blockedReason')).toBe(true);
    const ar = res.body.templates.filter((r) => r.language === 'ar');
    expect(ar.length).toBeGreaterThan(0);
    expect(ar.every((r) => r.blockedReason === 'arabic_not_reviewed' || r.blockedReason === 'legal')).toBe(true);
    expect(res.body.templates.filter((r) => r.language === 'en').every((r) => r.blockedReason === null)).toBe(true);
    expect(res.body.capacity).toMatchObject({ ceiling: expect.any(Number), total: expect.any(Number) });
  });
});

describe('connect.js <-> webhookEvents.clearMemo: a new WABA is recognised at once, not after the 60 s memo', () => {
  test('a merchant payload that was "unknown" before the connection is a merchant payload right after connect/complete', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'MemoClear');
    const body = { entry: [{ id: w.graph.ids.wabaId, changes: [{ field: 'account_update', value: { event: 'ACCOUNT_RECONNECTED' } }] }] };
    expect(await webhookEvents.matchesMerchant(body)).toBe(false); // the negative result is memoised for 60 s
    const spy = jest.spyOn(webhookEvents, 'clearMemo');
    try {
      expect((await t.complete()).status).toBe(200);
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    expect(await webhookEvents.matchesMerchant(body)).toBe(true);
    expect(await webhookEvents.matchesMerchant({ entry: [{ id: 'UNKNOWN_WABA_1' }] })).toBe(false);
    expect(await webhookEvents.matchesMerchant({ entry: [{ changes: [{ value: { metadata: { phone_number_id: w.graph.ids.phoneId } } }] }] })).toBe(true); // matched by phone id too
  });
});

describe('statusRefresh.markNeedsReconnect <-> connect.reportGraphError: status reconnect_required, one notification, whatever the order', () => {
  const reconnectNotes = (ws) => OnboardingNotification.find({ workspaceId: ws, kind: 'reconnect_needed' }).lean();

  test('markNeedsReconnect first, then reportGraphError: one row, one notification, status reconnect_required', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'ReconnectA');
    await t.complete();
    const err = { code: 190, subcode: 463, httpStatus: 400, kind: 'reconnect' };
    const r = await statusRefresh.markNeedsReconnect(t.ws, 'TOKEN_EXPIRED', { connect: { reportGraphError: (ws, e) => connectMod.reportGraphError(ws, e) } }, { err });
    expect(r).toEqual({ changed: true });
    await connectMod.reportGraphError(t.ws, err);
    const row = await connRow(t.ws);
    expect(row).toMatchObject({ needsReconnect: true, status: 'reconnect_required', reconnectReason: 'TOKEN_EXPIRED' });
    expect(await reconnectNotes(t.ws)).toHaveLength(1);
    expect(statusRefresh.connectionLevel(row)).toBe('reconnect_needed');
    // the gate cache sees it at once, and the /state level follows
    expect((await state.getGateState(t.ws)).conn).toMatchObject({ status: 'reconnect_required', needsReconnect: true });
    expect((await w.get(t, '/state')).body.connection.level).toBe('reconnect_needed');
  });

  test('reportGraphError first, then markNeedsReconnect: still one notification, same pair of fields', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'ReconnectB');
    await t.complete();
    await connectMod.reportGraphError(t.ws, { code: 190, subcode: 463, httpStatus: 400, kind: 'reconnect' });
    const second = await statusRefresh.markNeedsReconnect(t.ws, 'TOKEN_EXPIRED', {}, {});
    expect(second.changed).toBe(false);
    expect(await reconnectNotes(t.ws)).toHaveLength(1);
    expect(await connRow(t.ws)).toMatchObject({ needsReconnect: true, status: 'reconnect_required' });
  });

  test('a successful reconnect clears both fields again (needsReconnect false, status connected)', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'ReconnectC');
    await t.complete();
    await connectMod.reportGraphError(t.ws, { code: 190, httpStatus: 400, kind: 'reconnect' });
    const rc = await w.post(t, '/connection/reconnect');
    expect(rc.status).toBe(200);
    expect(rc.body.reconnect).toMatchObject({ expectedWabaId: w.graph.ids.wabaId });
    const done = await w.post(t, '/connect/complete', { attemptId: rc.body.attemptId, code: nextCode(), session: flat(w.graph.session('FINISH')) });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'connected', level: 'connected' });
    expect(await connRow(t.ws)).toMatchObject({ needsReconnect: false, status: 'connected' });
  });
});

describe('tokenVault: the same AAD purposes everywhere; the merchant token only ever reaches the Graph client', () => {
  test('token and PIN decrypt only with their own workspace + purpose; no secret appears in any log, body or event', async () => {
    const spy = H.spyConsole();
    try {
      const w = fullWorld({ graphOptions: { phoneStatus: 'PENDING' } });
      const t = await connectedTenant(w, 'VaultAad');
      const code = nextCode();
      const done = await t.complete({ code });
      expect(done.status).toBe(200);
      const row = await connRow(t.ws);
      const token = vault.decrypt(row.tokenEncrypted, { workspaceId: t.ws, purpose: 'token' });
      expect(token).toBe(w.graph.ids.merchantToken);
      const pin = vault.decrypt(row.pinEncrypted, { workspaceId: t.ws, purpose: 'pin' });
      expect(pin).toMatch(/^\d{6}$/);
      expect(() => vault.decrypt(row.tokenEncrypted, { workspaceId: t.ws, purpose: 'pin' })).toThrow();
      expect(() => vault.decrypt(row.pinEncrypted, { workspaceId: t.ws, purpose: 'token' })).toThrow();
      expect(() => vault.decrypt(row.tokenEncrypted, { workspaceId: H.newId(), purpose: 'token' })).toThrow();

      // every later reader of the token (refresh, template submit) works through the same envelope
      expect((await w.post(t, '/connection/refresh')).status).toBe(200);
      expect((await w.post(t, '/templates/submit')).status).toBe(200);
      const logs = spy.lines;
      w.graph.assertMerchantTokenOnly(w.graph.ids.merchantToken);
      w.graph.assertNeverUsedToken(w.graph.ids.platformToken);
      w.graph.assertNoForeignCalls();
      w.graph.assertNoLeak([code, pin, w.graph.ids.merchantToken], logs);
      const events = JSON.stringify(await OnboardingEvent.find({ workspaceId: t.ws }).lean());
      const notes = JSON.stringify(await OnboardingNotification.find({ workspaceId: t.ws }).lean());
      for (const secret of [code, pin, w.graph.ids.merchantToken]) {
        expect(events).not.toContain(secret);
        expect(notes).not.toContain(secret);
        expect(logs.join('\n')).not.toContain(secret);
      }
    } finally { spy.restore(); }
  });
});

describe('state.invalidate after every write that changes sub / conn / enrolment', () => {
  test('connect (step 3 + connection), reconnect flag, admin deactivate/activate, disconnect: the cached gate state is fresh at once', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'GateCache');
    let gs = await state.getGateState(t.ws); // warms the (30 s) cache
    expect(gs).toMatchObject({ enrolled: true, connectDone: false, locked: true });
    await t.complete();
    gs = await state.getGateState(t.ws);
    expect(gs).toMatchObject({ connectDone: true, locked: false, conn: { status: 'connected', needsReconnect: false } });
    const rq = await w.post(t, '/connection/disconnect/request');
    await connectMod.reportGraphError(t.ws, { code: 190, httpStatus: 400, kind: 'reconnect' });
    expect((await state.getGateState(t.ws)).conn).toMatchObject({ needsReconnect: true });
    await state.adminDeactivate({ workspaceId: t.ws, by: 'cli:test', notes: 'cache check' }, H.noTrack);
    gs = await state.getGateState(t.ws);
    expect(gs.sub.state).not.toBe('active');
    expect(gs.locked).toBe(true);
    await state.adminActivate({ workspaceId: t.ws, by: 'cli:test', notes: 'cache check back' }, H.noTrack);
    expect((await state.getGateState(t.ws)).sub.state).toBe('active');
    const dc = await w.post(t, '/connection/disconnect', { confirmationToken: rq.body.confirmationToken, confirmText: 'DISCONNECT' });
    expect(dc.status).toBe(200);
    gs = await state.getGateState(t.ws);
    expect(gs).toMatchObject({ connectDone: false, conn: { status: 'disconnected' } });
  });
});

describe('analytics: every OnboardingEvent the modules write passes the whitelist', () => {
  test('a whole setup leaves only whitelisted types, valid codes / reasons and no secret-looking value', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'EventsWhitelist');
    await t.complete();
    await w.get(t, '/approvals');
    await w.post(t, '/prompts/customers', { state: 'skipped' });
    await w.post(t, '/prompts/products', { state: 'skipped' });
    await w.post(t, '/first-promotion/state', { state: 'skipped' });
    await w.post(t, '/number/support-request', { message: 'help me' });
    const rows = await OnboardingEvent.find({ workspaceId: t.ws }).lean();
    expect(rows.length).toBeGreaterThan(5);
    for (const e of rows) {
      expect(analytics.EVENT_TYPES).toContain(e.type);
      if (e.step) expect(analytics.EVENT_STEPS).toContain(e.step);
      if (e.code) expect(e.code).toMatch(/^[A-Z][A-Z0-9_]{1,63}$/);
      if (e.reason) expect(e.reason).toMatch(/^[a-z0-9_ .:-]{1,80}$/);
    }
    const types = new Set(rows.map((e) => e.type));
    for (const must of ['step_enter', 'step_complete', 'connect_result', 'step_skip', 'help_opened']) expect(types.has(must)).toBe(true);
    expect(await OnboardingEvent.countDocuments({ workspaceId: t.ws })).toBeLessThanOrEqual(analytics.CAPS.PER_WORKSPACE);
  });
});

describe('email.sendSupportEmail <-> support.createSupportRequest, notifications.notify <-> email.sendNotificationEmail (real chain, fake Resend)', () => {
  test('a number-help request mails the desk with the real renderSupport output and stores emailSentAt; the notification is created', async () => {
    const w = fullWorld();
    const t = await enrolledTenant('SupportMail');
    await w.put(t, '/business', { ...BUSINESS, contactEmail: 'owner@shop.example.test' });
    const res = await w.post(t, '/number/support-request', { message: 'Please help me get a number <b>now</b>' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: false });
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]).toMatchObject({ to: 'help@desk.example.test', replyTo: 'owner@shop.example.test' });
    expect(w.mail.sent[0].html).toContain('&lt;b&gt;now&lt;/b&gt;');
    expect(w.mail.sent[0].html).not.toContain('<b>now</b>');
    const SupportRequest = require('../../../models/OnboardingSupportRequest');
    const row = await SupportRequest.findOne({ workspaceId: t.ws }).lean();
    expect(row.emailSentAt).toBeTruthy();
    expect(row.emailError).toBeUndefined();
    expect(await OnboardingNotification.countDocuments({ workspaceId: t.ws, kind: 'help_received' })).toBe(1);
    expect((await stateRow(t.ws)).number.helpRequestId).toBe(String(row._id));
  });

  test('notify(email:true) mails the owner through email.sendNotificationEmail; a failing provider is retried by retryEmails', async () => {
    const mail = createFakeSend({ failFirst: 1, failWith: { statusCode: 503 } });
    const n = notifications.createNotifications({ emailDeps: { send: mail.send, resolveRecipient: async () => ({ to: 'owner@shop.example.test', language: 'en' }) } });
    const t = await enrolledTenant('NotifyMail');
    const r = await n.notify({ workspaceId: t.ws, kind: 'reconnect_needed', dedupeKey: 'cross:1', params: { reason: 'TOKEN_REVOKED' }, email: true, severity: 'action', actionPath: '/setup/connect' });
    expect(r.created).toBe(true);
    await r.emailPromise;
    let row = await OnboardingNotification.findOne({ workspaceId: t.ws, dedupeKey: 'cross:1' }).lean();
    expect(row.emailError).toBeTruthy();
    expect(row.emailSentAt).toBeFalsy();
    const retry = await n.retryEmails({ now: new Date(), limit: 20 });
    expect(retry.attempted).toBeGreaterThanOrEqual(1);
    row = await OnboardingNotification.findOne({ workspaceId: t.ws, dedupeKey: 'cross:1' }).lean();
    expect(row.emailSentAt).toBeTruthy();
    expect(mail.sent).toHaveLength(1);
    // the same dedupe key again sends nothing
    const again = await n.notify({ workspaceId: t.ws, kind: 'reconnect_needed', dedupeKey: 'cross:1', params: {}, email: true });
    expect(again.created).toBe(false);
    expect(mail.sent).toHaveLength(1);
  });
});

describe('display name never reported by Meta: the row says waiting, the Step 4 summary blocks nothing', () => {
  test('nameStatusMissing: displayName waiting + all rows blocking:false, step 4 / next step / completion are not held back', async () => {
    const w = fullWorld();
    w.graph.scenarios.nameStatusMissing();
    const t = await connectedTenant(w, 'NameMissing');
    expect((await t.complete()).status).toBe(200);
    const row = await connRow(t.ws);
    expect(row.displayName.mapped).toBe('unknown');
    expect(statusRefresh.isWaiting({ ...row, verification: { mapped: 'done' } })).toBe(false); // an unknown name never keeps the 15 minute poll alive
    const appr = await w.get(t, '/approvals');
    expect(appr.status).toBe(200);
    const dn = appr.body.rows.find((r) => r.key === 'displayName');
    expect(dn.status).toBe('waiting');
    for (const r of appr.body.rows) expect(r.blocking).toBe(false);
    expect(['waiting', 'needs_you']).toContain(appr.body.overall);
    const st = (await w.get(t, '/state')).body;
    expect(st.steps.approvals.status).toBe('in_progress');
    expect(st.nextStep).toBe('customers'); // moved on although the name is "waiting"
    await w.post(t, '/prompts/customers', { state: 'skipped' });
    await w.post(t, '/prompts/products', { state: 'skipped' });
    await w.post(t, '/first-promotion/state', { state: 'skipped' });
    const fin = (await w.get(t, '/state')).body;
    expect(fin.view).toBe('done'); // setup can finish with step 4 still open
    expect(fin.progress.completedAt).toBeTruthy();
  });
});

describe('webhookEvents -> starterTemplates.applyTemplateStatusUpdate -> approvals row 5 (real chain)', () => {
  test('a signed merchant template-status webhook approves the stored row, notifies once and the Step 4 templates row counts it', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'WebhookTemplates');
    await t.complete();
    const sub = await starterTemplates.submitPending({ workspaceId: t.ws }, { metaClient: w.meta });
    expect(sub.submitted).toBeGreaterThanOrEqual(1);
    const row = await OnboardingTemplate.findOne({ workspaceId: t.ws, source: 'library', language: 'en', metaTemplateId: { $ne: null } }).lean();
    expect(row.metaStatus).toBe('PENDING');
    const body = { object: 'whatsapp_business_account', entry: [{ id: w.graph.ids.wabaId, time: 1739321024, changes: [{ field: 'message_template_status_update', value: {
      event: 'APPROVED', message_template_id: row.metaTemplateId, message_template_name: row.metaTemplateName, message_template_language: 'en', reason: 'NONE',
    } }] }] };
    const req = { body, metaSignature: 'valid' };
    expect(await webhookEvents.intercept(req)).toBe(true); // a merchant entry is processed here and removed from the legacy handler's body
    expect(req.body.entry).toEqual([]);
    await req.onboardingProcessing;
    const after = await OnboardingTemplate.findById(row._id).lean();
    expect(after.metaStatus).toBe('APPROVED');
    // one in-app notification for the template (no e-mail) + the "first template approved" milestone (the only e-mailed approval)
    expect(await OnboardingNotification.countDocuments({ workspaceId: t.ws, kind: 'template_approved', dedupeKey: /^template:/ })).toBe(1);
    expect(await OnboardingNotification.countDocuments({ workspaceId: t.ws, kind: 'template_approved', dedupeKey: 'templates:first_approved' })).toBe(1);
    expect(await OnboardingNotification.countDocuments({ workspaceId: t.ws, kind: 'template_approved' })).toBe(2);
    // replayed delivery: de-duplicated, no second notification
    const again = { body: JSON.parse(JSON.stringify(body)), metaSignature: 'valid' };
    await webhookEvents.intercept(again);
    await again.onboardingProcessing;
    expect(await OnboardingNotification.countDocuments({ workspaceId: t.ws, kind: 'template_approved' })).toBe(2);
    const view = await require('../../../shared/onboarding/approvals').buildApprovals(t.ws);
    expect(view.rows.find((r) => r.key === 'templates').counts.approved).toBe(1);
    // an UNSIGNED copy of a different event is only a hint: no state change
    const hint = { body: { object: 'whatsapp_business_account', entry: [{ id: w.graph.ids.wabaId, time: 1739321025, changes: [{ field: 'message_template_status_update', value: { event: 'REJECTED', message_template_id: row.metaTemplateId, message_template_name: row.metaTemplateName, message_template_language: 'en' } }] }] }, metaSignature: 'absent' };
    await webhookEvents.intercept(hint);
    await hint.onboardingProcessing;
    expect((await OnboardingTemplate.findById(row._id).lean()).metaStatus).toBe('APPROVED');
  });
});
