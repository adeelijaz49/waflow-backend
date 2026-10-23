'use strict';
const email = require('../../../shared/onboarding/email');
const emailCopy = require('../../../shared/onboarding/emailCopy');
const notifications = require('../../../shared/onboarding/notifications');
const { createFakeSend } = require('../_fixtures');
const { createFakeModel } = require('./_b0Store');

const WS = '507f1f77bcf86cd799439011';
const WS2 = '507f1f77bcf86cd799439012';
const OWNER = '607f1f77bcf86cd799439021';
const MEMBER = '607f1f77bcf86cd799439022';
const ENV = ['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'ONBOARDING_SUPPORT_EMAIL', 'SUPPORT_DESK_EMAIL', 'FRONTEND_URL'];
const saved = {};
let warnSpy;
beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { warnSpy.mockRestore(); for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function models({ state, users, memberships } = {}) {
  const OnboardingState = createFakeModel();
  const Membership = createFakeModel();
  const User = createFakeModel();
  (state || []).forEach((s) => OnboardingState.seed(s));
  (users || []).forEach((u) => User.seed(u));
  (memberships || []).forEach((m) => Membership.seed(m));
  return { OnboardingState, Membership, User };
}

describe('send (Resend client)', () => {
  test('resolves { id } and passes from / replyTo / text', async () => {
    process.env.RESEND_FROM_EMAIL = 'WaFlow <hello@example.test>';
    const calls = [];
    const resend = { emails: { send: async (p) => { calls.push(p); return { data: { id: 'em_1' }, error: null }; } } };
    const r = await email.send({ to: 'a@example.test', subject: 'S', html: '<p>x</p>', text: 'x', replyTo: 'r@example.test' }, { resend });
    expect(r).toEqual({ id: 'em_1' });
    expect(calls[0]).toMatchObject({ from: 'WaFlow <hello@example.test>', to: 'a@example.test', subject: 'S', html: '<p>x</p>', text: 'x', replyTo: 'r@example.test' });
  });
  test('THROWS on an API-level error (the SDK resolves { data:null, error }) without echoing the provider message', async () => {
    const resend = { emails: { send: async () => ({ data: null, error: { name: 'validation_error', message: 'to: leak@example.test is invalid', statusCode: 422 } }) } };
    await expect(email.send({ to: 'a@example.test', subject: 'S', html: 'h' }, { resend })).rejects.toMatchObject({ code: 'EMAIL_SEND_FAILED', statusCode: 422 });
    await expect(email.send({ to: 'a@example.test', subject: 'S', html: 'h' }, { resend })).rejects.toThrow(/validation_error/);
    let msg = '';
    try { await email.send({ to: 'a@example.test', subject: 'S', html: 'h' }, { resend }); } catch (e) { msg = e.message; }
    expect(msg).not.toContain('leak@example.test');
  });
  test('a network failure of the client propagates', async () => {
    const resend = { emails: { send: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); } } };
    await expect(email.send({ to: 'a@example.test', subject: 'S', html: 'h' }, { resend })).rejects.toMatchObject({ code: 'ECONNRESET' });
  });
  test('without RESEND_API_KEY and without an injected client it throws EMAIL_NOT_CONFIGURED (never builds a client)', async () => {
    await expect(email.send({ to: 'a@example.test', subject: 'S', html: 'h' })).rejects.toMatchObject({ code: 'EMAIL_NOT_CONFIGURED' });
    expect(email.isConfigured()).toBe(false);
    expect(email.isConfigured({ send: () => {} })).toBe(true);
    process.env.RESEND_API_KEY = 're_dummy';
    expect(email.isConfigured()).toBe(true);
  });
  test('isEmail', () => {
    expect(email.isEmail('a@example.test')).toBe(true);
    for (const bad of ['', 'a', 'a@b', 'a b@c.d', '<a@b.c>', null, undefined, 5, 'a@b.c,d@e.f', `${'x'.repeat(250)}@e.fg`]) expect(email.isEmail(bad)).toBe(false);
  });
});

