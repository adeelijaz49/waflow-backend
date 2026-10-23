'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_connection`;
assertThrowawayDb();

// Connection routes (status, refresh, reconnect, two-step disconnect) and reportGraphError: REAL connect module,
// routes and models on the throwaway mongod, Graph = fakeGraph.
const request = require('supertest');
const mongoose = require('mongoose');
const H = require('./_connectHarness');
const state = require('../../../shared/onboarding/state');
const connect = require('../../../shared/onboarding/connect');
const { MetaGraphError } = require('../../../shared/onboarding/metaClient');

const { WhatsAppConnection, WhatsAppClaim, OnboardingState } = H.models;
jest.setTimeout(60000);

let restoreEnv;
let seq = 0;
const nextCode = () => `AQDconnectionSECRET${String(++seq).padStart(4, '0')}abcdef`;
const flat = (s) => Object.assign({ event: s.event }, s.data);
const connRow = (ws) => WhatsAppConnection.findOne({ workspaceId: ws }).select('+tokenEncrypted +pinEncrypted').lean();

function world(opts = {}) {
  const w = H.createWorld(opts);
  const r = (method, path, t, who = 'owner') => request(w.app)[method](`/api/onboarding${path}`).set(w.asUser(t, who));
  w.call = {
    config: (t) => r('get', '/connect/config', t),
    complete: (t, attemptId) => r('post', '/connect/complete', t).send({ attemptId, code: nextCode(), session: flat(w.graph.session('FINISH')) }),
    connection: (t, who) => r('get', '/connection', t, who),
    refresh: (t, who) => r('post', '/connection/refresh', t, who).send({}),
    reconnect: (t, who) => r('post', '/connection/reconnect', t, who).send({}),
    disconnectRequest: (t, who) => r('post', '/connection/disconnect/request', t, who).send({}),
    disconnect: (t, body, who) => r('post', '/connection/disconnect', t, who).send(body),
  };
  return w;
}
async function connected(w, name) {
  const t = await H.makeTenant(name);
  const cfg = await w.call.config(t);
  const res = await w.call.complete(t, cfg.body.attemptId);
  expect(res.status).toBe(200);
  return t;
}

beforeAll(async () => {
  restoreEnv = H.setEnv();
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([OnboardingState.init(), WhatsAppConnection.init(), H.models.Membership.init()]);
});
afterAll(async () => { restoreEnv(); await mongoose.disconnect(); });
beforeEach(() => state.clearCache());

describe('GET /connection (from the DB, no Meta call)', () => {
  test('not connected, then connected: masked number only, no secrets, no Graph call', async () => {
    const w = world({ connectionDeps: { statusRefresh: {} } }); // no snapshot(): the DB fallback
    const t = await H.makeTenant('View');
    let res = await w.call.connection(t);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ level: 'not_connected', status: 'not_connected', numberMasked: null });
    const done = await connected(w, 'ViewConnected');
    const calls = w.graph.calls.length;
    res = await w.call.connection(done);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ level: 'connected', status: 'connected', verifiedName: 'Acme Coffee', needsReconnect: false, webhookSubscribed: true });
    expect(res.body.numberMasked).toMatch(/^\*+4567$/);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('966 55 123');
    expect(text).not.toMatch(/tokenEncrypted|pinEncrypted|v1:/);
    expect(w.graph.calls).toHaveLength(calls);
    expect((await w.call.connection(done, 'member')).status).toBe(200); // any member may read the status
  });
  test('uses statusRefresh.snapshot when it exists, and falls back safely when it throws', async () => {
    const snapshot = jest.fn(() => ({ level: 'needs_attention', causeCode: 'X' }));
    const w = world({ connectionDeps: { statusRefresh: { snapshot } } });
    const t = await connected(w, 'ViewSnap');
    let res = await w.call.connection(t);
    expect(res.body).toMatchObject({ status: 'connected', level: 'needs_attention', causeCode: 'X' });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot.mock.calls[0][0].tokenEncrypted).toBeUndefined();
    snapshot.mockImplementation(() => { const e = new Error('nope'); e.code = 'NOT_IMPLEMENTED'; throw e; });
    res = await w.call.connection(t);
    expect(res.status).toBe(200);
    expect(res.body.level).toBe('connected');
  });
  test('needsReconnect shows the reconnect level', async () => {
    const w = world({ connectionDeps: { statusRefresh: {} } });
    const t = await connected(w, 'ViewReconnect');
    await WhatsAppConnection.updateOne({ workspaceId: t.ws }, { $set: { needsReconnect: true, reconnectReason: 'TOKEN_REVOKED' } });
    const res = await w.call.connection(t);
    expect(res.body).toMatchObject({ level: 'reconnect_needed', reconnectReason: 'TOKEN_REVOKED', causeCode: 'WHATSAPP_RECONNECT_REQUIRED', causePath: '/setup/connect' });
  });
});

