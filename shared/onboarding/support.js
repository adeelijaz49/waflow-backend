'use strict';
// "Need help?" and the number-help request of the onboarding flow (DB design 7.2, DECISIONS C13).
//   getHelpContext        data for the client-built wa.me / mailto link (no Workspace.name, no phone, no token)
//   buildPrefilledText    the plain-English pre-filled message (English on purpose, for support staff)
//   createSupportRequest  DB-counted limit (3 per day per kind), 10-minute de-duplication (ATOMIC: a unique window key, review R7-05), e-mail
//                         to support (best effort, never fails the request), in-app note. It NEVER buys a number.
// Collaborators owned by other engineers (email.sendSupportEmail, notifications) are required lazily and
// can be replaced through `deps` (email, notifications, OnboardingSupportRequest, OnboardingState, now, track).
const config = require('./config');
const { OnbError } = require('./errors');
const stateModule = require('./state');
const steps = require('./steps');

const ID_RE = /^[0-9a-f]{24}$/i;
const KINDS = Object.freeze(['number_help', 'help', 'payment_help']);
const LIMIT_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const MESSAGE_MAX = 300;
const EMAIL_TIMEOUT_MS = 8000;
// the same numbering the client uses for "Step n of 5" (customers / products belong to step 3 in the UI)
const STEP_NUMBER = Object.freeze({ business: 1, number: 2, connect: 3, customers: 3, products: 3, approvals: 4, promotion: 5 });
const EVENT_STEPS = Object.freeze(['business', 'number', 'connect', 'approvals', 'customers', 'products', 'promotion', 'billing']);

function nowOf(deps) { return deps && typeof deps.now === 'function' ? deps.now() : new Date(); }
function modelOf(deps, name) { return (deps && deps[name]) || require(`../../models/${name}`); }

/** A free-text label that must carry neither an e-mail address nor a phone number. */
function safeLabel(value) {
  const v = steps.cleanText(value).slice(0, 80);
  if (!v) return '-';
  if (/\S+@\S+/.test(v) || (v.match(/\d/g) || []).length >= 7) return '-';
  return v;
}

/**
 * The pre-filled help message (plain English, no phone number, no token, no e-mail address).
 * @param {{businessName?:string|null, stepKey?:string|null, lastErrorCode?:string|null, language?:string}} input
 * @returns {string}
 */
function buildPrefilledText(input = {}) {
  const key = typeof input.stepKey === 'string' && /^[a-z_]{1,30}$/.test(input.stepKey) ? input.stepKey : null;
  const code = typeof input.lastErrorCode === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(input.lastErrorCode) ? input.lastErrorCode : 'none';
  let stepLine;
  if (key && STEP_NUMBER[key]) stepLine = `Step: ${STEP_NUMBER[key]} of 5 (${key})`;
  else if (key === 'billing') stepLine = 'Step: payment (billing)';
  else if (key === 'done') stepLine = 'Step: setup finished (done)';
  else stepLine = 'Step: unknown';
  return [
    'Hi WaFlow, I need help with my setup.',
    `Business: ${safeLabel(input.businessName)}`,
    stepLine,
    `Last problem: ${code}`,
    `Language: ${input.language === 'ar' ? 'ar' : 'en'}`,
  ].join('\n');
}

async function connectionOf(workspaceId, deps) {
  try { return await modelOf(deps, 'WhatsAppConnection').findOne({ workspaceId }).lean(); } catch (_) { return null; }
}

/** The step key the merchant is on (drives the pre-filled text). */
function stepKeyOf(doc, conn) {
  const sub = (doc.subscription && doc.subscription.state) || 'none';
  if (sub === 'none' || sub === 'pending') return 'billing';
  return steps.nextStep(doc, conn) || 'done';
}

/**
 * Data for the "Need help?" deep link (GET /help-context, gate E).
 * @param {{workspaceId:string, userId?:string, deps?:object}} args
 * @returns {Promise<{businessName:string|null, step:number|null, stepKey:string, lastError:{code:string,at:string|null}|null, supportEmail:string|null, supportWhatsapp:string|null, prefilledText:string}>}
 */
