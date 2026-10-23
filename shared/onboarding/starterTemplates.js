'use strict';
// Starter templates on the MERCHANT's own WhatsApp Business account (DB design 2.6 / 6.7,
// DECISIONS D9). English is queued automatically; Arabic only when the merchant chose Arabic
// AND the key is not legal-sensitive. Rows live in OnboardingTemplate (deliberately NOT
// LocalizedTemplate rows: those are swept with the platform client).
//
// Nothing here ever sends to a customer. Every Graph call uses the MERCHANT token (decrypted
// per call with tokenVault, AAD-bound to the workspace) and the merchant's WABA id; the platform
// token and shared/localization's createMetaClient (platform credentials, dry-run mode) are
// never used. The Graph client comes from B1-c's metaClient (lazy) or deps.metaClient.
//
// Everything external is injectable through the trailing `deps` argument:
//   model / connModel / stateModel   mongoose models (OnboardingTemplate, WhatsAppConnection, OnboardingState)
//   metaClient   a client object (or () => client) with the DB 6.2 methods
//   http         Graph HTTP port handed to metaClient.createMetaGraphClient when metaClient is absent
//   vault        tokenVault-like { decrypt }
//   now          () => Date | number
//   notify, track, connect, metaErrors, getGateState, library   replace the lazily required modules
// Nothing is executed at require time (no timers, no DB, no network, no cached env).
const config = require('./config');
const { OnbError, CODES } = require('./errors');
const testTemplate = require('./testTemplate');

const TEST_KEY = testTemplate.TEST_TEMPLATE_KEY;
const LANGS = Object.freeze(['en', 'ar']);
const MAX_PER_TICK = 5; // submissions per workspace per call / tick
const MAX_ATTEMPTS = 5; // a queued row that failed this many times waits for a manual resubmit / admin
const STALE_CLAIM_MS = 10 * 60 * 1000; // a claim older than this is considered crashed
const POLL_INTERVAL_MS = 60 * 60 * 1000; // PENDING rows are re-read at most hourly
const META_TEMPLATE_LIMIT = 250; // unverified portfolio (AU4 7); the ceiling below is what we enforce
const ALWAYS_ENGLISH_ONLY = Object.freeze(['welcome_optin']); // the consent request: legal approves its Arabic first
const BLOCKED_REASONS = Object.freeze(['arabic_not_reviewed', 'legal', 'limit', 'invalid']);
const KEEP_STATUS_EVENTS = Object.freeze(['FLAGGED', 'LOCKED', 'UNLOCKED']); // webhook events that do not change the sendable state
const CATEGORIES = Object.freeze(['UTILITY', 'MARKETING', 'AUTHENTICATION']);
const CAMPAIGN_TYPE = Object.freeze({
  promotion_weekend: 'store_wide_offer',
  promotion_new_arrival: 'product_promotion',
  comeback: 'store_wide_offer',
  points_balance: 'loyalty_reminder',
});

// ── small helpers ───────────────────────────────────────────────────────────
const toDate = (v) => (v instanceof Date ? v : new Date(v));
function nowOf(deps) { return deps && typeof deps.now === 'function' ? toDate(deps.now()) : new Date(); }
function idStr(v) { return v === undefined || v === null ? '' : String(v); }
function numOf(v) { const n = Number(v); return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : null; }

const models = {
  template: (deps) => (deps && deps.model) || require('../../models/OnboardingTemplate'),
  conn: (deps) => (deps && deps.connModel) || require('../../models/WhatsAppConnection'),
  state: (deps) => (deps && deps.stateModel) || require('../../models/OnboardingState'),
};
const lib = (deps) => (deps && deps.library) || require('../localization/templateLibrary');
const constraints = () => require('../localization/metaConstraints');
const metaTemplates = () => require('../localization/metaTemplates');
const mergeFields = () => require('../localization/mergeFields');

/** The starter keys, read from config on every access (never cached at load). */
function starterKeys() { return config.starterTemplateKeys(); }

async function safe(label, fn) {
  try { return await fn(); } catch (err) {
    config.safeLog('warn', `[onboarding] starterTemplates ${label} failed:`, err && err.code ? err.code : (err && err.message));
    return undefined;
  }
}

function track(deps, workspaceId, evt) {
  return safe('track', async () => {
    if (deps && typeof deps.track === 'function') return deps.track(workspaceId, evt);
    return require('./analytics').track(workspaceId, evt);
  });
}

// ── legal / arabic rules ────────────────────────────────────────────────────
/** Keys whose Arabic copy needs the owner's lawyer first (library flag + the hard English-only list). */
function legalKeys(deps) {
  const set = new Set(ALWAYS_ENGLISH_ONLY);
  try {
    for (const row of lib(deps).listLibraryStrings()) {
      if (row && row.needsLegalApproval) {
        const m = /^library\.([a-z0-9_]+)\.ar\./.exec(String(row.key || ''));
        if (m) set.add(m[1]);
      }
    }
  } catch (_) { /* the hard list still applies */ }
  return set;
}

/**
 * Template spec of a key, or null when the key is unknown.
 * @returns {{key:string, source:string, category:string, title:{en:string,ar:string}, fields:string[], legal:boolean, variantFor:(l:string)=>object}|null}
 */
function getSpec(key, deps) {
  if (key === TEST_KEY) {
    return {
      key, source: 'setup_test', category: testTemplate.TEST_TEMPLATE_CATEGORY, title: testTemplate.TEST_TEMPLATE_TITLE,
      fields: [], legal: false, variantFor: (language) => testTemplate.buildTestTemplate(language),
    };
  }
  let entry = null;
  try { entry = lib(deps).getLibraryEntry(key); } catch (_) { entry = null; }
  if (!entry) return null;
  return {
    key, source: 'library', category: entry.category, title: entry.name, fields: entry.fields || [],
    legal: legalKeys(deps).has(key), variantFor: (language) => ({ language, ...entry.variants[language] }),
  };
}

function cleanEditText(raw, max) {
  return String(raw).replace(/\r\n?/g, '\n').replace(/[\u{0000}-\u{0008}\u{000B}\u{000C}\u{000E}-\u{001F}\u{007F}]/gu, '').trim().slice(0, max);
}

