'use strict';
// "Which customer (workspace) does this WhatsApp webhook EVENT belong to?" - decided per event, never per request.
//
// Before: server.js gave every inbound event to the OLDEST workspace. With several customers (tenants) on one app that
// silently drops a second customer's button taps, delivery statuses and STOP/START, and would create a second customer's
// shoppers as Customers of the first. This module decides per event:
//
//   R1  value.metadata.phone_number_id equals some Workspace.whatsapp.phoneId (a customer's OWN number)
//       -> that workspace, for every event type. (60 s cache.)
//   R2  the shared platform number (or anything R1 did not claim): attribute deterministically where possible
//         statuses            status.id -> CampaignMessage by wamid (globally unique), then WhatsAppMessage
//         replies / taps      message.context.id -> the same wamid lookup
//         payload ids         promo_ / optout_ / promo:<id>: / promotest: (Promotion), flowbrowse_ (Flow), flownoshow_/rebook_/
//                             carouselsvc_ (Service), msgnode_ (MessageNode), consent_yes_/consent_no_ (Customer), cart_/variant_
//                             (Product), slot_/reslot_/paylater_ (TimeSlot): that document's workspaceId
//         typed text / rest   customer by phone: exactly one workspace has this phone -> it; several -> the workspace of the
//                             most recent outbound CampaignMessage to the phone within 72 h, else the oldest of them; none -> oldest
//   R3  nothing usable -> the OLDEST workspace, exactly today's behaviour, with a logged warning.
//       A lookup that keeps FAILING (a database error, after a few tries) is not "nothing usable": that answers rule R3_error and the
//       caller must not file the message under the oldest workspace (it may well belong to another customer) - see server.js.
//
// The result of every path is { workspaceId, rule }; resolveEventWorkspace NEVER throws. The oldest workspace stays the answer for
// everything that cannot be attributed, so a deployment with one workspace behaves exactly as before.
const R1_TTL_MS = 60 * 1000;
const R1_NEGATIVE_TTL_MS = 15 * 1000; // a phone id that matched nothing is re-checked sooner (a number may just have been saved)
const R1_CACHE_MAX = 500;
const AFFINITY_WINDOW_MS = 72 * 60 * 60 * 1000;
const PHONE_ROWS_MAX = 50;
const CC_TTL_MS = 60 * 1000;
const WARN_EVERY_MS = 10 * 60 * 1000;
const DEFAULT_COUNTRY_CODE = '966';
const PLATFORM_PHONE_ID_FALLBACK = '1032683093271618'; // same literal utils/whatsapp.js falls back to

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

const MODEL_FILES = {
  Workspace: '../models/Workspace',
  CampaignMessage: '../models/CampaignMessage',
  WhatsAppMessage: '../models/WhatsAppMessage',
  Customer: '../models/Customer',
  Settings: '../models/Settings',
  Promotion: '../models/Promotion',
  Flow: '../models/Flow',
  MessageNode: '../models/MessageNode',
  Product: '../models/Product',
  Service: '../models/Service',
  TimeSlot: '../models/TimeSlot',
};
const realModel = (name) => require(MODEL_FILES[name]);

// Payload prefixes that embed the id of ONE document, in matching order (longer / more specific prefixes first).
// `alt` is tried when the first model has no such document (optout_<id> is also used with a MessageNode id by flowBridge).
const PAYLOAD_RULES = [
  { prefix: 'promotest:', model: 'Promotion', kind: 'promotion' },
  { prefix: 'promo:', model: 'Promotion', kind: 'promotion' },
  { prefix: 'promo_', model: 'Promotion', kind: 'promotion' },
  { prefix: 'optout_', model: 'Promotion', alt: 'MessageNode', kind: 'promotion' },
  { prefix: 'flowbrowse_', model: 'Flow', kind: 'flow' },
  { prefix: 'flownoshow_', model: 'Service', kind: 'service' },
  { prefix: 'rebook_', model: 'Service', kind: 'service' },
  { prefix: 'carouselsvc_', model: 'Service', kind: 'service' },
  { prefix: 'msgnode_', model: 'MessageNode', kind: 'node' },
  { prefix: 'consent_yes_', model: 'Customer', kind: 'customer' },
  { prefix: 'consent_no_', model: 'Customer', kind: 'customer' },
  { prefix: 'cart_', model: 'Product', kind: 'product' },
  { prefix: 'variant_', model: 'Product', kind: 'product' },
  { prefix: 'reslot_', model: 'TimeSlot', kind: 'slot' },
  { prefix: 'slot_', model: 'TimeSlot', kind: 'slot' },
  { prefix: 'paylater_', model: 'TimeSlot', kind: 'slot' },
];

