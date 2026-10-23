'use strict';
// Status refresh of a merchant's WhatsApp connection (DB design 6.5 / 6.6).
//
//   refreshConnection(connOrWorkspaceId, deps?)  reads the truth from Graph with the stored (encrypted)
//                                                merchant token and stores a derived, secret-free view
//   snapshot(conn)                               pure view model (level, cause, per-item values)
//   connectionLevel(conn)                        'connected' | 'needs_attention' | 'reconnect_needed' | 'not_connected'
//   nextCheckDelayMs(conn, extras?)              15 min while anything is waiting, 6 h when settled, back-off on failures
//   markNeedsReconnect(workspaceId, reason, ...) shared by 190 handling, webhooks and the deauthorize callback
//
// Rules kept here (and tested):
//   * Graph is read ONLY with the merchant token, through the injected `meta` client (INTERFACES 2.16).
//     Every field of every response is optional: absence never overwrites a stored value (field negotiation:
//     a code-100 error naming an optional field retries ONCE with the core list).
//   * A 190 / is_valid:false flips needsReconnect exactly once and sends exactly one notification + e-mail
//     (idempotent key reconnect:<reason>:<connectedAt>).
//   * Transitions write OnboardingEvent{status_change} and notify only on change; keys contain the new value.
//   * Tokens, PINs and full phone numbers are never logged or returned.
const crypto = require('crypto');
const config = require('./config');
const metaConfig = require('./metaConfig');
const { OnbError } = require('./errors');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const CADENCE = Object.freeze({
  WAITING_MS: 15 * MIN,
  SETTLED_MS: 6 * HOUR,
  BACKOFF_BASE_MS: 15 * MIN,
  BACKOFF_MAX_MS: 6 * HOUR,
  TOKEN_WARN_MS: 7 * DAY,
});

/** Statuses the scheduler polls (INTERFACES / DB 6.5). */
const POLLABLE_STATUSES = Object.freeze(['connected', 'needs_attention', 'waba_only', 'connecting']);
const CONNECTED_LIKE = config.CONNECTED_LIKE;
const NOT_CONNECTED_STATUSES = Object.freeze(['not_connected', 'disconnected', 'connecting']);
const PHONE_FIELDS_NEGOTIABLE = Object.freeze([
  'name_status', 'new_display_name', 'new_name_status', 'code_verification_status', 'platform_type', 'is_on_biz_app',
  'whatsapp_business_manager_messaging_limit', 'throughput',
]);
const WABA_FIELDS_CORE = 'id,name,currency,business_verification_status,health_status';
const WABA_FIELDS_NEGOTIABLE = Object.freeze([
  'primary_funding_id', 'message_template_namespace', 'ownership_type', 'country', 'status', 'whatsapp_business_manager_messaging_limit',
]);
/** health.issues codes (set by webhooks or the poll) that put the connection in needs_attention. */
const ATTENTION_ISSUE_CODES = Object.freeze(['ACCOUNT_VIOLATION', 'ACCOUNT_RESTRICTION']);
const PATHS = Object.freeze({ connect: '/setup/connect', approvals: '/setup/approvals' });
const NETWORK_KINDS = Object.freeze(['network', 'unreachable']);

// ── small helpers ───────────────────────────────────────────────────────────
function dep(deps, name, load) { return deps && deps[name] ? deps[name] : load(); }
const Conn = (deps) => dep(deps, 'Connection', () => require('../../models/WhatsAppConnection'));
const Tpl = (deps) => dep(deps, 'Template', () => require('../../models/OnboardingTemplate'));
const getVault = (deps) => dep(deps, 'vault', () => require('./tokenVault'));
const getNotifications = (deps) => dep(deps, 'notifications', () => require('./notifications'));
const getAnalytics = (deps) => dep(deps, 'analytics', () => require('./analytics'));
const getStateMod = (deps) => dep(deps, 'state', () => require('./state'));
const getMeta = (deps) => dep(deps, 'meta', () => require('./metaClient').getDefaultClient());
const getConnect = (deps) => dep(deps, 'connect', () => require('./connect'));
const log = (deps, ...args) => (deps && deps.log ? deps.log(...args) : config.safeLog('warn', '[onboarding status]', ...args));

function nowMs(deps) {
  const v = deps && deps.now ? deps.now() : Date.now();
  return v instanceof Date ? v.getTime() : Number(v);
}
const toDate = (t) => new Date(t);
function ms(v) {
  if (v === undefined || v === null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}
const iso = (v) => { const t = ms(v); return t === null ? null : new Date(t).toISOString(); };
const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
/** Read a Graph field by its snake_case name (a camelCase twin is accepted: the client may normalise). */
function pick(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined) return obj[key];
  const c = camel(key);
  return obj[c] !== undefined ? obj[c] : undefined;
}
const str = (v, max = 200) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, max) : undefined);
const digits = (v) => String(v === undefined || v === null ? '' : v).replace(/\D/g, '');
const sha8 = (v) => crypto.createHash('sha256').update(String(v || '').trim().toLowerCase()).digest('hex').slice(0, 8);
const idStr = (v) => (v === undefined || v === null ? '' : String(v));
/**
 * Epoch of a RECURRING condition (review R7-04): the stamp of the connection document version the change was detected on (updatedAt, else the
 * last status check, else connectedAt). Everyone who read the SAME version (a poll and a webhook racing) gets the same key, so one change is
 * announced once; the next occurrence of the same condition (after a recovery, every write bumps the stamp) is a new key and notifies again.
 */
function epochOf(doc) {
  return ms(doc && doc.updatedAt) || ms(doc && doc.lastStatusCheckAt) || ms(doc && doc.connectedAt) || 0;
}
const displayNameKey = (mapped, name, epoch) => `displayname:${mapped}:${sha8(name)}${epoch === undefined ? '' : `:${epoch}`}`;

/** Copy-on-write set/unset along a dotted path (the lean doc stays untouched). */
function setPath(obj, path, value, remove) {
  const keys = path.split('.');
  const root = { ...obj };
  let cur = root;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    cur[k] = { ...(cur[k] && typeof cur[k] === 'object' && !(cur[k] instanceof Date) ? cur[k] : {}) };
    cur = cur[k];
  }
  const last = keys[keys.length - 1];
  if (remove) delete cur[last]; else cur[last] = value;
  return root;
}
function withPatch(doc, set, unset) {
  let out = { ...doc };
  for (const [k, v] of Object.entries(set || {})) out = setPath(out, k, v, false);
  for (const k of Object.keys(unset || {})) out = setPath(out, k, undefined, true);
  return out;
}
function get(obj, path) {
  return path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}