describe('POST /connection/refresh', () => {
  test('nothing to refresh without a connection: no statusRefresh call', async () => {
    const refreshConnection = jest.fn();
    const w = world({ connectionDeps: { statusRefresh: { refreshConnection } } });
    const t = await H.makeTenant('RefreshNone');
    const res = await w.call.refresh(t);
    expect(res.status).toBe(200);
    expect(res.body.level).toBe('not_connected');
    expect(refreshConnection).not.toHaveBeenCalled();
  });
  test('1 per 60 s; the snapshot comes from statusRefresh with the workspace id from the token', async () => {
    const refreshConnection = jest.fn(async () => ({ level: 'connected', checkedAt: '2026-10-15T09:00:00.000Z' }));
    const w = world({ connectionDeps: { statusRefresh: { refreshConnection } } });
    const t = await connected(w, 'RefreshOk');
    const first = await w.call.refresh(t);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'connected', level: 'connected' });
    expect(refreshConnection).toHaveBeenCalledWith(t.ws, undefined);
    const second = await w.call.refresh(t);
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('RATE_LIMITED');
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    expect(refreshConnection).toHaveBeenCalledTimes(1);
  });
  test('Meta errors become codes, never raw text; a 190 flips needsReconnect', async () => {
    const mk = (err) => jest.fn(async () => { throw err; });
    const e190 = new MetaGraphError('Session has expired', { httpStatus: 400, code: 190, subcode: 463, kind: 'reconnect', appCode: 'META_TOKEN_REVOKED' });
    const w = world({ connectionDeps: { statusRefresh: { refreshConnection: mk(e190) } } });
    const t = await connected(w, 'Refresh190');
    const res = await w.call.refresh(t);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('META_TOKEN_REVOKED');
    expect(JSON.stringify(res.body)).not.toContain('Session has expired');
    const row = await connRow(t.ws);
    expect(row.needsReconnect).toBe(true);
    expect(row.reconnectReason).toBe('TOKEN_EXPIRED');
    expect((await state.getGateState(t.ws)).conn.needsReconnect).toBe(true);

    const w2 = world({ connectionDeps: { statusRefresh: { refreshConnection: mk(new MetaGraphError('slow down', { httpStatus: 400, code: 4, kind: 'retry', appCode: 'META_RATE_LIMITED' })) } } });
    const t2 = await connected(w2, 'RefreshRate');
    const r2 = await w2.call.refresh(t2);
    expect(r2.status).toBe(429);
    expect(r2.body.code).toBe('META_RATE_LIMITED');
    const w3 = world({ connectionDeps: { statusRefresh: { refreshConnection: mk(new MetaGraphError('boom', { kind: 'network', appCode: 'META_UNREACHABLE', networkCode: 'ECONNRESET' })) } } });
    const t3 = await connected(w3, 'RefreshNet');
    const r3 = await w3.call.refresh(t3);
    expect(r3.status).toBe(503);
    expect(r3.body.code).toBe('META_UNREACHABLE');
  });
  test('tenant isolation: B never triggers a refresh of A', async () => {
    const refreshConnection = jest.fn(async () => ({ level: 'connected' }));
    const w = world({ connectionDeps: { statusRefresh: { refreshConnection } } });
    await connected(w, 'RefreshIsoA');
    const b = await H.makeTenant('RefreshIsoB');
    const res = await w.call.refresh(b);
    expect(res.body.level).toBe('not_connected');
    expect(refreshConnection).not.toHaveBeenCalled();
  });
});

