'use strict';
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const cb = require('../../../shared/onboarding/metaCallbacks');
const { makeEnv, flush, WS, WS2 } = require('./_b1dHelpers');

const SECRET = 'fixture_app_secret';
const VECTOR = 'dTd1i9xLV7gSbX2KqYfOsyJ7xqrLHmrHrPIdL0rDrJI.eyJhbGdvcml0aG0iOiJITUFDLVNIQTI1NiIsImlzc3VlZF9hdCI6MTcwMDAwMDAwMCwidXNlcl9pZCI6IjEyMzQ1Njc4OTAifQ';
const VECTOR_EXPIRES = 'vhFPmNg7tIsNubLGZ2y1dINpeVZ3wG7wsZmF8ghS3No.eyJhbGdvcml0aG0iOiJITUFDLVNIQTI1NiIsImV4cGlyZXMiOjE3MDAwMDAxMDAsInVzZXJfaWQiOiI5In0';

const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function signed(payload, secret = SECRET, raw = false) {
  const p = raw ? payload : b64u(payload);
  return `${crypto.createHmac('sha256', secret).update(p).digest('base64url')}.${p}`;
}

describe('verifySignedRequest vectors', () => {
  test('a precomputed vector verifies and returns the payload', () => {
    expect(cb.verifySignedRequest(VECTOR, SECRET)).toEqual({ algorithm: 'HMAC-SHA256', issued_at: 1700000000, user_id: '1234567890' });
  });
  test('the vector is the same one the test helper builds', () => {
    expect(signed({ algorithm: 'HMAC-SHA256', issued_at: 1700000000, user_id: '1234567890' })).toBe(VECTOR);
  });
  test('wrong secret, tampered signature, tampered payload -> null', () => {
    expect(cb.verifySignedRequest(VECTOR, 'other_secret')).toBeNull();
    const [s, p] = VECTOR.split('.');
    expect(cb.verifySignedRequest(`${s.slice(0, -2)}AA.${p}`, SECRET)).toBeNull();
    const forged = b64u({ algorithm: 'HMAC-SHA256', issued_at: 1700000000, user_id: '666' });
    expect(cb.verifySignedRequest(`${s}.${forged}`, SECRET)).toBeNull();
    expect(cb.verifySignedRequest(`${s}x.${p}`, SECRET)).toBeNull();
  });
  test('algorithm must be HMAC-SHA256 (case-insensitive); anything else is rejected even when signed', () => {
    expect(cb.verifySignedRequest(signed({ algorithm: 'hmac-sha256', user_id: '1' }), SECRET)).not.toBeNull();
    for (const algorithm of ['HMAC-SHA1', 'none', '', undefined, 5, null]) expect(cb.verifySignedRequest(signed({ algorithm, user_id: '1' }), SECRET)).toBeNull();
    expect(cb.verifySignedRequest(signed({ user_id: '1' }), SECRET)).toBeNull();
  });
  test('expiry: not yet expired passes, expired / exactly now / junk fails; no expires claim passes', () => {
    const at = (sec) => sec * 1000;
    expect(cb.verifySignedRequest(VECTOR_EXPIRES, SECRET, at(1700000099))).toMatchObject({ user_id: '9' });
    expect(cb.verifySignedRequest(VECTOR_EXPIRES, SECRET, at(1700000100))).toBeNull();
    expect(cb.verifySignedRequest(VECTOR_EXPIRES, SECRET, new Date(at(1700000200)))).toBeNull();
    expect(cb.verifySignedRequest(signed({ algorithm: 'HMAC-SHA256', expires: 'soon' }), SECRET)).toBeNull();
    expect(cb.verifySignedRequest(signed({ algorithm: 'HMAC-SHA256', expires: null, user_id: '1' }), SECRET)).not.toBeNull();
    expect(cb.verifySignedRequest(VECTOR, SECRET, at(9999999999))).not.toBeNull();
  });
  test('malformed input -> null, never a throw', () => {
    const junk = [undefined, null, 42, {}, [], '', '.', 'a.b.c', 'onlyonepart', `${'a'.repeat(9000)}.x`, 'abc.!!!', '!!!.abc', ' .x', `${VECTOR} `, 'a b.c'];
    for (const j of junk) expect(cb.verifySignedRequest(j, SECRET)).toBeNull();
    expect(cb.verifySignedRequest(VECTOR, '')).toBeNull();
    expect(cb.verifySignedRequest(VECTOR, undefined)).toBeNull();
    expect(cb.verifySignedRequest(signed('not json at all', SECRET, true), SECRET)).toBeNull();
    expect(cb.verifySignedRequest(signed(b64u('"a string payload"'), SECRET, true), SECRET)).toBeNull();
    expect(cb.verifySignedRequest(signed(b64u('[1,2]'), SECRET, true), SECRET)).toBeNull();
  });
  test('uses a constant-time comparison (a different length signature is rejected without throwing)', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    expect(cb.verifySignedRequest(VECTOR, SECRET)).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    const [, p] = VECTOR.split('.');
    expect(cb.verifySignedRequest(`abc.${p}`, SECRET)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1); // length mismatch is rejected before the call
    spy.mockRestore();
  });
});