describe('resolveRecipient', () => {
  const owner = { _id: OWNER, email: 'owner@example.test' };
  const base = (state) => ({
    state: state === null ? [] : [{ workspaceId: WS, ...(state || {}) }],
    users: [owner, { _id: MEMBER, email: 'member@example.test' }],
    memberships: [{ workspaceId: WS, userId: OWNER, role: 'owner' }, { workspaceId: WS, userId: MEMBER, role: 'member' }],
  });
  test('1. prefill.email wins', async () => {
    const m = models(base({ prefill: { email: 'prefill@example.test' }, business: { contactEmail: 'contact@example.test', uiLanguage: 'ar' } }));
    expect(await email.resolveRecipient({ workspaceId: WS }, m)).toEqual({ to: 'prefill@example.test', language: 'ar' });
  });
  test('2. otherwise the OWNER user e-mail (never a member)', async () => {
    const m = models(base({ business: { contactEmail: 'contact@example.test' } }));
    expect(await email.resolveRecipient({ workspaceId: WS }, m)).toEqual({ to: 'owner@example.test', language: 'en' });
  });
  test('3. otherwise business.contactEmail, but only an address the OWNER typed (review R2-09)', async () => {
    const m = models({ ...base({ business: { contactEmail: 'contact@example.test', contactEmailByOwner: true, uiLanguage: 'ar' } }), users: [{ _id: OWNER, phone: '966500000000' }] });
    expect(await email.resolveRecipient({ workspaceId: WS }, m)).toEqual({ to: 'contact@example.test', language: 'ar' });
  });
  test('3b. an address that nobody confirmed as the owner\'s own is never used for notification mail', async () => {
    for (const business of [{ contactEmail: 'contact@example.test', uiLanguage: 'ar' }, { contactEmail: 'contact@example.test', contactEmailByOwner: false }]) {
      const m = models({ ...base({ business }), users: [{ _id: OWNER, phone: '966500000000' }] });
      expect(await email.resolveRecipient({ workspaceId: WS }, m)).toBeNull();
    }
  });
  test('4. a phone-only account with no contact e-mail -> null (in-app only)', async () => {
    const m = models({ ...base({}), users: [{ _id: OWNER, phone: '966500000000' }] });
    expect(await email.resolveRecipient({ workspaceId: WS }, m)).toBeNull();
  });
  test('an invalid prefill address is skipped, the owner is used', async () => {
    const m = models(base({ prefill: { email: 'not an email' } }));
    expect((await email.resolveRecipient({ workspaceId: WS }, m)).to).toBe('owner@example.test');
  });
  test('no state document: still the owner e-mail, language en', async () => {
    const m = models(base(null));
    expect(await email.resolveRecipient({ workspaceId: WS }, m)).toEqual({ to: 'owner@example.test', language: 'en' });
  });
  test('another workspace never leaks across (tenant isolation) and a missing id is null', async () => {
    const m = models(base({ prefill: { email: 'prefill@example.test' } }));
    expect(await email.resolveRecipient({ workspaceId: WS2 }, m)).toBeNull();
    expect(await email.resolveRecipient({}, m)).toBeNull();
    expect(await email.resolveRecipient(undefined, m)).toBeNull();
  });
  test('a database error propagates (the caller retries)', async () => {
    const m = models(base({}));
    m.OnboardingState.failWith = new Error('db down');
    await expect(email.resolveRecipient({ workspaceId: WS }, m)).rejects.toThrow('db down');
  });
});