describe('POST /connection/reconnect', () => {
  test('returns the config payload pinned to the current WABA; owner only', async () => {
    const w = world();
    const t = await connected(w, 'ReconnectRoute');
    const res = await w.call.reconnect(t);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, appId: 'APP_ID_FIXTURE', reconnect: { expectedWabaId: w.graph.ids.wabaId } });
    expect((await connRow(t.ws)).connectAttempt.expectWabaId).toBe(w.graph.ids.wabaId);
    const member = await w.call.reconnect(t, 'member');
    expect(member.status).toBe(403);
    expect(member.body.code).toBe('OWNER_ONLY');
  });
});

describe('two-step disconnect', () => {
  test('request -> confirm: token unset, claims released, ids and PIN kept, nothing deleted, step 3 back to todo', async () => {
    const clock = H.fixedClock(new Date());
    const w = world({ clock, graphOptions: { phoneStatus: 'PENDING' } });
    const t = await connected(w, 'Disc');
    const before = await WhatsAppConnection.countDocuments({});
    const claimsBefore = await WhatsAppClaim.countDocuments({ workspaceId: t.ws });
    expect(claimsBefore).toBe(2);

    const reqRes = await w.call.disconnectRequest(t);
    expect(reqRes.status).toBe(200);
    expect(reqRes.body.expiresInSec).toBe(300);
    expect(reqRes.body.impactKeys.sort()).toEqual(['number', 'sending', 'templates']);
    expect(reqRes.body.confirmationToken).toMatch(/^[0-9a-f]{32}\.\d+\.[0-9a-f]{64}$/);

    // wrong confirm text, garbage token, a token of another user
    expect((await w.call.disconnect(t, { confirmationToken: reqRes.body.confirmationToken, confirmText: 'disconnect me' })).status).toBe(422);
    expect((await w.call.disconnect(t, { confirmationToken: 'abc', confirmText: 'DISCONNECT' })).status).toBe(422);
    const tampered = `${reqRes.body.confirmationToken.slice(0, -1)}${reqRes.body.confirmationToken.endsWith('0') ? '1' : '0'}`;
    const bad = await w.call.disconnect(t, { confirmationToken: tampered, confirmText: 'DISCONNECT' });
    expect(bad.status).toBe(422);
    expect(bad.body.details.reason).toBe('CONFIRMATION_INVALID');
    expect((await connRow(t.ws)).status).toBe('connected');
    // expiry after 300 s
    clock.advance(301 * 1000);
    const late = await w.call.disconnect(t, { confirmationToken: reqRes.body.confirmationToken, confirmText: 'DISCONNECT' });
    expect(late.status).toBe(422);
    expect(late.body.details.reason).toBe('CONFIRMATION_EXPIRED');
    expect((await connRow(t.ws)).status).toBe('connected');
    expect(w.graph.callsTo('unsubscribe')).toHaveLength(0);

    const fresh = await w.call.disconnectRequest(t);
    const ok = await w.call.disconnect(t, { confirmationToken: fresh.body.confirmationToken, confirmText: 'DISCONNECT' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'disconnected', unsubscribed: true });
    const unsub = w.graph.callsTo('unsubscribe');
    expect(unsub).toHaveLength(1);
    expect(unsub[0].authorization).toBe(`Bearer ${w.graph.ids.merchantToken}`);

    const row = await connRow(t.ws);
    expect(row.status).toBe('disconnected');
    expect(row.tokenEncrypted).toBeUndefined();
    expect(row.pinEncrypted).toMatch(/^v1:/);
    expect(row.ids).toMatchObject({ wabaId: w.graph.ids.wabaId, phoneNumberId: w.graph.ids.phoneId });
    expect(row.disconnectedByUserId).toBe(t.owner);
    expect(row.webhook.subscribed).toBe(false);
    expect(row.connectAttempt).toBeUndefined();
    expect(await WhatsAppConnection.countDocuments({})).toBe(before); // the document is never deleted
    const claims = await WhatsAppClaim.find({ workspaceId: t.ws }).lean();
    expect(claims).toHaveLength(claimsBefore);
    claims.forEach((c) => expect(c.releasedAt).toBeTruthy());
    const st = await OnboardingState.findOne({ workspaceId: t.ws }).lean();
    expect(st.steps.connect.status).toBe('todo');
    expect(st.progress.currentStep).toBeLessThanOrEqual(3);
    expect((await state.getGateState(t.ws)).connectDone).toBe(false);
    expect(w.outbox.map((n) => n.kind)).toEqual(['connected', 'reconnect_needed']);
    expect(w.outbox[1]).toMatchObject({ email: true, params: { reason: 'DISCONNECTED_BY_OWNER' } });

    // idempotent: the same confirmation again answers disconnected without another Meta call
    const again = await w.call.disconnect(t, { confirmationToken: fresh.body.confirmationToken, confirmText: 'DISCONNECT' });
    expect(again.status).toBe(200);
    expect(w.graph.callsTo('unsubscribe')).toHaveLength(1);
    // nothing left to disconnect -> no new request token
    expect((await w.call.disconnectRequest(t)).status).toBe(422);
    // the merchant can connect again afterwards (free to choose any WABA)
    const cfg = await w.call.config(t);
    expect(cfg.status).toBe(200);
    expect(cfg.body.reconnect).toBeNull();
  });

  test('a failing unsubscribe never blocks the disconnect', async () => {
    const w = world();
    const t = await connected(w, 'DiscUnsubFail');
    w.graph.scenarios.networkDrop({ code: 'ETIMEDOUT', match: 'unsubscribe' });
    const rq = await w.call.disconnectRequest(t);
    const res = await w.call.disconnect(t, { confirmationToken: rq.body.confirmationToken, confirmText: 'DISCONNECT' });
    expect(res.status).toBe(200);
    expect(res.body.unsubscribed).toBe(false);
    expect((await connRow(t.ws)).tokenEncrypted).toBeUndefined();
  });

  test('refused when AUTH_JWT_SECRET is unset; token is bound to user and workspace', async () => {
    const w = world();
    const t = await connected(w, 'DiscBound');
    const other = await connected(world(), 'DiscBoundOther');
    const rq = await w.call.disconnectRequest(t);
    // the other workspace's owner cannot use this token
    const res = await w.call.disconnect(Object.assign({}, other), { confirmationToken: rq.body.confirmationToken, confirmText: 'DISCONNECT' });
    expect(res.status).toBe(422);
    expect((await connRow(other.ws)).status).toBe('connected');
    const old = process.env.AUTH_JWT_SECRET;
    delete process.env.AUTH_JWT_SECRET;
    try {
      const refused = await w.call.disconnectRequest(t);
      expect(refused.status).toBe(503);
      expect(refused.body.code).toBe('CONNECT_NOT_CONFIGURED');
    } finally { process.env.AUTH_JWT_SECRET = old; }
  });

  test('owner only (live membership) and tenant isolation', async () => {
    const w = world();
    const t = await connected(w, 'DiscRoles');
    const member = await w.call.disconnectRequest(t, 'member');
    expect(member.status).toBe(403);
    expect(member.body.code).toBe('OWNER_ONLY');
    const stale = await request(w.app).post('/api/onboarding/connection/disconnect').set({ 'x-test-user': JSON.stringify({ id: t.member, workspaceId: t.ws, role: 'owner' }) }).send({ confirmationToken: 'x', confirmText: 'DISCONNECT' });
    expect(stale.status).toBe(403);
    expect((await connRow(t.ws)).status).toBe('connected');
  });
});

