'use strict';
const { useDatabase, connectDb, makeOwnerWorkspace, makeMerchant, graphClient, clock } = require('./_b1eEnv');
useDatabase('testmsg');

// The setup test message on REAL models + the REAL metaClient + fakeGraph (enforceApproved:true: Meta only accepts
// an APPROVED template). Nothing can leave the machine.
// Recipient rules (review R2-03): the requester's OWN login phone; an OWNER without a login phone names ONE number per workspace
// (stored masked + a keyed hash); a member never types a number; only an approved UTILITY template is ever sent.
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { createFakeGraph } = require('../_fixtures');
const OnboardingTemplate = require('../../../models/OnboardingTemplate');
const OnboardingState = require('../../../models/OnboardingState');
const OnboardingEvent = require('../../../models/OnboardingEvent');
const WhatsAppConnection = require('../../../models/WhatsAppConnection');
const Customer = require('../../../models/Customer');
const Membership = require('../../../models/Membership');
const User = require('../../../models/User');
const starter = require('../../../shared/onboarding/starterTemplates');
const testMessage = require('../../../shared/onboarding/testMessage');

let g;
let deps;
let clk;

/** A merchant whose starter templates are submitted and approved on the (fake) Meta, as the poll would learn it. */
async function approvedMerchant(opts = {}) {
  g = createFakeGraph({ wabaId: 'W1', phoneId: 'P1', enforceApproved: true });
  clk = clock();
  deps = { metaClient: graphClient(g), now: clk.now };
  const m = await makeMerchant(g, { name: `T${Math.random().toString(36).slice(2, 8)}`, ...opts });
  await starter.seedStarterTemplates(m.workspaceId, deps);
  await starter.submitQueued({ workspaceId: m.workspaceId }, deps);
  await starter.submitQueued({ workspaceId: m.workspaceId }, deps);
  if (opts.approve !== false) {
    g.approveAllTemplates();
    clk.advance(61 * 60 * 1000);
    await starter.pollStatuses({ workspaceId: m.workspaceId, submit: false }, deps);
  }
  g.calls.length = 0;
  return m;
}
const send = (m, args = {}, extra = {}) => testMessage.sendTestMessage({ workspaceId: m.workspaceId, userId: m.userId, ...args }, { ...deps, ...extra });
const stateOf = (m) => OnboardingState.findOne({ workspaceId: m.workspaceId }).lean();
const sends = () => g.callsTo('sendMessage');
const makeOwner = (m) => Membership.create({ userId: m.userId, workspaceId: m.workspaceId, role: 'owner' });
/** Another user of the workspace (a member), with a login phone of its own when `phone` is given. */
let seq = 0;
async function makeMember(m, phone) {
  seq += 1;
  const u = await User.create(phone ? { phone } : { email: `member${seq}-${m.workspaceId.slice(-6)}@example.test` });
  await Membership.create({ userId: u._id, workspaceId: m.workspaceId, role: 'member' });
  return String(u._id);
}
const keyedHash = (workspaceId, digits) => crypto.createHmac('sha256', process.env.AUTH_JWT_SECRET).update(`onb-test:${workspaceId}:${digits}`).digest('hex').slice(0, 24);

beforeAll(async () => {
  if (!process.env.AUTH_JWT_SECRET) process.env.AUTH_JWT_SECRET = 'itest-only-secret-for-the-number-hash';
  await connectDb();
  await Membership.init();
  await makeOwnerWorkspace();
});
afterAll(async () => { await mongoose.disconnect(); });

