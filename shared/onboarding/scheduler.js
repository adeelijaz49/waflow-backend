'use strict';
// Background upkeep of the WhatsApp onboarding flow (DB design 6.5). A copy of the proven recipe of
// shared/localization/scheduler.js: fixed-_id SchedulerLock (TTL = interval - 30 s, an efficiency guard only;
// correctness comes from the atomic claims inside every sweep), dependency injection through realDeps(),
// unref()'d timer, nothing at require time. startOnboardingScheduler() returns null and starts no timer
// when ONBOARDING_FLOW is not 'on' (the flag is read at start: an Azure env change restarts the app).
//
// One tick runs these sweeps, sequential, each bounded, each through a LAZILY required owner module and each
// caught on its own (a missing or throwing module costs one logged line, never the tick):
//   1 connections   WhatsAppConnection in connected|needs_attention|waba_only|connecting with nextCheckAt <= now
//                   (single-field sort on nextCheckAt, 20 per query, at most 20 refreshes per tick), only for
//                   workspaces whose subscription is active|past_due; the others are deferred 1 h (cancelled /
//                   none are never polled and resume within the hour of a reactivation)
//   2 templates     starterTemplates.pollStatuses({ now }) once per tick (status poll + queue submission by B1-e); an older
//                   module without it falls back to submitQueued per connected workspace (25 per tick, id cursor)
//   3 pathB         reminders.runPathBReminders
//   4 emails        notifications.retryEmails
//   5 resume        connect.resumeConnect once per stuck 'connecting' attempt (per process)
//   6 billing       billing.reconcileSweep
//   7 displayName   approvals.reRegisterDueNames (re-register with the stored PIN within 14 days of an approval)
const config = require('./config');

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const LOCK_ID = 'onboardingScheduler';
const LOCK_MARGIN_MS = 30 * 1000;
const MIN = 60 * 1000;
const POLL_PAGE = 20; // rows per query AND refreshes per tick
const POLL_PAGES = 5; // pages scanned per tick while skipping ineligible rows (so they never starve the others)
const DEFER_MS = 60 * MIN;
const FAILURE_RETRY_MS = 15 * MIN;
const TEMPLATE_PAGE = 25;
const RESUME_AFTER_MS = 2 * MIN;
const STEP_TIMEOUT_MS = 5 * MIN;
const POLLABLE = ['connected', 'needs_attention', 'waba_only', 'connecting'];
const ELIGIBLE_SUB_STATES = ['active', 'past_due'];
const TEMPLATE_POLL_EXPORTS = ['pollStatuses', 'pollPending', 'refreshStatuses'];

let schedulerHandle = null;
let templateCursor = null; // last connection _id handled by the template sweep (per process)
const resumed = new Set(); // `${workspaceId}:${attempt}` already resumed by this process

function realDeps() {
  return {
    SchedulerLock: () => require('../../models/SchedulerLock'),
    Connection: () => require('../../models/WhatsAppConnection'),
    statusRefresh: () => require('./statusRefresh'),
    state: () => require('./state'),
    starterTemplates: () => require('./starterTemplates'),
    reminders: () => require('./reminders'),
    notifications: () => require('./notifications'),
    connect: () => require('./connect'),
    billing: () => require('./billing'),
    approvals: () => require('./approvals'),
    enabled: () => config.enabled(),
    log: (...args) => config.safeLog('error', '[onboarding scheduler]', ...args),
    now: () => Date.now(),
    stepTimeoutMs: STEP_TIMEOUT_MS,
  };
}