describe('reportGraphError', () => {
  const ctxDeps = (w) => ({ ...w.connectDeps });
  test('flips needsReconnect + reason on reconnect kinds, sets lastError, invalidates the gate cache, notifies once', async () => {
    const w = world();
    const t = await connected(w, 'Report190');
    expect((await state.getGateState(t.ws)).conn.needsReconnect).toBe(false); // warm the cache
    w.outbox.length = 0;
    const err = new MetaGraphError('Session has expired', { httpStatus: 400, code: 190, subcode: 458, kind: 'reconnect', appCode: 'META_TOKEN_REVOKED' });
    await expect(connect.reportGraphError(t.ws, err, ctxDeps(w))).resolves.toBeUndefined();
    let row = await connRow(t.ws);
    expect(row.needsReconnect).toBe(true);
    expect(row.status).toBe('reconnect_required');
    expect(row.reconnectReason).toBe('APP_UNINSTALLED');
    expect(row.lastError).toMatchObject({ code: 'META_TOKEN_REVOKED', kind: 'reconnect', subcode: '458' });
    expect((await state.getGateState(t.ws)).conn.needsReconnect).toBe(true);
    expect(w.outbox).toHaveLength(1);
    expect(w.outbox[0]).toMatchObject({ kind: 'reconnect_needed', severity: 'action', email: true });
    expect(w.outbox[0].dedupeKey).toMatch(/^reconnect:APP_UNINSTALLED:\d+$/);
    // a second report does not notify again
    await connect.reportGraphError(t.ws, err, ctxDeps(w));
    expect(w.outbox).toHaveLength(1);
    row = await connRow(t.ws);
    expect(row.reconnectReason).toBe('APP_UNINSTALLED');
  });
  test('other kinds only set lastError; garbage input and bad ids never throw', async () => {
    const w = world();
    const t = await connected(w, 'ReportOther');
    await connect.reportGraphError(t.ws, new MetaGraphError('perm', { httpStatus: 400, code: 200, kind: 'permission', appCode: 'META_PERMISSION_MISSING' }), ctxDeps(w));
    let row = await connRow(t.ws);
    expect(row.needsReconnect).toBe(false);
    expect(row.lastError.code).toBe('META_PERMISSION_MISSING');
    await connect.reportGraphError(t.ws, { code: 190 }, ctxDeps(w)); // a bare shape works too
    expect((await connRow(t.ws)).needsReconnect).toBe(true);
    for (const bad of [undefined, null, 'x', 42, {}]) await expect(connect.reportGraphError(t.ws, bad, ctxDeps(w))).resolves.toBeUndefined();
    await expect(connect.reportGraphError('not-an-id', new Error('x'), ctxDeps(w))).resolves.toBeUndefined();
    await expect(connect.reportGraphError(undefined, new Error('x'), ctxDeps(w))).resolves.toBeUndefined();
    row = await connRow(t.ws);
    // the 190 flip above wrote the same pair as statusRefresh.markNeedsReconnect: needsReconnect + status reconnect_required
    expect(row.status).toBe('reconnect_required');
  });
  test('a connection that is not live (connecting / disconnected) is not flipped', async () => {
    const w = world();
    const t = await H.makeTenant('ReportConnecting');
    await state.ensureConnection(t.ws);
    await WhatsAppConnection.updateOne({ workspaceId: t.ws }, { $set: { status: 'connecting' } });
    await connect.reportGraphError(t.ws, { code: 190 }, ctxDeps(w));
    expect((await connRow(t.ws)).needsReconnect).toBe(false);
    expect(w.outbox).toHaveLength(0);
  });
  test('tenant isolation: only the reported workspace changes', async () => {
    const w = world();
    const a = await connected(w, 'ReportIsoA');
    const b = await connected(world(), 'ReportIsoB');
    await connect.reportGraphError(a.ws, { code: 190 }, ctxDeps(w));
    expect((await connRow(a.ws)).needsReconnect).toBe(true);
    expect((await connRow(b.ws)).needsReconnect).toBe(false);
  });
});