describe('the test message', () => {
  test('goes out from the merchant number with the MERCHANT token, to the user\'s own login phone', async () => {
    const m = await approvedMerchant({ userPhone: '966501234567' });
    const logs = [];
    const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    let out;
    try { out = await send(m); } finally { Object.assign(console, orig); }
    expect(out).toEqual({ sent: true, to: '********4567', templateKey: 'setup_test' });
    const sent = g.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: '966501234567', type: 'template', phoneId: 'P1', token: g.ids.merchantToken });
    expect(sent[0].template).toMatchObject({ name: `wf_${m.workspaceId.slice(-6)}_setup_test_en_v1`, language: { code: 'en' } });
    expect(sends()[0].tokenKind).toBe('merchant');
    expect(sends()[0].authorization).toBe(`Bearer ${g.ids.merchantToken}`);
    g.assertMerchantTokenOnly(g.ids.merchantToken);
    g.assertNeverUsedToken(g.ids.platformToken);
    g.assertNoForeignCalls();
    // no secret anywhere we control
    g.assertNoLeak([g.ids.merchantToken], logs);
    const dump = JSON.stringify([await stateOf(m), await OnboardingEvent.find({ workspaceId: m.workspaceId }).lean(), await OnboardingTemplate.find({ workspaceId: m.workspaceId }).lean(), logs, out]);
    expect(dump).not.toContain('966501234567');
    expect(dump).not.toContain('501234567');
    expect(dump).not.toContain(g.ids.merchantToken);
    // what is stored: masked number + timestamp + counters (no workspace test number: the login phone is the recipient)
    const st = await stateOf(m);
    expect(st.firstPromotion).toMatchObject({ testMessageCount: 1, testPhoneMasked: '********4567' });
    expect(st.firstPromotion.lastTestAt).toBeInstanceOf(Date);
    expect(st.firstPromotion.testNumberMasked).toBeUndefined();
  });

  test('a typed number is only accepted when it IS the requester\'s own login phone (nobody else\'s number can be messaged)', async () => {
    const m = await approvedMerchant({ userPhone: '966501234999' });
    await expect(send(m, { to: '0509999999' })).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', status: 422, details: { reason: 'NOT_YOUR_NUMBER' } });
    expect(sends()).toHaveLength(0);
    expect((await stateOf(m)).firstPromotion.testMessageCount).toBe(0);
    expect(await OnboardingEvent.countDocuments({ workspaceId: m.workspaceId, code: /^TEST_MESSAGE/ })).toBe(0);
    // ... the same number in another notation is the same number
    await expect(send(m, { to: '0501234999' })).resolves.toMatchObject({ sent: true, to: '********4999' });
    expect(g.sentMessages()[0].to).toBe('966501234999');
  });

  test('an e-mail-login OWNER names ONE number for the workspace: normalised, stored masked + keyed hash; another number is refused', async () => {
    const m = await approvedMerchant({ userPhone: null });
    // without a membership nobody may name a number
    await expect(send(m, { to: '0555555555' })).rejects.toMatchObject({ code: 'OWNER_ONLY', status: 403 });
    expect(sends()).toHaveLength(0);
    await makeOwner(m);
    await expect(send(m)).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'PHONE_REQUIRED' } });
    expect(sends()).toHaveLength(0);
    await expect(send(m, { to: '12' })).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID' });
    const out = await send(m, { to: '٠٥٥ ٥٥٥ ٥٥٥٥' });
    expect(out.to).toBe('********5555');
    expect(g.sentMessages()[0].to).toBe('966555555555');
    const st = await stateOf(m);
    expect(st.firstPromotion).toMatchObject({ testNumberMasked: '********5555', testNumberLast4: '5555', testNumberSetBy: m.userId });
    expect(st.firstPromotion.testNumberHash).toBe(keyedHash(m.workspaceId, '966555555555'));
    expect(JSON.stringify([st, await OnboardingEvent.find({ workspaceId: m.workspaceId }).lean()])).not.toContain('555555555');
    // the same number (any notation) is fine, any other number is not
    await expect(send(m, { to: '+966 55 555 5555' })).resolves.toMatchObject({ sent: true });
    await expect(send(m, { to: '0501111111' })).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'TEST_NUMBER_FIXED' } });
    // ... and the digits are never kept, so the owner types the number again for every test message
    await expect(send(m)).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'PHONE_REQUIRED' } });
    expect(sends()).toHaveLength(2);
  });

  test('a member without a login phone can never type a number; a member WITH a phone gets its own', async () => {
    const m = await approvedMerchant({ userPhone: null });
    await makeOwner(m);
    const noPhone = await makeMember(m);
    await expect(send(m, { userId: noPhone })).rejects.toMatchObject({ code: 'OWNER_ONLY', status: 403 });
    await expect(send(m, { userId: noPhone, to: '0501111111' })).rejects.toMatchObject({ code: 'OWNER_ONLY', status: 403 });
    expect(sends()).toHaveLength(0);
    expect((await stateOf(m)).firstPromotion.testNumberMasked).toBeUndefined();
    const withPhone = await makeMember(m, '966502223344');
    await expect(send(m, { userId: withPhone, to: '0501111111' })).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'NOT_YOUR_NUMBER' } });
    await expect(send(m, { userId: withPhone })).resolves.toMatchObject({ sent: true, to: '********3344' });
    expect(g.sentMessages()[0].to).toBe('966502223344');
  });

  test('without the server secret (AUTH_JWT_SECRET) only the last 4 digits and the counters are kept: no hash is ever stored', async () => {
    const m = await approvedMerchant({ userPhone: null });
    await makeOwner(m);
    await expect(send(m, { to: '0555555555' }, { hmacSecret: null })).resolves.toMatchObject({ sent: true, to: '********5555' });
    const st = await stateOf(m);
    expect(st.firstPromotion).toMatchObject({ testNumberMasked: '********5555', testNumberLast4: '5555', testMessageCount: 1 });
    expect(st.firstPromotion.testNumberHash).toBeUndefined();
    const ev = await OnboardingEvent.findOne({ workspaceId: m.workspaceId, code: 'TEST_MESSAGE_SENT' }).lean();
    expect(ev.meta).toEqual({ last4: '5555' });
    await expect(send(m, { to: '0501111111' }, { hmacSecret: null })).rejects.toMatchObject({ code: 'TEST_PHONE_INVALID', details: { reason: 'TEST_NUMBER_FIXED' } });
    await expect(send(m, { to: '0555555555' }, { hmacSecret: null })).resolves.toMatchObject({ sent: true });
    expect((await stateOf(m)).firstPromotion.testMessageCount).toBe(1); // a number already used is not a new number
  });

  test('a failed send gives the typed number back: the owner may name another one afterwards', async () => {
    const m = await approvedMerchant({ userPhone: null });
    await makeOwner(m);
    g.scenarios.paymentMissing();
    await expect(send(m, { to: '0555555555' })).rejects.toMatchObject({ code: 'META_ERROR' });
    const st = await stateOf(m);
    expect(st.firstPromotion.testNumberMasked).toBeUndefined();
    expect(st.firstPromotion.testNumberHash).toBeUndefined();
    expect(st.firstPromotion.testMessageCount).toBe(0);
    await expect(send(m, { to: '0501111111' })).resolves.toMatchObject({ sent: true, to: '********1111' });
    expect((await stateOf(m)).firstPromotion).toMatchObject({ testNumberMasked: '********1111', testMessageCount: 1 });
  });

  test('no approved template yet -> 409 TEST_NO_APPROVED_TEMPLATE; nothing sent, nothing counted', async () => {
    const m = await approvedMerchant({ approve: false });
    await expect(send(m)).rejects.toMatchObject({ code: 'TEST_NO_APPROVED_TEMPLATE', status: 409 });
    expect(sends()).toHaveLength(0);
    expect(await OnboardingEvent.countDocuments({ workspaceId: m.workspaceId, code: /^TEST_MESSAGE/ })).toBe(0);
    expect((await stateOf(m)).firstPromotion.testMessageCount).toBe(0);
  });

  test('a library UTILITY template is sent with sample values when it is the only approved one', async () => {
    const m = await approvedMerchant({ approve: false });
    const confirmation = await OnboardingTemplate.findOne({ workspaceId: m.workspaceId, key: 'order_confirmation', language: 'en' }).lean();
    const name = confirmation.metaTemplateName;
    g.setTemplateStatus(name, 'en', 'APPROVED');
    clk.advance(61 * 60 * 1000);
    await starter.pollStatuses({ workspaceId: m.workspaceId, submit: false }, deps);
    g.calls.length = 0;
    const out = await send(m);
    expect(out.templateKey).toBe('order_confirmation');
    const tpl = g.sentMessages()[0].template;
    expect(tpl.name).toBe(name);
    const body = tpl.components.find((c) => c.type === 'body');
    expect(body.parameters).toHaveLength(3);
    expect(tpl.components.filter((c) => c.type === 'button')).toEqual([]); // a UTILITY confirmation has no buttons (payloads stay inert anyway: unit tests)
  });

  test('a MARKETING template is NEVER used: only marketing approved -> 409; Meta re-categorising the UTILITY ones as MARKETING -> 409', async () => {
    const m = await approvedMerchant({ approve: false });
    for (const key of ['comeback', 'promotion_weekend']) {
      const row = await OnboardingTemplate.findOne({ workspaceId: m.workspaceId, key, language: 'en' }).lean();
      g.setTemplateStatus(row.metaTemplateName, 'en', 'APPROVED');
    }
    clk.advance(61 * 60 * 1000);
    await starter.pollStatuses({ workspaceId: m.workspaceId, submit: false }, deps);
    expect(await OnboardingTemplate.countDocuments({ workspaceId: m.workspaceId, metaStatus: 'APPROVED' })).toBe(2);
    g.calls.length = 0;
    await expect(send(m)).rejects.toMatchObject({ code: 'TEST_NO_APPROVED_TEMPLATE', status: 409 });
    expect(sends()).toHaveLength(0);
    // everything approved, but what Meta reports for the UTILITY ones is MARKETING now
    g.approveAllTemplates();
    clk.advance(61 * 60 * 1000);
    await starter.pollStatuses({ workspaceId: m.workspaceId, submit: false }, deps);
    await OnboardingTemplate.updateMany({ workspaceId: m.workspaceId, category: 'UTILITY' }, { $set: { category: 'MARKETING' } });
    g.calls.length = 0;
    await expect(send(m)).rejects.toMatchObject({ code: 'TEST_NO_APPROVED_TEMPLATE', status: 409 });
    expect(sends()).toHaveLength(0);
    expect(await OnboardingEvent.countDocuments({ workspaceId: m.workspaceId, code: /^TEST_MESSAGE/ })).toBe(0);
    expect((await stateOf(m)).firstPromotion.testMessageCount).toBe(0);
  });
});