function occurrences(variant) {
  const mf = mergeFields();
  return [...mf.extractOccurrences(variant.header || ''), ...mf.extractOccurrences(variant.body || '')].sort();
}

/** Apply merchant edits (header/body/footer text only). Buttons and the set of merge fields can never change. */
function applyEdits(variant, edits, spec) {
  const out = { ...variant };
  if (edits.body !== undefined) {
    if (typeof edits.body !== 'string') throw new OnbError('VALIDATION_FAILED', { details: { reason: 'TEMPLATE_INVALID', errors: ['body_required'] } });
    out.body = cleanEditText(edits.body, 2000);
  }
  if (edits.header !== undefined) out.header = typeof edits.header === 'string' ? cleanEditText(edits.header, 200) || undefined : undefined;
  if (edits.footer !== undefined) out.footer = typeof edits.footer === 'string' ? cleanEditText(edits.footer, 200) || undefined : undefined;
  const before = occurrences(variant);
  const after = occurrences(out);
  if (before.length !== after.length || before.some((f, i) => f !== after[i])) {
    throw new OnbError('VALIDATION_FAILED', { details: { reason: 'TEMPLATE_FIELDS_CHANGED', fields: spec.fields } });
  }
  return out;
}

/**
 * Validate a (key, language, revision) and build the Meta submission. Never throws for an invalid
 * variant (returns { ok:false, errors }). English and Arabic codes are 'en' / 'ar' (never ar_SA).
 */
function buildPlan({ spec, workspaceId, language, revision, edits }, deps) {
  let variant = spec.variantFor(language);
  if (edits) variant = applyEdits(variant, edits, spec);
  const check = constraints().validateVariant(variant, { category: spec.category });
  if (!check.ok) return { ok: false, errors: check.errors.map((e) => e.code) };
  const mt = metaTemplates();
  let name;
  try { name = mt.buildTemplateName({ workspaceId: idStr(workspaceId), key: spec.key, language, revision }); } catch (_) { return { ok: false, errors: ['name_invalid'] }; }
  let payload;
  try { payload = mt.buildSubmissionPayload({ name, variant, category: spec.category }); } catch (_) { return { ok: false, errors: ['payload_invalid'] }; }
  payload.allow_category_change = true; // Meta default since 2025-04-09; the stored category follows what Meta returns
  return { ok: true, name, payload, variant, category: spec.category };
}

function desiredBlock({ spec, language, chosen, workspaceId }, deps) {
  if (language === 'ar') {
    if (spec.legal) return 'legal';
    if (!chosen) return 'arabic_not_reviewed';
  }
  const plan = buildPlan({ spec, workspaceId, language, revision: 1 }, deps);
  return plan.ok ? null : 'invalid';
}

async function readLanguages(workspaceId, deps) {
  const res = await safe('readLanguages', async () => {
    const doc = await models.state(deps).findOne({ workspaceId }).select('business.languages').lean();
    const langs = doc && doc.business && doc.business.languages;
    return Array.isArray(langs) ? langs : [];
  });
  return res || [];
}

// ── seeding (no Meta call) ──────────────────────────────────────────────────
/**
 * Queue OnboardingTemplate rows for the given keys x (en, ar). Idempotent (unique index
 * {workspaceId, key, language}); an existing not-yet-submitted row whose block no longer applies
 * (the merchant added Arabic later) is unblocked. NO Graph call.
 * @param {string} workspaceId
 * @param {string[]} keys
 * @param {object} [deps]
 * @returns {Promise<{created:number, existing:number, total:number}>}
 */
async function seedRows(workspaceId, keys, deps = {}) {
  const T = models.template(deps);
  const chosen = (await readLanguages(workspaceId, deps)).includes('ar');
  const existingRows = await T.find({ workspaceId }).lean();
  const byKey = new Map(existingRows.map((r) => [`${r.key}|${r.language}`, r]));
  let created = 0;
  let existing = 0;
  let total = 0;
  for (const key of keys) {
    const spec = getSpec(key, deps);
    if (!spec) { config.safeLog('warn', '[onboarding] starterTemplates: unknown template key skipped', String(key).slice(0, 60)); continue; }
    for (const language of LANGS) {
      total += 1;
      const desired = desiredBlock({ spec, language, chosen, workspaceId }, deps);
      const cur = byKey.get(`${key}|${language}`);
      if (!cur) {
        try {
          const res = await T.updateOne(
            { workspaceId, key, language },
            { $setOnInsert: { revision: 1, category: spec.category, source: spec.source, attempts: 0, blockedReason: desired } },
            { upsert: true },
          );
          // a concurrent seeder may have inserted the row between our read and this upsert: count only real inserts
          if (res && typeof res.upsertedCount === 'number' && res.upsertedCount === 0) existing += 1; else created += 1;
        } catch (err) {
          if (err && err.code === 11000) existing += 1; else throw err; // lost an upsert race: the row exists
        }
        continue;
      }
      existing += 1;
      if (!cur.metaTemplateId && BLOCKED_REASONS.includes(cur.blockedReason) && cur.blockedReason !== desired && cur.blockedReason !== 'limit') {
        await T.updateOne({ _id: cur._id, workspaceId, blockedReason: cur.blockedReason, metaTemplateId: null }, { $set: { blockedReason: desired } });
      }
    }
  }
  return { created, existing, total };
}

/**
 * Queue the whole starter set (config.starterTemplateKeys() + the setup test template) for a
 * workspace. NO Meta call (submitQueued / the scheduler submit later).
 * @param {string} workspaceId
 * @param {object} [deps]
 */
async function seedStarterTemplates(workspaceId, deps = {}) {
  const keys = starterKeys().filter((k) => k !== TEST_KEY);
  keys.push(TEST_KEY);
  return seedRows(workspaceId, keys, deps);
}

/**
 * The workspace is now connected to ANOTHER WhatsApp Business account (a disconnect, then a connection of a different one): the Meta ids and
 * statuses of its template rows belong to the old account, where they do not exist on the new one. Put every row back in the queue
 * (the row stays; the Meta id, status, submit / check times and rejection details go; revision and attempts start again) and stamp it with
 * the new account, so the starter templates are submitted to it and the checklist counts the NEW account's approvals. Idempotent.
 * NO Graph call.
 * @param {{workspaceId:string, wabaId:string}} args
 * @param {object} [deps]
 * @returns {Promise<{requeued:number}>}
 */