let saved;
beforeEach(() => { saved = process.env.ONBOARDING_FLOW; process.env.ONBOARDING_FLOW = 'on'; jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); if (saved === undefined) delete process.env.ONBOARDING_FLOW; else process.env.ONBOARDING_FLOW = saved; });

function setup(over = {}) {
  const env = makeEnv();
  const deps = { ...env.deps, appSecret: () => SECRET, rateLimitDeps: { limiter: require('../../../shared/onboarding/rateLimit').createLimiter() }, ...over };
  const app = express();
  app.use(express.json());
  app.use('/onboarding-meta', cb.createRouter(deps));
  return { env, app, deps };
}
const form = (app, path, signedRequest) => request(app).post(`/onboarding-meta${path}`).type('form').send({ signed_request: signedRequest });
const payload = (userId, extra = {}) => ({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: userId, ...extra });

describe('POST /deauthorize', () => {
  test('flags every connection of that Facebook user as reconnect_required (DEAUTHORIZED), notifies once, answers 200', async () => {
    const { env, app } = setup();
    env.seedConn({ ids: { wabaId: 'W1', phoneNumberId: 'P1', metaUserId: 'FBUSER1' } });
    env.seedConn({ workspaceId: WS2, ids: { wabaId: 'W2', phoneNumberId: 'P2', metaUserId: 'FBUSER2' } });
    const res = await form(app, '/deauthorize', signed(payload('FBUSER1')));
    await flush();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(env.Connection.rows[0]).toMatchObject({ needsReconnect: true, reconnectReason: 'DEAUTHORIZED', status: 'reconnect_required' });
    expect(env.Connection.rows[1].needsReconnect).toBe(false);
    expect(env.notes().filter((n) => n.kind === 'reconnect_needed' && n.dedupeKey.startsWith('reconnect:DEAUTHORIZED:'))).toHaveLength(1);
    expect(env.emailSend).toHaveBeenCalledTimes(1);
    expect(env.state.invalidate).toHaveBeenCalledWith(WS);
    expect(env.Inbound.rows[0]).toMatchObject({ source: 'metacb', type: 'deauthorize', status: 'done', outcome: 'connections:1 flagged:1' });
    expect(JSON.stringify(env.Inbound.rows)).not.toContain('FBUSER1');
  });
  test('several workspaces of the same Facebook user are all flagged', async () => {
    const { env, app } = setup();
    env.seedConn({ ids: { wabaId: 'W1', metaUserId: 'FBUSER1' } });
    env.seedConn({ workspaceId: WS2, ids: { wabaId: 'W2', metaUserId: 'FBUSER1' } });
    await form(app, '/deauthorize', signed(payload('FBUSER1')));
    expect(env.Connection.rows.map((r) => r.reconnectReason)).toEqual(['DEAUTHORIZED', 'DEAUTHORIZED']);
  });
  test('an unknown user changes nothing; a disconnected connection is not flagged', async () => {
    const { env, app } = setup();
    env.seedConn({ status: 'disconnected', ids: { wabaId: 'W1', metaUserId: 'FBUSER1' } });
    expect((await form(app, '/deauthorize', signed(payload('NOBODY')))).status).toBe(200);
    expect((await form(app, '/deauthorize', signed(payload('FBUSER1', { issued_at: 5 })))).status).toBe(200);
    expect(env.row().needsReconnect).toBe(false);
    expect(env.notes()).toHaveLength(0);
  });
  test('a replay of the same signed_request is processed once', async () => {
    const { env, app } = setup();
    env.seedConn({ ids: { wabaId: 'W1', metaUserId: 'FBUSER1' } });
    const sr = signed(payload('FBUSER1'));
    await form(app, '/deauthorize', sr);
    env.row().needsReconnect = false; // pretend the merchant reconnected
    delete env.row().reconnectReason;
    env.row().status = 'connected';
    const again = await form(app, '/deauthorize', sr);
    expect(again.status).toBe(200);
    expect(env.row().needsReconnect).toBe(false); // the replay did nothing
    expect(env.Inbound.rows).toHaveLength(1);
  });
  test('a failure while flagging marks the ledger row failed, answers 500, and a retry of the same request is processed', async () => {
    const { env, app, deps } = setup();
    env.seedConn({ ids: { wabaId: 'W1', metaUserId: 'FBUSER1' } });
    const sr = signed(payload('FBUSER1'));
    const realRefresh = deps.statusRefresh || require('../../../shared/onboarding/statusRefresh');
    let broken = true;
    const flaky = { ...realRefresh, markNeedsReconnect: (...a) => { if (broken) throw new Error('db hiccup'); return realRefresh.markNeedsReconnect(...a); } };
    const app2 = express();
    app2.use(express.json());
    app2.use('/onboarding-meta', cb.createRouter({ ...deps, statusRefresh: flaky }));
    const first = await form(app2, '/deauthorize', sr);
    expect(first.status).toBe(500);
    expect(env.Inbound.rows[0]).toMatchObject({ status: 'failed', errorCode: 'FLAG_FAILED' });
    expect(env.row().needsReconnect).toBe(false);
    broken = false;
    const retry = await form(app2, '/deauthorize', sr);
    expect(retry.status).toBe(200);
    expect(env.row().needsReconnect).toBe(true);
    expect(env.Inbound.rows[0]).toMatchObject({ status: 'done', attempts: 2 });
    expect(app).toBeDefined();
  });
  test('bad signature / tampered / missing / expired / wrong algorithm -> 400; no secret configured -> 503; nothing changes', async () => {
    const { env, app } = setup();
    env.seedConn({ ids: { wabaId: 'W1', metaUserId: 'FBUSER1' } });
    const good = signed(payload('FBUSER1'));
    for (const sr of [signed(payload('FBUSER1'), 'wrong'), `${good}x`, '', 'garbage', signed(payload('FBUSER1', { expires: 1 })), signed({ ...payload('FBUSER1'), algorithm: 'HMAC-SHA1' })]) {
      const res = await form(app, '/deauthorize', sr);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_signed_request' });
    }
    expect((await request(app).post('/onboarding-meta/deauthorize').type('form').send({})).status).toBe(400);
    expect(env.row().needsReconnect).toBe(false);
    expect(env.Inbound.rows).toHaveLength(0);
    const noSecret = setup({ appSecret: () => null });
    expect((await form(noSecret.app, '/deauthorize', good)).status).toBe(503);
  });
  test('a JSON body works too (the global express.json may have parsed it) and the response never echoes inputs', async () => {
    const { env, app } = setup();
    env.seedConn({ ids: { wabaId: 'W1', metaUserId: 'FBUSER1' } });
    const res = await request(app).post('/onboarding-meta/deauthorize').send({ signed_request: signed(payload('FBUSER1')) });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('FBUSER1');
    expect(env.row().needsReconnect).toBe(true);
  });
  test('a valid request without a user id is acknowledged and ignored', async () => {
    const { env, app } = setup();
    env.seedConn({ ids: { wabaId: 'W1', metaUserId: 'FBUSER1' } });
    expect((await form(app, '/deauthorize', signed({ algorithm: 'HMAC-SHA256' }))).status).toBe(200);
    expect(env.row().needsReconnect).toBe(false);
  });
  test('only a POST with a form body is accepted by the route (GET -> 404)', async () => {
    const { app } = setup();
    expect((await request(app).get('/onboarding-meta/deauthorize')).status).toBe(404);
  });
});

