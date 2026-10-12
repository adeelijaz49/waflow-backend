'use strict';
// Campaign audience resolution (spec §3.2/§3.4/§4): turns an AudienceSpec
// ({kind: all_eligible | customer_ids | segment}) into the list of customers a
// campaign would address, each tagged with WHY it would be skipped, if at all.
// This module is the single place that decides "can this customer receive this
// campaign" — the planner uses it for the preview, the sender re-applies the
// same rules (classifyCustomer) on a FRESH customer read right before every send.
//
// Rules, in precedence order (a customer is counted under the first that matches):
//   demo          isDemo — the owner's demo data NEVER reaches Meta;
//   opted_out     optedOut — never receives anything from a campaign;
//   opted_out_phone  (counted as opted out) ANOTHER customer record of the same workspace
//                 with the same normalised phone is opted out. Customer.phone is not
//                 unique and the existing opt-out paths (server.js STOP / optout_ and the
//                 Arabic hook) update only the FIRST customer they find for the sender's
//                 number, so a second record of the same person would otherwise keep
//                 receiving. Resolved with ONE bulk query per audience (the phones of the
//                 workspace's opted-out records, normalised in memory, so every stored
//                 format of a number matches: 966…, +966…, 00966…, spaced) — never one
//                 query per recipient. Deliberately simple: only an OPTED-OUT sibling
//                 excludes; a sibling that merely lacks consent does not;
//   no_consent    MARKETING only: shared/consent.js#canSendMarketing is false
//                 (UTILITY templates do not need marketing consent, spec §3.4:
//                 "utility messages need no marketing consent"). `category` is the
//                 EFFECTIVE one (metaCategory || category, see campaignPlanner.js):
//                 Meta re-classified every UTILITY template this app submitted to
//                 MARKETING, and the UTILITY floor (category.js) makes every
//                 non-transactional use case MARKETING whatever was requested, so
//                 UTILITY here means a transactional message only (payment / booking /
//                 order). This module trusts the category it is handed.
//                 EXCEPTION — the consent request itself (use case
//                 welcome_optin) is the ask, so it goes to customers who have NOT
//                 consented yet, never to opted-out ones, and at most once per 7
//                 days per customer: a customer who already consented is skipped as
//                 already_consented, one asked within 7 days as asked_recently;
//   invalid_phone not a plausible international number (8-15 digits, no leading 0).
// Plus a de-duplication pass: Customer.phone is not unique in this codebase, so
// two customers sharing a number would otherwise be messaged twice; the first
// (by _id) keeps the send, later ones are skipped as duplicate_phone.
//
// `all_eligible` is "everyone who can receive it": the consent/opt-out rule runs
// IN THE DATABASE (so a 20 000-customer workspace never loads its non-consented
// customers) and the customers outside the audience are only counted. For
// `customer_ids` and `segment` everything matched is loaded and classified, so
// the campaign report can account for every selected customer.
//
// "Inactive for N days" stays consistent with the existing definition
// (shared/operations.js#listInactiveCustomers, also behind Smart Insights): a
// customer with at least one non-cancelled order whose LATEST such order is
// older than N days. Customers who never ordered are not "inactive".
//
// Everything here is workspace-scoped; client-supplied ids go through
// assertObjectId (NoSQL-operator injection) and ids of other tenants simply
// match nothing. Models and the consent module are injected (realDeps) so the
// unit tests never touch a database or the WhatsApp module.
const mongoose = require('mongoose');
const { assertObjectId } = require('./scope');
const { toWesternDigits, stripInvisibles } = require('./arabicText');

const MAX_RECIPIENTS = 5000;   // customers one campaign may send to (INVALID_INPUT beyond it)
const MAX_CUSTOMER_IDS = 2000; // customers chosen by hand: the server's JSON body limit is 100 kB (an id is ~28 bytes)
const CONSENT_ASK_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 20000;  // customers a segment may match before being refused as unmanageably broad
const MAX_OPTED_OUT_RECORDS = MAX_CANDIDATES; // opted-out records read for the same-phone rule (the same scale limit)
const ID_CHUNK = 1000;         // $in lists are queried in slices of this many ids
const PROJECTION = '_id firstname lastname phone loyaltyPoints marketingConsent marketingConsentAskedAt optedOut isDemo';

