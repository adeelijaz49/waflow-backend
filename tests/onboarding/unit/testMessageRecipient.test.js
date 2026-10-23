'use strict';
// Reviews R2-03 / R2-08 / R2-05 on the setup test message: the recipient is the REQUESTER'S OWN login phone; only an OWNER without a login
// phone may type ONE number per workspace (stored masked + a keyed hash); members can never type a number; only UTILITY templates are
// sent; the opted-out check covers every stored notation; the platform account is never a sender; a removed member gets a 403 on the route.
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const testMessage = require('../../../shared/onboarding/testMessage');
const { WS, WS2, USER, PLATFORM_TOKEN, makeWorld, seedTemplate, flat } = require('./_b1eKit');
const { newId } = require('./_b0Store');

const SAVED = {};
const ENV = ['WA_TOKEN', 'WA_PHONE_ID', 'WA_WABA_ID'];
beforeEach(() => { for (const k of ENV) { SAVED[k] = process.env[k]; delete process.env[k]; } process.env.WA_TOKEN = PLATFORM_TOKEN; process.env.WA_PHONE_ID = '999000111222'; });
afterEach(() => { for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

const approved = (w, key, language, extra = {}) => seedTemplate(w, {
  key, language, metaTemplateId: `${key}-${language}`, metaTemplateName: `wf_439011_${key}_${language}_v1`, metaStatus: 'APPROVED',
  metaStatusRaw: 'APPROVED', category: key === 'setup_test' || key === 'order_confirmation' ? 'UTILITY' : 'MARKETING', source: key === 'setup_test' ? 'setup_test' : 'library', ...extra,
});
const sends = (w) => w.client.calls.filter((c) => c.name === 'send');
const send = (w, args = {}, extraDeps = {}) => testMessage.sendTestMessage({ workspaceId: WS, userId: USER, ...args }, { ...w.deps, ...extraDeps });
function addUser(w, phone, role = 'member') {
  const id = newId();
  w.User.seed({ _id: id, ...(phone ? { phone } : { email: 'x@y.test' }) });
  if (role) w.Membership.seed({ userId: id, workspaceId: WS, role });
  return id;
}
const SECRET = 'unit-test-server-secret-0123456789';

describe('a user WITH a login phone: only that number, owner or member', () => {
  test.each([['owner'], ['member']])('a %s with a login phone is messaged on it', async (role) => {
    const w = makeWorld({ role });
    approved(w, 'setup_test', 'en');
    await expect(send(w)).resolves.toMatchObject({ sent: true, to: '********4567' });
    expect(sends(w)[0].args.to).toBe('966501234567');
  });
  test.each([['owner'], ['member']])('a %s typing ANOTHER number is refused (NOT_YOUR_NUMBER): nothing sent, counted or stored', async (role) => {
    const w = makeWorld({ role });
    approved(w, 'setup_test', 'en');
    for (const typed of ['+966 55 501 9977', '0555019977', '00966555019977', 555019977]) {
      await expect(send(w, { to: typed })).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'NOT_YOUR_NUMBER' } });
    }
    expect(sends(w)).toHaveLength(0);
    expect(w.Event.rows).toHaveLength(0);
    expect(w.State.rows[0].firstPromotion.testMessageCount).toBe(0);
    expect(w.State.rows[0].firstPromotion.testNumberMasked).toBeUndefined();
  });
  test('an invalid typed number is a plain TEST_PHONE_INVALID (not a stranger error) and never reaches Meta', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    await expect(send(w, { to: 'abc' })).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'PHONE_INVALID' } });
    expect(sends(w)).toHaveLength(0);
  });
  test('a MEMBER can never message a stranger, with a marketing-only workspace or with a ready test template alike', async () => {
    const w = makeWorld({ role: 'member' });
    approved(w, 'comeback', 'en');
    await expect(send(w, { to: '0555019977' })).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'NOT_YOUR_NUMBER' } });
    approved(w, 'setup_test', 'en');
    await expect(send(w, { to: '0555019977' })).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'NOT_YOUR_NUMBER' } });
    expect(sends(w)).toHaveLength(0);
  });
});