async function requeueForAccount({ workspaceId, wabaId } = {}, deps = {}) {
  const waba = idStr(wabaId);
  if (!workspaceId || !waba) return { requeued: 0 };
  const T = models.template(deps);
  const res = await T.updateMany(
    { workspaceId, wabaId: { $ne: waba } },
    {
      $set: { wabaId: waba, revision: 1, attempts: 0, submitClaimedAt: null },
      $unset: {
        metaTemplateId: '', metaTemplateName: '', metaStatus: '', metaStatusRaw: '', rejectedReason: '', rejectionRecommendation: '',
        qualityScore: '', submittedAt: '', lastCheckedAt: '', lastErrorCode: '',
      },
    },
  );
  return { requeued: Number((res && (res.modifiedCount !== undefined ? res.modifiedCount : res.nModified)) || 0) };
}

// ── merchant credentials and Graph client ───────────────────────────────────
/**
 * Load the merchant's connection + decrypt the token (never logged, never returned to a client).
 * @param {string} workspaceId
 * @param {object} [deps]
 * @param {{needPhoneId?:boolean, allowWabaOnly?:boolean}} [opts]
 * @returns {Promise<{token:string, wabaId:string, phoneNumberId:string|null, conn:object}>}
 */
async function loadMerchantContext(workspaceId, deps = {}, opts = {}) {
  const conn = await models.conn(deps).findOne({ workspaceId }).select('+tokenEncrypted').lean();
  if (!conn) throw new OnbError('WHATSAPP_NOT_CONNECTED');
  if (conn.needsReconnect || conn.status === 'reconnect_required' || conn.tokenIsValid === false) throw new OnbError('WHATSAPP_RECONNECT_REQUIRED');
  const okStatus = config.CONNECTED_LIKE.includes(conn.status) || (opts.allowWabaOnly && conn.status === 'waba_only');
  const ids = conn.ids || {};
  if (!okStatus || !conn.tokenEncrypted || !ids.wabaId || (opts.needPhoneId && !ids.phoneNumberId)) throw new OnbError('WHATSAPP_NOT_CONNECTED');
  // The PLATFORM's own WhatsApp account is never a merchant account: nothing is submitted to, read from or sent through it here.
  if (config.isPlatformAccount({ wabaId: ids.wabaId, phoneNumberId: ids.phoneNumberId })) throw new OnbError('WHATSAPP_NOT_CONNECTED');
  let token;
  try {
    const vault = (deps && deps.vault) || require('./tokenVault');
    token = vault.decrypt(conn.tokenEncrypted, { workspaceId: idStr(workspaceId), purpose: 'token' });
  } catch (err) {
    if (err && err.code === 'ENCRYPTION_NOT_CONFIGURED') throw new OnbError('ENCRYPTION_NOT_CONFIGURED');
    throw new OnbError('WHATSAPP_RECONNECT_REQUIRED');
  }
  const safeConn = { ...conn };
  delete safeConn.tokenEncrypted;
  return { token, wabaId: idStr(ids.wabaId), phoneNumberId: ids.phoneNumberId ? idStr(ids.phoneNumberId) : null, conn: safeConn };
}

function clientFor(deps) {
  const c = deps && deps.metaClient;
  if (c) return typeof c === 'function' ? c() : c;
  const mod = require('./metaClient');
  return mod.createMetaGraphClient(deps && deps.http ? { http: deps.http } : {});
}

function normRow(r) {
  if (!r || typeof r !== 'object') return null;
  const info = r.rejection_info && typeof r.rejection_info === 'object' ? r.rejection_info : {};
  return {
    id: r.id !== undefined && r.id !== null ? idStr(r.id) : null,
    name: r.name,
    language: r.language,
    status: r.status,
    category: r.category,
    quality: r.quality_score !== undefined ? r.quality_score : r.qualityScore,
    reason: r.rejected_reason !== undefined ? r.rejected_reason : (r.rejectedReason !== undefined ? r.rejectedReason : info.reason),
    recommendation: info.recommendation !== undefined ? info.recommendation : r.recommendation,
  };
}
function normList(res) {
  const list = Array.isArray(res) ? res : (res && (Array.isArray(res.data) ? res.data : (Array.isArray(res.templates) ? res.templates : [])));
  return (list || []).map(normRow).filter(Boolean);
}

/**
 * The four Graph calls this module needs, bound to one merchant context (token + ids).
 * Argument order follows DB design 6.2: (token, wabaId|phoneId, ...).
 */
function merchantGraph(client, ctx) {
  return {
    async submit(payload) {
      const res = await client.submitTemplate(ctx.token, ctx.wabaId, payload);
      const d = res && res.data && typeof res.data === 'object' && !res.id ? res.data : (res || {});
      return { id: d.id !== undefined && d.id !== null ? idStr(d.id) : null, status: d.status, category: d.category };
    },
    async listByName(name) { return normList(await client.listTemplates(ctx.token, ctx.wabaId, { name, limit: 100 })); },
    send(args) { return client.sendTemplateMessage(ctx.token, ctx.phoneNumberId, args); },
  };
}