const AUDIENCE_KINDS = Object.freeze(['all_eligible', 'customer_ids', 'segment']);
const SEGMENTS = Object.freeze([
  Object.freeze({ key: 'language', params: Object.freeze(['language']) }),
  Object.freeze({ key: 'inactive_days', params: Object.freeze(['days']) }),
  Object.freeze({ key: 'has_points', params: Object.freeze(['minPoints']) }),
  Object.freeze({ key: 'awaiting_consent', params: Object.freeze([]) }),
]);
const SEGMENT_KEYS = SEGMENTS.map((s) => s.key);
const SEGMENT_LANGUAGES = Object.freeze(['en', 'ar', 'unknown']);
const DAY_MS = 24 * 60 * 60 * 1000;

// skip key -> LocalizedSend status (+ the machine reason kept on the row)
const SKIP_STATUS = Object.freeze({
  demo: { status: 'skipped_demo' },
  opted_out: { status: 'skipped_opted_out' },
  opted_out_phone: { status: 'skipped_opted_out', errorCode: 'opted_out_same_phone', error: 'Another customer record with the same phone number has opted out' },
  no_consent: { status: 'skipped_no_consent' },
  already_consented: { status: 'skipped_error', errorCode: 'already_consented', error: 'The customer has already given marketing consent' },
  asked_recently: { status: 'skipped_error', errorCode: 'asked_recently', error: 'The customer was asked for consent within the last 7 days' },
  invalid_phone: { status: 'skipped_error', errorCode: 'invalid_phone', error: 'The phone number is not a valid international number' },
  duplicate_phone: { status: 'skipped_error', errorCode: 'duplicate_phone', error: 'Another recipient of this campaign has the same phone number' },
});

// Errors carry { status, code } exactly like the rest of the feature; scope.js#handler
// serialises them as { error, code }. `details` is for callers/tests, never sent.
function httpError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function asObjectId(value, label) {
  try {
    return assertObjectId(value, label);
  } catch (err) {
    throw httpError(400, 'INVALID_ID', err.message);
  }
}

