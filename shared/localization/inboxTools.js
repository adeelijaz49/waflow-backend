'use strict';
// Inbox tools for the Arabic localisation feature (spec §5) — the service behind
// routes/localization/inbox.js. Everything here is additive: the existing
// /api/inbox routes and shared/inbox.js are untouched, and are only CALLED
// (listConversations, sendManualMessage) through their exported functions.
//
//  1. Arabic-aware conversation search. The existing search drops the raw query
//     into an unescaped $regex over firstname/lastname/phone (a "(" or "+966"
//     makes it a malformed pattern, and nothing is normalised — audit R6 §1.3),
//     so `search` is NEVER passed to it. We call listConversations WITHOUT
//     search and filter the rows here, in JS, on normalised text: diacritics,
//     tatweel, alef/ya/teh-marbuta variants and Arabic-Indic/Persian digits fold
//     together. The query is data, never a pattern. Tokens are ANDed (so
//     "سارة أحمد" finds a customer whose first and last names are stored in
//     separate fields); a token matches the name, the last-message preview or —
//     for numbers — the phone digits. Phone-like tokens (>= 5 digits) also match
//     without the local trunk zero (05… typed, 9665… stored) and ignore "+",
//     "00", spaces, dashes and brackets.
//  2. The customer-language context (customer -> merchant default -> English).
//  3. "Send payment link" in the customer's language: a Stripe PaymentIntent
//     created exactly like shared/inbox.js#sendPaymentLink (same metadata keys,
//     so the Stripe webhook and /pay page treat it identically), sent through the
//     existing sendManualMessage with the text taken from catalog/inbox.json.
//  4. "Send loyalty reminder" in the customer's language: the workspace's
//     approved loyalty_reminder template variant, sent to this ONE customer by
//     the campaign sender (campaigns.sendSingle). Never a silent language
//     fallback: no usable variant in the customer's language -> a structured
//     "no_approved_variant" answer and the UI offers the existing English
//     reminder explicitly.
//
// Safety decisions:
//  * workspaceId comes only from the verified session; the existing inbox
//    helpers silently drop the tenant filter when it is falsy, so it is
//    required (and shape-checked) here before anything is called.
//  * Demo and erased customers are invisible to the inbox list, so they are
//    "not found" for every action here too (the existing send path would
//    message them).
//  * Marketing consent (shared/consent.js#canSendMarketing) gates the loyalty
//    reminder before any template is even looked at.
//  * LOCALIZATION_SEND_MODE=dry_run is honoured: no Stripe call and no WhatsApp
//    send (the text goes to transport's dry-run buffer instead). The existing
//    sendManualMessage talks to Meta directly, so without this a local
//    "dry run" would have sent a real message.
//  * Currency: read per workspace (Settings is per workspace; the existing
//    cache reads the first document of ANY tenant). Missing -> AUD, the
//    existing default. Stripe amounts are cents (x100) everywhere in this
//    codebase (webhook, /pay page), which is wrong for zero- and three-decimal
//    currencies, so those are refused rather than silently mispriced.
//  * One in-flight request per (customer, action): a double click cannot
//    create two payment links or send two reminders at once.
//  * Upstream failures (Stripe, Meta, anything unexpected) become sanitised
//    { error, code } answers; no upstream text or stack ever reaches a client.
//  * Nothing here deletes anything.
//
// shared/inbox.js, shared/consent.js and ./campaigns are required lazily
// (inside realDeps): shared/inbox.js builds a Stripe client at import time,
// which throws without STRIPE_SECRET_KEY, and this file must stay require-safe
// so routes/localization can always load. Every collaborator is injectable.
const { normalizeArabic, normalizeForMatch, toWesternDigits } = require('./arabicText');
const { resolveLanguage } = require('./languageDetect');
const { pickVariant } = require('./variantSelection');
const { extractFields, sanitizeValue } = require('./mergeFields');
const { isObjectIdLike } = require('./scope');
const { money } = require('../../utils/currency');

