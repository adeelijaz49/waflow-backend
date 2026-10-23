'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database (suffix) so suites in one jest run never see each other's data
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_notif`;
assertThrowawayDb();

// Notifications + events against a REAL (throwaway) mongod: unique-index idempotency, the HTTP routes,
// tenant isolation, and the e-mail leg with a fake Resend. No delete operations anywhere.
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const notifications = require('../../../shared/onboarding/notifications');
const analytics = require('../../../shared/onboarding/analytics');
const email = require('../../../shared/onboarding/email');
const OnboardingNotification = require('../../../models/OnboardingNotification');
const OnboardingEvent = require('../../../models/OnboardingEvent');
const OnboardingState = require('../../../models/OnboardingState');
const Membership = require('../../../models/Membership');
const User = require('../../../models/User');
const notificationsRouter = require('../../../routes/onboarding/notifications');
const eventsRouter = require('../../../routes/onboarding/events');
const { createFakeSend } = require('../_fixtures');

const oid = () => new mongoose.Types.ObjectId();
const WS_A = String(oid());
const WS_B = String(oid());
const OWNER_A = oid();

function appFor(workspaceId, routerDeps = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: String(OWNER_A), workspaceId, role: 'owner' }; next(); });
  app.use('/api/onboarding', notificationsRouter.createRouter(routerDeps));
  app.use('/api/onboarding', eventsRouter.createRouter());
  return app;
}

let warn;
beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([OnboardingNotification.init(), OnboardingEvent.init(), OnboardingState.init(), Membership.init(), User.init()]);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(async () => { warn.mockRestore(); await mongoose.disconnect(); });

describe('notify: idempotency on the real unique index', () => {
  test('the same key twice -> one document, one mail', async () => {
    const mail = createFakeSend();
    const emailDeps = { send: mail.send, resolveRecipient: async () => ({ to: 'owner@example.test', language: 'en' }) };
    const deps = { email, emailDeps };
    const args = { workspaceId: WS_A, kind: 'payment_failed', dedupeKey: 'sub:past_due:sub_1:inv_1', params: {}, email: true, severity: 'warning', actionPath: '/setup' };
    const first = await notifications.notify(args, deps);
    expect(first.created).toBe(true);
    expect(await first.emailPromise).toMatchObject({ sent: true });
    const second = await notifications.notify(args, deps);
    expect(second.created).toBe(false);
    expect(second.emailPromise).toBeNull();
    expect(await OnboardingNotification.countDocuments({ workspaceId: WS_A, dedupeKey: args.dedupeKey })).toBe(1);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toBe("Your WaFlow payment didn't go through");
    const row = await OnboardingNotification.findOne({ workspaceId: WS_A, dedupeKey: args.dedupeKey }).lean();
    expect(row.emailAttempts).toBe(1);
    expect(row.emailSentAt).toBeInstanceOf(Date);
    expect(row.emailError).toBeUndefined();
  });
  test('ten simultaneous notify() calls with one key -> exactly one document and one mail', async () => {
    const mail = createFakeSend();
    const deps = { email, emailDeps: { send: mail.send, resolveRecipient: async () => ({ to: 'owner@example.test', language: 'ar' }) } };
    const args = { workspaceId: WS_A, kind: 'connected', dedupeKey: 'race:connected', email: true, params: {} };
    const results = await Promise.all(Array.from({ length: 10 }, () => notifications.notify(args, deps)));
    await Promise.all(results.map((r) => r.emailPromise));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await OnboardingNotification.countDocuments({ workspaceId: WS_A, dedupeKey: 'race:connected' })).toBe(1);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].html).toContain('lang="ar"');
  });
  test('a failing mail is recorded, retried at most 3 times in total, and never blocks the in-app row', async () => {
    const mail = createFakeSend({ failFirst: Infinity });
    const deps = { email, emailDeps: { send: mail.send, resolveRecipient: async () => ({ to: 'owner@example.test', language: 'en' }) } };
    const r = await notifications.notify({ workspaceId: WS_B, kind: 'reconnect_needed', dedupeKey: 'reconnect:TOKEN_REVOKED:1', email: true }, deps);
    expect(r.created).toBe(true);
    await r.emailPromise;
    const find = () => OnboardingNotification.findOne({ workspaceId: WS_B, dedupeKey: 'reconnect:TOKEN_REVOKED:1' }).lean();
    expect(await find()).toMatchObject({ emailAttempts: 1, emailError: 'FAKE_SEND_FAILURE' });
    await notifications.retryEmails({}, deps);
    await notifications.retryEmails({}, deps);
    const after = await find();
    expect(after.emailAttempts).toBe(3);
    const third = await notifications.retryEmails({}, deps);
    expect(third.attempted).toBe(0);
    expect(mail.attempts).toBe(3);
    expect(mail.sent).toHaveLength(0);
  });
  test('retryEmails delivers a transient failure exactly once', async () => {
    const mail = createFakeSend({ failFirst: 1 });
    const deps = { email, emailDeps: { send: mail.send, resolveRecipient: async () => ({ to: 'owner@example.test', language: 'en' }) } };
    const r = await notifications.notify({ workspaceId: WS_B, kind: 'template_rejected', dedupeKey: 'template:t1:REJECTED', email: true, params: { reason: 'INVALID_FORMAT' } }, deps);
    await r.emailPromise;
    expect(mail.sent).toHaveLength(0);
    const retried = await notifications.retryEmails({}, deps);
    expect(retried.sent).toBeGreaterThanOrEqual(1);
    expect(mail.sent.filter((m) => m.subject === 'A message template was rejected')).toHaveLength(1);
    await notifications.retryEmails({}, deps);
    expect(mail.sent.filter((m) => m.subject === 'A message template was rejected')).toHaveLength(1);
  });
});

describe('recipient resolution against real documents', () => {
  test('prefill.email -> owner User.email -> business.contactEmail -> none (phone-only)', async () => {
    const ws = String(oid());
    const user = await User.create({ email: `owner-${ws}@example.test`, name: 'Owner' });
    await Membership.create({ userId: user._id, workspaceId: ws, role: 'owner' });
    const member = await User.create({ email: `member-${ws}@example.test` });
    await Membership.create({ userId: member._id, workspaceId: ws, role: 'member' });
    // no state document: the owner
    expect(await email.resolveRecipient({ workspaceId: ws })).toEqual({ to: `owner-${ws}@example.test`, language: 'en' });
    await OnboardingState.create({ workspaceId: ws, business: { contactEmail: 'contact@example.test', uiLanguage: 'ar' } });
    expect(await email.resolveRecipient({ workspaceId: ws })).toEqual({ to: `owner-${ws}@example.test`, language: 'ar' });
    await OnboardingState.updateOne({ workspaceId: ws }, { $set: { 'prefill.email': 'prefill@example.test' } });
    expect((await email.resolveRecipient({ workspaceId: ws })).to).toBe('prefill@example.test');

    const phoneOnly = String(oid());
    const pUser = await User.create({ phone: `9665${String(Date.now()).slice(-8)}` });
    await Membership.create({ userId: pUser._id, workspaceId: phoneOnly, role: 'owner' });
    expect(await email.resolveRecipient({ workspaceId: phoneOnly })).toBeNull();
    // business.contactEmail counts only when the OWNER set it (review R2-15): a value without the marker is ignored
    await OnboardingState.create({ workspaceId: phoneOnly, business: { contactEmail: 'fallback@example.test' } });
    expect(await email.resolveRecipient({ workspaceId: phoneOnly })).toBeNull();
    await OnboardingState.updateOne({ workspaceId: phoneOnly }, { $set: { 'business.contactEmailByOwner': true } });
    expect((await email.resolveRecipient({ workspaceId: phoneOnly })).to).toBe('fallback@example.test');
  });
});

describe('GET /notifications and POST /notifications/read on real data', () => {
  const ws = String(oid());
  const other = String(oid());
  let ids;
  beforeAll(async () => {
    const mk = async (workspaceId, kind, key, at) => {
      const r = await notifications.notify({ workspaceId, kind, dedupeKey: key, params: { n: 1 }, severity: 'success', actionPath: '/setup/approvals' });
      await OnboardingNotification.updateOne({ _id: r.notification.id }, { $set: { createdAt: at } });
      return r.notification.id;
    };
    ids = [
      await mk(ws, 'connected', 'k1', new Date('2026-10-14T08:00:00Z')),
      await mk(ws, 'template_approved', 'k2', new Date('2026-10-14T09:00:00Z')),
      await mk(ws, 'sending_paused', 'k3', new Date('2026-10-14T10:00:00Z')),
      await mk(other, 'connected', 'k1', new Date('2026-10-14T11:00:00Z')),
    ];
  });
  test('newest first, C14 row shape, unread count', async () => {
    const res = await request(appFor(ws)).get('/api/onboarding/notifications');
    expect(res.status).toBe(200);
    expect(res.body.notifications.map((n) => n.kind)).toEqual(['sending_paused', 'template_approved', 'connected']);
    expect(res.body.unread).toBe(3);
    expect(res.body.notifications[0]).toMatchObject({
      id: ids[2], kind: 'sending_paused', severity: 'success', titleKey: 'onboarding.notify.sending_paused.title', bodyKey: 'onboarding.notify.sending_paused.body',
      params: { n: 1 }, actionPath: '/setup/approvals', readAt: null,
    });
    expect(typeof res.body.notifications[0].createdAt).toBe('string');
  });
  test('limit and unread filters', async () => {
    const app = appFor(ws);
    expect((await request(app).get('/api/onboarding/notifications?limit=2')).body.notifications).toHaveLength(2);
    expect((await request(app).get('/api/onboarding/notifications?limit=1000')).body.notifications).toHaveLength(3);
  });
  test('tenant isolation: another workspace cannot read or mark these rows (even by id)', async () => {
    const appOther = appFor(other);
    const list = await request(appOther).get('/api/onboarding/notifications');
    expect(list.body.notifications).toHaveLength(1);
    const forged = await request(appOther).post('/api/onboarding/notifications/read').send({ ids });
    expect(forged.body.modified).toBe(1); // only its own row
    expect((await request(appFor(ws)).get('/api/onboarding/notifications?unread=1')).body.notifications).toHaveLength(3);
  });
  test('mark one, then all; unread filter follows', async () => {
    const app = appFor(ws);
    const one = await request(app).post('/api/onboarding/notifications/read').send({ ids: [ids[2]] });
    expect(one.body).toEqual({ modified: 1, unread: 2 });
    const unread = await request(app).get('/api/onboarding/notifications?unread=1');
    expect(unread.body.notifications.map((n) => n.id).sort()).toEqual([ids[0], ids[1]].sort());
    const all = await request(app).post('/api/onboarding/notifications/read').send({ all: true });
    expect(all.body).toEqual({ modified: 2, unread: 0 });
    const again = await request(app).post('/api/onboarding/notifications/read').send({ all: true });
    expect(again.body).toEqual({ modified: 0, unread: 0 });
    const row = await OnboardingNotification.findById(ids[2]).lean();
    expect(row.readAt).toBeInstanceOf(Date);
    expect((await request(app).get('/api/onboarding/notifications')).body.notifications.every((n) => n.readAt)).toBe(true);
  });
  test('validation: neither ids nor all -> 422', async () => {
    const res = await request(appFor(ws)).post('/api/onboarding/notifications/read').send({});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /events on a real collection', () => {
  const ws = String(oid());
  test('stores only the whitelisted fields; PII, unknown types and unknown fail codes never reach the collection', async () => {
    analytics._resetMemo();
    const app = appFor(ws);
    const post = (b) => request(app).post('/api/onboarding/events').send(b);
    expect((await post({ type: 'step_complete', step: 'business', durationMs: 4200, reason: 'owner@example.test', meta: { phone: '966501234567' }, name: 'Acme' })).status).toBe(204);
    expect((await post({ type: 'step_fail', step: 'connect', code: 'ONB_POPUP_BLOCKED' })).status).toBe(204);
    expect((await post({ type: 'step_fail', step: 'connect', code: 'CONNECT_PARTIAL' })).status).toBe(204);
    expect((await post({ type: 'admin' })).status).toBe(204);
    expect((await post({ type: 'help_opened', step: 'number' })).status).toBe(204);
    const rows = await OnboardingEvent.find({ workspaceId: ws }).lean();
    expect(rows.map((r) => r.type).sort()).toEqual(['help_opened', 'step_complete', 'step_fail']);
    const complete = rows.find((r) => r.type === 'step_complete');
    expect(complete).toMatchObject({ step: 'business', durationMs: 4200 });
    expect(complete.reason).toBeUndefined();
    expect(complete.meta).toBeUndefined();
    expect(JSON.stringify(rows)).not.toMatch(/966501234567|owner@example|Acme/);
    expect(rows.find((r) => r.type === 'step_fail').code).toBe('ONB_POPUP_BLOCKED');
  });
  test('step_enter is coalesced per step and hour by the shared write path', async () => {
    analytics._resetMemo();
    const app = appFor(ws);
    for (let i = 0; i < 4; i += 1) await request(app).post('/api/onboarding/events').send({ type: 'step_enter', step: 'number' });
    expect(await OnboardingEvent.countDocuments({ workspaceId: ws, type: 'step_enter', step: 'number' })).toBe(1);
  });
});
