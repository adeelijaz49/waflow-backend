'use strict';
// Onboarding analytics: the WRITE path (DB design 2.3 / 7.3). Rows are append-only,
// carry no PII (everything goes through sanitizeEvent) and are application-capped
// per workspace (the standing no-delete rule: nothing here ever deletes).
// track() never throws and never rejects: analytics must not break a state change.
// funnel() (admin summary, DB 7.4) is appended below.
const config = require('./config');
const { safeLog } = config;

const EVENT_TYPES = Object.freeze([
  'step_enter', 'step_complete', 'step_skip', 'step_fail', 'connect_event', 'connect_result', 'status_change',
  'payment_state', 'template_status', 'send_blocked', 'help_opened', 'notification', 'webhook_dropped', 'admin',
]);
const EVENT_STEPS = Object.freeze(['business', 'number', 'connect', 'approvals', 'customers', 'products', 'promotion', 'billing']);
/** Types the browser may report through POST /events (DECISIONS C4 adds step_fail). */
const UI_EVENT_TYPES = Object.freeze(['step_enter', 'step_complete', 'step_skip', 'step_fail', 'help_opened']);
const UI_FAIL_CODES = Object.freeze(['ONB_SDK_BLOCKED', 'ONB_SDK_TIMEOUT', 'ONB_POPUP_BLOCKED', 'ONB_IN_APP_BROWSER', 'ONB_NETWORK', 'ONB_CODE_HANDOFF_SLOW']);
const META_KEYS = Object.freeze(['path', 'usage', 'tier', 'templateKey', 'language', 'attempt']);
// PER_WORKSPACE / FAIL_TOTAL: the event budget of one workspace (webhook_dropped rows are NOT part of it, review R7-09: a busy merchant number
// would otherwise use it up and later status changes would no longer be recorded); DROPPED_PER_WORKSPACE: their own hard cap.
const CAPS = Object.freeze({ PER_WORKSPACE: 400, FAIL_TOTAL: 600, DROPPED_PER_WORKSPACE: 400 });
// kept writing after PER_WORKSPACE (until FAIL_TOTAL): what a merchant or staff member needs to understand why something stopped
const ALWAYS_WRITTEN_PAST_CAP = Object.freeze(['step_fail', 'send_blocked', 'status_change', 'payment_state', 'connect_result']);

const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const REASON_RE = /^[a-z0-9_ .:-]{1,80}$/;
const ID_RE = /^[0-9a-f]{24}$/i;
const MEMO_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function cleanMetaValue(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.length > 40) return undefined;
  if (s.includes('@') || /\d{8,}/.test(s)) return undefined; // looks like an e-mail / phone number: never stored
  return s;
}

/**
 * Whitelist an analytics event. Returns a clean plain object, or null when the
 * event must not be written (unknown type).
 * @param {{type:string, step?:string, code?:string, reason?:string, durationMs?:number, meta?:object}} input
 */
function sanitizeEvent(input) {
  if (!input || typeof input !== 'object') return null;
  if (!EVENT_TYPES.includes(input.type)) return null;
  const out = { type: input.type };
  if (typeof input.step === 'string' && EVENT_STEPS.includes(input.step)) out.step = input.step;
  if (typeof input.code === 'string' && CODE_RE.test(input.code)) out.code = input.code;
  if (typeof input.reason === 'string' && REASON_RE.test(input.reason)) out.reason = input.reason;
  if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)) {
    const d = Math.round(input.durationMs);
    if (d >= 0 && d <= 86400000) out.durationMs = d;
  }
  if (input.meta && typeof input.meta === 'object' && !Array.isArray(input.meta)) {
    const meta = {};
    for (const k of META_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(input.meta, k)) continue;
      const v = cleanMetaValue(input.meta[k]);
      if (v !== undefined) meta[k] = v;
    }
    if (Object.keys(meta).length) out.meta = meta;
  }
  return out;
}

function realModel() { return require('../../models/OnboardingEvent'); }

async function resolve(q) {
  let query = q;
  if (query && typeof query.lean === 'function') query = query.lean();
  return query;
}

/**
 * @param {{model?:object, now?:()=>number}} [deps]
 */