const ms = (v) => {
  if (v === undefined || v === null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};
const nowOf = (deps) => { const v = deps.now(); return v instanceof Date ? v.getTime() : Number(v); };

// Classic Mongo TTL lock. Returns true when this process may sweep.
async function acquireLock(deps, intervalMs) {
  const SchedulerLock = deps.SchedulerLock();
  const now = new Date(nowOf(deps));
  const lockedUntil = new Date(now.getTime() + Math.max(intervalMs - LOCK_MARGIN_MS, 1000));
  const renewed = await SchedulerLock.findOneAndUpdate(
    { _id: LOCK_ID, lockedUntil: { $lt: now } },
    { $set: { lockedAt: now, lockedUntil } },
    { returnDocument: 'after' },
  );
  if (renewed) return true;
  try {
    await SchedulerLock.create({ _id: LOCK_ID, lockedAt: now, lockedUntil });
    return true;
  } catch (err) {
    if (err && err.code === 11000) return false; // another instance holds a live lock
    throw err;
  }
}

function loadModule(load, deps, name) {
  try {
    const mod = load();
    if (!mod) throw new Error('module not available');
    return mod;
  } catch (err) {
    deps.log(`${name} unavailable:`, err && err.message);
    return null;
  }
}

function withTimeout(promise, ms2, onTimeout) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => { onTimeout(); resolve(null); }, ms2);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function runStep(deps, name, fn) {
  try {
    const limit = Number.isFinite(deps.stepTimeoutMs) && deps.stepTimeoutMs > 0 ? deps.stepTimeoutMs : STEP_TIMEOUT_MS;
    return await withTimeout(Promise.resolve().then(fn), limit, () => deps.log(`${name} timed out after ${limit} ms`));
  } catch (err) {
    deps.log(`${name} failed:`, err && err.message);
    return null;
  }
}

async function eligible(deps, state, workspaceId) {
  try {
    const gs = await state.getGateState(String(workspaceId));
    return !!(gs && gs.enrolled && gs.sub && ELIGIBLE_SUB_STATES.includes(gs.sub.state));
  } catch (_) {
    return false;
  }
}

// ── 1. connections ──────────────────────────────────────────────────────────
async function sweepConnections(deps, t) {
  const Connection = deps.Connection();
  const sr = loadModule(deps.statusRefresh, deps, 'statusRefresh');
  const state = loadModule(deps.state, deps, 'state');
  const out = { scanned: 0, refreshed: 0, deferred: 0, failed: 0 };
  if (!sr || !state || typeof sr.refreshConnection !== 'function') return out;
  const seen = new Set();
  const due = new Date(t);

  const budget = () => out.refreshed + out.failed < POLL_PAGE;
  const handle = async (row) => {
    const id = String(row._id);
    if (seen.has(id)) return false;
    if (!budget()) return false;
    seen.add(id);
    out.scanned += 1;
    if (!(await eligible(deps, state, row.workspaceId))) {
      try { await Connection.updateOne({ _id: row._id }, { $set: { nextCheckAt: new Date(t + DEFER_MS) } }); } catch (_) { /* best effort */ }
      out.deferred += 1;
      return true;
    }
    try {
      await sr.refreshConnection(String(row.workspaceId), { throwOnFailure: false });
      out.refreshed += 1;
    } catch (err) {
      out.failed += 1;
      deps.log('refresh failed:', err && err.code, err && err.message);
      try { await Connection.updateOne({ _id: row._id }, { $set: { nextCheckAt: new Date(t + FAILURE_RETRY_MS) } }); } catch (_) { /* best effort */ }
    }
    return true;
  };

  for (let page = 0; page < POLL_PAGES && budget(); page += 1) {
    const rows = await Connection.find({ status: { $in: POLLABLE }, nextCheckAt: { $lte: due } }).sort({ nextCheckAt: 1 }).limit(POLL_PAGE).lean();
    let progressed = false;
    for (const row of rows || []) { if (await handle(row)) progressed = true; }
    if (!progressed || (rows || []).length < POLL_PAGE) break;
  }
  // rows that never got a schedule are due too (checked with a plain equality filter: no $or)
  if (budget()) {
    const unscheduled = await Connection.find({ status: { $in: POLLABLE }, nextCheckAt: null }).limit(POLL_PAGE).lean();
    for (const row of unscheduled || []) await handle(row);
  }
  return out;
}