describe('limits are counted in the DB', () => {
  test('5 per hour per workspace, then 429; the sixth never reaches Meta; fresh after the hour', async () => {
    const m = await approvedMerchant();
    for (let i = 0; i < 5; i += 1) await send(m);
    const err = await send(m).catch((e) => e);
    expect(err).toMatchObject({ code: 'TEST_RATE_LIMITED', status: 429 });
    expect(err.retryAfterSec).toBeGreaterThan(0);
    expect(sends()).toHaveLength(5);
    expect(await OnboardingEvent.countDocuments({ workspaceId: m.workspaceId, code: 'TEST_MESSAGE_VOID' })).toBe(1);
    expect(await OnboardingEvent.countDocuments({ workspaceId: m.workspaceId, code: 'TEST_MESSAGE_SENT' })).toBe(5);
    clk.advance(61 * 60 * 1000);
    await expect(send(m)).resolves.toMatchObject({ sent: true });
  });

  test('a burst of simultaneous requests sends at most 5 (record first, then re-count)', async () => {
    const m = await approvedMerchant();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => send(m)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBeLessThanOrEqual(5);
    expect(sends()).toHaveLength(ok);
    for (const r of results) if (r.status === 'rejected') expect(r.reason.code).toBe('TEST_RATE_LIMITED');
  });

  test('2 distinct numbers per workspace lifetime (members with their own phones); the third is TEST_NUMBER_LIMIT; a known number is fine; a failed send gives the slot back', async () => {
    const m = await approvedMerchant({ userPhone: '966501111111' });
    const second = await makeMember(m, '966502222222');
    const third = await makeMember(m, '966503333333');
    await send(m);
    await send(m, { userId: second });
    await expect(send(m, { userId: third })).rejects.toMatchObject({ code: 'TEST_NUMBER_LIMIT', status: 409 });
    expect(sends()).toHaveLength(2);
    expect((await stateOf(m)).firstPromotion.testMessageCount).toBe(2);
    await expect(send(m)).resolves.toMatchObject({ sent: true }); // the first user's number is already known
    expect((await stateOf(m)).firstPromotion.testMessageCount).toBe(2);
    // an admin lifting the cap = lowering the counter; a Meta failure for a NEW number must not consume it
    await OnboardingState.updateOne({ workspaceId: m.workspaceId }, { $set: { 'firstPromotion.testMessageCount': 1 } });
    g.scenarios.paymentMissing();
    await expect(send(m, { userId: third })).rejects.toMatchObject({ code: 'META_ERROR' });
    expect((await stateOf(m)).firstPromotion.testMessageCount).toBe(1);
    await expect(send(m, { userId: third })).resolves.toMatchObject({ sent: true });
    expect((await stateOf(m)).firstPromotion.testMessageCount).toBe(2);
  });

  test('limits are per workspace', async () => {
    const a = await approvedMerchant();
    for (let i = 0; i < 5; i += 1) await send(a);
    await expect(send(a)).rejects.toMatchObject({ code: 'TEST_RATE_LIMITED' });
    const gA = g;
    const b = await approvedMerchant();
    expect(gA).not.toBe(g);
    await expect(send(b)).resolves.toMatchObject({ sent: true });
  });
});

