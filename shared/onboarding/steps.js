'use strict';
// Onboarding steps: input validation, the step state machine (markStep), the "what next" rule (nextStep)
// and the bodies of GET /state (buildState / buildBillingState). DB design 2.1, 4.10, 5 as amended by
// DECISIONS C1 / C9 / C11.
//
// Conventions: nothing runs at require time; every collaborator is injectable through the trailing
// `deps` argument (models by name, `now`, `track`, `getGateState`, `notifications`, `statusRefresh`);
// the workspace id is always the one the caller took from the verified token; no token / PIN / hash /
// Workspace.name is ever put in a body built here.
const config = require('./config');
const { OnbError } = require('./errors');
const stateModule = require('./state');
const gate = require('./gate');

const { STEP_KEYS, STEP_INDEX, INDUSTRY_KEYS, COUNTRY_CODES, LANGUAGES } = config;

const ID_RE = /^[0-9a-f]{24}$/i;
const STEP_STATUSES = Object.freeze(['todo', 'in_progress', 'done', 'skipped']);
const FINISHED_STATUSES = Object.freeze(['done', 'skipped']);
const MIN_ACTIVITY_WRITE_MS = 60 * 1000;
/** WhatsAppConnection.status values that mean "a connection exists" (answers of step 2 can no longer change). */
const CONNECTION_EXISTS_STATUSES = Object.freeze(['connected', 'needs_attention', 'waba_only', 'reconnect_required']);
const LEVELS = Object.freeze(['connected', 'needs_attention', 'reconnect_needed']);

// control characters, zero-width and bidi marks (code point escapes: no raw hidden characters in this file)
const HIDDEN_CHARS = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}]/gu;

