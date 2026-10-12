'use strict';
// Deterministic, localised text for the human-approval gate (spec §6: "nothing
// sends without explicit confirmation, in any language; a misunderstood Arabic
// request must never result in a send").
//
// The English agent shows the merchant whatever sentence the MODEL wrote before
// calling an action tool (audit R6 §2.5 item 7), so a mis-read request could be
// described correctly and executed with different arguments. Here the card is
// built by the SERVER from the stored arguments: the promotion / flow name is
// looked up from the id that will really be sent, the customer count is the
// real length of the list, a phone number is masked, a refund names its amount
// and says it is irreversible. The model's own prose never becomes the card.
//
// Also here: the sentences that report what happened after a confirmed action
// (replacing the second LLM call `phraseResult` that the English agent makes),
// including the demo-simulation disclosure that was added after a real
// incident, and the user-facing error text (internal and Stripe messages are
// never shown; only a short allow-list of known, safe causes is explained).
//
// All text comes from catalog/aimode.json. Counts use CLDR plural categories
// (Arabic: zero/one/two/few/many/other) implemented by hand, so the result does
// not depend on which ICU data the Node build ships.
const catalog = require('../catalog');
const { stripInvisibles } = require('../arabicText');

const NS = 'aimode.';
const BULLET = String.fromCodePoint(0x2022);
const MAX_NAMES = 3;

const lang = (language) => (language === 'ar' ? 'ar' : 'en');
const t = (language, key, params) => catalog.t(lang(language), `${NS}${key}`, params);
const isObject = (v) => v !== null && typeof v === 'object';
const num = (v) => (Number.isFinite(v) ? v : 0);

function formatInt(n) {
  return Math.round(Number(n)).toLocaleString('en-US');
}

// CLDR plural category of an integer count.
function pluralCategory(language, n) {
  const count = Number(n);
  if (!Number.isInteger(count) || count < 0) return 'other';
  if (lang(language) !== 'ar') return count === 1 ? 'one' : 'other';
  if (count === 0) return 'zero';
  if (count === 1) return 'one';
  if (count === 2) return 'two';
  const m = count % 100;
  if (m >= 3 && m <= 10) return 'few';
  if (m >= 11) return 'many';
  return 'other';
}

// "عميل واحد", "عميلين" (after a preposition) / "عميلان" (standalone), "3 عملاء",
// "15 عميلاً", "100 عميل"; English "1 customer", "3 customers".
function countPhrase(language, noun, n, { oblique = false } = {}) {
  const l = lang(language);
  const category = pluralCategory(l, n);
  const key = l === 'ar' && category === 'two' && oblique ? `count.${noun}.twoOblique` : `count.${noun}.${category}`;
  return t(l, key).replace('{n}', formatInt(n));
}

// Names that come from the database (and, for customers, from WhatsApp profile
// names written by strangers) are shown to the merchant on the card: strip
// invisible/bidi controls, flatten whitespace, cap the length.
function displayName(value, max = 60) {
  const flat = stripInvisibles(value === undefined || value === null ? '' : String(value))
    .replace(/[\u{0000}-\u{001F}\u{007F}-\u{009F}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

// +966•••••4567: country code and last four digits only.
function maskPhone(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length < 8) return d ? `+${BULLET.repeat(d.length)}` : '';
  return `+${d.slice(0, 3)}${BULLET.repeat(d.length - 7)}${d.slice(-4)}`;
}

const CURRENCY_SYMBOLS_AR = Object.freeze({ SAR: 'ر.س', AED: 'د.إ' });

function formatMoney(amount, currency, language) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const code = String(currency || 'SAR').toUpperCase();
  const symbol = lang(language) === 'ar' ? CURRENCY_SYMBOLS_AR[code] || code : code;
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${symbol}`;
}

// ── references ────────────────────────────────────────────────────────────
// Looks up what the action's ids point at, scoped to the workspace by the
// injected `lookups` (see lookups.js). Per reference: undefined = not applicable
// or the lookup was unavailable (the card falls back to the raw id), null =
// definitely not found, object = found. `problems` lists everything that makes
// the proposal pointless or unsafe; the agent hands them back to the model as a
// tool error instead of showing a card that is bound to fail.
async function resolveReferences({ toolName, args, workspaceId, lookups }) {
  const refs = { promotion: undefined, flow: undefined, order: undefined, customers: undefined, loyaltyAudience: undefined };
  const problems = [];
  if (!lookups) return { refs, problems };
  const call = async (name, ...params) => {
    if (typeof lookups[name] !== 'function') return undefined;
    try { return await lookups[name](workspaceId, ...params); } catch { return undefined; }
  };
  const a = args || {};

  if (toolName === 'send_promotion' || toolName === 'send_test_message') {
    refs.promotion = await call('promotion', a.promotionId);
    if (refs.promotion === null) problems.push(`promotionId ${a.promotionId} does not match any promotion in this workspace; call list_promotions and use an id from its result`);
  }
  if (toolName === 'send_promotion' || (toolName === 'send_loyalty_reminders' && Array.isArray(a.customerIds))) {
    refs.customers = await call('customers', a.customerIds);
    if (isObject(refs.customers) && num(refs.customers.found) < a.customerIds.length) {
      const missing = a.customerIds.length - num(refs.customers.found);
      problems.push(`${missing} of the ${a.customerIds.length} customerIds do not match customers in this workspace; look the customers up again in this turn (list_customers or get_recommended_customers)`);
    }
  }
  if (toolName === 'send_loyalty_reminders' && !Array.isArray(a.customerIds)) {
    refs.loyaltyAudience = await call('loyaltyAudience');
  }
  if (toolName === 'activate_flow') {
    refs.flow = await call('flow', a.flowId);
    if (refs.flow === null) problems.push(`flowId ${a.flowId} does not match any automated flow in this workspace; call list_flows and use an id from its result`);
  }
  if (toolName === 'refund_order') {
    refs.order = await call('order', a.orderId);
    if (refs.order === null) problems.push(`orderId ${a.orderId} does not match any order in this workspace; call list_orders and use an id from its result`);
    else if (isObject(refs.order) && refs.order.paymentStatus !== undefined && refs.order.paymentStatus !== 'paid') {
      problems.push(`this order's payment status is "${refs.order.paymentStatus}"; only paid orders can be refunded`);
    } else if (isObject(refs.order) && refs.order.hasStripePayment === false) {
      problems.push('this order has no Stripe payment to refund');
    }
  }
  return { refs, problems };
}