const FILTERS = Object.freeze(['all', 'unread', 'high-value', 'inactive', 'recent', 'booking']);
const LANGUAGE_SOURCES = Object.freeze(['merchant_set', 'csv_import', 'inferred', 'customer_chose']);
const MAX_SEARCH_LENGTH = 200;
const MIN_PHONE_DIGITS = 5;
const MIN_COMPACT_LENGTH = 3;
const MAX_AMOUNT_CENTS = 100000000; // 1,000,000.00
const MAX_AMOUNT_TEXT = 32;
const DEFAULT_CURRENCY = 'AUD';
const DRY_RUN_PAYMENT_INTENT = 'pi_dry_run';
const PAYMENT_LINK_KEY = 'inbox.paymentLink';
const LOCK_TTL_MS = 60 * 1000;
const MAX_FIELD_VALUES = 30;
const MAX_FIELD_VALUE_LENGTH = 500;
// Merge fields the campaign sender fills per customer on its own (CONTRACT §2
// Campaigns); every other field needs a merchant-supplied value.
const AUTO_FILLED_FIELDS = Object.freeze(['name', 'full_name', 'points', 'business']);
// Stripe expresses these as 0 or 3 decimals; the rest of this codebase assumes x100.
const NOT_TWO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
  'BHD', 'JOD', 'KWD', 'OMR', 'TND',
]);
const CUSTOMER_FIELDS = 'phone marketingConsent optedOut loyaltyPoints';

// ── Errors ────────────────────────────────────────────────────────────────

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.expose = true; // safe to show: created here with a contract code
  return err;
}

const defaultLog = (...args) => console.error('[localization]', ...args);

// Anything not created by fail() is unexpected: log the real reason, answer
// with a generic INTERNAL (the route's handler() would otherwise echo err.code,
// which for Mongo/axios errors is an internal detail).
function toApiError(err, log = defaultLog) {
  if (err && err.expose === true) return err;
  log('inbox request failed:', err && err.message);
  return fail(500, 'INTERNAL', 'Something went wrong');
}

function requireWorkspace(workspaceId) {
  if (!isObjectIdLike(workspaceId)) throw fail(403, 'FORBIDDEN', 'No workspace in this session');
  return String(workspaceId);
}

function assertId(value, label) {
  if (!isObjectIdLike(value)) throw fail(400, 'INVALID_ID', `Invalid ${label}`);
  return String(value);
}

function validUserId(value) {
  return isObjectIdLike(value) ? String(value) : undefined;
}

// ── Search ────────────────────────────────────────────────────────────────

// Like normalizeForMatch but keeps punctuation/emoji, for tokens that would
// otherwise vanish (an emoji-only or "(" query is matched literally, not dropped).
function fold(value) {
  return normalizeArabic(value).toLowerCase();
}

function digitsOf(value) {
  return toWesternDigits(value === undefined || value === null ? '' : value).replace(/\D/g, '');
}

// A number typed by a person: "+966 50…", "0966…", "0501234567". Phone-like
// (>= 5 digits once a leading 00 is dropped) numbers match the stored phone
// with and without the local trunk zero; shorter ones ("4567") match literally.
// `text` is the same token as text, for names and previews that contain it.
function numericToken(digits, text) {
  const core = digits.replace(/^00/, '');
  if (core.length < MIN_PHONE_DIGITS) return { phone: [digits], text };
  const phone = [core];
  if (core.startsWith('0')) phone.push(core.slice(1));
  return { phone, text };
}

function compileToken(token) {
  const stripped = token.replace(/[+\-().]/g, '');
  if (/^\d+$/.test(stripped)) return numericToken(stripped, normalizeForMatch(token));
  const text = normalizeForMatch(token);
  if (text) return { text, compact: text.replace(/ /g, '') };
  return { literal: token };
}