// ── Graph error classification ──────────────────────────────────────────────
/** Error kind: the client's `kind`, else metaErrors.classify, else a local fallback by Graph code. */
function kindOf(err, deps) {
  if (err && typeof err.kind === 'string' && err.kind && err.kind !== 'unknown') return err.kind;
  try {
    const mod = dep(deps, 'metaErrors', () => require('./metaErrors'));
    const c = mod.classify(err);
    if (c && c.kind) return c.kind;
  } catch (_) { /* stub or not loadable: fall back below */ }
  const n = Number(err && err.code);
  if (n === 190 || n === 102) return 'reconnect';
  if (n === 10 || (n >= 200 && n <= 299)) return 'permission';
  if ([4, 17, 32, 613, 80007, 130429, 131056].includes(n)) return 'retry';
  if (err && typeof err.code === 'string' && /^E[A-Z]+/.test(err.code)) return 'network';
  return 'unknown';
}
const KIND_TO_CODE = Object.freeze({
  reconnect: 'META_TOKEN_REVOKED', permission: 'META_PERMISSION_MISSING', retry: 'META_RATE_LIMITED',
  network: 'META_UNREACHABLE', unreachable: 'META_UNREACHABLE', register_rate: 'META_RATE_LIMITED', unknown: 'META_ERROR',
});
const appCodeOf = (kind) => KIND_TO_CODE[kind] || 'META_ERROR';

/** Map a Graph/client error to the OnbError the HTTP layer returns (never the raw Graph text). */
function toOnbError(err, deps) {
  if (err instanceof OnbError) return err;
  return new OnbError(appCodeOf(kindOf(err, deps)));
}

// ── mappings ────────────────────────────────────────────────────────────────
function healthIssues(hs) {
  const out = [];
  const entities = hs && Array.isArray(hs.entities) ? hs.entities : [];
  for (const e of entities) {
    if (out.length >= 10) break;
    const entityType = (str(pick(e, 'entity_type'), 30) || 'UNKNOWN').toUpperCase();
    const errors = Array.isArray(e && e.errors) ? e.errors : [];
    if (errors.length) {
      for (const er of errors) {
        if (out.length >= 10) break;
        const raw = pick(er, 'error_code') !== undefined ? pick(er, 'error_code') : (er && er.code);
        out.push({ entityType, code: str(raw, 40) || 'UNKNOWN' });
      }
    } else {
      const lvl = pick(e, 'can_send_message');
      if (lvl && lvl !== 'AVAILABLE') out.push({ entityType, code: String(lvl).slice(0, 40) });
    }
  }
  return out;
}

/**
 * Display-name state from the Graph phone facts and the stored state. Pure.
 * displayName.checkedAt means "when the decision last CHANGED" (the 14 day re-register window starts there).
 * @returns {{set:object, unset:object, mapped:string}|null} null = nothing readable
 */
function computeDisplayName(prev, facts, nowDate) {
  const p = prev || {};
  const ns = facts.nameStatus ? String(facts.nameStatus).toUpperCase() : undefined;
  const nns = facts.newNameStatus ? String(facts.newNameStatus).toUpperCase() : undefined;
  const newName = facts.newName ? String(facts.newName).trim().slice(0, 200) : undefined;
  if (ns === undefined && nns === undefined && newName === undefined) return null;

  const set = {};
  const unset = {};
  let mapped;
  if (ns !== undefined) set['displayName.nameStatusRaw'] = ns;

  if (newName) {
    // Meta still reports a pending / decided change
    set['displayName.newName'] = newName;
    if (nns) set['displayName.newNameStatusRaw'] = nns;
    mapped = metaConfig.mapNameStatus(nns || ns);
    if (mapped === 'needs_you') set['displayName.decision'] = 'REJECTED';
    else if (mapped === 'done') set['displayName.decision'] = 'APPROVED';
    else if (mapped === 'waiting') unset['displayName.decision'] = 1;
  } else if (p.newName && p.decision === 'REJECTED') {
    // Meta dropped the rejected request; the rejection stays visible until the merchant resubmits
    mapped = 'needs_you';
  } else if (p.newName && (ns === undefined || metaConfig.mapNameStatus(ns) === 'done')) {
    // the pending change got approved (new_display_name is gone and the name status is approved)
    mapped = ns === undefined ? (p.mapped || 'unknown') : 'done';
    if (mapped === 'done') {
      set['displayName.decision'] = 'APPROVED';
      unset['displayName.newNameStatusRaw'] = 1;
    }
  } else {
    mapped = metaConfig.mapNameStatus(ns);
    if (mapped === 'needs_you' && ns === 'DECLINED') set['displayName.decision'] = 'REJECTED';
    if (mapped === 'done' && !p.newName) unset['displayName.decision'] = 1;
  }
  set['displayName.mapped'] = mapped;
  const decisionAfter = set['displayName.decision'] !== undefined ? set['displayName.decision'] : (unset['displayName.decision'] ? undefined : p.decision);
  const changed = p.mapped !== mapped
    || (ns !== undefined && p.nameStatusRaw !== ns)
    || (nns !== undefined && p.newNameStatusRaw !== nns)
    || decisionAfter !== p.decision;
  if (changed) set['displayName.checkedAt'] = nowDate;
  return { set, unset, mapped };
}

// ── templates (read-only aggregate, also used by approvals.js) ──────────────
const PROBLEM_STATUSES = ['REJECTED', 'DISABLED', 'PAUSED'];
// A row blocked for a reason Meta never saw (invalid text, ceiling reached) has no catalogue text of its own. The catalogue is the
// frontend's (onboarding.approvals.templates.{summary,rejected,queued,arBlocked,submit,show,hide} exist, nothing else), so both use
// the nearest existing key: the one for a problem the merchant has to look at. Never build a key from a reason name.
const BLOCKED_REASON_KEYS = Object.freeze({ invalid: 'onboarding.approvals.templates.rejected', limit: 'onboarding.approvals.templates.rejected' });
/**
 * Aggregate starter-template rows. Only English library rows decide the row status (DB 6.6).
 * @param {object[]} rows OnboardingTemplate rows
 */
