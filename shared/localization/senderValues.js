'use strict';
// Merge-field values for the Arabic versions of the EXISTING senders (shared/operations.js
// sendPromotion / sendLoyaltyReminders / sendConsentRequests, the booking / order notices and the
// referral link text). One function per field, every value sanitised and clipped, so the senders
// (legacySenders.js, utilitySend.js) and the plan (legacyPlan.js) agree on what can be filled.
//
// Field registry
//   name        the customer's usable first name; a phone-number "name" (the Inbox names a customer it only
//               knows by number after the number), a name without a letter, or an empty one gives the
//               catalogue fallback (flows.fallbackName). Bidi controls are removed, clipped to 60 characters.
//   full_name   first + last name (clipped to 90); the same fallback.
//   points      the loyalty balance as a whole number (never negative).
//   business    the merchant's business name (planner.resolveBusinessName).
//   amount      the worth of the loyalty points, points / 10 as the English loyalty template computes it,
//               written like 12.50 ر.س (Western digits, GLOSSARY D8).
//   promo_name  the promotion's name.
//   item        the first item of the promotion: a REVIEWED Arabic product / service name when one exists
//               (G2), else the English name, else the catalogue fallback (flows.fallbackItem).
//   price       cash promotion: the first item's discounted price like 45.00 ر.س; points promotion: the
//               points price as a counted Arabic phrase (flowBridge.arabicPointsPhrase).
//   discount    the promotion's discount percent (whole or decimal, no sign).
//   points_price the points price of a points promotion as a bare number.
//   date        the promotion's end date: Gregorian, Western digits, UTC, "30 نوفمبر" (+ the year when it is
//               not the current one). A promotion without an end date cannot fill it.
// A value nobody can fill is reported as MISSING (never invented): the caller falls back to English rather
// than send a message with a hole in it.
//
// Pure helpers + a few functions that take injectable deps (no model is required at load time).
const { toWesternDigits, stripInvisibles } = require('./arabicText');
const { sanitizeValue } = require('./mergeFields');
const catalog = require('./catalog');

