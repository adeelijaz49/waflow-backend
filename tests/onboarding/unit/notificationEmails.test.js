'use strict';
// The e-mail policy of the onboarding notifications, proved through the REAL chain:
//   notifications.notify -> email.sendNotificationEmail -> emailCopy.render -> the fake provider (createFakeSend)
// Spec Step 4: "Send an email and an in-app notification when anything changes (approved, rejected, needs action)".
//   * every real change that needs the merchant is e-mailed ONCE (first insert of its dedupe key), never again on a re-delivery
//   * the approvals are coalesced: per-template approvals stay in the app, two milestone mails go out
//   * in-app-only kinds (sending_paused, per-template approvals, informational alerts) never send a mail
//   * a failing mail never blocks the state change and is attempted at most 3 times in all
// No DB, no network: in-memory models, fakeGraph, fakeResend.
const sr = require('../../../shared/onboarding/statusRefresh');
const wh = require('../../../shared/onboarding/webhookEvents');
const starter = require('../../../shared/onboarding/starterTemplates');
const sendGate = require('../../../shared/onboarding/sendGate');
const { createNotifications } = require('../../../shared/onboarding/notifications');
const { createFakeSend } = require('../_fixtures');
const { createFakeModel } = require('./_b0Store');
const { makeEnv, flush, WS } = require('./_b1dHelpers');
const kit = require('./_b1eKit');

const OWNER = 'owner@example.test';
const T = 1739321024;
const ENGLISH_KEYS = ['welcome_optin', 'promotion_weekend', 'promotion_new_arrival', 'comeback', 'points_balance', 'order_confirmation', 'booking_confirmation'];

let savedFrontend;
beforeEach(() => { savedFrontend = process.env.FRONTEND_URL; process.env.FRONTEND_URL = 'https://app.example.test'; jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); if (savedFrontend === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = savedFrontend; });

/** Real notification store + the real e-mail module on the fake provider. */
function mailWorld({ failFirst = 0, recipient = { to: OWNER, language: 'en' }, now = () => new Date('2026-10-15T09:00:00Z') } = {}) {
  const model = createFakeModel({ unique: [['workspaceId', 'dedupeKey']], defaults: { readAt: null, emailAttempts: 0 } });
  const mail = createFakeSend({ failFirst, failWith: { code: 'RESEND_DOWN', statusCode: 503 } });
  const notifications = createNotifications({ model, emailDeps: { send: mail.send, resolveRecipient: async () => recipient }, now });
  return { model, mail, notifications, notify: (args) => notifications.notify(args) };
}
const subjects = (w) => w.mail.sent.map((m) => m.subject);
const settle = () => flush(12);

