'use strict';
// Path B reminders (DB design 7.1, spec step 2.3): a merchant who has no WhatsApp number yet is
// "paused" (progress.status === 'paused_number'). While paused they get a reminder at +24 h, +3 d and
// +7 d after the pause (number.reminderCount max 3, number.lastReminderAt, notification dedupeKey
// 'pathb_reminder:<n>'), by e-mail AND in the app, NEVER through WhatsApp (they have no number).
// Reminders stop when numberReady is set (the status leaves paused_number). Called by the
// onboarding scheduler (B1-d) lazily; bounded per run; never throws.
const config = require('./config');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Offsets from the pause for reminder 1, 2, 3. */
const OFFSETS_MS = Object.freeze([DAY_MS, 3 * DAY_MS, 7 * DAY_MS]);
const MAX_REMINDERS = OFFSETS_MS.length;
/** Even when a run was missed for days, two reminders are never sent closer than this. */
const MIN_GAP_MS = DAY_MS;
const DEFAULT_LIMIT = 200;
const ID_RE = /^[0-9a-f]{24}$/i;

function toMs(value) {
  if (value === undefined || value === null) return NaN;
  if (typeof value === 'number') return value;
  if (typeof value === 'function') return toMs(value());
  return new Date(value).getTime();
}

async function resolveQuery(q) {
  let query = q;
  if (query && typeof query.lean === 'function') query = query.lean();
  return query;
}

/**
 * Send the reminders that are due. Never throws.
 * @param {{now?:Date|number, limit?:number}} [opts]
 * @param {{OnboardingState?:object, notify?:Function, now?:()=>Date}} [deps]
 * @returns {Promise<{sent:number, checked:number, skipped:number, errors:number}>}
 */
async function runPathBReminders(opts, deps) {
  const o = opts || {};
  const d = deps || {};
  const result = { sent: 0, checked: 0, skipped: 0, errors: 0 };
  try {
    const nowMs = [toMs(o.now), toMs(d.now)].find((n) => Number.isFinite(n)) ?? Date.now();
    const now = new Date(nowMs);
    const limit = Math.max(1, Math.min(500, Number(o.limit) || DEFAULT_LIMIT));
    const State = d.OnboardingState || require('../../models/OnboardingState');
    const notify = d.notify || require('./notifications').notify;

    // Single-field filter (index {progress.status}); the rest is decided in memory (Cosmos-safe).
    const rows = await resolveQuery(State.find({ 'progress.status': 'paused_number' })
      .select('workspaceId enrolled progress number subscription').limit(limit)) || [];

    for (const row of rows) {
      result.checked += 1;
      try {
        const workspaceId = String(row.workspaceId || '');
        const num = row.number || {};
        const count = Number(num.reminderCount) || 0;
        const subState = row.subscription && row.subscription.state;
        if (!ID_RE.test(workspaceId) || row.enrolled === false || num.numberReady
          || !row.progress || row.progress.status !== 'paused_number'
          || subState === 'cancelled' || count >= MAX_REMINDERS) { result.skipped += 1; continue; }

        const pausedMs = toMs(num.pausedAt || (row.progress && row.progress.lastActivityAt));
        if (!Number.isFinite(pausedMs)) { result.skipped += 1; continue; }
        let dueMs = pausedMs + OFFSETS_MS[count];
        const lastMs = toMs(num.lastReminderAt);
        if (Number.isFinite(lastMs)) dueMs = Math.max(dueMs, lastMs + MIN_GAP_MS);
        if (nowMs < dueMs) { result.skipped += 1; continue; }

        const n = count + 1;
        const r = await notify({
          workspaceId, kind: 'pathb_reminder', dedupeKey: `pathb_reminder:${n}`, params: { n },
          email: true, severity: 'info', actionPath: '/setup',
        });
        if (!r || (!r.created && !r.notification)) { result.errors += 1; continue; } // not recorded: retry next run
        if (r.emailPromise) await Promise.resolve(r.emailPromise).catch(() => {});

        // Claim the step; a second instance that notified the same key loses this conditional update.
        await State.updateOne({
          workspaceId, 'progress.status': 'paused_number', 'number.numberReady': { $ne: true },
          'number.reminderCount': count === 0 ? { $in: [0, null] } : count,
        }, { $set: { 'number.reminderCount': n, 'number.lastReminderAt': now } });
        if (r.created) result.sent += 1;
      } catch (err) {
        result.errors += 1;
        config.safeLog('warn', '[onboarding] path B reminder failed:', err && err.code ? err.code : '', err && err.message ? err.message : '');
      }
    }
  } catch (err) {
    result.errors += 1;
    config.safeLog('warn', '[onboarding] path B reminders failed:', err && err.code ? err.code : '', err && err.message ? err.message : '');
  }
  return result;
}

module.exports = { runPathBReminders, OFFSETS_MS, MAX_REMINDERS, MIN_GAP_MS };
