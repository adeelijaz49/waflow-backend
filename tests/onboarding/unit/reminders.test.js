'use strict';
const fs = require('fs');
const path = require('path');
const reminders = require('../../../shared/onboarding/reminders');
const notifications = require('../../../shared/onboarding/notifications');
const email = require('../../../shared/onboarding/email');
const { createFakeSend, fixedClock } = require('../_fixtures');
const { createFakeModel } = require('./_b0Store');

const H = 60 * 60 * 1000;
const D = 24 * H;
const T0 = new Date('2026-10-01T09:00:00Z');
let ws = 0;
const wsId = () => `507f1f77bcf86cd7994390${String(10 + (ws += 1)).padStart(2, '0')}`;

function row(over = {}) {
  return {
    workspaceId: wsId(), enrolled: true,
    subscription: { state: 'active' },
    progress: { status: 'paused_number', lastActivityAt: T0 },
    number: { path: 'B', numberReady: false, pausedAt: T0, reminderCount: 0 },
    ...over,
  };
}
function setup(rows, notifyImpl) {
  const OnboardingState = createFakeModel();
  const seeded = rows.map((r) => OnboardingState.seed(r));
  const notify = jest.fn(notifyImpl || (async (a) => ({ created: true, notification: { id: 'n', kind: a.kind }, emailPromise: null })));
  return { OnboardingState, notify, seeded, deps: { OnboardingState, notify } };
}
const at = (ms) => ({ now: new Date(T0.getTime() + ms) });
const rowOf = (OnboardingState, i = 0) => OnboardingState.rows[i];

