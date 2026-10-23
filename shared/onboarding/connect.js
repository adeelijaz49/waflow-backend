'use strict';
// Embedded Signup server side of the onboarding flow (DB design 6.4): connect configuration, popup
// events, the 7-step connect orchestration, resume, disconnect and reportGraphError.
//
// Order is Meta's (exchange -> debug_token -> claim -> phone -> register -> subscribe -> details) because the
// authorization code is single use: the token is encrypted (tokenVault, AAD-bound) and persisted right after
// the exchange, every step persists its result, and every later step is re-runnable from the stored token.
//
// Everything external is injectable through `deps` (models, Graph client, vault, clock, random, notify,
// analytics, steps, starter templates). Real defaults are required lazily; nothing runs at require time.
// Nothing here logs or returns a token, an authorization code, a PIN or a full phone number.
const crypto = require('crypto');
const config = require('./config');
const metaConfig = require('./metaConfig');
const metaErrors = require('./metaErrors');
const { OnbError, CODES } = require('./errors');

const ID24 = /^[0-9a-f]{24}$/i;
const ATTEMPT_TTL_MS = 15 * 60 * 1000;
const LOCK_MS = 60 * 1000;
const NEXT_CHECK_MS = 2 * 60 * 1000;
const DISCONNECT_TTL_SEC = 300;
const EXPIRES_IN_SEC = 900;
const CONFIRM_TEXT = 'DISCONNECT';
const STEP_ORDER = Object.freeze(['exchange', 'debugToken', 'phone', 'register', 'subscribe', 'details']);
const STEP_REASON = Object.freeze({ exchange: 'exchange', debugToken: 'debug_token', phone: 'phone', register: 'register', subscribe: 'subscribe', details: 'details' });
const CONNECTED_STATUSES = Object.freeze(['connected', 'needs_attention']);
const COEXISTENCE_EVENT = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
const ONLY_WABA_EVENT = 'FINISH_ONLY_WABA';
// failures the merchant can act on keep their own code; transient ones are answered as CONNECT_PARTIAL (details.cause has the specific code)
const DEFINITIVE = Object.freeze(new Set([
  'CONNECT_WABA_MISMATCH', 'CONNECT_AMBIGUOUS_WABA', 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT', 'CONNECT_REGISTER_RATE_LIMITED',
  'META_TOKEN_REVOKED', 'META_PERMISSION_MISSING',
]));
const IMPACT_KEYS = Object.freeze(['sending', 'templates', 'number']);

// ---- small utilities ------------------------------------------------------------------------------------------------

const E = (code, opts) => new OnbError(code, opts);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function log(level, ...parts) { config.safeLog(level, '[onboarding] connect:', ...parts.map((p) => (typeof p === 'string' || typeof p === 'number' ? String(p) : ''))); }

function idOf(workspaceId) {
  const id = String(workspaceId || '');
  if (!ID24.test(id)) throw E('ONBOARDING_NOT_AVAILABLE');
  return id;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cur[keys[i]] === null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}
function delPath(obj, path) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cur[keys[i]] === null || typeof cur[keys[i]] !== 'object') return;
    cur = cur[keys[i]];
  }
  delete cur[keys[keys.length - 1]];
}

/** Context over the injectable dependencies (lazy real defaults). */
function makeCtx(deps) {
  const d = deps || {};
  const ctx = {
    raw: d,
    Connection: () => d.Connection || require('../../models/WhatsAppConnection'),
    Claim: () => d.Claim || require('../../models/WhatsAppClaim'),
    State: () => d.State || require('../../models/OnboardingState'),
    stateMod: () => d.state || require('./state'),
    vault: () => d.vault || require('./tokenVault'),
    meta: () => d.meta || require('./metaClient').getDefaultClient(),
    steps: () => d.steps || require('./steps'),
    starter: () => d.starterTemplates || require('./starterTemplates'),
    now() { const t = d.now ? d.now() : new Date(); return t instanceof Date ? new Date(t.getTime()) : new Date(t); },
    randomInt: (a, b) => (d.randomInt ? d.randomInt(a, b) : crypto.randomInt(a, b)),
    randomBytes: (n) => (d.randomBytes ? d.randomBytes(n) : crypto.randomBytes(n)),
    hmacSecret: () => (d.hmacSecret !== undefined ? d.hmacSecret : process.env.AUTH_JWT_SECRET) || null,
    appId() { return d.appId || (d.meta && d.meta.appId) || metaConfig.metaEsAppId() || null; },
  };
  ctx.modelDeps = () => {
    const m = {};
    if (d.State) m.OnboardingState = d.State;
    if (d.Connection) m.WhatsAppConnection = d.Connection;
    if (d.now) m.now = d.now;
    if (d.track) m.track = d.track;
    return m;
  };
  return ctx;
}

async function track(c, workspaceId, evt) {
  try {
    const fn = c.raw.track || require('./analytics').track;
    await fn(workspaceId, evt);
  } catch (_) { /* analytics must never break the flow */ }
}

async function notify(c, args) {
  try {
    const fn = c.raw.notify || require('./notifications').notify;
    return await fn(args);
  } catch (err) {
    log('warn', 'notify failed', err && err.code ? String(err.code) : '');
    return null;
  }
}

function invalidate(c, workspaceId) {
  try { c.stateMod().invalidate(workspaceId); } catch (_) { /* cache is best effort */ }
}

function vaultReady(c) {
  try { return !!c.vault().isConfigured(); } catch (_) { return false; }
}

function appSecretReady(c) {
  if (c.raw.meta) return true;
  return !!((process.env.META_ES_APP_SECRET && String(process.env.META_ES_APP_SECRET).trim()) || (process.env.WA_APP_SECRET && String(process.env.WA_APP_SECRET).trim()));
}

/** ENCRYPTION_NOT_CONFIGURED first (before ANY Graph call), then the Meta app credentials. */
function assertCanConnect(c) {
  if (!vaultReady(c)) throw E('ENCRYPTION_NOT_CONFIGURED');
  if (!appSecretReady(c) || !c.appId()) throw E('CONNECT_NOT_CONFIGURED');
}

async function readConn(c, workspaceId, withSecrets) {
  let q = c.Connection().findOne({ workspaceId });
  if (withSecrets) q = q.select('+tokenEncrypted +pinEncrypted');
  return q.lean();
}

async function ensureConn(c, workspaceId) {
  return c.stateMod().ensureConnection(workspaceId, c.modelDeps());
}

function stepStatus(conn, key) {
  const s = conn && conn.connectSteps && conn.connectSteps[key];
  return s && s.status ? s.status : 'pending';
}

function stepsSummary(conn) {
  const out = {};
  for (const k of STEP_ORDER) out[k] = stepStatus(conn, k);
  return out;
}

function connectionSummary(conn) {
  const ids = conn.ids || {};
  const display = conn.display || {};
  return {
    status: conn.status,
    numberMasked: display.displayPhoneNumber ? config.maskPhone(display.displayPhoneNumber) : null,
    verifiedName: display.verifiedName || null,
    phoneConnected: !!ids.phoneNumberId,
    webhookSubscribed: !!(conn.webhook && conn.webhook.subscribed),
    needsReconnect: !!conn.needsReconnect,
  };
}

/** UI level of a connection row (statusRefresh.connectionLevel is the single definition; a local fallback keeps this module standalone). */
function levelOf(conn) {
  try {
    const fn = require('./statusRefresh').connectionLevel;
    if (typeof fn === 'function') return fn(conn);
  } catch (_) { /* fall back below */ }
  if (!conn) return 'not_connected';
  if (conn.needsReconnect || conn.status === 'reconnect_required') return 'reconnect_needed';
  if (conn.status === 'connected') return 'connected';
  if (conn.status === 'needs_attention' || conn.status === 'waba_only' || conn.status === 'error') return 'needs_attention';
  return 'not_connected';
}

