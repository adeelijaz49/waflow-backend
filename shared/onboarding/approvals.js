'use strict';
// Step 4 "Get approved" view model, the payment self-attestation and the display-name edit (DB design 6.6,
// DECISIONS C5 / C11 / D11).
//
//   buildApprovals(workspaceId)   five rows (verification, displayName, payment, messagingLimit, templates),
//                                 all blocking:false, status done | waiting | needs_you
//   confirmPayment(workspaceId)   self-attestation: payment.status = 'merchant_confirmed' (never "verified")
//   changeDisplayName(...)        owner action: Graph new_display_name, refuses at 10 changes in 30 days
//   reRegisterDueNames(...)       scheduler job: re-register with the stored PIN within 14 days of an approval
//
// Read-only on OnboardingTemplate. Tokens and PINs are decrypted only inside changeDisplayName /
// reRegisterDueNames, used for the Graph call and never logged or returned.
const config = require('./config');
const metaConfig = require('./metaConfig');
const { OnbError } = require('./errors');
const statusRefresh = require('./statusRefresh');

const DAY = 24 * 60 * 60 * 1000;
const REREGISTER_WINDOW_MS = 14 * DAY;
const REREGISTER_MAX_ATTEMPTS = 6;
const CONTROL_RE = /[\x00-\x1f\x7f]/g; // eslint-disable-line no-control-regex
const BIDI_RE = new RegExp(`[${[0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff].map((c) => String.fromCharCode(c)).join('')}]`, 'g');
const NAME_REASON_KEYS_IN_CATALOG = Object.freeze(['NAME_EMPLOYEE_ISSUE', 'NAME_INDIVIDUAL_ISSUE', 'NAME_ENDCLIENT_NOTRELATED', 'NAME_FORMAT_UNACCEPTABLE', 'NAME_NOT_CONSISTENT']);

function dep(deps, name, load) { return deps && deps[name] ? deps[name] : load(); }
const Conn = (deps) => dep(deps, 'Connection', () => require('../../models/WhatsAppConnection'));
const Tpl = (deps) => dep(deps, 'Template', () => require('../../models/OnboardingTemplate'));
const getVault = (deps) => dep(deps, 'vault', () => require('./tokenVault'));
const getAnalytics = (deps) => dep(deps, 'analytics', () => require('./analytics'));
const getMeta = (deps) => dep(deps, 'meta', () => require('./metaClient').getDefaultClient());
function nowMs(deps) {
  const v = deps && deps.now ? deps.now() : Date.now();
  return v instanceof Date ? v.getTime() : Number(v);
}
const idStr = (v) => (v === undefined || v === null ? '' : String(v));
function ms(v) {
  if (v === undefined || v === null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}
const iso = (v) => { const t = ms(v); return t === null ? null : new Date(t).toISOString(); };
function get(obj, path) { return path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj); }
async function track(deps, workspaceId, evt) {
  try { await getAnalytics(deps).track(String(workspaceId), evt); } catch (_) { /* never blocks */ }
}

/** Recent edit timestamps (ms), newest last, within the last 30 days. */
function recentEdits(conn, t) {
  const list = Array.isArray(get(conn, 'displayName.editsLast30d')) ? conn.displayName.editsLast30d : [];
  return list.map(ms).filter((x) => x !== null && t - x < 30 * DAY).sort((a, b) => a - b);
}

function links() {
  return {
    securityCenter: metaConfig.META_SECURITY_CENTER_URL(),
    paymentHelp: metaConfig.META_PAYMENT_HELP_URL(),
    paymentSettings: metaConfig.META_PAYMENT_SETTINGS_URL(),
    whatsappManager: metaConfig.META_WHATSAPP_MANAGER_URL(),
  };
}

const STATUS_OF = Object.freeze({ done: 'done', waiting: 'waiting', needs_you: 'needs_you' });
const asStatus = (mapped) => STATUS_OF[mapped] || 'waiting'; // 'unknown' / missing -> waiting ("we're checking")