async function getHelpContext({ workspaceId, deps } = {}) {
  const id = String(workspaceId || '');
  const doc = await stateModule.ensureState(id, deps); // 404 ONBOARDING_NOT_AVAILABLE when not enrolled
  const conn = await connectionOf(id, deps);
  const stepKey = stepKeyOf(doc, conn);
  const own = safeLabel(doc.business && doc.business.name);
  const pre = safeLabel(doc.prefill && doc.prefill.businessName);
  const businessName = own !== '-' ? own : (pre !== '-' ? pre : null);
  const le = steps.lastErrorOf(doc, conn); // the sidecar error or the connection row's (Embedded Signup problems live there), newer wins
  const e = le ? { code: le.code, at: le.at } : null;
  const cfg = config.supportConfig();
  const language = doc.business && doc.business.uiLanguage === 'ar' ? 'ar' : 'en';
  return {
    businessName,
    step: STEP_NUMBER[stepKey] || (stepKey === 'done' ? 5 : null),
    stepKey,
    lastError: e,
    supportEmail: cfg.email || null,
    supportWhatsapp: cfg.whatsapp || null,
    prefilledText: buildPrefilledText({ businessName, stepKey, lastErrorCode: e && e.code, language }),
  };
}

/** A short, safe code for a failed e-mail (never a message body). */
function emailErrorCode(err) {
  if (err && typeof err.code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(err.code)) return err.code.toUpperCase();
  const status = err && (err.statusCode || err.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) return `HTTP_${status}`;
  return 'EMAIL_FAILED';
}

function requestView(row) {
  return {
    id: String(row._id),
    kind: row.kind,
    step: row.step || null,
    status: row.status || 'open',
    createdAt: steps.toIso(row.createdAt),
    emailSentAt: steps.toIso(row.emailSentAt),
    emailError: row.emailError || null,
  };
}