describe('statusRefresh: one e-mail per real change, none on a repeat', () => {
  function world(opts) {
    const env = makeEnv();
    const w = mailWorld(opts);
    env.deps.notifications = w.notifications;
    return { env, w };
  }

  test('verification, messaging limit and display name (approved) each send one mail to the owner, in the merchant language', async () => {
    const { env, w } = world();
    env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' }, displayName: { nameStatusRaw: 'PENDING_REVIEW', mapped: 'waiting', newName: 'Acme Cafe' } });
    env.g.setVerification('verified');
    env.g.setTier('TIER_2K');
    env.g.setNameStatus('APPROVED');
    await sr.refreshConnection(WS, env.deps);
    await sr.refreshConnection(WS, env.deps);
    await settle();
    expect(subjects(w).sort()).toEqual(['Meta decided on your display name', 'Your business verification was updated', 'Your messaging limit changed']);
    for (const m of w.mail.sent) {
      expect(m.to).toBe(OWNER);
      expect(m.html).toContain('href="https://app.example.test/setup/approvals"');
    }
    expect(w.model.rows.map((r) => r.kind).sort()).toEqual(['display_name_decided', 'messaging_limit_changed', 'verification_changed']);
    expect(w.model.rows.every((r) => r.emailAttempts === 1 && r.emailSentAt instanceof Date)).toBe(true);
    expect(w.mail.findPhoneLike()).toEqual([]);

    const ar = world({ recipient: { to: OWNER, language: 'ar' } });
    ar.env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' } });
    ar.env.g.setVerification('verified');
    await sr.refreshConnection(WS, ar.env.deps);
    await settle();
    expect(subjects(ar.w)).toEqual(['تم تحديث التحقق من نشاطك التجاري']);
    expect(ar.w.mail.sent[0].html).toContain('dir="rtl"');
  });

  test('a declined display name is ONE mail (the in-app account alert for the same cause has no mail)', async () => {
    const { env, w } = world();
    env.seedConn();
    env.g.setNameStatus('DECLINED');
    await sr.refreshConnection(WS, env.deps);
    await sr.refreshConnection(WS, env.deps);
    await settle();
    expect(w.model.rows.map((r) => r.kind).sort()).toEqual(['account_alert', 'display_name_decided']);
    expect(subjects(w)).toEqual(['Meta decided on your display name']);
    expect(w.mail.sent[0].text).toContain('Status: Needs you');
    expect(w.model.rows.find((r) => r.kind === 'account_alert').emailAttempts).toBe(0);
  });

  test('a cause that needs the merchant (token about to expire) is an alert mail; the SAME cause again after a recovery is announced again (R7-04); a repeat refresh adds nothing', async () => {
    const { env, w } = world();
    env.seedConn();
    for (const days of [3, 3, 30, 3, 3]) { env.clock.advance(60 * 1000); env.g.setTokenExpiry(env.clock.sec() + days * 86400); await sr.refreshConnection(WS, env.deps); }
    await settle();
    expect(subjects(w)).toEqual(['A WhatsApp account alert', 'A WhatsApp account alert']);
  });

  test('a failing provider never blocks the state change; at most 3 attempts in all, then it stops', async () => {
    const { env, w } = world({ failFirst: Infinity });
    env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' } });
    env.g.setVerification('verified');
    const snap = await sr.refreshConnection(WS, env.deps);
    await settle();
    expect(snap.verification.mapped).toBe('done');
    expect(env.row().verification.mapped).toBe('done'); // stored
    expect(w.model.rows).toHaveLength(1); // the in-app notification exists
    expect(w.model.rows[0]).toMatchObject({ emailError: 'RESEND_DOWN', emailAttempts: 1 });
    expect(w.mail.sent).toHaveLength(0);
    expect((await w.notifications.retryEmails({})).attempted).toBe(1);
    expect((await w.notifications.retryEmails({})).attempted).toBe(1);
    expect(await w.notifications.retryEmails({})).toEqual({ attempted: 0, sent: 0 });
    expect(w.mail.attempts).toBe(3);
    // the next refresh changes nothing and mails nothing
    await sr.refreshConnection(WS, env.deps);
    await settle();
    expect(w.mail.attempts).toBe(3);
  });

  test('a provider that recovers on the first retry delivers exactly one mail', async () => {
    const { env, w } = world({ failFirst: 1 });
    env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' } });
    env.g.setVerification('verified');
    await sr.refreshConnection(WS, env.deps);
    await settle();
    expect(w.mail.sent).toHaveLength(0);
    expect(await w.notifications.retryEmails({})).toEqual({ attempted: 1, sent: 1 });
    expect(await w.notifications.retryEmails({})).toEqual({ attempted: 0, sent: 0 });
    expect(subjects(w)).toEqual(['Your business verification was updated']);
    expect(w.model.rows[0].emailSentAt).toBeInstanceOf(Date);
  });

  test('a phone-only account (no e-mail address) gets the in-app notification and no mail attempt, and nothing is retried', async () => {
    const { env, w } = world({ recipient: null });
    env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' } });
    env.g.setVerification('verified');
    await sr.refreshConnection(WS, env.deps);
    await settle();
    expect(w.model.rows).toHaveLength(1);
    expect(w.model.rows[0].emailError).toBe('skipped:no_recipient');
    expect(w.mail.attempts).toBe(0);
    expect(await w.notifications.retryEmails({})).toEqual({ attempted: 0, sent: 0 });
  });
});