/**
 * The Step 4 view model.
 * @param {string} workspaceId
 * @param {{Connection?:object, Template?:object, now?:()=>number}} [deps]
 * @returns {Promise<{rows:object[], overall:'done'|'waiting'|'needs_you', checkedAt:string|null, level:string}>}
 */
async function buildApprovals(workspaceId, deps = {}) {
  const ws = idStr(workspaceId);
  const t = nowMs(deps);
  const conn = await Conn(deps).findOne({ workspaceId: ws }).lean();
  let tplRows = [];
  try { tplRows = await Tpl(deps).find({ workspaceId: ws }).lean(); } catch (_) { tplRows = []; }
  const linkSet = links();
  const checkedAt = conn ? iso(conn.lastStatusCheckAt) : null;
  const level = statusRefresh.connectionLevel(conn, t);
  const row = (key, status, extra) => ({
    key, status, valueKey: null, value: null, reasonKey: null, blocking: false, links: linkSet, checkedAt, ...extra,
  });

  // verification
  const vMapped = get(conn, 'verification.mapped') || 'unknown';
  const vStatus = asStatus(vMapped);
  const vWord = { done: 'done', waiting: 'waiting', needs_you: 'needs' }[vStatus];
  const verification = row('verification', vStatus, {
    valueKey: `onboarding.approvals.verification.${vMapped === 'unknown' ? 'unknown' : vWord}`,
    value: get(conn, 'verification.businessRaw') || null,
    reasonKey: vStatus === 'needs_you' ? 'onboarding.approvals.verification.needs' : null,
  });

  // display name
  const dn = (conn && conn.displayName) || {};
  const dnMapped = dn.mapped || 'unknown';
  const dnStatus = asStatus(dnMapped);
  const edits = recentEdits(conn, t);
  const editsRemaining = conn && get(conn, 'ids.phoneNumberId') ? Math.max(0, metaConfig.DISPLAY_NAME_EDITS_PER_30D - edits.length) : null;
  const connectedNow = !!conn && config.CONNECTED_LIKE.includes(conn.status) && !conn.needsReconnect && !!get(conn, 'ids.phoneNumberId');
  let rejectionKey = null;
  if (dnStatus === 'needs_you') {
    rejectionKey = Object.prototype.hasOwnProperty.call(metaConfig.NAME_REJECTION_KEYS, dn.rejectionReason) ? dn.rejectionReason : 'UNKNOWN';
  }
  const displayName = row('displayName', dnStatus, {
    valueKey: `onboarding.approvals.name.${{ done: 'done', waiting: 'waiting', needs_you: 'needs' }[dnStatus]}`,
    value: dn.newName || dn.requested || get(conn, 'display.verifiedName') || null,
    reasonKey: rejectionKey && NAME_REASON_KEYS_IN_CATALOG.includes(rejectionKey) ? `onboarding.approvals.name.reason.${rejectionKey}` : (rejectionKey ? 'onboarding.approvals.name.needs' : null),
    canEdit: connectedNow && editsRemaining > 0 && dnMapped !== 'waiting',
    editsRemaining,
    rejectionKey,
  });

  // payment: Meta documents no API that reads a payment method (D11): self-attestation only
  const payStatus = get(conn, 'payment.status') || 'unknown';
  const payDone = payStatus === 'merchant_confirmed' || payStatus === 'probe_positive';
  const payment = row('payment', payDone ? 'done' : 'needs_you', {
    valueKey: payDone ? 'onboarding.approvals.payment.confirmed' : 'onboarding.approvals.payment.cantSee',
    value: payStatus,
    reasonKey: payDone ? null : 'onboarding.approvals.payment.cantSee',
  });

  // messaging limit: shows what Meta reports, never promises numbers
  const limitRaw = get(conn, 'messagingLimit.raw') || null;
  const tierNumber = get(conn, 'messagingLimit.tierNumber');
  const tierNum = tierNumber === undefined || tierNumber === null ? null : tierNumber;
  const messagingLimit = row('messagingLimit', limitRaw ? 'done' : 'waiting', {
    valueKey: tierNum !== null ? 'onboarding.approvals.limit.value' : 'onboarding.approvals.limit.unknown',
    value: tierNum !== null ? tierNum : limitRaw,
    tierNumber: tierNum,
    raw: limitRaw,
  });

  // templates: read-only aggregate of the starter set
  const agg = statusRefresh.templateAggregate(tplRows);
  const lastChecked = tplRows.map((r) => ms(r.lastCheckedAt)).filter((x) => x !== null).sort((a, b) => b - a)[0];
  const templates = row('templates', agg.status, {
    valueKey: 'onboarding.approvals.templates.summary',
    value: `${agg.approved}/${agg.total}`,
    reasonKey: agg.reasonKey,
    counts: { approved: agg.approved, total: agg.total, waiting: agg.waiting, problem: agg.problem },
    rejectedReason: agg.rejectedReason,
    checkedAt: lastChecked ? new Date(lastChecked).toISOString() : checkedAt,
  });

  const rows = [verification, displayName, payment, messagingLimit, templates];
  const overall = rows.some((r) => r.status === 'needs_you') ? 'needs_you' : rows.some((r) => r.status === 'waiting') ? 'waiting' : 'done';
  return { rows, overall, checkedAt, level };
}

