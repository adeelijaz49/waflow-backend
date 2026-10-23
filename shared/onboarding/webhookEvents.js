'use strict';
// Merchant-WABA events on the existing POST /webhook (DB design 6.9, hunk E3 in server.js):
//
//   enabled()          config.enabled(), a synchronous env read (the hunk short-circuits on it)
//   intercept(req)     splits req.body.entry into merchant entries (processed here, then REMOVED from the body)
//                      and everything else (left for the legacy handler, byte-identical). Resolves true only
//                      when nothing is left for the legacy handler.
//   handleEntry(...)   per-field handlers of one merchant entry
//
// A merchant entry is one whose entry.id, or any changes[].value.metadata.phone_number_id, matches a
// WhatsAppConnection row (positive lookup, 60 s memo including negatives). Rows are never deleted, so a
// disconnected WABA stays matched and is DROPPED: it never falls into the oldest workspace. When two rows carry the
// same id (a WABA handed from one workspace to another) the LIVE row wins; only when every match is disconnected is the entry dropped.
// TRUST: payload content updates stored state ONLY when req.metaSignature === 'valid'; any other event is a
// hint that just sets nextCheckAt = now (the poller then reads the truth from Graph with the stored token).
// `messages` are acknowledged and dropped with a counter (merchant inboxes are not part of this build, D5).
// Nothing here stores message content; tokens and phone numbers are never logged.
//
// BOUNDS (reviews R7-02 / R2-01 / R2-02 / R1-F1, F3): POST /webhook is PUBLIC and was acknowledged before this code runs, so an
// anonymous caller must not be able to turn one request into unbounded database work or memory:
//   * a request whose signature is not 'valid' looks at the FIRST 20 entries only (the legacy handler reads entry[0] only; the rest
//     stays in body.entry untouched), never claims an OnboardingInbound ledger row and costs at most one tiny hint write per workspace
//     per 30 s; its uncached lookups share a per-process budget per minute;
//   * a valid signature (only Meta can make one) processes up to 1,000 entries, each DISTINCT id looked up once;
//   * only digit-only ids of 5 to 30 characters are looked up or memoised (anything else is simply "not a merchant");
//   * the memo evicts expired entries and has a hard size cap (oldest first); changes per entry are capped;
//   * every lookup is raced against a 1.5 s timeout that FAILS OPEN (the entry stays with the legacy flow, nothing is cached) and a
//     hung database stops further lookups of that request.
const crypto = require('crypto');
const config = require('./config');
const metaConfig = require('./metaConfig');
const statusRefresh = require('./statusRefresh');
const failOpen = require('./failOpen');

const MEMO_TTL_MS = 60 * 1000;
const MEMO_MAX = 2000;
const COUNTER_FLUSH_MS = 24 * 60 * 60 * 1000; // webhook_dropped rows: one per workspace, code and UTC day (see countDropped)
const MAX_PHONE_IDS = 10;
const MAX_UNSIGNED_ENTRIES = 20;
const MAX_SIGNED_ENTRIES = 1000;
const MAX_CHANGES = 200;
const UNSIGNED_LOOKUPS_PER_MIN = 300;
const HINT_MIN_GAP_MS = 30 * 1000;
const ID_RE = /^\d{5,30}$/;
const MAX_RAW_ID_LENGTH = 64;
const RETRY_MAX_ATTEMPTS = 3;
const NOT_CONNECTED = ['disconnected', 'not_connected'];

/** account_update events that mean our access to the WABA is gone (-> needsReconnect + reason). */
const REVOKE_EVENTS = Object.freeze({
  PARTNER_REMOVED: 'PARTNER_REMOVED',
  PARTNER_APP_UNINSTALLED: 'APP_UNINSTALLED',
  ACCOUNT_DELETED: 'WABA_DELETED',
  DISABLED_UPDATE: 'PARTNER_REMOVED',
  ACCOUNT_OFFBOARDED: 'PARTNER_REMOVED',
});
/** account_update events that put the connection in needs_attention. */
const ATTENTION_EVENTS = Object.freeze(['ACCOUNT_VIOLATION', 'ACCOUNT_RESTRICTION']);
/** account_update events that make us read the truth again. */
const REFRESH_EVENTS = Object.freeze(['ACCOUNT_RECONNECTED', 'PARTNER_ADDED', 'PARTNER_APP_INSTALLED']);