/** A stored result served again (replay / resume of a connected workspace) with the CURRENT status and level of the row. */
function freshResult(stored, conn) {
  return Object.assign({}, stored, { status: conn.status, level: levelOf(conn) });
}

/** The recognition memo of the merchant-WABA webhook interception must not delay a brand-new (or removed) WABA by up to 60 s. */
function clearWebhookMemo() {
  try { require('./webhookEvents').clearMemo(); } catch (_) { /* a cache, never a reason to fail */ }
}

function resultOf(conn) {
  return {
    status: conn.status,
    level: levelOf(conn),
    steps: stepsSummary(conn),
    connection: connectionSummary(conn),
    nextStep: conn.status === 'waba_only' ? 'connect' : (CONNECTED_STATUSES.includes(conn.status) ? 'approvals' : 'connect'),
  };
}

function plainJson(v) { return JSON.parse(JSON.stringify(v)); }

function causeCode(x) {
  if (typeof x === 'string') return CODES[x] ? x : 'META_ERROR';
  const cls = metaErrors.classify(x);
  return CODES[cls.appCode] ? cls.appCode : 'META_ERROR';
}

// ---- getConnectConfig -----------------------------------------------------------------------------------------------

function sdkLocaleOf(language) { return language === 'ar' ? 'ar_AR' : 'en_US'; }

function stepSatisfied(st, key) {
  const s = st && st.steps && st.steps[key] && st.steps[key].status;
  return s === 'done' || s === 'skipped';
}

/**
 * Payload for the Embedded Signup popup; also creates the open connect attempt (15 minutes).
 * @param {{workspaceId:string, userId?:string, reconnect?:boolean}} args reconnect: pin the attempt to the current WABA
 * @param {object} [deps]
 * @returns {Promise<{enabled:true, appId:string, configId:string, graphVersion:string, extras:object, sdkLocale:string, attemptId:string, expiresInSec:number, reconnect:({expectedWabaId:string}|null)}>}
 */
async function getConnectConfig(args = {}, deps) {
  const c = makeCtx(deps);
  const ws = idOf(args.workspaceId);
  const reconnect = args.reconnect === true;
  const st = await c.stateMod().ensureState(ws, c.modelDeps());
  if (!reconnect && (!stepSatisfied(st, 'business') || !stepSatisfied(st, 'number'))) throw E('STEP_PREREQUISITE');
  const appId = metaConfig.metaEsAppId();
  const configId = metaConfig.metaEsConfigId();
  if (!appId || !configId) throw E('CONNECT_NOT_CONFIGURED');
  // tell the merchant BEFORE the popup (a consumed code cannot be reused) when the server could not finish the connection
  assertCanConnect(c);

  const conn = await ensureConn(c, ws);
  const now = c.now();
  if (!reconnect && CONNECTED_STATUSES.includes(conn.status) && !conn.needsReconnect) throw E('NUMBER_ALREADY_CONNECTED');
  if (conn.connectLockUntil && new Date(conn.connectLockUntil) > now) throw E('CONNECT_IN_PROGRESS');

  const knownWaba = conn.ids && conn.ids.wabaId ? String(conn.ids.wabaId) : null;
  // identity is pinned on reconnect and when the WABA exists but the number is still missing; after a disconnect the merchant is free to choose
  const pin = knownWaba && conn.status !== 'disconnected' && (reconnect || conn.status === 'waba_only');
  const expectWabaId = pin ? knownWaba : null;
  const attemptId = c.randomBytes(16).toString('hex');
  const res = await c.Connection().updateOne(
    { workspaceId: ws, $or: [{ connectLockUntil: { $exists: false } }, { connectLockUntil: null }, { connectLockUntil: { $lte: now } }] },
    { $set: { connectAttempt: { id: attemptId, createdAt: now, expectWabaId } } },
  );
  if (!res || !(res.matchedCount > 0 || res.modifiedCount > 0 || res.n > 0)) throw E('CONNECT_IN_PROGRESS');

  return {
    enabled: true,
    appId,
    configId,
    graphVersion: metaConfig.GRAPH_VERSION(),
    extras: metaConfig.ES_EXTRAS(),
    sdkLocale: sdkLocaleOf(st.business && st.business.uiLanguage),
    attemptId,
    expiresInSec: EXPIRES_IN_SEC,
    reconnect: reconnect && expectWabaId ? { expectedWabaId: expectWabaId } : null,
  };
}

// ---- recordConnectEvent ---------------------------------------------------------------------------------------------

function cleanPopupText(raw) {
  let text = '';
  try { text = require('../localization/metaTemplates').cleanText(raw, 120); } catch (_) { text = ''; }
  if (!text) text = require('./metaClient').sanitizeMessage(raw);
  return Array.from(require('./metaClient').sanitizeMessage(text)).slice(0, 120).join('');
}

/**
 * The popup reported CANCEL / ERROR / NO_FACEBOOK: map it to the outcome the UI shows (DB 6.3).
 * @param {{workspaceId:string, attemptId:string, event:string, currentStep?:string, errorCode?:(number|string), errorMessage?:string}} args
 * @returns {Promise<{outcome:string, code:string, nextStep:string, copyKey:string}>}
 */
async function recordConnectEvent(args = {}, deps) {
  const c = makeCtx(deps);
  const ws = idOf(args.workspaceId);
  await c.stateMod().ensureState(ws, c.modelDeps());
  const event = typeof args.event === 'string' ? args.event.trim().toUpperCase() : '';
  if (!['CANCEL', 'ERROR', 'NO_FACEBOOK'].includes(event)) throw E('VALIDATION_FAILED', { details: { fields: ['event'] } });
  const attemptId = typeof args.attemptId === 'string' ? args.attemptId.trim() : '';
  if (!attemptId || attemptId.length > 80) throw E('VALIDATION_FAILED', { details: { fields: ['attemptId'] } });
  const currentStep = typeof args.currentStep === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(args.currentStep.trim()) ? args.currentStep.trim().toUpperCase() : null;
  const rawCode = args.errorCode;
  const errorCode = (typeof rawCode === 'number' && Number.isInteger(rawCode)) || (typeof rawCode === 'string' && /^\d{1,9}$/.test(rawCode.trim())) ? Number(rawCode) : null;
  const message = typeof args.errorMessage === 'string' ? cleanPopupText(args.errorMessage) : '';

  const out = metaErrors.popupOutcome({ event, errorCode, currentStep });
  log('info', 'popup', event.toLowerCase(), out.code, errorCode === null ? '' : `popupCode=${errorCode}`, message ? `msg=${message}` : '');
  await track(c, ws, { type: 'connect_event', step: 'connect', code: out.code, reason: event.toLowerCase() });
  if (out.outcome === 'error') {
    try {
      await c.Connection().updateOne({ workspaceId: ws }, { $set: { lastError: { code: out.code, kind: 'popup', at: c.now() } } });
    } catch (_) { /* informational only */ }
  }
  return out;
}

// ---- completeConnect / resumeConnect ---------------------------------------------------------------------------------

function cleanSession(s) {
  const out = {};
  if (!s || typeof s !== 'object' || Array.isArray(s)) return out;
  if (typeof s.event === 'string' && /^[A-Za-z_]{2,60}$/.test(s.event.trim())) out.event = s.event.trim().toUpperCase();
  for (const k of ['phone_number_id', 'waba_id', 'business_id']) {
    if ((typeof s[k] === 'string' || typeof s[k] === 'number') && /^\d{5,30}$/.test(String(s[k]).trim())) out[k] = String(s[k]).trim();
  }
  return out;
}