function templateAggregate(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const en = list.filter((r) => r && r.language === 'en' && r.source !== 'setup_test');
  let approved = 0; let waiting = 0; let problem = 0; let rejectedReason = null; let reasonKey = null;
  for (const r of en) {
    const st = String(r.metaStatus || r.metaStatusRaw || '').toUpperCase();
    if (Object.prototype.hasOwnProperty.call(BLOCKED_REASON_KEYS, r.blockedReason)) {
      problem += 1; reasonKey = reasonKey || BLOCKED_REASON_KEYS[r.blockedReason];
    } else if (st === 'APPROVED') approved += 1;
    else if (PROBLEM_STATUSES.includes(st)) {
      problem += 1; reasonKey = reasonKey || 'onboarding.approvals.templates.rejected';
      if (!rejectedReason && r.rejectedReason) rejectedReason = String(r.rejectedReason).slice(0, 80);
    } else waiting += 1;
  }
  let waitingAll = 0;
  for (const r of list) {
    if (!r || r.blockedReason) continue;
    const st = String(r.metaStatus || r.metaStatusRaw || '').toUpperCase();
    if (st !== 'APPROVED' && !PROBLEM_STATUSES.includes(st)) waitingAll += 1;
  }
  let status;
  let key = reasonKey;
  if (!en.length) { status = 'waiting'; key = 'onboarding.approvals.templates.queued'; }
  else if (problem) status = 'needs_you';
  else if (waiting) { status = 'waiting'; key = en.every((r) => !r.metaStatus && !r.metaStatusRaw) ? 'onboarding.approvals.templates.queued' : null; }
  else { status = 'done'; key = null; }
  return { total: en.length, approved, waiting, problem, status, reasonKey: key, rejectedReason, waitingAll };
}

async function templatesWaiting(workspaceId, deps) {
  try {
    if (deps && typeof deps.templatesWaiting === 'function') return Number(await deps.templatesWaiting(workspaceId)) || 0;
    const rows = await Tpl(deps).find({ workspaceId }).select('language source metaStatus metaStatusRaw blockedReason').lean();
    return templateAggregate(rows).waitingAll;
  } catch (_) {
    return 0;
  }
}

// ── cause / level / snapshot ────────────────────────────────────────────────
/** First needs_attention cause derived ONLY from stored fields, or null. */
function attentionCause(conn, t) {
  const c = conn || {};
  const exp = ms(c.tokenExpiresAt);
  if (exp !== null && exp - t < CADENCE.TOKEN_WARN_MS) return { code: 'TOKEN_EXPIRING', path: PATHS.connect };
  if (c.webhook && c.webhook.subscribed === false) return { code: 'WEBHOOK_NOT_SUBSCRIBED', path: PATHS.connect };
  if (c.lastError && c.lastError.kind === 'permission') return { code: 'PERMISSION_MISSING', path: PATHS.connect };
  const canSend = get(c, 'health.canSend');
  if (canSend === 'BLOCKED') return { code: 'HEALTH_BLOCKED', path: PATHS.approvals };
  if (canSend === 'LIMITED') return { code: 'HEALTH_LIMITED', path: PATHS.approvals };
  const issues = Array.isArray(get(c, 'health.issues')) ? c.health.issues : [];
  const acct = issues.find((i) => i && ATTENTION_ISSUE_CODES.includes(i.code));
  if (acct) return { code: acct.code, path: PATHS.approvals };
  const dn = c.displayName || {};
  if (dn.mapped === 'needs_you' && (dn.decision === 'REJECTED' || dn.nameStatusRaw === 'DECLINED')) return { code: 'NAME_DECLINED', path: PATHS.approvals };
  if (c.registration && c.registration.lastErrorCode && !c.registration.registeredAt) return { code: 'REGISTRATION_FAILED', path: PATHS.connect };
  const phoneIssue = issues.find((i) => i && i.entityType === 'PHONE_NUMBER' && typeof i.code === 'string' && i.code.startsWith('PHONE_'));
  if (phoneIssue) return { code: phoneIssue.code, path: PATHS.connect };
  return null;
}

/** Cause of the current level: { code, path } or null when connected / not connected. */
function causeOf(conn, t) {
  if (!conn) return null;
  if (conn.needsReconnect || conn.status === 'reconnect_required') {
    return { code: conn.reconnectReason || 'RECONNECT_REQUIRED', path: PATHS.connect };
  }
  if (conn.status === 'waba_only') return { code: 'NUMBER_PENDING', path: PATHS.connect };
  if (conn.status === 'error') return { code: 'CONNECT_ERROR', path: PATHS.connect };
  if (CONNECTED_LIKE.includes(conn.status)) {
    const cause = attentionCause(conn, t);
    if (cause) return cause;
    if (conn.status === 'needs_attention') return { code: 'ATTENTION', path: PATHS.approvals };
  }
  return null;
}

/**
 * @param {object|null} conn lean WhatsAppConnection
 * @param {number|Date} [now]
 * @returns {'connected'|'needs_attention'|'reconnect_needed'|'not_connected'}
 */
function connectionLevel(conn, now) {
  if (!conn) return 'not_connected';
  if (conn.needsReconnect || conn.status === 'reconnect_required') return 'reconnect_needed';
  if (!conn.status || NOT_CONNECTED_STATUSES.includes(conn.status)) return 'not_connected';
  if (conn.status === 'waba_only' || conn.status === 'error') return 'needs_attention';
  if (CONNECTED_LIKE.includes(conn.status)) return causeOf(conn, now === undefined ? Date.now() : ms(now)) ? 'needs_attention' : 'connected';
  return 'not_connected';
}

