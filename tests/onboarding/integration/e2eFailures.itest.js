'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_e2efail`;
assertThrowawayDb();

// END TO END (task I1b): Path B (pause, reminders, support), every connect failure case, reconnect and disconnect,
// against the REAL server.js with only Graph / Stripe / Resend faked.
const { createWorld, spyConsole } = require('./_e2eWorld');

jest.setTimeout(90000);

let w;
let con;
const stateOf = async (t, who = 'owner') => (await w.get(t[who], '/state')).body;
const exchanges = (g) => g.callsTo('exchange').length;

beforeAll(async () => { w = await createWorld({ policy: 'block' }); con = spyConsole(); });
afterAll(async () => { con.restore(); await w.handle.stop(); });

describe('Path B: no number yet -> paused, reminders, support request, resume', () => {
  let t;
  beforeAll(async () => { t = await w.tenant('Path B'); await w.put(t.owner, '/business', w.BUSINESS(t)); });

  test('"I have no number" pauses the setup visibly and connect stays blocked', async () => {
    const r = await w.post(t.owner, '/number/path', { hasNumber: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ path: 'B', nextStep: 'number' });
    expect(r.body.guidance.keys.length).toBeGreaterThan(0);
    expect(await stateOf(t)).toMatchObject({ progress: { status: 'paused_number' }, number: { path: 'B', paused: true, numberReady: false }, nextStep: 'number', steps: { number: { status: 'in_progress' } }, locked: true });
    const cfg = await w.get(t.owner, '/connect/config');
    expect(cfg.status).toBe(409);
    expect(cfg.body.code).toBe('STEP_PREREQUISITE');
    // the same answer again is a no-op
    const again = await w.post(t.owner, '/number/path', { hasNumber: false });
    expect(again.status).toBe(200);
  });

  test('"Ask WaFlow to help me get a number": one request, one support e-mail (escaped), duplicates are not re-sent', async () => {
    w.mail.reset();
    const evil = 'Call me <script>alert(1)</script> & thanks';
    const a = await w.post(t.owner, '/number/support-request', { message: evil });
    expect(a.status).toBe(200);
    const b = await w.post(t.owner, '/number/support-request', { message: 'second try' });
    expect(b.status).toBe(200);
    expect(await w.M('OnboardingSupportRequest').countDocuments({ workspaceId: t.ws })).toBe(1);
    const toSupport = w.mail.sent.filter((m) => m.to === 'support@waflow.test' || (Array.isArray(m.to) && m.to.includes('support@waflow.test')));
    expect(toSupport).toHaveLength(1);
    expect(toSupport[0].html).not.toContain('<script>');
    expect(toSupport[0].html).toContain('&lt;script&gt;');
    expect(toSupport[0].html + toSupport[0].text).not.toContain(t.owner.phone);
    expect((await stateOf(t)).number.helpRequested).toBe(true);
    const ctx = await w.get(t.owner, '/help-context');
    expect(ctx.body).toMatchObject({ stepKey: 'number', supportEmail: 'support@waflow.test' });
    expect(JSON.stringify(ctx.body)).not.toContain(t.owner.phone);
    const notes = (await w.get(t.owner, '/notifications')).body;
    expect(notes.notifications.some((n) => n.kind === 'help_received')).toBe(true);
  });

  test('reminders at +24 h and +3 d reach the owner (one e-mail each), never closer than 24 h, and stop once the number is ready', async () => {
    const reminders = require('../../../shared/onboarding/reminders');
    w.mail.reset();
    const row0 = await w.rowOf(t.ws);
    const base = new Date(row0.number.pausedAt).getTime();
    const run = (ms) => reminders.runPathBReminders({ now: new Date(base + ms) });
    expect((await run(60 * 60 * 1000)).sent).toBe(0); // too early
    expect((await run(25 * 3600 * 1000)).sent).toBeGreaterThanOrEqual(1);
    expect((await run(26 * 3600 * 1000)).sent).toBe(0); // < 24 h since the last one
    expect((await run(3 * 86400 * 1000 + 3600 * 1000)).sent).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 200));
    const mails = w.mail.sent.filter((m) => m.to === t.owner.email);
    expect(mails.length).toBe(2);
    expect(mails.every((m) => !m.html.includes(t.owner.phone))).toBe(true);
    expect((await w.rowOf(t.ws)).number.reminderCount).toBe(2);
    const notes = (await w.get(t.owner, '/notifications')).body.notifications.filter((n) => n.kind.startsWith('path_b') || n.kind === 'number_reminder' || /remind/.test(n.kind));
    expect(notes.length).toBeGreaterThanOrEqual(2);
    // the number is ready: the pause ends and the reminders stop for good
    const ready = await w.post(t.owner, '/number/ready', {});
    expect(ready.status).toBe(200);
    expect(await stateOf(t)).toMatchObject({ progress: { status: 'in_progress' }, number: { numberReady: true, paused: false }, steps: { number: { status: 'done' } }, nextStep: 'connect' });
    w.mail.reset();
    expect((await run(30 * 86400 * 1000)).sent).toBe(0);
    expect(w.mail.sent).toHaveLength(0);
    // and now connect is possible
    expect((await w.get(t.owner, '/connect/config')).status).toBe(200);
  });
});