async function acquireLock(c, ws, now) {
  const until = new Date(now.getTime() + LOCK_MS);
  const res = await c.Connection().updateOne(
    { workspaceId: ws, $or: [{ connectLockUntil: { $exists: false } }, { connectLockUntil: null }, { connectLockUntil: { $lte: now } }] },
    { $set: { connectLockUntil: until } },
  );
  return !!(res && (res.matchedCount > 0 || res.modifiedCount > 0 || res.n > 0));
}

async function releaseLock(c, ws) {
  try { await c.Connection().updateOne({ workspaceId: ws }, { $set: { connectLockUntil: null } }); } catch (_) { /* the lock expires by itself in 60 s */ }
}

/** Persist a patch and mirror it into the run's local copy of the connection; refreshes the 60 s lock. */
async function persist(c, run, set, unset) {
  const now = c.now();
  const full = Object.assign({ connectLockUntil: new Date(now.getTime() + LOCK_MS) }, set || {});
  const update = { $set: full };
  if (unset && Object.keys(unset).length) update.$unset = unset;
  await c.Connection().updateOne({ workspaceId: run.ws }, update);
  for (const [k, v] of Object.entries(full)) setPath(run.conn, k, v);
  for (const k of Object.keys(unset || {})) delPath(run.conn, k);
}

function judgeAttempt(c, conn, attemptId) {
  const a = conn && conn.connectAttempt;
  if (!a || !a.id || a.id !== attemptId) return { kind: 'invalid' };
  if (a.usedAt) {
    if (a.result) return { kind: 'replay', result: a.result };
    // used without a stored result = a partial run: continue from the stored token, never exchange again
    if (conn.tokenEncrypted && stepStatus(conn, 'exchange') === 'done') return { kind: 'continue' };
    return { kind: 'invalid' };
  }
  const created = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  if (!created || c.now().getTime() - created > ATTEMPT_TTL_MS) return { kind: 'invalid' };
  return { kind: 'fresh' };
}

/** Record a failed step, leave the connection resumable and throw the right error. */
async function failStep(c, run, key, cause, rawErr) {
  const code = causeCode(cause);
  const now = c.now();
  const base = run.conn.status === 'waba_only' && run.resume ? 'waba_only' : 'connecting';
  const lastError = { code, kind: rawErr && rawErr.kind ? String(rawErr.kind) : undefined, at: now };
  if (rawErr && Number.isInteger(rawErr.subcode)) lastError.subcode = String(rawErr.subcode);
  const set = { [`connectSteps.${key}`]: { status: 'failed', at: now, errorCode: code }, status: base, lastError };
  if (key === 'register') set['registration.lastErrorCode'] = code;
  try { await persist(c, run, set); } catch (_) { /* the original failure is what matters */ }
  invalidate(c, run.ws);
  await track(c, run.ws, { type: 'connect_result', step: 'connect', code, reason: `failed:${STEP_REASON[key] || key}`, durationMs: Math.max(0, Math.min(86400000, now.getTime() - run.startedAt)) });
  log('warn', 'step failed', STEP_REASON[key] || key, code);
  throw E(DEFINITIVE.has(code) ? code : 'CONNECT_PARTIAL', { details: { step: key, cause: code, resumable: true } });
}

function exchangeFailure(err) {
  if (!err || !err.name || err.name !== 'MetaGraphError') return E('META_ERROR');
  if (err.kind === 'not_configured') return E('CONNECT_NOT_CONFIGURED');
  if (err.kind === 'network') return E('META_UNREACHABLE');
  if (err.httpStatus >= 500) return E('META_ERROR');
  if (err.kind === 'retry') return E('META_RATE_LIMITED');
  log('warn', 'exchange rejected', `http=${err.httpStatus}`, `graphCode=${err.code}`, `subcode=${err.subcode}`);
  return E('CONNECT_CODE_INVALID_OR_EXPIRED');
}

async function decryptToken(c, ws, conn) {
  try {
    return c.vault().decrypt(conn.tokenEncrypted, { workspaceId: ws, purpose: 'token' });
  } catch (err) {
    if (err && err.code === 'ENCRYPTION_NOT_CONFIGURED') throw E('ENCRYPTION_NOT_CONFIGURED');
    throw E('CONNECT_ATTEMPT_INVALID');
  }
}

// ---- the steps ---------------------------------------------------------------------------------------------------------

async function stepExchange(c, run) {
  let ex;
  try {
    ex = await c.meta().exchangeCode(run.code);
  } catch (err) {
    await track(c, run.ws, { type: 'connect_result', step: 'connect', code: exchangeFailure(err).code, reason: 'failed:exchange' });
    throw exchangeFailure(err);
  }
  const now = c.now();
  const vault = c.vault();
  const set = {
    tokenEncrypted: vault.encrypt(ex.accessToken, { workspaceId: run.ws, purpose: 'token' }),
    tokenKeyVersion: vault.keyVersion(),
    tokenIsValid: true,
    tokenCheckedAt: now,
    tokenExpiresAt: ex.expiresIn ? new Date(now.getTime() + ex.expiresIn * 1000) : null,
    status: 'connecting',
    'connectAttempt.usedAt': now,
    'connectAttempt.codeHash': sha256(run.code),
    connectSteps: {
      exchange: { status: 'done', at: now },
      debugToken: { status: 'pending' }, phone: { status: 'pending' }, register: { status: 'pending' }, subscribe: { status: 'pending' }, details: { status: 'pending' },
    },
  };
  await persist(c, run, set, { 'connectAttempt.result': '' });
  run.token = ex.accessToken;
  invalidate(c, run.ws);
}

/** Which WABA does this token own? The browser's claim only counts when the token's granular scopes confirm it. */
async function deriveWaba(c, run, info) {
  const targets = info.wabaTargetIds || [];
  const s = run.session || {};
  const expect = run.expectWabaId || null;
  const hasEvent = !!(s.event || s.phone_number_id || s.business_id);
  let wabaId = null;
  let source = 'debug_token';
  if (s.waba_id) {
    if (!targets.includes(s.waba_id)) return { error: 'CONNECT_WABA_MISMATCH' };
    wabaId = s.waba_id;
    source = 'event';
  } else if (expect && targets.includes(expect)) {
    wabaId = expect;
  } else if (!hasEvent) {
    if (!targets.length) return { error: 'CONNECT_AMBIGUOUS_WABA' };
    wabaId = targets[0]; // Meta lists the most recently onboarded WABA first
  } else if (targets.length === 1) {
    wabaId = targets[0];
  } else if (targets.length > 1 && s.phone_number_id) {
    for (const candidate of targets.slice(0, 5)) {
      const phones = await c.meta().listPhones(run.token, candidate, metaConfig.PHONE_FIELDS_CORE);
      if (phones.some((p) => p.id === s.phone_number_id)) { wabaId = candidate; break; }
    }
    if (!wabaId) return { error: 'CONNECT_AMBIGUOUS_WABA' };
  } else {
    return { error: 'CONNECT_AMBIGUOUS_WABA' };
  }
  if (expect && wabaId !== expect) return { error: 'CONNECT_WABA_MISMATCH' };
  return { wabaId, source };
}

/**
 * Take a cross-tenant claim ('waba:<id>' / 'phone:<id>'). Resolves { ok, fresh }: ok = this workspace holds the claim now; fresh = this
 * call TOOK it (it was free or released), as opposed to finding it already held by this workspace. Fresh claims are remembered on the run
 * so that a failure later in the run can release exactly those (release = releasedAt, rows are never deleted).
 */