/** Trim, drop control / zero-width / bidi characters, collapse whitespace. Non-strings give ''. */
function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(HIDDEN_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/** ISO string of a Date / date-like value; null when absent or invalid. */
function toIso(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function nowOf(deps) { return deps && typeof deps.now === 'function' ? deps.now() : new Date(); }
function trackOf(deps) { return deps && typeof deps.track === 'function' ? deps.track : require('./analytics').track; }
function modelOf(deps, name) { return (deps && deps[name]) || require(`../../models/${name}`); }
function idOf(workspaceId) {
  const id = String(workspaceId || '');
  if (!ID_RE.test(id)) throw new OnbError('ONBOARDING_NOT_AVAILABLE');
  return id;
}

/**
 * What every handler takes from the request: the workspace and user ids come ONLY from the verified token
 * (req.user), never from the body or query. Throws ONBOARDING_NOT_AVAILABLE when there is no usable workspace id.
 */
function requestContext(req) {
  const u = (req && req.user) || {};
  const workspaceId = u.workspaceId ? String(u.workspaceId) : '';
  if (!ID_RE.test(workspaceId)) throw new OnbError('ONBOARDING_NOT_AVAILABLE');
  return { workspaceId, userId: u.id ? String(u.id) : undefined, role: u.role };
}

/** analytics.track that never throws (analytics must not block a state change). */
async function trackEvent(workspaceId, evt, deps) {
  try { await trackOf(deps)(workspaceId, evt); } catch (_) { /* never blocks */ }
}

// ---------------------------------------------------------------------------------------------
// Validation (PUT /business, POST /preferences)
// ---------------------------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;
const INSTAGRAM_RE = /^[A-Za-z0-9._]{1,30}$/;
const CR_RE = /^[A-Za-z0-9]{5,20}$/;

function isBlank(v) { return v === null || (typeof v === 'string' && v.trim() === ''); }

function validateWebsite(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length > 200 || s.length < 9 || /[\s\u{0}-\u{1f}\u{7f}]/u.test(s)) return null;
  let url;
  try { url = new URL(s); } catch (_) { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (!url.hostname.includes('.') || url.hostname.endsWith('.')) return null;
  return s;
}

/**
 * Validate the (possibly partial) Step 1 body. Only the keys that are present are validated and returned;
 * unknown keys are ignored. Empty string / null on an optional text field means "clear it".
 * Bounds (DB section 5): name 2-80, country in COUNTRY_CODES, industry in INDUSTRY_KEYS, website an https URL
 * <= 200, instagram [A-Za-z0-9._]{1,30} (a leading @ is stripped), CR number 5-20 alphanumerics (no country
 * format is claimed), e-mail format, uiLanguage en|ar, languages a non-empty subset of en|ar.
 * @param {object} body
 * @returns {{ok:true, value:object}|{ok:false, fields:Object<string,string>}} fields: key -> INVALID|LENGTH|EMPTY
 */
function validateBusinessInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, fields: { body: 'INVALID' } };
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
  const fields = {};
  const value = {};

  if (has('name')) {
    if (typeof body.name !== 'string') fields.name = 'INVALID';
    else {
      const v = cleanText(body.name);
      if (v.length < 2 || v.length > 80) fields.name = 'LENGTH';
      else value.name = v;
    }
  }
  if (has('country')) {
    const v = typeof body.country === 'string' ? body.country.trim().toUpperCase() : '';
    if (COUNTRY_CODES.includes(v)) value.country = v; else fields.country = 'INVALID';
  }
  if (has('industry')) {
    const v = typeof body.industry === 'string' ? body.industry.trim().toLowerCase() : '';
    if (INDUSTRY_KEYS.includes(v)) value.industry = v; else fields.industry = 'INVALID';
  }
  if (has('website')) {
    if (isBlank(body.website)) value.website = null;
    else { const v = validateWebsite(body.website); if (v) value.website = v; else fields.website = 'INVALID'; }
  }
  if (has('instagram')) {
    if (isBlank(body.instagram)) value.instagram = null;
    else if (typeof body.instagram !== 'string') fields.instagram = 'INVALID';
    else {
      const v = body.instagram.trim().replace(/^@/, '');
      if (INSTAGRAM_RE.test(v)) value.instagram = v; else fields.instagram = 'INVALID';
    }
  }
  if (has('crNumber')) {
    if (isBlank(body.crNumber)) value.crNumber = null;
    else if (typeof body.crNumber !== 'string') fields.crNumber = 'INVALID';
    else {
      const v = body.crNumber.trim();
      if (CR_RE.test(v)) value.crNumber = v; else fields.crNumber = 'INVALID';
    }
  }
  if (has('crSkipped')) {
    if (typeof body.crSkipped === 'boolean') value.crSkipped = body.crSkipped; else fields.crSkipped = 'INVALID';
  }
  if (has('contactEmail')) {
    if (isBlank(body.contactEmail)) value.contactEmail = null;
    else if (typeof body.contactEmail !== 'string') fields.contactEmail = 'INVALID';
    else {
      const v = body.contactEmail.trim().toLowerCase();
      if (v.length <= 120 && EMAIL_RE.test(v)) value.contactEmail = v; else fields.contactEmail = 'INVALID';
    }
  }
  if (has('uiLanguage')) {
    const v = typeof body.uiLanguage === 'string' ? body.uiLanguage.trim().toLowerCase() : '';
    if (LANGUAGES.includes(v)) value.uiLanguage = v; else fields.uiLanguage = 'INVALID';
  }
  if (has('languages')) {
    const raw = body.languages;
    const list = Array.isArray(raw) ? raw.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : '')) : null;
    const uniq = list ? Array.from(new Set(list)) : null;
    if (uniq && list.length <= 6 && uniq.length >= 1 && uniq.every((x) => LANGUAGES.includes(x))) value.languages = uniq;
    else fields.languages = 'INVALID';
  }

  if (Object.keys(fields).length) return { ok: false, fields };
  if (!Object.keys(value).length) return { ok: false, fields: { body: 'EMPTY' } };
  return { ok: true, value };
}

/** True when the Step 1 required fields (name, country, industry) are all present. */
function businessComplete(business) {
  const b = business || {};
  return !!(b.name && b.country && b.industry);
}

// ---------------------------------------------------------------------------------------------
// Step state machine
// ---------------------------------------------------------------------------------------------

function stepStatus(doc, key) {
  const s = doc && doc.steps && doc.steps[key];
  return (s && s.status) || 'todo';
}
function stepDone(doc, key) { return FINISHED_STATUSES.includes(stepStatus(doc, key)); }