describe('schedule: +24 h, +3 d, +7 d, then stop', () => {
  test('nothing before 24 h; reminder 1 at +24 h with e-mail + in-app and the right key', async () => {
    const { OnboardingState, notify, deps, seeded } = setup([row()]);
    expect(await reminders.runPathBReminders(at(24 * H - 1), deps)).toMatchObject({ sent: 0, checked: 1 });
    expect(notify).not.toHaveBeenCalled();
    const r = await reminders.runPathBReminders(at(24 * H), deps);
    expect(r).toMatchObject({ sent: 1, errors: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      workspaceId: seeded[0].workspaceId, kind: 'pathb_reminder', dedupeKey: 'pathb_reminder:1', params: { n: 1 }, email: true, actionPath: '/setup',
    });
    expect(rowOf(OnboardingState).number.reminderCount).toBe(1);
    expect(new Date(rowOf(OnboardingState).number.lastReminderAt).getTime()).toBe(T0.getTime() + 24 * H);
  });
  test('full sequence 24 h -> 3 d -> 7 d, then never again', async () => {
    const { OnboardingState, notify, deps } = setup([row()]);
    const run = (ms) => reminders.runPathBReminders(at(ms), deps);
    await run(24 * H); await run(2 * D); expect(notify).toHaveBeenCalledTimes(1);
    await run(3 * D); expect(notify).toHaveBeenCalledTimes(2);
    await run(6 * D); expect(notify).toHaveBeenCalledTimes(2);
    await run(7 * D); expect(notify).toHaveBeenCalledTimes(3);
    await run(8 * D); await run(30 * D); await run(365 * D);
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls.map((c) => c[0].dedupeKey)).toEqual(['pathb_reminder:1', 'pathb_reminder:2', 'pathb_reminder:3']);
    expect(rowOf(OnboardingState).number.reminderCount).toBe(3);
  });
  test('a missed scheduler is not a burst: after 10 idle days reminders still go out one per day at most', async () => {
    const { notify, deps } = setup([row()]);
    const run = (ms) => reminders.runPathBReminders(at(ms), deps);
    await run(10 * D); expect(notify).toHaveBeenCalledTimes(1);
    await run(10 * D); await run(10 * D + 10 * 60 * 1000); expect(notify).toHaveBeenCalledTimes(1);
    await run(11 * D); expect(notify).toHaveBeenCalledTimes(2);
    await run(12 * D); expect(notify).toHaveBeenCalledTimes(3);
    await run(13 * D); expect(notify).toHaveBeenCalledTimes(3);
  });
  test('the same run twice at the same time is idempotent (count + dedupeKey)', async () => {
    const { notify, deps } = setup([row()]);
    await reminders.runPathBReminders(at(25 * H), deps);
    await reminders.runPathBReminders(at(25 * H), deps);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  test('uses deps.now when opts.now is absent and pausedAt falls back to progress.lastActivityAt', async () => {
    const { notify, deps } = setup([row({ number: { path: 'B', numberReady: false, reminderCount: 0 } })]);
    await reminders.runPathBReminders({}, { ...deps, now: () => new Date(T0.getTime() + 2 * D) });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('who gets a reminder', () => {
  test('stops on numberReady (status resumed, or the flag set while still listed)', async () => {
    const { OnboardingState, notify, deps } = setup([row(), row({ number: { path: 'B', numberReady: true, pausedAt: T0, reminderCount: 0 } })]);
    OnboardingState.rows[0].progress.status = 'in_progress';
    await reminders.runPathBReminders(at(30 * D), deps);
    expect(notify).not.toHaveBeenCalled();
  });
  test('skips un-enrolled, cancelled, invalid-id and no-timestamp rows; processes the rest', async () => {
    const good = row();
    const { notify, deps } = setup([
      row({ enrolled: false }), row({ subscription: { state: 'cancelled' } }), row({ workspaceId: 'zzz' }),
      row({ number: { path: 'B', reminderCount: 0 }, progress: { status: 'paused_number' } }), good,
    ]);
    const r = await reminders.runPathBReminders(at(2 * D), deps);
    expect(r).toMatchObject({ checked: 5, sent: 1, skipped: 4 });
    expect(notify.mock.calls[0][0].workspaceId).toBe(good.workspaceId);
  });
  test('only paused_number rows are read (single-field filter)', async () => {
    const { OnboardingState, notify, deps } = setup([row({ progress: { status: 'in_progress', lastActivityAt: T0 } }), row({ progress: { status: 'waiting_meta', lastActivityAt: T0 } })]);
    const r = await reminders.runPathBReminders(at(30 * D), deps);
    expect(r.checked).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect(OnboardingState.calls.find((c) => c[0] === 'find')[1]).toEqual({ 'progress.status': 'paused_number' });
  });
  test('bounded per run: limit caps the number of rows examined', async () => {
    const { notify, deps } = setup([row(), row(), row(), row(), row()]);
    const r = await reminders.runPathBReminders({ ...at(2 * D), limit: 2 }, deps);
    expect(r.checked).toBe(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe('never throws, never loses a reminder silently', () => {
  test('a database failure returns a result', async () => {
    const { OnboardingState, deps } = setup([row()]);
    OnboardingState.failWith = new Error('db down');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(reminders.runPathBReminders(at(2 * D), deps)).resolves.toMatchObject({ sent: 0, errors: 1 });
    warn.mockRestore();
  });
  test('a throwing notify is an error for that row only and the reminder is retried next run', async () => {
    let calls = 0;
    const { OnboardingState, deps } = setup([row(), row()], async (a) => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return { created: true, notification: { id: 'n', kind: a.kind }, emailPromise: null };
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r1 = await reminders.runPathBReminders(at(2 * D), deps);
    expect(r1).toMatchObject({ sent: 1, errors: 1 });
    expect(rowOf(OnboardingState, 0).number.reminderCount).toBe(0);
    expect(rowOf(OnboardingState, 1).number.reminderCount).toBe(1);
    const r2 = await reminders.runPathBReminders(at(2 * D + H), deps);
    expect(r2.sent).toBe(1);
    expect(rowOf(OnboardingState, 0).number.reminderCount).toBe(1);
    warn.mockRestore();
  });
  test('notify says "not recorded" -> not advanced; notify says "already exists" -> advanced silently', async () => {
    const a = setup([row()], async () => ({ created: false, notification: null, emailPromise: null }));
    expect(await reminders.runPathBReminders(at(2 * D), a.deps)).toMatchObject({ sent: 0, errors: 1 });
    expect(rowOf(a.OnboardingState).number.reminderCount).toBe(0);
    const b = setup([row()], async () => ({ created: false, notification: { id: 'x' }, emailPromise: null }));
    expect(await reminders.runPathBReminders(at(2 * D), b.deps)).toMatchObject({ sent: 0, errors: 0 });
    expect(rowOf(b.OnboardingState).number.reminderCount).toBe(1);
  });
  test('awaits the e-mail promise so a run is deterministic, and a rejected one cannot break it', async () => {
    let sentMail = false;
    const { deps } = setup([row(), row()], async (a) => ({
      created: true, notification: { id: 'n', kind: a.kind },
      emailPromise: a.workspaceId.endsWith('11') ? Promise.reject(new Error('x')) : new Promise((resolve) => setTimeout(() => { sentMail = true; resolve({ sent: true }); }, 20)),
    }));
    const r = await reminders.runPathBReminders(at(2 * D), deps);
    expect(r.sent).toBe(2);
    expect(sentMail).toBe(true);
  });
  test('exported schedule constants', () => {
    expect(reminders.OFFSETS_MS).toEqual([D, 3 * D, 7 * D]);
    expect(reminders.MAX_REMINDERS).toBe(3);
  });
});

describe('end to end with the real notifications + e-mail modules (fake model, fake Resend)', () => {
  function world(rows) {
    const OnboardingState = createFakeModel();
    rows.forEach((r) => OnboardingState.seed(r));
    const model = createFakeModel({ unique: [['workspaceId', 'dedupeKey']], defaults: { readAt: null, emailAttempts: 0 } });
    const mail = createFakeSend();
    const clock = fixedClock(T0);
    const n = notifications.createNotifications({
      model, email, now: () => clock.now(),
      emailDeps: { send: mail.send, resolveRecipient: async () => ({ to: 'owner@example.test', language: 'en' }) },
    });
    return { OnboardingState, model, mail, clock, deps: { OnboardingState, notify: n.notify } };
  }
  test('three reminders = three in-app rows + three e-mails, nothing after; no phone/token in any mail', async () => {
    const w = world([row()]);
    for (const ms of [24 * H, 3 * D, 7 * D, 8 * D, 20 * D]) await reminders.runPathBReminders(at(ms), w.deps);
    expect(w.model.rows.map((r) => r.dedupeKey)).toEqual(['pathb_reminder:1', 'pathb_reminder:2', 'pathb_reminder:3']);
    expect(w.model.rows.every((r) => r.kind === 'pathb_reminder' && r.emailSentAt instanceof Date)).toBe(true);
    expect(w.mail.sent).toHaveLength(3);
    expect(w.mail.sent.every((m) => m.subject === 'Come back when your number is ready')).toBe(true);
    expect(w.mail.findPhoneLike()).toEqual([]);
  });
  test('two instances racing: one notification, one mail, the counter advances once', async () => {
    const w = world([row()]);
    const [a, b] = await Promise.all([reminders.runPathBReminders(at(25 * H), w.deps), reminders.runPathBReminders(at(25 * H), w.deps)]);
    expect(a.sent + b.sent).toBe(1);
    expect(w.model.rows).toHaveLength(1);
    expect(w.mail.sent).toHaveLength(1);
    expect(w.OnboardingState.rows[0].number.reminderCount).toBe(1);
  });
  test('a phone-only merchant (no e-mail) still gets the in-app reminder', async () => {
    const OnboardingState = createFakeModel();
    OnboardingState.seed(row());
    const model = createFakeModel({ unique: [['workspaceId', 'dedupeKey']], defaults: { readAt: null, emailAttempts: 0 } });
    const mail = createFakeSend();
    const n = notifications.createNotifications({ model, email, emailDeps: { send: mail.send, resolveRecipient: async () => null } });
    const r = await reminders.runPathBReminders(at(25 * H), { OnboardingState, notify: n.notify });
    expect(r.sent).toBe(1);
    expect(model.rows).toHaveLength(1);
    expect(mail.attempts).toBe(0);
  });
});

describe('never through WhatsApp', () => {
  test('the module neither requires nor calls any WhatsApp sender', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../shared/onboarding/reminders.js'), 'utf8');
    expect(src).not.toMatch(/require\([^)]*(whatsapp|waPost|metaClient|testMessage|sendGate)/i);
    expect(src).not.toMatch(/sendTemplateMessage|graph\.facebook|waPost/i);
  });
});