// ── 2. starter templates ────────────────────────────────────────────────────
// B1-e's pollStatuses({ now }) is a GLOBAL job (one list call per workspace with waiting templates, only for active|past_due
// subscriptions with a usable connection) and it submits the queued rows too, so it is called ONCE per tick. Without it
// (an older starterTemplates) the queue is submitted per connected workspace through submitQueued, 25 workspaces per tick.
async function sweepTemplates(deps, t) {
  const st = loadModule(deps.starterTemplates, deps, 'starterTemplates');
  const out = { mode: null, workspaces: 0, submitted: 0, polled: 0, failed: 0 };
  if (!st) return out;
  const pollName = TEMPLATE_POLL_EXPORTS.find((n) => typeof st[n] === 'function');
  if (pollName) {
    out.mode = 'poll';
    try {
      const r = (await st[pollName]({ now: new Date(t) })) || {};
      out.workspaces = Number(r.workspaces) || 0;
      out.polled = Number(r.checked) || 0;
      out.submitted = Number(r.submit && r.submit.submitted) || 0;
      out.failed = Number(r.errors) || 0;
    } catch (err) {
      out.failed += 1;
      deps.log('template poll failed:', err && err.code, err && err.message);
    }
    return out;
  }
  deps.log('starterTemplates status poll export missing (pollStatuses): only the queue is submitted');
  if (typeof st.submitQueued !== 'function') { deps.log('starterTemplates.submitQueued missing: skipped'); return out; }
  out.mode = 'per_workspace';
  const Connection = deps.Connection();
  const state = loadModule(deps.state, deps, 'state');
  if (!state) return out;
  const filter = { status: { $in: ['connected', 'needs_attention'] }, needsReconnect: { $ne: true } };
  if (templateCursor) filter._id = { $gt: templateCursor };
  const rows = await Connection.find(filter).select('workspaceId').sort({ _id: 1 }).limit(TEMPLATE_PAGE).lean();
  templateCursor = (rows || []).length < TEMPLATE_PAGE ? null : rows[rows.length - 1]._id;
  for (const row of rows || []) {
    const ws = String(row.workspaceId);
    if (!(await eligible(deps, state, ws))) continue;
    out.workspaces += 1;
    try {
      const r = await st.submitQueued({ workspaceId: ws, max: 5 });
      out.submitted += Number(r && (r.submitted !== undefined ? r.submitted : r.count)) || 0;
    } catch (err) { out.failed += 1; deps.log('template submit failed:', err && err.code, err && err.message); }
  }
  return out;
}

// ── 5. stuck 'connecting' ───────────────────────────────────────────────────
async function sweepResume(deps, t) {
  const Connection = deps.Connection();
  const connect = loadModule(deps.connect, deps, 'connect');
  const out = { checked: 0, resumed: 0, failed: 0 };
  if (!connect || typeof connect.resumeConnect !== 'function') return out;
  const rows = await Connection.find({ status: 'connecting', tokenEncrypted: { $exists: true } })
    .select('workspaceId connectedByUserId connectAttempt connectLockUntil lastError updatedAt').limit(20).lean();
  for (const row of rows || []) {
    out.checked += 1;
    // How long has the attempt been stuck? The last connect activity (code exchange, last failed step), NOT updatedAt: the
    // connections sweep of the same tick reschedules a connecting row (nextCheckAt) and that write bumps updatedAt, which
    // would make every stuck attempt look fresh at exactly the moment this sweep looks at it.
    const activity = [ms(row.connectAttempt && row.connectAttempt.usedAt), ms(row.lastError && row.lastError.at)].filter((x) => x !== null);
    const updated = activity.length ? Math.max(...activity) : ms(row.updatedAt);
    const lock = ms(row.connectLockUntil);
    if (updated !== null && t - updated < RESUME_AFTER_MS) continue;
    if (lock !== null && lock > t) continue;
    const ws = String(row.workspaceId);
    const attempt = row.connectAttempt && (row.connectAttempt.id || ms(row.connectAttempt.usedAt)) ? String(row.connectAttempt.id || ms(row.connectAttempt.usedAt)) : '';
    const key = `${ws}:${attempt}`;
    if (resumed.has(key)) continue; // once per attempt per process
    if (resumed.size >= 500) resumed.clear();
    resumed.add(key);
    try {
      await connect.resumeConnect({ workspaceId: ws, userId: row.connectedByUserId ? String(row.connectedByUserId) : null, system: true });
      out.resumed += 1;
    } catch (err) {
      out.failed += 1;
      deps.log('resume failed:', err && err.code, err && err.message);
    }
  }
  return out;
}