describe('a user WITHOUT a login phone (e-mail login)', () => {
  test('a MEMBER can never type a number: 403 OWNER_ONLY, with or without a typed number, nothing sent or stored', async () => {
    const w = makeWorld({ userPhone: null, role: 'member' });
    approved(w, 'setup_test', 'en');
    for (const to of [undefined, '0555019977', '0501234567']) {
      await expect(send(w, { to })).rejects.toMatchObject({ code: 'OWNER_ONLY', status: 403 });
    }
    expect(sends(w)).toHaveLength(0);
    expect(w.Event.rows).toHaveLength(0);
    expect(w.State.rows[0].firstPromotion.testNumberMasked).toBeUndefined();
  });
  test('a removed member (no Membership any more) is refused the same way', async () => {
    const w = makeWorld({ userPhone: null, role: null });
    approved(w, 'setup_test', 'en');
    await expect(send(w, { to: '0555019977' })).rejects.toMatchObject({ code: 'OWNER_ONLY', status: 403 });
    expect(sends(w)).toHaveLength(0);
  });
  test('the role comes from the LIVE membership, not from anything the caller says (a demoted owner is a member)', async () => {
    const w = makeWorld({ userPhone: null });
    approved(w, 'setup_test', 'en');
    await expect(send(w, { to: '0555019977' })).resolves.toMatchObject({ sent: true });
    w.Membership.rows[0].role = 'member';
    await expect(send(w, { to: '0555019977' })).rejects.toMatchObject({ code: 'OWNER_ONLY' });
  });
  test('the OWNER must type a number (PHONE_REQUIRED); the first one becomes the workspace test number', async () => {
    const w = makeWorld({ userPhone: null });
    approved(w, 'setup_test', 'en');
    await expect(send(w)).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'PHONE_REQUIRED' } });
    const out = await send(w, { to: '0555019977' });
    expect(out).toEqual({ sent: true, to: '********9977', templateKey: 'setup_test' });
    expect(sends(w)[0].args.to).toBe('966555019977');
    const fp = w.State.rows[0].firstPromotion;
    expect(fp).toMatchObject({ testNumberMasked: '********9977', testNumberLast4: '9977', testMessageCount: 1 });
    expect(fp.testNumberHash).toMatch(/^[0-9a-f]{24}$/);
    expect(fp.testNumberSetBy).toBe(USER);
    expect(fp.testNumberSetAt).toBeInstanceOf(Date);
  });
  test('later requests must be the SAME number (any notation); another number is refused (TEST_NUMBER_FIXED)', async () => {
    const w = makeWorld({ userPhone: null });
    approved(w, 'setup_test', 'en');
    await send(w, { to: '0555019977' });
    await expect(send(w, { to: '+966 55 501 9977' })).resolves.toMatchObject({ sent: true });
    await expect(send(w, { to: '00966555019977' })).resolves.toMatchObject({ sent: true });
    await expect(send(w, { to: '0555019988' })).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'TEST_NUMBER_FIXED' } });
    await expect(send(w, { to: '0501234567' })).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'TEST_NUMBER_FIXED' } });
    expect(sends(w).map((s) => s.args.to)).toEqual(['966555019977', '966555019977', '966555019977']);
    await expect(send(w)).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'PHONE_REQUIRED' } }); // the server cannot recall the digits: they are typed again
  });
  test('two simultaneous first requests with different numbers: ONE becomes the workspace number, the other is refused', async () => {
    const w = makeWorld({ userPhone: null });
    approved(w, 'setup_test', 'en');
    const results = await Promise.allSettled([send(w, { to: '0555019977' }), send(w, { to: '0555019988' })]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'TEST_NUMBER_FIXED' } });
    expect(sends(w)).toHaveLength(1);
  });
  test('a failed send gives the number slot back: a typo can be corrected (the stored number is cleared again)', async () => {
    const w = makeWorld({ userPhone: null });
    approved(w, 'setup_test', 'en');
    w.client.failNext.push({ name: 'send', err: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) });
    await expect(send(w, { to: '0555019977' })).rejects.toMatchObject({ code: 'META_UNREACHABLE' });
    expect(w.State.rows[0].firstPromotion.testNumberMasked).toBeUndefined();
    expect(w.State.rows[0].firstPromotion.testNumberHash).toBeUndefined();
    await expect(send(w, { to: '0555019988' })).resolves.toMatchObject({ sent: true, to: '********9988' });
    expect(w.State.rows[0].firstPromotion.testNumberLast4).toBe('9988');
  });
  test('the opted-out check and the own-number check run BEFORE the number is stored', async () => {
    const w = makeWorld({ userPhone: null, displayPhoneNumber: '+966 55 501 9977' });
    approved(w, 'setup_test', 'en');
    await expect(send(w, { to: '0555019977' })).rejects.toMatchObject({ details: { reason: 'SAME_AS_BUSINESS_NUMBER' } });
    w.Customer.seed({ workspaceId: WS, phone: '966555019988', optedOut: true });
    await expect(send(w, { to: '0555019988' })).rejects.toMatchObject({ code: 'TEST_RECIPIENT_OPTED_OUT' });
    expect(w.State.rows[0].firstPromotion.testNumberMasked).toBeUndefined();
    expect(w.Event.rows).toHaveLength(0);
  });
});