// ── error handling ──────────────────────────────────────────────────────────
function metaCodeOf(err) {
  if (!err) return { code: null, subcode: null };
  const body = err.response && err.response.data && err.response.data.error;
  const m = err.metaError || {};
  return {
    code: numOf(err.code !== undefined && typeof err.code !== 'string' ? err.code : (m.code !== undefined ? m.code : (body && body.code))),
    subcode: numOf(err.subcode !== undefined ? err.subcode : (err.error_subcode !== undefined ? err.error_subcode : (m.subcode !== undefined ? m.subcode : (body && body.error_subcode)))),
  };
}
function isDuplicate(err) {
  const { code, subcode } = metaCodeOf(err);
  return (code === 100 && subcode === 2388024) || (err && err.kind === 'duplicate_template');
}
function isNetwork(err) { return !!err && typeof err.code === 'string' && /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)/.test(err.code); }
function localKind(err) {
  const { code } = metaCodeOf(err);
  const http = numOf(err && (err.httpStatus || err.status));
  if (isNetwork(err)) return 'retry';
  if (code === 190 || code === 102) return 'reconnect';
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return 'permission';
  if ([4, 17, 32, 613, 80007, 130429, 131056].includes(code) || http === 429 || (http !== null && http >= 500)) return 'retry';
  return 'unknown';
}
/** { kind, appCode } of a Graph failure: metaErrors.classify first, then the error's own fields, then a local table. */
function classifyErr(err, deps) {
  let kind = null;
  let appCode = null;
  try {
    const m = (deps && deps.metaErrors) || require('./metaErrors');
    const c = m.classify(err);
    if (c) { kind = c.kind || null; appCode = c.appCode || null; }
  } catch (_) { /* metaErrors unavailable: fall back below */ }
  if ((!kind || kind === 'unknown') && err && typeof err.kind === 'string' && err.kind) kind = err.kind;
  if (!appCode && err && typeof err.appCode === 'string') appCode = err.appCode;
  if (!kind || kind === 'unknown') { const lk = localKind(err); if (lk !== 'unknown') kind = lk; }
  return { kind: kind || 'unknown', appCode };
}
/** metaErrors kind of a Graph failure ('reconnect', 'permission', 'retry', 'network', 'duplicate_template', ...). */
function kindOf(err, deps) { return classifyErr(err, deps).kind; }
/** A short A-Z0-9_ code safe to store and track (never a message). */
function codeString(err) {
  if (isNetwork(err) || (err && err.kind === 'network')) return 'META_UNREACHABLE';
  const { code, subcode } = metaCodeOf(err);
  if (code === null) return 'META_ERROR';
  return subcode ? `META_${code}_${subcode}` : `META_${code}`;
}
async function reportGraph(workspaceId, err, deps) {
  await safe('reportGraphError', async () => {
    const connect = (deps && deps.connect) || require('./connect');
    return connect.reportGraphError(workspaceId, err);
  });
}
/** Map a Graph failure to the OnbError a route answers with (and flip the connection on a revoked token). */
async function toOnbError(err, workspaceId, deps) {
  const { kind, appCode } = classifyErr(err, deps);
  if (kind === 'reconnect') {
    await reportGraph(workspaceId, err, deps);
    return new OnbError('WHATSAPP_RECONNECT_REQUIRED');
  }
  if (kind === 'network' || isNetwork(err)) return new OnbError('META_UNREACHABLE');
  if (kind === 'permission') return new OnbError('META_PERMISSION_MISSING');
  if (kind === 'retry') return new OnbError('META_RATE_LIMITED');
  if (appCode && appCode !== 'META_ERROR' && /^(META_|WHATSAPP_)/.test(appCode) && CODES[appCode]) return new OnbError(appCode);
  return new OnbError('META_ERROR', { details: { code: codeString(err) } });
}

// ── submission ──────────────────────────────────────────────────────────────
function staleCutoff(now) { return new Date(now.getTime() - STALE_CLAIM_MS); }
function claimFilter(now) { return { $or: [{ submitClaimedAt: null }, { submitClaimedAt: { $lt: staleCutoff(now) } }] }; }
const normLang = (l) => String(l || '').split(/[_-]/)[0].toLowerCase();

/** POST the template; on 100/2388024 list by name and adopt the existing id/status. */
async function submitOrAdopt(plan, row, graph) {
  try {
    const res = await graph.submit(plan.payload);
    return { ...res, adopted: false };
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    const list = await graph.listByName(plan.name);
    const found = list.find((r) => r.name === plan.name && (!r.language || normLang(r.language) === row.language));
    if (!found || !found.id) {
      const e = new Error('duplicate template could not be adopted');
      e.code = 'TEMPLATE_DUPLICATE_UNRESOLVED';
      e.adoptFailed = true;
      throw e;
    }
    return { id: found.id, status: found.status, category: found.category, adopted: true, remote: found };
  }
}

function templateTitle(row, deps) {
  const spec = getSpec(row.key, deps);
  const t = spec && spec.title;
  return (t && (t[row.language] || t.en)) || String(row.key);
}

const MILESTONE_FIRST = 'templates:first_approved';
const MILESTONE_ALL = 'templates:all_approved';

/**
 * Coalesced approval e-mails. The spec asks for an e-mail when something is approved, but 14 starter templates (7 keys x 2
 * languages) must not send up to 14 mails in a burst. So every approval stays ONE in-app notification WITHOUT e-mail (applyRowStatus),
 * and on top of that exactly two milestone notifications of the same kind (template_approved) carry the e-mail, each at most once per
 * workspace (the dedupe key decides, notify() mails on the first insert only):
 *   templates:first_approved   the first starter template of the workspace is approved       params { count, total }
 *   templates:all_approved     every non-blocked ENGLISH starter template is approved          params { count, total }
 * No template names and no other value travel in the params (the mail copy is emailCopy's template_approved milestone text). When
 * the first approval is also the last one (a single non-blocked English template) only the "all approved" milestone is sent.
 * The internal setup test template never counts. Never throws.
 * @param {object} row the OnboardingTemplate row that was just approved (source !== 'setup_test')
 * @param {object} deps
 */
async function notifyTemplateMilestones(row, deps) {
  await safe('milestones', async () => {
    const notify = (deps && deps.notify) || require('./notifications').notify;
    const rows = (await models.template(deps).find({ workspaceId: row.workspaceId }).lean()).filter((r) => r && r.source !== 'setup_test');
    const approvedNow = (r) => r.metaStatus === 'APPROVED';
    const english = rows.filter((r) => r.language === 'en' && !r.blockedReason);
    const allDone = english.length > 0 && english.every(approvedNow);
    const approvedAny = rows.filter(approvedNow).length;
    const send = (dedupeKey, count, total) => notify({
      workspaceId: row.workspaceId, kind: 'template_approved', dedupeKey, severity: 'success',
      params: { count, total }, actionPath: '/setup/approvals', email: true,
    });
    if (allDone) await send(MILESTONE_ALL, english.length, english.length);
    else if (approvedAny === 1) await send(MILESTONE_FIRST, 1, rows.filter((r) => !r.blockedReason).length);
  });
}