/** Send the support e-mail; swallows EVERYTHING; returns { sentAt?:Date, error?:string }. */
async function mailSupport(plain, deps) {
  let timer;
  try {
    const mod = (deps && deps.email) || require('./email');
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'EMAIL_TIMEOUT' })), (deps && deps.emailTimeoutMs) || EMAIL_TIMEOUT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    const result = await Promise.race([Promise.resolve().then(() => mod.sendSupportEmail(plain)), timeout]);
    if (result && result.sent === false) {
      const why = typeof result.skipped === 'string' && /^[a-z_]{1,30}$/.test(result.skipped) ? result.skipped.toUpperCase() : 'EMAIL_NOT_SENT';
      return { error: why };
    }
    return { sentAt: nowOf(deps) };
  } catch (err) {
    return { error: emailErrorCode(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Create a help request (kind number_help | help | payment_help) unless one was created in the last 10 minutes
 * (then that one is returned); at most 3 per day per workspace and kind (counted in the database, so it holds
 * across instances; 429 RATE_LIMITED with Retry-After beyond that). The e-mail to support is best effort: a failure
 * is stored as a short code on the row and never fails the request. NEVER buys a number.
 * @param {{workspaceId:string, userId?:string, kind:string, step?:string, message?:string}} args
 * @param {object} [deps]
 * @returns {Promise<{request:object, duplicate:boolean}>}
 */
async function createSupportRequest(args = {}, deps) {
  const kind = args.kind;
  if (!KINDS.includes(kind)) throw new OnbError('VALIDATION_FAILED', { details: { reason: 'UNKNOWN_KIND' } });
  const message = steps.cleanText(args.message === undefined || args.message === null ? '' : args.message);
  if (message.length > MESSAGE_MAX) throw new OnbError('VALIDATION_FAILED', { details: { fields: { message: 'LENGTH' } } });

  const id = String(args.workspaceId || '');
  const doc = await stateModule.ensureState(id, deps);
  const Req = modelOf(deps, 'OnboardingSupportRequest');
  const now = nowOf(deps);
  const nowMs = now.getTime();

  const found = await Req.find({ workspaceId: id, kind, createdAt: { $gte: new Date(nowMs - DAY_MS) } })
    .select('_id kind step status createdAt emailSentAt emailError').lean();
  const recent = (found || [])
    .map((r) => ({ ...r, _t: new Date(r.createdAt).getTime() }))
    .filter((r) => Number.isFinite(r._t))
    .sort((a, b) => a._t - b._t);

  const latest = recent[recent.length - 1];
  if (latest && nowMs - latest._t < DUPLICATE_WINDOW_MS) return { request: requestView(latest), duplicate: true };
  if (recent.length >= LIMIT_PER_DAY) {
    const frees = recent[recent.length - LIMIT_PER_DAY]; // when this one leaves the 24 h window the merchant may ask again
    const retryAfterSec = Math.max(1, Math.ceil((frees._t + DAY_MS - nowMs) / 1000));
    throw new OnbError('RATE_LIMITED', { retryAfterSec });
  }

  const conn = await connectionOf(id, deps);
  const stepKey = typeof args.step === 'string' && EVENT_STEPS.includes(args.step) ? args.step : stepKeyOf(doc, conn);
  const business = doc.business || {};
  const row = {
    workspaceId: id,
    kind,
    step: EVENT_STEPS.includes(stepKey) ? stepKey : undefined,
    lastErrorCode: (steps.lastErrorOf(doc, conn) || {}).code || undefined,
    message: message || undefined,
    businessName: (business.name && steps.cleanText(business.name).slice(0, 80)) || (doc.prefill && doc.prefill.businessName) || undefined,
    contactEmail: business.contactEmail || (doc.prefill && doc.prefill.email) || undefined,
    status: 'open',
  };
  if (args.userId && ID_RE.test(String(args.userId))) row.userId = String(args.userId);
  // Atomic de-duplication: the row carries its 10-minute window key and the unique {workspaceId, kind, windowKey} index lets exactly ONE of any
  // number of simultaneous requests create it; the others get E11000 and are answered with that row (no second row, no second e-mail).
  row.windowKey = String(Math.floor(nowMs / DUPLICATE_WINDOW_MS));
  let created;
  try {
    created = await Req.create(row);
  } catch (err) {
    if (!(err && err.code === 11000)) throw err;
    const winner = await Req.findOne({ workspaceId: id, kind, windowKey: row.windowKey }).select('_id kind step status createdAt emailSentAt emailError').lean();
    if (winner) return { request: requestView(winner), duplicate: true };
    throw err;
  }
  const createdPlain = typeof created.toObject === 'function' ? created.toObject() : created;
  const rowId = String(createdPlain._id);

  if (kind === 'number_help') {
    try {
      await modelOf(deps, 'OnboardingState').updateOne({ workspaceId: id }, { $set: { 'number.helpRequestedAt': now, 'number.helpRequestId': rowId } });
    } catch (err) { config.safeLog('warn', '[onboarding] help request not recorded on the state:', err && err.code); }
  }

  const { windowKey, ...mailRow } = row; // eslint-disable-line no-unused-vars
  const mail = await mailSupport({ ...mailRow, id: rowId, _id: rowId, createdAt: steps.toIso(createdPlain.createdAt || now) }, deps);
  try {
    const set = mail.sentAt ? { emailSentAt: mail.sentAt } : { emailError: mail.error };
    await Req.updateOne({ _id: createdPlain._id }, { $set: set });
  } catch (_) { /* bookkeeping only */ }

  try {
    const n = (deps && deps.notifications) || require('./notifications');
    await n.notify({ workspaceId: id, kind: 'help_received', dedupeKey: `help_received:${rowId}`, params: { kind }, severity: 'info', actionPath: '/setup' });
  } catch (_) { /* never blocks */ }
  try {
    const track = deps && typeof deps.track === 'function' ? deps.track : require('./analytics').track;
    await track(id, { type: 'help_opened', step: row.step, reason: 'support_request' });
  } catch (_) { /* never blocks */ }

  return {
    request: requestView({ ...createdPlain, _id: createdPlain._id, emailSentAt: mail.sentAt, emailError: mail.sentAt ? undefined : mail.error }),
    duplicate: false,
  };
}

module.exports = {
  getHelpContext, createSupportRequest, buildPrefilledText,
  // additions (B1-a)
  safeLabel, emailErrorCode, KINDS, LIMIT_PER_DAY, DUPLICATE_WINDOW_MS, MESSAGE_MAX, STEP_NUMBER,
};