function enabled() { return config.enabled(); }

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const idStr = (v) => (v === undefined || v === null ? '' : String(v));
const cleanCode = (v, max = 60) => idStr(v).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, max);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function get(obj, path) { return path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj); }

/** Only a string or a number can be an id; anything else (objects, arrays, booleans) is ignored. Over-long strings are cut to a harmless marker. */
function rawId(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v !== '') return v.length > MAX_RAW_ID_LENGTH ? v.slice(0, MAX_RAW_ID_LENGTH + 1) : v;
  return null;
}

function changesOf(entry) {
  return Array.isArray(entry && entry.changes) ? entry.changes.slice(0, MAX_CHANGES) : [];
}

function collectPhoneIds(entry) {
  const out = [];
  for (const c of changesOf(entry)) {
    const p = rawId(c && c.value && c.value.metadata && c.value.metadata.phone_number_id);
    if (p !== null) {
      if (!out.includes(p)) out.push(p);
      if (out.length >= MAX_PHONE_IDS) break;
    }
  }
  return out;
}

/** The merchant row to use among the rows that carry one id: a connected one, else any non-disconnected one, else a disconnected one. */
function pickLive(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  if (!list.length) return null;
  const rank = (r) => (config.CONNECTED_LIKE.includes(r.status) ? 0 : (NOT_CONNECTED.includes(r.status) ? 2 : 1));
  const best = list.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)[0].r;
  return { _id: best._id, workspaceId: idStr(best.workspaceId), status: best.status };
}

/**
 * @param {object} [deps] { Connection, Inbound, analytics, notifications, state, meta, vault, connect, statusRefresh,
 *   starterTemplates, now, log, platformWabaId, platformPhoneId, dropUnknown, sync }
 */