/** Secret-free view of a connection document. Never includes the token, the PIN or the full number. */
function snapshot(conn, now) {
  const t = now === undefined ? Date.now() : ms(now);
  const level = connectionLevel(conn, t);
  if (!conn) {
    return {
      level, status: 'not_connected', cause: null, causeCode: null, causePath: null, numberMasked: null, last4: null, verifiedName: null,
      needsReconnect: false, reconnectReason: null,
      verification: { raw: null, mapped: null, checkedAt: null },
      displayName: { requested: null, newName: null, raw: null, newRaw: null, decision: null, rejectionReason: null, mapped: null, checkedAt: null },
      payment: { status: 'unknown', confirmedAt: null }, messagingLimit: { raw: null, tierNumber: null, checkedAt: null },
      quality: { ratingRaw: null }, health: { canSend: null, issues: [] }, webhook: { subscribed: null },
      token: { expiresAt: null, isValid: null, nearExpiry: false }, lastStatusCheckAt: null, nextCheckAt: null,
      checkFailures: 0, lastError: null, checkedAt: null,
    };
  }
  const exp = ms(conn.tokenExpiresAt);
  const dn = conn.displayName || {};
  const shown = conn.display && (conn.display.displayPhoneNumber || conn.display.last4);
  const tier = get(conn, 'messagingLimit.tierNumber');
  const cause = level === 'connected' || level === 'not_connected' ? null : causeOf(conn, t);
  return {
    level,
    status: conn.status || 'not_connected',
    cause,
    causeCode: cause ? cause.code : null, // flat aliases of cause{code,path}: the names /state.connection uses
    causePath: cause ? cause.path : null,
    numberMasked: shown ? config.maskPhone(shown) : null,
    last4: (conn.display && conn.display.last4) || null,
    verifiedName: (conn.display && conn.display.verifiedName) || null,
    needsReconnect: !!conn.needsReconnect,
    reconnectReason: conn.reconnectReason || null,
    verification: { raw: get(conn, 'verification.businessRaw') || null, mapped: get(conn, 'verification.mapped') || null, checkedAt: iso(get(conn, 'verification.checkedAt')) },
    displayName: {
      requested: dn.requested || null, newName: dn.newName || null, raw: dn.nameStatusRaw || null, newRaw: dn.newNameStatusRaw || null,
      decision: dn.decision || null, rejectionReason: dn.rejectionReason || null, mapped: dn.mapped || null, checkedAt: iso(dn.checkedAt),
    },
    payment: { status: get(conn, 'payment.status') || 'unknown', confirmedAt: iso(get(conn, 'payment.confirmedAt')) },
    messagingLimit: { raw: get(conn, 'messagingLimit.raw') || null, tierNumber: tier === undefined ? null : tier, checkedAt: iso(get(conn, 'messagingLimit.checkedAt')) },
    quality: { ratingRaw: get(conn, 'quality.ratingRaw') || null },
    health: { canSend: get(conn, 'health.canSend') || null, issues: Array.isArray(get(conn, 'health.issues')) ? conn.health.issues.map((i) => ({ entityType: i.entityType, code: i.code })) : [] },
    webhook: { subscribed: get(conn, 'webhook.subscribed') === undefined ? null : get(conn, 'webhook.subscribed') },
    token: { expiresAt: iso(conn.tokenExpiresAt), isValid: conn.tokenIsValid === undefined ? null : conn.tokenIsValid, nearExpiry: exp !== null && exp - t < CADENCE.TOKEN_WARN_MS },
    lastStatusCheckAt: iso(conn.lastStatusCheckAt),
    nextCheckAt: iso(conn.nextCheckAt),
    checkFailures: Number(conn.checkFailures) || 0,
    lastError: conn.lastError && (conn.lastError.code || conn.lastError.kind) ? { code: conn.lastError.code || null, kind: conn.lastError.kind || null, at: iso(conn.lastError.at) } : null,
    checkedAt: iso(conn.lastStatusCheckAt),
  };
}

/** Something is waiting on Meta (or on a probe) -> poll fast; otherwise the connection is settled. */
function isWaiting(conn, extras) {
  const c = conn || {};
  if (c.status === 'waba_only' || c.status === 'connecting') return true;
  if (get(c, 'verification.mapped') === 'waiting') return true;
  if (get(c, 'displayName.mapped') === 'waiting') return true;
  // payment can only change by polling when the probe is on; otherwise it waits for the merchant's own confirmation
  if (metaConfig.paymentProbe() && (get(c, 'payment.status') || 'unknown') === 'unknown') return true;
  if (extras && Number(extras.templatesWaiting) > 0) return true;
  return false;
}

/**
 * Delay to the next poll: exponential back-off (15 min, 30, 60 ... capped at 6 h) while checks fail,
 * 15 min while something is waiting, 6 h when settled.
 * @param {object} conn
 * @param {{templatesWaiting?:number}} [extras]
 */
function nextCheckDelayMs(conn, extras) {
  const failures = Number(conn && conn.checkFailures) || 0;
  if (failures > 0) return Math.min(CADENCE.BACKOFF_MAX_MS, CADENCE.BACKOFF_BASE_MS * (2 ** Math.min(failures - 1, 10)));
  return isWaiting(conn, extras) ? CADENCE.WAITING_MS : CADENCE.SETTLED_MS;
}

// ── side effects ────────────────────────────────────────────────────────────
async function track(deps, workspaceId, evt) {
  try { await getAnalytics(deps).track(String(workspaceId), evt); } catch (_) { /* analytics never blocks */ }
}
async function notify(deps, args) {
  try { return await getNotifications(deps).notify(args); } catch (_) { return null; }
}
function invalidate(deps, workspaceId) {
  try { getStateMod(deps).invalidate(String(workspaceId)); } catch (_) { /* cache only */ }
}

/** lastError of a reconnect flip: catalogue code + kind, never the Graph text. */
function lastErrorFor(err, t) {
  const out = { code: 'META_TOKEN_REVOKED', kind: 'reconnect', at: toDate(t) };
  if (err && err.subcode !== undefined && err.subcode !== null) out.subcode = String(err.subcode).slice(0, 20);
  return out;
}

/**
 * Flag a connection as needing a reconnect (token revoked/expired, partner removed, deauthorized ...).
 * Idempotent: only the FIRST flip writes, tracks and notifies (exactly one in-app notification + e-mail).
 * @param {string} workspaceId
 * @param {string} reason TOKEN_REVOKED|TOKEN_EXPIRED|APP_UNINSTALLED|PARTNER_REMOVED|WABA_DELETED|DEAUTHORIZED
 * @param {object} [deps]
 * @param {{err?:object, conn?:object}} [opts] err = the Graph error (handed to connect.reportGraphError afterwards)
 * @returns {Promise<{changed:boolean, skipped?:string}>}
 */