/** Write a status observed on Meta into the row; notify + track on a real APPROVED / REJECTED transition. */
async function applyRowStatus(row, info, deps) {
  const T = models.template(deps);
  const now = nowOf(deps);
  const raw = String(info.statusRaw === undefined || info.statusRaw === null ? '' : info.statusRaw).trim().toUpperCase();
  const mt = metaTemplates();
  let mapped = null;
  if (raw) {
    if (mt.KNOWN_STATUSES.includes(raw)) mapped = raw;
    else if (raw === 'REINSTATED' || raw === 'UNARCHIVED') mapped = 'APPROVED';
    else if (!KEEP_STATUS_EVENTS.includes(raw)) mapped = mt.mapMetaStatus(raw);
  }
  const same = !raw || (row.metaStatusRaw === raw && (!info.id || idStr(info.id) === idStr(row.metaTemplateId)));
  const set = { lastCheckedAt: now };
  if (info.id && !row.metaTemplateId) set.metaTemplateId = idStr(info.id);
  const category = typeof info.category === 'string' ? info.category.trim().toUpperCase() : '';
  if (CATEGORIES.includes(category)) set.category = category;
  if (info.quality !== undefined && info.quality !== null) {
    const q = mt.cleanQualityScore(info.quality);
    if (q) set.qualityScore = q;
  }
  if (!same) {
    set.metaStatusRaw = raw;
    if (mapped) set.metaStatus = mapped;
    if (mapped === 'REJECTED') {
      set.rejectedReason = mt.cleanRejectedReason(info.reason);
      set.rejectionRecommendation = info.recommendation ? mt.cleanText(info.recommendation, 300) || null : null;
    } else if (mapped === 'APPROVED') {
      set.rejectedReason = null;
      set.rejectionRecommendation = null;
    }
  } else if (row.metaStatus === 'REJECTED' && mapped === 'REJECTED') {
    // the poll saw the rejection first (it carries no reason); the webhook delivers it later
    if (!row.rejectedReason) { const r = mt.cleanRejectedReason(info.reason); if (r) set.rejectedReason = r; }
    if (!row.rejectionRecommendation && info.recommendation) { const rec = mt.cleanText(info.recommendation, 300); if (rec) set.rejectionRecommendation = rec; }
  }
  await T.updateOne({ _id: row._id, workspaceId: row.workspaceId }, { $set: set });
  const changed = !same && !!mapped && mapped !== row.metaStatus;
  if (changed && (mapped === 'APPROVED' || mapped === 'REJECTED')) {
    const tid = idStr(set.metaTemplateId || row.metaTemplateId) || `row-${idStr(row._id)}`;
    await track(deps, row.workspaceId, { type: 'template_status', step: 'approvals', code: `TEMPLATE_${mapped}`, meta: { templateKey: row.key, language: row.language } });
    if (row.source !== 'setup_test') {
      await safe('notify', async () => {
        const notify = (deps && deps.notify) || require('./notifications').notify;
        return notify({
          workspaceId: row.workspaceId,
          kind: mapped === 'APPROVED' ? 'template_approved' : 'template_rejected',
          dedupeKey: `template:${tid}:${mapped}`, // one per template id and status: a repeat delivery is a no-op
          severity: mapped === 'APPROVED' ? 'success' : 'action',
          params: { template: templateTitle(row, deps), language: row.language, ...(mapped === 'REJECTED' && set.rejectedReason ? { reason: set.rejectedReason } : {}) },
          actionPath: '/setup',
          // a rejection needs action: e-mail too. An approval stays in the app (the approvals are coalesced into two milestone mails)
          email: mapped === 'REJECTED',
        });
      });
      if (mapped === 'APPROVED') await notifyTemplateMilestones(row, deps);
    }
  }
  return { changed, status: mapped || row.metaStatus || null };
}