// ---- small helpers ----
const phoneIdCache = new Map(); // phone number id -> { workspaceId (ObjectId|null), expires }
const countryCodeCache = { codes: null, expires: 0 };
const warnedAt = new Map();

function _resetForTests() {
  phoneIdCache.clear();
  countryCodeCache.codes = null; countryCodeCache.expires = 0;
  warnedAt.clear();
}

/** Forget one cached phone number id (or all). Call after a workspace's WhatsApp number changed. */
function invalidatePhoneId(phoneId) {
  if (phoneId === undefined || phoneId === null) phoneIdCache.clear();
  else phoneIdCache.delete(String(phoneId));
}

const nowOf = (deps) => (deps && typeof deps.now === 'function' ? deps.now() : Date.now());
const sleepOf = (deps, ms) => (deps && typeof deps.sleep === 'function' ? deps.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms)));
const modelOf = (deps, name) => ((deps && deps.models && deps.models[name]) || realModel(name));
const logOf = (deps) => (deps && deps.log) || ((level, ...a) => (level === 'warn' ? console.warn : console.log)(...a));
const idKey = (v) => (v === undefined || v === null ? '' : String(v));
const isId = (s) => typeof s === 'string' && OBJECT_ID_RE.test(s);
const platformPhoneId = () => String(process.env.WA_PHONE_ID || PLATFORM_PHONE_ID_FALLBACK);
const onlyDigits = (s) => String(s === undefined || s === null ? '' : s).replace(/\D/g, '');

function warnThrottled(deps, key, ...args) {
  const t = nowOf(deps);
  const prev = warnedAt.get(key);
  if (prev !== undefined && t - prev < WARN_EVERY_MS) return;
  if (warnedAt.size >= 200) warnedAt.clear();
  warnedAt.set(key, t);
  logOf(deps)('warn', ...args);
}

/** The oldest Workspace (today's behaviour for everything that cannot be attributed). -> ObjectId or undefined. Never throws. */
async function oldestWorkspaceId(deps) {
  try {
    const ws = await modelOf(deps, 'Workspace').findOne().sort({ createdAt: 1 });
    return ws ? ws._id : undefined;
  } catch (err) {
    return undefined;
  }
}

// ---- payload / phone helpers ----

/** The button payload / reply id of an inbound message ('' when it has none). */
function payloadOf(message) {
  if (!message) return '';
  const p = (message.button && message.button.payload)
    || (message.interactive && message.interactive.button_reply && message.interactive.button_reply.id)
    || (message.interactive && message.interactive.list_reply && message.interactive.list_reply.id)
    || '';
  return typeof p === 'string' ? p : '';
}

/** -> { rule, id } for a payload that embeds a document id, else null. Pure. */
function parsePayload(payload) {
  if (typeof payload !== 'string' || !payload) return null;
  for (const rule of PAYLOAD_RULES) {
    if (payload.startsWith(rule.prefix)) {
      const m = /^([0-9a-fA-F]{24})/.exec(payload.slice(rule.prefix.length));
      return m ? { rule, id: m[1] } : null;
    }
  }
  return null;
}

async function countryCodes(deps) {
  const t = nowOf(deps);
  if (countryCodeCache.codes && countryCodeCache.expires > t) return countryCodeCache.codes;
  const codes = new Set([DEFAULT_COUNTRY_CODE]);
  try {
    const rows = await modelOf(deps, 'Settings').distinct('defaultCountryCode');
    for (const r of rows || []) { const d = onlyDigits(r); if (d) codes.add(d); }
  } catch (_) { /* the default code alone is used */ }
  countryCodeCache.codes = [...codes];
  countryCodeCache.expires = t + CC_TTL_MS;
  return countryCodeCache.codes;
}