async function markNeedsReconnect(workspaceId, reason, deps, opts = {}) {
  const ws = idStr(workspaceId);
  const conn = opts.conn || await Conn(deps).findOne({ workspaceId: ws }).lean();
  if (!conn) return { changed: false, skipped: 'no_connection' };
  if (conn.status === 'disconnected' || conn.status === 'not_connected') return { changed: false, skipped: 'not_connected' };
  const t = nowMs(deps);
  const res = await Conn(deps).updateOne(
    // a disconnect that happened while the caller was talking to Meta must not be turned into "reconnect needed" (R7-07)
    { _id: conn._id, needsReconnect: { $ne: true }, status: { $nin: ['disconnected', 'not_connected'] } },
    { $set: { needsReconnect: true, reconnectReason: reason, status: 'reconnect_required', nextCheckAt: toDate(t + CADENCE.SETTLED_MS), lastError: lastErrorFor(opts.err, t) } },
  );
  const changed = !!res && (res.modifiedCount > 0 || res.nModified > 0);
  if (opts.err) {
    try { await getConnect(deps).reportGraphError(ws, opts.err); } catch (e) { log(deps, 'reportGraphError unavailable:', e && e.code); }
  }
  if (!changed) return { changed: false, skipped: 'already_flagged' };
  invalidate(deps, ws);
  await track(deps, ws, { type: 'status_change', step: 'connect', code: `RECONNECT_${String(reason).replace(/[^A-Z0-9_]/g, '_')}`.slice(0, 60), reason: 'needs_reconnect' });
  await notify(deps, {
    workspaceId: ws, kind: 'reconnect_needed', dedupeKey: `reconnect:${reason}:${ms(conn.connectedAt) || 0}`,
    params: { reason }, email: true, severity: 'action', actionPath: PATHS.connect,
  });
  return { changed: true };
}

/**
 * needs_attention caused by an event (violation / restriction): stores an issue, flips the status, notifies once.
 * @param {string} workspaceId
 * @param {{code:string, entityType?:string}} issue
 * @param {object} [deps]
 * @param {{conn?:object, eventKey?:string|number}} [opts]
 */
async function markNeedsAttention(workspaceId, issue, deps, opts = {}) {
  const ws = idStr(workspaceId);
  const conn = opts.conn || await Conn(deps).findOne({ workspaceId: ws }).lean();
  if (!conn || !CONNECTED_LIKE.includes(conn.status)) return { changed: false };
  const issues = (Array.isArray(get(conn, 'health.issues')) ? conn.health.issues : []).filter((i) => i && i.code !== issue.code);
  issues.push({ entityType: issue.entityType || 'WABA', code: issue.code });
  const t = nowMs(deps);
  const wrote = await Conn(deps).updateOne({ _id: conn._id, status: { $in: CONNECTED_LIKE } }, { $set: { status: 'needs_attention', 'health.issues': issues.slice(-10), nextCheckAt: toDate(t) } });
  if (wrote && wrote.matchedCount === 0) return { changed: false }; // disconnected meanwhile: never resurrected (R7-07)
  invalidate(deps, ws);
  await track(deps, ws, { type: 'status_change', step: 'connect', code: issue.code, reason: 'needs_attention' });
  await notify(deps, {
    workspaceId: ws, kind: 'account_alert', dedupeKey: `alert:${issue.code}:${opts.eventKey || t}`,
    params: { code: issue.code }, severity: 'warning', actionPath: PATHS.approvals, email: true, // needs action: e-mail too (first insert only)
  });
  return { changed: true };
}

/**
 * What changed between two connection views: [{ track, notify? }] (pure).
 * Spec Step 4: "Send an email and an in-app notification when anything changes (approved, rejected, needs action)": every
 * notice built here carries `email: true` (the notification store sends it on the FIRST insert of its dedupe key only).
 */
function transitions(prev, next) {
  const out = [];
  const ep = epochOf(prev);
  const prevV = get(prev, 'verification.mapped');
  const newV = get(next, 'verification.mapped');
  if (prevV && newV && prevV !== newV) {
    out.push({
      track: { type: 'status_change', step: 'approvals', code: `VERIFICATION_${newV.toUpperCase()}`, reason: `verification_${prevV}_to_${newV}` },
      notify: { kind: 'verification_changed', dedupeKey: `verification:${newV}:${ep}`, params: { status: newV }, severity: newV === 'done' ? 'success' : newV === 'needs_you' ? 'warning' : 'info', actionPath: PATHS.approvals, email: true },
    });
  }
  const prevD = get(prev, 'displayName.mapped');
  const newD = get(next, 'displayName.mapped');
  if (prevD && newD && prevD !== newD) {
    const entry = { track: { type: 'status_change', step: 'approvals', code: `DISPLAY_NAME_${newD.toUpperCase()}`, reason: `name_${prevD}_to_${newD}` } };
    if (newD === 'done' || newD === 'needs_you') {
      const dn = next.displayName || {};
      const name = dn.newName || dn.requested || get(next, 'display.verifiedName') || '';
      entry.notify = { kind: 'display_name_decided', dedupeKey: displayNameKey(newD, name, ep), params: { status: newD }, severity: newD === 'done' ? 'success' : 'warning', actionPath: PATHS.approvals, email: true };
    }
    out.push(entry);
  }
  const prevL = get(prev, 'messagingLimit.raw');
  const newL = get(next, 'messagingLimit.raw');
  if (prevL && newL && prevL !== newL) {
    out.push({
      track: { type: 'status_change', step: 'approvals', code: 'LIMIT_CHANGED', meta: { tier: String(newL).slice(0, 40) } },
      notify: { kind: 'messaging_limit_changed', dedupeKey: `limit:${newL}:${ep}`, params: { limit: String(newL).slice(0, 40) }, severity: 'info', actionPath: PATHS.approvals, email: true },
    });
  }
  return out;
}

/** Track + notify everything that changed between two views of a connection (never throws). */
async function emitNotices(before, after, wsId, deps, t) {
  const levelBefore = connectionLevel(before, t);
  const levelAfter = connectionLevel(after, t);
  const notices = transitions(before, after);
  if (levelBefore !== levelAfter) {
    const cause = causeOf(after, t);
    notices.push({
      track: { type: 'status_change', step: 'connect', code: `LEVEL_${levelAfter.toUpperCase()}`, reason: `from_${levelBefore}_to_${levelAfter}` },
      // severity warning = needs action = e-mail too. One real change, one e-mail: a declined display name already has its own
      // display_name_decided mail (transitions above), so this alert stays in the app for that cause.
      notify: levelAfter === 'needs_attention' && cause
        ? { kind: 'account_alert', dedupeKey: `level:needs_attention:${cause.code}:${epochOf(before)}`, params: { code: cause.code }, severity: 'warning', actionPath: cause.path, email: cause.code !== 'NAME_DECLINED' }
        : undefined,
    });
  }
  if (before.webhook && before.webhook.subscribed === false && after.webhook && after.webhook.subscribed === true) {
    notices.push({ track: { type: 'status_change', step: 'connect', code: 'WEBHOOK_RESUBSCRIBED', reason: 'webhook_restored' } });
  }
  for (const n of notices) {
    if (n.track) await track(deps, wsId, n.track);
    if (n.notify) await notify(deps, { workspaceId: wsId, ...n.notify });
  }
  if (before.status !== after.status) invalidate(deps, wsId);
}