describe('sendNotificationEmail', () => {
  const recipient = async () => ({ to: 'owner@example.test', language: 'en' });
  test('renders and sends to the resolved recipient', async () => {
    const mail = createFakeSend();
    const r = await email.sendNotificationEmail({ workspaceId: WS, kind: 'connected', params: {} }, { send: mail.send, resolveRecipient: recipient });
    expect(r).toEqual({ sent: true, id: 'email_fixture_1' });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe('owner@example.test');
    expect(mail.sent[0].subject).toBe('WhatsApp is connected to WaFlow');
    expect(mail.sent[0].html).toContain('Continue setup');
  });
  test('Arabic recipient language renders Arabic copy; an explicit language/to wins', async () => {
    const mail = createFakeSend();
    await email.sendNotificationEmail({ workspaceId: WS, kind: 'connected' }, { send: mail.send, resolveRecipient: async () => ({ to: 'o@example.test', language: 'ar' }) });
    expect(mail.sent[0].subject).toBe(emailCopy.render('connected', 'ar', {}).subject);
    await email.sendNotificationEmail({ workspaceId: WS, kind: 'connected', to: 'other@example.test', language: 'en' }, { send: mail.send, resolveRecipient: async () => { throw new Error('must not be called'); } });
    expect(mail.sent[1].to).toBe('other@example.test');
    expect(mail.sent[1].subject).toBe('WhatsApp is connected to WaFlow');
  });
  test('kind falls back to notification.kind and the notification actionPath is the link', async () => {
    process.env.FRONTEND_URL = 'https://app.example.test';
    const mail = createFakeSend();
    await email.sendNotificationEmail({ workspaceId: WS, notification: { kind: 'template_rejected', actionPath: '/setup/approvals' }, params: { reason: 'INVALID_FORMAT' } }, { send: mail.send, resolveRecipient: recipient });
    expect(mail.sent[0].subject).toBe('A message template was rejected');
    expect(mail.sent[0].html).toContain('https://app.example.test/setup/approvals');
    expect(mail.sent[0].html).toContain('INVALID_FORMAT');
  });
  test('skips with no_recipient (phone-only account / invalid address) and never sends', async () => {
    const mail = createFakeSend();
    expect(await email.sendNotificationEmail({ workspaceId: WS, kind: 'connected' }, { send: mail.send, resolveRecipient: async () => null })).toEqual({ sent: false, skipped: 'no_recipient' });
    expect(await email.sendNotificationEmail({ workspaceId: WS, kind: 'connected', to: 'bad' }, { send: mail.send, resolveRecipient: async () => null })).toEqual({ sent: false, skipped: 'no_recipient' });
    expect(mail.attempts).toBe(0);
  });
  test('skips with not_configured when there is no e-mail client at all (and does not touch the database)', async () => {
    const touched = jest.fn();
    const r = await email.sendNotificationEmail({ workspaceId: WS, kind: 'connected' }, { resolveRecipient: touched });
    expect(r).toEqual({ sent: false, skipped: 'not_configured' });
    expect(touched).not.toHaveBeenCalled();
  });
  test('a provider failure THROWS (notify records emailError and retries)', async () => {
    const mail = createFakeSend({ failFirst: 1, failWith: { code: 'FAKE_SEND_FAILURE', statusCode: 503 } });
    await expect(email.sendNotificationEmail({ workspaceId: WS, kind: 'connected' }, { send: mail.send, resolveRecipient: recipient })).rejects.toMatchObject({ code: 'FAKE_SEND_FAILURE' });
  });
  test('hostile params are escaped; no phone number, token or workspace name reaches the message', async () => {
    const mail = createFakeSend();
    const hostile = { templateKey: '<img src=x onerror=alert(1)>', reason: '"><script>alert(1)</script>', phone: '966501234567', token: 'EAAFXTdummy_'.padEnd(64, 'x'), workspaceName: "Adeel's Workspace" };
    for (const kind of notifications.KINDS) {
      for (const language of ['en', 'ar']) {
        await email.sendNotificationEmail({ workspaceId: WS, kind, params: hostile }, { send: mail.send, resolveRecipient: async () => ({ to: 'owner@example.test', language }) });
      }
    }
    expect(mail.sent).toHaveLength(notifications.KINDS.length * 2);
    expect(mail.assertEscaped([hostile.templateKey, hostile.reason])).toBe(true);
    expect(mail.assertNoLeak([hostile.phone, hostile.token, 'Adeel'])).toBe(true);
    expect(mail.findPhoneLike()).toEqual([]);
  });
});

describe('sendSupportEmail', () => {
  const request = { kind: 'help', businessName: '<b>Acme</b>', step: 'connect', lastErrorCode: 'CONNECT_PARTIAL', message: '<script>alert(1)</script>', contactEmail: 'owner@example.test' };
  test('goes to ONBOARDING_SUPPORT_EMAIL, escaped, static subject, reply-to the merchant', async () => {
    process.env.ONBOARDING_SUPPORT_EMAIL = 'support@example.test';
    process.env.SUPPORT_DESK_EMAIL = 'desk@example.test';
    const mail = createFakeSend();
    const r = await email.sendSupportEmail(request, { send: mail.send });
    expect(r.sent).toBe(true);
    expect(mail.sent[0].to).toBe('support@example.test');
    expect(mail.sent[0].subject).toBe('WaFlow onboarding help request');
    expect(mail.sent[0].replyTo).toBe('owner@example.test');
    expect(mail.sent[0].html).toContain('CONNECT_PARTIAL');
    expect(mail.assertEscaped(['<b>Acme</b>', '<script>alert(1)</script>'])).toBe(true);
  });
  test('falls back to SUPPORT_DESK_EMAIL; none configured -> skipped no_recipient; no client -> skipped not_configured', async () => {
    const mail = createFakeSend();
    expect(await email.sendSupportEmail(request, { send: mail.send })).toEqual({ sent: false, skipped: 'no_recipient' });
    process.env.SUPPORT_DESK_EMAIL = 'desk@example.test';
    expect((await email.sendSupportEmail(request, { send: mail.send })).sent).toBe(true);
    expect(mail.sent[0].to).toBe('desk@example.test');
    expect(await email.sendSupportEmail(request, {})).toEqual({ sent: false, skipped: 'not_configured' });
  });
  test('an invalid contact e-mail gets no reply-to; a provider failure throws', async () => {
    process.env.SUPPORT_DESK_EMAIL = 'desk@example.test';
    const mail = createFakeSend({ failFirst: 1 });
    await expect(email.sendSupportEmail(request, { send: mail.send })).rejects.toMatchObject({ code: 'FAKE_SEND_FAILURE' });
    await email.sendSupportEmail({ ...request, contactEmail: 'nope' }, { send: mail.send });
    expect(mail.sent[0].replyTo).toBeUndefined();
  });
});