/**
 * Setup is finished when all five steps are done or skipped. Step 4 (approvals) is non-blocking by spec (Meta
 * decides, waiting is not an error), so a merchant who has opened it (status in_progress) counts as finished.
 */
function isFinished(doc) {
  return STEP_KEYS.every((k) => stepDone(doc, k) || (k === 'approvals' && stepStatus(doc, k) === 'in_progress'));
}

/** Path B and the merchant has not yet said "I've got my number". */
function numberPaused(doc) {
  const n = (doc && doc.number) || {};
  return !stepDone(doc, 'number') && n.path === 'B' && !n.numberReady;
}

/** Is the stored connection a broken / partial one (the merchant has to go back to the connect step)? */
function connectionBroken(conn) {
  if (!conn) return false;
  if (conn.needsReconnect) return true;
  return ['reconnect_required', 'disconnected', 'error', 'waba_only', 'not_connected', 'connecting'].includes(conn.status);
}

/**
 * The next screen the merchant belongs on (the /state vocabulary).
 * Order: business, number, connect, approvals, customers, products, promotion, then null.
 * - A step counts as passed when it is done or skipped.
 * - connect: not passed, or passed but the stored connection (when given) is broken / partial -> 'connect'.
 * - approvals is non-blocking: it is offered once (status todo); after it was opened the flow moves on.
 * - the customers / products prompts are open while their state is 'pending' (a skipped one stays a reminder only).
 * @param {object} stateDoc lean OnboardingState
 * @param {object} [connDoc] lean WhatsAppConnection (optional)
 * @returns {'business'|'number'|'connect'|'approvals'|'customers'|'products'|'promotion'|null}
 */
function nextStep(stateDoc, connDoc) {
  const doc = stateDoc || {};
  if (!stepDone(doc, 'business')) return 'business';
  if (!stepDone(doc, 'number')) return 'number';
  if (!stepDone(doc, 'connect') || connectionBroken(connDoc)) return 'connect';
  if (stepStatus(doc, 'approvals') === 'todo') return 'approvals';
  const prompts = doc.prompts || {};
  if (((prompts.customers && prompts.customers.state) || 'pending') === 'pending') return 'customers';
  if (((prompts.products && prompts.products.state) || 'pending') === 'pending') return 'products';
  if (!stepDone(doc, 'promotion')) return 'promotion';
  return null;
}

/**
 * Pure: the `progress.*` fields that follow from the step statuses (dotted paths).
 * lastActivityAt is only written on a change, when `opts.touch` is set, or when it is older than a minute.
 * @returns {{set:object, unset:object}}
 */
function deriveProgress(doc, now, opts = {}) {
  const progress = doc.progress || {};
  const set = {};
  const unset = {};
  const first = STEP_KEYS.find((k) => !stepDone(doc, k));
  const currentStep = first ? STEP_INDEX[first] : STEP_KEYS.length;
  if (progress.currentStep !== currentStep) set['progress.currentStep'] = currentStep;
  const furthest = Math.max(progress.furthestStep || 1, currentStep);
  if (progress.furthestStep !== furthest) set['progress.furthestStep'] = furthest;
  if (!progress.startedAt) set['progress.startedAt'] = now;

  const finished = isFinished(doc);
  let status;
  if (finished) status = 'completed';
  else if (numberPaused(doc)) status = 'paused_number';
  else if (progress.status === 'waiting_meta') status = 'waiting_meta';
  else status = 'in_progress';
  if (progress.status !== status) set['progress.status'] = status;

  if (finished && !progress.completedAt) set['progress.completedAt'] = now;
  if (!finished && progress.completedAt) unset['progress.completedAt'] = '';

  const last = progress.lastActivityAt ? new Date(progress.lastActivityAt).getTime() : 0;
  if (opts.touch || Object.keys(set).length || Object.keys(unset).length || now.getTime() - last >= MIN_ACTIVITY_WRITE_MS) {
    set['progress.lastActivityAt'] = now;
  }
  return { set, unset };
}

const TRACK_TYPE = { done: 'step_complete', skipped: 'step_skip', in_progress: 'step_enter' };