function createAnalytics(deps = {}) {
  const now = deps.now || (() => Date.now());
  const countMemo = new Map();   // workspaceId -> { count, expires }
  const enterMemo = new Map();   // `${ws}|${step}|${hour}` -> true
  const droppedMemo = new Map(); // `${ws}|${code}|${utc day}` -> true
  const getModel = () => deps.model || realModel();

  async function currentCount(model, workspaceId) {
    const key = String(workspaceId);
    const t = now();
    const hit = countMemo.get(key);
    if (hit && hit.expires > t) return hit;
    const count = Number(await resolve(model.countDocuments({ workspaceId, type: { $ne: 'webhook_dropped' } }))) || 0; // the dropped-webhook counters have their own cap
    const rec = { count, expires: t + MEMO_MS };
    countMemo.set(key, rec);
    return rec;
  }

  /**
   * Record one event. Never throws, never rejects.
   * @param {string|object} workspaceId
   * @param {object} evt see sanitizeEvent
   */
  async function track(workspaceId, evt) {
    try {
      const clean = sanitizeEvent(evt);
      if (!clean) return;
      if (!ID_RE.test(String(workspaceId || ''))) return;
      const model = getModel();
      const t = now();

      if (clean.type === 'webhook_dropped') {
        // one row per (workspace, code, UTC day), outside the event budget, with its own hard cap (no deletes: the collection must not grow without bound)
        const dayStart = Math.floor(t / DAY_MS) * DAY_MS;
        const dropKey = `${workspaceId}|${clean.code || ''}|${dayStart}`;
        if (droppedMemo.has(dropKey)) return;
        if (droppedMemo.size > 5000) droppedMemo.clear();
        droppedMemo.set(dropKey, true);
        const sameDay = await resolve(model.findOne({ workspaceId, type: 'webhook_dropped', ...(clean.code ? { code: clean.code } : {}), at: { $gte: new Date(dayStart) } }));
        if (sameDay) return;
        const total = Number(await resolve(model.countDocuments({ workspaceId, type: 'webhook_dropped' }))) || 0;
        if (total >= CAPS.DROPPED_PER_WORKSPACE) return;
        await model.create({ workspaceId, ...clean, at: new Date(t) });
        return;
      }

      const rec = await currentCount(model, workspaceId);
      if (rec.count >= CAPS.FAIL_TOTAL) return;
      if (rec.count >= CAPS.PER_WORKSPACE && !ALWAYS_WRITTEN_PAST_CAP.includes(clean.type)) return;

      if (clean.type === 'step_enter') {
        const hourStart = Math.floor(t / HOUR_MS) * HOUR_MS;
        const memoKey = `${workspaceId}|${clean.step || ''}|${hourStart}`;
        if (enterMemo.has(memoKey)) return;
        if (enterMemo.size > 5000) enterMemo.clear();
        enterMemo.set(memoKey, true);
        const existing = await resolve(model.findOne({
          workspaceId, type: 'step_enter', ...(clean.step ? { step: clean.step } : {}), at: { $gte: new Date(hourStart) },
        }));
        if (existing) return;
      }

      await model.create({ workspaceId, ...clean, at: new Date(t) });
      rec.count += 1;
    } catch (err) {
      safeLog('warn', '[onboarding] analytics write failed:', err && err.code ? err.code : '', err && err.message ? err.message : '');
    }
  }

  function _resetMemo() { countMemo.clear(); enterMemo.clear(); }
  return { track, _resetMemo };
}

const defaultInstance = createAnalytics();

/** Record one event with the real model. Never throws, never rejects. */
function track(workspaceId, evt, deps) {
  if (deps && (deps.model || deps.now)) return createAnalytics(deps).track(workspaceId, evt);
  return defaultInstance.track(workspaceId, evt);
}
function _resetMemo() { defaultInstance._resetMemo(); }

const DROP_OFF_MS = 7 * 24 * HOUR_MS;
const FUNNEL_MAX_STATES = 5000;
const FUNNEL_FAIL_TYPES = Object.freeze(['step_fail', 'connect_result']);
/** testMessage.js writes its own OnboardingEvent rows (type 'notification', code TEST_MESSAGE_SENT|VOID|FAILED): bookkeeping, never funnel data. */
const FUNNEL_IGNORED_CODE = /^TEST_MESSAGE/;
const SUB_STATES = Object.freeze(['none', 'pending', 'active', 'past_due', 'cancelled']);
const CONN_LEVELS = Object.freeze(['connected', 'needs_attention', 'reconnect_needed', 'not_connected']);

function msOf(value) {
  if (value === undefined || value === null) return NaN;
  return new Date(value).getTime();
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Math.round(m * 10) / 10;
}

/** Local mapping of a WhatsAppConnection row to the UI level (statusRefresh.connectionLevel is preferred when available). */
function localConnectionLevel(conn) {
  if (!conn) return 'not_connected';
  if (conn.needsReconnect || conn.status === 'reconnect_required') return 'reconnect_needed';
  if (conn.status === 'connected') return 'connected';
  if (conn.status === 'needs_attention' || conn.status === 'error') return 'needs_attention';
  return 'not_connected';
}

function levelFn(deps) {
  if (deps && typeof deps.connectionLevel === 'function') return deps.connectionLevel;
  try {
    const fn = require('./statusRefresh').connectionLevel;
    if (typeof fn === 'function') {
      return (conn) => {
        try { const l = fn(conn); return CONN_LEVELS.includes(l) ? l : localConnectionLevel(conn); } catch (_) { return localConnectionLevel(conn); }
      };
    }
  } catch (_) { /* owner module not ready / stub: use the local mapping */ }
  return localConnectionLevel;
}