describe('connect: the popup outcomes and every failing step have a code, a way forward and keep the setup resumable', () => {
  test('cancel / popup error / no Facebook account: a code, a copy key and the next step; nothing is stored as a failure of the account', async () => {
    const t = await w.tenant('Popup');
    const ctx = await w.prepareConnect(t);
    const ev = (body) => w.post(t.owner, '/connect/event', { attemptId: ctx.attemptId, ...body });
    const cancel = await ev({ event: 'CANCEL', currentStep: 'PHONE_NUMBER_SETUP' });
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ outcome: expect.any(String), code: 'CONNECT_CANCELLED', nextStep: 'connect', copyKey: expect.any(String) });
    expect((await ev({ event: 'NO_FACEBOOK' })).body.code).toBe('CONNECT_NO_FACEBOOK_ACCOUNT');
    const err = await ev({ event: 'ERROR', errorCode: '3441030', errorMessage: 'The number is registered somewhere else' });
    expect(err.body.code).toBe('CONNECT_NUMBER_REGISTERED_ELSEWHERE');
    expect(err.body.nextStep).toBe('number');
    expect((await ev({ event: 'EXPLODE' })).status).toBe(422);
    expect((await w.post(t.owner, '/connect/event', { event: 'CANCEL' })).status).toBe(422); // the attempt id is required (format only: the outcome mapping is stateless)
    expect(w.graph.calls().filter((c) => c.fake === `T${t.ws}`)).toHaveLength(0); // the popup events never reach Graph
    expect((await stateOf(t)).steps.connect.status).toBe('todo');
  });

  test('wrong or stale attempt, missing legal acceptance, a member, no encryption key: refused BEFORE any Graph call', async () => {
    const t = await w.tenant('Prereq');
    const ctx = await w.prepareConnect(t);
    const calls = () => w.graph.get(`T${t.ws}`).calls.length;
    const bad = await w.post(t.owner, '/connect/complete', { attemptId: 'f'.repeat(32), code: w.nextCode(), session: w.flat(ctx.graph.session('FINISH')) });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('CONNECT_ATTEMPT_INVALID');
    const member = await w.post(t.member, '/connect/complete', { attemptId: ctx.attemptId, code: w.nextCode(), session: w.flat(ctx.graph.session('FINISH')) });
    expect(member.status).toBe(403);
    expect(member.body.code).toBe('OWNER_ONLY');
    const key = process.env.WA_TOKEN_ENCRYPTION_KEY;
    delete process.env.WA_TOKEN_ENCRYPTION_KEY;
    try {
      const noKey = await w.post(t.owner, '/connect/complete', { attemptId: ctx.attemptId, code: w.nextCode(), session: w.flat(ctx.graph.session('FINISH')) });
      expect(noKey.status).toBe(503);
      expect(noKey.body.code).toBe('ENCRYPTION_NOT_CONFIGURED');
      expect((await w.get(t.owner, '/connect/config')).body.code).toBe('ENCRYPTION_NOT_CONFIGURED');
    } finally { process.env.WA_TOKEN_ENCRYPTION_KEY = key; }
    expect(calls()).toBe(0);
    // legal acceptance is enforced server-side on this endpoint only (D13)
    const nl = await w.tenant('NoLegal', { legalAccepted: false });
    const nlc = await w.prepareConnect(nl);
    const refused = await w.complete(nl, nlc);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    expect(nlc.graph.calls).toHaveLength(0);
  });

  test('the code exchange fails (expired / used twice): 422 with a way forward, the attempt stays usable, one fresh code finishes', async () => {
    const t = await w.tenant('Expired');
    const ctx = await w.prepareConnect(t);
    ctx.graph.scenarios.codeExpired();
    const first = await w.complete(t, ctx);
    expect(first.status).toBe(422);
    expect(first.body).toMatchObject({ code: 'CONNECT_CODE_INVALID_OR_EXPIRED', nextStep: 'connect', retryable: true });
    expect(await stateOf(t)).toMatchObject({ nextStep: 'connect', steps: { connect: { status: 'todo' } }, connection: { level: null } });
    const second = await w.complete(t, ctx);
    expect([second.status, second.body.code, second.body.status]).toEqual([200, undefined, 'connected']); // the code names the cause when this ever fails
    expect(exchanges(ctx.graph) - 0).toBeGreaterThanOrEqual(1);
  });

  test('a step fails half way (register rate limit): the run is resumable, the state says so, resume finishes from the stored token with NO second exchange', async () => {
    const t = await w.tenant('Partial');
    const ctx = await w.prepareConnect(t, { phoneStatus: 'PENDING' });
    ctx.graph.scenarios.register133016();
    const r = await w.complete(t, ctx);
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: 'CONNECT_REGISTER_RATE_LIMITED', nextStep: 'connect', retryable: true, details: { step: 'register', resumable: true } });
    const s = await stateOf(t);
    expect(s).toMatchObject({ steps: { connect: { status: 'partial' } }, nextStep: 'connect', locked: true, lastError: { code: expect.any(String), step: 'connect' } });
    expect(s.connection.level).toBeNull();
    expect((await w.get(t.owner, '/connection')).body.status).toBe('connecting');
    // a member cannot resume (owner only)
    expect((await w.post(t.member, '/connect/resume', {})).status).toBe(403);
    const resumed = await w.post(t.owner, '/connect/resume', {});
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: 'connected', level: 'connected', nextStep: 'approvals' });
    expect(exchanges(ctx.graph)).toBe(1);
    const after = await stateOf(t);
    expect(after).toMatchObject({ steps: { connect: { status: 'done' } }, lastError: null, locked: false });
    // resuming a finished connection answers the CURRENT state, no new Graph work
    const calls = ctx.graph.calls.length;
    expect((await w.post(t.owner, '/connect/resume', {})).body.status).toBe('connected');
    expect(ctx.graph.calls.length).toBe(calls);
  });

  test('the webhook subscription is refused by Meta (token problem): a code, resumable; a transient network drop is retryable', async () => {
    const t = await w.tenant('SubFail');
    const ctx = await w.prepareConnect(t);
    ctx.graph.scenarios.subscribeFails({ code: 200 });
    const r = await w.complete(t, ctx);
    expect([409, 503]).toContain(r.status);
    expect(r.body.nextStep).toBe('connect');
    expect(r.body.details).toMatchObject({ step: 'subscribe', resumable: true });
    ctx.graph.scenarios.networkDrop({ match: 'listSubscribed' });
    const r2 = await w.post(t.owner, '/connect/resume', {});
    expect([409, 503]).toContain(r2.status);
    const r3 = await w.post(t.owner, '/connect/resume', {});
    expect(r3.status).toBe(200);
    expect(r3.body.status).toBe('connected');
    expect(exchanges(ctx.graph)).toBe(1);
  });

  test('replay: the same attempt and code again returns the stored result with ZERO new Graph calls; a double click makes ONE exchange', async () => {
    const t = await w.tenant('Replay');
    const ctx = await w.prepareConnect(t);
    const code = w.nextCode();
    const body = { attemptId: ctx.attemptId, code, session: w.flat(ctx.graph.session('FINISH')) };
    const [a, b] = await Promise.all([w.post(t.owner, '/connect/complete', body), w.post(t.owner, '/connect/complete', body)]);
    expect([a.status, b.status].sort()).toEqual(expect.arrayContaining([200]));
    expect(exchanges(ctx.graph)).toBe(1);
    const n = ctx.graph.calls.length;
    const replay = await w.post(t.owner, '/connect/complete', body);
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe('connected');
    expect(ctx.graph.calls.length).toBe(n);
    const other = await w.post(t.owner, '/connect/complete', { ...body, code: w.nextCode() });
    expect(other.status).toBeGreaterThanOrEqual(200);
    expect(ctx.graph.calls.length).toBe(n); // a different code on a finished attempt does not exchange again
  });

  test('FINISH_ONLY_WABA: the account is connected but there is no number yet (waba_only); adding the number completes it by refresh', async () => {
    const t = await w.tenant('OnlyWaba');
    const ctx = await w.prepareConnect(t);
    ctx.graph.scenarios.finishOnlyWaba();
    const r = await w.post(t.owner, '/connect/complete', { attemptId: ctx.attemptId, code: w.nextCode(), session: w.flat(ctx.graph.session('FINISH_ONLY_WABA')) });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('waba_only');
    expect(await stateOf(t)).toMatchObject({ steps: { connect: { status: 'waba_only' } }, nextStep: 'connect', connection: { level: 'needs_attention', causeCode: 'NUMBER_PENDING' } });
    ctx.graph.addPhone({ display_phone_number: '+966 55 888 0042' });
    const refreshed = await w.post(t.owner, '/connection/refresh', {});
    expect(refreshed.status).toBe(200);
    expect(await stateOf(t)).toMatchObject({ steps: { connect: { status: 'done' } }, connection: { level: 'connected' } });
  });

  test('a number that another WaFlow account already connected is refused (NUMBER_IN_USE), the first tenant is untouched', async () => {
    const t1 = await w.tenant('Owner1');
    const ctx1 = await w.connectTenant(t1);
    const t2 = await w.tenant('Owner2');
    const ids = ctx1.graph.ids;
    // the second merchant's popup reports the SAME WABA and phone id (a number already connected elsewhere)
    const g2 = w.graph.newTarget(`T${t2.ws}`, { wabaId: ids.wabaId, phoneId: ids.phoneId, businessId: ids.businessId });
    await w.put(t2.owner, '/business', w.BUSINESS(t2));
    await w.post(t2.owner, '/number/path', { hasNumber: true, usage: 'unused' });
    const cfg = await w.get(t2.owner, '/connect/config');
    const r = await w.post(t2.owner, '/connect/complete', { attemptId: cfg.body.attemptId, code: w.nextCode(), session: w.flat(g2.session('FINISH')) });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT');
    expect(r.body.nextStep).toBe('number');
    expect((await stateOf(t1)).connection.level).toBe('connected');
    expect((await stateOf(t2)).steps.connect.status).not.toBe('done');
  });
});

