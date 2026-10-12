'use strict';
// Bridge between the Arabic AI Mode agent and the existing tool registry
// (ai/tools.js: 20 tools, 5 of them gated actions). The registry itself is NOT
// modified or copied; this file wraps it with what the English agent lacks
// (audit R6 §2.5 item 8, §6 item 4): every tool input is validated and coerced
// BEFORE it is run or stored as a pending action, so a model that returns the
// string "٣٠" for `days`, an object where an id belongs, or a 40-million-row
// `limit` can never reach the database layer.
//
// The registry is injected (`createToolBridge(registry)`); the default loader
// requires ai/tools.js LAZILY because that module pulls shared/operations,
// which builds a Stripe client at import time. Unit tests and the evaluation
// harness pass their own registry (same shape: { getTool, toolsForClaude }).
//
// ALLOW-LIST SNAPSHOT: ACTION_TOOL_NAMES lists the tools the confirm gate
// protects. tests/localization/aiModeGate.test.js asserts the registry's
// `isAction` set equals it exactly, and that every registry tool is classified
// as read / draft-write / action here, so adding or re-flagging a tool forces
// a human to review this module and the confirmation summaries.
//
// Coercion policy per field:
//   * `limit`, `days`  -> clamped into a sane range (a huge number is harmless
//                         once clamped).
//   * everything else numeric (month, year, discountPercent, thresholds...)
//                      -> must be in range or the call is REJECTED. Clamping a
//                         write argument ("150% discount" -> 100%) would turn a
//                         misread into a valid but wrong value; the model gets
//                         an error and asks the merchant instead.
//   * `...Id` / `...Ids` -> 24-hex ids only (assertObjectId / assertObjectIdArray),
//                         which also blocks {"$ne": null} style operator bodies.
//   * strings          -> invisible/bidi characters stripped, length capped.
//   * unknown fields   -> dropped (the schemas are additionalProperties:false).
// `workspaceId` is never an argument: the agent always passes the verified one.
const { assertObjectId, assertObjectIdArray } = require('../scope');
const { toWesternDigits, stripInvisibles, stripDiacritics, stripTatweel } = require('../arabicText');
const { sanitize, tidyDisplay } = require('./normalize');

const ACTION_TOOL_NAMES = Object.freeze(['send_promotion', 'send_test_message', 'send_loyalty_reminders', 'activate_flow', 'refund_order']);
// Not gated (they only create a draft / an inactive record) but they DO write.
const DRAFT_WRITE_TOOL_NAMES = Object.freeze(['create_promotion', 'create_flow']);
const READ_TOOL_NAMES = Object.freeze([
  'get_smart_insights', 'get_order_stats', 'list_customers', 'get_customer_return_rate', 'get_top_loyalty_customers',
  'get_best_performing_promotion', 'list_inactive_customers', 'list_promotions', 'list_flows', 'list_orders',
  'get_campaign_report', 'get_flow_report', 'get_recommended_customers',
]);

