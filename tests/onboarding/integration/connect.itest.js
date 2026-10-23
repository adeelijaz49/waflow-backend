'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database so suites in one jest run never see each other's workspaces
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_connect`;
assertThrowawayDb();

// Embedded Signup connect: REAL connect module + routes + models on the throwaway mongod, Graph = fakeGraph.
const request = require('supertest');
const mongoose = require('mongoose');
const H = require('./_connectHarness');
const vault = require('../../../shared/onboarding/tokenVault');
const state = require('../../../shared/onboarding/state');
const { createFakeGraph } = require('../_fixtures');

const { WhatsAppConnection, WhatsAppClaim, OnboardingState } = H.models;
jest.setTimeout(60000);

let restoreEnv;
let seq = 0;
const nextCode = () => `AQDcodeSECRET${String(++seq).padStart(4, '0')}valueXYZ`;
const flat = (s) => Object.assign({ event: s.event }, s.data);
const connRow = (ws) => WhatsAppConnection.findOne({ workspaceId: ws }).select('+tokenEncrypted +pinEncrypted').lean();

const api = (w) => ({
  config: (t, who = 'owner') => request(w.app).get('/api/onboarding/connect/config').set(w.asUser(t, who)),
  complete: (t, attemptId, body = {}, who = 'owner') => request(w.app).post('/api/onboarding/connect/complete').set(w.asUser(t, who)).send({
    attemptId, code: body.code || nextCode(), session: body.session === undefined ? flat(w.graph.session('FINISH')) : body.session,
  }),
  resume: (t, who = 'owner') => request(w.app).post('/api/onboarding/connect/resume').set(w.asUser(t, who)).send({}),
  event: (t, body, who = 'owner') => request(w.app).post('/api/onboarding/connect/event').set(w.asUser(t, who)).send(body),
  connection: (t, who = 'owner') => request(w.app).get('/api/onboarding/connection').set(w.asUser(t, who)),
  reconnect: (t, who = 'owner') => request(w.app).post('/api/onboarding/connection/reconnect').set(w.asUser(t, who)).send({}),
  disconnectRequest: (t, who = 'owner') => request(w.app).post('/api/onboarding/connection/disconnect/request').set(w.asUser(t, who)).send({}),
  disconnect: (t, body, who = 'owner') => request(w.app).post('/api/onboarding/connection/disconnect').set(w.asUser(t, who)).send(body),
});

beforeAll(async () => {
  restoreEnv = H.setEnv();
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([OnboardingState.init(), WhatsAppConnection.init(), H.models.Membership.init()]);
});
afterAll(async () => { restoreEnv(); await mongoose.disconnect(); });
beforeEach(() => state.clearCache());

function world(opts = {}) {
  const starter = { calls: 0, seedStarterTemplates: async () => { starter.calls += 1; return {}; } };
  const w = H.createWorld({ ...opts, connectDeps: { starterTemplates: starter, ...(opts.connectDeps || {}) } });
  w.starter = starter;
  w.api = api(w);
  return w;
}
async function begin(w, t) {
  const res = await w.api.config(t);
  expect(res.status).toBe(200);
  return res.body.attemptId;
}
const names = (w) => w.graph.calls.map((c) => c.name);

describe('GET /connect/config', () => {
  test('payload shape, no secret, creates an attempt', async () => {
    const w = world();
    const t = await H.makeTenant('Cfg');
    const res = await w.api.config(t);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, appId: 'APP_ID_FIXTURE', configId: 'CONFIG_ID_FIXTURE', graphVersion: 'v25.0', extras: {}, sdkLocale: 'en_US', expiresInSec: 900, reconnect: null });
    expect(res.body.attemptId).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(res.body)).not.toContain(H.ENV.WA_APP_SECRET);
    const row = await connRow(t.ws);
    expect(row.connectAttempt.id).toBe(res.body.attemptId);
    expect(row.connectAttempt.expectWabaId).toBeNull();
    expect(w.graph.calls).toHaveLength(0);
  });
  test('steps 1-2 must be done or skipped (409 STEP_PREREQUISITE)', async () => {
    const w = world();
    const t = await H.makeTenant('NoSteps', { steps: false });
    const res = await w.api.config(t);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STEP_PREREQUISITE');
    await OnboardingState.updateOne({ workspaceId: t.ws }, { $set: { 'steps.business.status': 'done', 'steps.number.status': 'skipped' } });
    expect((await w.api.config(t)).status).toBe(200);
  });
  test('503 CONNECT_NOT_CONFIGURED without the config id', async () => {
    const w = world();
    const t = await H.makeTenant('NoCfg');
    const old = process.env.META_ES_CONFIG_ID;
    delete process.env.META_ES_CONFIG_ID;
    try {
      const res = await w.api.config(t);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('CONNECT_NOT_CONFIGURED');
    } finally { process.env.META_ES_CONFIG_ID = old; }
  });
  test('a legacy workspace gets the same 404 as an unknown route', async () => {
    const w = world();
    const ws = await H.makeWorkspace('Legacy');
    const res = await request(w.app).get('/api/onboarding/connect/config').set({ 'x-test-user': JSON.stringify({ id: H.newId(), workspaceId: ws, role: 'owner' }) });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ONBOARDING_NOT_AVAILABLE');
  });
});

describe('happy path', () => {
  test('phone not registered yet: ends connected in 8 mocked calls, token and PIN encrypted at rest', async () => {
    const w = world({ graphOptions: { phoneStatus: 'PENDING' } });
    const t = await H.makeTenant('Happy');
    const attemptId = await begin(w, t);
    const code = nextCode();
    const res = await w.api.complete(t, attemptId, { code });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('connected');
    expect(res.body.nextStep).toBe('approvals');
    expect(res.body.steps).toEqual({ exchange: 'done', debugToken: 'done', phone: 'done', register: 'done', subscribe: 'done', details: 'done' });
    expect(res.body.connection.numberMasked).toMatch(/4567$/);
    expect(JSON.stringify(res.body)).not.toContain('966 55 123');
    expect(names(w)).toEqual(['exchange', 'debugToken', 'listPhones', 'getPhone', 'register', 'subscribe', 'listSubscribed', 'getWaba']); // listPhones: the browser's phone id is checked against the account's numbers first (R7-08)
    // merchant token only (never the platform token), in the Authorization header
    w.graph.assertMerchantTokenOnly(w.graph.ids.merchantToken);
    w.graph.assertNeverUsedToken(w.graph.ids.platformToken);
    w.graph.calls.filter((c) => !['exchange', 'debugToken'].includes(c.name)).forEach((c) => {
      expect(c.authorization).toBe(`Bearer ${w.graph.ids.merchantToken}`);
      expect(c.tokenSource).toBe('header');
    });
    expect(w.graph.callsTo('debugToken')[0].tokenKind).toBe('app');
    expect(w.graph.callsTo('register')[0].data).toEqual({ messaging_product: 'whatsapp', pin: '482913' });

    const row = await connRow(t.ws);
    expect(row.status).toBe('connected');
    expect(row.tokenEncrypted).toMatch(/^v1:/);
    expect(row.tokenEncrypted).not.toContain(w.graph.ids.merchantToken);
    expect(vault.decrypt(row.tokenEncrypted, { workspaceId: t.ws, purpose: 'token' })).toBe(w.graph.ids.merchantToken);
    expect(() => vault.decrypt(row.tokenEncrypted, { workspaceId: H.newId(), purpose: 'token' })).toThrow();
    expect(() => vault.decrypt(row.tokenEncrypted, { workspaceId: t.ws, purpose: 'pin' })).toThrow();
    expect(vault.decrypt(row.pinEncrypted, { workspaceId: t.ws, purpose: 'pin' })).toBe('482913');
    expect(row.pinEncrypted).not.toContain('482913');
    expect(row.connectAttempt.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row.ids).toMatchObject({ wabaId: w.graph.ids.wabaId, phoneNumberId: w.graph.ids.phoneId, businessId: w.graph.ids.businessId, wabaSource: 'event' });
    expect(row.display).toMatchObject({ last4: '4567', verifiedName: 'Acme Coffee' });
    expect(row.registration.registeredAt).toBeTruthy();
    expect(row.webhook.subscribed).toBe(true);
    expect(row.nextCheckAt.getTime() - row.connectedAt.getTime()).toBeGreaterThan(110000);
    expect(row.connectedByUserId).toBe(t.owner);
    expect(row.connectLockUntil).toBeNull();
    // default queries never select the secrets
    const plain = await WhatsAppConnection.findOne({ workspaceId: t.ws }).lean();
    expect(plain.tokenEncrypted).toBeUndefined();
    expect(plain.pinEncrypted).toBeUndefined();
    // claims, step 3, prompts, seeding, notification, gate cache
    expect((await WhatsAppClaim.findById(`waba:${w.graph.ids.wabaId}`).lean()).workspaceId.toString()).toBe(t.ws);
    expect((await WhatsAppClaim.findById(`phone:${w.graph.ids.phoneId}`).lean()).workspaceId.toString()).toBe(t.ws);
    const st = await OnboardingState.findOne({ workspaceId: t.ws }).lean();
    expect(st.steps.connect.status).toBe('done');
    expect(st.progress.currentStep).toBeGreaterThanOrEqual(4);
    expect(st.prompts.promptedAt).toBeTruthy();
    expect(w.starter.calls).toBe(1);
    expect(w.outbox.map((n) => n.kind)).toEqual(['connected']);
    const gs = await state.getGateState(t.ws);
    expect(gs.connectDone).toBe(true);
    expect(gs.conn.status).toBe('connected');
  });

  test('phone already CONNECTED at Meta: register is skipped, 7 calls', async () => {
    const w = world();
    const t = await H.makeTenant('AlreadyReg');
    const res = await w.api.complete(t, await begin(w, t));
    expect(res.status).toBe(200);
    expect(names(w)).toEqual(['exchange', 'debugToken', 'listPhones', 'getPhone', 'subscribe', 'listSubscribed', 'getWaba']);
    const row = await connRow(t.ws);
    expect(row.connectSteps.register.status).toBe('skipped');
    expect(row.pinEncrypted).toBeUndefined();
  });

  test('FINISH_ONLY_WABA: status waba_only, no phone or register call, step 3 not done', async () => {
    const w = world();
    w.graph.scenarios.finishOnlyWaba();
    const t = await H.makeTenant('OnlyWaba');
    const res = await w.api.complete(t, await begin(w, t), { session: flat(w.graph.session('FINISH_ONLY_WABA')) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('waba_only');
    expect(res.body.nextStep).toBe('connect');
    expect(names(w)).toEqual(['exchange', 'debugToken', 'subscribe', 'listSubscribed', 'getWaba']);
    const st = await OnboardingState.findOne({ workspaceId: t.ws }).lean();
    expect(st.steps.connect.status).not.toBe('done');
    expect(w.outbox).toHaveLength(0);
    const row = await connRow(t.ws);
    expect(row.status).toBe('waba_only');
    expect(row.connectSteps.phone.status).toBe('skipped');
  });

  test('a number added later: resume from waba_only discovers it, registers and connects', async () => {
    const w = world({ graphOptions: { phoneStatus: 'PENDING' } });
    w.graph.scenarios.finishOnlyWaba();
    const t = await H.makeTenant('LaterPhone');
    await w.api.complete(t, await begin(w, t), { session: flat(w.graph.session('FINISH_ONLY_WABA')) });
    w.graph.addPhone();
    const res = await w.api.resume(t);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('connected');
    expect(names(w)).toContain('register');
    expect((await connRow(t.ws)).ids.phoneNumberId).toBe(w.graph.ids.phoneId);
  });

  test('coexistence event: register is never called', async () => {
    const w = world({ graphOptions: { phoneStatus: 'PENDING' } });
    const t = await H.makeTenant('Coex');
    const res = await w.api.complete(t, await begin(w, t), { session: flat(w.graph.session('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING')) });
    expect(res.status).toBe(200);
    expect(w.graph.callsTo('register')).toHaveLength(0);
    expect((await connRow(t.ws)).connectSteps.register.status).toBe('skipped');
  });

  test('no session event (lost message): the first granular target is used', async () => {
    const w = world();
    const t = await H.makeTenant('NoEvent');
    const res = await w.api.complete(t, await begin(w, t), { session: {} });
    expect(res.status).toBe(200);
    const row = await connRow(t.ws);
    expect(row.ids.wabaId).toBe(w.graph.ids.wabaId);
    expect(row.ids.wabaSource).toBe('debug_token');
    expect(w.graph.callsTo('listPhones')).toHaveLength(1);
  });

  test('several WABAs and a session without waba_id: ambiguity -> CONNECT_AMBIGUOUS_WABA', async () => {
    const w = world({ graphOptions: { extraWabaIds: ['1098765432109999'] } });
    const t = await H.makeTenant('Ambiguous');
    const res = await w.api.complete(t, await begin(w, t), { session: { event: 'FINISH', business_id: w.graph.ids.businessId } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONNECT_AMBIGUOUS_WABA');
    expect(res.body.details).toMatchObject({ step: 'debugToken', resumable: true });
  });

  test('health not AVAILABLE: connected with status needs_attention', async () => {
    const w = world();
    w.graph.setHealth('LIMITED');
    const t = await H.makeTenant('Limited');
    const res = await w.api.complete(t, await begin(w, t));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('needs_attention');
    expect((await connRow(t.ws)).health.canSend).toBe('LIMITED');
  });
});

describe('attempt rules, replay and concurrency', () => {
  test('CONNECT_ATTEMPT_INVALID: unknown id, no attempt, and an attempt older than 15 minutes', async () => {
    const w = world();
    const t = await H.makeTenant('Attempts');
    let res = await w.api.complete(t, 'f'.repeat(32));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONNECT_ATTEMPT_INVALID');
    const attemptId = await begin(w, t);
    res = await w.api.complete(t, 'e'.repeat(32));
    expect(res.body.code).toBe('CONNECT_ATTEMPT_INVALID');
    await WhatsAppConnection.updateOne({ workspaceId: t.ws }, { $set: { 'connectAttempt.createdAt': new Date(Date.now() - 16 * 60 * 1000) } });
    res = await w.api.complete(t, attemptId);
    expect(res.body.code).toBe('CONNECT_ATTEMPT_INVALID');
    expect(w.graph.calls).toHaveLength(0);
  });

  test('replay of the same attempt returns the stored result with ZERO new Graph calls', async () => {
    const w = world();
    const t = await H.makeTenant('Replay');
    const attemptId = await begin(w, t);
    const first = await w.api.complete(t, attemptId);
    const callsAfterFirst = w.graph.calls.length;
    const again = await w.api.complete(t, attemptId, { code: nextCode() });
    const sameCode = await w.api.complete(t, attemptId);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(sameCode.body).toEqual(first.body);
    expect(w.graph.calls).toHaveLength(callsAfterFirst);
    expect(w.graph.state.exchanges).toBe(1);
  });

  test('concurrent double click: one exchange only', async () => {
    const w = world({ graphOptions: { delayMs: 25 } });
    const t = await H.makeTenant('Double');
    const attemptId = await begin(w, t);
    const code = nextCode();
    const [a, b] = await Promise.all([w.api.complete(t, attemptId, { code }), w.api.complete(t, attemptId, { code })]);
    expect(w.graph.callsTo('exchange')).toHaveLength(1);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);
    const loser = [a, b].find((r) => r.status === 409);
    if (loser) expect(loser.body.code).toBe('CONNECT_IN_PROGRESS');
    expect((await connRow(t.ws)).status).toBe('connected');
  });

  test('a new GET /connect/config replaces the attempt: the old attempt id is rejected', async () => {
    const w = world();
    const t = await H.makeTenant('Replace');
    const first = await begin(w, t);
    const second = await begin(w, t);
    expect(second).not.toBe(first);
    expect((await w.api.complete(t, first)).body.code).toBe('CONNECT_ATTEMPT_INVALID');
    expect((await w.api.complete(t, second)).status).toBe(200);
  });

  test('missing encryption key -> 503 ENCRYPTION_NOT_CONFIGURED before ANY Graph call', async () => {
    const w = world();
    const t = await H.makeTenant('NoKey');
    const attemptId = await begin(w, t);
    const old = process.env.WA_TOKEN_ENCRYPTION_KEY;
    delete process.env.WA_TOKEN_ENCRYPTION_KEY;
    try {
      const res = await w.api.complete(t, attemptId);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('ENCRYPTION_NOT_CONFIGURED');
      expect(w.graph.calls).toHaveLength(0);
      expect((await w.api.config(t)).body.code).toBe('ENCRYPTION_NOT_CONFIGURED');
    } finally { process.env.WA_TOKEN_ENCRYPTION_KEY = old; }
    expect((await connRow(t.ws)).tokenEncrypted).toBeUndefined();
  });

  test('steps 1-2 not done -> 409 STEP_PREREQUISITE on complete as well', async () => {
    const w = world();
    const t = await H.makeTenant('Prereq');
    const attemptId = await begin(w, t);
    await OnboardingState.updateOne({ workspaceId: t.ws }, { $set: { 'steps.number.status': 'todo' } });
    const res = await w.api.complete(t, attemptId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STEP_PREREQUISITE');
    expect(w.graph.calls).toHaveLength(0);
  });
});

describe('failing steps leave a resumable state', () => {
  test('exchange 400 -> CONNECT_CODE_INVALID_OR_EXPIRED, nothing stored, the same attempt works with a fresh code', async () => {
    const w = world();
    const t = await H.makeTenant('ExchangeFail');
    const attemptId = await begin(w, t);
    w.graph.scenarios.codeExpired();
    const res = await w.api.complete(t, attemptId);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CONNECT_CODE_INVALID_OR_EXPIRED');
    let row = await connRow(t.ws);
    expect(row.tokenEncrypted).toBeUndefined();
    expect(row.status).toBe('not_connected');
    expect(row.connectAttempt.usedAt).toBeUndefined();
    expect((await w.api.complete(t, attemptId)).status).toBe(200);
    row = await connRow(t.ws);
    expect(row.status).toBe('connected');
  });

  test('exchange network drop -> 503 META_UNREACHABLE, nothing stored', async () => {
    const w = world();
    const t = await H.makeTenant('ExchangeNet');
    const attemptId = await begin(w, t);
    w.graph.scenarios.networkDrop({ code: 'ETIMEDOUT', match: 'exchange' });
    const res = await w.api.complete(t, attemptId);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('META_UNREACHABLE');
    expect((await connRow(t.ws)).tokenEncrypted).toBeUndefined();
  });

  test('browser waba_id not in the token granular scopes -> CONNECT_WABA_MISMATCH; resume completes from the stored token', async () => {
    const w = world();
    const t = await H.makeTenant('Mismatch');
    const attemptId = await begin(w, t);
    const res = await w.api.complete(t, attemptId, { session: { event: 'FINISH', waba_id: '999999999999', phone_number_id: w.graph.ids.phoneId } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONNECT_WABA_MISMATCH');
    expect(res.body.details).toMatchObject({ step: 'debugToken', cause: 'CONNECT_WABA_MISMATCH', resumable: true });
    let row = await connRow(t.ws);
    expect(row.status).toBe('connecting');
    expect(row.connectSteps.exchange.status).toBe('done');
    expect(row.connectSteps.debugToken).toMatchObject({ status: 'failed', errorCode: 'CONNECT_WABA_MISMATCH' });
    expect(row.ids.wabaId).toBeUndefined();
    expect(await WhatsAppClaim.countDocuments({ workspaceId: t.ws })).toBe(0);
    expect(row.lastError.code).toBe('CONNECT_WABA_MISMATCH');
    const exchanges = w.graph.callsTo('exchange').length;
    const ok = await w.api.resume(t);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('connected');
    expect(w.graph.callsTo('exchange')).toHaveLength(exchanges); // no code needed, no second exchange
    row = await connRow(t.ws);
    expect(row.ids.wabaId).toBe(w.graph.ids.wabaId);
    expect(row.lastError).toBeUndefined();
  });

  test('claim conflict (WABA owned by another workspace) -> CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT; after release, resume completes', async () => {
    const w = world();
    const a = await H.makeTenant('ClaimA');
    const b = await H.makeTenant('ClaimB');
    expect((await w.api.complete(a, await begin(w, a))).status).toBe(200);
    const res = await w.api.complete(b, await begin(w, b));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT');
    expect(res.body.nextStep).toBe('number');
    let row = await connRow(b.ws);
    expect(row.status).toBe('connecting');
    expect(row.connectSteps.debugToken.status).toBe('failed');
    expect((await WhatsAppClaim.findById(`waba:${w.graph.ids.wabaId}`).lean()).workspaceId.toString()).toBe(a.ws);
    // A disconnects: claims released (never deleted), B can finish from the stored token
    const req = await w.api.disconnectRequest(a);
    expect((await w.api.disconnect(a, { confirmationToken: req.body.confirmationToken, confirmText: 'DISCONNECT' })).status).toBe(200);
    const claim = await WhatsAppClaim.findById(`waba:${w.graph.ids.wabaId}`).lean();
    expect(claim).toBeTruthy();
    expect(claim.releasedAt).toBeTruthy();
    const ok = await w.api.resume(b);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('connected');
    row = await connRow(b.ws);
    expect((await WhatsAppClaim.findById(`waba:${w.graph.ids.wabaId}`).lean()).workspaceId.toString()).toBe(b.ws);
    expect((await WhatsAppClaim.findById(`waba:${w.graph.ids.wabaId}`).lean()).releasedAt).toBeNull();
  });

  test('register 133016 stops with CONNECT_REGISTER_RATE_LIMITED after ONE attempt; resume completes with the stored PIN', async () => {
    const w = world({ graphOptions: { phoneStatus: 'PENDING' } });
    const t = await H.makeTenant('Register133016');
    w.graph.scenarios.register133016();
    const res = await w.api.complete(t, await begin(w, t));
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('CONNECT_REGISTER_RATE_LIMITED');
    expect(res.body.details).toMatchObject({ step: 'register', resumable: true });
    expect(w.graph.callsTo('register')).toHaveLength(1);
    let row = await connRow(t.ws);
    expect(row.status).toBe('connecting');
    expect(row.connectSteps.register.status).toBe('failed');
    expect(row.registration.attempts).toBe(1);
    expect(row.registration.lastErrorCode).toBe('CONNECT_REGISTER_RATE_LIMITED');
    expect(vault.decrypt(row.pinEncrypted, { workspaceId: t.ws, purpose: 'pin' })).toBe('482913'); // encrypted BEFORE the call
    const ok = await w.api.resume(t);
    expect(ok.status).toBe(200);
    expect(w.graph.callsTo('register')).toHaveLength(2);
    expect(w.graph.callsTo('register')[1].data.pin).toBe('482913');
    row = await connRow(t.ws);
    expect(row.status).toBe('connected');
    expect(row.registration.registeredAt).toBeTruthy();
    expect(row.registration.lastErrorCode).toBeUndefined();
  });

  test('subscribe 190 -> META_TOKEN_REVOKED with a resumable state; resume completes', async () => {
    const w = world();
    const t = await H.makeTenant('Subscribe190');
    w.graph.scenarios.subscribeFails({ code: 190 });
    const res = await w.api.complete(t, await begin(w, t));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('META_TOKEN_REVOKED');
    expect(res.body.details).toMatchObject({ step: 'subscribe', cause: 'META_TOKEN_REVOKED', resumable: true });
    let row = await connRow(t.ws);
    expect(row.status).toBe('connecting');
    expect(row.connectSteps.subscribe.status).toBe('failed');
    expect(row.connectSteps.phone.status).toBe('done');
    const ok = await w.api.resume(t);
    expect(ok.status).toBe(200);
    expect(ok.body.steps.subscribe).toBe('done');
    row = await connRow(t.ws);
    expect(row.status).toBe('connected');
    expect(w.graph.callsTo('getPhone').length).toBeGreaterThanOrEqual(1);
  });

  test('a transient failure (subscribe network drop) is answered as CONNECT_PARTIAL with the specific cause', async () => {
    const w = world();
    const t = await H.makeTenant('Partial');
    w.graph.scenarios.networkDrop({ code: 'ECONNRESET', match: 'subscribe' });
    const res = await w.api.complete(t, await begin(w, t));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('CONNECT_PARTIAL');
    expect(res.body.details).toMatchObject({ step: 'subscribe', cause: 'META_UNREACHABLE', resumable: true });
    expect((await w.api.resume(t)).status).toBe(200);
  });

  test('the same POST repeated after a partial run (network retry) continues from the stored token, never re-exchanges', async () => {
    const w = world();
    const t = await H.makeTenant('RetryPost');
    const attemptId = await begin(w, t);
    w.graph.scenarios.networkDrop({ code: 'ECONNRESET', match: 'subscribe' });
    expect((await w.api.complete(t, attemptId)).status).toBe(503);
    const again = await w.api.complete(t, attemptId);
    expect(again.status).toBe(200);
    expect(w.graph.callsTo('exchange')).toHaveLength(1);
  });

  test('resume without anything to resume -> 409 CONNECT_ATTEMPT_INVALID; resume of a connected workspace returns the stored result', async () => {
    const w = world();
    const t = await H.makeTenant('ResumeNone');
    expect((await w.api.resume(t)).body.code).toBe('CONNECT_ATTEMPT_INVALID');
    const done = await w.api.complete(t, await begin(w, t));
    const calls = w.graph.calls.length;
    const res = await w.api.resume(t);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(done.body);
    expect(w.graph.calls).toHaveLength(calls);
  });
});

describe('reconnect', () => {
  test('must resolve to the SAME WABA; the same WABA succeeds, clears needsReconnect and does not seed templates again', async () => {
    const w = world();
    const t = await H.makeTenant('Reconnect');
    expect((await w.api.complete(t, await begin(w, t))).status).toBe(200);
    expect(w.starter.calls).toBe(1);
    expect((await w.api.config(t)).body.code).toBe('NUMBER_ALREADY_CONNECTED');

    await WhatsAppConnection.updateOne({ workspaceId: t.ws }, { $set: { needsReconnect: true, reconnectReason: 'TOKEN_REVOKED' } });
    state.invalidate(t.ws);
    // a different Meta account answers the popup
    const other = createFakeGraph(H.uniqueIds());
    const originalMeta = w.connectDeps.meta;
    w.connectDeps.meta = require('../../../shared/onboarding/metaClient').createMetaGraphClient({ http: other.http, appId: other.ids.appId, appSecret: other.ids.appSecret });
    const cfg = await w.api.reconnect(t);
    expect(cfg.status).toBe(200);
    expect(cfg.body.reconnect).toEqual({ expectedWabaId: w.graph.ids.wabaId });
    const bad = await w.api.complete(t, cfg.body.attemptId, { session: flat(other.session('FINISH')) });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('CONNECT_WABA_MISMATCH');
    // back on the right account
    w.connectDeps.meta = originalMeta;
    const cfg2 = await w.api.reconnect(t);
    const ok = await w.api.complete(t, cfg2.body.attemptId);
    expect(ok.status).toBe(200);
    const row = await connRow(t.ws);
    expect(row.needsReconnect).toBe(false);
    expect(row.reconnectReason).toBeUndefined();
    expect(row.status).toBe('connected');
    expect(w.starter.calls).toBe(1);
  });
});

describe('POST /connect/event', () => {
  test('CANCEL / ERROR / NO_FACEBOOK outcomes', async () => {
    const w = world();
    const t = await H.makeTenant('Events');
    const attemptId = await begin(w, t);
    let res = await w.api.event(t, { attemptId, event: 'CANCEL', currentStep: 'PHONE_NUMBER_SETUP' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: 'cancelled', code: 'CONNECT_CANCELLED', nextStep: 'connect', copyKey: 'onboarding.errors.CONNECT_CANCELLED' });
    res = await w.api.event(t, { attemptId, event: 'ERROR', errorCode: 3441030, errorMessage: 'The number +966 55 123 4567 is already registered' });
    expect(res.body).toMatchObject({ outcome: 'error', code: 'CONNECT_NUMBER_REGISTERED_ELSEWHERE', nextStep: 'number' });
    res = await w.api.event(t, { attemptId, event: 'CANCEL', errorCode: '2388091' });
    expect(res.body.code).toBe('CONNECT_VERIFICATION_FAILED');
    res = await w.api.event(t, { attemptId, event: 'NO_FACEBOOK' });
    expect(res.body).toMatchObject({ outcome: 'no_facebook', code: 'CONNECT_NO_FACEBOOK_ACCOUNT' });
    expect((await connRow(t.ws)).lastError.code).toBe('CONNECT_VERIFICATION_FAILED');
  });
  test('validation and the 30 per minute limit', async () => {
    const w = world();
    const t = await H.makeTenant('EventLimit');
    expect((await w.api.event(t, { attemptId: 'x', event: 'FINISH' })).status).toBe(422);
    expect((await w.api.event(t, { event: 'CANCEL' })).status).toBe(422);
    let last;
    for (let i = 0; i < 30; i += 1) last = await w.api.event(t, { attemptId: 'abc', event: 'CANCEL' });
    expect([200, 429]).toContain(last.status);
    const over = await w.api.event(t, { attemptId: 'abc', event: 'CANCEL' });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('RATE_LIMITED');
    expect(over.headers['retry-after']).toBeDefined();
  });
});

describe('complete: body, limits and roles', () => {
  test('body > 4 KB and malformed fields are rejected with 422', async () => {
    const w = world();
    const t = await H.makeTenant('Body');
    const attemptId = await begin(w, t);
    const big = await request(w.app).post('/api/onboarding/connect/complete').set(w.asUser(t)).send({ attemptId, code: 'x'.repeat(5000) });
    expect(big.status).toBe(422);
    expect(big.body.details.reason).toBe('BODY_TOO_LARGE');
    const bad = await request(w.app).post('/api/onboarding/connect/complete').set(w.asUser(t)).send({ attemptId });
    expect(bad.status).toBe(422);
    expect(bad.body.details.fields).toContain('code');
    expect(w.graph.calls).toHaveLength(0);
  });
  test('5 completes per 10 minutes', async () => {
    const w = world();
    const t = await H.makeTenant('CompleteLimit');
    let status = 0;
    for (let i = 0; i < 6; i += 1) status = (await w.api.complete(t, 'f'.repeat(32))).status;
    expect(status).toBe(429);
  });
  test('owner-only routes use the LIVE membership: a member whose stale JWT says owner gets 403 OWNER_ONLY', async () => {
    const w = world();
    const t = await H.makeTenant('Roles');
    const attemptId = await begin(w, t);
    const stale = { 'x-test-user': JSON.stringify({ id: t.member, workspaceId: t.ws, role: 'owner' }) };
    const post = (path, body = {}) => request(w.app).post(path).set(stale).send(body);
    for (const [path, body] of [
      ['/api/onboarding/connect/complete', { attemptId, code: nextCode(), session: {} }],
      ['/api/onboarding/connect/resume', {}],
      ['/api/onboarding/connection/reconnect', {}],
      ['/api/onboarding/connection/disconnect/request', {}],
      ['/api/onboarding/connection/disconnect', { confirmationToken: 'a', confirmText: 'DISCONNECT' }],
    ]) {
      const res = await post(path, body);
      expect([path, res.status, res.body.code]).toEqual([path, 403, 'OWNER_ONLY']);
    }
    expect(w.graph.calls).toHaveLength(0);
  });
  test('an owner who has not accepted the legal terms is refused on complete (LEGAL_ACCEPTANCE_REQUIRED)', async () => {
    const w = world();
    const t = await H.makeTenant('Legal');
    const second = H.newId();
    await H.models.Membership.create({ userId: second, workspaceId: t.ws, role: 'owner' });
    const res = await request(w.app).post('/api/onboarding/connect/complete').set({ 'x-test-user': JSON.stringify({ id: second, workspaceId: t.ws, role: 'owner' }) }).send({ attemptId: 'a'.repeat(32), code: nextCode() });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
  });
  test('unpaid workspace: 402 before anything else', async () => {
    const w = world();
    const t = await H.makeTenant('Unpaid');
    await OnboardingState.updateOne({ workspaceId: t.ws }, { $set: { 'subscription.state': 'none', 'subscription.source': null } });
    state.invalidate(t.ws);
    const res = await w.api.config(t);
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('SUBSCRIPTION_REQUIRED');
  });
});

describe('tenant isolation', () => {
  test("B cannot use A's attempt, see A's connection or resume A's token", async () => {
    const w = world();
    const a = await H.makeTenant('IsoA');
    const b = await H.makeTenant('IsoB');
    const attemptA = await begin(w, a);
    await begin(w, b);
    expect((await w.api.complete(b, attemptA)).body.code).toBe('CONNECT_ATTEMPT_INVALID');
    expect((await w.api.complete(a, attemptA)).status).toBe(200);
    const view = await w.api.connection(b);
    expect(view.status).toBe(200);
    expect(view.body.level).toBe('not_connected');
    expect(JSON.stringify(view.body)).not.toContain('4567');
    expect((await w.api.resume(b)).body.code).toBe('CONNECT_ATTEMPT_INVALID');
    // a workspaceId in the body or query is ignored: only the token workspace counts
    const res = await request(w.app).post('/api/onboarding/connect/resume').query({ workspaceId: a.ws }).set(w.asUser(b)).send({ workspaceId: a.ws });
    expect(res.body.code).toBe('CONNECT_ATTEMPT_INVALID');
  });
});

describe('no secret ever leaks (code, token, PIN)', () => {
  test('logs, thrown errors, HTTP bodies, stored result and Graph calls', async () => {
    const spy = H.spyConsole();
    try {
      const w = world({ graphOptions: { phoneStatus: 'PENDING' } });
      const t = await H.makeTenant('Leaks');
      const bodies = [];
      const attemptId = await begin(w, t);
      const code = nextCode();
      // a failing run first (transient), then the success: both must be clean
      w.graph.scenarios.networkDrop({ code: 'ECONNRESET', match: 'subscribe' });
      const r1 = await w.api.complete(t, attemptId, { code });
      bodies.push(r1.body, r1.text);
      const r2 = await w.api.resume(t);
      bodies.push(r2.body, r2.text);
      const r3 = await w.api.complete(t, attemptId, { code });
      bodies.push(r3.body, r3.text);
      bodies.push((await w.api.connection(t)).body);
      const ev = await w.api.event(t, { attemptId, event: 'ERROR', errorCode: 3441030, errorMessage: `registered with token ${w.graph.ids.merchantToken}` });
      bodies.push(ev.body);
      const rd = await w.api.disconnectRequest(t);
      const rdis = await w.api.disconnect(t, { confirmationToken: rd.body.confirmationToken, confirmText: 'DISCONNECT' });
      bodies.push(rdis.body);
      const row = await connRow(t.ws);
      const stored = [JSON.stringify(row.connectAttempt), JSON.stringify(row.lastError || {}), JSON.stringify(row.connectSteps)];
      w.graph.assertNoLeak([code, w.graph.ids.merchantToken, '482913'], [...spy.lines, ...bodies, ...stored, ...w.outbox.map((o) => JSON.stringify(o))]);
      // hostile Graph error text is sanitised before it reaches a body or a log
      expect(spy.lines.join('\n')).not.toMatch(/\b\d{9,15}\b/);
    } finally { spy.restore(); }
  });
});