async function submitOne(row, ctx, graph, deps, now) {
  const T = models.template(deps);
  const workspaceId = row.workspaceId;
  const spec = getSpec(row.key, deps);
  const plan = spec ? buildPlan({ spec, workspaceId, language: row.language, revision: row.revision || 1 }, deps) : { ok: false, errors: ['unknown_key'] };
  if (!plan.ok) {
    await T.updateOne({ _id: row._id, workspaceId }, { $set: { blockedReason: 'invalid', lastErrorCode: 'TEMPLATE_INVALID' } });
    return { outcome: 'invalid', reached: false };
  }
  // atomic claim BEFORE the Graph call: two ticks / a tick and a click can never both submit one row
  const claimed = await T.findOneAndUpdate(
    { _id: row._id, workspaceId, blockedReason: null, metaTemplateId: null, attempts: { $lt: MAX_ATTEMPTS }, ...claimFilter(now) },
    { $set: { submitClaimedAt: now }, $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  );
  if (!claimed) return { outcome: 'skipped', reached: false };
  let res;
  try {
    res = await submitOrAdopt(plan, row, graph);
  } catch (err) {
    const kind = err && err.adoptFailed ? 'unknown' : kindOf(err, deps);
    if (kind === 'reconnect') await reportGraph(workspaceId, err, deps);
    await T.updateOne({ _id: row._id, workspaceId }, { $set: { submitClaimedAt: null, lastErrorCode: err && err.adoptFailed ? 'TEMPLATE_DUPLICATE_UNRESOLVED' : codeString(err) } });
    return { outcome: kind === 'reconnect' ? 'reconnect' : 'failed', reached: true, kind };
  }
  const status = res.status ? mapStatusForStore(res.status) : { metaStatus: 'PENDING', raw: 'PENDING' };
  const category = typeof res.category === 'string' && CATEGORIES.includes(res.category.toUpperCase()) ? res.category.toUpperCase() : plan.category;
  await T.updateOne({ _id: row._id, workspaceId }, {
    $set: {
      metaTemplateId: res.id || null,
      metaTemplateName: plan.name,
      metaStatus: status.metaStatus,
      metaStatusRaw: status.raw,
      category,
      submittedAt: now,
      submitClaimedAt: null,
      lastErrorCode: null,
      lastCheckedAt: now,
      wabaId: ctx.wabaId,
    },
  });
  await track(deps, workspaceId, { type: 'template_status', step: 'approvals', code: 'TEMPLATE_SUBMITTED', meta: { templateKey: row.key, language: row.language } });
  if (status.metaStatus === 'APPROVED' || status.metaStatus === 'REJECTED') {
    // the template was already decided (an adopted duplicate): record the details + notify once
    const fresh = { ...row, metaTemplateId: res.id, metaStatus: 'PENDING', metaStatusRaw: 'PENDING', source: row.source };
    const remote = res.remote || {};
    await applyRowStatus(fresh, { statusRaw: status.raw, id: res.id, category, reason: remote.reason, recommendation: remote.recommendation, quality: remote.quality }, deps);
  }
  return { outcome: res.adopted ? 'adopted' : 'submitted', reached: true };
}

function mapStatusForStore(rawStatus) {
  const raw = String(rawStatus).trim().toUpperCase();
  return { raw, metaStatus: metaTemplates().mapMetaStatus(raw) || 'PENDING' };
}

function priority(row) {
  const keyRank = row.key === TEST_KEY ? -1 : Math.max(0, starterKeys().indexOf(row.key));
  return (row.language === 'en' ? 0 : 1000) + keyRank;
}

function queuedFilter(now, extra) {
  return { blockedReason: null, metaTemplateId: null, attempts: { $lt: MAX_ATTEMPTS }, ...claimFilter(now), ...(extra || {}) };
}

/**
 * Submit queued rows of ONE workspace to the merchant's WABA: at most 5 per call, never past
 * config.templateCeiling(). Throws OnbError WHATSAPP_NOT_CONNECTED / WHATSAPP_RECONNECT_REQUIRED /
 * ENCRYPTION_NOT_CONFIGURED when there is queued work but no usable connection, and
 * TEMPLATE_LIMIT_REACHED when the ceiling is already reached.
 * @param {{workspaceId:string, max?:number}} args
 * @param {object} [deps]
 * @returns {Promise<{submitted:number, adopted:number, failed:number, invalid:number, remaining:number, limitReached:boolean, aborted:string|null}>}
 */
async function submitQueued({ workspaceId, max } = {}, deps = {}) {
  const T = models.template(deps);
  const now = nowOf(deps);
  const requested = Number.isFinite(Number(max)) && Number(max) >= 1 ? Math.floor(Number(max)) : MAX_PER_TICK;
  const cap = Math.min(MAX_PER_TICK, requested);
  const result = { submitted: 0, adopted: 0, failed: 0, invalid: 0, remaining: 0, limitReached: false, aborted: null };
  const candidates = (await T.find({ workspaceId, ...queuedFilter(now) }).lean()).sort((a, b) => priority(a) - priority(b));
  result.remaining = candidates.length;
  if (!candidates.length) return result;
  const ctx = await loadMerchantContext(workspaceId, deps, { allowWabaOnly: true });
  const ceiling = config.templateCeiling();
  let used = await T.countDocuments({ workspaceId, metaTemplateId: { $ne: null } });
  if (used >= ceiling) throw new OnbError('TEMPLATE_LIMIT_REACHED', { details: { used, ceiling } });
  const graph = merchantGraph(clientFor(deps), ctx);
  let calls = 0;
  for (const row of candidates) {
    if (calls >= cap) break;
    if (used >= ceiling) { result.limitReached = true; break; }
    const r = await submitOne(row, ctx, graph, deps, now);
    if (r.reached) calls += 1;
    if (r.outcome === 'submitted') { result.submitted += 1; used += 1; result.remaining -= 1; }
    else if (r.outcome === 'adopted') { result.adopted += 1; used += 1; result.remaining -= 1; }
    else if (r.outcome === 'invalid') { result.invalid += 1; result.remaining -= 1; }
    else if (r.outcome === 'failed') result.failed += 1;
    else if (r.outcome === 'reconnect') { result.failed += 1; result.aborted = 'reconnect'; break; }
  }
  return result;
}

async function gateAllows(workspaceId, deps, states) {
  try {
    const getGateState = (deps && deps.getGateState) || require('./state').getGateState;
    const gate = await getGateState(workspaceId);
    return !!(gate && gate.enrolled && gate.sub && states.includes(gate.sub.state));
  } catch (_) { return false; }
}

/**
 * Scheduler hook: submit queued rows (<= 5 each) for every workspace that has some and an active
 * subscription. Never throws; per-workspace failures are counted.
 * @param {{now?:Date|number, limit?:number, workspaceId?:string}} [opts] workspaceId restricts the run to one workspace
 * @param {object} [deps]
 * @returns {Promise<{workspaces:number, submitted:number, adopted:number, errors:number}>}
 */
async function submitPending(opts = {}, deps = {}) {
  const d = opts.now !== undefined ? { ...deps, now: () => opts.now } : deps;
  const out = { workspaces: 0, submitted: 0, adopted: 0, errors: 0 };
  const T = models.template(d);
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 20));
  let rows;
  try { rows = await T.find(queuedFilter(nowOf(d), opts.workspaceId ? { workspaceId: opts.workspaceId } : null)).select('workspaceId').limit(500).lean(); } catch (err) { out.errors += 1; return out; }
  const seen = [];
  for (const r of rows) { const id = idStr(r.workspaceId); if (id && !seen.includes(id)) seen.push(id); }
  for (const workspaceId of seen.slice(0, limit)) {
    if (!(await gateAllows(workspaceId, d, ['active']))) continue;
    out.workspaces += 1;
    try {
      const r = await submitQueued({ workspaceId, max: MAX_PER_TICK }, d);
      out.submitted += r.submitted;
      out.adopted += r.adopted;
    } catch (err) {
      out.errors += 1;
      config.safeLog('info', '[onboarding] template submit skipped:', err && err.code);
    }
  }
  return out;
}

// ── reading ─────────────────────────────────────────────────────────────────
function uiStatus(row) {
  if (row.blockedReason) return 'blocked';
  const s = row.metaStatus;
  if (!row.metaTemplateId && !s) return 'queued';
  if (s === 'APPROVED') return 'approved';
  if (s === 'PENDING' || s === 'IN_APPEAL' || !s) return 'pending';
  if (s === 'REJECTED') return 'rejected';
  if (s === 'PAUSED' || s === 'DISABLED') return 'paused';
  return 'unavailable';
}