describe('POST /data-deletion', () => {
  test('records a row (no deletion), answers { url, confirmation_code } with a deterministic code', async () => {
    const { env, app } = setup();
    env.seedConn({ ids: { wabaId: 'W1', metaUserId: 'FBUSER1' } });
    const sr = signed(payload('FBUSER1'));
    const res = await form(app, '/data-deletion', sr);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['confirmation_code', 'url']);
    expect(res.body.confirmation_code).toMatch(/^[a-f0-9]{24}$/);
    expect(res.body.url).toBe(`http://localhost:3000/onboarding-meta/deletion-status?code=${res.body.confirmation_code}`);
    const row = env.Inbound.rows[0];
    expect(row).toMatchObject({ _id: `metacb:${res.body.confirmation_code}`, source: 'metacb', type: 'data_deletion', status: 'processing', workspaceId: WS });
    expect(row.outcome).toBe('awaiting_staff user:FBUSER1');
    // nothing was deleted or flagged: the connection is untouched and no delete-type call was made on any model
    expect(env.row().needsReconnect).toBe(false);
    for (const model of [env.Connection, env.Inbound, env.notifModel]) expect(model.calls.every((c) => !/delete|remove|drop/i.test(c[0]))).toBe(true);
    // a retry gets the same code and no second row
    const again = await form(app, '/data-deletion', sr);
    expect(again.body).toEqual(res.body);
    expect(env.Inbound.rows).toHaveLength(1);
    // a different request gets a different code
    const other = await form(app, '/data-deletion', signed(payload('FBUSER2', { issued_at: 1 })));
    expect(other.body.confirmation_code).not.toBe(res.body.confirmation_code);
  });
  test('the url uses APP_URL when set', async () => {
    const prev = process.env.APP_URL;
    process.env.APP_URL = 'https://api.example.test/';
    try {
      const { app } = setup();
      const res = await form(app, '/data-deletion', signed(payload('U1')));
      expect(res.body.url.startsWith('https://api.example.test/onboarding-meta/deletion-status?code=')).toBe(true);
    } finally { if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev; }
  });
  test('no connection for that user: still recorded (no workspace); several workspaces: no workspace is guessed', async () => {
    const { env, app } = setup();
    env.seedConn({ ids: { wabaId: 'W1', metaUserId: 'FBUSER1' } });
    env.seedConn({ workspaceId: WS2, ids: { wabaId: 'W2', metaUserId: 'FBUSER1' } });
    await form(app, '/data-deletion', signed(payload('FBUSER1')));
    await form(app, '/data-deletion', signed(payload('NOBODY')));
    expect(env.Inbound.rows).toHaveLength(2);
    expect(env.Inbound.rows.every((r) => r.workspaceId === undefined)).toBe(true);
  });
  test('invalid signature -> 400 and nothing recorded', async () => {
    const { env, app } = setup();
    expect((await form(app, '/data-deletion', signed(payload('U1'), 'wrong'))).status).toBe(400);
    expect(env.Inbound.rows).toHaveLength(0);
  });
  test('a database failure answers 500 without details', async () => {
    const { env, app } = setup();
    env.Inbound.failWith = new Error('db down with 966500000001');
    const res = await form(app, '/data-deletion', signed(payload('U1')));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
  });
});