describe('R2-08: the stored number hash is keyed with a SERVER secret', () => {
  const expectedHash = (digits, secret = SECRET) => crypto.createHmac('sha256', secret).update(`onb-test:${WS}:${digits}`).digest('hex').slice(0, 24);

  test('the event row and the workspace number carry HMAC(server secret, workspace + digits); the old workspace-derived key no longer matches', async () => {
    const w = makeWorld({ userPhone: null });
    approved(w, 'setup_test', 'en');
    await send(w, { to: '0555019977' });
    const stored = w.State.rows[0].firstPromotion.testNumberHash;
    expect(stored).toBe(expectedHash('966555019977'));
    expect(w.Event.rows[0].meta).toEqual({ h: stored, last4: '9977' });
    const legacy = crypto.createHmac('sha256', `onb-test:${WS}`).update('966555019977').digest('hex').slice(0, 24); // the old, derivable key
    expect(stored).not.toBe(legacy);
    // an attacker with a copy of the database but without the secret cannot confirm a guess
    expect(testMessage.numberHash(WS, '966555019977', 'wrong-secret')).not.toBe(stored);
    expect(testMessage.numberHash(WS, '966555019977', SECRET)).toBe(stored);
    expect(testMessage.numberHash(WS2, '966555019977', SECRET)).not.toBe(stored); // workspace scoped
  });
  test('without AUTH_JWT_SECRET (no secret) NO hash is stored anywhere: only the last 4 digits, the masked number and the counters', async () => {
    const w = makeWorld({ userPhone: null, hmacSecret: null });
    approved(w, 'setup_test', 'en');
    expect(testMessage.numberHash(WS, '966555019977', null)).toBeNull();
    await send(w, { to: '0555019977' });
    const fp = w.State.rows[0].firstPromotion;
    expect(fp.testNumberHash).toBeUndefined();
    expect(fp).toMatchObject({ testNumberMasked: '********9977', testNumberLast4: '9977' });
    expect(w.Event.rows[0].meta).toEqual({ last4: '9977' });
    expect(flat([w.State.rows, w.Event.rows])).not.toMatch(/555019977/);
    // the one-number rule still holds, by the last 4 digits
    await expect(send(w, { to: '0555019977' })).resolves.toMatchObject({ sent: true });
    await expect(send(w, { to: '0555010000' })).rejects.toMatchObject({ details: { reason: 'TEST_NUMBER_FIXED' } });
  });
  test('the secret is read from AUTH_JWT_SECRET when no dependency is injected', async () => {
    const saved = process.env.AUTH_JWT_SECRET;
    process.env.AUTH_JWT_SECRET = 'from-the-environment-secret-0123456789';
    try {
      const w = makeWorld({ userPhone: null });
      delete w.deps.hmacSecret;
      approved(w, 'setup_test', 'en');
      await send(w, { to: '0555019977' });
      expect(w.State.rows[0].firstPromotion.testNumberHash).toBe(expectedHash('966555019977', 'from-the-environment-secret-0123456789'));
      delete process.env.AUTH_JWT_SECRET;
      const w2 = makeWorld({ userPhone: null });
      delete w2.deps.hmacSecret;
      approved(w2, 'setup_test', 'en');
      await send(w2, { to: '0555019977' });
      expect(w2.State.rows[0].firstPromotion.testNumberHash).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.AUTH_JWT_SECRET; else process.env.AUTH_JWT_SECRET = saved;
    }
  });
});