/**
 * Move one step to a status (idempotent), keep `progress.*` consistent, track the transition, invalidate the
 * gate cache. Called by B1-c/d/e (connect, approvals, promotion) and by the routes of this module.
 * Throws OnbError ONBOARDING_NOT_AVAILABLE when the workspace is not enrolled, VALIDATION_FAILED for an
 * unknown step / status.
 * @param {string} workspaceId
 * @param {'business'|'number'|'connect'|'approvals'|'promotion'} stepKey
 * @param {'todo'|'in_progress'|'done'|'skipped'} status
 * @param {object} [deps] { OnboardingState, now, track }
 * @returns {Promise<object>} the lean state document after the write
 */
async function markStep(workspaceId, stepKey, status, deps) {
  if (!STEP_KEYS.includes(stepKey)) throw new OnbError('VALIDATION_FAILED', { details: { reason: 'UNKNOWN_STEP' } });
  if (!STEP_STATUSES.includes(status)) throw new OnbError('VALIDATION_FAILED', { details: { reason: 'UNKNOWN_STATUS' } });
  const id = idOf(workspaceId);
  const State = modelOf(deps, 'OnboardingState');
  const now = nowOf(deps);

  const before = await stateModule.ensureState(id, deps);
  const cur = (before.steps && before.steps[stepKey]) || {};
  const prev = cur.status || 'todo';
  const changed = prev !== status;
  let doc = before;
  let wrote = false;

  if (changed) {
    const set = { [`steps.${stepKey}.status`]: status };
    const unset = {};
    const update = { $set: set };
    if (status === 'in_progress') {
      if (!cur.enteredAt) set[`steps.${stepKey}.enteredAt`] = now;
      unset[`steps.${stepKey}.completedAt`] = '';
      update.$inc = { [`steps.${stepKey}.attempts`]: 1 };
    } else if (status === 'todo') {
      unset[`steps.${stepKey}.completedAt`] = '';
    } else { // done | skipped
      if (!cur.enteredAt) set[`steps.${stepKey}.enteredAt`] = now;
      set[`steps.${stepKey}.completedAt`] = now;
    }
    if (Object.keys(unset).length) update.$unset = unset;
    await State.updateOne({ workspaceId: id }, update);
    wrote = true;
    doc = (await State.findOne({ workspaceId: id }).lean()) || before;
  }

  const d = deriveProgress(doc, now, { touch: changed });
  if (Object.keys(d.set).length || Object.keys(d.unset).length) {
    const update = { $set: d.set };
    if (Object.keys(d.unset).length) update.$unset = d.unset;
    await State.updateOne({ workspaceId: id }, update);
    wrote = true;
    doc = (await State.findOne({ workspaceId: id }).lean()) || doc;
  }

  if (wrote) stateModule.invalidate(id);
  if (changed && TRACK_TYPE[status]) {
    try { await trackOf(deps)(id, { type: TRACK_TYPE[status], step: stepKey }); } catch (_) { /* analytics never blocks */ }
  }
  return doc;
}

// ---------------------------------------------------------------------------------------------
// /state
// ---------------------------------------------------------------------------------------------

async function gateStateOf(workspaceId, deps) {
  if (deps && typeof deps.getGateState === 'function') return deps.getGateState(workspaceId, { fresh: true });
  return stateModule.getGateState(workspaceId, { fresh: true, deps });
}

/** Live role check (never the JWT role, which can be 30 days stale). */
async function isOwner(userId, workspaceId, deps) {
  try {
    if (!userId) return false;
    const Membership = modelOf(deps, 'Membership');
    const m = await Membership.findOne({ userId, workspaceId }).select('role').lean();
    return !!m && m.role === 'owner';
  } catch (_) { return false; }
}

async function unreadOf(workspaceId, deps) {
  try {
    const n = deps && deps.notifications ? deps.notifications : require('./notifications');
    const c = await n.unreadCount(workspaceId);
    return Number.isFinite(c) && c >= 0 ? c : 0;
  } catch (_) { return 0; }
}