describe('GET /deletion-status', () => {
  async function createRequest(app) {
    const res = await form(app, '/data-deletion', signed(payload('FBUSER1')));
    return res.body.confirmation_code;
  }
  test('HTML for a browser: received; completed once staff mark it done; nothing from the request is echoed', async () => {
    const { env, app } = setup();
    const code = await createRequest(app);
    let res = await request(app).get(`/onboarding-meta/deletion-status?code=${code}`).set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.text).toContain('Status: received');
    expect(res.text).toContain('has been received');
    expect(res.text).not.toContain(code);
    env.Inbound.rows[0].status = 'done';
    res = await request(app).get(`/onboarding-meta/deletion-status?code=${code}`).set('Accept', 'text/html');
    expect(res.text).toContain('Status: completed');
  });
  test('JSON when asked for', async () => {
    const { app } = setup();
    const code = await createRequest(app);
    const res = await request(app).get(`/onboarding-meta/deletion-status?code=${code}`).set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'received' });
  });
  test('unknown, malformed and hostile codes are 404 (HTML escaped / JSON), never echoed, never a query on a bad shape', async () => {
    const { env, app } = setup();
    for (const code of ['0123456789abcdef01234567', 'zz', '<script>alert(1)</script>', '', 'A'.repeat(24), `${'a'.repeat(65)}`]) {
      const res = await request(app).get('/onboarding-meta/deletion-status').query({ code }).set('Accept', 'text/html');
      expect(res.status).toBe(404);
      expect(res.text).toContain('was not found');
      expect(res.text).not.toContain('script');
    }
    const json = await request(app).get('/onboarding-meta/deletion-status?code=nope').set('Accept', 'application/json');
    expect(json.status).toBe(404);
    expect(json.body).toEqual({ error: 'not_found' });
    expect((await request(app).get('/onboarding-meta/deletion-status')).status).toBe(404);
    expect((await request(app).get('/onboarding-meta/deletion-status?code[]=a&code[]=b')).status).toBe(404);
    expect(env.Inbound.calls.filter((c) => c[0] === 'findOne')).toHaveLength(1); // only the one well-formed code was looked up
  });
  test('a metacb row of another type (deauthorize) is not shown as a deletion request', async () => {
    const { env, app } = setup();
    env.seedConn({ ids: { wabaId: 'W1', metaUserId: 'FBUSER1' } });
    await form(app, '/deauthorize', signed(payload('FBUSER1')));
    const row = env.Inbound.rows[0];
    const code = '0123456789abcdef01234567';
    env.Inbound.seed({ _id: `metacb:${code}`, source: 'metacb', type: 'deauthorize', status: 'done' });
    expect(row.type).toBe('deauthorize');
    expect((await request(app).get(`/onboarding-meta/deletion-status?code=${code}`)).status).toBe(404);
  });
});