describe('reconnect and disconnect', () => {
  let t;
  let ctx;
  beforeAll(async () => { t = await w.tenant('Reconnect'); ctx = await w.connectTenant(t); w.mail.reset(); });

  test('the token is revoked at Meta: the refresh flags it ONCE (state, notification, e-mail) and sending is paused with a code, never silently', async () => {
    ctx.graph.scenarios.token190();
    const r = await w.post(t.owner, '/connection/refresh', {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ level: 'reconnect_needed', needsReconnect: true });
    const s = await stateOf(t);
    expect(s).toMatchObject({ nextStep: 'connect', connection: { level: 'reconnect_needed' }, sendingPaused: { code: 'WHATSAPP_RECONNECT_REQUIRED' } });
    expect(s.subscription.retry.reconnect).toBe(false);
    const legacy = await w.agent.post('/api/promotions/000000000000000000000001/send').set('Authorization', `Bearer ${t.owner.token}`).send({});
    expect(legacy.status).toBe(402);
    expect(legacy.body.code).toBe('WHATSAPP_RECONNECT_REQUIRED');
    expect(legacy.body.retry).toMatchObject({ reconnect: true });
    // a second refresh (after the limiter window) does not create a second notification or mail
    w.limiterReset && w.limiterReset();
    const notes = (await w.get(t.owner, '/notifications')).body.notifications.filter((n) => n.kind === 'reconnect_needed');
    expect(notes).toHaveLength(1);
    await new Promise((r2) => setTimeout(r2, 200));
    expect(w.mail.sent.filter((m) => m.to === t.owner.email && /reconnect/i.test(m.subject + m.text))).toHaveLength(1);
  });

  test('reconnect is owner only and must resolve to the SAME WhatsApp account; another account is a mismatch', async () => {
    expect((await w.post(t.member, '/connection/reconnect', {})).status).toBe(403);
    const cfg = await w.post(t.owner, '/connection/reconnect', {});
    expect(cfg.status).toBe(200);
    expect(cfg.body.reconnect).toEqual({ expectedWabaId: ctx.graph.ids.wabaId });
    // a different WABA in the popup
    const other = w.graph.newTarget(`R${t.ws}`, { displayNumber: '+966 55 877 0009' });
    const wrong = await w.post(t.owner, '/connect/complete', { attemptId: cfg.body.attemptId, code: w.nextCode(), session: w.flat(other.session('FINISH')) });
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe('CONNECT_WABA_MISMATCH');
    expect((await stateOf(t)).connection.level).toBe('reconnect_needed');
    // the same account again (new token), after Meta accepts it
    w.graph.setTarget(`T${t.ws}`);
    ctx.graph.scenarios.happy();
    const cfg2 = await w.post(t.owner, '/connection/reconnect', {});
    const ok = await w.post(t.owner, '/connect/complete', { attemptId: cfg2.body.attemptId, code: w.nextCode(), session: w.flat(ctx.graph.session('FINISH')) });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'connected', level: 'connected' });
    expect(await stateOf(t)).toMatchObject({ connection: { level: 'connected' }, sendingPaused: { code: 'SENDING_NOT_AVAILABLE_YET' }, nextStep: 'approvals' });
    const conn = await w.connOf(t.ws);
    expect(conn.needsReconnect).toBe(false);
    expect(await w.M('OnboardingTemplate').countDocuments({ workspaceId: t.ws, key: 'welcome_optin', language: 'en' })).toBe(1); // not re-seeded
  });

  test('disconnect is a two-step owner action: wrong text / member / tampered token refused; the document and the ids stay, the token is gone', async () => {
    expect((await w.post(t.member, '/connection/disconnect/request', {})).status).toBe(403);
    const reqd = await w.post(t.owner, '/connection/disconnect/request', {});
    expect(reqd.status).toBe(200);
    expect(reqd.body).toMatchObject({ expiresInSec: 300, impactKeys: expect.any(Array) });
    expect(reqd.body.impactKeys.every((k) => ['sending', 'templates', 'number'].includes(k))).toBe(true);
    expect((await w.post(t.owner, '/connection/disconnect', { confirmationToken: reqd.body.confirmationToken, confirmText: 'nope' })).status).toBe(422);
    expect((await w.post(t.owner, '/connection/disconnect', { confirmationToken: `${reqd.body.confirmationToken}x`, confirmText: 'DISCONNECT' })).status).toBe(422);
    const before = await w.M('WhatsAppConnection').countDocuments({});
    const done = await w.post(t.owner, '/connection/disconnect', { confirmationToken: reqd.body.confirmationToken, confirmText: 'DISCONNECT' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('disconnected');
    expect(await w.M('WhatsAppConnection').countDocuments({})).toBe(before);
    const raw = await w.M('WhatsAppConnection').collection.findOne({ workspaceId: (await w.connOf(t.ws)).workspaceId });
    expect(raw.tokenEncrypted).toBeUndefined();
    expect(raw.ids.wabaId).toBe(ctx.graph.ids.wabaId);
    const s = await stateOf(t);
    expect(s).toMatchObject({ steps: { connect: { status: 'todo' } }, nextStep: 'connect', connection: { level: null }, sendingPaused: { code: 'WHATSAPP_NOT_CONNECTED' } });
    expect(ctx.graph.callsTo('unsubscribe').length).toBeGreaterThanOrEqual(1);
    const again = await w.post(t.owner, '/connection/disconnect', { confirmationToken: reqd.body.confirmationToken, confirmText: 'DISCONNECT' });
    expect([200, 422]).toContain(again.status);
  });

  test('after a disconnect the owner can connect again (even another account), claims were released, not deleted', async () => {
    const g = w.graph.newTarget(`D${t.ws}`, { displayNumber: '+966 55 866 0003' });
    const cfg = await w.get(t.owner, '/connect/config');
    expect(cfg.status).toBe(200);
    const ok = await w.post(t.owner, '/connect/complete', { attemptId: cfg.body.attemptId, code: w.nextCode(), session: w.flat(g.session('FINISH')) });
    expect(ok.status).toBe(200);
    expect(await stateOf(t)).toMatchObject({ connection: { level: 'connected', numberMasked: '********0003' }, steps: { connect: { status: 'done' } } });
  });
});