/**
 * Apply a stored-state patch (webhook events), derive the status from the causes, and track/notify the
 * transitions. Returns the merged view.
 * @param {object} conn lean WhatsAppConnection (before)
 * @param {object} set $set paths
 * @param {object} [unset] $unset paths
 * @param {object} [deps]
 */
async function commitPatch(conn, set, unset, deps) {
  const t = nowMs(deps);
  const s = { ...(set || {}) };
  const u = { ...(unset || {}) };
  let merged = withPatch(conn, s, u);
  if (!merged.needsReconnect && CONNECTED_LIKE.includes(conn.status)) {
    const newStatus = attentionCause(merged, t) ? 'needs_attention' : 'connected';
    if (newStatus !== conn.status) { s.status = newStatus; merged = { ...merged, status: newStatus }; }
  }
  await Conn(deps).updateOne({ _id: conn._id }, { $set: s, ...(Object.keys(u).length ? { $unset: u } : {}) });
  await emitNotices(conn, merged, idStr(conn.workspaceId), deps, t);
  return merged;
}

// ── refreshConnection ───────────────────────────────────────────────────────
/**
 * Live refresh of one connection: debug_token, WABA, phone, subscribed apps (DB 6.5).
 * Graph problems are recorded first (lastError, checkFailures, back-off). When NOTHING could be read the original
 * Graph error is then re-thrown (so POST /connection/refresh can map it), unless deps.throwOnFailure === false.
 * @param {string|{workspaceId:*}} connOrWorkspaceId
 * @param {object} [deps] { Connection, Template, meta, vault, notifications, analytics, state, connect, metaErrors, appId, paymentProbe, now, log, templatesWaiting, throwOnFailure }
 * @returns {Promise<object>} snapshot + { fieldsDegraded, checks, skipped? }
 */