// term (the query string) -> { tokens, needsFold } | null (null = no filtering).
function buildSearch(term) {
  if (term === undefined || term === null) return null;
  if (typeof term !== 'string') throw fail(400, 'INVALID_INPUT', 'search must be a string');
  if (term.length > MAX_SEARCH_LENGTH) throw fail(400, 'INVALID_INPUT', `search is too long (max ${MAX_SEARCH_LENGTH} characters)`);
  const folded = fold(term).trim();
  if (!folded) return null;
  // "+966 50 123 4567" is one phone number, not four tokens.
  const compact = folded.replace(/[\s+\-().]/g, '');
  const wholeNumber = /^[\d\s+\-().]+$/.test(folded) && /^\d+$/.test(compact)
    && compact.replace(/^00/, '').length >= MIN_PHONE_DIGITS;
  const tokens = wholeNumber
    ? [numericToken(compact, normalizeForMatch(folded))]
    : folded.split(/\s+/).map(compileToken);
  return { tokens, needsFold: tokens.some((token) => token.literal !== undefined) };
}

function textOf(value) {
  return value === undefined || value === null ? '' : String(value);
}

function indexRow(row, needsFold) {
  const name = textOf(row && row.name);
  const preview = textOf(row && row.lastMessagePreview);
  return {
    phone: digitsOf(row && row.phone),
    name: normalizeForMatch(name),
    preview: normalizeForMatch(preview),
    nameFold: needsFold ? fold(name) : '',
    previewFold: needsFold ? fold(preview) : '',
  };
}

function tokenMatches(token, h) {
  if (token.phone) {
    return token.phone.some((v) => h.phone.includes(v)) || h.name.includes(token.text) || h.preview.includes(token.text);
  }
  if (token.literal !== undefined) return h.nameFold.includes(token.literal) || h.previewFold.includes(token.literal);
  // Compound names are written both ways ("عبد الله" / "عبدالله"): a longer
  // token may also match the name with its spaces removed.
  return h.name.includes(token.text) || h.preview.includes(token.text)
    || (token.compact.length >= MIN_COMPACT_LENGTH && h.name.replace(/ /g, '').includes(token.compact));
}

// row: an InboxConversation-like { name, phone, lastMessagePreview }.
function matchesSearch(search, row) {
  if (!search) return true;
  const h = indexRow(row, search.needsFold);
  return search.tokens.every((token) => tokenMatches(token, h));
}

// ── Customer + language lookups ───────────────────────────────────────────

function languageFor(languages, customerId) {
  const language = languages.get(String(customerId));
  return language === 'en' || language === 'ar' ? language : 'unknown';
}

// ONE query for the whole result set (never one per row).
async function loadLanguages(deps, workspaceId, rows) {
  const ids = rows.map((row) => row.customerId).filter((id) => id !== undefined && id !== null);
  if (!ids.length) return new Map();
  const docs = await deps.CustomerLanguage.find({ workspaceId, customerId: { $in: ids } }).select('customerId language').lean();
  return new Map(docs.map((doc) => [String(doc.customerId), doc.language]));
}