// ── the sweep ───────────────────────────────────────────────────────────────
/**
 * One pass of upkeep. Never throws; returns what each step reported (null = skipped, failed or unavailable).
 * @param {object} [deps] realDeps() shape (every module is a thunk)
 */
async function runOnboardingSweep(deps = realDeps()) {
  const result = { skipped: false, connections: null, templates: null, pathB: null, emails: null, resume: null, billing: null, displayName: null };
  try {
    if (typeof deps.enabled === 'function' && !deps.enabled()) return { ...result, skipped: true };
    const t = nowOf(deps);
    const now = new Date(t);
    result.connections = await runStep(deps, 'connections', () => sweepConnections(deps, t));
    result.templates = await runStep(deps, 'templates', () => sweepTemplates(deps, t));
    const reminders = loadModule(deps.reminders, deps, 'reminders');
    if (reminders && typeof reminders.runPathBReminders === 'function') {
      result.pathB = await runStep(deps, 'path B reminders', () => reminders.runPathBReminders({ now }));
    }
    const notifications = loadModule(deps.notifications, deps, 'notifications');
    if (notifications && typeof notifications.retryEmails === 'function') {
      result.emails = await runStep(deps, 'e-mail retries', () => notifications.retryEmails({ now, limit: 20 }));
    }
    result.resume = await runStep(deps, 'connect resume', () => sweepResume(deps, t));
    const billing = loadModule(deps.billing, deps, 'billing');
    if (billing && typeof billing.reconcileSweep === 'function') {
      result.billing = await runStep(deps, 'billing reconcile', () => billing.reconcileSweep({ now }));
    }
    const approvals = loadModule(deps.approvals, deps, 'approvals');
    if (approvals && typeof approvals.reRegisterDueNames === 'function') {
      result.displayName = await runStep(deps, 'display-name re-register', () => approvals.reRegisterDueNames({ now: t }));
    }
  } catch (err) {
    try { deps.log('sweep failed:', err && err.message); } catch (_) { /* nothing left to do */ }
  }
  return result;
}

function tick(deps, intervalMs) {
  return acquireLock(deps, intervalMs)
    .then((ok) => (ok ? runOnboardingSweep(deps) : null))
    .catch((err) => deps.log('tick error:', err && err.message));
}

function effectiveInterval(intervalMs) {
  return Number.isFinite(intervalMs) && intervalMs >= 1000 ? intervalMs : config.schedulerIntervalMs();
}

/**
 * Hunk E4 (server.js, inside app.listen). Idempotent. Returns null (no timer) when the flag is off.
 * @param {object|{intervalMs?:number, deps?:object, setIntervalFn?:Function}} [arg] a deps object, or an options object
 */
function startOnboardingScheduler(arg) {
  // INTERFACES 2.16 documents startOnboardingScheduler(deps?); an options object is accepted too
  const opts = arg && typeof arg.SchedulerLock === 'function' ? { deps: arg } : (arg || {});
  const { intervalMs, setIntervalFn = setInterval } = opts;
  const d = opts.deps || realDeps();
  if (!(typeof d.enabled === 'function' ? d.enabled() : config.enabled())) return null;
  if (schedulerHandle) return schedulerHandle;
  const every = effectiveInterval(intervalMs);
  tick(d, every);
  schedulerHandle = setIntervalFn(() => { tick(d, every); }, every);
  if (schedulerHandle && typeof schedulerHandle.unref === 'function') schedulerHandle.unref();
  return schedulerHandle;
}

/** Test/shutdown helper: stops the timer and forgets the per-process cursors so a later start begins afresh. */
function stopOnboardingScheduler(clearIntervalFn = clearInterval) {
  if (schedulerHandle) clearIntervalFn(schedulerHandle);
  schedulerHandle = null;
  templateCursor = null;
  resumed.clear();
}

module.exports = {
  startOnboardingScheduler,
  runOnboardingSweep,
  LOCK_ID,
  // additions (documented in B1-d.md)
  stopOnboardingScheduler, acquireLock, tick, realDeps, sweepConnections, sweepTemplates, sweepResume, DEFAULT_INTERVAL_MS,
};
