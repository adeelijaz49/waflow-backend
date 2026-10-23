'use strict';
// Onboarding enrolment + the cached "gate state" every other module reads
// (DB design 3.2-3.4). Legacy = no sidecar document = never gated. Models are
// required lazily and every dependency is injectable (`deps`) so the pure parts
// are testable without a database. Nothing runs at require time.
const config = require('./config');
const { OnbError } = require('./errors');
const subscription = require('./subscription');

const ID_RE = /^[0-9a-f]{24}$/i;
const POSITIVE_TTL_MS = 30 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const STALE_MAX_MS = 10 * 60 * 1000;
const OLDEST_TTL_MS = 10 * 60 * 1000;
const AUTO_NEG_TTL_MS = 5 * 60 * 1000;
const LOG_EVERY_MS = 60 * 1000;
const MAX_CACHE = 5000;

const gateCache = new Map();   // workspaceId -> { value, expires, fetchedAt }
const autoMemo = new Map();    // workspaceId -> { reason, expires }
const oldestMemo = { value: null, expires: 0 };
const lastLogged = new Map();  // key -> ts

const MODEL_PATHS = {
  OnboardingState: '../../models/OnboardingState',
  WhatsAppConnection: '../../models/WhatsAppConnection',
  OnboardingAdminLog: '../../models/OnboardingAdminLog',
  Workspace: '../../models/Workspace',
  Customer: '../../models/Customer',
  Order: '../../models/Order',
  Promotion: '../../models/Promotion',
};
/** Resolve a model: injected first, real (lazily required) otherwise. */
function M(deps, name) {
  if (deps && deps[name]) return deps[name];
  return require(MODEL_PATHS[name]);
}
/** analytics.track (injectable as deps.track so unit tests never touch a model). */
function trackOf(deps) { return deps && typeof deps.track === 'function' ? deps.track : require('./analytics').track; }
function nowOf(deps) { return deps && typeof deps.now === 'function' ? deps.now() : new Date(); }
function nowMs(deps) { return nowOf(deps).getTime(); }

function logOnce(deps, key, ...args) {
  const t = nowMs(deps);
  const last = lastLogged.get(key) || 0;
  if (t - last < LOG_EVERY_MS) return;
  lastLogged.set(key, t);
  config.safeLog('warn', '[onboarding]', ...args);
}

function invalidate(workspaceId) { gateCache.delete(String(workspaceId)); }
function clearCache() { gateCache.clear(); autoMemo.clear(); oldestMemo.value = null; oldestMemo.expires = 0; lastLogged.clear(); }

/**
 * Pure: the gate state from the sidecar and connection documents (INTERFACES 0.5).
 * @param {object|null} stateDoc
 * @param {object|null} connDoc
 */
function buildGateState(stateDoc, connDoc) {
  if (!stateDoc || stateDoc.enrolled === false) return { enrolled: false };
  const sub = stateDoc.subscription || {};
  const subState = sub.state || 'none';
  const connectDone = !!(stateDoc.steps && stateDoc.steps.connect && stateDoc.steps.connect.status === 'done');
  const completed = !!(stateDoc.progress && stateDoc.progress.completedAt);
  const unlockAt = config.unlockAt();
  const unlocked = subState === 'active' && (unlockAt === 'finished' ? completed : connectDone);
  return {
    enrolled: true,
    sub: { state: subState, source: sub.source || null },
    conn: connDoc ? { status: connDoc.status, needsReconnect: !!connDoc.needsReconnect } : null,
    locked: !unlocked,
    unlockAt,
    completed,
    connectDone,
    legacyPolicy: config.legacySendPolicy(),
  };
}

const GATE_FIELDS = 'enrolled subscription.state subscription.source steps.connect.status progress.completedAt';

/**
 * Cached gate state. 30 s positive / 60 s negative; on a DB error the last value
 * is served for up to 10 min (stale-if-error), then fail-open { enrolled:false }.
 * @param {string} workspaceId
 * @param {{fresh?:boolean, deps?:object}} [opts]
 */