function mapRow(row, deps) {
  const spec = getSpec(row.key, deps);
  const status = uiStatus(row);
  const title = spec ? { en: spec.title.en, ar: spec.title.ar } : { en: String(row.key), ar: String(row.key) };
  let reasonKey = null;
  if (status === 'rejected') reasonKey = 'onboarding.approvals.templates.rejected';
  else if (status === 'blocked' && (row.blockedReason === 'arabic_not_reviewed' || row.blockedReason === 'legal')) reasonKey = 'onboarding.approvals.templates.arBlocked';
  else if (status === 'queued') reasonKey = 'onboarding.approvals.templates.queued';
  return {
    key: row.key,
    language: row.language,
    status,
    category: row.category || (spec && spec.category) || null,
    reasonKey,
    rejectedReason: status === 'rejected' ? (row.rejectedReason || null) : null,
    recommendation: status === 'rejected' ? (row.rejectionRecommendation || null) : null,
    title,
    blockedReason: row.blockedReason || null,
    revision: row.revision || 1,
    canResubmit: status === 'rejected',
  };
}

function sortRows(rows) {
  const order = [...starterKeys().filter((k) => k !== TEST_KEY), TEST_KEY];
  const rank = (r) => { const i = order.indexOf(r.key); return (i < 0 ? 999 : i) * 2 + (r.language === 'en' ? 0 : 1); };
  return rows.slice().sort((a, b) => rank(a) - rank(b));
}

/**
 * Starter-set statuses for the workspace (read-only, no Meta call), ordered like the starter set.
 * Row: { key, language, status:'queued'|'pending'|'approved'|'rejected'|'paused'|'unavailable'|'blocked',
 *        category, reasonKey, rejectedReason, recommendation, title:{en,ar}, blockedReason, revision, canResubmit }
 * @param {string} workspaceId
 * @param {object} [deps]
 * @returns {Promise<object[]>}
 */
async function listStatuses(workspaceId, deps = {}) {
  const rows = await models.template(deps).find({ workspaceId }).lean();
  return sortRows(rows).map((r) => mapRow(r, deps));
}

/**
 * Capacity and counters for the templates screen.
 * @returns {Promise<{ceiling:number, metaLimit:number, used:number, remaining:number, total:number, approved:number, pending:number, rejected:number, queued:number, blocked:number, arabicRequested:boolean}>}
 */
async function getCapacity(workspaceId, deps = {}) {
  const rows = await models.template(deps).find({ workspaceId }).lean();
  const ceiling = config.templateCeiling();
  const used = rows.filter((r) => r.metaTemplateId).length;
  const counts = { approved: 0, pending: 0, rejected: 0, queued: 0, blocked: 0 };
  for (const r of rows) {
    const s = uiStatus(r);
    if (s in counts) counts[s] += 1;
  }
  const arabicRequested = (await readLanguages(workspaceId, deps)).includes('ar');
  return { ceiling, metaLimit: META_TEMPLATE_LIMIT, used, remaining: Math.max(0, ceiling - used), total: rows.length, ...counts, arabicRequested };
}

// ── resubmit ────────────────────────────────────────────────────────────────
/**
 * Resubmit a REJECTED template as a NEW revision (new name wf_<ws6>_<key>_<lang>_v<n+1>), with
 * optional edited text (header / body / footer; the merge fields and buttons cannot change) that
 * must pass metaConstraints.validateVariant. The edit is used for this submission only (the row
 * stores no text); on a Meta failure the row stays REJECTED with its old revision.
 * @param {{workspaceId:string, key:string, language:string, edits?:{header?:string, body?:string, footer?:string}}} args
 * @param {object} [deps]
 * @returns {Promise<{template:object}>}
 */