// ── confirmation summaries ────────────────────────────────────────────────
function nameList(language, customers, total) {
  const names = (isObject(customers) && Array.isArray(customers.names) ? customers.names : [])
    .map((n) => displayName(n, 40)).filter(Boolean).slice(0, MAX_NAMES);
  if (!names.length) return null;
  const joined = names.join(lang(language) === 'ar' ? '، ' : ', ');
  return total > names.length ? t(language, 'summary.namesMore', { names: joined }) : joined;
}

function entityName(ref, fallbackId) {
  return isObject(ref) && ref.name ? displayName(ref.name) : displayName(fallbackId);
}

function describeArgs(args) {
  const compact = (v) => {
    if (Array.isArray(v)) return `[${v.length}]`;
    if (isObject(v)) return '{...}';
    return displayName(typeof v === 'string' ? v : JSON.stringify(v), 40);
  };
  return Object.entries(args || {}).map(([k, v]) => `${k}: ${compact(v)}`).join(', ').slice(0, 300);
}

// -> string. `resolved` ({ refs, problems }) can be passed in when the caller
// already ran resolveReferences (the agent does, to reject unusable proposals).
async function buildSummary({ toolName, args, language, lookups, workspaceId, resolved }) {
  const l = lang(language);
  const a = args || {};
  const { refs } = resolved || await resolveReferences({ toolName, args: a, workspaceId, lookups });

  switch (toolName) {
    case 'send_promotion': {
      const total = Array.isArray(a.customerIds) ? a.customerIds.length : 0;
      const names = nameList(l, refs.customers, total);
      const params = { promotion: entityName(refs.promotion, a.promotionId), customers: countPhrase(l, 'customer', total, { oblique: true }) };
      const head = names ? t(l, 'summary.sendPromotionNames', { ...params, names }) : t(l, 'summary.sendPromotion', params);
      return `${head} ${t(l, 'summary.consentNote')}`;
    }
    case 'send_test_message':
      return t(l, 'summary.sendTest', { promotion: entityName(refs.promotion, a.promotionId), phone: maskPhone(a.phone) });
    case 'send_loyalty_reminders': {
      let head;
      if (Array.isArray(a.customerIds) && a.customerIds.length) {
        const customers = countPhrase(l, 'customer', a.customerIds.length, { oblique: true });
        const names = nameList(l, refs.customers, a.customerIds.length);
        head = names ? t(l, 'summary.sendLoyaltySomeNames', { customers, names }) : t(l, 'summary.sendLoyaltySome', { customers });
      } else if (Number.isFinite(refs.loyaltyAudience) && refs.loyaltyAudience > 0) {
        head = t(l, 'summary.sendLoyaltyAllCount', { customers: countPhrase(l, 'customer', refs.loyaltyAudience, { oblique: true }) });
      } else {
        head = t(l, 'summary.sendLoyaltyAll');
      }
      return `${head} ${t(l, 'summary.consentNote')}`;
    }
    case 'activate_flow':
      return t(l, 'summary.activateFlow', { flow: entityName(refs.flow, a.flowId) });
    case 'refund_order': {
      const order = `#${String(a.orderId || '').slice(-6)}`;
      const o = isObject(refs.order) ? refs.order : {};
      const amount = o.total !== undefined && o.total !== null ? formatMoney(o.total, o.currency, l) : null;
      const customer = o.customerName ? displayName(o.customerName, 40) : '';
      if (amount && customer) return t(l, 'summary.refundOrderBoth', { order, amount, customer });
      if (amount) return t(l, 'summary.refundOrderAmount', { order, amount });
      if (customer) return t(l, 'summary.refundOrderCustomer', { order, customer });
      return t(l, 'summary.refundOrder', { order });
    }
    default:
      return t(l, 'summary.generic', { tool: displayName(toolName, 60), details: describeArgs(a) || '-' });
  }
}

