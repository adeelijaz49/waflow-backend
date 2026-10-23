'use strict';
// Review R1-F1 / R1-F2 on the signature middleware: only a conforming JSON request is taken over (everything else is answered by the
// legacy parser exactly as before), and Meta's 3 MB is only read for a request that carries the signature header (100 kB otherwise).
const crypto = require('crypto');
const zlib = require('zlib');
const { Readable } = require('stream');
const express = require('express');
const request = require('supertest');

const mockMerchantIds = new Set();
jest.mock('../../../shared/onboarding/webhookEvents', () => ({
  matchesMerchant: jest.fn(async (body) => ((body && body.entry) || []).some((e) => e && mockMerchantIds.has(String(e.id)))),
}));
const sig = require('../../../shared/onboarding/webhookSignature');
const earlyMounts = require('../../../shared/onboarding/earlyMounts');

const SECRET = 'APP_SECRET_FIXTURE_0123456789abcdef';
const PLATFORM = '1111111111';
const MERCHANT = '2222222222';
const sign = (raw, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
const ENV_KEYS = ['ONBOARDING_FLOW', 'ONBOARDING_WEBHOOK_SIGNATURE', 'WA_APP_SECRET', 'WA_WABA_ID'];
let saved;
beforeEach(() => {
  mockMerchantIds.clear();
  mockMerchantIds.add(MERCHANT);
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ONBOARDING_FLOW = 'on';
  delete process.env.ONBOARDING_WEBHOOK_SIGNATURE;
  process.env.WA_APP_SECRET = SECRET;
  process.env.WA_WABA_ID = PLATFORM;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const payload = (...ids) => ({ object: 'whatsapp_business_account', entry: ids.map((id, i) => ({ id, time: 1739321024 + i, changes: [{ field: 'messages', value: { metadata: { phone_number_id: '999' }, statuses: [] } }] })) });

/** The hunk order of server.js: earlyMounts, then express.json(), then the handler; errors answer as JSON for comparison. */
function makeApp() {
  const app = express();
  earlyMounts.mount(app, express);
  app.use(express.json());
  const seen = [];
  app.post('/webhook', (req, res) => { seen.push({ body: req.body, sig: req.metaSignature }); res.status(200).json({ ok: true }); });
  app.use((err, req, res, next) => { res.status(err.status || 500).json({ error: 'handler-error', status: err.status, type: err.type, message: err.message }); }); // eslint-disable-line no-unused-vars
  return { app, seen };
}
const post = (app, raw, headers = {}) => request(app).post('/webhook').set('Content-Type', 'application/json').set(headers).send(raw);

function jsonReq(chunks, headers = {}) {
  const parts = (Array.isArray(chunks) ? chunks : [chunks]).map((c) => Buffer.from(c));
  const req = Readable.from(parts);
  req.headers = { 'content-type': 'application/json', 'content-length': String(parts.reduce((n, c) => n + c.length, 0)), ...headers };
  return req;
}
const fakeRes = () => ({ headersSent: false, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } });
const mwOf = () => sig.createMiddleware({ mode: () => 'enforce', secret: () => SECRET, isMerchant: async () => false, log: () => {} });

describe('R1-F1: Meta always signs, so only a request WITH the header may be as large as 3 MB', () => {
  test('constants: 100 kB without the header, 3 MB with it', () => {
    expect(sig.MAX_UNSIGNED_BYTES).toBe(100 * 1024);
    expect(sig.MAX_BYTES).toBe(3 * 1024 * 1024);
  });
  test('declared length over 100 kB and no header: the stream is NOT read, the legacy parser answers', async () => {
    const mw = mwOf();
    const req = jsonReq([], { 'content-length': String(150 * 1024) });
    const next = jest.fn();
    const res = fakeRes();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.code).toBeUndefined();
    expect(req.listenerCount('data')).toBe(0);
    expect(req.metaSignature).toBeUndefined();
  });
  test('undeclared (chunked) and over 100 kB without the header: cut at the limit with a 413', async () => {
    const mw = mwOf();
    const req = jsonReq([Buffer.alloc(60 * 1024, 120), Buffer.alloc(60 * 1024, 120)], { 'transfer-encoding': 'chunked' });
    delete req.headers['content-length'];
    const res = fakeRes();
    const next = jest.fn();
    await mw(req, res, next);
    expect(res.code).toBe(413);
    expect(res.headers.Connection).toBe('close');
    expect(next).not.toHaveBeenCalled();
  });
  test('the same 150 kB WITH the header is read and processed (signed batches may be large); a blank header counts as no header', async () => {
    const mw = mwOf();
    const raw = JSON.stringify({ entry: [{ id: PLATFORM, pad: 'x'.repeat(150 * 1024) }] });
    const signed = jsonReq(raw, { 'x-hub-signature-256': sign(raw) });
    const next = jest.fn();
    await mw(signed, fakeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(signed.metaSignature).toBe('valid');
    expect(signed.body.entry[0].id).toBe(PLATFORM);
    const blank = jsonReq([], { 'content-length': String(150 * 1024), 'x-hub-signature-256': '   ' });
    const next2 = jest.fn();
    await mw(blank, fakeRes(), next2);
    expect(next2).toHaveBeenCalledWith();
    expect(blank.listenerCount('data')).toBe(0);
  });
  test('an unsigned body up to 100 kB is still processed (platform payloads are never rejected)', async () => {
    const raw = JSON.stringify({ entry: [{ id: PLATFORM, pad: 'x'.repeat(99 * 1024) }] });
    const { app, seen } = makeApp();
    expect((await post(app, raw)).status).toBe(200);
    expect(seen[0].sig).toBe('absent');
  });
  test('end to end: 150 kB unsigned is the legacy 413 with the flag on or off; the same body signed is accepted', async () => {
    const raw = JSON.stringify({ entry: [{ id: PLATFORM, pad: 'x'.repeat(150 * 1024) }] });
    const on = makeApp();
    const resOn = await post(on.app, raw);
    delete process.env.ONBOARDING_FLOW;
    const off = makeApp();
    const resOff = await post(off.app, raw);
    process.env.ONBOARDING_FLOW = 'on';
    expect([resOn.status, resOff.status]).toEqual([413, 413]);
    expect(resOn.body).toEqual(resOff.body);
    expect(on.seen).toHaveLength(0);
    const ok = await post(on.app, raw, { 'X-Hub-Signature-256': sign(raw) });
    expect(ok.status).toBe(200);
    expect(on.seen).toHaveLength(1);
  });
});

describe('R1-F2: only a conforming JSON request is taken over', () => {
  const mk = (headers, withIs) => ({
    headers,
    ...(withIs ? { is: (t) => (String(headers['content-type'] || '').split(';')[0].trim().toLowerCase() === t && (headers['content-length'] !== undefined || headers['transfer-encoding'] !== undefined) ? t : false) } : {}),
  });
  test.each([[true], [false]])('conformingJson (with req.is: %p)', (withIs) => {
    expect(sig.conformingJson(mk({ 'content-type': 'application/json', 'content-length': '10' }, withIs))).toBe(true);
    expect(sig.conformingJson(mk({ 'content-type': 'application/json; charset=utf-8', 'transfer-encoding': 'chunked' }, withIs))).toBe(true);
    expect(sig.conformingJson(mk({ 'content-type': 'application/json; charset="UTF-8"', 'content-length': '10' }, withIs))).toBe(true);
    for (const bad of [
      { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '3' },
      { 'content-type': 'text/plain', 'content-length': '3' },
      { 'content-type': 'application/octet-stream', 'content-length': '3' },
      { 'content-type': 'application/json', 'content-length': '3', 'content-encoding': 'gzip' },
      { 'content-type': 'application/json', 'content-length': '3', 'content-encoding': 'identity' },
      { 'content-type': 'application/json', 'content-length': '3', 'content-encoding': 'br' },
      { 'content-type': 'application/json; charset=iso-8859-1', 'content-length': '3' },
      { 'content-type': 'application/json; charset=utf-16', 'content-length': '3' },
      { 'content-type': 'application/json; charset=utf8', 'content-length': '3' },
      { 'content-length': '3' },
      { 'content-type': 'application/json' }, // no body announced
      {},
    ]) expect(sig.conformingJson(mk(bad, withIs))).toBe(false);
  });
  test('conformingJson of nothing is false', () => {
    expect(sig.conformingJson(undefined)).toBe(false);
  });

  const body = JSON.stringify(payload(PLATFORM));
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]);
  const TABLE = [
    ['urlencoded', 'application/x-www-form-urlencoded', 'entry%5B0%5D%5Bid%5D=1&a=b'],
    ['text/plain garbage', 'text/plain', 'not json at all'],
    ['text/plain JSON text', 'text/plain', body],
    ['octet-stream', 'application/octet-stream', Buffer.from([1, 2, 3, 250])],
    ['gzip JSON', 'application/json', zlib.gzipSync(body), { 'Content-Encoding': 'gzip' }],
    ['deflate JSON', 'application/json', zlib.deflateSync(body), { 'Content-Encoding': 'deflate' }],
    ['broken gzip', 'application/json', Buffer.from('not gzip'), { 'Content-Encoding': 'gzip' }],
    ['unknown encoding', 'application/json', body, { 'Content-Encoding': 'rot13' }],
    ['identity encoding', 'application/json', body, { 'Content-Encoding': 'identity' }],
    ['charset iso-8859-1', 'application/json; charset=iso-8859-1', body],
    ['charset utf-16', 'application/json; charset=utf-16', Buffer.from(body, 'utf16le')],
    ['unknown charset', 'application/json; charset=nonsense', body],
    ['BOM JSON', 'application/json', bom],
    ['vendor JSON type', 'application/vnd.api+json', body],
    ['malformed JSON', 'application/json', '{"entry": ['],
    ['JSON string', 'application/json', '"just a string"'],
    ['JSON null', 'application/json', 'null'],
    ['JSON number', 'application/json', '12'],
    ['blank JSON', 'application/json', '   '],
    ['garbage JSON', 'application/json', 'abc'],
    ['truncated array', 'application/json', '[1,'],
    ['empty body', 'application/json', ''],
    ['99 kB JSON', 'application/json', JSON.stringify({ entry: [{ id: PLATFORM, pad: 'x'.repeat(99 * 1024) }] })],
    ['150 kB JSON', 'application/json', JSON.stringify({ entry: [{ id: PLATFORM, pad: 'x'.repeat(150 * 1024) }] })],
    ['valid Meta-style payload', 'application/json', body],
    ['valid payload with surrounding whitespace', 'application/json', `\n  ${body}  \n`],
  ];
  const answer = async (flagOn, c) => {
    if (flagOn) process.env.ONBOARDING_FLOW = 'on'; else delete process.env.ONBOARDING_FLOW;
    const { app, seen } = makeApp();
    let r = request(app).post('/webhook').set('Content-Type', c[1]);
    for (const [k, v] of Object.entries(c[3] || {})) r = r.set(k, v);
    const res = await r.send(c[2]);
    return { status: res.status, text: res.text, seen: seen.map((x) => JSON.stringify(x.body)) };
  };
  test.each(TABLE.map((c) => [c[0], c]))('%s: same status, same body, same body seen by the handler with the flag on and off', async (_name, c) => {
    const on = await answer(true, c);
    const off = await answer(false, c);
    process.env.ONBOARDING_FLOW = 'on';
    expect(on.status).toBe(off.status);
    expect(on.text).toBe(off.text);
    expect(on.seen).toEqual(off.seen);
  });
  test('a non-conforming request is not read by the middleware and carries no req.metaSignature', async () => {
    const mw = sig.createMiddleware({ mode: () => 'enforce', secret: () => SECRET, isMerchant: async () => true, log: () => {} });
    for (const headers of [{ 'content-type': 'application/x-www-form-urlencoded' }, { 'content-type': 'application/json', 'content-encoding': 'gzip' }, { 'content-type': 'text/plain' }]) {
      const req = jsonReq(['abc'], headers);
      const next = jest.fn();
      const res = fakeRes();
      await mw(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(req.listenerCount('data')).toBe(0);
      expect(req.metaSignature).toBeUndefined();
      expect(res.code).toBeUndefined();
    }
  });
  test('a conforming body that is not valid JSON goes to next(err) with the SyntaxError body-parser raises (status 400, entity.parse.failed, same message)', async () => {
    const mw = sig.createMiddleware({ mode: () => 'enforce', secret: () => SECRET, isMerchant: async () => true, log: () => {} });
    const legacy = (text) => new Promise((resolve) => {
      const app = express();
      app.use(express.json());
      app.post('/x', (req, res) => res.json({ ok: true }));
      app.use((err, req, res, next) => { resolve({ message: err.message, status: err.status, type: err.type }); res.end(); }); // eslint-disable-line no-unused-vars
      request(app).post('/x').set('Content-Type', 'application/json').send(text).then(() => resolve(null), () => resolve(null));
    });
    for (const text of ['{"entry": [', '"just a string"', 'null', '12', 'abc', '[1,', '{"a":}', 'tru', '   ', '{"a":1}}', 'x{']) {
      const req = jsonReq(text);
      const next = jest.fn();
      await mw(req, fakeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err).toBeInstanceOf(SyntaxError);
      expect([err.status, err.statusCode, err.expose, err.type]).toEqual([400, 400, true, 'entity.parse.failed']);
      expect({ message: err.message, status: err.status, type: err.type }).toEqual(await legacy(text));
    }
  });
  test('parseLikeLegacy: a BOM is dropped, an empty body is {}, an array is accepted, a primitive is refused', () => {
    expect(sig.parseLikeLegacy(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]))).toEqual({ a: 1 });
    expect(sig.parseLikeLegacy(Buffer.from(''))).toEqual({});
    expect(sig.parseLikeLegacy(Buffer.from(' [1, 2] '))).toEqual([1, 2]);
    expect(() => sig.parseLikeLegacy(Buffer.from('7'))).toThrow(SyntaxError);
  });
  test('a valid Meta-style signed payload is unchanged: raw-byte signature, body, req.metaSignature', async () => {
    const raw = JSON.stringify(payload(MERCHANT));
    const { app, seen } = makeApp();
    expect((await post(app, raw, { 'X-Hub-Signature-256': sign(raw) })).status).toBe(200);
    expect(seen[0].sig).toBe('valid');
    expect(JSON.stringify(seen[0].body)).toBe(raw);
  });
});

describe('R1-F3: a merchant lookup that never settles fails open and is logged once per minute', () => {
  test('timeout -> the payload passes (not a merchant payload), one throttled line with the code only', async () => {
    const failOpen = require('../../../shared/onboarding/failOpen');
    failOpen._resetLog();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mw = sig.createMiddleware({ mode: () => 'enforce', secret: () => SECRET, isMerchant: () => new Promise(() => {}), lookupTimeoutMs: 20, log: () => {} });
    const raw = JSON.stringify(payload(MERCHANT));
    for (let i = 0; i < 3; i += 1) {
      const req = jsonReq(raw);
      const next = jest.fn();
      await mw(req, fakeRes(), next);
      expect(next).toHaveBeenCalledWith();
    }
    const lines = warn.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.includes('fail-open'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('webhookSignature');
    expect(lines[0]).toContain('ONB_LOOKUP_TIMEOUT');
    expect(lines[0]).not.toContain(MERCHANT);
  });
});