async function resubmit({ workspaceId, key, language, edits } = {}, deps = {}) {
  const T = models.template(deps);
  const now = nowOf(deps);
  const bad = (reason, extra) => new OnbError('VALIDATION_FAILED', { details: { reason, ...(extra || {}) } });
  if (!LANGS.includes(language)) throw bad('UNKNOWN_TEMPLATE');
  const spec = typeof key === 'string' ? getSpec(key, deps) : null;
  if (!spec) throw bad('UNKNOWN_TEMPLATE');
  const row = await T.findOne({ workspaceId, key, language }).lean();
  if (!row) throw bad('UNKNOWN_TEMPLATE');
  if (row.metaStatus !== 'REJECTED') throw bad('NOT_REJECTED');
  const editObj = edits && typeof edits === 'object' && !Array.isArray(edits) ? edits : null;
  const revision = (row.revision || 1) + 1;
  const plan = buildPlan({ spec, workspaceId, language, revision, edits: editObj }, deps);
  if (!plan.ok) throw bad('TEMPLATE_INVALID', { errors: plan.errors });
  const ctx = await loadMerchantContext(workspaceId, deps, { allowWabaOnly: true });
  const ceiling = config.templateCeiling();
  const used = await T.countDocuments({ workspaceId, metaTemplateId: { $ne: null } });
  if (used >= ceiling) throw new OnbError('TEMPLATE_LIMIT_REACHED', { details: { used, ceiling } });
  const claimed = await T.findOneAndUpdate(
    { _id: row._id, workspaceId, metaStatus: 'REJECTED', ...claimFilter(now) },
    { $set: { submitClaimedAt: now }, $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  );
  if (!claimed) throw bad('ALREADY_RESUBMITTING');
  const graph = merchantGraph(clientFor(deps), ctx);
  let res;
  try {
    res = await submitOrAdopt(plan, row, graph);
  } catch (err) {
    await T.updateOne({ _id: row._id, workspaceId }, { $set: { submitClaimedAt: null, lastErrorCode: err && err.adoptFailed ? 'TEMPLATE_DUPLICATE_UNRESOLVED' : codeString(err) } });
    if (err && err.adoptFailed) throw new OnbError('META_ERROR', { details: { code: 'TEMPLATE_DUPLICATE_UNRESOLVED' } });
    throw await toOnbError(err, workspaceId, deps);
  }
  const status = res.status ? mapStatusForStore(res.status) : { metaStatus: 'PENDING', raw: 'PENDING' };
  const category = typeof res.category === 'string' && CATEGORIES.includes(res.category.toUpperCase()) ? res.category.toUpperCase() : plan.category;
  await T.updateOne({ _id: row._id, workspaceId }, {
    $set: {
      revision,
      metaTemplateName: plan.name,
      metaTemplateId: res.id || null,
      metaStatus: status.metaStatus,
      metaStatusRaw: status.raw,
      category,
      submittedAt: now,
      submitClaimedAt: null,
      rejectedReason: null,
      rejectionRecommendation: null,
      lastErrorCode: null,
      lastCheckedAt: now,
      wabaId: ctx.wabaId,
    },
  });
  await track(deps, workspaceId, { type: 'template_status', step: 'approvals', code: 'TEMPLATE_RESUBMITTED', meta: { templateKey: key, language } });
  const fresh = await T.findOne({ workspaceId, key, language }).lean();
  return { template: mapRow(fresh || { ...row, revision, metaStatus: status.metaStatus, metaTemplateId: res.id, blockedReason: null }, deps) };
}

// ── status updates (webhook + poll) ─────────────────────────────────────────
/**
 * Apply a template status observed on Meta (webhook `message_template_status_update` /
 * `template_category_update`, or the poll). Idempotent by template id + status; notifies
 * template_approved / template_rejected once per (template id, status).
 * @param {{workspaceId:string, templateId?:string|number, name?:string, language?:string, statusRaw?:string, reason?:string, recommendation?:string, category?:string, qualityScore?:any}} args
 * @param {object} [deps]
 * @returns {Promise<{updated:boolean, changed:boolean, status?:string|null, reason?:string}>}
 */
async function applyTemplateStatusUpdate({ workspaceId, templateId, name, language, statusRaw, reason, recommendation, category, qualityScore } = {}, deps = {}) {
  if (!workspaceId) return { updated: false, changed: false, reason: 'no_workspace' };
  const T = models.template(deps);
  let row = null;
  if (templateId !== undefined && templateId !== null && templateId !== '') row = await T.findOne({ workspaceId, metaTemplateId: idStr(templateId) }).lean();
  if (!row && typeof name === 'string' && name) {
    row = await T.findOne({ workspaceId, metaTemplateName: name }).lean();
    if (row && language && normLang(language) !== row.language) row = null; // en-US vs en_US vs en: compare the language part only
  }
  if (!row) return { updated: false, changed: false, reason: 'unknown_template' };
  const r = await applyRowStatus(row, { statusRaw, id: templateId, reason, recommendation, category, quality: qualityScore }, deps);
  return { updated: true, changed: r.changed, status: r.status };
}

function namePrefix(workspaceId) {
  const sample = metaTemplates().buildTemplateName({ workspaceId: idStr(workspaceId), key: 'x', language: 'en', revision: 1 });
  return sample.slice(0, sample.indexOf('_x_') + 1);
}

/**
 * Scheduler hook: re-read PENDING rows (at most hourly each) from each merchant's WABA with ONE
 * list call per workspace, store APPROVED / REJECTED (+ reason and recommendation) and notify; then
 * (unless opts.submit === false) submit queued rows (submitPending). Never throws.
 * @param {{now?:Date|number, limit?:number, submit?:boolean, workspaceId?:string}} [opts] workspaceId restricts the run to one workspace
 * @param {object} [deps]
 * @returns {Promise<{workspaces:number, checked:number, changed:number, skipped:number, errors:number, submit?:object}>}
 */
async function pollStatuses(opts = {}, deps = {}) {
  const d = opts.now !== undefined ? { ...deps, now: () => opts.now } : deps;
  const now = nowOf(d);
  const out = { workspaces: 0, checked: 0, changed: 0, skipped: 0, errors: 0 };
  const T = models.template(d);
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 50));
  let rows = [];
  try {
    rows = await T.find({
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      metaTemplateId: { $ne: null },
      metaStatus: { $in: ['PENDING', 'IN_APPEAL', null] },
      $or: [{ lastCheckedAt: null }, { lastCheckedAt: { $lt: new Date(now.getTime() - POLL_INTERVAL_MS) } }],
    }).limit(500).lean();
  } catch (err) { out.errors += 1; rows = []; }
  const byWs = new Map();
  for (const r of rows) { const k = idStr(r.workspaceId); if (!byWs.has(k)) byWs.set(k, []); byWs.get(k).push(r); }
  for (const [workspaceId, list] of [...byWs.entries()].slice(0, limit)) {
    if (!(await gateAllows(workspaceId, d, ['active', 'past_due']))) { out.skipped += 1; continue; }
    out.workspaces += 1;
    try {
      const ctx = await loadMerchantContext(workspaceId, d, { allowWabaOnly: true });
      const graph = merchantGraph(clientFor(d), ctx);
      let remote;
      try {
        remote = await graph.listByName(namePrefix(workspaceId));
      } catch (err) {
        if (kindOf(err, d) === 'reconnect') await reportGraph(workspaceId, err, d);
        out.errors += 1;
        continue;
      }
      const byName = new Map(remote.map((x) => [x.name, x]));
      for (const row of list) {
        out.checked += 1;
        const hit = byName.get(row.metaTemplateName);
        if (!hit || (hit.language && normLang(hit.language) !== row.language)) {
          await T.updateOne({ _id: row._id, workspaceId: row.workspaceId }, { $set: { lastCheckedAt: now } });
          continue;
        }
        const r = await applyRowStatus(row, { statusRaw: hit.status, id: hit.id, category: hit.category, reason: hit.reason, recommendation: hit.recommendation, quality: hit.quality }, d);
        if (r.changed) out.changed += 1;
      }
    } catch (err) {
      out.skipped += 1; // not connected / needs reconnect / encryption: nothing to poll right now
    }
  }
  if (opts.submit !== false) out.submit = await submitPending({ limit: opts.limit, workspaceId: opts.workspaceId }, d);
  return out;
}

const api = {
  TEST_TEMPLATE_KEY: TEST_KEY,
  seedStarterTemplates,
  seedRows,
  requeueForAccount,
  listStatuses,
  getCapacity,
  submitQueued,
  submitPending,
  resubmit,
  applyTemplateStatusUpdate,
  pollStatuses,
  loadMerchantContext,
  merchantGraph,
  clientFor,
  kindOf,
  toOnbError,
  getSpec,
  legalKeys,
  buildPlan,
  CAMPAIGN_TYPE,
  MAX_PER_TICK,
  MAX_ATTEMPTS,
};
Object.defineProperty(api, 'STARTER_KEYS', { enumerable: true, get: () => starterKeys() });

module.exports = api;
