'use strict';
// Background upkeep for the Arabic-localisation feature: every tick it
//  1. refreshes Meta template statuses that are still waiting (templates.refreshPending), and
//  2. resumes campaigns whose sending run was interrupted (campaigns.resumeStuckCampaigns).
// Polling is the PRIMARY status path: the existing webhook drops
// message_template_status_update events (design/META-REALITY.md §7), and Meta
// reviews take up to 24 h, so a 10 minute cadence is plenty.
//
// Decisions:
//  * Same SchedulerLock recipe as utils/flowScheduler.js (fixed _id, TTL =
//    interval - 30 s) — an efficiency guard only; correctness comes from the
//    atomic claims inside the two sweeps. Both sweeps also check the kill switch
//    and the per-merchant flag themselves, so a merchant without Arabic enabled
//    is never touched.
//  * Nothing runs at require time; the timer is unref()'d so it can never keep
//    Jest or a CLI alive. The lead starts it from server.js's app.listen callback:
//      require('./shared/localization/scheduler').startLocalizationScheduler();
//  * Sweep modules are required lazily inside try/catch: a missing or throwing
//    module costs one logged line, never the tick (and never the process).
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const LOCK_ID = 'localizationScheduler';
const LOCK_MARGIN_MS = 30 * 1000;

let schedulerHandle = null;

function envInterval() {
  const n = Number(process.env.LOCALIZATION_SCHEDULER_INTERVAL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_INTERVAL_MS;
}

function realDeps() {
  return {
    SchedulerLock: () => require('../../models/SchedulerLock'),
    settings: () => require('./settings'),
    templates: () => require('./templates'),
    campaigns: () => require('./campaigns'),
    log: (...args) => console.error('[localization scheduler]', ...args),
    now: () => Date.now(),
  };
}

// Classic Mongo TTL lock. Returns true when this process may sweep.
async function acquireLock(deps, intervalMs) {
  const SchedulerLock = deps.SchedulerLock();
  const now = new Date(deps.now());
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

function loadSweepModule(load, deps, name) {
  try {
    return load();
  } catch (err) {
    deps.log(`${name} unavailable:`, err && err.message);
    return null;
  }
}

async function runStep(deps, name, fn) {
  try {
    return await fn();
  } catch (err) {
    deps.log(`${name} failed:`, err && err.message);
    return null;
  }
}

// One pass of upkeep. Never throws; returns what each step reported.
async function runSweepOnce(deps = realDeps()) {
  const result = { skipped: false, templates: null, campaigns: null };
  const settings = loadSweepModule(deps.settings, deps, 'settings');
  if (settings && typeof settings.killSwitchOn === 'function' && settings.killSwitchOn()) {
    return { ...result, skipped: true };
  }
  const templates = loadSweepModule(deps.templates, deps, 'templates');
  if (templates && typeof templates.refreshPending === 'function') {
    result.templates = await runStep(deps, 'template refresh', () => templates.refreshPending());
  }
  const campaigns = loadSweepModule(deps.campaigns, deps, 'campaigns');
  if (campaigns && typeof campaigns.resumeStuckCampaigns === 'function') {
    result.campaigns = await runStep(deps, 'campaign resume', () => campaigns.resumeStuckCampaigns());
  }
  return result;
}

function tick(deps, intervalMs) {
  return acquireLock(deps, intervalMs)
    .then((ok) => (ok ? runSweepOnce(deps) : null))
    .catch((err) => deps.log('tick error:', err && err.message));
}

// Idempotent: a second call returns the existing handle and starts nothing.
function startLocalizationScheduler({ intervalMs, deps = realDeps(), setIntervalFn = setInterval } = {}) {
  if (schedulerHandle) return schedulerHandle;
  const every = Number.isFinite(intervalMs) && intervalMs >= 1000 ? intervalMs : envInterval();
  tick(deps, every);
  schedulerHandle = setIntervalFn(() => { tick(deps, every); }, every);
  if (schedulerHandle && typeof schedulerHandle.unref === 'function') schedulerHandle.unref();
  return schedulerHandle;
}

// Test/shutdown helper: stops the timer so a later start begins afresh.
function stopLocalizationScheduler(clearIntervalFn = clearInterval) {
  if (schedulerHandle) clearIntervalFn(schedulerHandle);
  schedulerHandle = null;
}

module.exports = {
  DEFAULT_INTERVAL_MS, LOCK_ID,
  startLocalizationScheduler, stopLocalizationScheduler, runSweepOnce, acquireLock, tick, realDeps,
};