describe('consent: an opted-out customer is never messaged', () => {
  test('a Customer of this workspace with optedOut:true -> 422, nothing sent, nothing counted', async () => {
    const m = await approvedMerchant({ userPhone: '966507654321' });
    await Customer.create({ workspaceId: m.workspaceId, firstname: 'Sara', lastname: 'A', phone: '966507654321', optedOut: true, optedOutAt: new Date() });
    await expect(send(m)).rejects.toMatchObject({ code: 'TEST_RECIPIENT_OPTED_OUT', status: 422 });
    expect(sends()).toHaveLength(0);
    expect(await OnboardingEvent.countDocuments({ workspaceId: m.workspaceId, code: /^TEST_MESSAGE/ })).toBe(0);
    expect((await stateOf(m)).firstPromotion.testMessageCount).toBe(0);
  });

  test('an opted-out customer stored in another notation (+966, spaces) still blocks', async () => {
    const m = await approvedMerchant({ userPhone: '966507654322' });
    await Customer.create({ workspaceId: m.workspaceId, firstname: 'Sara', lastname: 'B', phone: '+966 50 765 4322', optedOut: true, optedOutAt: new Date() });
    await expect(send(m)).rejects.toMatchObject({ code: 'TEST_RECIPIENT_OPTED_OUT', status: 422 });
    expect(sends()).toHaveLength(0);
  });

  test('an opted-out customer of ANOTHER workspace does not block; an opted-in customer does not block', async () => {
    const other = await approvedMerchant();
    const m = await approvedMerchant({ userPhone: '966508888888' });
    await Customer.create({ workspaceId: other.workspaceId, firstname: 'X', lastname: 'Y', phone: '966508888888', optedOut: true });
    await Customer.create({ workspaceId: m.workspaceId, firstname: 'Z', lastname: 'Y', phone: '966508888888', optedOut: false, marketingConsent: true });
    await expect(send(m)).resolves.toMatchObject({ sent: true });
  });
});