/** The exact stored spellings a sender's number can have (digits, +digits, 00digits and the national forms 0xxxxxxxxx / xxxxxxxxx). */
async function phoneVariants(deps, from) {
  const digits = onlyDigits(from);
  if (!digits) return [];
  const out = new Set([String(from), digits, `+${digits}`, `00${digits}`]);
  for (const cc of await countryCodes(deps)) {
    if (digits.startsWith(cc) && digits.length > cc.length) {
      const national = digits.slice(cc.length);
      out.add(national); out.add(`0${national}`);
    }
  }
  return [...out];
}

// ---- lookups ----

async function workspaceOfDoc(deps, modelName, id) {
  const row = await modelOf(deps, modelName).findById(id).select('workspaceId').lean();
  return row && row.workspaceId ? row.workspaceId : null;
}

async function workspaceOfCustomerId(deps, customerId) {
  if (!customerId) return null;
  try {
    const row = await modelOf(deps, 'Customer').findById(customerId).select('workspaceId').lean();
    return row && row.workspaceId ? row.workspaceId : null;
  } catch (_) { return null; }
}

/** wamid -> workspaceId through CampaignMessage (then its customer for a legacy row without a workspace) then WhatsAppMessage. */
async function workspaceOfWamid(deps, wamid) {
  if (typeof wamid !== 'string' || !wamid) return null;
  const cm = await modelOf(deps, 'CampaignMessage').findOne({ wamid }).select('workspaceId customer').lean();
  if (cm) {
    if (cm.workspaceId) return cm.workspaceId;
    const viaCustomer = await workspaceOfCustomerId(deps, cm.customer);
    if (viaCustomer) return viaCustomer;
  }
  const wm = await modelOf(deps, 'WhatsAppMessage').findOne({ wamid }).select('workspaceId customer').lean();
  if (wm) {
    if (wm.workspaceId) return wm.workspaceId;
    return workspaceOfCustomerId(deps, wm.customer);
  }
  return null;
}

/** R1: the workspace that owns this phone number id, or null. Cached (positive 60 s, negative 15 s). */
async function workspaceOfPhoneId(deps, phoneId) {
  if (typeof phoneId !== 'string' || !phoneId.trim()) return null;
  const key = phoneId.trim();
  const t = nowOf(deps);
  const hit = phoneIdCache.get(key);
  if (hit && hit.expires > t) return hit.workspaceId;
  const ws = await modelOf(deps, 'Workspace').findOne({ 'whatsapp.phoneId': key }).select('_id').lean();
  const workspaceId = ws ? ws._id : null;
  if (phoneIdCache.size >= R1_CACHE_MAX) phoneIdCache.clear();
  phoneIdCache.set(key, { workspaceId, expires: t + (workspaceId ? R1_TTL_MS : R1_NEGATIVE_TTL_MS) });
  return workspaceId;
}

/** Typed text and everything else: customer by phone (see the header). -> { workspaceId, rule } or null (no customer anywhere). */
async function workspaceOfPhone(deps, from) {
  const variants = await phoneVariants(deps, from);
  if (!variants.length) return null;
  const rows = await modelOf(deps, 'Customer')
    .find({ phone: { $in: variants }, deletedAt: { $exists: false } })
    .select('workspaceId').limit(PHONE_ROWS_MAX).lean();
  const byKey = new Map();
  for (const r of rows || []) if (r && r.workspaceId) byKey.set(idKey(r.workspaceId), r.workspaceId);
  if (byKey.size === 0) return null;
  if (byKey.size === 1) return { workspaceId: [...byKey.values()][0], rule: 'R2_customer_single' };

  const ids = [...byKey.values()];
  const since = new Date(nowOf(deps) - AFFINITY_WINDOW_MS);
  let recent = null;
  try {
    recent = await modelOf(deps, 'CampaignMessage')
      .findOne({ phone: { $in: variants }, workspaceId: { $in: ids }, status: { $ne: 'failed' }, createdAt: { $gte: since } })
      .sort({ createdAt: -1 }).select('workspaceId').lean();
  } catch (err) {
    // This tie-break needs an index on CampaignMessage (phone, createdAt) that a database may refuse to build. A person who is a customer of
    // two businesses must not become unattributable because of it: fall through to the documented next rule (the oldest of them).
    warnThrottled(deps, 'recent-outbound-lookup', `[inbound] the "most recent message sent to this phone" lookup failed (${err && err.message}); the oldest of the customers that have it is used`);
  }
  if (recent && recent.workspaceId) return { workspaceId: recent.workspaceId, rule: 'R2_customer_recent_outbound' };

  const oldestOfThem = await modelOf(deps, 'Workspace').find({ _id: { $in: ids } }).sort({ createdAt: 1 }).limit(1).select('_id').lean();
  if (oldestOfThem && oldestOfThem[0]) return { workspaceId: oldestOfThem[0]._id, rule: 'R2_customer_oldest_of' };
  return { workspaceId: ids[0], rule: 'R2_customer_oldest_of' };
}