/**
 * Keep step 4 of the checklist in step with what the merchant sees: the first view of the approvals moves a never-opened
 * step to in_progress (B1-a's nextStep then moves on to the prompts), and a view where every row is done completes it.
 * Never regresses a step, never throws (a failure must not break the read).
 * @param {string} workspaceId
 * @param {'done'|'waiting'|'needs_you'} overall
 * @param {{stateModule?:object, steps?:object, stateDeps?:object, stepsDeps?:object}} [deps]
 * @returns {Promise<'in_progress'|'done'|null>} the status written, or null
 */
async function touchProgress(workspaceId, overall, deps = {}) {
  try {
    const ws = idStr(workspaceId);
    const stateMod = deps.stateModule || require('./state');
    const steps = deps.steps || require('./steps');
    const doc = await stateMod.getState(ws, deps.stateDeps);
    if (!doc) return null;
    const cur = get(doc, 'steps.approvals.status') || 'todo';
    let target = null;
    if (cur === 'todo') target = 'in_progress';
    if (overall === 'done' && cur !== 'done' && cur !== 'skipped') target = 'done';
    if (!target) return null;
    await steps.markStep(ws, 'approvals', target, deps.stepsDeps);
    return target;
  } catch (_) {
    return null;
  }
}

/**
 * Payment self-attestation (D11). Idempotent; never claims the payment method is verified.
 * @param {string} workspaceId
 * @param {{Connection?:object, analytics?:object, now?:()=>number}} [deps]
 * @returns {Promise<{ok:true, payment:{status:string, confirmedAt:string|null}, alreadyConfirmed:boolean}>}
 */
async function confirmPayment(workspaceId, deps = {}) {
  const ws = idStr(workspaceId);
  const conn = await Conn(deps).findOne({ workspaceId: ws }).lean();
  if (!conn || conn.status === 'not_connected' || conn.status === 'disconnected') throw new OnbError('WHATSAPP_NOT_CONNECTED');
  const cur = get(conn, 'payment.status') || 'unknown';
  if (cur === 'merchant_confirmed' || cur === 'probe_positive') {
    return { ok: true, payment: { status: cur, confirmedAt: iso(get(conn, 'payment.confirmedAt')) }, alreadyConfirmed: true };
  }
  const now = new Date(nowMs(deps));
  const res = await Conn(deps).updateOne(
    { _id: conn._id, 'payment.status': { $nin: ['merchant_confirmed', 'probe_positive'] } },
    { $set: { 'payment.status': 'merchant_confirmed', 'payment.confirmedAt': now } },
  );
  if (res && (res.modifiedCount > 0 || res.nModified > 0)) {
    await track(deps, ws, { type: 'status_change', step: 'approvals', code: 'PAYMENT_CONFIRMED', reason: 'merchant_attested' });
  }
  return { ok: true, payment: { status: 'merchant_confirmed', confirmedAt: now.toISOString() }, alreadyConfirmed: false };
}

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(CONTROL_RE, ' ').replace(BIDI_RE, '').replace(/\s+/g, ' ').trim();
}

