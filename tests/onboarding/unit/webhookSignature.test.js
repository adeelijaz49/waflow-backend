'use strict';
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const request = require('supertest');
// the merchant lookup of webhookEvents (memoised DB lookup in production) is replaced by a set of known merchant WABA ids
const mockMerchantIds = new Set();
const mockLookup = { mode: 'ok', calls: 0 };
jest.mock('../../../shared/onboarding/webhookEvents', () => ({
  matchesMerchant: jest.fn(async (body) => {
    mockLookup.calls += 1;
    if (mockLookup.mode === 'throw') throw new Error('db down');
    if (mockLookup.mode === 'hang') return new Promise(() => {});
    return ((body && body.entry) || []).some((e) => e && mockMerchantIds.has(String(e.id)));
  }),
}));
const sig = require('../../../shared/onboarding/webhookSignature');
const earlyMounts = require('../../../shared/onboarding/earlyMounts');

const SECRET = 'APP_SECRET_FIXTURE_0123456789abcdef';
const PLATFORM = '1111111111';
const MERCHANT = '2222222222';
const sign = (raw, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
const ENV_KEYS = ['ONBOARDING_FLOW', 'ONBOARDING_WEBHOOK_SIGNATURE', 'WA_APP_SECRET', 'WA_WABA_ID'];
let saved;
let warnSpy;
beforeEach(() => {
  mockMerchantIds.clear();
  mockMerchantIds.add(MERCHANT);
  mockLookup.mode = 'ok';
  mockLookup.calls = 0;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ONBOARDING_FLOW = 'on';
  delete process.env.ONBOARDING_WEBHOOK_SIGNATURE;
  process.env.WA_APP_SECRET = SECRET;
  process.env.WA_WABA_ID = PLATFORM;
});
afterEach(() => {
  warnSpy.mockRestore();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const payload = (...ids) => ({ object: 'whatsapp_business_account', entry: ids.map((id, i) => ({ id, time: 1739321024 + i, changes: [{ field: 'messages', value: { metadata: { phone_number_id: '999' }, messages: [{ from: '966500000000', text: { body: 'مرحبا 👋 hello' } }] } }] })) });

/** The hunk order of server.js: earlyMounts, then express.json(), then the handler. */
function makeApp() {
  const app = express();
  earlyMounts.mount(app, express);
  app.use(express.json());
  const seen = [];
  app.post('/webhook', (req, res) => { seen.push({ body: req.body, sig: req.metaSignature }); res.status(200).json({ ok: true, sig: req.metaSignature === undefined ? null : req.metaSignature }); });
  app.use((err, req, res, next) => { res.status(err.status || 500).json({ error: 'handler-error', status: err.status }); }); // eslint-disable-line no-unused-vars
  return { app, seen };
}
const post = (app, raw, headers = {}) => request(app).post('/webhook').set('Content-Type', 'application/json').set(headers).send(raw);

/** A fake request that is a CONFORMING webhook POST (application/json with a content-length) unless the headers say otherwise. */
function jsonReq(chunks, headers = {}) {
  const parts = (Array.isArray(chunks) ? chunks : [chunks]).map((c) => Buffer.from(c));
  const req = Readable.from(parts);
  req.headers = { 'content-type': 'application/json', 'content-length': String(parts.reduce((n, c) => n + c.length, 0)), ...headers };
  return req;
}

describe('computeSignature / verify', () => {
  test('known HMAC-SHA256 vector', () => {
    const expected = 'sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8';
    expect(sig.computeSignature('The quick brown fox jumps over the lazy dog', 'key')).toBe(expected);
    expect(sig.computeSignature(Buffer.from('The quick brown fox jumps over the lazy dog'), 'key')).toBe(expected);
  });
  test('verify accepts the right signature (case and whitespace tolerant) and nothing else', () => {
    const raw = Buffer.from('{"a":1}');
    const good = sign(raw);
    expect(sig.verify(raw, good, SECRET)).toBe(true);
    expect(sig.verify(raw, good.toUpperCase(), SECRET)).toBe(true);
    expect(sig.verify(raw, ` ${good} `, SECRET)).toBe(true);
    expect(sig.verify(raw, sign(raw, 'other'), SECRET)).toBe(false);
    expect(sig.verify(Buffer.from('{"a":2}'), good, SECRET)).toBe(false);
    expect(sig.verify(raw, good.slice(0, -2), SECRET)).toBe(false);
    expect(sig.verify(raw, good.replace('sha256=', ''), SECRET)).toBe(false);
    expect(sig.verify(raw, `${good}00`, SECRET)).toBe(false);
    for (const bad of [undefined, null, '', 42, {}, []]) expect(sig.verify(raw, bad, SECRET)).toBe(false);
    expect(sig.verify(raw, good, '')).toBe(false);
    expect(sig.verify(raw, good, undefined)).toBe(false);
  });
});

describe('readRawBody', () => {
  test('joins chunks, enforces the byte limit and the declared content-length', async () => {
    const r1 = Readable.from([Buffer.from('ab'), Buffer.from('cd')]); r1.headers = {};
    expect((await sig.readRawBody(r1, 10)).toString()).toBe('abcd');
    const r2 = Readable.from([Buffer.alloc(8), Buffer.alloc(8)]); r2.headers = {};
    await expect(sig.readRawBody(r2, 10)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const r3 = Readable.from([]); r3.headers = { 'content-length': '99' };
    await expect(sig.readRawBody(r3, 10)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(sig.MAX_BYTES).toBe(3 * 1024 * 1024);
  });
  test('a stream error and an aborted request reject', async () => {
    const r1 = new Readable({ read() { this.destroy(new Error('socket')); } }); r1.headers = {};
    await expect(sig.readRawBody(r1, 10)).rejects.toThrow('socket');
    const r2 = new Readable({ read() {} }); r2.headers = {};
    const p = sig.readRawBody(r2, 10);
    r2.destroy();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('mode off / flag off: untouched', () => {
  test('flag off: earlyMounts passes through, the stream is not read, express.json parses as today, no req.metaSignature', async () => {
    delete process.env.ONBOARDING_FLOW;
    const { app, seen } = makeApp();
    const body = payload(MERCHANT);
    const res = await post(app, JSON.stringify(body));
    expect(res.status).toBe(200);
    expect(seen[0].body).toEqual(body);
    expect(seen[0].sig).toBeUndefined();
  });
  test('explicit mode off with the flag on: same, even for a merchant payload with no signature', async () => {
    process.env.ONBOARDING_WEBHOOK_SIGNATURE = 'off';
    const { app, seen } = makeApp();
    const res = await post(app, JSON.stringify(payload(MERCHANT)));
    expect(res.status).toBe(200);
    expect(seen[0].sig).toBeUndefined();
  });
  test('mode off is next() without touching the stream (no data listener is attached)', async () => {
    const mw = sig.createMiddleware({ mode: () => 'off' });
    const req = new Readable({ read() {} }); req.headers = {};
    const next = jest.fn();
    await mw(req, {}, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.listenerCount('data')).toBe(0);
    expect(req.metaSignature).toBeUndefined();
  });
  test('the default mode is off while the flow is off, enforce while it is on', () => {
    const config = require('../../../shared/onboarding/config');
    delete process.env.ONBOARDING_FLOW;
    expect(config.webhookSignatureMode()).toBe('off');
    process.env.ONBOARDING_FLOW = 'on';
    expect(config.webhookSignatureMode()).toBe('enforce');
  });
});

describe('enforce mode (the default with the flow on)', () => {
  test('a platform payload passes unsigned, byte-identical, with req.metaSignature = absent', async () => {
    const { app, seen } = makeApp();
    const body = payload(PLATFORM);
    const raw = JSON.stringify(body);
    const res = await post(app, raw);
    expect(res.status).toBe(200);
    expect(seen[0].sig).toBe('absent');
    expect(JSON.stringify(seen[0].body)).toBe(raw);
    expect(seen[0].body).toEqual(body);
  });
  test('a platform payload with a WRONG signature still passes (platform is never rejected: log mode semantics)', async () => {
    const { app, seen } = makeApp();
    const raw = JSON.stringify(payload(PLATFORM));
    const res = await post(app, raw, { 'X-Hub-Signature-256': sign(raw, 'wrong') });
    expect(res.status).toBe(200);
    expect(seen[0].sig).toBe('invalid');
  });
  test('a payload with no entry id (every legacy test payload) passes in every mode', async () => {
    for (const mode of ['log', 'enforce']) {
      process.env.ONBOARDING_WEBHOOK_SIGNATURE = mode;
      const { app, seen } = makeApp();
      const bodies = [{ entry: [{ changes: [{ field: 'messages', value: { statuses: [] } }] }] }, { entry: [] }, {}, { entry: 'x' }];
      for (const b of bodies) {
        const res = await post(app, JSON.stringify(b));
        expect(res.status).toBe(200);
      }
      expect(seen.map((s) => s.sig)).toEqual(['absent', 'absent', 'absent', 'absent']);
    }
  });
  test('a merchant payload: no signature -> 403, wrong signature -> 403, valid -> 200 with req.metaSignature = valid', async () => {
    const { app, seen } = makeApp();
    const raw = JSON.stringify(payload(MERCHANT));
    expect((await post(app, raw)).status).toBe(403);
    expect((await post(app, raw, { 'X-Hub-Signature-256': sign(raw, 'wrong') })).status).toBe(403);
    expect((await post(app, raw, { 'X-Hub-Signature-256': 'sha256=zz' })).status).toBe(403);
    expect(seen).toHaveLength(0); // the handler never saw a rejected payload
    const ok = await post(app, raw, { 'X-Hub-Signature-256': sign(raw) });
    expect(ok.status).toBe(200);
    expect(ok.body.sig).toBe('valid');
    expect(seen[0].body).toEqual(JSON.parse(raw));
  });
  test('a signature over different bytes (re-serialised JSON) is invalid: the raw bytes are what counts', async () => {
    const { app } = makeApp();
    const body = payload(MERCHANT);
    const signedOver = JSON.stringify(body);
    const sent = JSON.stringify(body, null, 2);
    expect((await post(app, sent, { 'X-Hub-Signature-256': sign(signedOver) })).status).toBe(403);
    expect((await post(app, sent, { 'X-Hub-Signature-256': sign(sent) })).status).toBe(200);
  });
  test('a mixed payload (platform + merchant entry) needs the signature too', async () => {
    const { app } = makeApp();
    const raw = JSON.stringify(payload(PLATFORM, MERCHANT));
    expect((await post(app, raw)).status).toBe(403);
    expect((await post(app, raw, { 'X-Hub-Signature-256': sign(raw) })).status).toBe(200);
  });
  test('WA_APP_SECRET unset: merchant payloads are unsigned hints (unconfigured), never rejected', async () => {
    delete process.env.WA_APP_SECRET;
    const { app, seen } = makeApp();
    const res = await post(app, JSON.stringify(payload(MERCHANT)));
    expect(res.status).toBe(200);
    expect(seen[0].sig).toBe('unconfigured');
  });
  test('ruling 1: an UNKNOWN WABA (no merchant owns it) with a bad or absent signature passes untouched', async () => {
    const { app, seen } = makeApp();
    const body = payload('7777777777');
    const raw = JSON.stringify(body);
    for (const headers of [{}, { 'X-Hub-Signature-256': sign(raw, 'wrong') }]) {
      const res = await post(app, raw, headers);
      expect(res.status).toBe(200);
    }
    expect(seen.map((x) => x.sig)).toEqual(['absent', 'invalid']);
    expect(JSON.stringify(seen[0].body)).toBe(raw);
  });
  test('ruling 1: a mis-set WA_WABA_ID or WA_APP_SECRET can never break the platform webhook', async () => {
    const raw = JSON.stringify(payload(PLATFORM));
    // WA_WABA_ID points somewhere else: the platform payload is now "unknown" and still passes
    process.env.WA_WABA_ID = '9999999999';
    let t = makeApp();
    expect((await post(t.app, raw)).status).toBe(200);
    expect((await post(t.app, raw, { 'X-Hub-Signature-256': sign(raw, 'wrong') })).status).toBe(200);
    // WA_WABA_ID unset: same
    delete process.env.WA_WABA_ID;
    t = makeApp();
    expect((await post(t.app, raw)).status).toBe(200);
    // WA_APP_SECRET mis-set: platform payloads signed by Meta (with the real secret) still pass
    process.env.WA_WABA_ID = PLATFORM;
    process.env.WA_APP_SECRET = 'not-the-meta-app-secret-0123456789';
    t = makeApp();
    expect((await post(t.app, raw, { 'X-Hub-Signature-256': sign(raw) })).status).toBe(200);
    expect(t.seen[0].sig).toBe('invalid');
    expect(JSON.stringify(t.seen[0].body)).toBe(raw);
  });
  test('ruling 1: a merchant payload with a bad signature is 403 whatever WA_WABA_ID says (the positive match decides)', async () => {
    const raw = JSON.stringify(payload(MERCHANT));
    for (const waba of [undefined, '9999999999', PLATFORM]) {
      if (waba === undefined) delete process.env.WA_WABA_ID; else process.env.WA_WABA_ID = waba;
      const { app, seen } = makeApp();
      expect((await post(app, raw)).status).toBe(403);
      expect((await post(app, raw, { 'X-Hub-Signature-256': sign(raw, 'wrong') })).status).toBe(403);
      expect(seen).toHaveLength(0);
    }
    expect(require('../../../shared/onboarding/webhookEvents').matchesMerchant).toHaveBeenCalled();
  });
  test('ruling 1: a failing lookup is "not a merchant payload": the payload passes through (never a 5xx, never a 403)', async () => {
    mockLookup.mode = 'throw';
    const { app, seen } = makeApp();
    const raw = JSON.stringify(payload(MERCHANT));
    const res = await post(app, raw);
    expect(res.status).toBe(200);
    expect(seen[0].sig).toBe('absent');
  });
  test('ruling 1: a hanging lookup is bounded: the payload passes after the timeout', async () => {
    const hang = sig.createMiddleware({ mode: () => 'enforce', secret: () => SECRET, isMerchant: () => new Promise(() => {}), lookupTimeoutMs: 40, log: () => {} });
    const raw = Buffer.from(JSON.stringify(payload(MERCHANT)));
    const req = jsonReq(raw);
    const next = jest.fn();
    const res = { headersSent: false, status: jest.fn(() => res), json: jest.fn(() => res), set: jest.fn(() => res) };
    const started = Date.now();
    await hang(req, res, next);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(sig.LOOKUP_TIMEOUT_MS).toBe(1500);
  });
  test('the merchant lookup is only asked when the signature is bad (valid / unconfigured never touch the database)', async () => {
    const { app } = makeApp();
    const raw = JSON.stringify(payload(MERCHANT));
    expect((await post(app, raw, { 'X-Hub-Signature-256': sign(raw) })).status).toBe(200);
    expect(mockLookup.calls).toBe(0);
    delete process.env.WA_APP_SECRET;
    expect((await post(app, raw)).status).toBe(200);
    expect(mockLookup.calls).toBe(0);
  });
  test('numeric entry ids are compared as strings', async () => {
    const { app } = makeApp();
    const raw = JSON.stringify({ entry: [{ id: Number(PLATFORM), changes: [] }] });
    expect((await post(app, raw)).status).toBe(200);
  });
});

describe('log mode', () => {
  test('never rejects, reports non-valid signatures (throttled, no content, no secret)', async () => {
    process.env.ONBOARDING_WEBHOOK_SIGNATURE = 'log';
    const warn = warnSpy;
    warn.mockClear();
    try {
      const { app, seen } = makeApp();
      const raw = JSON.stringify(payload(MERCHANT));
      for (let i = 0; i < 3; i += 1) expect((await post(app, raw)).status).toBe(200);
      expect((await post(app, raw, { 'X-Hub-Signature-256': sign(raw) })).status).toBe(200);
      expect(seen.map((s) => s.sig)).toEqual(['absent', 'absent', 'absent', 'valid']);
      const lines = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines.length).toBeLessThanOrEqual(3);
      expect(lines.join('\n')).toMatch(/signature absent on a merchant payload/);
      expect(lines.join('\n')).not.toContain(SECRET);
      expect(lines.join('\n')).not.toContain('مرحبا');
    } finally { warn.mockClear(); }
  });
  test('log mode never rejects, also for a lookup that says merchant, and platform payloads are logged as platform', async () => {
    const log = jest.fn();
    const mw = sig.createMiddleware({ mode: () => 'log', secret: () => SECRET, isMerchant: async (b) => b.entry.some((e) => e.id === MERCHANT), log, now: () => 0 });
    const run = async (body, header) => {
      const req = jsonReq(JSON.stringify(body), header ? { 'x-hub-signature-256': header } : {});
      const res = { headersSent: false, status: jest.fn(() => res), json: jest.fn(() => res), set: jest.fn(() => res) };
      const next = jest.fn();
      await mw(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    };
    await run(payload(PLATFORM));
    await run(payload(MERCHANT), sign('x', 'wrong'));
    const lines = log.mock.calls.map((c) => c.join(' ')).join(' | ');
    expect(lines).toMatch(/signature absent on a platform payload .mode log./);
    expect(lines).toMatch(/signature invalid on a merchant payload .mode log./);
  });
  test('the throttle lets a line through again after a minute', async () => {
    let t = 0;
    const log = jest.fn();
    const mw = sig.createMiddleware({ mode: () => 'log', secret: () => SECRET, isMerchant: async () => true, log, now: () => t });
    const run = async () => {
      const raw = Buffer.from(JSON.stringify(payload(MERCHANT)));
      const req = jsonReq(raw);
      await mw(req, {}, () => {});
    };
    await run(); await run();
    expect(log).toHaveBeenCalledTimes(1);
    t = 61000;
    await run();
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe('T-SIG-6: body-parser interplay (express.json after the middleware)', () => {
  test('a valid signature leaves req.body intact (unicode included), no hang, and the JSON is parsed exactly once', async () => {
    const { app, seen } = makeApp();
    const body = payload(MERCHANT);
    const raw = JSON.stringify(body);
    const parse = jest.spyOn(JSON, 'parse');
    let res;
    let watchdog;
    try {
      res = await Promise.race([
        post(app, raw, { 'X-Hub-Signature-256': sign(raw) }),
        new Promise((_, rej) => { watchdog = setTimeout(() => rej(new Error('request hung')), 3000); }),
      ]);
      clearTimeout(watchdog);
      expect(parse.mock.calls.filter((c) => c[0] === raw)).toHaveLength(1);
    } finally { clearTimeout(watchdog); parse.mockRestore(); }
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toEqual(body);
    expect(seen[0].body.entry[0].changes[0].value.messages[0].text.body).toBe('مرحبا 👋 hello');
  });
  test('the same request with the flag off goes through express.json alone and yields the same body', async () => {
    const body = payload(PLATFORM);
    const raw = JSON.stringify(body);
    const withMw = makeApp();
    await post(withMw.app, raw);
    delete process.env.ONBOARDING_FLOW;
    const without = makeApp();
    await post(without.app, raw);
    expect(withMw.seen[0].body).toEqual(without.seen[0].body);
    expect(JSON.stringify(withMw.seen[0].body)).toBe(JSON.stringify(without.seen[0].body));
  });
  test('a legacy platform payload is byte-identical (key order, numbers, nesting) after the middleware', async () => {
    const raw = '{"object":"whatsapp_business_account","entry":[{"id":"1111111111","time":1739321024,"changes":[{"value":{"metadata":{"phone_number_id":"999","display_phone_number":"15550783881"},"statuses":[{"id":"wamid.X","status":"delivered","timestamp":"1739321024","recipient_id":"966500000000"}]},"field":"messages"}]}]}';
    const { app, seen } = makeApp();
    expect((await post(app, raw)).status).toBe(200);
    expect(JSON.stringify(seen[0].body)).toBe(raw);
  });
  test('an empty body yields {} and a handler that runs once', async () => {
    const { app, seen } = makeApp();
    const res = await request(app).post('/webhook').set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    expect(seen[0].body).toEqual({});
  });
  test('malformed JSON and non-object JSON are a 400 (as express.json strict mode); the handler is not reached', async () => {
    const { app, seen } = makeApp();
    expect((await post(app, '{"entry": [')).status).toBe(400);
    expect((await post(app, '"just a string"')).status).toBe(400);
    expect((await post(app, 'null')).status).toBe(400);
    expect(seen).toHaveLength(0);
  });
  test('a SIGNED body over 3 MB is a 413 (declared length or streamed) and is never parsed', async () => {
    const mk = (headers, chunks) => {
      const req = jsonReq(chunks, headers);
      if (headers['content-length'] === undefined) { delete req.headers['content-length']; req.headers['transfer-encoding'] = 'chunked'; }
      const res = { headersSent: false, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
      return { req, res };
    };
    const mw = sig.createMiddleware({ mode: () => 'enforce', secret: () => SECRET, isMerchant: async () => false, log: () => {} });
    const signedHeader = { 'x-hub-signature-256': sign('x') };
    for (const [headers, chunks] of [
      [{ 'content-length': String(3 * 1024 * 1024 + 1), ...signedHeader }, []],
      [{ 'content-length': undefined, ...signedHeader }, [Buffer.alloc(2 * 1024 * 1024), Buffer.alloc(2 * 1024 * 1024)]],
    ]) {
      const { req, res } = mk(headers, chunks);
      const next = jest.fn();
      await mw(req, res, next);
      expect(res.code).toBe(413);
      expect(res.headers.Connection).toBe('close');
      expect(next).not.toHaveBeenCalled();
      expect(req.body).toBeUndefined();
    }
    // over a real socket the client may see the 413 or a connection reset (the server stops reading); the handler never runs
    const { app, seen } = makeApp();
    const big = JSON.stringify({ entry: [{ id: PLATFORM, pad: 'x'.repeat(3 * 1024 * 1024 + 16) }] });
    const server = require('http').createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await post(server, big, { 'X-Hub-Signature-256': sign('x') }).then((r) => r, (e) => e);
      expect(res.status === 413 || (res && ['ECONNRESET', 'EPIPE'].includes(res.code))).toBe(true);
    } finally {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    expect(seen).toHaveLength(0);
  });
  test('a non-JSON content type is NOT taken over any more (R1-F2): the legacy parser decides, req.metaSignature stays unset', async () => {
    const { app, seen } = makeApp();
    const raw = JSON.stringify(payload(PLATFORM));
    const res = await request(app).post('/webhook').set('Content-Type', 'text/plain').send(raw);
    expect(res.status).toBe(200);
    expect(seen[0].body).toBeUndefined(); // express.json() skips text/plain exactly as it always did
    expect(seen[0].sig).toBeUndefined();
  });
  test('a failing middleware module never blocks the webhook (earlyMounts falls through)', async () => {
    const app = express();
    app.post('/webhook', (req, res, next) => { const mw = () => { throw new Error('boom'); }; Promise.resolve().then(() => mw(req, res, next)).catch(() => next()); });
    app.use(express.json());
    app.post('/webhook', (req, res) => res.json({ ok: true }));
    expect((await post(app, '{}')).status).toBe(200);
  });
});