// Same visibility as the inbox list: not erased, not demo, this workspace only.
async function findCustomer(deps, workspaceId, customerId) {
  const customer = await deps.Customer.findOne({
    _id: customerId, workspaceId, deletedAt: { $exists: false }, isDemo: { $ne: true },
  }).select(CUSTOMER_FIELDS).lean();
  if (!customer) throw fail(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
  return customer;
}

async function languageOf(deps, workspaceId, customerId) {
  const [doc, merchantDefault] = await Promise.all([
    deps.CustomerLanguage.findOne({ workspaceId, customerId }).select('language languageSource').lean(),
    deps.getMerchantDefault(workspaceId),
  ]);
  const language = doc && (doc.language === 'en' || doc.language === 'ar') ? doc.language : 'unknown';
  const languageSource = doc && LANGUAGE_SOURCES.includes(doc.languageSource) ? doc.languageSource : null;
  return { language, languageSource, effectiveLanguage: resolveLanguage(language, merchantDefault) };
}

// One in-flight request per key; a stale entry expires on its own.
function createLocks(ttlMs = LOCK_TTL_MS, now = Date.now) {
  const held = new Map();
  return {
    acquire(key) {
      const until = held.get(key);
      if (until !== undefined && until > now()) return false;
      held.set(key, now() + ttlMs);
      return true;
    },
    release(key) { held.delete(key); },
  };
}

async function withLock(deps, key, work) {
  if (!deps.locks.acquire(key)) throw fail(429, 'RATE_LIMITED', 'Another request for this customer is already in progress');
  try {
    return await work();
  } finally {
    deps.locks.release(key);
  }
}

// ── 1. Conversations ──────────────────────────────────────────────────────

// -> { conversations: InboxConversation[] }: the existing envelope + `language`.
async function searchConversations({ workspaceId, filter, search } = {}, deps = getDeps()) {
  const ws = requireWorkspace(workspaceId);
  const compiled = buildSearch(search);
  const listFilter = filter !== 'all' && FILTERS.includes(filter) ? filter : undefined;
  // Deliberately no `search`: see the header comment.
  const { conversations } = await deps.listConversations({ workspaceId: ws, filter: listFilter });
  const rows = compiled ? conversations.filter((row) => matchesSearch(compiled, row)) : conversations;
  const languages = await loadLanguages(deps, ws, rows);
  return { conversations: rows.map((row) => ({ ...row, language: languageFor(languages, row.customerId) })) };
}

// ── 2. Context ────────────────────────────────────────────────────────────

// -> InboxContext
async function getContext({ workspaceId, customerId } = {}, deps = getDeps()) {
  const ws = requireWorkspace(workspaceId);
  const id = assertId(customerId, 'customerId');
  await findCustomer(deps, ws, id);
  return { customerId: id, ...(await languageOf(deps, ws, id)) };
}

// ── 3. Payment link ───────────────────────────────────────────────────────

// An amount typed by staff: a finite number, or a decimal string (Arabic-Indic
// digits and the Arabic decimal separator are accepted). 0.01 .. 1,000,000.00
// with at most two decimals -> integer cents.
function parseAmount(raw) {
  const invalid = () => fail(400, 'INVALID_AMOUNT', 'Enter a valid amount');
  let value = raw;
  if (typeof value === 'string') {
    const text = normalizeArabic(value).trim();
    if (text.length > MAX_AMOUNT_TEXT || !/^(?:\d+\.?\d*|\.\d+)$/.test(text)) throw invalid();
    value = Number(text);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid();
  const cents = Math.round(value * 100);
  if (cents < 1 || cents > MAX_AMOUNT_CENTS || Math.abs(cents / 100 - value) > 1e-9) throw invalid();
  return cents;
}

function stripeUnavailable() {
  return fail(503, 'STRIPE_UNAVAILABLE', 'Payments are not available right now');
}

async function resolveCurrency(deps, workspaceId) {
  const doc = await deps.Settings.findOne({ workspaceId }).select('currency').lean();
  const stored = doc && typeof doc.currency === 'string' ? doc.currency.trim() : '';
  const code = (stored || DEFAULT_CURRENCY).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || NOT_TWO_DECIMAL.has(code)) {
    deps.log('inbox payment link: unsupported currency setting', code);
    throw stripeUnavailable();
  }
  return code;
}

function stripeFailure(deps, err) {
  deps.log('inbox payment link: Stripe error', err && err.type, err && err.code);
  if (err && (err.code === 'amount_too_small' || err.code === 'amount_too_large')) {
    return fail(400, 'INVALID_AMOUNT', 'That amount is outside what the payment provider accepts');
  }
  return stripeUnavailable();
}

// Same call, same metadata keys as shared/inbox.js#sendPaymentLink (including the workspaceId the Stripe webhook attributes the
// payment to).
async function createPaymentIntent(deps, stripe, { cents, currency, phone, workspaceId }) {
  try {
    const intent = await stripe.paymentIntents.create({
      amount: cents,
      currency: currency.toLowerCase(),
      automatic_payment_methods: { enabled: true },
      metadata: { buyerPhone: phone, source: 'inbox_manual_payment_link', ...(workspaceId ? { workspaceId: String(workspaceId) } : {}) },
    });
    if (!intent || typeof intent.id !== 'string' || !intent.id) throw new Error('no payment intent id returned');
    return intent.id;
  } catch (err) {
    throw stripeFailure(deps, err);
  }
}

function paymentLinkBody(deps, { language, cents, currency, paymentIntentId }) {
  const base = String(deps.appUrl).replace(/\/+$/, '');
  const link = `${base}/pay/${paymentIntentId}${language === 'ar' ? '?lang=ar' : ''}`;
  return deps.catalog.t(language, PAYMENT_LINK_KEY, { amount: money(cents / 100, currency), link });
}

function sendFailure(deps, err) {
  if (err && err.message === 'Customer not found') return fail(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
  const upstream = err && err.response;
  deps.log('inbox send failed:', err && err.message, upstream && upstream.status, upstream && upstream.data && upstream.data.error && upstream.data.error.code);
  if (err && (err.isAxiosError || upstream)) return fail(502, 'META_ERROR', 'WhatsApp could not send the message');
  return fail(500, 'INTERNAL', 'Something went wrong');
}

function idOf(doc) {
  const id = doc && (doc._id || doc.id);
  return id ? String(id) : undefined;
}

async function deliverPaymentLink(deps, { dryRun, workspaceId, customerId, customer, body, performedBy }) {
  if (dryRun) {
    const result = await deps.transport.sendText(customer.phone, body);
    return { sent: true, messageId: deps.transport.extractWamid(result) };
  }
  try {
    const saved = await deps.sendManualMessage({ customerId, workspaceId, body, performedBy: validUserId(performedBy), messageType: 'payment' });
    return { sent: true, messageId: idOf(saved) };
  } catch (err) {
    throw sendFailure(deps, err);
  }
}

// -> InboxActionResult { sent: true, messageId }
async function sendPaymentLink({ workspaceId, customerId, amount, performedBy } = {}, deps = getDeps()) {
  const ws = requireWorkspace(workspaceId);
  const id = assertId(customerId, 'customerId');
  const cents = parseAmount(amount);
  // A missing catalogue entry would make t() return the KEY: never send that to
  // a customer — and check before a PaymentIntent exists, not after.
  if (!deps.catalog.has(PAYMENT_LINK_KEY)) throw fail(500, 'INTERNAL', 'Something went wrong');
  const customer = await findCustomer(deps, ws, id);
  const dryRun = deps.transport.isDryRun();
  const stripe = dryRun ? null : deps.getStripe();
  if (!dryRun && !stripe) throw stripeUnavailable();

  return withLock(deps, `payment:${ws}:${id}`, async () => {
    const [{ effectiveLanguage }, currency] = await Promise.all([languageOf(deps, ws, id), resolveCurrency(deps, ws)]);
    const paymentIntentId = dryRun ? DRY_RUN_PAYMENT_INTENT : await createPaymentIntent(deps, stripe, { cents, currency, phone: customer.phone, workspaceId: ws });
    const body = paymentLinkBody(deps, { language: effectiveLanguage, cents, currency, paymentIntentId });
    return deliverPaymentLink(deps, { dryRun, workspaceId: ws, customerId: id, customer, body, performedBy });
  });
}

// ── 4. Loyalty reminder ───────────────────────────────────────────────────

const NO_CONSENT = Object.freeze({ sent: false, reason: 'no_consent', fallbackAvailable: false });
const NO_POINTS = Object.freeze({ sent: false, reason: 'no_points', fallbackAvailable: false });
const NO_APPROVED_VARIANT = Object.freeze({ sent: false, reason: 'no_approved_variant', fallbackAvailable: true });

// Optional merchant-supplied values for merge fields the sender cannot fill
// itself (e.g. {date}). A client can never override the per-customer fields.
function parseFieldValues(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw fail(400, 'INVALID_INPUT', 'fieldValues must be an object');
  const entries = Object.entries(raw);
  if (entries.length > MAX_FIELD_VALUES) throw fail(400, 'INVALID_INPUT', `fieldValues may contain at most ${MAX_FIELD_VALUES} entries`);
  const out = {};
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw fail(400, 'INVALID_INPUT', 'fieldValues has an invalid field name');
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) throw fail(400, 'INVALID_INPUT', `fieldValues.${key} must be text`);
    const text = sanitizeValue(value);
    if (!text || text.length > MAX_FIELD_VALUE_LENGTH) throw fail(400, 'INVALID_INPUT', `fieldValues.${key} must be 1-${MAX_FIELD_VALUE_LENGTH} characters`);
    if (!AUTO_FILLED_FIELDS.includes(key)) out[key] = text;
  }
  return out;
}