// ── results and errors ────────────────────────────────────────────────────
// Same rule as ai/agent.js: a simulated (demo) send must never read as an
// unqualified success. `total` is the number of sends the executor counted.
function demoDisclosure(language, result) {
  const demoCount = result && result.demoCount;
  if (typeof demoCount !== 'number' || !(demoCount > 0)) return '';
  const total = result.sentCount ?? demoCount;
  return demoCount >= total ? t(language, 'result.demoAll') : t(language, 'result.demoPartial', { demo: demoCount, total });
}

function describeSend(language, toolName, result) {
  const done = toolName === 'send_promotion' ? 'result.sendPromotionDone' : 'result.sendLoyaltyDone';
  const disclosure = demoDisclosure(language, result);
  if (!Number.isFinite(result.sentCount)) return [t(language, 'result.generic'), disclosure].filter(Boolean).join('\n\n');
  const sent = result.sentCount;
  const real = Math.max(0, sent - num(result.demoCount));
  const skipped = num(result.skippedOptedOut) + num(result.skippedNoConsent);
  const failed = Array.isArray(result.errors) ? result.errors.length : 0;
  const parts = [];
  if (sent === 0) parts.push(t(language, 'result.nothingSent'));
  else if (real > 0) parts.push(t(language, done, { customers: countPhrase(language, 'customer', real, { oblique: true }) }));
  if (skipped > 0) parts.push(t(language, 'result.skipped', { count: skipped }));
  if (failed > 0) parts.push(t(language, 'result.failedSends', { count: failed }));
  return [parts.join(' '), disclosure].filter(Boolean).join('\n\n');
}

// -> string. `args` are the stored (server-side) arguments the action ran with.
function describeResult({ toolName, args, result, language }) {
  const l = lang(language);
  const r = isObject(result) ? result : {};
  const a = args || {};
  switch (toolName) {
    case 'send_promotion':
    case 'send_loyalty_reminders':
      return describeSend(l, toolName, r);
    case 'send_test_message':
      return r.success === false ? t(l, 'result.generic') : t(l, 'result.testSent', { phone: maskPhone(a.phone) });
    case 'activate_flow':
      if (r.status !== 'active') return t(l, 'result.generic');
      return r.name ? t(l, 'result.flowActivated', { flow: displayName(r.name) }) : t(l, 'result.flowActivatedNoName');
    case 'refund_order':
      return r.paymentStatus === 'refunded' ? t(l, 'result.refunded', { order: `#${String(a.orderId || '').slice(-6)}` }) : t(l, 'result.generic');
    default:
      return [t(l, 'result.generic'), demoDisclosure(l, r)].filter(Boolean).join('\n\n');
  }
}

// Only these known, merchant-safe causes are explained. Everything else (Stripe
// and database messages, stack text) collapses to the generic sentence.
const KNOWN_ERRORS = Object.freeze([
  [/promotion not found/i, 'error.promotionNotFound'],
  [/flow not found/i, 'error.flowNotFound'],
  [/order not found/i, 'error.orderNotFound'],
  [/only paid orders can be refunded/i, 'error.refundNotPaid'],
  [/no stripe payment to refund/i, 'error.refundNoPayment'],
  [/needs an approved (custom message|whatsapp template)/i, 'error.flowNeedsApproval'],
  [/customerIds required/i, 'error.noCustomers'],
]);

function describeError({ error, language }) {
  const message = error && typeof error.message === 'string' ? error.message : '';
  const known = KNOWN_ERRORS.find(([re]) => re.test(message));
  return known ? t(language, 'error.withReason', { reason: t(language, known[1]) }) : t(language, 'error.generic');
}

module.exports = {
  pluralCategory, countPhrase, displayName, maskPhone, formatMoney, formatInt,
  resolveReferences, buildSummary, describeResult, describeError, demoDisclosure,
};