/**
 * Admin-only funnel summary (DB design 7.4). Simple single-collection reads, no multi-field sort,
 * aggregation limited to one $match + one $group. Not exposed on any merchant route.
 * Per step: { entered, completed, skipped, medianMinutes, dropOff }; dropOff = enrolled workspaces whose
 * progress.currentStep is that step, not finished, and whose lastActivityAt is older than 7 days.
 * @param {{OnboardingState?:object, OnboardingEvent?:object, WhatsAppConnection?:object, now?:()=>number|Date, connectionLevel?:Function}} [deps]
 */
async function funnel(deps) {
  const d = deps || {};
  const State = d.OnboardingState || require('../../models/OnboardingState');
  const nowRaw = typeof d.now === 'function' ? d.now() : Date.now();
  const nowMs = typeof nowRaw === 'number' ? nowRaw : new Date(nowRaw).getTime();
  const warnings = [];

  let states = await resolve(State.find({ enrolled: { $ne: false } })
    .select('workspaceId subscription.state progress steps').limit(FUNNEL_MAX_STATES + 1)) || [];
  const truncated = states.length > FUNNEL_MAX_STATES;
  if (truncated) { states = states.slice(0, FUNNEL_MAX_STATES); warnings.push('truncated_at_5000_workspaces'); }

  const stepKeys = config.STEP_KEYS;
  const steps = {};
  const durations = {};
  for (const k of stepKeys) { steps[k] = { entered: 0, completed: 0, skipped: 0, medianMinutes: null, dropOff: 0 }; durations[k] = []; }
  const subscription = {};
  for (const s of SUB_STATES) subscription[s] = 0;
  let completedCount = 0;

  for (const st of states) {
    const sub = (st.subscription && st.subscription.state) || 'none';
    subscription[sub] = (subscription[sub] || 0) + 1;
    const progress = st.progress || {};
    const finished = !!progress.completedAt || progress.status === 'completed';
    if (finished) completedCount += 1;
    for (const k of stepKeys) {
      const step = (st.steps && st.steps[k]) || {};
      const status = step.status || 'todo';
      if (status !== 'todo' || step.enteredAt || step.completedAt) steps[k].entered += 1;
      if (status === 'done') {
        steps[k].completed += 1;
        const a = msOf(step.enteredAt);
        const b = msOf(step.completedAt);
        if (Number.isFinite(a) && Number.isFinite(b) && b >= a) durations[k].push((b - a) / 60000);
      }
      if (status === 'skipped') steps[k].skipped += 1;
    }
    const idx = Number(progress.currentStep);
    const last = msOf(progress.lastActivityAt);
    if (!finished && idx >= 1 && idx <= stepKeys.length && Number.isFinite(last) && last < nowMs - DROP_OFF_MS) steps[stepKeys[idx - 1]].dropOff += 1;
  }
  for (const k of stepKeys) steps[k].medianMinutes = median(durations[k]);

  // Top failure codes: one $match + one $group; ordering and the limit happen in memory.
  let failureCodes = [];
  try {
    const Event = d.OnboardingEvent || require('../../models/OnboardingEvent');
    const rows = await Event.aggregate([
      { $match: { type: { $in: FUNNEL_FAIL_TYPES.slice() }, code: { $exists: true } } },
      { $group: { _id: '$code', count: { $sum: 1 } } },
    ]);
    failureCodes = (rows || []).filter((r) => r && r._id && !FUNNEL_IGNORED_CODE.test(String(r._id))).map((r) => ({ code: String(r._id), count: Number(r.count) || 0 }))
      .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1)).slice(0, 10);
  } catch (err) {
    warnings.push('failure_codes_unavailable');
    safeLog('warn', '[onboarding] funnel failure codes failed:', err && err.message ? err.message : '');
  }

  // Connection levels of the enrolled workspaces (an enrolled workspace without a row is not_connected).
  const connection = {};
  for (const l of CONN_LEVELS) connection[l] = 0;
  try {
    const Conn = d.WhatsAppConnection || require('../../models/WhatsAppConnection');
    const rows = await resolve(Conn.find({}).select('workspaceId status needsReconnect').limit(FUNNEL_MAX_STATES + 1)) || [];
    const byWs = new Map(rows.map((r) => [String(r.workspaceId), r]));
    const level = levelFn(d);
    for (const st of states) connection[level(byWs.get(String(st.workspaceId)) || null)] += 1;
  } catch (err) {
    warnings.push('connection_levels_unavailable');
    safeLog('warn', '[onboarding] funnel connection levels failed:', err && err.message ? err.message : '');
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    enrolled: states.length,
    completed: completedCount,
    truncated,
    steps,
    failureCodes,
    subscription,
    connection,
    warnings,
  };
}

module.exports = {
  track, sanitizeEvent, createAnalytics, _resetMemo, funnel,
  EVENT_TYPES, EVENT_STEPS, UI_EVENT_TYPES, UI_FAIL_CODES, CAPS,
};
