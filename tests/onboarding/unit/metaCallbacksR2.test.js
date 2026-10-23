'use strict';
// Reviews R2-06 / R2-07 / R7-11 / R1-F4 on the public Meta callbacks: only FAILED attempts count against the per-address limiter (a validly
// signed callback is never limited), non-canonical base64url spellings are refused, the deauthorize replay key is the hash of the PAYLOAD
// part, and support is e-mailed once per data-deletion request (the request id only).
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const cb = require('../../../shared/onboarding/metaCallbacks');
const rateLimit = require('../../../shared/onboarding/rateLimit');
const { makeEnv, flush, WS } = require('./_b1dHelpers');

const SECRET = 'fixture_app_secret';
const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function signedOf(payloadPart, secret = SECRET) {
  return `${crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url')}.${payloadPart}`;
}
const signed = (payload, secret = SECRET) => signedOf(b64u(payload), secret);
const payload = (userId, extra = {}) => ({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: userId, ...extra });

/** Another base64url spelling of the SAME bytes: the last character with its unused low bits changed. */
function nonCanonical(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = Buffer.from(s, 'base64url');
  const rem = bytes.length % 3;
  if (rem === 0) return null; // no unused bits: only one spelling exists
  const unused = rem === 1 ? 4 : 2;
  const last = alphabet.indexOf(s[s.length - 1]);
  for (let bit = 1; bit < (1 << unused); bit += 1) {
    const variant = s.slice(0, -1) + alphabet[last | bit];
    if (variant !== s && Buffer.from(variant, 'base64url').equals(bytes)) return variant;
  }
  return null;
}

let saved;
beforeEach(() => { saved = process.env.ONBOARDING_FLOW; process.env.ONBOARDING_FLOW = 'on'; jest.spyOn(console, 'error').mockImplementation(() => {}); jest.spyOn(console, 'warn').mockImplementation(() => {}); jest.spyOn(console, 'info').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); if (saved === undefined) delete process.env.ONBOARDING_FLOW; else process.env.ONBOARDING_FLOW = saved; });

function setup(over = {}) {
  const env = makeEnv();
  const email = { sendDataDeletionNotice: jest.fn(async () => ({ sent: true, id: 'm1' })) };
  const deps = { ...env.deps, appSecret: () => SECRET, email, rateLimitDeps: { limiter: rateLimit.createLimiter() }, ...over };
  const app = express();
  app.set('trust proxy', true); // only so that the tests can play different client addresses (the real app does not trust X-Forwarded-For)
  app.use(express.json());
  app.use('/onboarding-meta', cb.createRouter(deps));
  return { env, app, deps, email };
}
const form = (app, path, signedRequest, ip) => {
  let r = request(app).post(`/onboarding-meta${path}`).type('form');
  if (ip) r = r.set('X-Forwarded-For', ip);
  return r.send({ signed_request: signedRequest });
};

describe('R2-07: non-canonical base64url spellings are refused', () => {
  test('a signature or payload that is another spelling of the same bytes never verifies, the canonical one does', () => {
    const p = payload('1234567890');
    // find a payload whose length leaves unused bits in its last base64 group
    let user = 0;
    let part;
    do { user += 1; part = b64u(payload(String(1234567890 + user))); } while (Buffer.from(part, 'base64url').length % 3 === 0);
    expect(cb.verifySignedRequest(signedOf(part), SECRET)).not.toBeNull();
    const badPayload = nonCanonical(part);
    expect(badPayload).not.toBeNull();
    expect(Buffer.from(badPayload, 'base64url').equals(Buffer.from(part, 'base64url'))).toBe(true); // the same bytes ...
    expect(cb.verifySignedRequest(signedOf(badPayload), SECRET)).toBeNull(); // ... another spelling, even though it carries a VALID signature of that spelling
    const canonical = signedOf(b64u(p));
    const [sig, pay] = canonical.split('.');
    const badSig = nonCanonical(sig);
    expect(badSig).not.toBeNull();
    expect(cb.verifySignedRequest(`${sig}.${pay}`, SECRET)).not.toBeNull();
    expect(cb.verifySignedRequest(`${badSig}.${pay}`, SECRET)).toBeNull();
  });
  test('padding and standard-alphabet characters stay refused as before', () => {
    const canonical = signed(payload('1'));
    const [sig, pay] = canonical.split('.');
    expect(cb.verifySignedRequest(`${sig}=.${pay}`, SECRET)).toBeNull();
    expect(cb.verifySignedRequest(`${sig.replace(/-/g, '+').replace(/_/g, '/')}.${pay}`, sig.includes('-') || sig.includes('_') ? SECRET : 'x')).toBeNull();
  });
  test('a replay of a deauthorize request in another signature spelling is refused (400), so the request is processed exactly once', async () => {
    const { env, app } = setup();
    env.seedConn({ ids: { wabaId: '1100000000000001', phoneNumberId: '1100000000000002', metaUserId: 'FBUSER1' } });
    let n = 0;
    let part;
    let base;
    do { n += 1; part = b64u(payload('FBUSER1', { n })); base = signedOf(part); } while (!nonCanonical(base.split('.')[0]));
    const [sig] = base.split('.');
    expect((await form(app, '/deauthorize', base)).status).toBe(200);
    expect((await form(app, '/deauthorize', base)).status).toBe(200); // the identical retry
    const respelled = `${nonCanonical(sig)}.${part}`;
    expect((await form(app, '/deauthorize', respelled)).status).toBe(400);
    expect(env.Inbound.rows).toHaveLength(1);
  });
});