describe('connection and Meta failures', () => {
  test('a revoked token (190) flags the connection and rolls the counters back', async () => {
    const m = await approvedMerchant();
    g.scenarios.token190();
    await expect(send(m)).rejects.toMatchObject({ code: 'WHATSAPP_RECONNECT_REQUIRED' });
    expect((await WhatsAppConnection.findOne({ workspaceId: m.workspaceId }).lean()).needsReconnect).toBe(true);
    expect((await stateOf(m)).firstPromotion.testMessageCount).toBe(0);
    expect(await OnboardingEvent.countDocuments({ workspaceId: m.workspaceId, code: 'TEST_MESSAGE_FAILED' })).toBe(1);
    g.calls.length = 0;
    await expect(send(m)).rejects.toMatchObject({ code: 'WHATSAPP_RECONNECT_REQUIRED' }); // refused up front now
    expect(g.calls).toHaveLength(0);
  });

  test('a network failure -> 503 META_UNREACHABLE, not counted', async () => {
    const m = await approvedMerchant();
    g.scenarios.networkDrop({ code: 'ETIMEDOUT' });
    await expect(send(m)).rejects.toMatchObject({ code: 'META_UNREACHABLE', status: 503 });
    expect((await stateOf(m)).firstPromotion.testMessageCount).toBe(0);
    await expect(send(m)).resolves.toMatchObject({ sent: true });
  });

  test('not connected -> WHATSAPP_NOT_CONNECTED; no approved template of someone else is borrowed', async () => {
    const a = await approvedMerchant();
    const b = await makeMerchant(g, { name: 'NoConnB', connStatus: null });
    await expect(send(b)).rejects.toMatchObject({ code: 'WHATSAPP_NOT_CONNECTED' });
    const c = await makeMerchant(g, { name: 'NoTemplatesC' });
    await expect(send(c)).rejects.toMatchObject({ code: 'TEST_NO_APPROVED_TEMPLATE' });
    expect(sends()).toHaveLength(0);
    expect(a.workspaceId).not.toBe(c.workspaceId);
  });
});

