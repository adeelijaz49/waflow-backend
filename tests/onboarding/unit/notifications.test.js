'use strict';
const notifications = require('../../../shared/onboarding/notifications');
const { createFakeModel } = require('./_b0Store');

const WS = '507f1f77bcf86cd799439011';
const WS2 = '507f1f77bcf86cd799439012';

function setup(emailImpl) {
  const model = createFakeModel({ unique: [['workspaceId', 'dedupeKey']], defaults: { readAt: null, emailAttempts: 0 } });
  const email = { sendNotificationEmail: jest.fn(emailImpl || (async () => ({ sent: true, id: 'em_1' }))) };
  const now = jest.fn(() => new Date('2026-10-15T10:00:00Z'));
  const n = notifications.createNotifications({ model, email, now });
  return { model, email, n, now };
}
const base = { workspaceId: WS, kind: 'connected', dedupeKey: 'connected:2026', params: { a: 1 } };

describe('notify', () => {
  test('creates a row with i18n keys and defaults', async () => {
    const { n, model } = setup();
    const r = await n.notify(base);
    expect(r.created).toBe(true);
    expect(r.emailPromise).toBeNull();
    expect(r.notification).toMatchObject({ kind: 'connected', severity: 'info', titleKey: 'onboarding.notify.connected.title', bodyKey: 'onboarding.notify.connected.body', actionPath: '/setup', readAt: null });
    expect(model.rows).toHaveLength(1);
  });
  test('dedupe: the same key twice -> one row, second call created:false and NO e-mail', async () => {
    const { n, model, email } = setup();
    const a = await n.notify({ ...base, email: true });
    await a.emailPromise;
    const b = await n.notify({ ...base, email: true });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.notification.id).toBe(a.notification.id);
    expect(b.emailPromise).toBeNull();
    expect(model.rows).toHaveLength(1);
    expect(email.sendNotificationEmail).toHaveBeenCalledTimes(1);
  });
  test('dedupe also holds when the index reports E11000 (race)', async () => {
    const { n, model } = setup();
    model.seed({ workspaceId: WS, dedupeKey: 'k1', kind: 'connected', readAt: null });
    const realFindOne = model.findOne;
    let calls = 0;
    model.findOne = (f) => { calls += 1; return calls === 1 ? Promise.resolve(null) : realFindOne(f); }; // pre-check misses, create hits the unique key
    const r = await n.notify({ ...base, dedupeKey: 'k1' });
    expect(r.created).toBe(false);
    expect(r.notification).not.toBeNull();
    expect(model.rows).toHaveLength(1);
  });
  test('same key in another workspace is a different notification', async () => {
    const { n, model } = setup();
    await n.notify(base);
    const r = await n.notify({ ...base, workspaceId: WS2 });
    expect(r.created).toBe(true);
    expect(model.rows).toHaveLength(2);
  });
  test('validation: invalid workspace, unknown kind, missing dedupeKey -> no row, no throw', async () => {
    const { n, model } = setup();
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await n.notify({ ...base, workspaceId: 'x' })).created).toBe(false);
    expect((await n.notify({ ...base, kind: 'weird' })).created).toBe(false);
    expect((await n.notify({ ...base, dedupeKey: '' })).created).toBe(false);
    expect((await n.notify(undefined)).created).toBe(false);
    spy.mockRestore();
    expect(model.rows).toHaveLength(0);
  });
  test('severity and actionPath are validated; params are trimmed to small primitives', async () => {
    const { n } = setup();
    const long = 'x'.repeat(200);
    const r = await n.notify({ ...base, severity: 'catastrophe', actionPath: 'javascript:alert(1)', params: { s: long, n: 5, b: true, o: { nested: 1 }, f: () => 1, k1: 1, k2: 1, k3: 1, k4: 1, k5: 1, k6: 1, k7: 1 } });
    expect(r.notification.severity).toBe('info');
    expect(r.notification.actionPath).toBe('/setup');
    expect(r.notification.params.s).toHaveLength(80);
    expect(r.notification.params.o).toBeUndefined();
    expect(Object.keys(r.notification.params).length).toBeLessThanOrEqual(8);
    const ok = await n.notify({ ...base, dedupeKey: 'k2', severity: 'action', actionPath: '/setup/approvals' });
    expect(ok.notification).toMatchObject({ severity: 'action', actionPath: '/setup/approvals' });
  });
  test('a database failure never throws', async () => {
    const { n, model } = setup();
    model.failWith = new Error('db down');
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(n.notify(base)).resolves.toEqual({ created: false, notification: null, emailPromise: null });
    spy.mockRestore();
  });
});