async function refreshConnection(connOrWorkspaceId, deps = {}) {
  const isObj = connOrWorkspaceId && typeof connOrWorkspaceId === 'object' && connOrWorkspaceId.workspaceId !== undefined;
  const wsId = idStr(isObj ? connOrWorkspaceId.workspaceId : connOrWorkspaceId);
  const t = nowMs(deps);
  const now = toDate(t);
  const Connection = Conn(deps);
  const conn = await Connection.findOne({ workspaceId: wsId }).select('+tokenEncrypted').lean();
  if (!conn) return { ...snapshot(null, t), skipped: 'no_connection', fieldsDegraded: false };

  const skippedView = (skipped) => ({ ...snapshot(conn, t), skipped, fieldsDegraded: false });
  const reschedule = async (delayMs) => {
    const due = ms(conn.nextCheckAt);
    if (due === null || due <= t) {
      try { await Connection.updateOne({ _id: conn._id }, { $set: { nextCheckAt: toDate(t + delayMs) } }); } catch (_) { /* best effort */ }
    }
  };
  if (!POLLABLE_STATUSES.includes(conn.status)) return skippedView('not_pollable');
  if (conn.needsReconnect) { await reschedule(CADENCE.SETTLED_MS); return skippedView('needs_reconnect'); }
  if (conn.status === 'connecting') { await reschedule(CADENCE.WAITING_MS); return skippedView('connecting'); }
  if (!conn.tokenEncrypted) {
    await markNeedsReconnect(wsId, 'TOKEN_REVOKED', deps, { conn });
    const after = await Connection.findOne({ workspaceId: wsId }).lean();
    return { ...snapshot(after || conn, t), skipped: 'no_token', fieldsDegraded: false };
  }

  let token;
  try {
    token = getVault(deps).decrypt(conn.tokenEncrypted, { workspaceId: wsId, purpose: 'token' });
  } catch (err) {
    // our key problem, not the merchant's: record it, back off, never flip needsReconnect
    const failures = (Number(conn.checkFailures) || 0) + 1;
    const next = { ...conn, checkFailures: failures };
    await Connection.updateOne({ _id: conn._id }, {
      $set: { checkFailures: failures, lastStatusCheckAt: now, nextCheckAt: toDate(t + nextCheckDelayMs(next)), lastError: { code: (err && err.code) || 'DECRYPTION_FAILED', kind: 'config', at: now } },
    });
    log(deps, 'token not readable:', err && err.code);
    return { ...snapshot(withPatch(conn, { checkFailures: failures }), t), skipped: 'token_unreadable', fieldsDegraded: false };
  }

  const meta = getMeta(deps);
  const ids = conn.ids || {};
  const set = {};
  const unset = {};
  const checks = { ok: 0, failed: 0 };
  const errors = []; // [{ err, kind }]
  let reconnect = null; // { reason, err }
  let networkDown = false;
  let fieldsDegraded = false;
  const dnFacts = {};
  let tierRaw;
  let phoneStatus;

  const attempt = async (fn) => {
    try { const v = await fn(); checks.ok += 1; return { ok: true, v }; } catch (err) {
      checks.failed += 1;
      const kind = kindOf(err, deps);
      errors.push({ err, kind });
      if (kind === 'reconnect' && !reconnect) reconnect = { reason: Number(err && err.subcode) === 463 ? 'TOKEN_EXPIRED' : 'TOKEN_REVOKED', err };
      if (NETWORK_KINDS.includes(kind)) networkDown = true;
      return { ok: false, err };
    }
  };
  const namesField = (err, fields) => Number(err && err.code) === 100 && fields.some((f) => String((err && err.message) || '').includes(f));
  const forgetLastFailure = () => { errors.pop(); checks.failed -= 1; };

  // 1. debug_token: validity and expiry
  const dbg = await attempt(() => meta.debugToken(token));
  if (dbg.ok) {
    const raw = dbg.v;
    const d = raw && raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : (raw || {});
    const dbgErr = d.error;
    const expSec = Number(pick(d, 'expires_at')) || 0;
    if (pick(d, 'is_valid') === false || (dbgErr && Number(dbgErr.code) === 190)) {
      const expired = (expSec > 0 && expSec * 1000 <= t) || Number(dbgErr && dbgErr.subcode) === 463;
      reconnect = { reason: expired ? 'TOKEN_EXPIRED' : 'TOKEN_REVOKED', err: { code: 190, subcode: dbgErr && dbgErr.subcode, kind: 'reconnect', message: 'token is not valid' } };
    } else {
      set.tokenIsValid = true;
      set.tokenCheckedAt = now;
      set.tokenExpiresAt = expSec > 0 ? toDate(expSec * 1000) : null;
      const da = Number(pick(d, 'data_access_expires_at')) || 0;
      if (da > 0) set.tokenDataAccessExpiresAt = toDate(da * 1000);
      const uid = str(pick(d, 'user_id'), 80);
      if (uid) set['ids.metaUserId'] = uid;
    }
  }

  if (!reconnect && !networkDown) {
    // 2. WABA: verification, health, tier, optional payment probe
    if (ids.wabaId) {
      let wres = await attempt(() => meta.getWaba(token, ids.wabaId));
      if (!wres.ok && !reconnect && namesField(wres.err, WABA_FIELDS_NEGOTIABLE)) {
        forgetLastFailure(); // the single negotiation retry replaces the failed attempt
        fieldsDegraded = true;
        wres = await attempt(() => meta.getWaba(token, ids.wabaId, WABA_FIELDS_CORE));
      }
      if (wres.ok) {
        const w = wres.v || {};
        if (w.fieldsDegraded === true) fieldsDegraded = true; // the client negotiated the field list down itself
        const vRaw = pick(w, 'business_verification_status');
        if (vRaw !== undefined && vRaw !== null) {
          set['verification.businessRaw'] = String(vRaw).slice(0, 40);
          set['verification.mapped'] = metaConfig.mapVerification(vRaw);
          set['verification.checkedAt'] = now;
        } else if (!get(conn, 'verification.mapped')) {
          set['verification.mapped'] = 'unknown';
        }
        const hs = pick(w, 'health_status');
        if (hs && typeof hs === 'object') {
          const cs = pick(hs, 'can_send_message');
          if (typeof cs === 'string' && metaConfig.HEALTH_MAP[cs.toUpperCase()]) set['health.canSend'] = metaConfig.HEALTH_MAP[cs.toUpperCase()];
          set['health.issues'] = healthIssues(hs);
          set['health.checkedAt'] = now;
        }
        const tr = pick(w, 'whatsapp_business_manager_messaging_limit');
        tierRaw = tr !== undefined && tr !== null ? tr : pick(w, 'messaging_limit_tier');
        const probe = deps.paymentProbe ? deps.paymentProbe() : metaConfig.paymentProbe();
        if (probe) {
          const fid = pick(w, 'primary_funding_id');
          set['payment.probeFundingIdPresent'] = !!fid;
          set['payment.checkedAt'] = now;
          if (fid && (get(conn, 'payment.status') || 'unknown') === 'unknown') set['payment.status'] = 'probe_positive';
        }
      }
    }

    // 3. phone: name status, quality, status
    if (!reconnect && !networkDown && ids.phoneNumberId) {
      let pres = await attempt(() => meta.getPhone(token, ids.phoneNumberId, metaConfig.PHONE_FIELDS_FULL));
      if (!pres.ok && !reconnect && namesField(pres.err, PHONE_FIELDS_NEGOTIABLE)) {
        forgetLastFailure();
        fieldsDegraded = true;
        pres = await attempt(() => meta.getPhone(token, ids.phoneNumberId, metaConfig.PHONE_FIELDS_CORE));
      }
      if (pres.ok) {
        const p = pres.v || {};
        if (p.fieldsDegraded === true) fieldsDegraded = true;
        const vn = str(pick(p, 'verified_name'), 200);
        if (vn) set['display.verifiedName'] = vn;
        const dpn = str(pick(p, 'display_phone_number'), 40);
        if (dpn) {
          set['display.displayPhoneNumber'] = dpn;
          const dg = digits(dpn);
          if (dg.length >= 4) set['display.last4'] = dg.slice(-4);
        }
        const qr = str(pick(p, 'quality_rating'), 20);
        if (qr) { set['quality.ratingRaw'] = qr; set['quality.checkedAt'] = now; }
        const pt = str(pick(p, 'platform_type'), 40);
        if (pt) set['ids.platformType'] = pt;
        const biz = pick(p, 'is_on_biz_app');
        if (typeof biz === 'boolean') set['ids.isOnBizApp'] = biz;
        phoneStatus = str(pick(p, 'status'), 40);
        Object.assign(dnFacts, {
          nameStatus: str(pick(p, 'name_status'), 40), newName: str(pick(p, 'new_display_name'), 200), newNameStatus: str(pick(p, 'new_name_status'), 40),
        });
        if (tierRaw === undefined || tierRaw === null) tierRaw = pick(p, 'whatsapp_business_manager_messaging_limit');
        if (tierRaw === undefined || tierRaw === null) tierRaw = pick(p, 'messaging_limit_tier');
      }
    }

    // 4. is our app still subscribed to the WABA's webhooks?
    if (!reconnect && !networkDown && ids.wabaId) {
      const appId = deps.appId !== undefined ? (typeof deps.appId === 'function' ? deps.appId() : deps.appId) : metaConfig.metaEsAppId();
      const isOurs = (rows) => {
        const list = Array.isArray(rows) ? rows : (rows && Array.isArray(rows.data) ? rows.data : []);
        if (!appId) return list.length > 0;
        return list.some((r) => {
          const a = (r && (r.whatsapp_business_api_data || r.whatsappBusinessApiData)) || r || {};
          return String(a.id) === String(appId);
        });
      };
      const sres = await attempt(() => meta.listSubscribedApps(token, ids.wabaId));
      if (sres.ok) {
        if (isOurs(sres.v)) {
          set['webhook.subscribed'] = true;
          if (conn.webhook && conn.webhook.subscribed === false) set['webhook.subscribedAt'] = now;
        } else {
          // lost: re-subscribe once, then confirm (never for the PLATFORM's own account: a subscribe call is a write to it)
          let healed = false;
          const sub = config.isPlatformAccount({ wabaId: ids.wabaId }) ? { ok: false } : await attempt(() => meta.subscribeApp(token, ids.wabaId));
          if (sub.ok) {
            const again = await attempt(() => meta.listSubscribedApps(token, ids.wabaId));
            healed = again.ok && isOurs(again.v);
          }
          set['webhook.subscribed'] = healed;
          if (healed) set['webhook.subscribedAt'] = now;
        }
        set['webhook.checkedAt'] = now;
      }
    }
  }

  // ── derive, persist, notify ───────────────────────────────────────────────
  if (tierRaw !== undefined && tierRaw !== null && tierRaw !== '') {
    const tier = metaConfig.tierFromRaw(tierRaw);
    if (tier.raw) {
      set['messagingLimit.raw'] = tier.raw;
      set['messagingLimit.tierNumber'] = tier.tierNumber;
      set['messagingLimit.checkedAt'] = now;
    }
  }
  const dn = Object.keys(dnFacts).length ? computeDisplayName(conn.displayName, dnFacts, now) : null;
  if (dn) { Object.assign(set, dn.set); Object.assign(unset, dn.unset); }
  if (phoneStatus && !reconnect) {
    const base = Array.isArray(set['health.issues']) ? set['health.issues'] : (Array.isArray(get(conn, 'health.issues')) ? conn.health.issues.slice() : []);
    const filtered = base.filter((i) => !(i && i.entityType === 'PHONE_NUMBER' && typeof i.code === 'string' && i.code.startsWith('PHONE_')));
    const upper = phoneStatus.toUpperCase();
    if (!['CONNECTED', 'PENDING', 'ONLINE'].includes(upper)) filtered.push({ entityType: 'PHONE_NUMBER', code: `PHONE_${upper.replace(/[^A-Z0-9]/g, '_')}`.slice(0, 40) });
    set['health.issues'] = filtered.slice(0, 10);
  }

  // failure bookkeeping: back-off only when NOTHING could be read
  if (reconnect) set.checkFailures = 0;
  else if (checks.ok === 0 && checks.failed > 0) set.checkFailures = (Number(conn.checkFailures) || 0) + 1;
  else set.checkFailures = 0;
  const lastFail = errors.length ? errors[errors.length - 1] : null;
  if (lastFail && !reconnect) {
    const lastError = { code: appCodeOf(lastFail.kind), kind: lastFail.kind, at: now };
    if (lastFail.err && lastFail.err.subcode !== undefined && lastFail.err.subcode !== null) lastError.subcode = String(lastFail.err.subcode).slice(0, 20);
    set.lastError = lastError;
  } else if (!lastFail && !reconnect) {
    unset.lastError = 1;
  }
  set.lastStatusCheckAt = now;

  let merged = withPatch(conn, set, unset);
  // status follows the derived cause (connected <-> needs_attention); waba_only is never touched here
  if (!reconnect && CONNECTED_LIKE.includes(conn.status)) {
    const newStatus = attentionCause(merged, t) ? 'needs_attention' : 'connected';
    if (newStatus !== conn.status) { set.status = newStatus; merged = { ...merged, status: newStatus }; }
  }
  set.nextCheckAt = toDate(t + nextCheckDelayMs(merged, { templatesWaiting: await templatesWaiting(wsId, deps) }));
  merged = { ...merged, nextCheckAt: set.nextCheckAt };

  // The write is conditional on what was READ (review R7-07): a disconnect, a reconnect or another refresh that happened while Graph was
  // answering changes status, disconnectedAt or tokenCheckedAt, and this (now stale) result is then dropped instead of overwriting it.
  const written = await Connection.updateOne(
    { _id: conn._id, status: conn.status, disconnectedAt: conn.disconnectedAt || null, tokenCheckedAt: conn.tokenCheckedAt || null },
    { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
  );
  if (written && written.matchedCount === 0) {
    let latest = null;
    try { latest = await Connection.findOne({ workspaceId: wsId }).lean(); } catch (_) { /* the view we have is enough */ }
    invalidate(deps, wsId);
    return { ...snapshot(latest || conn, t), skipped: 'changed_meanwhile', fieldsDegraded, checks: { ok: checks.ok, failed: checks.failed } };
  }

  if (reconnect) {
    await markNeedsReconnect(wsId, reconnect.reason, deps, { err: reconnect.err, conn });
    const after = await Connection.findOne({ workspaceId: wsId }).lean();
    if (after) merged = after;
    invalidate(deps, wsId);
  } else {
    await emitNotices(conn, merged, wsId, deps, t);
    if (conn.status === 'waba_only' && checks.ok > 0 && deps.resumeWabaOnly !== false) {
      // "WhatsApp account connected, number pending" is polled (DB 6.4): connect.resumeConnect looks for the number the
      // merchant may have added in Meta since (phone, register, details) and finishes the connection when it exists.
      try { await getConnect(deps).resumeConnect({ workspaceId: wsId, userId: idStr(conn.connectedByUserId), system: true }); } catch (err) { log(deps, 'resume of a waba_only connection:', err && err.code); }
      try { const after = await Connection.findOne({ workspaceId: wsId }).lean(); if (after) merged = after; } catch (_) { /* keep the view we have */ }
    }
  }
  // Nothing could be read at all (network down, rate limit, permission ...): the failure is stored above (lastError, back-off),
  // and the ORIGINAL Graph error is re-thrown so the HTTP layer can map it to a catalogue code. The scheduler passes
  // deps.throwOnFailure = false (it only needs the stored state). A reconnect flip is not thrown: the answer is the new level.
  if (!reconnect && checks.ok === 0 && checks.failed > 0 && deps.throwOnFailure !== false && errors.length) throw errors[0].err;
  return { ...snapshot(merged, t), fieldsDegraded, checks: { ok: checks.ok, failed: checks.failed } };
}

module.exports = {
  refreshConnection, snapshot, connectionLevel, nextCheckDelayMs,
  // additions (documented in B1-d.md)
  markNeedsReconnect, markNeedsAttention, templateAggregate, computeDisplayName, attentionCause, causeOf,
  kindOf, toOnbError, isWaiting, transitions, displayNameKey, epochOf, commitPatch, withPatch, CADENCE, POLLABLE_STATUSES, ATTENTION_ISSUE_CODES, PATHS,
};