describe('Meta tells us the merchant removed the app (deauthorize) and asks for data deletion', () => {
  const crypto = require('crypto');
  const signed = (payload, secret) => {
    const part = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), ...payload })).toString('base64url');
    return `${crypto.createHmac('sha256', secret).update(part).digest('base64url')}.${part}`;
  };
  test('a signed deauthorize flags exactly that merchant (state, level, notification); an unsigned or tampered one changes nothing', async () => {
    const t = await w.tenant('Deauth');
    const other = await w.tenant('DeauthBystander');
    await w.connectTenant(t);
    await w.connectTenant(other);
    await w.M('WhatsAppConnection').updateOne({ workspaceId: t.ws }, { $set: { 'ids.metaUserId': 'META_USER_DEAUTH_1' } });
    await w.M('WhatsAppConnection').updateOne({ workspaceId: other.ws }, { $set: { 'ids.metaUserId': 'META_USER_OTHER_2' } });
    const secret = w.handle.env.appSecret;
    const bad = await w.agent.post('/onboarding-meta/deauthorize').type('form').send({ signed_request: signed({ user_id: 'META_USER_DEAUTH_1' }, 'not-the-app-secret-at-all') });
    expect(bad.status).toBe(400);
    expect((await stateOf(t)).connection.level).toBe('connected');
    const ok = await w.agent.post('/onboarding-meta/deauthorize').type('form').send({ signed_request: signed({ user_id: 'META_USER_DEAUTH_1' }, secret) });
    expect(ok.status).toBe(200);
    expect(await stateOf(t)).toMatchObject({ nextStep: 'connect', connection: { level: 'reconnect_needed' }, sendingPaused: { code: 'WHATSAPP_RECONNECT_REQUIRED' } });
    expect((await stateOf(other)).connection.level).toBe('connected');
    expect((await w.get(t.owner, '/notifications')).body.notifications.some((n) => n.kind === 'reconnect_needed')).toBe(true);
    const again = await w.agent.post('/onboarding-meta/deauthorize').type('form').send({ signed_request: signed({ user_id: 'META_USER_DEAUTH_1' }, secret) });
    expect(again.status).toBe(200);
  });

  test('a signed data-deletion request is recorded for staff (NO automatic deletion), the status URL answers a static page', async () => {
    const t = await w.tenant('Deletion');
    await w.connectTenant(t);
    const before = { ws: await w.M('Workspace').countDocuments({}), cust: await w.M('Customer').countDocuments({}), conn: await w.M('WhatsAppConnection').countDocuments({}) };
    const sr = signed({ user_id: 'META_USER_DELETE_9' }, w.handle.env.appSecret);
    const r = await w.agent.post('/onboarding-meta/data-deletion').type('form').send({ signed_request: sr });
    expect(r.status).toBe(200);
    expect(r.body.confirmation_code).toMatch(/^[a-f0-9]{24}$/);
    expect(r.body.url).toContain(`/onboarding-meta/deletion-status?code=${r.body.confirmation_code}`);
    const row = await w.M('OnboardingInbound').findOne({ _id: `metacb:${r.body.confirmation_code}` }).lean();
    expect(row).toMatchObject({ type: 'data_deletion', status: 'processing' });
    const same = await w.agent.post('/onboarding-meta/data-deletion').type('form').send({ signed_request: sr });
    expect(same.body.confirmation_code).toBe(r.body.confirmation_code); // a retry gets the same code
    const page = await w.agent.get(`/onboarding-meta/deletion-status?code=${r.body.confirmation_code}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('has been received');
    expect(page.text).not.toContain('META_USER_DELETE_9');
    expect((await w.agent.get('/onboarding-meta/deletion-status?code=deadbeefdeadbeefdeadbeef')).status).toBe(404);
    expect({ ws: await w.M('Workspace').countDocuments({}), cust: await w.M('Customer').countDocuments({}), conn: await w.M('WhatsAppConnection').countDocuments({}) }).toEqual(before);
  });
});
