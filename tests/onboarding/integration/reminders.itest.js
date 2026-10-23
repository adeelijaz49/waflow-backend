'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database (suffix) so suites in one jest run never see each other's data
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_remind`;
assertThrowawayDb();

// Path B reminders against a REAL (throwaway) mongod with the real notifications + e-mail modules and a
// fake Resend: +24 h / +3 d / +7 d then stop, e-mail plus in-app, bounded, race-safe. No deletes.
const mongoose = require('mongoose');
const reminders = require('../../../shared/onboarding/reminders');
const notifications = require('../../../shared/onboarding/notifications');
const email = require('../../../shared/onboarding/email');
const OnboardingState = require('../../../models/OnboardingState');
const OnboardingNotification = require('../../../models/OnboardingNotification');
const { createFakeSend } = require('../_fixtures');

const H = 60 * 60 * 1000;
const D = 24 * H;
const T0 = new Date('2026-10-01T09:00:00Z');
const oid = () => String(new mongoose.Types.ObjectId());
const at = (ms) => ({ now: new Date(T0.getTime() + ms) });

function world() {
  const mail = createFakeSend();
  const emailDeps = { send: mail.send, resolveRecipient: async () => ({ to: 'owner@example.test', language: 'en' }) };
  const notify = (args) => notifications.notify(args, { email, emailDeps });
  return { mail, deps: { notify } };
}
async function paused(over = {}) {
  const workspaceId = oid();
  await OnboardingState.create({
    workspaceId, enrolled: true,
    progress: { status: 'paused_number', currentStep: 2, lastActivityAt: T0 },
    number: { path: 'B', pausedAt: T0 },
    subscription: { state: 'active', source: 'admin' },
    ...over,
  });
  return workspaceId;
}
const stateOf = (ws) => OnboardingState.findOne({ workspaceId: ws }).lean();
const notesOf = (ws) => OnboardingNotification.find({ workspaceId: ws, kind: 'pathb_reminder' }).lean();

let warn;
beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([OnboardingState.init(), OnboardingNotification.init()]);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(async () => { warn.mockRestore(); await mongoose.disconnect(); });
// Every test starts with a clean slate WITHOUT deleting anything: rows of earlier tests are un-enrolled (an update), so a sweep only sees this test's workspaces.
beforeEach(async () => { await OnboardingState.updateMany({}, { $set: { enrolled: false } }); });

describe('Path B reminders on real documents', () => {
  test('the schema default reminderCount is 0 and the sequence is +24 h, +3 d, +7 d, then nothing', async () => {
    const { mail, deps } = world();
    const ws = await paused();
    expect((await stateOf(ws)).number.reminderCount).toBe(0);
    const sent = [];
    for (const ms of [23 * H, 24 * H, 2 * D, 3 * D, 6 * D, 7 * D, 8 * D, 40 * D]) {
      const r = await reminders.runPathBReminders(at(ms), deps);
      sent.push(r.sent);
    }
    expect(sent).toEqual([0, 1, 0, 1, 0, 1, 0, 0]);
    const rows = await notesOf(ws);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(['pathb_reminder:1', 'pathb_reminder:2', 'pathb_reminder:3']);
    expect(rows.every((r) => r.kind === 'pathb_reminder' && r.actionPath === '/setup' && r.emailSentAt instanceof Date)).toBe(true);
    const st = await stateOf(ws);
    expect(st.number.reminderCount).toBe(3);
    expect(new Date(st.number.lastReminderAt).getTime()).toBe(T0.getTime() + 7 * D);
    const mine = mail.sent;
    expect(mine).toHaveLength(3);
    expect(mine.every((m) => m.subject === 'Come back when your number is ready' && m.to === 'owner@example.test')).toBe(true);
    expect(mail.findPhoneLike()).toEqual([]);
  });
  test('stops as soon as the number is ready', async () => {
    const { mail, deps } = world();
    const ws = await paused();
    await reminders.runPathBReminders(at(25 * H), deps);
    expect(mail.sent).toHaveLength(1);
    await OnboardingState.updateOne({ workspaceId: ws }, { $set: { 'number.numberReady': true, 'progress.status': 'in_progress' } });
    await reminders.runPathBReminders(at(30 * D), deps);
    expect(mail.sent).toHaveLength(1);
    expect((await notesOf(ws))).toHaveLength(1);
  });
  test('numberReady set while the status still says paused: no reminder either', async () => {
    const { mail, deps } = world();
    const ws = await paused({ number: { path: 'B', pausedAt: T0, numberReady: true } });
    await reminders.runPathBReminders(at(30 * D), deps);
    expect(mail.sent).toHaveLength(0);
    expect(await notesOf(ws)).toHaveLength(0);
  });
  test('two instances sweeping at the same moment: one notification, one mail, counter advances once', async () => {
    const { mail, deps } = world();
    const ws = await paused();
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => reminders.runPathBReminders(at(25 * H), deps)));
    expect(a.sent + b.sent + c.sent).toBe(1);
    expect(await notesOf(ws)).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
    expect((await stateOf(ws)).number.reminderCount).toBe(1);
  });
  test('un-enrolled, cancelled, in-progress and other-status workspaces are left alone', async () => {
    const { mail, deps } = world();
    const unenrolled = await paused({ enrolled: false });
    const cancelled = await paused({ subscription: { state: 'cancelled' } });
    const resumed = await paused({ progress: { status: 'in_progress', currentStep: 2, lastActivityAt: T0 } });
    const waiting = await paused({ progress: { status: 'waiting_meta', currentStep: 4, lastActivityAt: T0 } });
    await reminders.runPathBReminders(at(30 * D), deps);
    for (const ws of [unenrolled, cancelled, resumed, waiting]) expect(await notesOf(ws)).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });
  test('a phone-only merchant (no e-mail) still gets the in-app reminder and no mail is attempted', async () => {
    const mail = createFakeSend();
    const emailDeps = { send: mail.send, resolveRecipient: async () => null };
    const ws = await paused({ number: { path: 'B', pausedAt: new Date(T0.getTime() - 400 * D) } });
    await reminders.runPathBReminders({ now: new Date(T0.getTime() + 10 * D), limit: 500 }, { notify: (a) => notifications.notify(a, { email, emailDeps }) });
    expect(await notesOf(ws)).toHaveLength(1);
    expect(mail.attempts).toBe(0);
  });
  test('bounded per run: limit caps the rows examined', async () => {
    const { deps } = world();
    await paused(); await paused(); await paused();
    const r = await reminders.runPathBReminders({ ...at(1000 * D), limit: 1 }, deps);
    expect(r.checked).toBe(1);
  });
  test('what a reminder leaves behind: one in-app row and one e-mail, nothing else', async () => {
    const { mail, deps } = world();
    const ws = await paused();
    const r = await reminders.runPathBReminders(at(25 * H), deps);
    expect(r).toMatchObject({ sent: 1, errors: 0 });
    expect(await notesOf(ws)).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
    expect(Object.keys((await stateOf(ws)).number).sort()).toEqual(expect.arrayContaining(['lastReminderAt', 'reminderCount']));
  });
});