async function claim(c, run, key, now) {
  try {
    const before = await c.Claim().findOneAndUpdate(
      { _id: key, $or: [{ workspaceId: run.ws }, { releasedAt: { $ne: null } }] },
      { $set: { workspaceId: run.ws, claimedAt: now, releasedAt: null } },
      { upsert: true, returnDocument: 'before' },
    );
    const fresh = !before || (before.releasedAt !== null && before.releasedAt !== undefined);
    if (fresh && run.claimed && !run.claimed.includes(key)) run.claimed.push(key);
    return { ok: true, fresh };
  } catch (err) {
    if (err && err.code === 11000) return { ok: false, fresh: false };
    throw err;
  }
}

/** A step of a run failed: the claims this run took go back (set releasedAt, never a delete). A resume takes them again from the stored ids. */
async function releaseRunClaims(c, run) {
  const keys = (run.claimed || []).splice(0);
  const now = c.now();
  for (const key of keys) {
    try { await c.Claim().updateOne({ _id: key, workspaceId: run.ws }, { $set: { releasedAt: now } }); } catch (err) { log('warn', 'claim not released', err && err.code ? String(err.code) : ''); }
  }
}

/** The PLATFORM's own WhatsApp account can never be connected by a merchant (it would own the platform ids; disconnecting it would remove the production webhook subscription). */
const isPlatform = (ids) => config.isPlatformAccount(ids);

/**
 * Refuse a connection that resolved to the platform's own account, BEFORE any claim, id or Graph write: the exchanged token is not
 * kept, nothing stays resumable, the row goes back to where it was. The answer is the existing code "number in use by another account"
 * with its neutral message (it does not say which account it is).
 */
async function refusePlatform(c, run, key) {
  const code = 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT';
  const now = c.now();
  const base = run.conn.disconnectedAt ? 'disconnected' : 'not_connected';
  const set = { status: base, tokenIsValid: false, [`connectSteps.${key}`]: { status: 'failed', at: now, errorCode: code }, lastError: { code, kind: 'platform_account', at: now } };
  try { await persist(c, run, set, { tokenEncrypted: '', tokenExpiresAt: '', tokenDataAccessExpiresAt: '' }); } catch (_) { /* the refusal is what matters */ }
  await releaseRunClaims(c, run);
  invalidate(c, run.ws);
  await track(c, run.ws, { type: 'connect_result', step: 'connect', code, reason: `failed:${STEP_REASON[key] || key}`, durationMs: Math.max(0, Math.min(86400000, now.getTime() - run.startedAt)) });
  log('warn', 'platform account refused', STEP_REASON[key] || key);
  throw E(code, { details: { step: key, cause: code, resumable: false } });
}

/** Every Graph write of a run goes through here first: a stored id that became the platform's (the env was set later) is never written to. */
async function assertNotPlatform(c, run, key) {
  const ids = run.conn.ids || {};
  if (isPlatform({ wabaId: ids.wabaId, phoneNumberId: ids.phoneNumberId })) await refusePlatform(c, run, key);
}

/**
 * The state that belongs to ONE Meta account (kind 'account') or ONE number (kind 'number') must not survive a switch to another one:
 * the merchant's own confirmation of the old account's billing, its verification and health, the display name, the registration (and
 * its PIN) of the old number. The new run reads all of it again. Pure: the patch to persist.
 */
function accountResetPatch(kind) {
  const set = { 'registration.attempts': 0 };
  const unset = {
    'registration.registeredAt': '', 'registration.lastErrorCode': '', pinEncrypted: '', displayName: '', quality: '', messagingLimit: '',
    'ids.platformType': '', 'ids.isOnBizApp': '',
  };
  if (kind === 'account') {
    set['payment.status'] = 'unknown';
    Object.assign(unset, { 'payment.confirmedAt': '', 'payment.probeFundingIdPresent': '', 'payment.checkedAt': '', health: '', verification: '', 'ids.businessId': '' });
  }
  return { set, unset };
}

async function resetAccountState(c, run, kind, wabaId) {
  const { set, unset } = accountResetPatch(kind);
  if (kind === 'account') {
    // the starter templates of the old account do not exist on the new one: queue them again (the rows stay)
    try {
      const starter = c.starter();
      if (starter && typeof starter.requeueForAccount === 'function') await starter.requeueForAccount({ workspaceId: run.ws, wabaId });
    } catch (err) { log('warn', 'starter templates not re-queued', err && err.code ? String(err.code) : ''); }
  }
  await persist(c, run, set, unset);
  await track(c, run.ws, { type: 'connect_event', step: 'connect', code: 'ACCOUNT_SWITCHED', reason: kind === 'account' ? 'waba_changed' : 'number_changed' });
}