/**
 * Does this workspace already have a (not erased) Customer with this phone, in any of its usual spellings? Used to avoid creating
 * a Customer in a customer's workspace out of a stranger's phone. Fails OPEN (true = today's behaviour) on an error.
 */
async function customerKnownInWorkspace(workspaceId, from, deps) {
  try {
    const variants = await phoneVariants(deps, from);
    if (!variants.length || !workspaceId) return true;
    const row = await modelOf(deps, 'Customer').findOne({ workspaceId, phone: { $in: variants }, deletedAt: { $exists: false } }).select('_id').lean();
    return !!row;
  } catch (_) {
    return true;
  }
}

async function fallbackOldest(deps, args, rule) {
  const oldest = args && args.oldestWorkspaceId !== undefined ? await args.oldestWorkspaceId : await oldestWorkspaceId(deps);
  return { workspaceId: oldest, rule };
}

// ---- the resolver ----

/**
 * @param {{ value?: object, status?: object, message?: object, oldestWorkspaceId?: any }} args
 *   value = the change's value (metadata.phone_number_id, contacts); exactly one of status / message normally.
 *   oldestWorkspaceId (optional) = the oldest workspace id (or a promise of it) when the caller already has it.
 * @param {object} [deps] test seam: { models, now, log }
 * @returns {Promise<{ workspaceId: any, rule: string }>} never rejects
 */
async function resolveEventWorkspace(args, deps) {
  const a = args || {};
  try {
    const result = await withRetries(deps, () => resolveInner(a, deps));
    if (result && result.workspaceId !== undefined && result.workspaceId !== null) return result;
    return fallbackOldest(deps, a, 'R3_oldest');
  } catch (err) {
    warnThrottled(deps, 'error', `[inbound] workspace resolution kept failing (${err && err.message}): the message is NOT attributed to any customer`);
    try { return await fallbackOldest(deps, a, 'R3_error'); } catch (_) { return { workspaceId: undefined, rule: 'R3_error' }; }
  }
}