// Orchestrator ruling 5: an erased (anonymised by the internal admin tool: Customer.deletedAt set) customer never counts
// toward the prompts' "done" check or the counts of /state. Same filter as shared/entitlements.js.
const NOT_ERASED = Object.freeze({ deletedAt: { $exists: false } });
async function countOf(deps, name, workspaceId, extra) {
  try {
    const n = await modelOf(deps, name).countDocuments({ workspaceId, ...(extra || {}) });
    return Number.isFinite(n) ? n : null;
  } catch (_) { return null; }
}
/** Read-only counts used by /state and by the prompts rule (null on failure). Erased customers are not counted (ruling 5). */
async function readCounts(workspaceId, deps) {
  const [customers, products, services] = await Promise.all([
    countOf(deps, 'Customer', workspaceId, NOT_ERASED), countOf(deps, 'Product', workspaceId), countOf(deps, 'Service', workspaceId),
  ]);
  return { customers, products, services };
}

function subscriptionBlock(gs) {
  const state = (gs.sub && gs.sub.state) || 'none';
  const sd = gate.subscriptionDenial(state);
  return {
    state,
    source: (gs.sub && gs.sub.source) || null,
    retry: sd ? sd.retry : { checkout: false, billingPortal: false, reconnect: false },
  };
}

function prefillOf(doc) {
  const p = (doc && doc.prefill) || {};
  const out = { businessName: p.businessName || null, email: p.email || null, planCode: p.planCode || null };
  return out.businessName || out.email || out.planCode ? out : null;
}

function checkoutBlock(doc) {
  const prices = config.stripePrices();
  const labels = config.planLabels();
  const lang = (doc && doc.business && doc.business.uiLanguage) === 'ar' ? 'ar' : 'en';
  const plans = Object.keys(prices).map((code) => {
    const l = labels && labels[code];
    const name = l && typeof l === 'object' && typeof l[lang] === 'string' && l[lang].trim() ? l[lang].trim() : null;
    return { code, name };
  });
  return { available: config.checkoutEnabled() && plans.length >= 1, plans };
}

/**
 * The billing subset for a workspace whose subscription is none|pending (DECISIONS C1): no setup data at all.
 * @param {{workspaceId:string, userId?:string, role?:string, deps?:object, gateState?:object, stateDoc?:object}} args
 */
async function buildBillingState(args = {}) {
  const { deps } = args;
  const id = String(args.workspaceId || '');
  const gs = args.gateState || await gateStateOf(id, deps);
  if (!gs || !gs.enrolled) return { enrolled: false };
  const doc = args.stateDoc || await stateModule.getState(id, deps);
  if (!doc) return { enrolled: false };
  const prefill = prefillOf(doc);
  return {
    enrolled: true,
    view: 'billing',
    subscription: subscriptionBlock(gs),
    checkout: checkoutBlock(doc),
    ...(prefill ? { prefill } : {}),
    locked: gs.locked !== false,
    notifications: { unread: await unreadOf(id, deps) },
    checkedAt: nowOf(deps).toISOString(),
  };
}

// Fallback when the status snapshot is unavailable: derive only the level from the row.
function fallbackLevel(conn) {
  if (!conn) return null;
  if (conn.needsReconnect || conn.status === 'reconnect_required') return 'reconnect_needed';
  if (conn.status === 'connected') return 'connected';
  if (conn.status === 'needs_attention' || conn.status === 'waba_only' || conn.status === 'error') return 'needs_attention';
  return null;
}

function maskedNumber(conn) {
  const d = (conn && conn.display) || {};
  if (d.displayPhoneNumber) return config.maskPhone(d.displayPhoneNumber);
  if (d.last4 && /^\d{4}$/.test(String(d.last4))) return `****${d.last4}`;
  return null;
}