function createWebhookEvents(deps = {}) {
  const now = () => { const v = deps.now ? deps.now() : Date.now(); return v instanceof Date ? v.getTime() : Number(v); };
  const Conn = () => deps.Connection || require('../../models/WhatsAppConnection');
  const Inbound = () => deps.Inbound || require('../../models/OnboardingInbound');
  const refreshMod = () => deps.statusRefresh || statusRefresh;
  const templatesMod = () => (deps.starterTemplates ? deps.starterTemplates : require('./starterTemplates'));
  const analytics = () => deps.analytics || require('./analytics');
  const notifications = () => deps.notifications || require('./notifications');
  const log = (...a) => (deps.log ? deps.log(...a) : config.safeLog('warn', '[onboarding webhook]', ...a));
  const platformWaba = () => (deps.platformWabaId !== undefined ? deps.platformWabaId : (process.env.WA_WABA_ID ? String(process.env.WA_WABA_ID).trim() : null));
  const platformPhone = () => (deps.platformPhoneId !== undefined ? deps.platformPhoneId : (process.env.WA_PHONE_ID ? String(process.env.WA_PHONE_ID).trim() : null));
  const dropUnknown = () => (deps.dropUnknown !== undefined ? deps.dropUnknown : config.dropUnknownWaba());

  const lookupTimeoutMs = () => (Number.isFinite(deps.lookupTimeoutMs) && deps.lookupTimeoutMs > 0 ? deps.lookupTimeoutMs : failOpen.TIMEOUT_MS);
  const unsignedLookupsPerMin = () => (Number.isFinite(deps.unsignedLookupsPerMin) && deps.unsignedLookupsPerMin >= 0 ? deps.unsignedLookupsPerMin : UNSIGNED_LOOKUPS_PER_MIN);

  const memo = new Map(); // `${type}:${id}` -> { value: {_id, workspaceId, status}|null, expires }; insertion order = age
  const counters = new Map(); // `${ws}:${code}` -> { pending, lastFlush }
  const hinted = new Map(); // workspaceId -> ms of the last hint write (unsigned traffic: one write per workspace per 30 s)
  const budget = { start: 0, used: 0 }; // uncached lookups of requests without a valid signature, per minute and process
  const stats = { dropped: 0 };

  const clearMemo = () => memo.clear();

  function memoGet(k, t) {
    const hit = memo.get(k);
    if (!hit) return undefined;
    if (hit.expires > t) return hit;
    memo.delete(k);
    return undefined;
  }
  /** Insert (newest last). At the cap: expired entries go first, then the oldest ones: the memo can never hold more than MEMO_MAX keys. */
  function memoPut(k, value, t) {
    memo.delete(k);
    if (memo.size >= MEMO_MAX) {
      for (const [key, v] of memo) { if (v.expires <= t) memo.delete(key); else break; }
      while (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
    }
    const rec = { value, expires: t + MEMO_TTL_MS };
    memo.set(k, rec);
    return rec;
  }
  function takeBudget(t) {
    if (!budget.start || t - budget.start >= 60 * 1000) { budget.start = t; budget.used = 0; }
    if (budget.used >= unsignedLookupsPerMin()) return false;
    budget.used += 1;
    return true;
  }
  /** Per-request state: the request-local "seen" map (each DISTINCT id is looked up once per request) and the hung-database breaker. */
  const newCtx = (signed) => ({ signed: !!signed, seen: new Map(), dbDown: false });

  /**
   * One lookup. Only digit-only ids of 5-30 characters are looked up or memoised (anything else is "not a merchant"). Several rows
   * can carry one id (a WABA handed over between workspaces): the live one wins. Throws on a database error or timeout (never cached).
   */
  async function lookup(type, id, ctx) {
    if (!ID_RE.test(id)) return null;
    const k = `${type}:${id}`;
    const local = ctx.seen.get(k);
    if (local) return local.value;
    const t = now();
    const hit = memoGet(k, t);
    if (hit) { ctx.seen.set(k, hit); return hit.value; }
    if (ctx.dbDown) return null; // the database did not answer a moment ago: the rest of this request stays with the legacy flow
    if (!ctx.signed && !takeBudget(t)) return null; // anonymous traffic shares a per-minute budget of uncached lookups
    const field = type === 'waba' ? 'ids.wabaId' : 'ids.phoneNumberId';
    let rows;
    try {
      rows = await failOpen.withTimeout(() => Conn().find({ [field]: id }).select('workspaceId status').limit(5).lean(), lookupTimeoutMs(), 'connection lookup');
    } catch (err) {
      if (err && err.code === 'ONB_LOOKUP_TIMEOUT') ctx.dbDown = true;
      throw err;
    }
    const rec = memoPut(k, pickLive(rows), now());
    ctx.seen.set(k, rec);
    return rec.value;
  }

  /** { kind: 'platform' | 'merchant' | 'unknown', conn?, phoneIds } */
  async function classify(entry, ctx = newCtx(false)) {
    if (!isObj(entry)) return { kind: 'platform', phoneIds: [] };
    const id = rawId(entry.id);
    const phoneIds = collectPhoneIds(entry);
    const pw = platformWaba();
    const pp = platformPhone();
    if (id && pw && id === pw) return { kind: 'platform', phoneIds };
    if (!id && !phoneIds.length) return { kind: 'platform', phoneIds };
    if (!id && pp && phoneIds.every((p) => p === pp)) return { kind: 'platform', phoneIds };
    const keys = [];
    if (id) keys.push(['waba', id]);
    for (const p of phoneIds) keys.push(['phone', p]);
    for (const [type, v] of keys) {
      let hit = null;
      try { hit = await lookup(type, v, ctx); } catch (err) {
        log('connection lookup failed:', err && err.code);
        failOpen.logFailOpen('webhookEvents', err);
        continue; // a failed lookup never turns an entry into a merchant entry; it stays with the legacy flow
      }
      if (hit) return { kind: 'merchant', conn: hit, phoneIds };
    }
    return { kind: 'unknown', phoneIds };
  }

  // ── counters (webhook_dropped) ────────────────────────────────────────────
  // One webhook_dropped row per (workspace, code, UTC day): a busy merchant number would otherwise write a row every few minutes for
  // ever and use up the per-workspace event budget (R7-09). The rows carry the count of drops since the previous row.
  async function countDropped(ws, code, reason, n = 1) {
    stats.dropped += n;
    if (!ws) return;
    const k = `${ws}:${code}`;
    const t = now();
    const c = counters.get(k) || { pending: 0, lastFlush: null };
    c.pending += n;
    counters.set(k, c);
    if (counters.size > 5000) counters.clear();
    if (c.lastFlush === null || t - c.lastFlush >= COUNTER_FLUSH_MS || new Date(t).getUTCDate() !== new Date(c.lastFlush).getUTCDate()) {
      const count = c.pending;
      c.pending = 0;
      c.lastFlush = t;
      try { await analytics().track(ws, { type: 'webhook_dropped', code, reason, meta: { attempt: count } }); } catch (_) { /* never blocks */ }
    }
  }

  // ── handlers (one per change.field) ───────────────────────────────────────
  async function loadConn(ws) {
    return Conn().findOne({ workspaceId: ws }).lean();
  }
  /** Untrusted events only ask for a poll: one tiny write per workspace per 30 s and process, however many such events arrive. */
  async function hint(ws) {
    const t = now();
    const last = hinted.get(ws);
    if (last !== undefined && t - last < HINT_MIN_GAP_MS) return 'hint';
    if (hinted.size >= 5000) hinted.clear();
    hinted.set(ws, t);
    await Conn().updateOne({ workspaceId: ws }, { $set: { nextCheckAt: new Date(t) } });
    return 'hint';
  }

  async function accountUpdate(value, ctx) {
    const event = cleanCode(value && value.event);
    if (!event) return 'ignored';
    const known = REVOKE_EVENTS[event] || ATTENTION_EVENTS.includes(event) || REFRESH_EVENTS.includes(event);
    if (!known) return 'ignored';
    if (!ctx.trusted) return hint(ctx.ws);
    if (REVOKE_EVENTS[event]) {
      const r = await refreshMod().markNeedsReconnect(ctx.ws, REVOKE_EVENTS[event], deps);
      return r && r.changed ? 'reconnect' : 'reconnect_noop';
    }
    if (ATTENTION_EVENTS.includes(event)) {
      const r = await refreshMod().markNeedsAttention(ctx.ws, { code: event }, deps, { eventKey: ctx.entryTime });
      return r && r.changed ? 'attention' : 'attention_noop';
    }
    await refreshMod().refreshConnection(ctx.ws, deps);
    return 'refresh';
  }

  async function phoneNumberNameUpdate(value, ctx) {
    const decision = cleanCode(value && value.decision, 20);
    if (!['APPROVED', 'REJECTED', 'DEFERRED', 'PENDING'].includes(decision)) return 'ignored';
    if (!ctx.trusted) return hint(ctx.ws);
    const conn = await loadConn(ctx.ws);
    if (!conn) return 'no_connection';
    const prev = conn.displayName || {};
    const requested = typeof (value && value.requested_verified_name) === 'string' ? value.requested_verified_name.trim().slice(0, 200) : '';
    const name = requested || prev.newName || '';
    let facts;
    if (decision === 'APPROVED') facts = { nameStatus: 'APPROVED' };
    else if (decision === 'REJECTED') facts = name ? { newName: name, newNameStatus: 'DECLINED' } : { nameStatus: 'DECLINED' };
    else facts = name ? { newName: name, newNameStatus: 'PENDING_REVIEW' } : { nameStatus: 'PENDING_REVIEW' };
    const dn = refreshMod().computeDisplayName(prev, facts, new Date(now()));
    if (!dn) return 'ignored';
    const set = { ...dn.set };
    const unset = { ...dn.unset };
    if (decision === 'APPROVED') {
      if (name) { set['display.verifiedName'] = name; set['displayName.requested'] = name; }
    } else if (decision === 'REJECTED') {
      const reason = cleanCode(value && value.rejection_reason, 60);
      set['displayName.rejectionReason'] = Object.prototype.hasOwnProperty.call(metaConfig.NAME_REJECTION_KEYS, reason) ? reason : 'UNKNOWN';
      set['displayName.decision'] = 'REJECTED';
      delete unset['displayName.decision'];
    }
    if (decision !== 'REJECTED' && !unset['displayName.rejectionReason']) unset['displayName.rejectionReason'] = 1;
    await refreshMod().commitPatch(conn, set, unset, deps);
    return decision.toLowerCase();
  }

  async function tierUpdate(value, ctx) {
    const raw = value && (value.current_limit !== undefined && value.current_limit !== null ? value.current_limit : value.max_daily_conversations_per_business);
    if (raw === undefined || raw === null || raw === '') return 'ignored';
    if (!ctx.trusted) return hint(ctx.ws);
    const tier = metaConfig.tierFromRaw(raw);
    if (!tier.raw) return 'ignored';
    const conn = await loadConn(ctx.ws);
    if (!conn) return 'no_connection';
    const t = new Date(now());
    await refreshMod().commitPatch(conn, {
      'messagingLimit.raw': tier.raw, 'messagingLimit.tierNumber': tier.tierNumber, 'messagingLimit.checkedAt': t, 'messagingLimit.lastEventAt': t,
    }, {}, deps);
    return 'tier';
  }

  async function accountAlerts(value, ctx) {
    const info = isObj(value && value.alert_info) ? value.alert_info : null;
    if (!info) return 'ignored';
    const type = cleanCode(info.alert_type);
    if (!type) return 'ignored';
    if (!ctx.trusted) return hint(ctx.ws);
    const status = cleanCode(info.alert_status, 20) || 'ACTIVE';
    const severity = cleanCode(info.alert_severity, 20) || 'INFORMATIONAL';
    const conn = await loadConn(ctx.ws);
    if (!conn) return 'no_connection';
    const current = (Array.isArray(get(conn, 'health.issues')) ? conn.health.issues : []).filter((i) => i && i.code !== type);
    if (status !== 'NONE') current.push({ entityType: cleanCode(value.entity_type, 30) || 'ALERT', code: type });
    await Conn().updateOne({ _id: conn._id }, { $set: { 'health.issues': current.slice(-10) } });
    if (status !== 'NONE') {
      const needsAction = /^INCREASED_CAPABILITIES_ELIGIBILITY_(DEFERRED|FAILED|NEED_MORE_INFO)$/.test(type);
      const sev = severity === 'CRITICAL' ? 'action' : (severity === 'WARNING' || needsAction ? 'warning' : 'info');
      try {
        await notifications().notify({
          workspaceId: ctx.ws, kind: 'account_alert', dedupeKey: `alert:${type}:${status}:${ctx.entryTime}`,
          params: { code: type, severity: severity.toLowerCase() }, severity: sev, actionPath: statusRefresh.PATHS.approvals,
          email: sev === 'warning' || sev === 'action', // needs action -> e-mail too; an informational alert stays in the app
        });
      } catch (_) { /* never blocks */ }
    }
    return 'alert';
  }

  async function templateUpdate(value, ctx, category) {
    if (!ctx.trusted) return 'ignored';
    let mod;
    try { mod = templatesMod(); } catch (err) { log('starterTemplates unavailable:', err && err.code); return 'unavailable'; }
    if (!mod || typeof mod.applyTemplateStatusUpdate !== 'function') { log('starterTemplates.applyTemplateStatusUpdate missing: skipped'); return 'unavailable'; }
    const reasonRaw = (value && value.rejection_info && value.rejection_info.reason) || (value && value.reason);
    const reason = reasonRaw && String(reasonRaw).toUpperCase() !== 'NONE' ? String(reasonRaw).slice(0, 80) : undefined;
    const recommendationRaw = value && value.rejection_info && value.rejection_info.recommendation;
    const args = {
      workspaceId: ctx.ws,
      templateId: value && value.message_template_id !== undefined && value.message_template_id !== null ? String(value.message_template_id) : undefined,
      name: typeof (value && value.message_template_name) === 'string' ? value.message_template_name.slice(0, 200) : undefined,
      language: typeof (value && value.message_template_language) === 'string' ? value.message_template_language.slice(0, 20) : undefined,
    };
    if (category) {
      // template_category_update: the new category, no status
      args.category = cleanCode(value && (value.new_category || value.correct_category), 30) || undefined;
    } else {
      args.statusRaw = value && value.event ? String(value.event).toUpperCase().slice(0, 40) : null;
      args.reason = reason;
      if (typeof recommendationRaw === 'string' && recommendationRaw.trim()) args.recommendation = recommendationRaw.trim().slice(0, 300);
      const cat = cleanCode(value && value.message_template_category, 30);
      if (cat) args.category = cat;
    }
    if (!args.templateId && !args.name) return 'ignored';
    await mod.applyTemplateStatusUpdate(args);
    return category ? 'template_category' : 'template_status';
  }

  async function dispatch(field, value, ctx) {
    switch (field) {
      case 'account_update': return accountUpdate(value, ctx);
      case 'phone_number_name_update': return phoneNumberNameUpdate(value, ctx);
      case 'phone_number_quality_update':
      case 'business_capability_update': return tierUpdate(value, ctx);
      case 'account_alerts': return accountAlerts(value, ctx);
      case 'message_template_status_update': return templateUpdate(value, ctx, false);
      case 'template_category_update': return templateUpdate(value, ctx, true);
      case 'messages': await countDropped(ctx.ws, 'WEBHOOK_MESSAGES_DROPPED', 'merchant_inbox_not_enabled'); return 'dropped';
      default: return 'ignored';
    }
  }

  /**
   * Handle the changes of ONE merchant entry (no de-duplication here: intercept() does it).
   * @param {object} entry the Meta webhook entry
   * @param {{workspaceId:string, signature?:string}} ctx signature 'valid' = the request signature verified
   * @returns {Promise<{outcomes:string[], failed:boolean, errorCode?:string}>}
   */
  async function handleEntry(entry, ctx = {}) {
    const ws = idStr(ctx.workspaceId);
    const changes = changesOf(entry);
    const entryTime = entry && entry.time ? idStr(entry.time).replace(/[^0-9]/g, '').slice(0, 14) || sha256(JSON.stringify(entry)).slice(0, 12) : sha256(JSON.stringify(entry || {})).slice(0, 12);
    const c = { ws, trusted: ctx.signature === 'valid', entryTime };
    const outcomes = [];
    let failed = null;
    for (const change of changes) {
      const field = change && typeof change.field === 'string' && /^[a-z_]{1,60}$/.test(change.field) ? change.field : 'unknown';
      try {
        outcomes.push(`${field}:${await dispatch(field, (change && change.value) || {}, c)}`);
      } catch (err) {
        failed = failed || err;
        outcomes.push(`${field}:failed`);
        log(`handler ${field} failed:`, err && err.code, err && err.message);
      }
    }
    return { outcomes, failed: !!failed, errorCode: failed ? (cleanCode(failed.code, 40) || 'HANDLER_ERROR') : undefined };
  }

  /** Claim the de-duplication row; false = duplicate (already processed / being processed). */
  async function claim(key, ws) {
    const t = new Date(now());
    try {
      await Inbound().create({ _id: key, source: 'meta', type: 'entry', workspaceId: ws, status: 'processing', attempts: 1, startedAt: t });
      return true;
    } catch (err) {
      if (!(err && err.code === 11000)) throw err;
      const retry = await Inbound().findOneAndUpdate(
        { _id: key, status: 'failed', attempts: { $lt: RETRY_MAX_ATTEMPTS } },
        { $set: { status: 'processing', startedAt: t }, $inc: { attempts: 1 } },
      );
      return !!retry;
    }
  }

  async function processMerchantEntry(entry, conn, signature) {
    const ws = conn.workspaceId;
    try {
      const current = await loadConn(ws);
      if (!current || NOT_CONNECTED.includes(current.status)) { await countDropped(ws, 'WEBHOOK_DISCONNECTED_DROPPED', 'disconnected_waba'); return; }
      const changes = changesOf(entry);
      if (changes.length && changes.every((c) => c && c.field === 'messages')) {
        await countDropped(ws, 'WEBHOOK_MESSAGES_DROPPED', 'merchant_inbox_not_enabled'); // no ledger row: nothing to de-duplicate
        return;
      }
      if (signature !== 'valid') {
        // An entry without a valid signature can only ask for a poll (hint): no ledger row (R2-02: an anonymous caller must not grow
        // the never-deleted OnboardingInbound collection) and the hint itself is coalesced per workspace.
        await handleEntry(entry, { workspaceId: ws, signature });
        return;
      }
      const key = `meta:${sha256(JSON.stringify(entry))}`;
      if (!(await claim(key, ws))) return;
      const res = await handleEntry(entry, { workspaceId: ws, signature });
      const status = res.failed ? 'failed' : (res.outcomes.every((o) => /:(ignored|dropped)$/.test(o)) ? 'ignored' : 'done');
      await Inbound().updateOne({ _id: key }, {
        $set: { status, outcome: res.outcomes.join(',').slice(0, 300), finishedAt: new Date(now()), ...(res.errorCode ? { errorCode: res.errorCode } : {}) },
      });
    } catch (err) {
      log('merchant entry failed:', err && err.code, err && err.message);
    }
  }

  /**
   * Hunk E3. Resolves true when every entry was a merchant entry (nothing is left for the legacy handler).
   * Flag off, no entries, or no merchant entry -> false and req.body is left untouched. Never rejects (a failure is logged, throttled, and
   * the legacy handler simply goes on: hunk E3 would swallow it silently).
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  function intercept(req) {
    if (!config.enabled()) return Promise.resolve(false);
    const body = req && req.body;
    if (!isObj(body) || !Array.isArray(body.entry) || body.entry.length === 0) return Promise.resolve(false);
    return interceptEntries(req, body).catch((err) => { failOpen.logFailOpen('webhookEvents', err); return false; });
  }

  async function interceptEntries(req, body) {
    // Only a VALID signature (Meta's) earns the generous cap; everything else looks at the first few entries only (the legacy handler
    // reads entry[0] only) and the rest stays in body.entry, untouched and never claimed.
    const signed = req.metaSignature === 'valid';
    const all = body.entry;
    const cap = signed ? MAX_SIGNED_ENTRIES : MAX_UNSIGNED_ENTRIES;
    const slice = all.length > cap ? all.slice(0, cap) : all;
    const rest = all.length > cap ? all.slice(cap) : [];
    const ctx = newCtx(signed);
    const merchant = [];
    const keep = [];
    let dropped = 0;
    for (const entry of slice) {
      const c = await classify(entry, ctx);
      if (c.kind === 'merchant') { merchant.push({ entry, conn: c.conn }); continue; }
      if (c.kind === 'unknown' && dropUnknown() && platformPhone() && c.phoneIds.length && c.phoneIds.every((p) => p !== platformPhone())) {
        dropped += 1; // a phone id that is neither the platform's nor a merchant's (opt-in, requires WA_PHONE_ID)
        continue;
      }
      keep.push(entry);
    }
    if (!merchant.length && !dropped) return false;
    if (dropped) { stats.dropped += dropped; log(`dropped ${dropped} entr${dropped === 1 ? 'y' : 'ies'} of an unknown WABA`); }
    body.entry = rest.length ? keep.concat(rest) : keep;
    const signature = req.metaSignature;
    const processing = (async () => {
      for (const m of merchant) await processMerchantEntry(m.entry, m.conn, signature);
    })().catch((err) => log('merchant processing failed:', err && err.code));
    try { Object.defineProperty(req, 'onboardingProcessing', { value: processing, enumerable: false, configurable: true }); } catch (_) { /* test doubles may be frozen */ }
    if (deps.sync) await processing;
    return body.entry.length === 0;
  }

  /**
   * Does ANY of the first entries of this (parsed) webhook payload positively match a merchant WhatsAppConnection (entry id or
   * metadata.phone_number_id)? Uses the SAME memoised, bounded lookup as intercept() and the SAME slice (this is only called for a payload
   * whose signature is NOT valid, so it looks at the first 20 entries). Platform entries, entries without ids and unknown WABAs are NOT a
   * match; a failing lookup is NOT a match (the caller passes the payload through). Never throws. Used by webhookSignature to decide
   * whether a bad signature may be rejected (ruling 1).
   * @param {object} body parsed JSON body
   * @returns {Promise<boolean>}
   */
  async function matchesMerchant(body) {
    try {
      if (!isObj(body) || !Array.isArray(body.entry)) return false;
      const ctx = newCtx(false);
      for (const entry of body.entry.slice(0, MAX_UNSIGNED_ENTRIES)) {
        const c = await classify(entry, ctx);
        if (c.kind === 'merchant') return true;
      }
    } catch (_) { /* a failing lookup is never a match */ }
    return false;
  }

  return { enabled, intercept, handleEntry, classify, matchesMerchant, clearMemo, stats, _counters: counters, _memo: memo };
}

const real = createWebhookEvents();
const pick = (deps) => (deps ? createWebhookEvents(deps) : real);

module.exports = {
  enabled,
  /** intercept(req, deps?) - see header; deps only for tests */
  intercept: (req, deps) => pick(deps).intercept(req),
  /** handleEntry(entry, ctx, deps?) */
  handleEntry: (entry, ctx, deps) => pick(deps).handleEntry(entry, ctx),
  // additions (documented in B1-d.md)
  createWebhookEvents,
  clearMemo: () => real.clearMemo(),
  /** matchesMerchant(body, deps?) - true when a payload entry belongs to a connected merchant WABA (ruling 1) */
  matchesMerchant: (body, deps) => pick(deps).matchesMerchant(body),
  REVOKE_EVENTS, ATTENTION_EVENTS, REFRESH_EVENTS,
  /** The bounds of the public POST /webhook path (see the header). */
  LIMITS: Object.freeze({ MAX_UNSIGNED_ENTRIES, MAX_SIGNED_ENTRIES, MAX_CHANGES, MEMO_MAX, UNSIGNED_LOOKUPS_PER_MIN, HINT_MIN_GAP_MS }),
};
