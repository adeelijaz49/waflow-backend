'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_b1d_sr`; // this suite gets its OWN database
assertThrowawayDb();

// Real throwaway mongod, REAL models and indexes (WhatsAppConnection, OnboardingNotification, OnboardingEvent,
// OnboardingTemplate, OnboardingState, SchedulerLock), fakeGraph for Meta, a fake e-mail port. statusRefresh and
// approvals run against the real schema: this proves the update documents are valid for MongoDB (no conflicting
// paths), the schema keeps every field, and the idempotency keys hold with the real unique indexes.
const mongoose = require('mongoose');
const { createFakeGraph, fixedClock } = require('../_fixtures');
const { rawGraphClient } = require('../unit/_b1dHelpers');
const sr = require('../../../shared/onboarding/statusRefresh');
const approvals = require('../../../shared/onboarding/approvals');
const vault = require('../../../shared/onboarding/tokenVault');
const { createNotifications } = require('../../../shared/onboarding/notifications');
const Conn = require('../../../models/WhatsAppConnection');
const Notification = require('../../../models/OnboardingNotification');
const Event = require('../../../models/OnboardingEvent');
const Template = require('../../../models/OnboardingTemplate');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const oid = () => String(new mongoose.Types.ObjectId());

beforeAll(async () => {
  process.env.WA_TOKEN_ENCRYPTION_KEY = 'cd'.repeat(32);
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([Conn.init(), Notification.init(), Event.init(), Template.init()]);
});
afterAll(async () => { await mongoose.disconnect(); });

function makeEnv(graph = {}) {
  const clock = fixedClock('2026-10-15T09:00:00Z');
  const g = createFakeGraph({ clock, ...graph });
  const emailSend = jest.fn(async () => ({ sent: true, id: 'm1' }));
  const notifications = createNotifications({ email: { sendNotificationEmail: emailSend }, now: () => new Date(clock.ms()) });
  const deps = { meta: rawGraphClient(g), notifications, appId: g.ids.appId, now: () => clock.ms(), log: jest.fn(), paymentProbe: () => false };
  const ws = oid();
  async function seed(over = {}) {
    return Conn.create({
      workspaceId: ws, status: 'connected',
      ids: { wabaId: g.ids.wabaId, phoneNumberId: g.ids.phoneId, businessId: g.ids.businessId },
      display: { displayPhoneNumber: '+966 55 123 4567', last4: '4567', verifiedName: 'Acme Coffee' },
      tokenEncrypted: vault.encrypt(g.ids.merchantToken, { workspaceId: ws, purpose: 'token' }),
      pinEncrypted: vault.encrypt('482913', { workspaceId: ws, purpose: 'pin' }),
      webhook: { subscribed: true }, verification: { businessRaw: 'verified', mapped: 'done' }, displayName: { nameStatusRaw: 'APPROVED', mapped: 'done' },
      payment: { status: 'unknown' }, messagingLimit: { raw: 'TIER_250', tierNumber: 250 }, health: { canSend: 'AVAILABLE', issues: [] },
      nextCheckAt: new Date(clock.ms() - 1000), connectedAt: new Date('2026-10-01T00:00:00Z'), ...over,
    });
  }
  const row = () => Conn.findOne({ workspaceId: ws }).lean();
  const notes = () => Notification.find({ workspaceId: ws }).sort({ createdAt: 1 }).lean();
  const events = () => Event.find({ workspaceId: ws }).sort({ at: 1 }).lean();
  return { clock, g, ws, deps, emailSend, seed, row, notes, events };
}
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };

describe('refreshConnection against the real schema', () => {
  test('a healthy refresh is stored completely (nothing dropped by strict mode) and schedules the next check', async () => {
    const env = makeEnv({ tier: 'TIER_2K', verificationStatus: 'pending', qualityRating: 'YELLOW' });
    await env.seed({ verification: undefined, messagingLimit: undefined, quality: undefined });
    const snap = await sr.refreshConnection(env.ws, env.deps);
    const r = await env.row();
    expect(r.verification).toMatchObject({ businessRaw: 'pending', mapped: 'waiting' });
    expect(r.verification.checkedAt).toBeInstanceOf(Date);
    expect(r.messagingLimit).toMatchObject({ raw: 'TIER_2K', tierNumber: 2000 });
    expect(r.quality.ratingRaw).toBe('YELLOW');
    expect(r.health.canSend).toBe('AVAILABLE');
    expect(r.displayName).toMatchObject({ nameStatusRaw: 'APPROVED', mapped: 'done' });
    expect(r.tokenIsValid).toBe(true);
    expect(r.ids.metaUserId).toBeTruthy();
    expect(r.webhook.subscribed).toBe(true);
    expect(r.checkFailures).toBe(0);
    expect(r.lastStatusCheckAt).toBeInstanceOf(Date);
    expect(new Date(r.nextCheckAt).getTime() - env.clock.ms()).toBe(15 * MIN); // verification is waiting
    expect(snap.level).toBe('connected');
    expect(r.tokenEncrypted).toBeUndefined(); // select:false: the secret never comes back by default
  });

  test('a token that is valid but expires soon: the date is stored, level needs_attention', async () => {
    const env = makeEnv();
    env.g.setTokenExpiry(env.clock.sec() + 2 * 86400);
    await env.seed();
    await sr.refreshConnection(env.ws, env.deps);
    const r = await env.row();
    expect(new Date(r.tokenExpiresAt).getTime()).toBe((env.clock.sec() + 2 * 86400) * 1000);
    expect(r.status).toBe('needs_attention');
  });

  test('190: needsReconnect + exactly one notification and one e-mail even when two refreshes race (real unique index + conditional update)', async () => {
    const env = makeEnv();
    env.g.scenarios.token190();
    await env.seed();
    await Promise.all([sr.refreshConnection(env.ws, env.deps), sr.refreshConnection(env.ws, env.deps)]);
    await settle();
    const r = await env.row();
    expect(r).toMatchObject({ needsReconnect: true, reconnectReason: 'TOKEN_EXPIRED', status: 'reconnect_required' });
    const notes = await env.notes();
    expect(notes.filter((n) => n.kind === 'reconnect_needed')).toHaveLength(1);
    expect(env.emailSend).toHaveBeenCalledTimes(1);
    const ev = await env.events();
    expect(ev.filter((e) => e.type === 'status_change' && /^RECONNECT_/.test(e.code))).toHaveLength(1);
    await sr.refreshConnection(env.ws, env.deps);
    expect(await Notification.countDocuments({ workspaceId: env.ws, kind: 'reconnect_needed' })).toBe(1);
  });

  test('verification waiting -> done: one status_change event and one notification (real unique key), nothing on the next refresh', async () => {
    const env = makeEnv({ verificationStatus: 'verified' });
    await env.seed({ verification: { businessRaw: 'pending', mapped: 'waiting' } });
    await sr.refreshConnection(env.ws, env.deps);
    await sr.refreshConnection(env.ws, env.deps);
    const notes = await env.notes();
    // the key carries the epoch of the document version (review R7-04): the same version dedupes, a later recurrence is announced again
    expect(notes.map((n) => [n.kind, n.dedupeKey.replace(/:\d+$/, ':<epoch>'), n.titleKey])).toEqual([['verification_changed', 'verification:done:<epoch>', 'onboarding.notify.verification_changed.title']]);
    expect(notes[0].dedupeKey).toMatch(/^verification:done:\d+$/);
    expect((await env.events()).filter((e) => e.code === 'VERIFICATION_DONE')).toHaveLength(1);
  });

  test('health blocked -> needs_attention with the issue stored in the real subdocument array; recovery restores connected', async () => {
    const env = makeEnv();
    env.g.setHealth('BLOCKED');
    await env.seed();
    await sr.refreshConnection(env.ws, env.deps);
    let r = await env.row();
    expect(r.status).toBe('needs_attention');
    expect(r.health.issues).toEqual([{ entityType: 'WABA', code: '141002' }]);
    env.g.setHealth('AVAILABLE');
    await sr.refreshConnection(env.ws, env.deps);
    r = await env.row();
    expect(r.status).toBe('connected');
    expect(r.health.issues).toEqual([]);
  });

  test('subscription lost is healed by one re-subscribe; a display-name approval keeps the re-register marker; both updates are valid for MongoDB', async () => {
    const env = makeEnv();
    env.g.setSubscribed(false);
    await env.seed({ displayName: { mapped: 'waiting', newName: 'Acme Cafe', newNameStatusRaw: 'PENDING_REVIEW', nameStatusRaw: 'APPROVED' } });
    env.g.setPhone({ verified_name: 'Acme Cafe' });
    await sr.refreshConnection(env.ws, env.deps);
    const r = await env.row();
    expect(env.g.callsTo('subscribe')).toHaveLength(1);
    expect(r.webhook.subscribed).toBe(true);
    expect(r.displayName).toMatchObject({ mapped: 'done', decision: 'APPROVED', newName: 'Acme Cafe' });
    expect(r.displayName.newNameStatusRaw).toBeUndefined();
  });

  test('network down: back-off is stored (15 min), lastError is a catalogue code, no Graph hammering', async () => {
    const env = makeEnv();
    env.g.scenarios.networkDrop({ code: 'ECONNRESET', times: Infinity });
    await env.seed();
    await expect(sr.refreshConnection(env.ws, env.deps)).rejects.toMatchObject({ code: 'ECONNRESET' }); // stored first, then the original error is re-thrown
    const r = await env.row();
    expect(r.checkFailures).toBe(1);
    expect(r.lastError).toMatchObject({ code: 'META_UNREACHABLE', kind: 'network' });
    expect(new Date(r.nextCheckAt).getTime() - env.clock.ms()).toBe(15 * MIN);
    expect(env.g.calls).toHaveLength(1);
    env.g.reset();
    await sr.refreshConnection(env.ws, env.deps);
    const ok = await env.row();
    expect(ok.checkFailures).toBe(0);
    expect(ok.lastError).toBeUndefined();
  });

  test('waiting templates (real OnboardingTemplate rows) keep the poll at 15 minutes', async () => {
    const env = makeEnv();
    await env.seed();
    await Template.create({ workspaceId: env.ws, key: 'welcome_optin', language: 'en', metaStatus: 'PENDING' });
    await sr.refreshConnection(env.ws, env.deps);
    expect(new Date((await env.row()).nextCheckAt).getTime() - env.clock.ms()).toBe(15 * MIN);
    await Template.updateOne({ workspaceId: env.ws, key: 'welcome_optin' }, { $set: { metaStatus: 'APPROVED' } });
    await sr.refreshConnection(env.ws, env.deps);
    expect(new Date((await env.row()).nextCheckAt).getTime() - env.clock.ms()).toBe(6 * HOUR);
  });

  test('another workspace is never touched', async () => {
    const env = makeEnv();
    const other = makeEnv();
    await env.seed();
    await other.seed();
    other.g.scenarios.token190();
    await sr.refreshConnection(other.ws, other.deps);
    await sr.refreshConnection(env.ws, env.deps);
    expect((await env.row()).needsReconnect).toBe(false);
    expect((await other.row()).needsReconnect).toBe(true);
  });
});