function timeOf(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function newestFirst(a, b) {
  return timeOf(b.updatedAt) - timeOf(a.updatedAt) || String(b._id).localeCompare(String(a._id));
}

function missingFields(variant, supplied) {
  return extractFields(`${variant.header || ''}\n${variant.body || ''}`)
    .filter((field) => !AUTO_FILLED_FIELDS.includes(field) && !Object.prototype.hasOwnProperty.call(supplied, field));
}

// The most recently updated standalone loyalty_reminder template whose variant
// in `language` is sendable (APPROVED, and natively reviewed for Arabic) and
// needs no value we cannot supply. Explicit single-language mode: no fallback.
// Sorted here, not by the database: Cosmos DB needs an index for every sort.
async function chooseTemplate(deps, workspaceId, language, supplied) {
  const docs = await deps.LocalizedTemplate.find({ workspaceId, useCase: 'loyalty_reminder', archived: { $ne: true } }).lean();
  const usable = docs
    .filter((template) => !template.linkedMessageNodeId) // flow messages are not standalone reminders
    .sort(newestFirst)
    .map((template) => ({ template, variant: pickVariant(template, { languageMode: language }).variant }))
    .filter((candidate) => candidate.variant);
  let needs = null;
  for (const { template, variant } of usable) {
    const missing = missingFields(variant, supplied);
    if (!missing.length) return { template };
    needs = needs || missing;
  }
  return { template: null, needs };
}

// Only a short machine reason is ever logged; free text from a sender may carry
// a phone number or upstream detail.
function loggableReason(reason) {
  return /^[a-z0-9_]{1,60}$/.test(reason) ? reason : 'other';
}

// What campaigns.sendSingle answers -> InboxActionResult (or an error).
function toReminderResult(deps, outcome) {
  if (outcome && outcome.sent === true) {
    const messageId = outcome.messageId || outcome.wamid;
    return messageId ? { sent: true, messageId: String(messageId) } : { sent: true };
  }
  const status = outcome && outcome.status;
  const reason = String((outcome && outcome.reason) || '');
  if (status === 'skipped_no_consent' || status === 'skipped_opted_out' || reason === 'no_consent' || reason === 'opted_out') return NO_CONSENT;
  if (status === 'skipped_blocked' || reason === 'no_usable_variant' || /^(?:en|ar)_/.test(reason)) return NO_APPROVED_VARIANT;
  deps.log('inbox loyalty reminder not sent:', loggableReason(String(status)), loggableReason(reason));
  throw fail(502, 'META_ERROR', 'WhatsApp could not send the message');
}

// Contract errors the sender may throw, re-created with fixed text (never the
// sender's own message, which may carry upstream detail).
const SENDER_ERRORS = Object.freeze({
  FIELD_VALUES_MISSING: 'Some message fields have no value',
  META_ERROR: 'WhatsApp could not send the message',
  META_NOT_CONFIGURED: 'WhatsApp is not connected for this workspace',
  CUSTOMER_NOT_FOUND: 'Customer not found',
  TEMPLATE_NOT_FOUND: 'Template not found',
});

function reminderFailure(deps, err) {
  const code = err && err.code;
  if (Object.prototype.hasOwnProperty.call(SENDER_ERRORS, code) && Number.isInteger(err.status)) return fail(err.status, code, SENDER_ERRORS[code]);
  deps.log('inbox loyalty reminder failed:', err && err.message);
  return fail(500, 'INTERNAL', 'Something went wrong');
}

// -> InboxActionResult. Not sent (HTTP 200) with a reason the UI understands:
//   no_consent / no_points -> fallbackAvailable false; no_approved_variant -> the
//   existing English reminder can be offered (explicitly, with a confirm).
async function sendLoyaltyReminder({ workspaceId, customerId, performedBy, fieldValues } = {}, deps = getDeps()) {
  const ws = requireWorkspace(workspaceId);
  const id = assertId(customerId, 'customerId');
  const supplied = parseFieldValues(fieldValues);
  const customer = await findCustomer(deps, ws, id);
  if (!deps.canSendMarketing(customer)) return NO_CONSENT;
  if (!(customer.loyaltyPoints > 0)) return NO_POINTS;

  return withLock(deps, `loyalty:${ws}:${id}`, async () => {
    const { effectiveLanguage } = await languageOf(deps, ws, id);
    const { template, needs } = await chooseTemplate(deps, ws, effectiveLanguage, supplied);
    if (!template) {
      if (needs) throw fail(422, 'FIELD_VALUES_MISSING', `This template needs a value for: ${needs.join(', ')}`);
      return NO_APPROVED_VARIANT;
    }
    let outcome;
    try {
      outcome = await deps.sendSingle({
        workspaceId: ws, templateId: String(template._id), customerId: id, fieldValues: supplied,
        languageMode: effectiveLanguage, createdBy: validUserId(performedBy),
      });
    } catch (err) {
      if (err && (err.code === 'TEMPLATE_UNUSABLE' || err.code === 'NOTHING_TO_SEND')) return NO_APPROVED_VARIANT;
      throw reminderFailure(deps, err);
    }
    return toReminderResult(deps, outcome);
  });
}

// ── Collaborators ─────────────────────────────────────────────────────────

let stripeCache = null;

// Lazy: no Stripe client (and no `stripe` require) until a payment link is
// actually sent; null when the key is not configured.
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!stripeCache || stripeCache.key !== key) {
    const Stripe = require('stripe');
    stripeCache = { key, client: new Stripe(key) };
  }
  return stripeCache.client;
}