async function getGateState(workspaceId, opts = {}) {
  const id = String(workspaceId || '');
  if (!ID_RE.test(id)) return { enrolled: false };
  const deps = opts.deps;
  const t = nowMs(deps);
  const hit = gateCache.get(id);
  if (!opts.fresh && hit && hit.expires > t) return hit.value;
  try {
    const stateDoc = await M(deps, 'OnboardingState').findOne({ workspaceId: id }).select(GATE_FIELDS).lean();
    let connDoc = null;
    if (stateDoc && stateDoc.enrolled !== false) {
      connDoc = await M(deps, 'WhatsAppConnection').findOne({ workspaceId: id }).select('status needsReconnect').lean();
    }
    const value = buildGateState(stateDoc, connDoc);
    if (gateCache.size >= MAX_CACHE) {
      for (const [k, v] of gateCache) if (t - v.fetchedAt > STALE_MAX_MS) gateCache.delete(k);
      if (gateCache.size >= MAX_CACHE) gateCache.clear();
    }
    gateCache.set(id, { value, fetchedAt: t, expires: t + (value.enrolled ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
    return value;
  } catch (err) {
    if (hit && t - hit.fetchedAt <= STALE_MAX_MS) {
      logOnce(deps, 'gate-stale', 'gate lookup failed, serving the last known value:', err && err.message);
      return { ...hit.value, stale: true };
    }
    logOnce(deps, 'gate-failopen', 'gate lookup failed:', err && err.message);
    return { enrolled: false };
  }
}

/** Lean sidecar document, or null when absent / un-enrolled. */
async function getState(workspaceId, deps) {
  const id = String(workspaceId || '');
  if (!ID_RE.test(id)) return null;
  const doc = await M(deps, 'OnboardingState').findOne({ workspaceId: id }).lean();
  return doc && doc.enrolled !== false ? doc : null;
}

/** Lean sidecar document; throws OnbError ONBOARDING_NOT_AVAILABLE (404) when not enrolled. Never creates an enrolment. */
async function ensureState(workspaceId, deps) {
  const doc = await getState(workspaceId, deps);
  if (!doc) throw new OnbError('ONBOARDING_NOT_AVAILABLE');
  return doc;
}

/** Upsert-and-return the WhatsAppConnection row of an ENROLLED workspace (secrets not selected). */
async function ensureConnection(workspaceId, deps) {
  await ensureState(workspaceId, deps);
  const id = String(workspaceId);
  const Conn = M(deps, 'WhatsAppConnection');
  try {
    return await Conn.findOneAndUpdate(
      { workspaceId: id },
      { $setOnInsert: { workspaceId: id } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean();
  } catch (err) {
    if (err && err.code === 11000) return Conn.findOne({ workspaceId: id }).lean();
    throw err;
  }
}

/**
 * Re-derive the effective subscription state from the stored Stripe facts +
 * admin activation and write the transition atomically. Invalidates the gate cache.
 */
async function recomputeSubscription(workspaceId, opts = {}, deps) {
  const id = String(workspaceId || '');
  if (!ID_RE.test(id)) throw new OnbError('VALIDATION_FAILED', { details: { reason: 'INVALID_WORKSPACE_ID' } });
  const State = M(deps, 'OnboardingState');
  const now = (opts && opts.now) || nowOf(deps);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const doc = await State.findOne({ workspaceId: id }).select('subscription').lean();
    if (!doc) return { changed: false, before: null, after: null };
    const sub = doc.subscription || {};
    const before = { state: sub.state || 'none', source: sub.source || null };
    const next = subscription.effectiveState(sub);
    const patch = subscription.transitionPatch(before, next, now);
    const after = { state: next.state, source: next.source };
    if (!patch.changed) { invalidate(id); return { changed: false, before, after }; }
    const res = await State.updateOne({ workspaceId: id, 'subscription.state': before.state }, { $set: patch.set });
    const modified = res && (res.modifiedCount !== undefined ? res.modifiedCount : res.nModified);
    if (modified) {
      invalidate(id);
      try {
        await trackOf(deps)(id, { type: 'payment_state', step: 'billing', code: `SUB_${after.state.toUpperCase()}` });
      } catch (_) { /* analytics never blocks */ }
      return { changed: true, before, after };
    }
    // lost a race with another writer: re-read once
  }
  invalidate(id);
  return { changed: false, before: null, after: null };
}

// ── Oldest workspace (webhook workspace / owner) ───────────────────────────
async function getOldestWorkspace(opts = {}) {
  const deps = opts.deps;
  const t = nowMs(deps);
  if (!opts.fresh && oldestMemo.value && oldestMemo.expires > t) return oldestMemo.value;
  const doc = await M(deps, 'Workspace').findOne().sort({ createdAt: 1 }).select('_id createdAt').lean();
  if (doc) { oldestMemo.value = doc; oldestMemo.expires = t + OLDEST_TTL_MS; }
  return doc || null;
}

// ── Admin helpers ──────────────────────────────────────────────────────────
function cleanBy(by, fallback) {
  const s = typeof by === 'string' ? by.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) : '';
  return s || fallback;
}
function cleanNotes(notes) {
  return typeof notes === 'string' ? notes.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500) : '';
}
function assertId(workspaceId) {
  const id = String(workspaceId || '');
  if (!ID_RE.test(id)) throw new OnbError('VALIDATION_FAILED', { details: { reason: 'INVALID_WORKSPACE_ID' } });
  return id;
}
function invalid(reason, extra) {
  return new OnbError('VALIDATION_FAILED', { details: { reason, ...(extra || {}) } });
}
/** Log-before-mutate: a failing log row aborts the mutation (the error propagates). */
async function logAdmin(deps, row) {
  await M(deps, 'OnboardingAdminLog').create({
    workspaceId: row.workspaceId, action: row.action, adminUser: row.adminUser, notes: row.notes || '', ip: row.ip, before: row.before, after: row.after,
  });
}

async function existingDataReasons(ws, deps) {
  const reasons = [];
  const has = async (name) => {
    const doc = await M(deps, name).findOne({ workspaceId: ws._id }).select('_id').lean();
    return !!doc;
  };
  if (await has('Customer')) reasons.push('customers');
  if (await has('Order')) reasons.push('orders');
  if (await has('Promotion')) reasons.push('promotions');
  const from = config.enrolFrom();
  if (from && ws.createdAt && new Date(ws.createdAt).getTime() < from.getTime()) reasons.push('created_before_cutover');
  return reasons;
}

async function trackAdmin(id, reason, deps) {
  try { await trackOf(deps)(id, { type: 'admin', reason }); } catch (_) { /* never blocks */ }
}

/**
 * Enrol a workspace (admin page / CLI / auto first-sight). Safeguards of DB 3.2
 * apply to admin enrolment; R1 (DB 3.4) only for a freshly enrolled workspace.
 */
async function enrol(args, deps) {
  const o = args || {};
  const id = assertId(o.workspaceId);
  const via = o.via === 'auto_signup' ? 'auto_signup' : 'admin';
  const by = cleanBy(o.by, via === 'auto_signup' ? 'system' : 'unknown');
  const notes = cleanNotes(o.notes);
  const State = M(deps, 'OnboardingState');
  const Workspace = M(deps, 'Workspace');
  const now = nowOf(deps);

  const ws = await Workspace.findById(id).select('_id createdAt onboarding').lean();
  if (!ws) throw invalid('WORKSPACE_NOT_FOUND');
  const existing = await State.findOne({ workspaceId: id }).lean();
  const alreadyEnrolled = !!existing && existing.enrolled !== false;
  const warnings = [];

  if (!alreadyEnrolled && via === 'admin') {
    const oldest = await getOldestWorkspace({ fresh: true, deps });
    if (oldest && String(oldest._id) === id) {
      if (!o.forceOldest) throw invalid('OLDEST_WORKSPACE');
      warnings.push('oldest_workspace_forced');
    }
    const reasons = await existingDataReasons(ws, deps);
    if (reasons.length) {
      if (!o.confirmExistingData) throw invalid('EXISTING_DATA', { reasons });
      warnings.push('existing_data_confirmed');
    }
  }

  if (o.dryRun) {
    return { ok: true, dryRun: true, alreadyEnrolled, enrolled: alreadyEnrolled, r1Applied: false, activated: false, warnings };
  }

  let r1Applied = false;
  let doc = existing;
  let wonEnrolment = false;
  if (!alreadyEnrolled) {
    const logRow = {
      workspaceId: id, action: o.activate ? 'enrol_activate' : 'enrol', adminUser: by, notes, ip: o.ip,
      before: { enrolled: false }, after: { enrolled: true, via },
    };
    // Admin actions are logged BEFORE they mutate (a failing log row means nothing changed). Auto first-sight
    // enrolment has no admin: only the request that actually wins the insert writes its (best-effort) audit row,
    // so a race of simultaneous first requests leaves ONE row and ONE log entry.
    if (via === 'admin') await logAdmin(deps, logRow);

    const fields = { enrolled: true, enrolledAt: now, enrolledVia: via, enrolledBy: by };
    if (!existing) {
      try {
        await State.create({ workspaceId: id, ...fields, schemaVersion: 1, progress: { startedAt: now, lastActivityAt: now } });
        wonEnrolment = true;
      } catch (err) {
        if (!(err && err.code === 11000)) throw err; // a simultaneous first request inserted the row: it applies R1
      }
    } else {
      // re-enrolment of an un-enrolled workspace: the conditional update decides the winner
      const res = await State.updateOne({ workspaceId: id, enrolled: false }, { $set: fields, $unset: { unenrolledAt: 1, unenrolledBy: 1 } });
      wonEnrolment = !!(res && (res.modifiedCount !== undefined ? res.modifiedCount : res.nModified));
    }
    doc = await State.findOne({ workspaceId: id }).lean();

    if (wonEnrolment) {
      if (via !== 'admin') {
        try { await logAdmin(deps, logRow); } catch (err) { config.safeLog('warn', '[onboarding] enrolment audit row not written:', err && err.message); }
      }
      try {
        const res = await Workspace.updateOne({ _id: id, 'onboarding.completed': false }, { $set: { 'onboarding.completed': true } });
        const modified = res && (res.modifiedCount !== undefined ? res.modifiedCount : res.nModified);
        if (modified) {
          r1Applied = true;
          await State.updateOne({ workspaceId: id }, { $set: { r1Applied: true } });
        }
      } catch (err) {
        config.safeLog('warn', '[onboarding] R1 (onboarding.completed) not applied:', err && err.message);
      }
      await trackAdmin(id, via === 'auto_signup' ? 'enrolled_auto' : 'enrolled_admin', deps);
    }
    invalidate(id);
  }

  let activated = false;
  if (o.activate) {
    if (alreadyEnrolled) {
      await adminActivate({ workspaceId: id, by, notes: notes || 'activated at enrolment', ip: o.ip }, deps);
    } else {
      await applyAdminActivation(id, by, notes || 'activated at enrolment', deps);
    }
    activated = true;
  }

  return { ok: true, dryRun: false, alreadyEnrolled: alreadyEnrolled || !wonEnrolment, enrolled: true, r1Applied, activated, warnings, state: doc || undefined };
}

async function applyAdminActivation(id, by, notes, deps) {
  const State = M(deps, 'OnboardingState');
  await State.updateOne({ workspaceId: id }, { $set: { 'subscription.admin': { active: true, by, at: nowOf(deps), notes } } });
  return recomputeSubscription(id, {}, deps);
}

/** Admin: mark the workspace as un-enrolled (document kept, inert). Cache invalidated at once. */
async function unenrol(args, deps) {
  const o = args || {};
  const id = assertId(o.workspaceId);
  const by = cleanBy(o.by, 'unknown');
  const State = M(deps, 'OnboardingState');
  const doc = await State.findOne({ workspaceId: id }).select('enrolled').lean();
  const wasEnrolled = !!doc && doc.enrolled !== false;
  if (!wasEnrolled || o.dryRun) return { ok: true, dryRun: !!o.dryRun, wasEnrolled };
  await logAdmin(deps, { workspaceId: id, action: 'unenrol', adminUser: by, notes: cleanNotes(o.notes), ip: o.ip, before: { enrolled: true }, after: { enrolled: false } });
  await State.updateOne({ workspaceId: id }, { $set: { enrolled: false, unenrolledAt: nowOf(deps), unenrolledBy: by } });
  invalidate(id);
  await trackAdmin(id, 'unenrolled', deps);
  return { ok: true, dryRun: false, wasEnrolled: true };
}

/** Admin: the global runtime kill without a redeploy (rows kept). */
async function unenrolAll(args, deps) {
  const o = args || {};
  const by = cleanBy(o.by, 'unknown');
  const State = M(deps, 'OnboardingState');
  const rows = await State.find({ enrolled: { $ne: false } }).select('workspaceId').lean();
  if (o.dryRun) return { ok: true, dryRun: true, count: rows.length };
  let count = 0;
  for (const r of rows) {
    const id = String(r.workspaceId);
    await logAdmin(deps, { workspaceId: id, action: 'unenrol', adminUser: by, notes: cleanNotes(o.notes) || 'unenrol --all', ip: o.ip, before: { enrolled: true }, after: { enrolled: false } });
    await State.updateOne({ workspaceId: id }, { $set: { enrolled: false, unenrolledAt: nowOf(deps), unenrolledBy: by } });
    count += 1;
  }
  clearCache();
  return { ok: true, dryRun: false, count };
}

/** Admin: explicit activation (partner accounts, spec 1b.7). Notes required. */
async function adminActivate(args, deps) {
  const o = args || {};
  const id = assertId(o.workspaceId);
  const by = cleanBy(o.by, 'unknown');
  const notes = cleanNotes(o.notes);
  if (!notes) throw invalid('NOTES_REQUIRED');
  const State = M(deps, 'OnboardingState');
  const doc = await State.findOne({ workspaceId: id }).select('enrolled subscription').lean();
  if (!doc || doc.enrolled === false) throw invalid('NOT_ENROLLED');
  const sub = doc.subscription || {};
  const before = { state: sub.state || 'none', source: sub.source || null };
  if (o.dryRun) {
    const next = subscription.effectiveState({ ...sub, admin: { ...(sub.admin || {}), active: true } });
    return { ok: true, dryRun: true, before, after: { state: next.state, source: next.source } };
  }
  await logAdmin(deps, { workspaceId: id, action: 'activate', adminUser: by, notes, ip: o.ip, before, after: { adminActive: true } });
  const r = await applyAdminActivation(id, by, notes, deps);
  return { ok: true, dryRun: false, before, after: r.after || before };
}

/** Admin: deactivate the explicit activation (Stripe-derived state is untouched). */
async function adminDeactivate(args, deps) {
  const o = args || {};
  const id = assertId(o.workspaceId);
  const by = cleanBy(o.by, 'unknown');
  const State = M(deps, 'OnboardingState');
  const doc = await State.findOne({ workspaceId: id }).select('enrolled subscription').lean();
  if (!doc || doc.enrolled === false) throw invalid('NOT_ENROLLED');
  const sub = doc.subscription || {};
  const before = { state: sub.state || 'none', source: sub.source || null };
  if (o.dryRun) {
    const next = subscription.effectiveState({ ...sub, admin: { ...(sub.admin || {}), active: false } });
    return { ok: true, dryRun: true, before, after: { state: next.state, source: next.source } };
  }
  await logAdmin(deps, { workspaceId: id, action: 'deactivate', adminUser: by, notes: cleanNotes(o.notes), ip: o.ip, before, after: { adminActive: false } });
  const set = { 'subscription.admin.active': false };
  const notes = cleanNotes(o.notes);
  if (notes) set['subscription.admin.notes'] = notes;
  await State.updateOne({ workspaceId: id }, { $set: set });
  const r = await recomputeSubscription(id, {}, deps);
  return { ok: true, dryRun: false, before, after: r.after || before };
}

/**
 * Auto first-sight enrolment of a brand-new self-serve signup (DB 3.2 rule 2).
 * Never throws. Returns { enrolled, reason }.
 */
async function autoEnrolIfEligible(args, deps) {
  const none = (reason) => ({ enrolled: false, reason });
  try {
    if (!config.enabled()) return none('flag_off');
    const from = config.enrolFrom();
    if (!from) return none('no_cutover');
    const id = String((args && args.workspaceId) || '');
    if (!ID_RE.test(id)) return none('invalid_workspace');
    const t = nowMs(deps);
    const memo = autoMemo.get(id);
    if (memo && memo.expires > t) return none(memo.reason);
    const neg = (reason) => {
      if (autoMemo.size >= MAX_CACHE) autoMemo.clear();
      autoMemo.set(id, { reason, expires: t + AUTO_NEG_TTL_MS });
      return none(reason);
    };

    const sidecar = await M(deps, 'OnboardingState').findOne({ workspaceId: id }).select('_id enrolled').lean();
    if (sidecar) return sidecar.enrolled === false ? neg('unenrolled') : none('already_enrolled');

    const ws = await M(deps, 'Workspace').findById(id).select('_id createdAt onboarding').lean();
    if (!ws) return none('workspace_not_found');
    if (!ws.onboarding || ws.onboarding.completed !== false) return neg('completed');
    if (!ws.createdAt || new Date(ws.createdAt).getTime() < from.getTime()) return neg('before_cutover');

    const oldest = await getOldestWorkspace({ deps });
    if (oldest && String(oldest._id) === id) return neg('oldest_workspace');
    if (oldest && from.getTime() < new Date(oldest.createdAt).getTime()) {
      logOnce(deps, 'misconfig', 'ONBOARDING_ENROL_FROM is earlier than the oldest workspace: auto-enrolment refused');
      return neg('misconfigured_cutover');
    }

    const r = await enrol({ workspaceId: id, via: 'auto_signup', by: 'system' }, deps);
    return { enrolled: true, reason: r.alreadyEnrolled ? 'raced' : 'eligible' };
  } catch (err) {
    logOnce(deps, 'auto-error', 'auto-enrolment check failed:', err && err.message);
    return none('error');
  }
}

module.exports = {
  getGateState, buildGateState, invalidate, clearCache,
  getState, ensureState, ensureConnection, recomputeSubscription,
  enrol, unenrol, unenrolAll, adminActivate, adminDeactivate, autoEnrolIfEligible, getOldestWorkspace,
  POSITIVE_TTL_MS, NEGATIVE_TTL_MS, STALE_MAX_MS,
};