function realDeps() {
  return {
    Customer: require('../../models/Customer'),
    CustomerLanguage: require('../../models/CustomerLanguage'),
    Order: require('../../models/Order'),
    consent: require('../consent'),
    now: () => Date.now(),
  };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function byId(a, b) {
  const x = String(a._id);
  const y = String(b._id);
  if (x < y) return -1;
  return x > y ? 1 : 0;
}

// Whole numbers only; accepts a number or a digit string (Arabic-Indic digits too:
// a merchant typing "٣٠" days must not be rejected).
function parseWholeNumber(value, label, min, max) {
  let n = value;
  if (typeof value === 'string') n = /^\s*\d+\s*$/.test(toWesternDigits(value)) ? Number(toWesternDigits(value).trim()) : NaN;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw httpError(400, 'INVALID_INPUT', `${label} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Validates + normalises an AudienceSpec from a request body. The result only
// contains allow-listed keys with checked values (safe to store and to query).
function normalizeAudienceSpec(raw) {
  if (!isPlainObject(raw)) throw httpError(400, 'INVALID_INPUT', 'audience is required');
  const kind = raw.kind;
  if (typeof kind !== 'string' || !AUDIENCE_KINDS.includes(kind)) {
    throw httpError(400, 'INVALID_INPUT', `audience.kind must be one of: ${AUDIENCE_KINDS.join(', ')}`);
  }
  if (kind === 'all_eligible') return { kind };

  if (kind === 'customer_ids') {
    if (!Array.isArray(raw.customerIds)) throw httpError(400, 'INVALID_INPUT', 'audience.customerIds must be an array');
    if (!raw.customerIds.length) throw httpError(400, 'INVALID_INPUT', 'Choose at least one customer');
    if (raw.customerIds.length > MAX_CUSTOMER_IDS) {
      throw httpError(400, 'INVALID_INPUT', `At most ${MAX_CUSTOMER_IDS} customers can be chosen by hand; use a segment for a larger audience`, { max: MAX_CUSTOMER_IDS });
    }
    const seen = new Set();
    const customerIds = [];
    raw.customerIds.forEach((value, i) => {
      const id = asObjectId(value, `customerIds[${i}]`).toLowerCase();
      if (!seen.has(id)) { seen.add(id); customerIds.push(id); }
    });
    return { kind, customerIds };
  }

  const segmentKey = raw.segmentKey;
  if (typeof segmentKey !== 'string' || !SEGMENT_KEYS.includes(segmentKey)) {
    throw httpError(400, 'INVALID_INPUT', `audience.segmentKey must be one of: ${SEGMENT_KEYS.join(', ')}`);
  }
  const params = isPlainObject(raw.segmentParams) ? raw.segmentParams : {};
  const segmentParams = {};
  if (segmentKey === 'language') {
    if (typeof params.language !== 'string' || !SEGMENT_LANGUAGES.includes(params.language)) {
      throw httpError(400, 'INVALID_INPUT', `segmentParams.language must be one of: ${SEGMENT_LANGUAGES.join(', ')}`);
    }
    segmentParams.language = params.language;
  } else if (segmentKey === 'inactive_days') {
    segmentParams.days = parseWholeNumber(params.days, 'segmentParams.days', 1, 3650);
  } else if (segmentKey === 'has_points') {
    segmentParams.minPoints = parseWholeNumber(params.minPoints, 'segmentParams.minPoints', 1, 100000000);
  }
  return { kind, segmentKey, segmentParams };
}

// A deliverable WhatsApp recipient: international digits, 8-15 long, no leading
// zero (a number written in local form such as 05xxxxxxxx cannot be delivered and
// we never guess a country code). Returns the digits to send to, or null.
function normalizeRecipientPhone(raw) {
  if (raw === undefined || raw === null) return null;
  let s = stripInvisibles(toWesternDigits(String(raw))).replace(/[\s().-]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  return /^[1-9]\d{7,14}$/.test(s) ? s : null;
}

function askedRecently(customer, nowMs) {
  const asked = customer.marketingConsentAskedAt ? new Date(customer.marketingConsentAskedAt).getTime() : NaN;
  return Number.isFinite(asked) && nowMs - asked < CONSENT_ASK_COOLDOWN_MS;
}

// null = eligible, otherwise the skip key (see the precedence list above).
// options.consentRequest: the template IS the consent request (see the header);
// options.nowMs: the clock for the 7-day rule;
// options.optedOutPhones: Set of normalised phones that belong to an opted-out record of the
// workspace (loadOptedOutPhones) — a customer whose number is in it is skipped as opted_out_phone.
function classifyCustomer(customer, category, consent, options = {}) {
  if (customer.isDemo === true) return 'demo';
  if (customer.optedOut === true) return 'opted_out';
  if (options.optedOutPhones && options.optedOutPhones.has(normalizeRecipientPhone(customer.phone))) return 'opted_out_phone';
  if (options.consentRequest) {
    if (customer.marketingConsent === true) return 'already_consented';
    if (askedRecently(customer, options.nowMs === undefined ? Date.now() : options.nowMs)) return 'asked_recently';
  } else if (category !== 'UTILITY' && !consent.canSendMarketing(customer)) {
    return 'no_consent';
  }
  if (!normalizeRecipientPhone(customer.phone)) return 'invalid_phone';
  return null;
}

async function findByIds(Model, filter, ids, projection) {
  const out = [];
  for (const slice of chunk(ids, ID_CHUNK)) {
    const rows = await Model.find({ ...filter, _id: { $in: slice } }).select(projection).lean();
    out.push(...rows);
  }
  return out;
}

// The same-phone opt-out rule (see the header): the normalised phones of EVERY opted-out
// customer record of the workspace, in ONE query (a bulk read by `optedOut`, not a lookup per
// recipient). Normalised in memory with the same function the recipients go through, so a
// record stored as "+966 50 123 4567" matches one stored as "966501234567". Opted-out records
// are a small slice of a workspace; beyond MAX_OPTED_OUT_RECORDS the check fails CLOSED
// (a clear error, nothing is planned or sent) rather than silently skipping part of the list.
async function loadOptedOutPhones(deps, workspaceId) {
  const rows = await deps.Customer.find({ workspaceId, optedOut: true }).select('phone').limit(MAX_OPTED_OUT_RECORDS + 1).lean();
  if (rows.length > MAX_OPTED_OUT_RECORDS) {
    throw httpError(400, 'INVALID_INPUT',
      `This workspace has more than ${MAX_OPTED_OUT_RECORDS} opted-out customers, which is too many to check against.`, { max: MAX_OPTED_OUT_RECORDS });
  }
  const phones = new Set();
  for (const row of rows) {
    const digits = normalizeRecipientPhone(row.phone);
    if (digits) phones.add(digits);
  }
  return phones;
}

async function languageMap(deps, workspaceId, customers) {
  const map = new Map();
  for (const slice of chunk(customers.map((c) => c._id), ID_CHUNK)) {
    const rows = await deps.CustomerLanguage.find({ workspaceId, customerId: { $in: slice } }).select('customerId language').lean();
    for (const row of rows) map.set(String(row.customerId), row.language);
  }
  return map;
}

function tooBroad(count) {
  return httpError(400, 'INVALID_INPUT',
    `This audience matches more than ${count} customers. Narrow it down (use a segment or choose customers).`, { max: count });
}

async function staleCustomerIds(deps, workspaceId, days) {
  const cutoff = new Date(deps.now() - days * DAY_MS);
  const rows = await deps.Order.aggregate([
    { $match: { workspaceId: new mongoose.Types.ObjectId(String(workspaceId)), status: { $ne: 'cancelled' } } },
    { $group: { _id: '$customer', lastOrderAt: { $max: '$createdAt' } } },
    { $match: { lastOrderAt: { $lt: cutoff } } },
    { $limit: MAX_CANDIDATES + 1 },
  ]);
  if (rows.length > MAX_CANDIDATES) throw tooBroad(MAX_CANDIDATES);
  return rows.map((r) => r._id).filter(Boolean);
}

// -> { candidates: [customer docs], notFound, outside: { optedOut, noConsent } }
async function loadCandidates(deps, { workspaceId, spec, category, consentRequest }) {
  const base = { workspaceId, deletedAt: { $exists: false } };
  const { Customer } = deps;
  const outside = { optedOut: 0, noConsent: 0, alreadyConsented: 0, askedRecently: 0 };

  if (spec.kind === 'all_eligible') {
    const askCutoff = new Date(deps.now() - CONSENT_ASK_COOLDOWN_MS);
    let eligibility;
    if (consentRequest) {
      eligibility = {
        optedOut: { $ne: true },
        marketingConsent: { $ne: true },
        $or: [{ marketingConsentAskedAt: { $exists: false } }, { marketingConsentAskedAt: null }, { marketingConsentAskedAt: { $lt: askCutoff } }],
      };
    } else {
      eligibility = category === 'UTILITY' ? { optedOut: { $ne: true } } : { ...deps.consent.MARKETING_ELIGIBLE_QUERY };
    }
    const eligible = await Customer.find({ ...base, isDemo: { $ne: true }, ...eligibility })
      .select(PROJECTION).sort({ _id: 1 }).limit(MAX_RECIPIENTS + 1).lean();
    if (eligible.length > MAX_RECIPIENTS) throw tooBroad(MAX_RECIPIENTS);
    const demo = await Customer.find({ ...base, isDemo: true }).select(PROJECTION).sort({ _id: 1 }).limit(MAX_RECIPIENTS).lean();
    outside.optedOut = await Customer.countDocuments({ ...base, isDemo: { $ne: true }, optedOut: true });
    if (consentRequest) {
      const live = { ...base, isDemo: { $ne: true }, optedOut: { $ne: true } };
      outside.alreadyConsented = await Customer.countDocuments({ ...live, marketingConsent: true });
      outside.askedRecently = await Customer.countDocuments({ ...live, marketingConsent: { $ne: true }, marketingConsentAskedAt: { $gte: askCutoff } });
    } else if (category !== 'UTILITY') {
      outside.noConsent =await Customer.countDocuments({ ...base, isDemo: { $ne: true }, optedOut: { $ne: true }, marketingConsent: { $ne: true } });
    }
    return { candidates: [...eligible, ...demo].sort(byId), notFound: 0, outside };
  }

  if (spec.kind === 'customer_ids') {
    const found = await findByIds(Customer, base, spec.customerIds, PROJECTION);
    return { candidates: found.sort(byId), notFound: spec.customerIds.length - found.length, outside };
  }

  // segment
  let candidates;
  if (spec.segmentKey === 'has_points') {
    candidates = await Customer.find({ ...base, loyaltyPoints: { $gte: spec.segmentParams.minPoints } })
      .select(PROJECTION).sort({ _id: 1 }).limit(MAX_CANDIDATES + 1).lean();
  } else if (spec.segmentKey === 'awaiting_consent') {
    // Not yet consented and not opted out: the people a consent request (use case
    // welcome_optin, a template with opt-in buttons) is for.
    candidates = await Customer.find({ ...base, marketingConsent: { $ne: true }, optedOut: { $ne: true } })
      .select(PROJECTION).sort({ _id: 1 }).limit(MAX_CANDIDATES + 1).lean();
  } else if (spec.segmentKey === 'inactive_days') {
    const ids = await staleCustomerIds(deps, workspaceId, spec.segmentParams.days);
    candidates = await findByIds(Customer, base, ids, PROJECTION);
  } else if (spec.segmentParams.language === 'unknown') {
    // "Unknown" = no CustomerLanguage row, or one that says unknown: load, then filter below.
    candidates = await Customer.find(base).select(PROJECTION).sort({ _id: 1 }).limit(MAX_CANDIDATES + 1).lean();
  } else {
    const rows = await deps.CustomerLanguage.find({ workspaceId, language: spec.segmentParams.language })
      .select('customerId').limit(MAX_CANDIDATES + 1).lean();
    if (rows.length > MAX_CANDIDATES) throw tooBroad(MAX_CANDIDATES);
    candidates = await findByIds(Customer, base, rows.map((r) => r.customerId), PROJECTION);
  }
  if (candidates.length > MAX_CANDIDATES) throw tooBroad(MAX_CANDIDATES);
  return { candidates: candidates.sort(byId), notFound: 0, outside };
}

// -> {
//   kind, selected, eligible, notFound,
//   skipped: { noConsent, optedOut, demo, invalidPhone, duplicatePhone, alreadyConsented, askedRecently },
//   customers: [{ id, firstname, lastname, phone, phoneDigits, loyaltyPoints, language, isDemo, skip }]  (by id; `skip` null = will be sent)
// }
async function resolveAudience({ workspaceId, audience, category = 'MARKETING', consentRequest = false }, deps = realDeps()) {
  if (!workspaceId) throw new Error('workspaceId is required');
  const spec = normalizeAudienceSpec(audience);
  const { candidates, notFound, outside } = await loadCandidates(deps, { workspaceId, spec, category, consentRequest });

  const languages = await languageMap(deps, workspaceId, candidates);
  // Only a customer who could otherwise be messaged needs the same-phone check, so an audience made
  // of demo / opted-out / undeliverable records costs no extra read.
  const needsPhoneCheck = candidates.some((c) => c.isDemo !== true && c.optedOut !== true && normalizeRecipientPhone(c.phone));
  const optedOutPhones = needsPhoneCheck ? await loadOptedOutPhones(deps, workspaceId) : new Set();
  let customers = candidates.map((c) => ({
    id: String(c._id),
    firstname: c.firstname || '',
    lastname: c.lastname || '',
    phone: c.phone === undefined || c.phone === null ? '' : String(c.phone),
    phoneDigits: normalizeRecipientPhone(c.phone),
    loyaltyPoints: Number.isFinite(Number(c.loyaltyPoints)) ? Number(c.loyaltyPoints) : 0,
    language: languages.get(String(c._id)) || 'unknown',
    isDemo: c.isDemo === true,
    marketingConsent: c.marketingConsent === true,
    optedOut: c.optedOut === true,
    skip: classifyCustomer(c, category, deps.consent, { consentRequest, nowMs: deps.now(), optedOutPhones }),
  }));
  if (spec.kind === 'segment' && spec.segmentKey === 'language') {
    customers = customers.filter((c) => c.language === spec.segmentParams.language);
  }

  const taken = new Set();
  for (const c of customers) {
    if (c.skip) continue;
    if (taken.has(c.phoneDigits)) c.skip = 'duplicate_phone';
    else taken.add(c.phoneDigits);
  }

  const skipped = {
    noConsent: outside.noConsent, optedOut: outside.optedOut, demo: 0, invalidPhone: 0, duplicatePhone: 0,
    alreadyConsented: outside.alreadyConsented, askedRecently: outside.askedRecently,
  };
  for (const c of customers) {
    if (c.skip === 'demo') skipped.demo += 1;
    else if (c.skip === 'opted_out' || c.skip === 'opted_out_phone') skipped.optedOut += 1; // a same-phone sibling counts as opted out
    else if (c.skip === 'no_consent') skipped.noConsent += 1;
    else if (c.skip === 'invalid_phone') skipped.invalidPhone += 1;
    else if (c.skip === 'duplicate_phone') skipped.duplicatePhone += 1;
    else if (c.skip === 'already_consented') skipped.alreadyConsented += 1;
    else if (c.skip === 'asked_recently') skipped.askedRecently += 1;
  }
  const eligible = customers.filter((c) => !c.skip).length;
  if (eligible > MAX_RECIPIENTS) throw tooBroad(MAX_RECIPIENTS);
  const outsideTotal = outside.optedOut + outside.noConsent + outside.alreadyConsented + outside.askedRecently;

  return { kind: spec.kind, selected: customers.length + outsideTotal, eligible, notFound, skipped, customers };
}

module.exports = {
  MAX_RECIPIENTS, MAX_CUSTOMER_IDS, CONSENT_ASK_COOLDOWN_MS, MAX_CANDIDATES, AUDIENCE_KINDS, SEGMENTS, SEGMENT_KEYS, SKIP_STATUS, CUSTOMER_PROJECTION: PROJECTION,
  httpError, asObjectId, chunk, isPlainObject,
  normalizeAudienceSpec, normalizeRecipientPhone, classifyCustomer, loadOptedOutPhones, resolveAudience, realDeps,
};