describe('notify -> e-mail, end to end (fake model + fake Resend)', () => {
  const NOTIF = { unique: [['workspaceId', 'dedupeKey']], defaults: { readAt: null, emailAttempts: 0 } };
  function setup(sendOpts) {
    const model = createFakeModel(NOTIF);
    const mail = createFakeSend(sendOpts);
    const emailDeps = { send: mail.send, resolveRecipient: async () => ({ to: 'owner@example.test', language: 'en' }) };
    const n = notifications.createNotifications({ model, email, emailDeps, now: () => new Date('2026-10-15T10:00:00Z') });
    return { model, mail, n };
  }
  const args = { workspaceId: WS, kind: 'payment_failed', dedupeKey: 'sub:past_due:sub_1:inv_1', params: {}, email: true };

  test('same dedupeKey twice -> ONE row and ONE mail', async () => {
    const { model, mail, n } = setup();
    const a = await n.notify(args);
    expect(await a.emailPromise).toMatchObject({ sent: true });
    const b = await n.notify(args);
    expect(b.created).toBe(false);
    expect(b.emailPromise).toBeNull();
    expect(model.rows).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({ emailAttempts: 1 });
    expect(model.rows[0].emailSentAt).toBeInstanceOf(Date);
    expect(model.rows[0].emailError).toBeUndefined();
  });
  test('a failed mail is recorded and retried, at most 3 attempts in total, and never blocks notify', async () => {
    const { model, mail, n } = setup({ failFirst: Infinity });
    const a = await n.notify(args);
    expect(a.created).toBe(true); // the in-app row exists although the mail failed
    expect(await a.emailPromise).toMatchObject({ sent: false });
    expect(model.rows[0]).toMatchObject({ emailAttempts: 1, emailError: 'FAKE_SEND_FAILURE' });
    expect((await n.retryEmails({})).attempted).toBe(1);
    expect((await n.retryEmails({})).attempted).toBe(1);
    expect(model.rows[0].emailAttempts).toBe(3);
    expect(await n.retryEmails({})).toEqual({ attempted: 0, sent: 0 }); // the limit holds
    expect(mail.attempts).toBe(3);
    expect(mail.sent).toHaveLength(0);
  });
  test('a transient failure is delivered by a retry (exactly one message in the end)', async () => {
    const { model, mail, n } = setup({ failFirst: 1 });
    const a = await n.notify(args);
    await a.emailPromise;
    expect(mail.sent).toHaveLength(0);
    expect(await n.retryEmails({})).toEqual({ attempted: 1, sent: 1 });
    expect(mail.sent).toHaveLength(1);
    expect(model.rows[0].emailSentAt).toBeInstanceOf(Date);
    expect(model.rows[0].emailError).toBeUndefined();
    expect(await n.retryEmails({})).toEqual({ attempted: 0, sent: 0 });
  });
  test('a hanging mail provider never blocks the state change (notify resolves first)', async () => {
    const model = createFakeModel(NOTIF);
    const n = notifications.createNotifications({
      model, email, emailDeps: { send: () => new Promise(() => {}), resolveRecipient: async () => ({ to: 'owner@example.test', language: 'en' }) },
    });
    let timer;
    const r = await Promise.race([n.notify(args), new Promise((resolve) => { timer = setTimeout(() => resolve('blocked'), 1500); })]);
    clearTimeout(timer);
    expect(r).not.toBe('blocked');
    expect(r.created).toBe(true);
  });
  test('a phone-only account gets the in-app row only; the skip is terminal (no retry loop)', async () => {
    const model = createFakeModel(NOTIF);
    const mail = createFakeSend();
    const n = notifications.createNotifications({ model, email, emailDeps: { send: mail.send, resolveRecipient: async () => null } });
    const a = await n.notify(args);
    expect(await a.emailPromise).toMatchObject({ sent: false, skipped: 'no_recipient' });
    expect(model.rows).toHaveLength(1);
    expect(mail.attempts).toBe(0);
    expect(await n.retryEmails({})).toEqual({ attempted: 0, sent: 0 });
  });
});