async function connectionBlock(conn, owner, deps) {
  let snap = null;
  try {
    const sr = deps && deps.statusRefresh ? deps.statusRefresh : require('./statusRefresh');
    if (conn) snap = await sr.snapshot(conn);
  } catch (_) { snap = null; } // NOT_IMPLEMENTED (stub) or any failure: local fallback below, never throw
  if (!snap || typeof snap !== 'object') snap = null;

  let level;
  if (snap && Object.prototype.hasOwnProperty.call(snap, 'level')) level = LEVELS.includes(snap.level) ? snap.level : null;
  else level = fallbackLevel(conn);

  const cause = (snap && snap.cause) || {};
  const pick = (...vals) => { for (const v of vals) if (typeof v === 'string' && v) return v; return null; };
  const display = (conn && conn.display) || {};
  const block = {
    level,
    // the raw WhatsAppConnection.status (the word GET /connection and /connect/complete use; 'not_connected' without a row): the Step 3
    // screen tells a pending number (waba_only) or a partial run (connecting) from "never started" without asking GET /connection
    status: (conn && conn.status) || 'not_connected',
    numberMasked: maskedNumber(conn),
    verifiedName: pick(snap && snap.verifiedName, display.verifiedName),
    causeCode: pick(snap && snap.causeCode, cause.code),
    causePath: pick(snap && snap.causePath, cause.path),
    checkedAt: toIso((snap && (snap.checkedAt || snap.lastStatusCheckAt)) || (conn && conn.lastStatusCheckAt)),
  };
  if (owner) block.numberFull = (conn && conn.display && conn.display.displayPhoneNumber) || null;
  return block;
}

/**
 * The status of step 3 AS THE UI READS IT: the stored step status (todo|in_progress|done|skipped) plus, while step 3 is not
 * finished, what the connection row says: 'waba_only' (WhatsApp account connected, number pending), 'connecting' (a run is in
 * flight) or 'partial' (a run stopped at a failed step: resume). Only the VIEW changes: nothing is stored, the gate reads the
 * stored status.
 */
function connectStepView(status, conn) {
  if (status === 'done' || status === 'skipped' || !conn) return status;
  if (conn.status === 'waba_only') return 'waba_only';
  if (conn.status === 'connecting') {
    const cs = conn.connectSteps || {};
    return Object.keys(cs).some((k) => cs[k] && cs[k].status === 'failed') ? 'partial' : 'connecting';
  }
  return status;
}

function stepsBlock(doc, conn) {
  const out = {};
  for (const k of STEP_KEYS) {
    const s = (doc.steps && doc.steps[k]) || {};
    const stored = s.status || 'todo';
    out[k] = {
      status: k === 'connect' ? connectStepView(stored, conn) : stored,
      enteredAt: toIso(s.enteredAt),
      completedAt: toIso(s.completedAt),
      attempts: s.attempts || 0,
    };
  }
  return out;
}

function businessBlock(doc) {
  const b = doc.business || {};
  return {
    name: b.name || null,
    country: b.country || null,
    industry: b.industry || null,
    website: b.website || null,
    instagram: b.instagram || null,
    crNumber: b.crNumber || null,
    crSkipped: !!b.crSkipped,
    contactEmail: b.contactEmail || null,
    uiLanguage: b.uiLanguage === 'ar' ? 'ar' : 'en',
    languages: Array.isArray(b.languages) ? b.languages.slice() : null,
    industryOptions: INDUSTRY_KEYS.slice(),
  };
}

function numberBlock(doc) {
  const n = doc.number || {};
  return {
    path: n.path || null,
    usage: n.usage || null,
    hasNumber: typeof n.hasNumber === 'boolean' ? n.hasNumber : null,
    paused: !!(doc.progress && doc.progress.status === 'paused_number'),
    pausedAt: toIso(n.pausedAt),
    numberReady: !!n.numberReady,
    businessAppChoice: n.businessAppChoice || null,
    personalWarningAcknowledged: !!n.personalWarningAcknowledged,
    helpRequested: !!n.helpRequestedAt,
  };
}

function firstPromotionBlock(doc) {
  const f = doc.firstPromotion || {};
  return {
    state: f.state || 'locked',
    suggestedKey: f.suggestedKey || null,
    testMessageCount: f.testMessageCount || 0,
    testPhoneMasked: f.testPhoneMasked || null,
    startedAt: toIso(f.startedAt),
    doneAt: toIso(f.doneAt),
  };
}

const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * The last problem of the merchant's setup (what the Help button and /state.lastError show). Two writers exist: the sidecar
 * (OnboardingState.lastError {code, step, at}) and the Embedded Signup / status code, which only ever records the problem on
 * the CONNECTION row (WhatsAppConnection.lastError {code, kind, at}, cleared again when a connect or a refresh succeeds).
 * The newer of the two wins (a connection error is a step 'connect' problem). Never throws.
 * @returns {{code:string, step:string|null, at:string|null}|null}
 */