describe('webhook account alerts: only warning and action are e-mailed', () => {
  let savedFlag;
  beforeEach(() => { savedFlag = process.env.ONBOARDING_FLOW; process.env.ONBOARDING_FLOW = 'on'; });
  afterEach(() => { if (savedFlag === undefined) delete process.env.ONBOARDING_FLOW; else process.env.ONBOARDING_FLOW = savedFlag; });
  const entryFor = (wabaId, info, time = T) => ({ id: wabaId, time, changes: [{ field: 'account_alerts', value: { entity_type: 'BUSINESS', entity_id: 'B1', alert_info: info } }] });
  const req = (entries) => ({ body: { object: 'whatsapp_business_account', entry: entries }, metaSignature: 'valid' });

  test('CRITICAL and WARNING alerts send a mail each, an informational one stays in the app; a repeat delivery sends nothing', async () => {
    const wabaId = '1100000000000001';
    const env = makeEnv({ graph: { wabaId, phoneId: '1100000000000002' } });
    env.seedConn({ ids: { wabaId, phoneNumberId: '1100000000000002', businessId: 'B1' } });
    const w = mailWorld();
    const ev = wh.createWebhookEvents({ ...env.deps, notifications: w.notifications, sync: true, platformWabaId: null, platformPhoneId: null, starterTemplates: {} });
    const critical = entryFor(wabaId, { alert_severity: 'CRITICAL', alert_status: 'ACTIVE', alert_type: 'OBA_REJECTED' }, T);
    await ev.intercept(req([critical]));
    await ev.intercept(req([JSON.parse(JSON.stringify(critical))])); // Meta re-delivers the same entry
    await ev.intercept(req([entryFor(wabaId, { alert_severity: 'WARNING', alert_status: 'ACTIVE', alert_type: 'PROFILE_PICTURE_LOST' }, T + 10)]));
    await ev.intercept(req([entryFor(wabaId, { alert_severity: 'INFORMATIONAL', alert_status: 'ACTIVE', alert_type: 'OBA_APPROVED' }, T + 20)]));
    await ev.intercept(req([entryFor(wabaId, { alert_severity: 'CRITICAL', alert_status: 'NONE', alert_type: 'OBA_REJECTED' }, T + 30)])); // cleared: no notification at all
    await settle();
    expect(w.model.rows.map((r) => [r.kind, r.severity]).sort()).toEqual([['account_alert', 'action'], ['account_alert', 'info'], ['account_alert', 'warning']]);
    expect(subjects(w)).toEqual(['A WhatsApp account alert', 'A WhatsApp account alert']);
    expect(w.model.rows.find((r) => r.severity === 'info').emailAttempts).toBe(0);
  });
});