const MAX_CUSTOMER_IDS = 500;
const MAX_ARRAY_ITEMS = 100;
const ORDER_STATUSES = Object.freeze(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled']);

// field name -> { min, max, clamp }
const NUMBER_RULES = Object.freeze({
  limit: { min: 1, max: 100, clamp: true },
  days: { min: 1, max: 3650, clamp: true },
  month: { min: 1, max: 12 },
  year: { min: 2000, max: 2100 },
  discountPercent: { min: 0, max: 100 },
  pointsPrice: { min: 0, max: 1000000 },
  inactivityDays: { min: 1, max: 3650 },
  delayHours: { min: 0, max: 8760 },
  pointsThreshold: { min: 1, max: 10000000 },
  orderCountThreshold: { min: 1, max: 1000 },
});
const DEFAULT_NUMBER_RULE = Object.freeze({ min: -1e9, max: 1e9 });

// "<tool>.<field>" -> extra rules that the registry's schema does not express.
const FIELD_RULES = Object.freeze({
  'list_orders.status': { enum: ORDER_STATUSES },
  'list_customers.search': { kind: 'search' },
  'send_test_message.phone': { kind: 'phone' },
});
const STRING_MAX = Object.freeze({ name: 120, description: 1000, search: 60, phone: 32 });
const DEFAULT_STRING_MAX = 200;

function loadRegistry() {
  return require('../../../ai/tools'); // lazy: see the header
}

function assertRegistry(registry) {
  if (!registry || typeof registry.getTool !== 'function' || typeof registry.toolsForClaude !== 'function') {
    throw new Error('AI Mode tool registry must provide getTool() and toolsForClaude()');
  }
  return registry;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ── numbers ───────────────────────────────────────────────────────────────
const PLAIN_NUMBER_RE = /^[+-]?\d+(?:\.\d+)?$/;
const GROUPED_NUMBER_RE = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

function parseNumberLike(value, { allowPercent = false } = {}) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  let s = stripInvisibles(toWesternDigits(value)).replace(/\u{066C}/gu, ',').replace(/\u{066B}/gu, '.').trim();
  if (allowPercent) s = s.replace(/\s*[%\u{066A}]$/u, '');
  if (PLAIN_NUMBER_RE.test(s)) return Number(s);
  if (GROUPED_NUMBER_RE.test(s)) return Number(s.replace(/,/g, ''));
  return NaN;
}

function coerceNumber(field, value, { integer }) {
  const parsed = parseNumberLike(value, { allowPercent: /Percent$/.test(field) });
  if (!Number.isFinite(parsed)) throw new Error(`must be a number, got ${describe(value)}`);
  const rule = NUMBER_RULES[field] || DEFAULT_NUMBER_RULE;
  let n = integer ? Math.round(parsed) : parsed;
  if (n < rule.min || n > rule.max) {
    if (!rule.clamp) throw new Error(`must be between ${rule.min} and ${rule.max}, got ${n}`);
    n = Math.min(rule.max, Math.max(rule.min, n));
  }
  return n;
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  throw new Error(`must be true or false, got ${describe(value)}`);
}

// ── strings ───────────────────────────────────────────────────────────────
function describe(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
  if (typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object';
  return String(value);
}

// Local numbers (0501234567) are ambiguous across countries and a wrong guess
// would message a stranger, so the country code is required, not inferred.
function normalizePhone(raw) {
  const s = toWesternDigits(stripInvisibles(String(raw))).trim();
  let digits = s.replace(/\D/g, '');
  if (!s.startsWith('+') && digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) {
    throw new Error('must include the country code, for example 966501234567 (a local number starting with 0 is ambiguous)');
  }
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('must be an international phone number of 8 to 15 digits, for example 966501234567');
  }
  return digits;
}

// list_customers hands `search` to a $regex UNESCAPED (shared/operations.js
// listCustomers), so a "(" is an invalid pattern and ".*" matches everything.
// Here every character becomes an escaped literal or a letter class, which makes
// the term a plain substring search that cannot backtrack, and makes Arabic
// spelling variants match each other (احمد finds أحمد, مدرسه finds مدرسة).
// Phone-like terms are reduced to digits without the international/trunk prefix
// so 0501234567, +966 50 123 4567 and 501234567 all find 966501234567.
const cp = (...codes) => codes.map((c) => String.fromCodePoint(c)).join('');
const SEARCH_FAMILIES = [
  cp(0x0627, 0x0622, 0x0623, 0x0625, 0x0671), // alef, madda, hamza above/below, wasla
  cp(0x064A, 0x0649), // yeh, alef maksura
  cp(0x0647, 0x0629), // heh, teh marbuta
];
const SEARCH_CLASS = new Map();
for (const members of SEARCH_FAMILIES) for (const ch of members) SEARCH_CLASS.set(ch, `[${members}]`);
const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|]/;
const PHONE_LIKE_RE = /^\+?[\d\s().-]*\d[\d\s().-]*$/;