/**
 * Display-name change (owner only: the route enforces it). Meta decides; the poll or the
 * phone_number_name_update webhook records the outcome.
 * @param {{workspaceId:string, userId?:string, newName:string}} args
 * @param {{Connection?:object, vault?:object, meta?:object, analytics?:object, now?:()=>number}} [deps]
 * @returns {Promise<{ok:true, displayName:{value:string, status:'waiting', editsRemaining:number}}>}
 */
async function changeDisplayName({ workspaceId, userId, newName } = {}, deps = {}) { // eslint-disable-line no-unused-vars
  const ws = idStr(workspaceId);
  const name = cleanName(newName);
  if (name.length < metaConfig.DISPLAY_NAME_MIN || name.length > metaConfig.DISPLAY_NAME_MAX) {
    throw new OnbError('VALIDATION_FAILED', { details: { fields: { newName: 'length' } } });
  }
  const t = nowMs(deps);
  const conn = await Conn(deps).findOne({ workspaceId: ws }).select('+tokenEncrypted').lean();
  const phoneId = get(conn, 'ids.phoneNumberId');
  if (!conn || !phoneId || !config.CONNECTED_LIKE.includes(conn.status)) {
    throw new OnbError(conn && (conn.needsReconnect || conn.status === 'reconnect_required') ? 'WHATSAPP_RECONNECT_REQUIRED' : 'WHATSAPP_NOT_CONNECTED');
  }
  if (conn.needsReconnect) throw new OnbError('WHATSAPP_RECONNECT_REQUIRED');
  // the PLATFORM's own WhatsApp account is never a merchant account: no display-name write to it, ever
  if (config.isPlatformAccount({ wabaId: get(conn, 'ids.wabaId'), phoneNumberId: phoneId })) throw new OnbError('WHATSAPP_NOT_CONNECTED');
  const edits = recentEdits(conn, t);
  if (edits.length >= metaConfig.DISPLAY_NAME_EDITS_PER_30D) {
    throw new OnbError('VALIDATION_FAILED', { details: { reason: 'DISPLAY_NAME_LIMIT', editsRemaining: 0 } });
  }
  const current = String(get(conn, 'display.verifiedName') || '').trim().toLowerCase();
  if (current && current === name.toLowerCase() && !get(conn, 'displayName.newName')) {
    throw new OnbError('VALIDATION_FAILED', { details: { reason: 'SAME_NAME' } });
  }
  if (!conn.tokenEncrypted) throw new OnbError('WHATSAPP_RECONNECT_REQUIRED');

  let token;
  try {
    token = getVault(deps).decrypt(conn.tokenEncrypted, { workspaceId: ws, purpose: 'token' });
  } catch (err) {
    throw new OnbError(err && err.code === 'ENCRYPTION_NOT_CONFIGURED' ? 'ENCRYPTION_NOT_CONFIGURED' : 'META_ERROR');
  }
  try {
    await getMeta(deps).setDisplayName(token, phoneId, name);
  } catch (err) {
    if (statusRefresh.kindOf(err, deps) === 'reconnect') {
      try { await statusRefresh.markNeedsReconnect(ws, Number(err && err.subcode) === 463 ? 'TOKEN_EXPIRED' : 'TOKEN_REVOKED', deps, { err, conn }); } catch (_) { /* best effort */ }
    }
    throw statusRefresh.toOnbError(err, deps);
  }
  const now = new Date(t);
  const history = edits.concat(t).map((x) => new Date(x));
  await Conn(deps).updateOne(
    { _id: conn._id },
    {
      $set: {
        'displayName.requested': name, 'displayName.newName': name, 'displayName.newNameStatusRaw': 'PENDING_REVIEW',
        'displayName.mapped': 'waiting', 'displayName.checkedAt': now, 'displayName.editsLast30d': history, nextCheckAt: now,
      },
      $unset: { 'displayName.decision': 1, 'displayName.rejectionReason': 1 },
    },
  );
  await track(deps, ws, { type: 'status_change', step: 'approvals', code: 'DISPLAY_NAME_REQUESTED', reason: 'name_requested' });
  return { ok: true, displayName: { value: name, status: 'waiting', editsRemaining: Math.max(0, metaConfig.DISPLAY_NAME_EDITS_PER_30D - history.length) } };
}