describe('R2-07: the deauthorize idempotency key is the hash of the PAYLOAD part', () => {
  test('one ledger row per payload, keyed metacb:deauth:<sha256(payload part)[0..32)> (as the data-deletion code keys its payload)', async () => {
    const { env, app } = setup();
    env.seedConn({ ids: { wabaId: '1100000000000001', phoneNumberId: '1100000000000002', metaUserId: 'FBUSER1' } });
    const part = b64u(payload('FBUSER1'));
    const sr = signedOf(part);
    await form(app, '/deauthorize', sr);
    await form(app, '/deauthorize', sr);
    await flush();
    expect(env.Inbound.rows).toHaveLength(1);
    expect(env.Inbound.rows[0]._id).toBe(`metacb:deauth:${sha(part).slice(0, 32)}`);
    expect(env.Inbound.rows[0]._id).not.toBe(`metacb:deauth:${sha(sr).slice(0, 32)}`); // not the hash of the whole string any more
    expect(env.notes().filter((x) => x.kind === 'reconnect_needed')).toHaveLength(1);
  });
});

describe('R2-06 / R1-F4: only FAILED attempts count against the per-address limiter', () => {
  test('junk beyond 60 failures per minute is answered 429; a VALIDLY signed callback from the same address is never limited', async () => {
    const { app, env } = setup();
    const ip = '203.0.113.9';
    const junk = [];
    for (let i = 0; i < 70; i += 1) junk.push((await form(app, '/deauthorize', 'bad', ip)).status);
    expect(junk.slice(0, 60).every((c) => c === 400)).toBe(true);
    expect(junk.slice(60).every((c) => c === 429)).toBe(true);
    const del = await form(app, '/data-deletion', signed(payload('FBUSER9')), ip);
    expect(del.status).toBe(200);
    expect(del.body.confirmation_code).toMatch(/^[0-9a-f]{24}$/);
    const deauth = await form(app, '/deauthorize', signed(payload('FBUSER9', { n: 1 })), ip);
    expect(deauth.status).toBe(200);
    expect(env.Inbound.rows.length).toBeGreaterThanOrEqual(2);
  });
  test('successful callbacks do not use up the budget: 100 valid requests from one address all pass', async () => {
    const { app } = setup();
    for (let i = 0; i < 100; i += 1) expect((await form(app, '/data-deletion', signed(payload('FBUSER9')), '203.0.113.10')).status).toBe(200);
  });
  test('the budget is per address and per minute: another address is unaffected, the same one is free again after the window', async () => {
    let t = 1000000;
    const limiter = rateLimit.createLimiter({ now: () => t });
    const { app } = setup({ rateLimitDeps: { limiter } });
    for (let i = 0; i < 61; i += 1) await form(app, '/deauthorize', 'bad', '203.0.113.11');
    expect((await form(app, '/deauthorize', 'bad', '203.0.113.11')).status).toBe(429);
    expect((await form(app, '/deauthorize', 'bad', '203.0.113.12')).status).toBe(400);
    t += 61 * 1000;
    expect((await form(app, '/deauthorize', 'bad', '203.0.113.11')).status).toBe(400);
  });
  test('a 429 carries Retry-After and the same JSON error shape', async () => {
    const { app } = setup({ failedLimit: { limit: 2, windowMs: 60000 } });
    await form(app, '/deauthorize', 'x', '203.0.113.13');
    await form(app, '/deauthorize', 'x', '203.0.113.13');
    const res = await form(app, '/deauthorize', 'x', '203.0.113.13');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'rate_limited' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
  test('GET /deletion-status: a KNOWN code is never limited; unknown codes are failed attempts', async () => {
    const { app, env } = setup();
    const created = await form(app, '/data-deletion', signed(payload('FBUSER9')), '203.0.113.14');
    const code = created.body.confirmation_code;
    for (let i = 0; i < 70; i += 1) await request(app).get(`/onboarding-meta/deletion-status?code=${'a'.repeat(24)}`).set('X-Forwarded-For', '203.0.113.14');
    const unknown = await request(app).get(`/onboarding-meta/deletion-status?code=${'b'.repeat(24)}`).set('X-Forwarded-For', '203.0.113.14');
    expect(unknown.status).toBe(429);
    const known = await request(app).get(`/onboarding-meta/deletion-status?code=${code}`).set('X-Forwarded-For', '203.0.113.14');
    expect(known.status).toBe(200);
    expect(env.Inbound.rows[0]._id).toBe(`metacb:${code}`);
  });
});

describe('R7-11: support is e-mailed ONCE per data-deletion request, with the request id only', () => {
  test('the first delivery mails, the retry of the same request does not; the call carries the confirmation code and nothing else', async () => {
    const { app, email } = setup();
    const sr = signed(payload('FBUSER_SECRET_77'));
    const a = await form(app, '/data-deletion', sr);
    const b = await form(app, '/data-deletion', sr);
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(email.sendDataDeletionNotice).toHaveBeenCalledTimes(1);
    expect(email.sendDataDeletionNotice).toHaveBeenCalledWith({ requestId: a.body.confirmation_code });
    expect(JSON.stringify(email.sendDataDeletionNotice.mock.calls)).not.toMatch(/FBUSER_SECRET_77/);
  });
  test('another request is another mail', async () => {
    const { app, email } = setup();
    await form(app, '/data-deletion', signed(payload('U1')));
    await form(app, '/data-deletion', signed(payload('U2')));
    expect(email.sendDataDeletionNotice).toHaveBeenCalledTimes(2);
  });
  test('a failing, skipping or hanging mailer never fails or delays the callback (Meta still gets its answer)', async () => {
    for (const mailer of [
      { sendDataDeletionNotice: async () => { throw Object.assign(new Error('provider down with 966500000001'), { code: 'EMAIL_SEND_FAILED' }); } },
      { sendDataDeletionNotice: async () => ({ sent: false, skipped: 'no_recipient' }) },
      { sendDataDeletionNotice: () => new Promise(() => {}) },
      { sendDataDeletionNotice: () => { throw new Error('sync boom'); } },
      {},
    ]) {
      const { app } = setup({ email: mailer, mailTimeoutMs: 40 });
      const started = Date.now();
      const res = await form(app, '/data-deletion', signed(payload('U1')));
      expect(res.status).toBe(200);
      expect(res.body.url).toMatch(/\/onboarding-meta\/deletion-status\?code=[0-9a-f]{24}$/);
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });
  test('the ledger row is still recorded as before (processing, awaiting staff, workspace when exactly one matched)', async () => {
    const { app, env } = setup();
    env.seedConn({ ids: { wabaId: '1100000000000001', phoneNumberId: '1100000000000002', metaUserId: 'FBUSER1' } });
    const res = await form(app, '/data-deletion', signed(payload('FBUSER1')));
    expect(env.Inbound.rows[0]).toMatchObject({ _id: `metacb:${res.body.confirmation_code}`, type: 'data_deletion', status: 'processing', workspaceId: WS });
    expect(env.Inbound.rows[0].outcome).toBe('awaiting_staff user:FBUSER1');
  });
});