// A database lookup that fails once (throttling, a dropped connection) usually works a moment later: try again before giving up.
// Delays are short because the webhook has already been answered; the whole thing is bounded to well under a second.
const RETRY_DELAYS_MS = [150, 400];
async function withRetries(deps, fn) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (attempt < RETRY_DELAYS_MS.length) await sleepOf(deps, RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

async function resolveInner(a, deps) {
  const { value, status, message } = a;
  const phoneId = value && value.metadata && value.metadata.phone_number_id;

  // R1: a customer's own number.
  if (typeof phoneId === 'string' && phoneId && phoneId !== platformPhoneId()) {
    const own = await workspaceOfPhoneId(deps, phoneId);
    if (own) return { workspaceId: own, rule: 'R1_phone_id' };
    warnThrottled(deps, `phone:${phoneId}`, '[inbound] metadata.phone_number_id matches no workspace and is not the platform number - attributing the event by its content (oldest workspace when it carries none)');
  }

  // R2: the shared number, attributed per event.
  if (status) {
    const ws = await workspaceOfWamid(deps, status.id);
    if (ws) return { workspaceId: ws, rule: 'R2_status_wamid' };
    return fallbackOldest(deps, a, 'R2_oldest_unknown_status');
  }

  if (message) {
    const ctxId = message.context && message.context.id;
    if (ctxId) {
      const ws = await workspaceOfWamid(deps, ctxId);
      if (ws) return { workspaceId: ws, rule: 'R2_context_wamid' };
    }

    const parsed = parsePayload(payloadOf(message));
    if (parsed && isId(parsed.id)) {
      let ws = await workspaceOfDoc(deps, parsed.rule.model, parsed.id);
      if (!ws && parsed.rule.alt) ws = await workspaceOfDoc(deps, parsed.rule.alt, parsed.id);
      if (ws) return { workspaceId: ws, rule: `R2_payload_${parsed.rule.kind}` };
    }

    if (message.from) {
      const byPhone = await workspaceOfPhone(deps, message.from);
      if (byPhone) return byPhone;
      return fallbackOldest(deps, a, 'R2_oldest_no_customer');
    }
  }

  return fallbackOldest(deps, a, 'R3_oldest');
}

/**
 * Group a change's statuses by the workspace each belongs to, with the same rules as resolveEventWorkspace but batched:
 * R1 for the whole change, else one $in query on CampaignMessage and one on WhatsAppMessage for the rest. Order of first
 * appearance is kept; a status nothing claims joins the oldest workspace. Never rejects.
 * @returns {Promise<Array<{ workspaceId: any, rule: string, statuses: object[] }>>}
 */
async function resolveStatusGroups({ value, statuses, oldestWorkspaceId: oldestArg } = {}, deps) {
  const list = Array.isArray(statuses) ? statuses.filter(Boolean) : [];
  if (!list.length) return [];
  const args = { value, oldestWorkspaceId: oldestArg };
  try {
    return await withRetries(deps, () => groupStatuses({ value, list, args }, deps));
  } catch (err) {
    warnThrottled(deps, 'error', `[inbound] status attribution kept failing (${err && err.message}): these delivery updates are NOT attributed to any customer`);
    const oldest = (await fallbackOldest(deps, args, 'R3_error').catch(() => ({ workspaceId: undefined }))).workspaceId;
    return [{ workspaceId: oldest, rule: 'R3_error', statuses: list }];
  }
}

async function groupStatuses({ value, list, args }, deps) {
  const groups = new Map(); // workspace key -> { workspaceId, rule, statuses }
  const add = (workspaceId, rule, status) => {
    const k = idKey(workspaceId);
    if (!groups.has(k)) groups.set(k, { workspaceId, rule, statuses: [] });
    groups.get(k).statuses.push(status);
  };
  const phoneId = value && value.metadata && value.metadata.phone_number_id;
  if (typeof phoneId === 'string' && phoneId && phoneId !== platformPhoneId()) {
    const own = await workspaceOfPhoneId(deps, phoneId);
    if (own) { for (const s of list) add(own, 'R1_phone_id', s); return [...groups.values()]; }
    warnThrottled(deps, `phone:${phoneId}`, '[inbound] metadata.phone_number_id matches no workspace and is not the platform number - attributing the event by its content (oldest workspace when it carries none)');
  }

  const wanted = [...new Set(list.map((s) => s.id).filter((id) => typeof id === 'string' && id))];
  const owner = new Map(); // wamid -> workspaceId
  if (wanted.length) {
    const cms = await modelOf(deps, 'CampaignMessage').find({ wamid: { $in: wanted } }).select('wamid workspaceId customer').lean();
    const needCustomer = [];
    for (const cm of cms || []) {
      if (cm.workspaceId) owner.set(cm.wamid, cm.workspaceId);
      else needCustomer.push(cm);
    }
    for (const cm of needCustomer) { const ws = await workspaceOfCustomerId(deps, cm.customer); if (ws) owner.set(cm.wamid, ws); }
    const rest = wanted.filter((id) => !owner.has(id));
    if (rest.length) {
      const wms = await modelOf(deps, 'WhatsAppMessage').find({ wamid: { $in: rest } }).select('wamid workspaceId customer').lean();
      for (const wm of wms || []) {
        const ws = wm.workspaceId || await workspaceOfCustomerId(deps, wm.customer);
        if (ws) owner.set(wm.wamid, ws);
      }
    }
  }
  let oldest; let oldestLoaded = false;
  for (const s of list) {
    const ws = owner.get(s.id);
    if (ws) { add(ws, 'R2_status_wamid', s); continue; }
    if (!oldestLoaded) { oldest = (await fallbackOldest(deps, args, 'R2_oldest_unknown_status')).workspaceId; oldestLoaded = true; }
    add(oldest, 'R2_oldest_unknown_status', s);
  }
  return [...groups.values()];
}

module.exports = {
  resolveEventWorkspace, resolveStatusGroups, oldestWorkspaceId, invalidatePhoneId, withRetries, platformPhoneId,
  // exported for tests / the webhook
  customerKnownInWorkspace, payloadOf, parsePayload, phoneVariants, workspaceOfPhoneId, _resetForTests,
  AFFINITY_WINDOW_MS, R1_TTL_MS,
};