/**
 * Scheduler job (7): after a display-name approval, re-register the number with the stored PIN within 14 days.
 * Gives up after REREGISTER_MAX_ATTEMPTS or when Meta reports the register rate limit (133016).
 * @param {{now?:number|Date, limit?:number}} [opts]
 * @param {object} [deps]
 * @returns {Promise<{checked:number, registered:number, failed:number, expired:number}>}
 */
async function reRegisterDueNames(opts = {}, deps = {}) {
  const out = { checked: 0, registered: 0, failed: 0, expired: 0 };
  const d = opts.now !== undefined ? { ...deps, now: () => (opts.now instanceof Date ? opts.now.getTime() : Number(opts.now)) } : deps;
  const t = nowMs(d);
  const Connection = Conn(d);
  const rows = await Connection.find({
    'displayName.decision': 'APPROVED',
    'displayName.newName': { $exists: true, $nin: [null, ''] },
    status: { $in: config.CONNECTED_LIKE },
    needsReconnect: { $ne: true },
  }).select('+tokenEncrypted +pinEncrypted').limit(Math.max(1, Math.min(50, opts.limit || 20))).lean();
  for (const conn of rows || []) {
    out.checked += 1;
    const ws = idStr(conn.workspaceId);
    const stop = () => Connection.updateOne({ _id: conn._id }, { $unset: { 'displayName.newName': 1 } });
    const approvedAt = ms(get(conn, 'displayName.checkedAt'));
    if (approvedAt === null || t - approvedAt > REREGISTER_WINDOW_MS || (Number(get(conn, 'registration.attempts')) || 0) >= REREGISTER_MAX_ATTEMPTS) {
      await stop(); out.expired += 1; continue;
    }
    const phoneId = get(conn, 'ids.phoneNumberId');
    if (!phoneId || !conn.tokenEncrypted || !conn.pinEncrypted) { await stop(); out.expired += 1; continue; }
    // never a register call for the PLATFORM's own number
    if (config.isPlatformAccount({ wabaId: get(conn, 'ids.wabaId'), phoneNumberId: phoneId })) { await stop(); out.expired += 1; continue; }
    let token; let pin;
    try {
      const vault = getVault(d);
      token = vault.decrypt(conn.tokenEncrypted, { workspaceId: ws, purpose: 'token' });
      pin = vault.decrypt(conn.pinEncrypted, { workspaceId: ws, purpose: 'pin' });
    } catch (_) { out.failed += 1; continue; }
    try {
      await getMeta(d).registerPhone(token, phoneId, pin);
      await Connection.updateOne({ _id: conn._id }, {
        $set: { 'registration.registeredAt': new Date(t), 'registration.attempts': (Number(get(conn, 'registration.attempts')) || 0) + 1 },
        $unset: { 'displayName.newName': 1, 'registration.lastErrorCode': 1 },
      });
      await track(d, ws, { type: 'status_change', step: 'approvals', code: 'DISPLAY_NAME_REREGISTERED', reason: 'reregistered' });
      out.registered += 1;
    } catch (err) {
      out.failed += 1;
      const kind = statusRefresh.kindOf(err, d);
      const attempts = kind === 'register_rate' || Number(err && err.code) === 133016 ? REREGISTER_MAX_ATTEMPTS : (Number(get(conn, 'registration.attempts')) || 0) + 1;
      try {
        await Connection.updateOne({ _id: conn._id }, { $set: { 'registration.attempts': attempts } });
        if (kind === 'reconnect') await statusRefresh.markNeedsReconnect(ws, 'TOKEN_REVOKED', d, { err, conn });
      } catch (_) { /* best effort */ }
    }
  }
  return out;
}

module.exports = {
  buildApprovals, confirmPayment, changeDisplayName,
  // additions (documented in B1-d.md)
  reRegisterDueNames, touchProgress, cleanName, REREGISTER_WINDOW_MS, REREGISTER_MAX_ATTEMPTS,
};