describe('flag, rate limit and exports', () => {
  test('the flag off at request time: the router falls through (404 in a bare app), nothing is read', async () => {
    const { env, app } = setup();
    process.env.ONBOARDING_FLOW = 'off';
    const res = await form(app, '/data-deletion', signed(payload('U1')));
    expect(res.status).toBe(404);
    expect(env.Inbound.calls).toHaveLength(0);
  });
  test('the callbacks are rate limited per IP (60 per minute)', async () => {
    const { app } = setup();
    const codes = [];
    for (let i = 0; i < 62; i += 1) codes.push((await form(app, '/deauthorize', 'bad')).status);
    expect(codes.slice(0, 60).every((c) => c === 400)).toBe(true);
    expect(codes.slice(60)).toEqual([429, 429]);
  });
  test('router and createRouter are exported; the default router is an express router; nothing is read at require time', () => {
    expect(typeof cb.router).toBe('function');
    expect(typeof cb.router.handle).toBe('function');
    expect(typeof cb.createRouter).toBe('function');
    expect(typeof cb.verifySignedRequest).toBe('function');
  });
  test('the default router answers through mount.js style wiring (smoke): a bad request is a 400, never a 500', async () => {
    const app = express();
    app.use('/onboarding-meta', cb.router);
    const prev = process.env.WA_APP_SECRET;
    process.env.WA_APP_SECRET = SECRET;
    try {
      const res = await request(app).post('/onboarding-meta/deauthorize').type('form').send({ signed_request: 'bad' });
      expect(res.status).toBe(400);
    } finally { if (prev === undefined) delete process.env.WA_APP_SECRET; else process.env.WA_APP_SECRET = prev; }
  });
});