describe('starter templates: approvals are coalesced into two mails', () => {
  async function world(opts) {
    const k = kit.makeWorld(opts);
    const w = mailWorld();
    k.deps.notify = w.notify;
    await starter.seedStarterTemplates(kit.WS, k.deps);
    for (let i = 0; i < 4; i += 1) await starter.submitQueued({ workspaceId: kit.WS, max: 5 }, k.deps);
    const rowOf = (key, language = 'en') => k.Template.rows.find((r) => r.key === key && r.language === language);
    const decide = (key, language, statusRaw, extra) => starter.applyTemplateStatusUpdate({ workspaceId: kit.WS, templateId: rowOf(key, language).metaTemplateId, statusRaw, ...(extra || {}) }, k.deps);
    return { k, w, decide };
  }

  test('7 approvals = 9 in-app notifications and exactly 2 mails (first template approved, all approved), none of them naming a template', async () => {
    const { w, decide } = await world();
    for (const key of ENGLISH_KEYS) { await decide(key, 'en', 'APPROVED'); await settle(); }
    expect(w.model.rows.filter((r) => r.kind === 'template_approved')).toHaveLength(9); // 7 per template + 2 milestones
    expect(subjects(w)).toEqual(['Your first message template was approved', 'Your starter message templates are approved']);
    expect(w.mail.sent[0].text).toContain('Approved: 1 of 7');
    expect(w.mail.sent[1].text).toContain('Approved: 7 of 7');
    w.mail.assertNoLeak(['Welcome', 'Weekend offer', 'wf_439011', 'promotion_weekend']);
    expect(w.mail.findPhoneLike()).toEqual([]);
    expect(w.model.rows.filter((r) => /^template:/.test(r.dedupeKey)).every((r) => r.emailAttempts === 0)).toBe(true);
    // a re-delivery of every decision (webhook after poll) adds no row and no mail
    const rows = w.model.rows.length;
    for (const key of ENGLISH_KEYS) { await decide(key, 'en', 'APPROVED'); await settle(); }
    expect(w.model.rows).toHaveLength(rows);
    expect(w.mail.sent).toHaveLength(2);
    // ... and so does a pause followed by a new approval of the same template (same template id + status = same key)
    await decide('comeback', 'en', 'PAUSED');
    await decide('comeback', 'en', 'APPROVED');
    await settle();
    expect(w.mail.sent).toHaveLength(2);
  });

  test('a rejection is mailed once per template id (with its reason), a re-delivery is not', async () => {
    const { w, decide } = await world();
    await decide('comeback', 'en', 'REJECTED', { reason: 'INVALID_FORMAT' });
    await decide('comeback', 'en', 'REJECTED', { reason: 'INVALID_FORMAT' });
    await decide('points_balance', 'en', 'REJECTED', { reason: 'ABUSIVE_CONTENT' });
    await settle();
    expect(subjects(w)).toEqual(['A message template was rejected', 'A message template was rejected']);
    expect(w.mail.sent[0].text).toContain('Reason: INVALID_FORMAT');
    expect(w.mail.sent[1].text).toContain('Reason: ABUSIVE_CONTENT');
    w.mail.assertNoLeak(['Come-back offer', 'comeback']);
  });

  test('the failing mail of a milestone never blocks the approval and is attempted at most 3 times', async () => {
    const k = kit.makeWorld();
    const w = mailWorld({ failFirst: Infinity });
    k.deps.notify = w.notify;
    await starter.seedStarterTemplates(kit.WS, k.deps);
    await starter.submitQueued({ workspaceId: kit.WS, max: 5 }, k.deps);
    const id = k.Template.rows.find((r) => r.key === 'comeback' && r.language === 'en').metaTemplateId;
    const r = await starter.applyTemplateStatusUpdate({ workspaceId: kit.WS, templateId: id, statusRaw: 'APPROVED' }, k.deps);
    await settle();
    expect(r).toMatchObject({ updated: true, changed: true, status: 'APPROVED' });
    expect(k.Template.rows.find((x) => x.key === 'comeback' && x.language === 'en').metaStatus).toBe('APPROVED');
    const milestone = w.model.rows.find((x) => x.dedupeKey === 'templates:first_approved');
    expect(milestone).toMatchObject({ emailError: 'RESEND_DOWN', emailAttempts: 1 });
    await w.notifications.retryEmails({});
    await w.notifications.retryEmails({});
    expect(await w.notifications.retryEmails({})).toEqual({ attempted: 0, sent: 0 });
    expect(w.mail.attempts).toBe(3);
  });
});

describe('in-app only kinds never send a mail', () => {
  test('sending_paused (the visible trail of a blocked send) is in the app only', async () => {
    const w = mailWorld();
    const flow = { workspaceId: WS };
    const getGateState = async () => ({ enrolled: true, sub: { state: 'past_due', source: 'stripe' }, conn: { status: 'connected', needsReconnect: false }, legacyPolicy: 'block' });
    process.env.ONBOARDING_FLOW = 'on';
    try {
      expect(await sendGate.flowBlocked(flow, { getGateState, notify: w.notify, track: async () => {}, now: () => new Date('2026-10-15T09:00:00Z') })).toBe(true);
    } finally { delete process.env.ONBOARDING_FLOW; }
    await settle();
    expect(w.model.rows.map((r) => r.kind)).toEqual(['sending_paused']);
    expect(w.mail.attempts).toBe(0);
    expect(w.model.rows[0].emailAttempts).toBe(0);
  });
});