function lastErrorOf(doc, conn) {
  const cands = [];
  const side = doc && doc.lastError;
  if (side && typeof side.code === 'string' && ERROR_CODE_RE.test(side.code)) cands.push({ code: side.code, step: side.step || null, at: side.at });
  const own = conn && conn.lastError;
  if (own && typeof own.code === 'string' && ERROR_CODE_RE.test(own.code)) cands.push({ code: own.code, step: 'connect', at: own.at });
  if (!cands.length) return null;
  const t = (c) => { const n = c.at ? new Date(c.at).getTime() : NaN; return Number.isFinite(n) ? n : -1; };
  cands.sort((a, b) => t(b) - t(a)); // stable: a tie keeps the sidecar first
  const e = cands[0];
  return { code: e.code, step: e.step, at: toIso(e.at) };
}

function lastErrorBlock(doc, conn) {
  return lastErrorOf(doc, conn);
}

/**
 * The /state body (DECISIONS C1 / C11). Not enrolled -> { enrolled:false }; subscription none|pending -> the
 * billing subset; everything else (including past_due | cancelled) -> the FULL state.
 * `role` is accepted for symmetry with the route but NOT trusted: numberFull is decided by a live Membership check.
 * @param {{workspaceId:string, userId?:string, role?:string, deps?:object}} args
 */
async function buildState(args = {}) {
  const { deps } = args;
  const id = String(args.workspaceId || '');
  const gs = await gateStateOf(id, deps);
  if (!gs || !gs.enrolled) return { enrolled: false };
  const doc = await stateModule.getState(id, deps);
  if (!doc) return { enrolled: false };

  const subState = (gs.sub && gs.sub.state) || 'none';
  if (subState === 'none' || subState === 'pending') {
    return buildBillingState({ ...args, gateState: gs, stateDoc: doc });
  }

  let conn = null;
  try { conn = await modelOf(deps, 'WhatsAppConnection').findOne({ workspaceId: id }).lean(); } catch (_) { conn = null; }
  const [owner, counts, unread] = await Promise.all([
    isOwner(args.userId, id, deps), readCounts(id, deps), unreadOf(id, deps),
  ]);
  const connection = await connectionBlock(conn, owner, deps);

  const verdict = gate.evaluate(gs, { kind: 'send', policy: config.legacySendPolicy() });
  const finished = !!(doc.progress && doc.progress.completedAt);
  const stepIdx = (doc.progress && doc.progress.currentStep) || 1;
  const prompts = doc.prompts || {};
  return {
    enrolled: true,
    view: finished ? 'done' : 'setup',
    subscription: subscriptionBlock(gs),
    locked: gs.locked !== false,
    unlockAt: gs.unlockAt || config.unlockAt(),
    nextStep: nextStep(doc, conn),
    currentStep: STEP_KEYS[Math.min(Math.max(stepIdx, 1), STEP_KEYS.length) - 1],
    steps: stepsBlock(doc, conn),
    progress: { completedAt: toIso(doc.progress && doc.progress.completedAt), status: (doc.progress && doc.progress.status) || 'in_progress' },
    business: businessBlock(doc),
    number: numberBlock(doc),
    prompts: {
      customers: { state: (prompts.customers && prompts.customers.state) || 'pending' },
      products: { state: (prompts.products && prompts.products.state) || 'pending' },
      counts,
    },
    firstPromotion: firstPromotionBlock(doc),
    connection,
    sendingPaused: verdict.allowed ? null : { code: verdict.code },
    notifications: { unread },
    prefill: prefillOf(doc),
    lastError: lastErrorBlock(doc, conn),
    checkedAt: nowOf(deps).toISOString(),
  };
}

module.exports = {
  STEP_KEYS, STEP_INDEX, INDUSTRY_KEYS, COUNTRY_CODES,
  validateBusinessInput, nextStep, markStep, buildState, buildBillingState,
  // additions (B1-a): shared helpers of the routes and of support.js
  STEP_STATUSES, CONNECTION_EXISTS_STATUSES, cleanText, toIso, businessComplete, isFinished, deriveProgress,
  stepStatus, stepDone, numberPaused, connectionBroken, isOwner, readCounts, requestContext, trackEvent, connectStepView, lastErrorOf,
};