function buildSearchTerm(raw) {
  const text = stripDiacritics(stripTatweel(toWesternDigits(raw))).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (PHONE_LIKE_RE.test(text)) {
    const digits = text.replace(/\D/g, '').replace(/^00/, '').replace(/^0/, '');
    return digits || undefined;
  }
  let out = '';
  for (const ch of text) {
    if (SEARCH_CLASS.has(ch)) out += SEARCH_CLASS.get(ch);
    else if (REGEX_SPECIALS.test(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

function coerceString(tool, field, value) {
  let v = value;
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v); // a phone number sent as a JSON number
  if (typeof v !== 'string') throw new Error(`must be a string, got ${describe(value)}`);
  const rule = FIELD_RULES[`${tool}.${field}`] || {};
  const single = field !== 'description';
  const clean = single ? sanitize(v).replace(/\s+/g, ' ').trim() : tidyDisplay(sanitize(v));
  if (!clean) return undefined;
  if (Array.from(clean).length > (STRING_MAX[field] || DEFAULT_STRING_MAX) && rule.kind !== 'phone' && rule.kind !== 'search') {
    throw new Error(`is too long (max ${STRING_MAX[field] || DEFAULT_STRING_MAX} characters)`);
  }
  if (rule.kind === 'phone') return normalizePhone(clean);
  if (rule.kind === 'search') return buildSearchTerm(Array.from(clean).slice(0, STRING_MAX.search).join(''));
  return clean;
}

function normalizeEnumKey(s) {
  return String(s).trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function matchEnum(value, allowed) {
  if (typeof value !== 'string') throw new Error(`must be one of: ${allowed.join(', ')}`);
  const key = normalizeEnumKey(value);
  const hit = allowed.find((a) => normalizeEnumKey(a) === key);
  if (hit === undefined) throw new Error(`must be one of: ${allowed.join(', ')}, got ${describe(value)}`);
  return hit;
}

// ── ids and containers ────────────────────────────────────────────────────
function isIdField(field) {
  return /[a-z]Ids?$/.test(field);
}

function coerceId(field, value) {
  try {
    return assertObjectId(value, field);
  } catch {
    throw new Error(`must be a 24-character hex id taken from a lookup in this turn, got ${describe(value)}`);
  }
}

function coerceIdArray(field, value) {
  if (!Array.isArray(value)) throw new Error(`must be an array of ids, got ${describe(value)}`);
  if (value.length === 0) {
    throw new Error('must contain at least one id (leave the field out only if the tool allows targeting everyone)');
  }
  let ids;
  try {
    ids = assertObjectIdArray(value, field, { max: MAX_CUSTOMER_IDS });
  } catch (err) {
    throw new Error(`${err.message} (ids must be 24-character hex ids taken from a lookup in this turn)`);
  }
  return Array.from(new Set(ids));
}

// Deep copy of plain JSON for object-typed arguments of future tools: operator
// keys ("$ne") and dotted paths are dropped so the value cannot become a query.
function cleanPlain(value, depth = 0) {
  if (depth > 4) return undefined;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((v) => cleanPlain(v, depth + 1)).filter((v) => v !== undefined);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.')) continue;
      const cleaned = cleanPlain(v, depth + 1);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  if (typeof value === 'string') return sanitize(value).slice(0, 500);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return typeof value === 'boolean' ? value : undefined;
}

function coerceField(tool, field, spec, value) {
  const rule = FIELD_RULES[`${tool}.${field}`] || {};
  const type = spec && spec.type;
  if (isIdField(field)) return type === 'array' ? coerceIdArray(field, value) : coerceId(field, value);
  const allowed = rule.enum || (spec && spec.enum);
  if (allowed) return matchEnum(value, allowed);
  switch (type) {
    case 'integer': return coerceNumber(field, value, { integer: true });
    case 'number': return coerceNumber(field, value, { integer: false });
    case 'boolean': return coerceBoolean(value);
    case 'string': return coerceString(tool, field, value);
    case 'array': {
      if (!Array.isArray(value)) throw new Error(`must be an array, got ${describe(value)}`);
      return value.slice(0, MAX_ARRAY_ITEMS).map((item) => coerceString(tool, field, item)).filter((v) => v !== undefined);
    }
    default: return cleanPlain(value);
  }
}

// -> { ok: true, args } | { ok: false, error }
function prepareToolInput(tool, rawInput) {
  if (!tool) return { ok: false, error: 'unknown tool' };
  const schema = tool.input_schema || {};
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const input = isPlainObject(rawInput) ? rawInput : {};
  const args = {};
  const problems = [];
  for (const [field, spec] of Object.entries(properties)) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    try {
      const coerced = coerceField(tool.name, field, spec, value);
      if (coerced !== undefined) args[field] = coerced;
    } catch (err) {
      problems.push(`${field} ${err.message}`);
    }
  }
  for (const field of required) {
    if (args[field] === undefined && !problems.some((p) => p.startsWith(`${field} `))) problems.push(`${field} is required`);
  }
  if (problems.length) return { ok: false, error: problems.join('; ') };
  return { ok: true, args };
}

// `source` is a registry object or a function that returns one (loaded on first use).
function createToolBridge(source = loadRegistry) {
  let registry = null;
  const reg = () => {
    if (!registry) registry = assertRegistry(typeof source === 'function' ? source() : source);
    return registry;
  };
  const getTool = (name) => (typeof name === 'string' ? reg().getTool(name) : undefined);
  return {
    toolsForClaude: () => reg().toolsForClaude(),
    getTool,
    // Fail safe: anything truthy on the registry flag is gated; an unknown name is not an action (and cannot run either).
    isAction: (name) => { const tool = getTool(name); return !!(tool && tool.isAction); },
    prepareInput: (name, input) => prepareToolInput(getTool(name), input),
    listTools: () => reg().toolsForClaude().map((t) => ({ name: t.name, isAction: !!(getTool(t.name) && getTool(t.name).isAction) })),
  };
}

module.exports = {
  ACTION_TOOL_NAMES,
  DRAFT_WRITE_TOOL_NAMES,
  READ_TOOL_NAMES,
  MAX_CUSTOMER_IDS,
  ORDER_STATUSES,
  createToolBridge,
  prepareToolInput,
  buildSearchTerm,
  normalizePhone,
  parseNumberLike,
  loadRegistry,
};