describe('approvals against the real schema', () => {
  test('buildApprovals reads the real documents (5 rows, workspace scoped)', async () => {
    const env = makeEnv();
    await env.seed({ verification: { businessRaw: 'pending', mapped: 'waiting' }, lastStatusCheckAt: new Date(env.clock.ms() - MIN) });
    for (const [key, st] of [['welcome_optin', 'APPROVED'], ['comeback', 'PENDING'], ['points_balance', 'REJECTED']]) {
      await Template.create({ workspaceId: env.ws, key, language: 'en', metaStatus: st, metaStatusRaw: st, rejectedReason: st === 'REJECTED' ? 'INVALID_FORMAT' : undefined });
    }
    await Template.create({ workspaceId: oid(), key: 'welcome_optin', language: 'en', metaStatus: 'APPROVED' }); // someone else's
    const res = await approvals.buildApprovals(env.ws, env.deps);
    expect(res.rows.map((r) => [r.key, r.status])).toEqual([['verification', 'waiting'], ['displayName', 'done'], ['payment', 'needs_you'], ['messagingLimit', 'done'], ['templates', 'needs_you']]);
    expect(res.rows[4].counts).toEqual({ approved: 1, total: 3, waiting: 1, problem: 1 });
    expect(res.checkedAt).toBe(new Date(env.clock.ms() - MIN).toISOString());
    expect(JSON.stringify(res)).not.toMatch(/v1:|966 55/);
  });

  test('confirmPayment is atomic and idempotent under a race', async () => {
    const env = makeEnv();
    await env.seed();
    const [a, b] = await Promise.all([approvals.confirmPayment(env.ws, env.deps), approvals.confirmPayment(env.ws, env.deps)]);
    expect([a.payment.status, b.payment.status]).toEqual(['merchant_confirmed', 'merchant_confirmed']);
    expect((await env.events()).filter((e) => e.code === 'PAYMENT_CONFIRMED')).toHaveLength(1);
    expect((await env.row()).payment.status).toBe('merchant_confirmed');
  });

  test('changeDisplayName stores the pending request and the edit dates; the 11th change in 30 days is refused', async () => {
    const env = makeEnv();
    await env.seed();
    const res = await approvals.changeDisplayName({ workspaceId: env.ws, userId: 'u', newName: 'Acme Cafe' }, env.deps);
    expect(res.displayName).toEqual({ value: 'Acme Cafe', status: 'waiting', editsRemaining: 9 });
    let r = await env.row();
    expect(r.displayName).toMatchObject({ requested: 'Acme Cafe', newName: 'Acme Cafe', newNameStatusRaw: 'PENDING_REVIEW', mapped: 'waiting' });
    expect(r.displayName.editsLast30d).toHaveLength(1);
    expect(r.displayName.editsLast30d[0]).toBeInstanceOf(Date);
    const full = Array.from({ length: 10 }, (_, i) => new Date(env.clock.ms() - (i + 1) * 86400000));
    await Conn.updateOne({ workspaceId: env.ws }, { $set: { 'displayName.editsLast30d': full } });
    await expect(approvals.changeDisplayName({ workspaceId: env.ws, newName: 'Another Name' }, env.deps)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'DISPLAY_NAME_LIMIT' } });
    r = await env.row();
    expect(r.displayName.editsLast30d).toHaveLength(10);
  });

  test('reRegisterDueNames registers with the decrypted stored PIN and clears the marker', async () => {
    const env = makeEnv();
    await env.seed({ displayName: { mapped: 'done', decision: 'APPROVED', newName: 'Acme Cafe', nameStatusRaw: 'APPROVED', checkedAt: new Date(env.clock.ms() - 86400000) } });
    const res = await approvals.reRegisterDueNames({}, env.deps);
    expect(res.registered).toBeGreaterThanOrEqual(1); // the scan is global: rows left by earlier tests of this suite are due as well
    expect(res.failed).toBe(0);
    expect(env.g.callsTo('register').every((c) => c.data.pin === '482913')).toBe(true);
    const r = await env.row();
    expect(r.displayName.newName).toBeUndefined();
    expect(r.registration.registeredAt).toBeInstanceOf(Date);
    env.g.assertNoLeak([env.g.ids.merchantToken], [JSON.stringify(res)]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Contract check against B1-c's REAL Graph client (shared/onboarding/metaClient.js) over fakeGraph: the client
// returns raw snake_case fields plus camelCase aliases and a normalised debugToken; statusRefresh must read all
// of it. Skipped automatically while metaClient is still a stub.
const metaClientMod = require('../../../shared/onboarding/metaClient');
let realClientAvailable = true;
try { metaClientMod.createMetaGraphClient({}); } catch (_) { realClientAvailable = false; }
const describeReal = realClientAvailable ? describe : describe.skip;

describeReal('statusRefresh with the real metaClient (B1-c) over fakeGraph', () => {
  function realEnv(graph = {}) {
    const env = makeEnv(graph);
    env.deps.meta = metaClientMod.createMetaGraphClient({ http: env.g.http, appId: env.g.ids.appId, appSecret: env.g.ids.appSecret });
    return env;
  }

  test('a healthy refresh through the real client stores verification, health, tier, name status and quality', async () => {
    const env = realEnv({ tier: 'TIER_2K', verificationStatus: 'pending', qualityRating: 'YELLOW' });
    await env.seed({ verification: undefined, messagingLimit: undefined, quality: undefined, displayName: undefined });
    const snap = await sr.refreshConnection(env.ws, env.deps);
    const r = await env.row();
    expect(r.verification).toMatchObject({ businessRaw: 'pending', mapped: 'waiting' });
    expect(r.messagingLimit).toMatchObject({ raw: 'TIER_2K', tierNumber: 2000 });
    expect(r.quality.ratingRaw).toBe('YELLOW');
    expect(r.displayName).toMatchObject({ nameStatusRaw: 'APPROVED', mapped: 'done' });
    expect(r.health.canSend).toBe('AVAILABLE');
    expect(r.tokenIsValid).toBe(true);
    expect(r.tokenExpiresAt).toBeNull(); // expires_at 0 = never
    expect(r.ids.metaUserId).toBeTruthy();
    expect(snap.level).toBe('connected');
    env.g.assertMerchantTokenOnly(env.g.ids.merchantToken);
    env.g.assertNeverUsedToken(env.g.ids.platformToken);
  });

  test('token expiry arrives as a Date in the client and as seconds in the alias: both read correctly', async () => {
    const env = realEnv();
    env.g.setTokenExpiry(env.clock.sec() + 3 * 86400);
    await env.seed();
    const snap = await sr.refreshConnection(env.ws, env.deps);
    expect(new Date((await env.row()).tokenExpiresAt).getTime()).toBe((env.clock.sec() + 3 * 86400) * 1000);
    expect(snap.cause).toEqual({ code: 'TOKEN_EXPIRING', path: '/setup/connect' });
  });

  test('190: needsReconnect once, ONE notification and e-mail, the real connect.reportGraphError adds nothing', async () => {
    const env = realEnv();
    env.g.scenarios.token190();
    await env.seed();
    const real = { ...env.deps };
    delete real.connect; // use B1-c's real reportGraphError
    await sr.refreshConnection(env.ws, real);
    await settle();
    const r = await env.row();
    expect(r).toMatchObject({ needsReconnect: true, reconnectReason: 'TOKEN_EXPIRED', status: 'reconnect_required' });
    expect(await Notification.countDocuments({ workspaceId: env.ws, kind: 'reconnect_needed' })).toBe(1);
    expect(env.emailSend).toHaveBeenCalledTimes(1);
  });

  test('a field the client negotiates away itself is reported as fieldsDegraded (the client retried, not statusRefresh)', async () => {
    const env = realEnv();
    env.g.scenarios.fieldRejected('name_status');
    await env.seed();
    const snap = await sr.refreshConnection(env.ws, env.deps);
    expect(snap.fieldsDegraded).toBe(true);
    expect(env.g.callsTo('getPhone')).toHaveLength(2);
    expect(snap.checks.failed).toBe(0);
  });

  test('subscription lost is healed through the real listSubscribedApps shape', async () => {
    const env = realEnv();
    env.g.setSubscribed(false);
    await env.seed();
    await sr.refreshConnection(env.ws, env.deps);
    expect(env.g.callsTo('subscribe')).toHaveLength(1);
    expect((await env.row()).webhook.subscribed).toBe(true);
  });

  test('a rate limit on everything is stored AND re-thrown as the client\'s MetaGraphError (the route maps it); the scheduler flag silences the throw', async () => {
    const env = realEnv();
    env.g.scenarios.rateLimited(4, { times: Infinity });
    await env.seed();
    await expect(sr.refreshConnection(env.ws, { ...env.deps, throwOnFailure: undefined })).rejects.toMatchObject({ name: 'MetaGraphError', kind: 'retry' });
    expect((await env.row()).lastError).toMatchObject({ code: 'META_RATE_LIMITED', kind: 'retry' });
    const snap = await sr.refreshConnection(env.ws, { ...env.deps, throwOnFailure: false });
    expect(snap.checkFailures).toBe(2);
  });

  test('waba_only: once the merchant adds a number in Meta, the refresh hands over to the real connect.resumeConnect and the connection completes', async () => {
    const OnbState = require('../../../models/OnboardingState');
    const connectMod = require('../../../shared/onboarding/connect');
    await OnbState.init();
    const env = realEnv();
    env.g.scenarios.finishOnlyWaba();
    await OnbState.create({ workspaceId: env.ws, enrolled: true, subscription: { state: 'active', source: 'admin' } });
    await env.seed({ status: 'waba_only', ids: { wabaId: env.g.ids.wabaId, businessId: env.g.ids.businessId, onboardingEvent: 'FINISH_ONLY_WABA' }, display: undefined, verification: undefined, displayName: undefined, messagingLimit: undefined });
    const prev = { id: process.env.WA_APP_ID, secret: process.env.WA_APP_SECRET };
    process.env.WA_APP_ID = env.g.ids.appId;
    process.env.WA_APP_SECRET = env.g.ids.appSecret;
    env.deps.connect = { reportGraphError: connectMod.reportGraphError, resumeConnect: (args) => connectMod.resumeConnect(args, { meta: env.deps.meta, appId: env.g.ids.appId, now: () => new Date(env.clock.ms()) }) };
    try {
      let snap = await sr.refreshConnection(env.ws, env.deps);
      expect(snap.status).toBe('waba_only'); // no number yet
      env.g.addPhone();
      env.g.setPhone({ status: 'CONNECTED' });
      snap = await sr.refreshConnection(env.ws, env.deps);
      const r = await env.row();
      expect(r.status).toBe('connected');
      expect(r.ids.phoneNumberId).toBe(env.g.ids.phoneId);
      expect(snap.status).toBe('connected');
      expect(snap.level).toBe('connected');
    } finally {
      if (prev.id === undefined) delete process.env.WA_APP_ID; else process.env.WA_APP_ID = prev.id;
      if (prev.secret === undefined) delete process.env.WA_APP_SECRET; else process.env.WA_APP_SECRET = prev.secret;
    }
  });

  test('changeDisplayName and reRegisterDueNames work through the real client', async () => {
    const env = realEnv();
    await env.seed();
    await approvals.changeDisplayName({ workspaceId: env.ws, newName: 'Acme Cafe' }, env.deps);
    expect(env.g.callsTo('setDisplayName')[0].data).toEqual({ new_display_name: 'Acme Cafe' });
    await Conn.updateOne({ workspaceId: env.ws }, { $set: { 'displayName.decision': 'APPROVED', 'displayName.mapped': 'done', 'displayName.checkedAt': new Date(env.clock.ms()) } });
    const res = await approvals.reRegisterDueNames({}, env.deps);
    expect(res.registered).toBeGreaterThanOrEqual(1);
    expect(env.g.callsTo('register').pop().data).toEqual({ messaging_product: 'whatsapp', pin: '482913' });
  });
});

describe('approvals.touchProgress with the real steps module and the real OnboardingState', () => {
  const OnbState = require('../../../models/OnboardingState');
  test('todo -> in_progress on the first view, -> done once every row is done, never regresses', async () => {
    await OnbState.init();
    const ws = oid();
    await OnbState.create({ workspaceId: ws, enrolled: true, subscription: { state: 'active', source: 'admin' } });
    const stepOf = async () => (await OnbState.findOne({ workspaceId: ws }).lean()).steps.approvals.status;
    expect(await stepOf()).toBe('todo');
    expect(await approvals.touchProgress(ws, 'waiting')).toBe('in_progress');
    expect(await stepOf()).toBe('in_progress');
    expect(await approvals.touchProgress(ws, 'waiting')).toBeNull();
    expect(await approvals.touchProgress(ws, 'done')).toBe('done');
    expect(await stepOf()).toBe('done');
    expect(await approvals.touchProgress(ws, 'needs_you')).toBeNull();
    expect(await stepOf()).toBe('done');
    expect(await approvals.touchProgress(oid(), 'done')).toBeNull(); // not enrolled: nothing happens
  });
});

describe('a refresh must not undo what happened while Graph was answering (review R7-07, real database)', () => {
  /** The refresh waits inside its FIRST Graph call (debug_token) until the test lets it go: the window in which a disconnect / reconnect can happen. */
  function slowFirstCall(env) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { env.onEnter = resolve; });
    const real = env.deps.meta;
    const meta = { ...real, debugToken: async (...args) => { env.onEnter(); await gate; return real.debugToken(...args); } };
    return { deps: { ...env.deps, meta }, release, entered };
  }

  test('the owner disconnects while the refresh is waiting: the stale result is dropped; the row stays disconnected, no token, no schedule', async () => {
    const env = makeEnv({ verificationStatus: 'pending' });
    await env.seed();
    const slow = slowFirstCall(env);
    const pending = sr.refreshConnection(env.ws, slow.deps);
    await slow.entered;
    await Conn.updateOne({ workspaceId: env.ws }, {
      $set: { status: 'disconnected', disconnectedAt: new Date(env.clock.ms()), tokenIsValid: false, nextCheckAt: null, 'webhook.subscribed': false },
      $unset: { tokenEncrypted: '' },
    });
    slow.release();
    const snap = await pending;
    expect(snap.skipped).toBe('changed_meanwhile');
    const r = await env.row();
    expect(r.status).toBe('disconnected');
    expect(r.tokenIsValid).toBe(false);
    expect(r.nextCheckAt).toBeNull();
    expect(r.webhook.subscribed).toBe(false);
    expect(r.lastStatusCheckAt).toBeUndefined(); // the stale refresh wrote nothing at all
    expect(await Notification.countDocuments({ workspaceId: env.ws })).toBe(0);
  });

  test('a revoked token (190) answered after a disconnect does not flip the row to reconnect_required', async () => {
    const env = makeEnv();
    env.g.scenarios.token190();
    await env.seed();
    const slow = slowFirstCall(env);
    const pending = sr.refreshConnection(env.ws, slow.deps);
    await slow.entered;
    await Conn.updateOne({ workspaceId: env.ws }, {
      $set: { status: 'disconnected', disconnectedAt: new Date(env.clock.ms()), tokenIsValid: false, nextCheckAt: null },
      $unset: { tokenEncrypted: '' },
    });
    slow.release();
    await pending;
    await settle();
    const r = await env.row();
    expect(r.status).toBe('disconnected');
    expect(r.needsReconnect).not.toBe(true);
    expect(r.reconnectReason).toBeUndefined();
    expect(await Notification.countDocuments({ workspaceId: env.ws, kind: 'reconnect_needed' })).toBe(0);
    expect(env.emailSend).not.toHaveBeenCalled();
  });

  test('another refresh (or a reconnect) finished first: the slower one is dropped and the newer values stay', async () => {
    const env = makeEnv({ tier: 'TIER_2K' });
    await env.seed();
    const slow = slowFirstCall(env);
    const pending = sr.refreshConnection(env.ws, slow.deps);
    await slow.entered;
    const newer = new Date(env.clock.ms() + 5000);
    await Conn.updateOne({ workspaceId: env.ws }, { $set: { tokenCheckedAt: newer, 'messagingLimit.raw': 'TIER_100K', 'messagingLimit.tierNumber': 100000 } });
    slow.release();
    const snap = await pending;
    expect(snap.skipped).toBe('changed_meanwhile');
    const r = await env.row();
    expect(new Date(r.tokenCheckedAt).getTime()).toBe(newer.getTime());
    expect(r.messagingLimit).toMatchObject({ raw: 'TIER_100K', tierNumber: 100000 });
  });

  test('two refreshes started from the same row: exactly one write lands, the other reports changed_meanwhile', async () => {
    const env = makeEnv({ tier: 'TIER_2K' });
    await env.seed();
    const snaps = await Promise.all([sr.refreshConnection(env.ws, env.deps), sr.refreshConnection(env.ws, env.deps)]);
    expect(snaps.filter((s) => s.skipped === 'changed_meanwhile')).toHaveLength(1);
    const r = await env.row();
    expect(r.messagingLimit).toMatchObject({ raw: 'TIER_2K', tierNumber: 2000 });
    expect(r.status).toBe('connected');
    // a later refresh (nothing in flight) works as always
    env.clock.advance(20 * MIN);
    expect((await sr.refreshConnection(env.ws, env.deps)).skipped).toBeUndefined();
  });
});