const sharedLocks = createLocks();

function realDeps() {
  const inbox = () => require('../inbox');
  return {
    Customer: require('../../models/Customer'),
    CustomerLanguage: require('../../models/CustomerLanguage'),
    LocalizedTemplate: require('../../models/LocalizedTemplate'),
    Settings: require('../../models/Settings'),
    transport: require('./transport'),
    catalog: require('./catalog'),
    appUrl: require('../../utils/config').APP_URL,
    locks: sharedLocks,
    log: defaultLog,
    getStripe,
    getMerchantDefault: async (workspaceId) => (await require('./settings').getSettings(workspaceId)).defaultCustomerLanguage,
    listConversations: (args) => inbox().listConversations(args),
    sendManualMessage: (args) => inbox().sendManualMessage(args),
    canSendMarketing: (customer) => require('../consent').canSendMarketing(customer),
    sendSingle: (args) => require('./campaigns').sendSingle(args),
  };
}

let cachedDeps = null;
function getDeps() {
  if (!cachedDeps) cachedDeps = realDeps();
  return cachedDeps;
}

module.exports = {
  FILTERS,
  AUTO_FILLED_FIELDS,
  MAX_SEARCH_LENGTH,
  MAX_AMOUNT_CENTS,
  buildSearch,
  matchesSearch,
  parseAmount,
  parseFieldValues,
  createLocks,
  toApiError,
  searchConversations,
  getContext,
  sendPaymentLink,
  sendLoyaltyReminder,
  realDeps,
};