describe('e-mail', () => {
  test('sent on first insert: bookkeeping set, payload carries ids/kind/params, to/language forwarded', async () => {
    const { n, model, email } = setup();
    const r = await n.notify({ ...base, email: { to: 'owner@example.com', language: 'ar' } });
    await expect(r.emailPromise).resolves.toEqual({ sent: true, id: 'em_1' });
    const call = email.sendNotificationEmail.mock.calls[0][0];
    expect(call).toMatchObject({ workspaceId: WS, kind: 'connected', to: 'owner@example.com', language: 'ar', params: { a: 1 } });
    expect(call.notification.id).toBeTruthy();
    const row = model.rows[0];
    expect(row.emailAttempts).toBe(1);
    expect(row.emailSentAt).toBeInstanceOf(Date);
    expect(row.emailError).toBeUndefined();
  });
  test('notify does not wait for the e-mail and a failing mail never blocks or throws', async () => {
    const { n, model } = setup(async () => { const e = new Error('smtp down'); e.code = 'RESEND_DOWN'; throw e; });
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await n.notify({ ...base, email: true });
    expect(r.created).toBe(true);
    await expect(r.emailPromise).resolves.toMatchObject({ sent: false });
    expect(model.rows[0].emailError).toBe('RESEND_DOWN');
    expect(model.rows[0].emailAttempts).toBe(1);
    expect(model.rows[0].emailSentAt).toBeUndefined();
    spy.mockRestore();
  });
  test('"skipped" (no recipient) is terminal: recorded, never retried', async () => {
    const { n, model, email } = setup(async () => ({ sent: false, skipped: 'no_recipient' }));
    const r = await n.notify({ ...base, email: true });
    await r.emailPromise;
    expect(model.rows[0].emailError).toBe('skipped:no_recipient');
    const out = await n.retryEmails({});
    expect(out).toEqual({ attempted: 0, sent: 0 });
    expect(email.sendNotificationEmail).toHaveBeenCalledTimes(1);
  });
  test('retryEmails re-sends failures up to 3 attempts, then stops', async () => {
    let fail = true;
    const { n, model, email } = setup(async () => { if (fail) { const e = new Error('x'); e.code = 'E1'; throw e; } return { sent: true, id: 'em_9' }; });
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await n.notify({ ...base, email: true });
    await r.emailPromise; // attempt 1 (failed)
    expect((await n.retryEmails({})).attempted).toBe(1); // attempt 2 (failed)
    expect((await n.retryEmails({})).attempted).toBe(1); // attempt 3 (failed)
    expect(model.rows[0].emailAttempts).toBe(3);
    expect(await n.retryEmails({})).toEqual({ attempted: 0, sent: 0 }); // capped
    expect(email.sendNotificationEmail).toHaveBeenCalledTimes(3);
    // a fresh failing row that then succeeds on retry
    fail = true;
    const r2 = await n.notify({ ...base, dedupeKey: 'k-retry', email: true });
    await r2.emailPromise;
    fail = false;
    expect(await n.retryEmails({})).toEqual({ attempted: 1, sent: 1 });
    expect(model.rows.find((x) => x.dedupeKey === 'k-retry').emailSentAt).toBeInstanceOf(Date);
    expect(await n.retryEmails({})).toEqual({ attempted: 0, sent: 0 });
    spy.mockRestore();
  });
  test('no e-mail requested -> mailer never called', async () => {
    const { n, email } = setup();
    await n.notify(base);
    expect(email.sendNotificationEmail).not.toHaveBeenCalled();
  });
});

describe('list / markRead / unreadCount', () => {
  async function seed(n) {
    for (let i = 0; i < 3; i += 1) await n.notify({ ...base, dedupeKey: `k${i}` });
    await n.notify({ ...base, workspaceId: WS2, dedupeKey: 'other' });
  }
  test('list is workspace scoped, newest first, mapped to the C14 row shape', async () => {
    const { n, model } = setup();
    await seed(n);
    model.rows.forEach((r, i) => { r.createdAt = new Date(2026, 0, 1 + i); });
    const rows = await n.list(WS, {});
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.createdAt.getDate())).toEqual([3, 2, 1]);
    expect(Object.keys(rows[0]).sort()).toEqual(['actionPath', 'bodyKey', 'createdAt', 'id', 'kind', 'params', 'readAt', 'severity', 'titleKey']);
  });
  test('unread filter and limit', async () => {
    const { n } = setup();
    await seed(n);
    const first = (await n.list(WS, {}))[0];
    await n.markRead(WS, { ids: [first.id] });
    expect(await n.list(WS, { unread: true })).toHaveLength(2);
    expect(await n.list(WS, { limit: 1 })).toHaveLength(1);
  });
  test('markRead by ids only touches this workspace; all:true marks all of this workspace', async () => {
    const { n, model } = setup();
    await seed(n);
    const otherId = String(model.rows.find((r) => r.workspaceId === WS2)._id);
    expect(await n.markRead(WS, { ids: [otherId] })).toEqual({ modified: 0 });
    expect(await n.unreadCount(WS2)).toBe(1);
    expect(await n.markRead(WS, { all: true })).toEqual({ modified: 3 });
    expect(await n.unreadCount(WS)).toBe(0);
    expect(await n.unreadCount(WS2)).toBe(1);
  });
  test('markRead ignores malformed ids; helpers return safe values on bad input or DB errors', async () => {
    const { n, model } = setup();
    expect(await n.markRead(WS, { ids: ['nope', 5, null] })).toEqual({ modified: 0 });
    expect(await n.list('bad', {})).toEqual([]);
    expect(await n.unreadCount('bad')).toBe(0);
    model.failWith = new Error('db down');
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await n.list(WS, {})).toEqual([]);
    expect(await n.unreadCount(WS)).toBe(0);
    expect(await n.markRead(WS, { all: true })).toEqual({ modified: 0 });
    spy.mockRestore();
  });
});

describe('module exports', () => {
  test('KINDS is the DB 7.1 list', () => {
    expect(notifications.KINDS).toEqual([
      'payment_failed', 'subscription_active', 'subscription_cancelled', 'connected', 'reconnect_needed', 'verification_changed',
      'display_name_decided', 'messaging_limit_changed', 'template_approved', 'template_rejected', 'pathb_reminder', 'sending_paused',
      'account_alert', 'help_received',
    ]);
  });
  test('top-level functions accept injected deps', async () => {
    const model = createFakeModel({ unique: [['workspaceId', 'dedupeKey']], defaults: { readAt: null, emailAttempts: 0 } });
    const r = await notifications.notify(base, { model });
    expect(r.created).toBe(true);
    expect(await notifications.unreadCount(WS, { model })).toBe(1);
    expect(await notifications.list(WS, {}, { model })).toHaveLength(1);
    expect(await notifications.markRead(WS, { all: true }, { model })).toEqual({ modified: 1 });
  });
});