describe('route (mini app, real modules)', () => {
  const { createRouter } = require('../../../routes/onboarding/test');
  function mkApp(m, userId = m.userId) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { id: userId, workspaceId: m.workspaceId, role: 'owner' }; next(); });
    app.use(createRouter({ moduleDeps: deps, rateLimitDeps: { limiter: require('../../../shared/onboarding/rateLimit').createLimiter() } }));
    return app;
  }

  test('POST /test-message -> 200 { sent, to (masked), templateKey }; errors carry codes only', async () => {
    const m = await approvedMerchant({ userPhone: '966501230000' });
    await makeOwner(m); // the route re-reads the Membership: a live member is required
    const app = mkApp(m);
    const ok = await request(app).post('/test-message').send({});
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ sent: true, to: '********0000', templateKey: 'setup_test' });
    const bad = await request(app).post('/test-message').send({ phone: 'nope' });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: 'TEST_PHONE_INVALID' });
    const stranger = await request(app).post('/test-message').send({ phone: '0509876543' });
    expect(stranger.status).toBe(422);
    expect(stranger.body).toMatchObject({ code: 'TEST_PHONE_INVALID' });
    expect(JSON.stringify([ok.body, bad.body, stranger.body])).not.toMatch(/966501230000|0509876543|EAAFXT/);
    for (let i = 0; i < 4; i += 1) await request(app).post('/test-message').send({});
    const limited = await request(app).post('/test-message').send({});
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('TEST_RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  test('a user who is no longer a member (stale 30-day login) gets 403 NOT_A_MEMBER: nothing is sent, nothing counted (review R2-05)', async () => {
    const m = await approvedMerchant({ userPhone: '966501230001' }); // a user with a phone, but NO Membership row
    const res = await request(mkApp(m)).post('/test-message').send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_A_MEMBER');
    expect(sends()).toHaveLength(0);
    expect((await stateOf(m)).firstPromotion.testMessageCount).toBe(0);
    expect(await OnboardingEvent.countDocuments({ workspaceId: m.workspaceId, code: /^TEST_MESSAGE/ })).toBe(0);
    // a MEMBER (not an owner) with a phone of its own is fine
    const member = await makeMember(m, '966501230002');
    const ok = await request(mkApp(m, member)).post('/test-message').send({});
    expect(ok.status).toBe(200);
    expect(ok.body.to).toBe('********0002');
  });

  test('GET /first-promotion tells an owner without a phone that a number is needed, and a member that none is', async () => {
    const m = await approvedMerchant({ userPhone: null });
    await makeOwner(m);
    const member = await makeMember(m);
    const asOwner = await request(mkApp(m)).get('/first-promotion');
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.testRecipient).toEqual({ masked: null, needsPhone: true });
    const asMember = await request(mkApp(m, member)).get('/first-promotion');
    expect(asMember.body.testRecipient).toEqual({ masked: null, needsPhone: false });
  });
});