const NAME_MAX = 60;
const FULL_NAME_MAX = 90;
const PROMO_NAME_MAX = 100;
const ITEM_NAME_MAX = 100;
const PHONE_LIKE_RE = /^\+?[\d\s().-]{7,}$/;
const BIDI_SPOOF_RE = /[\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
const CONTROL_RE = /[\u{0000}-\u{001F}\u{007F}-\u{009F}]/gu;
const CURRENCY_SYMBOLS_AR = Object.freeze({ SAR: 'ر.س', AED: 'د.إ' });
const MONTHS_AR = Object.freeze(['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']);

// What each sender can fill (the derivation below). `date`/`price`/... of a promotion are only available
// when the promotion supplies them (see promotionValues).
const SENDER_FIELDS = Object.freeze({
  promotion: Object.freeze(['name', 'full_name', 'points', 'business', 'amount', 'promo_name', 'item', 'price', 'discount', 'points_price', 'date']),
  loyalty_reminder: Object.freeze(['name', 'full_name', 'points', 'business', 'amount']),
  consent_request: Object.freeze(['name', 'full_name', 'business']),
});

function clip(text, max) {
  return Array.from(text).slice(0, max).join('').trim();
}

// Free text that came from a person or a form: no bidi controls (they could reorder the sentence around the
// value), no control characters, single line, clipped by code points (an emoji is never cut in half).
function plainText(raw, max) {
  const flat = String(raw === undefined || raw === null ? '' : raw).replace(BIDI_SPOOF_RE, '').replace(CONTROL_RE, ' ');
  return clip(sanitizeValue(stripInvisibles(flat)), max);
}

function hasLetter(text) { return /\p{L}/u.test(text); }

function usableName(raw, max = NAME_MAX) {
  const text = plainText(raw, max);
  if (!text || !hasLetter(text) || PHONE_LIKE_RE.test(toWesternDigits(text))) return '';
  return text;
}

function fallbackName() { return catalog.t('ar', 'flows.fallbackName'); }

function nameValue(customer) {
  return usableName(customer && customer.firstname) || fallbackName();
}

function fullNameValue(customer) {
  const first = usableName(customer && customer.firstname);
  if (!first) return fallbackName();
  const last = usableName(customer && customer.lastname);
  return clip(`${first}${last ? ` ${last}` : ''}`, FULL_NAME_MAX);
}

function pointsNumber(customer) {
  const n = Math.round(Number(customer && customer.loyaltyPoints));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function pointsValue(customer) { return String(pointsNumber(customer)); }

// 150.00 ر.س (number, space, symbol). Unknown currency codes are written as the code. null for a non-number.
function formatMoney(amount, currency, language = 'ar') {
  const n = Number(amount);
  if (amount === null || amount === undefined || amount === '' || !Number.isFinite(n)) return null;
  const code = String(currency || 'SAR').toUpperCase();
  const symbol = language === 'ar' ? (CURRENCY_SYMBOLS_AR[code] || code) : code;
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${symbol}`;
}

// The worth of a points balance: points / 10, exactly what the English loyalty template computes.
function amountValue(customer, currency) {
  return formatMoney(+(pointsNumber(customer) / 10).toFixed(2), currency, 'ar');
}

// "30 نوفمبر" / "5 مارس 2027": Gregorian, Western digits, UTC. null for a missing or invalid date.
function formatDate(value, { now = Date.now(), language = 'ar' } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const day = d.getUTCDate();
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear();
  const currentYear = new Date(now).getUTCFullYear();
  const monthName = language === 'ar' ? MONTHS_AR[month] : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][month];
  return year === currentYear ? `${day} ${monthName}` : `${day} ${monthName} ${year}`;
}

// ── promotion values (computed ONCE per run) ─────────────────────────────────

// Arabic number agreement for a points price, through the flow bridge (one implementation of the phrase).
function pointsPhrase(value) {
  return require('./flowBridge').arabicPointsPhrase(value);
}

function itemKind(promotion) { return promotion && promotion.scope === 'services' ? 'service' : 'product'; }

// The same "what does this promotion cover" resolution as shared/operations.js#resolvePromoItems (store-wide /
// no-explicit-picks falls back to the first active items of its own workspace). Used only where the caller did
// not already resolve the items (the plan and the test send).
async function loadPromotionItems(deps, promotion) {
  const filter = { active: true };
  if (promotion.workspaceId) filter.workspaceId = promotion.workspaceId;
  if (promotion.scope === 'services') {
    return promotion.services && promotion.services.length ? promotion.services : deps.Service.find(filter).limit(10);
  }
  return promotion.products && promotion.products.length ? promotion.products : deps.Product.find(filter).limit(10);
}

// -> { values: { promo_name?, item?, price?, discount?, points_price?, date? } } - a field is simply absent when the
// promotion cannot supply it. Never throws for missing data.
async function promotionValues(deps, { promotion, items, currency, workspaceId, now }) {
  const out = Object.create(null);
  const name = plainText(promotion && promotion.name, PROMO_NAME_MAX);
  if (name) out.promo_name = name;

  const isPoints = promotion && promotion.customerType === 'points';
  const first = Array.isArray(items) && items.length ? items[0] : null;

  // item: reviewed Arabic name (G2), else the English one, else the fallback.
  let itemName = '';
  if (first) {
    try {
      const names = await deps.catalogTranslations.resolveItemNames({
        workspaceId, kind: itemKind(promotion), ids: [String(first._id)], language: 'ar',
      });
      itemName = plainText(names.get(String(first._id).toLowerCase()) || names.get(String(first._id)) || '', ITEM_NAME_MAX);
    } catch (err) { itemName = ''; }
    if (!itemName) itemName = plainText(first.name, ITEM_NAME_MAX);
  }
  out.item = itemName || catalog.t('ar', 'flows.fallbackItem');

  if (isPoints) {
    const pts = Number(promotion.pointsPrice);
    if (Number.isFinite(pts) && pts > 0) {
      out.price = pointsPhrase(pts);
      out.points_price = String(Math.round(pts));
    }
  } else if (first) {
    const discount = Number(promotion.discountPercent) || 0;
    const discounted = formatMoney(+(Number(first.basePrice) * (1 - discount / 100)).toFixed(2), currency, 'ar');
    if (discounted) out.price = discounted;
  }
  const percent = Number(promotion && promotion.discountPercent);
  if (Number.isFinite(percent) && percent > 0) out.discount = String(+percent.toFixed(2));
  const date = formatDate(promotion && promotion.endDate, { now: now === undefined ? Date.now() : now });
  if (date) out.date = date;
  return out;
}

// ── per-customer values ──────────────────────────────────────────────────────

// fields: the field names a variant uses. ctx: { business, currency, promotion: { ...promotionValues } | null }.
// -> { values (null-prototype), missing: [field] }
function valuesFor(fields, customer, ctx = {}) {
  const values = Object.create(null);
  const missing = [];
  const promo = ctx.promotion || {};
  for (const field of fields) {
    let value;
    switch (field) {
      case 'name': value = nameValue(customer); break;
      case 'full_name': value = fullNameValue(customer); break;
      case 'points': value = pointsValue(customer); break;
      case 'business': value = ctx.business; break;
      case 'amount': value = amountValue(customer, ctx.currency); break;
      case 'promo_name': case 'item': case 'price': case 'discount': case 'points_price': case 'date': value = promo[field]; break;
      default: value = undefined;
    }
    if (typeof value === 'string' && value.trim()) values[field] = value;
    else missing.push(field);
  }
  return { values, missing };
}

// Which of `fields` this sender could NEVER fill for anyone in this run (not part of the sender's registry,
// or the workspace / promotion lacks the value). Customer-level fields always have a fallback.
function unfillableFields(fields, sender, ctx = {}) {
  const known = SENDER_FIELDS[sender] || [];
  const promo = ctx.promotion || {};
  return fields.filter((field) => {
    if (!known.includes(field)) return true;
    if (field === 'business') return !(typeof ctx.business === 'string' && ctx.business.trim());
    if (['promo_name', 'item', 'price', 'discount', 'points_price', 'date'].includes(field)) return !(typeof promo[field] === 'string' && promo[field].trim());
    return false;
  });
}

// ── booking / order notices (session text) ───────────────────────────────────

function slotParts(slot) {
  return {
    date: plainText(slot && slot.date, 40),
    time: plainText(slot && slot.startTime, 40),
  };
}

// values of senders.bookingConfirmed / bookingRescheduled / bookingDeclined / bookingCancelled for a populated Booking.
// `slot` overrides booking.slotId (reschedule passes the NEW slot). The cancelled message wants {slot} = "date time".
function bookingNoticeValues(booking, slot) {
  const useSlot = slot || (booking && booking.slotId) || null;
  const { date, time } = slotParts(useSlot);
  const service = plainText(booking && booking.serviceId && booking.serviceId.name, ITEM_NAME_MAX);
  const first = usableName(booking && booking.customerName);
  return {
    name: first || fallbackName(),
    service: service || catalog.t('ar', 'flows.fallbackService'),
    date,
    time,
    slot: date || time ? `${date} ${time}`.trim() : catalog.t('ar', 'senders.slotFallback'),
  };
}

// Same values, with the REVIEWED Arabic service name when one exists (decision G2: the shopping journey already shows it, so a booking
// notice must not switch back to the English name mid-conversation). Never throws: any problem keeps the English name.
async function bookingNoticeValuesAsync(booking, slot, deps = realDeps()) {
  const result = bookingNoticeValues(booking, slot);
  try {
    const serviceId = booking && booking.serviceId && booking.serviceId._id ? String(booking.serviceId._id) : null;
    const workspaceId = booking && booking.workspaceId ? String(booking.workspaceId) : null;
    if (serviceId && workspaceId) {
      const names = await deps.catalogTranslations.resolveItemNames({ workspaceId, kind: 'service', ids: [serviceId], language: 'ar' });
      const name = plainText(names.get(serviceId.toLowerCase()) || names.get(serviceId), ITEM_NAME_MAX);
      if (name) result.service = name;
    }
  } catch (err) { /* the English service name stays */ }
  return result;
}

// The lines of the order summary: "1. <name> — 45.00 ر.س" with the REVIEWED Arabic product name when there is one.
// `items` = the createOrder input [{ productId, quantity }] (cartItems repeat a product `quantity` times, in order);
// `cartItems` = [{ name, priceAud }]. Anything that cannot be resolved keeps the English name.
async function orderItemLines(deps, { workspaceId, items, cartItems, currency }) {
  const ids = [];
  for (const entry of Array.isArray(items) ? items : []) {
    const quantity = Number.isInteger(entry && entry.quantity) && entry.quantity > 0 ? entry.quantity : 1;
    for (let i = 0; i < quantity; i += 1) ids.push(entry && entry.productId ? String(entry.productId) : null);
  }
  let arabic = new Map();
  try {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (unique.length && workspaceId) arabic = await deps.catalogTranslations.resolveItemNames({ workspaceId, kind: 'product', ids: unique, language: 'ar' });
  } catch (err) { arabic = new Map(); }
  return cartItems.map((item, i) => {
    const id = ids[i];
    const name = plainText((id && (arabic.get(String(id).toLowerCase()) || arabic.get(String(id)))) || item.name, ITEM_NAME_MAX);
    return `${i + 1}. ${name} — ${formatMoney(item.priceAud, currency, 'ar')}`;
  });
}

// values of senders.orderSummary. The lines are joined with real line breaks (utilitySend keeps them).
async function orderSummaryValues(args, deps = realDeps()) {
  const { workspaceId, items, cartItems, subtotal, shipping, total, currency, address, link } = args;
  const lines = await orderItemLines(deps, { workspaceId, items, cartItems, currency });
  return {
    items: lines.join('\n'),
    subtotal: formatMoney(subtotal, currency, 'ar'),
    shipping: formatMoney(shipping, currency, 'ar'),
    total: formatMoney(total, currency, 'ar'),
    address: plainText(address, 300),
    link: `${link}${String(link).includes('?') ? '&' : '?'}lang=ar`,
  };
}

function realDeps() {
  return {
    get catalogTranslations() { return require('./catalogTranslations'); },
    get Product() { return require('../../models/Product'); },
    get Service() { return require('../../models/Service'); },
  };
}

module.exports = {
  SENDER_FIELDS, plainText, usableName, nameValue, fullNameValue, pointsNumber, pointsValue, amountValue, formatMoney, formatDate,
  loadPromotionItems, promotionValues, valuesFor, unfillableFields, bookingNoticeValues, bookingNoticeValuesAsync, orderItemLines, orderSummaryValues, realDeps,
};