async function stepDebugToken(c, run) {
  const key = 'debugToken';
  let info;
  try { info = await c.meta().debugToken(run.token); } catch (err) { return failStep(c, run, key, err, err); }
  if (!info.isValid) return failStep(c, run, key, 'META_TOKEN_REVOKED');
  let derived;
  try { derived = await deriveWaba(c, run, info); } catch (err) { return failStep(c, run, key, err, err); }
  if (derived.error) return failStep(c, run, key, derived.error);
  const s = run.session || {};
  // the platform's own account is refused before any claim, id or Graph write (the browser's phone id counts too)
  if (isPlatform({ wabaId: derived.wabaId, phoneNumberId: s.phone_number_id })) return refusePlatform(c, run, key);
  const now = c.now();
  const claimed = await claim(c, run, `waba:${derived.wabaId}`, now);
  if (!claimed.ok) return failStep(c, run, key, 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT');
  // another Meta account than the one this row held: its per-account state must not carry over (R7-03)
  const stored = run.conn.ids || {};
  if (stored.wabaId && String(stored.wabaId) !== String(derived.wabaId)) await resetAccountState(c, run, 'account', derived.wabaId);
  const set = {
    'ids.wabaId': derived.wabaId,
    'ids.wabaSource': derived.source,
    'ids.metaUserId': info.userId || null,
    tokenIsValid: true,
    tokenCheckedAt: now,
    'connectSteps.debugToken': { status: 'done', at: now },
  };
  // expires_at 0 = never: the exchange's expires_in guess is replaced by the authoritative value
  set.tokenExpiresAt = info.expiresAt || null;
  if (info.dataAccessExpiresAt) set.tokenDataAccessExpiresAt = info.dataAccessExpiresAt;
  if (s.event) set['ids.onboardingEvent'] = s.event;
  if (s.business_id) set['ids.businessId'] = s.business_id;
  // The phone number id the browser reported is only a HINT: it is neither claimed nor stored as an id here (R7-08 / R2-04). The phone
  // step claims and stores the id Graph returns, after the merchant's own token read it and the WABA's number list contained it.
  if (s.phone_number_id) set['connectAttempt.phoneHint'] = s.phone_number_id;
  await persist(c, run, set);
  clearWebhookMemo(); // the WABA id is known now: merchant webhook events are recognised at once
}

async function stepPhone(c, run) {
  const key = 'phone';
  await assertNotPlatform(c, run, key);
  const ids = run.conn.ids || {};
  const wabaId = ids.wabaId;
  const hint = (run.session && run.session.phone_number_id) || (run.conn.connectAttempt && run.conn.connectAttempt.phoneHint) || null;
  const storedId = ids.phoneNumberId ? String(ids.phoneNumberId) : null;
  let phoneId = null;
  let listed = null;
  try {
    if (ids.onboardingEvent === ONLY_WABA_EVENT && !run.resume) phoneId = null;
    else {
      listed = await c.meta().listPhones(run.token, wabaId, metaConfig.PHONE_FIELDS_CORE);
      const idOfPhone = (p) => (p && p.id !== undefined && p.id !== null ? String(p.id) : null);
      const has = (id) => !!id && listed.some((p) => idOfPhone(p) === id);
      if (hint) {
        if (!has(String(hint))) return failStep(c, run, key, 'CONNECT_WABA_MISMATCH'); // the browser named a number this account does not own
        phoneId = String(hint);
      } else if (has(storedId) && (run.reconnect || run.resume)) {
        phoneId = storedId; // a reconnect (or a resumed run) without a hint keeps the number it had
      } else {
        phoneId = listed.length ? idOfPhone(listed[0]) : null;
      }
    }
  } catch (err) { return failStep(c, run, key, err, err); }
  const now = c.now();
  if (!phoneId) {
    await persist(c, run, { 'connectSteps.phone': { status: 'skipped', at: now }, 'ids.phoneNumberId': null });
    return undefined;
  }
  if (isPlatform({ wabaId, phoneNumberId: phoneId })) return refusePlatform(c, run, key);
  let phone;
  try { phone = await c.meta().getPhone(run.token, phoneId, metaConfig.PHONE_FIELDS_FULL); } catch (err) { return failStep(c, run, key, err, err); }
  // the id GRAPH returned, never the browser's string (they are equal unless something is wrong)
  const verifiedId = phone && phone.id !== undefined && phone.id !== null && String(phone.id) !== '' ? String(phone.id) : phoneId;
  if (listed && !listed.some((p) => p && String(p.id) === verifiedId)) return failStep(c, run, key, 'CONNECT_WABA_MISMATCH');
  if (isPlatform({ wabaId, phoneNumberId: verifiedId })) return refusePlatform(c, run, key);
  const phoneClaim = await claim(c, run, `phone:${verifiedId}`, now);
  if (!phoneClaim.ok) return failStep(c, run, key, 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT');
  // another number than the one this row held: the registration and name of the old one do not carry over (R7-03)
  if (storedId && storedId !== verifiedId) await resetAccountState(c, run, 'number');
  const tier = metaConfig.tierFromRaw(phone.messagingLimit);
  const set = {
    'ids.phoneNumberId': verifiedId,
    'ids.platformType': phone.platformType || null,
    'display.displayPhoneNumber': phone.displayPhoneNumber || null,
    'display.last4': phone.last4 || null,
    'display.verifiedName': phone.verifiedName || null,
    'displayName.nameStatusRaw': phone.nameStatus || null,
    'displayName.mapped': metaConfig.mapNameStatus(phone.nameStatus),
    'displayName.checkedAt': now,
    'quality.ratingRaw': phone.qualityRating || null,
    'quality.checkedAt': now,
    'connectSteps.phone': { status: 'done', at: now },
  };
  if (phone.isOnBizApp !== null) set['ids.isOnBizApp'] = phone.isOnBizApp;
  if (tier.raw) { set['messagingLimit.raw'] = tier.raw; set['messagingLimit.tierNumber'] = tier.tierNumber; set['messagingLimit.checkedAt'] = now; }
  await persist(c, run, set);
  run.phone = phone;
  return undefined;
}

function generatePin(c) {
  const n = c.randomInt(10 ** (metaConfig.REGISTER_PIN_LENGTH - 1), 10 ** metaConfig.REGISTER_PIN_LENGTH);
  return String(n).padStart(metaConfig.REGISTER_PIN_LENGTH, '0');
}

async function stepRegister(c, run) {
  const key = 'register';
  await assertNotPlatform(c, run, key);
  const ids = run.conn.ids || {};
  const now = c.now();
  const skip = async () => persist(c, run, { 'connectSteps.register': { status: 'skipped', at: now } });
  if (stepStatus(run.conn, 'phone') === 'skipped' || !ids.phoneNumberId) return skip();
  if (ids.onboardingEvent === COEXISTENCE_EVENT) return skip();
  let phone = run.phone;
  if (!phone) {
    try { phone = await c.meta().getPhone(run.token, ids.phoneNumberId, metaConfig.PHONE_FIELDS_CORE); } catch (err) { return failStep(c, run, key, err, err); }
  }
  if (phone.isOnBizApp === true) return skip();
  // The live status of THIS phone number decides (R7-03): a registration record of ANOTHER number never skips it (the switch above clears it),
  // and our own record of this very number only counts when Meta did not report a status at all.
  const live = phone.status ? String(phone.status).toUpperCase() : null;
  if (live === 'CONNECTED') return skip();
  if (!live && run.conn.registration && run.conn.registration.registeredAt) return skip();

  // the PIN is encrypted and stored BEFORE the call (a crash must never lose the PIN Meta has just accepted); a stored PIN is reused
  let pin = null;
  if (run.conn.pinEncrypted) {
    try { pin = c.vault().decrypt(run.conn.pinEncrypted, { workspaceId: run.ws, purpose: 'pin' }); } catch (_) { pin = null; }
  }
  if (!pin || !/^\d{6}$/.test(pin)) {
    pin = generatePin(c);
    await persist(c, run, { pinEncrypted: c.vault().encrypt(pin, { workspaceId: run.ws, purpose: 'pin' }) });
  }
  const attempts = ((run.conn.registration && run.conn.registration.attempts) || 0) + 1;
  await persist(c, run, { 'registration.attempts': attempts });
  try {
    await c.meta().registerPhone(run.token, ids.phoneNumberId, pin); // ONE attempt per run
  } catch (err) {
    return failStep(c, run, key, err, err);
  }
  await persist(c, run, { 'registration.registeredAt': c.now(), 'connectSteps.register': { status: 'done', at: c.now() } }, { 'registration.lastErrorCode': '' });
  return undefined;
}

async function stepSubscribe(c, run) {
  const key = 'subscribe';
  await assertNotPlatform(c, run, key);
  const wabaId = run.conn.ids.wabaId;
  try {
    await c.meta().subscribeApp(run.token, wabaId);
    const listed = await c.meta().listSubscribedApps(run.token, wabaId);
    const appId = c.appId();
    const confirmed = appId ? listed.appIds.includes(String(appId)) : listed.appIds.length > 0;
    if (!confirmed) return failStep(c, run, key, 'META_ERROR');
  } catch (err) {
    if (err && err.name === 'OnbError') throw err;
    return failStep(c, run, key, err, err);
  }
  const now = c.now();
  await persist(c, run, { 'webhook.subscribed': true, 'webhook.subscribedAt': now, 'webhook.checkedAt': now, 'connectSteps.subscribe': { status: 'done', at: now } });
  return undefined;
}

function healthIssues(health) {
  const out = [];
  for (const e of (health && health.entities) || []) {
    for (const er of e.errors || []) {
      if (out.length < 10) out.push({ entityType: e.entityType || undefined, code: er.code === null ? undefined : String(er.code) });
    }
  }
  return out;
}

async function markConnectStep(c, ws, status, now) {
  let done = false;
  try {
    await c.steps().markStep(ws, 'connect', status, c.raw.stepsDeps);
    done = true;
  } catch (err) {
    if (!err || err.code !== 'NOT_IMPLEMENTED') log('warn', 'markStep failed', err && err.code ? String(err.code) : '');
  }
  const State = c.State();
  try {
    if (!done) {
      const set = { 'steps.connect.status': status };
      if (status === 'done') set['steps.connect.completedAt'] = now;
      await State.updateOne({ workspaceId: ws }, { $set: set });
    }
    if (status === 'done') {
      // guaranteed, idempotent: the prompts appear as soon as step 3 completes (spec 0b)
      await State.updateOne({ workspaceId: ws, 'progress.currentStep': { $lt: 4 } }, { $set: { 'progress.currentStep': 4 } });
      await State.updateOne({ workspaceId: ws, 'progress.furthestStep': { $lt: 4 } }, { $set: { 'progress.furthestStep': 4 } });
      await State.updateOne({ workspaceId: ws, 'prompts.promptedAt': { $exists: false } }, { $set: { 'prompts.promptedAt': now } });
    } else if (status === 'todo') {
      await State.updateOne({ workspaceId: ws, 'progress.currentStep': { $gt: 3 } }, { $set: { 'progress.currentStep': 3 } });
    }
  } catch (err) {
    log('warn', 'step bookkeeping failed', err && err.code ? String(err.code) : '');
  }
}

async function stepDetails(c, run) {
  const key = 'details';
  let waba;
  try { waba = await c.meta().getWaba(run.token, run.conn.ids.wabaId); } catch (err) { return failStep(c, run, key, err, err); }
  const now = c.now();
  const wabaOnly = stepStatus(run.conn, 'phone') === 'skipped';
  const health = waba.healthStatus || null;
  const needsAttention = !!(health && health.canSend && health.canSend !== 'AVAILABLE');
  const status = wabaOnly ? 'waba_only' : (needsAttention ? 'needs_attention' : 'connected');
  const tier = metaConfig.tierFromRaw(waba.messagingLimit);
  const set = {
    status,
    'connectSteps.details': { status: 'done', at: now },
    'verification.businessRaw': waba.businessVerificationStatus || null,
    'verification.mapped': metaConfig.mapVerification(waba.businessVerificationStatus),
    'verification.checkedAt': now,
    'health.canSend': health && health.canSend && ['AVAILABLE', 'LIMITED', 'BLOCKED'].includes(health.canSend) ? health.canSend : null,
    'health.issues': healthIssues(health),
    'health.checkedAt': now,
    nextCheckAt: new Date(now.getTime() + NEXT_CHECK_MS),
    lastStatusCheckAt: now,
    connectedByUserId: run.userId || null,
    needsReconnect: false,
    checkFailures: 0,
  };
  if (!wabaOnly) set.connectedAt = now;
  if (tier.raw && !(run.conn.messagingLimit && run.conn.messagingLimit.raw)) {
    set['messagingLimit.raw'] = tier.raw; set['messagingLimit.tierNumber'] = tier.tierNumber; set['messagingLimit.checkedAt'] = now;
  }
  const unset = { reconnectReason: '', lastError: '' };
  const firstConnection = !run.conn.connectedAt; // a reconnect keeps the same WABA: nothing to seed again
  await persist(c, run, set, unset);
  // the stored result is what a replay of this attempt returns (masked number only)
  const result = plainJson(resultOf(run.conn));
  await persist(c, run, { 'connectAttempt.result': result, connectLockUntil: null });
  run.result = result;
  clearWebhookMemo();

  if (!(run.reconnect && !firstConnection)) {
    try { await c.starter().seedStarterTemplates(run.ws); } catch (err) { log('warn', 'starter templates not seeded', err && err.code ? String(err.code) : ''); }
  }
  if (!wabaOnly) {
    await markConnectStep(c, run.ws, 'done', now);
    // e-mail too (spec Step 4: tell the merchant by e-mail and in the app); first insert of this key only
    await notify(c, { workspaceId: run.ws, kind: 'connected', dedupeKey: `connected:${now.getTime()}`, severity: 'success', actionPath: '/setup/approvals', params: {}, email: true });
  }
  invalidate(c, run.ws);
  await track(c, run.ws, {
    type: 'connect_result', step: 'connect', reason: status,
    durationMs: Math.max(0, Math.min(86400000, now.getTime() - run.startedAt)),
    meta: { attempt: (run.conn.registration && run.conn.registration.attempts) || 0 },
  });
  if (!wabaOnly) submitStarterTemplatesSoon(c, run.ws); // best effort, never awaited
  return undefined;
}

// ---- immediate starter-template submission (best effort, never awaited) ----------------------------------------------------

const SUBMIT_AFTER_CONNECT_MAX = 5; // the same cap as one scheduler tick
const background = new Set();

/** Only an enrolled workspace whose subscription is positively NOT active is skipped (the scheduler submits for active ones only). Fail-open. */
async function subscriptionAllowsSubmit(c, ws) {
  try {
    const gs = await c.stateMod().getGateState(ws);
    return !(gs && gs.enrolled && gs.sub && gs.sub.state !== 'active');
  } catch (_) {
    return true; // no gate state (a fake, a read error): the claim-protected submit is harmless
  }
}

/**
 * A completed connection hands the queued starter templates to Meta at once instead of at the next scheduler tick (up to 10 minutes,
 * 5 per tick). NON-BLOCKING: nothing awaits the job, so the connect answer, the stored result and every replay are untouched; errors
 * are swallowed and only their code is logged. Idempotent: starterTemplates.submitQueued claims every row before its Graph call,
 * so this call and a scheduler tick (or a second resume) can never submit a row twice.
 * @param {object} c the connect context
 * @param {string} ws workspace id
 */
function submitStarterTemplatesSoon(c, ws) {
  const job = (async () => {
    try {
      const starter = c.starter();
      if (!starter || typeof starter.submitQueued !== 'function') return;
      if (!(await subscriptionAllowsSubmit(c, ws))) return;
      await starter.submitQueued({ workspaceId: ws, max: SUBMIT_AFTER_CONNECT_MAX });
    } catch (err) {
      log('warn', 'template submit after connect skipped', err && err.code ? String(err.code) : '');
    }
  })();
  background.add(job);
  const forget = () => { background.delete(job); };
  job.then(forget, forget);
}

/** Resolves once every background submission started by this module has settled (tests and graceful shutdown; the request path never waits). */
async function idle() {
  while (background.size) await Promise.allSettled([...background]);
}

const HANDLERS = Object.freeze({
  debugToken: stepDebugToken, phone: stepPhone, register: stepRegister, subscribe: stepSubscribe, details: stepDetails,
});

/**
 * A resumed run starts from ids that earlier steps verified: their claims are taken again (a failed run released them), so another
 * account that took the number in between wins and this run stops with the same definitive code.
 */
async function reclaimStored(c, run) {
  const ids = run.conn.ids || {};
  const now = c.now();
  if (ids.wabaId && stepStatus(run.conn, 'debugToken') === 'done') {
    const r = await claim(c, run, `waba:${ids.wabaId}`, now);
    if (!r.ok) await failStep(c, run, 'debugToken', 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT');
  }
  if (ids.phoneNumberId && stepStatus(run.conn, 'phone') === 'done') {
    const r = await claim(c, run, `phone:${ids.phoneNumberId}`, now);
    if (!r.ok) await failStep(c, run, 'phone', 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT');
  }
}

async function execute(c, run) {
  run.claimed = run.claimed || [];
  try {
    if (run.fresh && isPlatform({ wabaId: run.session && run.session.waba_id, phoneNumberId: run.session && run.session.phone_number_id })) {
      // the popup itself named the platform's own account: refused before the single-use code is spent
      await track(c, run.ws, { type: 'connect_result', step: 'connect', code: 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT', reason: 'failed:platform_account' });
      log('warn', 'platform account refused before the code exchange');
      throw E('CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT', { details: { step: 'exchange', cause: 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT', resumable: false } });
    }
    if (!run.fresh) await reclaimStored(c, run);
    for (const key of STEP_ORDER) {
      if (key === 'exchange') {
        if (run.fresh) await stepExchange(c, run);
        continue;
      }
      const st = stepStatus(run.conn, key);
      if (st === 'done' || st === 'skipped') continue;
      await HANDLERS[key](c, run);
    }
    return run.result;
  } catch (err) {
    await releaseRunClaims(c, run); // a later step failed: the claims this run took go back (R7-08 / R2-04)
    throw err;
  }
}

/**
 * Finish the Embedded Signup: exchange the single-use code, find and claim the WABA, read the number, register it
 * when needed, subscribe the app and read the account details.
 * @param {{workspaceId:string, userId:string, attemptId:string, code:string, session?:{event?:string, phone_number_id?:string, waba_id?:string, business_id?:string}}} args
 * @param {object} [deps]
 * @returns {Promise<{status:string, steps:object, connection:object, nextStep:string}>}
 */
async function completeConnect(args = {}, deps) {
  const c = makeCtx(deps);
  const ws = idOf(args.workspaceId);
  const attemptId = typeof args.attemptId === 'string' ? args.attemptId.trim() : '';
  const code = typeof args.code === 'string' ? args.code.trim() : '';
  const bad = [];
  if (!attemptId || attemptId.length > 80) bad.push('attemptId');
  if (!code || code.length > 1024) bad.push('code');
  if (bad.length) throw E('VALIDATION_FAILED', { details: { fields: bad } });

  const st = await c.stateMod().ensureState(ws, c.modelDeps());
  if (!stepSatisfied(st, 'business') || !stepSatisfied(st, 'number')) throw E('STEP_PREREQUISITE');
  assertCanConnect(c); // ENCRYPTION_NOT_CONFIGURED before ANY Graph call

  let conn = await readConn(c, ws, true);
  if (!conn) conn = await ensureConn(c, ws);
  let verdict = judgeAttempt(c, conn, attemptId);
  if (verdict.kind === 'invalid') throw E('CONNECT_ATTEMPT_INVALID');
  if (verdict.kind === 'replay') return freshResult(verdict.result, conn);

  if (!(await acquireLock(c, ws, c.now()))) throw E('CONNECT_IN_PROGRESS');
  try {
    // re-read under the lock: a concurrent run may have finished (replay) or the attempt may have been replaced
    conn = await readConn(c, ws, true);
    verdict = judgeAttempt(c, conn, attemptId);
    if (verdict.kind === 'invalid') throw E('CONNECT_ATTEMPT_INVALID');
    if (verdict.kind === 'replay') return freshResult(verdict.result, conn);

    const run = {
      ws, userId: String(args.userId || ''), conn, code, startedAt: c.now().getTime(),
      session: cleanSession(args.session),
      expectWabaId: conn.connectAttempt.expectWabaId || null,
      reconnect: !!conn.connectAttempt.expectWabaId,
      fresh: verdict.kind === 'fresh', resume: verdict.kind === 'continue', token: null,
    };
    if (run.resume) {
      run.token = await decryptToken(c, ws, conn);
      const ids = conn.ids || {};
      run.session = { event: ids.onboardingEvent || undefined, phone_number_id: ids.phoneNumberId || (conn.connectAttempt && conn.connectAttempt.phoneHint) || undefined, business_id: ids.businessId || undefined };
    }
    return await execute(c, run);
  } finally {
    await releaseLock(c, ws);
  }
}

/**
 * Re-run a partial connection from the first step that is not done, using the stored token (no code needed).
 * Also re-checks a connection that finished without a phone number (status waba_only).
 * @param {{workspaceId:string, userId:string}} args
 * @param {object} [deps]
 */
async function resumeConnect(args = {}, deps) {
  const c = makeCtx(deps);
  const ws = idOf(args.workspaceId);
  await c.stateMod().ensureState(ws, c.modelDeps());
  if (!vaultReady(c)) throw E('ENCRYPTION_NOT_CONFIGURED');
  let conn = await readConn(c, ws, true);
  const resumable = (x) => !!(x && x.tokenEncrypted && ['connecting', 'waba_only'].includes(x.status));
  if (conn && CONNECTED_STATUSES.includes(conn.status) && !conn.needsReconnect && conn.connectAttempt && conn.connectAttempt.result) return freshResult(conn.connectAttempt.result, conn);
  if (!resumable(conn)) throw E('CONNECT_ATTEMPT_INVALID');
  if (!(await acquireLock(c, ws, c.now()))) throw E('CONNECT_IN_PROGRESS');
  try {
    conn = await readConn(c, ws, true);
    if (conn && CONNECTED_STATUSES.includes(conn.status) && !conn.needsReconnect && conn.connectAttempt && conn.connectAttempt.result) return freshResult(conn.connectAttempt.result, conn);
    if (!resumable(conn)) throw E('CONNECT_ATTEMPT_INVALID');
    if (!appSecretReady(c) || !c.appId()) throw E('CONNECT_NOT_CONFIGURED');
    const ids = conn.ids || {};
    const run = {
      ws, userId: String(args.userId || ''), conn, code: null, startedAt: c.now().getTime(),
      session: { event: ids.onboardingEvent || undefined, phone_number_id: ids.phoneNumberId || (conn.connectAttempt && conn.connectAttempt.phoneHint) || undefined, business_id: ids.businessId || undefined },
      expectWabaId: (conn.connectAttempt && conn.connectAttempt.expectWabaId) || null,
      reconnect: !!(conn.connectAttempt && conn.connectAttempt.expectWabaId),
      fresh: false, resume: true, token: null,
    };
    run.token = await decryptToken(c, ws, conn);
    if (conn.status === 'waba_only') {
      // the number may have been added since: look again (phone, register, details)
      await persist(c, run, { 'connectSteps.phone': { status: 'pending' }, 'connectSteps.register': { status: 'pending' }, 'connectSteps.details': { status: 'pending' }, 'connectSteps.subscribe': { status: 'pending' } });
    }
    return await execute(c, run);
  } finally {
    await releaseLock(c, ws);
  }
}

// ---- disconnect ----------------------------------------------------------------------------------------------------------

function signDisconnect(secret, userId, ws, nonce, exp) {
  return crypto.createHmac('sha256', secret).update(`${userId}:${ws}:disconnect:${nonce}:${exp}`).digest('hex');
}

function impactKeysOf(conn) {
  const keys = [];
  const live = CONNECTED_STATUSES.includes(conn.status) || conn.status === 'waba_only';
  if (live) keys.push('sending');
  if (live) keys.push('templates');
  if (conn.ids && conn.ids.phoneNumberId) keys.push('number');
  return keys.filter((k) => IMPACT_KEYS.includes(k));
}

/**
 * Step one of the two-step disconnect: a confirmation token bound to this user and workspace (HMAC-SHA256 with
 * AUTH_JWT_SECRET, 300 s). The page lists impactKeys, the owner types DISCONNECT.
 * @param {{workspaceId:string, userId:string}} args
 * @param {object} [deps]
 * @returns {Promise<{confirmationToken:string, expiresInSec:number, impactKeys:string[]}>}
 */
async function requestDisconnect(args = {}, deps) {
  const c = makeCtx(deps);
  const ws = idOf(args.workspaceId);
  const userId = String(args.userId || '');
  await c.stateMod().ensureState(ws, c.modelDeps());
  const secret = c.hmacSecret();
  if (!secret) throw E('CONNECT_NOT_CONFIGURED', { details: { reason: 'SIGNING_SECRET_MISSING' } });
  const conn = await readConn(c, ws, false);
  if (!conn || ['not_connected', 'disconnected'].includes(conn.status)) throw E('VALIDATION_FAILED', { details: { reason: 'NOT_CONNECTED' } });
  const nonce = c.randomBytes(16).toString('hex');
  const exp = Math.floor(c.now().getTime() / 1000) + DISCONNECT_TTL_SEC;
  const sig = signDisconnect(secret, userId, ws, nonce, exp);
  return { confirmationToken: `${nonce}.${exp}.${sig}`, expiresInSec: DISCONNECT_TTL_SEC, impactKeys: impactKeysOf(conn) };
}

function verifyDisconnectToken(c, token, userId, ws) {
  const secret = c.hmacSecret();
  if (!secret) throw E('CONNECT_NOT_CONFIGURED', { details: { reason: 'SIGNING_SECRET_MISSING' } });
  const m = typeof token === 'string' ? /^([0-9a-f]{32})\.(\d{9,12})\.([0-9a-f]{64})$/.exec(token.trim()) : null;
  if (!m) throw E('VALIDATION_FAILED', { details: { reason: 'CONFIRMATION_INVALID' } });
  const exp = Number(m[2]);
  const expected = Buffer.from(signDisconnect(secret, userId, ws, m[1], exp), 'hex');
  const given = Buffer.from(m[3], 'hex');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) throw E('VALIDATION_FAILED', { details: { reason: 'CONFIRMATION_INVALID' } });
  if (exp * 1000 <= c.now().getTime()) throw E('VALIDATION_FAILED', { details: { reason: 'CONFIRMATION_EXPIRED' } });
}

/**
 * Step two: best-effort unsubscribe, then the stored token is removed, claims are released and step 3 goes back to
 * todo. Ids and the PIN are kept and the document is NEVER deleted.
 * @param {{workspaceId:string, userId:string, confirmationToken:string, confirmText:string}} args
 * @param {object} [deps]
 * @returns {Promise<{status:'disconnected', unsubscribed:boolean}>}
 */
async function disconnect(args = {}, deps) {
  const c = makeCtx(deps);
  const ws = idOf(args.workspaceId);
  const userId = String(args.userId || '');
  await c.stateMod().ensureState(ws, c.modelDeps());
  if (typeof args.confirmText !== 'string' || args.confirmText.trim() !== CONFIRM_TEXT) throw E('VALIDATION_FAILED', { details: { fields: ['confirmText'] } });
  verifyDisconnectToken(c, args.confirmationToken, userId, ws);
  const conn = await readConn(c, ws, true);
  if (!conn || conn.status === 'not_connected') throw E('VALIDATION_FAILED', { details: { reason: 'NOT_CONNECTED' } });
  if (conn.status === 'disconnected') return { status: 'disconnected', unsubscribed: false };

  let unsubscribed = false;
  const wabaId = conn.ids && conn.ids.wabaId;
  // never an unsubscribe for the PLATFORM's own account: that would remove the production webhook subscription
  if (conn.tokenEncrypted && wabaId && vaultReady(c) && !isPlatform({ wabaId })) {
    try {
      const token = c.vault().decrypt(conn.tokenEncrypted, { workspaceId: ws, purpose: 'token' });
      await c.meta().unsubscribeApp(token, wabaId);
      unsubscribed = true;
    } catch (err) {
      log('warn', 'unsubscribe skipped', err && err.code ? String(err.code) : '');
    }
  }
  const now = c.now();
  await c.Connection().updateOne({ workspaceId: ws }, {
    $set: {
      status: 'disconnected', disconnectedAt: now, disconnectedByUserId: userId, tokenIsValid: false,
      'webhook.subscribed': false, needsReconnect: false, connectLockUntil: null, nextCheckAt: null,
      connectSteps: { exchange: { status: 'pending' }, debugToken: { status: 'pending' }, phone: { status: 'pending' }, register: { status: 'pending' }, subscribe: { status: 'pending' }, details: { status: 'pending' } },
    },
    $unset: { tokenEncrypted: '', tokenExpiresAt: '', connectAttempt: '', reconnectReason: '' },
  });
  for (const key of [wabaId && `waba:${wabaId}`, conn.ids && conn.ids.phoneNumberId && `phone:${conn.ids.phoneNumberId}`].filter(Boolean)) {
    try { await c.Claim().updateOne({ _id: key, workspaceId: ws }, { $set: { releasedAt: now } }); } catch (err) { log('warn', 'claim not released', err && err.code ? String(err.code) : ''); }
  }
  await markConnectStep(c, ws, 'todo', now);
  invalidate(c, ws);
  clearWebhookMemo(); // the removed connection is a DROPPED (disconnected) WABA from now on
  await track(c, ws, { type: 'status_change', step: 'connect', code: 'DISCONNECTED', reason: 'owner_disconnect' });
  await notify(c, {
    workspaceId: ws, kind: 'reconnect_needed', dedupeKey: `disconnect:${now.getTime()}`, severity: 'warning', actionPath: '/setup/connect',
    params: { reason: 'DISCONNECTED_BY_OWNER' }, email: true,
  });
  return { status: 'disconnected', unsubscribed };
}

// ---- reportGraphError ----------------------------------------------------------------------------------------------------

function reconnectReasonOf(err) {
  const sub = err && Number.isInteger(err.subcode) ? err.subcode : null;
  if (sub === 458) return 'APP_UNINSTALLED';
  if (sub === 463) return 'TOKEN_EXPIRED';
  return 'TOKEN_REVOKED';
}

/**
 * A merchant-token Graph call failed: remember it, and flip needsReconnect when Meta says the token is gone.
 * Never throws and never blocks the caller.
 * @param {string} workspaceId
 * @param {Error|object} err a MetaGraphError (or any Graph error shape)
 * @param {object} [deps]
 * @returns {Promise<void>}
 */
async function reportGraphError(workspaceId, err, deps) {
  try {
    const c = makeCtx(deps);
    const ws = String(workspaceId || '');
    if (!ID24.test(ws)) return;
    const cls = metaErrors.classify(err);
    const now = c.now();
    const lastError = { code: CODES[cls.appCode] ? cls.appCode : 'META_ERROR', kind: cls.kind, at: now };
    if (err && Number.isInteger(err.subcode)) lastError.subcode = String(err.subcode);
    await c.Connection().updateOne({ workspaceId: ws }, { $set: { lastError } });
    if (cls.kind === 'reconnect') {
      const reason = reconnectReasonOf(err);
      const flipped = await c.Connection().findOneAndUpdate(
        { workspaceId: ws, status: { $in: ['connected', 'needs_attention', 'waba_only'] }, needsReconnect: { $ne: true } },
        // status reconnect_required too: the same pair statusRefresh.markNeedsReconnect writes (every reader accepts either)
        { $set: { needsReconnect: true, reconnectReason: reason, status: 'reconnect_required' } },
        { returnDocument: 'after' },
      ).lean();
      if (flipped) {
        const stamp = flipped.connectedAt ? new Date(flipped.connectedAt).getTime() : 0;
        await track(c, ws, { type: 'status_change', step: 'connect', code: 'RECONNECT_NEEDED', reason: reason.toLowerCase() });
        await notify(c, { workspaceId: ws, kind: 'reconnect_needed', dedupeKey: `reconnect:${reason}:${stamp}`, severity: 'action', actionPath: '/setup/connect', params: { reason }, email: true });
      }
    }
    invalidate(c, ws);
  } catch (e) {
    log('warn', 'reportGraphError failed', e && e.code ? String(e.code) : '');
  }
}

module.exports = {
  getConnectConfig,
  recordConnectEvent,
  completeConnect,
  resumeConnect,
  requestDisconnect,
  disconnect,
  reportGraphError,
  // additions (documented in B1-c.md)
  CONNECT_CONSTANTS: Object.freeze({ ATTEMPT_TTL_MS, LOCK_MS, NEXT_CHECK_MS, DISCONNECT_TTL_SEC, EXPIRES_IN_SEC, CONFIRM_TEXT, STEP_ORDER }),
  _internal: { cleanSession, judgeAttempt, deriveWaba, signDisconnect, causeCode, resultOf, impactKeysOf, levelOf, freshResult, idle, submitStarterTemplatesSoon },
};