describe('the opted-out check covers every stored notation of the number', () => {
  test.each([
    ['international digits', '966501234567'],
    ['plus + digits', '+966501234567'],
    ['plus with spaces', '+966 50 123 4567'],
    ['00 prefix', '00966501234567'],
    ['local with a trunk zero', '0501234567'],
    ['local with spaces and dashes', '050-123 4567'],
    ['bare national number', '501234567'],
    ['Arabic-Indic digits', '٠٥٠١٢٣٤٥٦٧'],
    ['parentheses', '(966) 50 123 4567'],
  ])('a customer stored as %s (opted out) blocks the test message', async (_label, stored) => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    w.Customer.seed({ workspaceId: WS, phone: stored, optedOut: true });
    await expect(send(w)).rejects.toMatchObject({ code: 'TEST_RECIPIENT_OPTED_OUT', status: 422 });
    expect(sends(w)).toHaveLength(0);
    expect(w.Event.rows).toHaveLength(0);
  });
  test('a customer who did not opt out, one of another workspace and one with a different number do not block', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    w.Customer.seed({ workspaceId: WS, phone: '0501234567', optedOut: false });
    w.Customer.seed({ workspaceId: WS2, phone: '0501234567', optedOut: true });
    w.Customer.seed({ workspaceId: WS, phone: '0501234568', optedOut: true });
    w.Customer.seed({ workspaceId: WS, phone: '+971501234567', optedOut: true }); // another country, same national digits
    await expect(send(w)).resolves.toMatchObject({ sent: true });
  });
});

describe('the PLATFORM account is never a sender', () => {
  test('a connection whose WABA or phone id is the platform\'s is refused before anything is sent or counted', async () => {
    for (const ids of [{ wabaId: '222222222222222', phoneNumberId: 'P1' }, { wabaId: 'W1', phoneNumberId: '111111111111111' }]) {
      process.env.WA_WABA_ID = '222222222222222';
      process.env.WA_PHONE_ID = '111111111111111';
      const w = makeWorld();
      w.Conn.rows[0].ids = ids;
      approved(w, 'setup_test', 'en');
      await expect(send(w)).rejects.toMatchObject({ code: 'WHATSAPP_NOT_CONNECTED' });
      expect(w.client.calls).toHaveLength(0);
      expect(w.Event.rows).toHaveLength(0);
    }
  });
});

describe('the route: a removed member\'s JWT gets 403 (live Membership), a member of the workspace goes through', () => {
  const { createRouter } = require('../../../routes/onboarding/test');
  const rateLimit = require('../../../shared/onboarding/rateLimit');
  const gateDepsOf = (w) => ({ getGateState: async () => ({ enrolled: true, sub: { state: 'active', source: 'admin' }, conn: { status: 'connected' } }), Membership: w.Membership });
  const mkApp = (w, user) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = user; next(); });
    app.use(createRouter({ moduleDeps: w.deps, rateLimitDeps: { limiter: rateLimit.createLimiter() }, gateDeps: gateDepsOf(w) }));
    return app;
  };

  test('a user without a Membership: 403 NOT_A_MEMBER before anything else (no template, no Graph call, no limiter use)', async () => {
    const w = makeWorld();
    approved(w, 'setup_test', 'en');
    const removed = addUser(w, '0501234567', null);
    const res = await request(mkApp(w, { id: removed, workspaceId: WS, role: 'owner' })).post('/test-message').send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'NOT_A_MEMBER' });
    expect(sends(w)).toHaveLength(0);
    expect(w.client.calls).toHaveLength(0);
    expect(w.Event.rows).toHaveLength(0);
  });
  test('a stale JWT role (owner) is not enough, and a current member passes', async () => {
    const w = makeWorld({ role: 'member' });
    approved(w, 'setup_test', 'en');
    const ok = await request(mkApp(w, { id: USER, workspaceId: WS, role: 'owner' })).post('/test-message').send({});
    expect(ok.status).toBe(200);
    w.Membership.rows.length = 0;
    const gone = await request(mkApp(w, { id: USER, workspaceId: WS, role: 'owner' })).post('/test-message').send({});
    expect(gone.status).toBe(403);
    expect(gone.body.code).toBe('NOT_A_MEMBER');
    expect(sends(w)).toHaveLength(1);
  });
  test('a member without a login phone typing a stranger number: 403 OWNER_ONLY through the route', async () => {
    const w = makeWorld({ userPhone: null, role: 'member' });
    approved(w, 'setup_test', 'en');
    const res = await request(mkApp(w, { id: USER, workspaceId: WS, role: 'member' })).post('/test-message').send({ phone: '0555019977' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OWNER_ONLY');
    expect(sends(w)).toHaveLength(0);
  });
});
