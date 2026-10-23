'use strict';
// Stripe adapter of the onboarding flow (DB design 4.2, 4.9). Everything that knows the SHAPE of a
// Stripe object lives here, behind small tolerant readers, so a change of the Stripe API version
// ("basil": period end moved onto the subscription items, invoice -> subscription link moved into
// invoice.parent) cannot silently break the webhook. Pure functions + a lazily created client:
// nothing runs at require time and every external effect is injectable (`stripe`).
const config = require('./config');
const subscription = require('./subscription');
const { OnbError } = require('./errors');

/** metadata.waflow_purpose value that marks a Checkout Session / Subscription as OURS (merchant billing). */
const PURPOSE = 'merchant_subscription';
/** Raw Stripe statuses after which a subscription never comes back. */
const TERMINAL_STATUSES = Object.freeze(['canceled', 'incomplete_expired']);

const ID_CHARS = /^[A-Za-z0-9_]{1,200}$/;

/**
 * Map a raw Stripe subscription status to our state (DB 4.2). Delegates to B0's pure table.
 * @param {string} status raw Stripe status
 * @param {{hasDefaultPaymentMethod?:boolean, acceptTrialing?:boolean}} [ctx]
 * @returns {{state:string|null, reason?:string}} state null = unknown status (never guess)
 */
function mapStripeStatus(status, ctx) {
  return subscription.mapRawStatus(status, ctx || {});
}

/** A Stripe id that may be a string or an expanded object ({ id }). Returns null for anything else. */
function idOf(value) {
  const v = value && typeof value === 'object' ? value.id : value;
  return typeof v === 'string' && ID_CHARS.test(v) ? v : null;
}

function secToDate(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Current period end of a subscription. Tolerant of both API shapes: before 2025-03-31.basil it is
 * `subscription.current_period_end`; from basil on it lives on each item (`items.data[i].current_period_end`).
 * With several items the LATEST item end is used. UNVERIFIED against a live basil account: see the report.
 * @param {object} sub Stripe subscription object
 * @returns {Date|null}
 */
function readPeriodEnd(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const direct = secToDate(sub.current_period_end);
  if (direct) return direct;
  const items = sub.items && Array.isArray(sub.items.data) ? sub.items.data : [];
  let best = null;
  for (const it of items) {
    const d = it && secToDate(it.current_period_end);
    if (d && (!best || d > best)) best = d;
  }
  return best;
}

/**
 * The subscription id an invoice belongs to. Current API: `invoice.parent.subscription_details.subscription`
 * ('basil' and later); before that `invoice.subscription`. The id may be a string or an expanded object.
 * Falls back to the first line item's parent (basil) so a partial payload still resolves.
 * @param {object} invoice Stripe invoice object
 * @returns {string|null}
 */
function readSubscriptionIdFromInvoice(invoice) {
  if (!invoice || typeof invoice !== 'object') return null;
  const parent = invoice.parent && invoice.parent.subscription_details;
  const fromParent = idOf(parent && parent.subscription);
  if (fromParent) return fromParent;
  const legacy = idOf(invoice.subscription);
  if (legacy) return legacy;
  const line = invoice.lines && Array.isArray(invoice.lines.data) ? invoice.lines.data[0] : null;
  const lineParent = line && line.parent && line.parent.subscription_item_details;
  const fromLine = idOf(lineParent && lineParent.subscription);
  if (fromLine) return fromLine;
  const lineLegacy = idOf(line && line.subscription);
  return lineLegacy || null;
}

/** Customer id of a subscription / invoice / checkout session (string or expanded). */
function readCustomerId(obj) {
  return obj && typeof obj === 'object' ? idOf(obj.customer) : null;
}

/** Price id of the first subscription item. */
function readPriceId(sub) {
  const items = sub && sub.items && Array.isArray(sub.items.data) ? sub.items.data : [];
  const price = items[0] && items[0].price;
  return idOf(price) || null;
}

/** True when the subscription (or, defensively, its expanded customer's invoice settings) carries a default payment method. */
function hasDefaultPaymentMethod(sub) {
  if (!sub || typeof sub !== 'object') return false;
  if (idOf(sub.default_payment_method)) return true;
  const c = sub.customer;
  const inv = c && typeof c === 'object' ? c.invoice_settings : null;
  return !!(inv && idOf(inv.default_payment_method));
}

// control characters and bidi controls (written with \x and \u{...} escapes only)
const CONTROL_CHARS = /[\x00-\x1f\x7f\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;
function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A syntactically valid e-mail (<= 200 chars) or null. Never returns a phone number. */
function cleanEmail(value) {
  const s = cleanText(value, 200);
  return s && EMAIL_RE.test(s) ? s : null;
}
function cleanPlanCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value.trim()) ? value.trim() : null;
}

/**
 * Step-1 pre-fill captured from a Checkout Session (DB 4.9 step 5, spec 1b.6): `customer_details.email`
 * (else `customer_email`), the `business_name` custom field (`custom_fields[].text.value`), and our own
 * `metadata.planCode`. The `customer_details.business_name` / `collected_information.business_name` paths
 * are UNVERIFIED alternatives for `name_collection.business` and are read only when present.
 * @param {object} session Stripe checkout.session object
 * @returns {{email:string|null, businessName:string|null, planCode:string|null}}
 */
function extractPrefill(session) {
  const s = session && typeof session === 'object' ? session : {};
  const details = s.customer_details && typeof s.customer_details === 'object' ? s.customer_details : {};
  const fields = Array.isArray(s.custom_fields) ? s.custom_fields : [];
  const bn = fields.find((f) => f && f.key === 'business_name');
  const collected = s.collected_information && typeof s.collected_information === 'object' ? s.collected_information : {};
  const businessName = cleanText(bn && bn.text && bn.text.value, 80)
    || cleanText(details.business_name, 80)
    || cleanText(collected.business_name, 80);
  const email = cleanEmail(details.email) || cleanEmail(s.customer_email);
  const planCode = cleanPlanCode(s.metadata && s.metadata.planCode);
  return { email, businessName, planCode };
}

let cachedClient = null;
/**
 * The Stripe client: `deps.stripe` (tests) or a lazily created one from config.stripeSecretKey().
 * @param {{stripe?:object}} [deps]
 * @returns {object}
 * @throws {OnbError} CHECKOUT_NOT_CONFIGURED when no secret key is configured
 */
function getStripeClient(deps) {
  if (deps && deps.stripe) return deps.stripe;
  const key = config.stripeSecretKey();
  if (!key) throw new OnbError('CHECKOUT_NOT_CONFIGURED');
  if (cachedClient && cachedClient.key === key) return cachedClient.client;
  const Stripe = require('stripe');
  const client = new Stripe(key, { maxNetworkRetries: 1, timeout: 15000, telemetry: false });
  cachedClient = { key, client };
  return client;
}

class WebhookSignatureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebhookSignatureError';
    this.code = code;
  }
}

/**
 * Verify a webhook delivery against EVERY configured secret (rolling secrets: current + previous).
 * Needs the RAW body (Buffer or string), the `Stripe-Signature` header and the endpoint secrets.
 * @param {Buffer|string} rawBody
 * @param {string} signature value of the Stripe-Signature header
 * @param {{secrets?:string[], stripe?:object}} [opts]
 * @returns {object} the verified Stripe event
 * @throws {WebhookSignatureError} code WEBHOOK_SECRET_MISSING | WEBHOOK_BODY_INVALID | WEBHOOK_SIGNATURE_MISSING | WEBHOOK_SIGNATURE_INVALID
 */
function verifyEvent(rawBody, signature, opts = {}) {
  const secrets = (Array.isArray(opts.secrets) ? opts.secrets : []).filter((s) => typeof s === 'string' && s !== '');
  if (!secrets.length) throw new WebhookSignatureError('WEBHOOK_SECRET_MISSING', 'No webhook secret is configured');
  if (!(Buffer.isBuffer(rawBody) || typeof rawBody === 'string') || rawBody.length === 0) {
    throw new WebhookSignatureError('WEBHOOK_BODY_INVALID', 'The webhook body must be the raw request body');
  }
  if (typeof signature !== 'string' || signature.trim() === '') {
    throw new WebhookSignatureError('WEBHOOK_SIGNATURE_MISSING', 'Missing signature header');
  }
  const webhooks = (opts.stripe && opts.stripe.webhooks) || require('stripe').webhooks;
  for (const secret of secrets) {
    try {
      const event = webhooks.constructEvent(rawBody, signature, secret);
      if (event && typeof event === 'object') return event;
    } catch (_) { /* try the next secret */ }
  }
  throw new WebhookSignatureError('WEBHOOK_SIGNATURE_INVALID', 'Signature verification failed');
}

/**
 * Checkout Session parameters exactly as DB 4.9. The price id is passed in by the CALLER from
 * config.stripePrices() (never from a client request).
 * @param {{workspaceId:string, planCode:string, priceId:string, email?:string|null}} args
 * @returns {object}
 */
function buildCheckoutParams({ workspaceId, planCode, priceId, email } = {}) {
  const ws = String(workspaceId || '');
  const meta = { workspaceId: ws, planCode: String(planCode || ''), waflow_purpose: PURPOSE };
  const base = config.frontendUrl();
  const params = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: ws,
    metadata: { ...meta },
    subscription_data: { metadata: { ...meta } },
    custom_fields: [{ key: 'business_name', label: { type: 'custom', custom: 'Business name' }, type: 'text' }],
    payment_method_collection: 'always',
    success_url: `${base}/setup?checkout=return`,
    cancel_url: `${base}/setup?checkout=cancel`,
  };
  const safeEmail = cleanEmail(email);
  if (safeEmail) params.customer_email = safeEmail;
  return params;
}

/**
 * Classify a Stripe client error without reading its message.
 * @returns {'config'|'transient'} config = request/credential problem that retrying cannot fix
 */
function classifyStripeError(err) {
  const type = String((err && err.type) || (err && err.constructor && err.constructor.name) || '');
  if (/InvalidRequest|Authentication|Permission/.test(type)) return 'config';
  if (/^Stripe\w*Error$/.test(type)) return 'transient'; // connection, rate limit, API, idempotency...
  const raw = String((err && err.rawType) || '');
  return /invalid_request|authentication|permission/i.test(raw) ? 'config' : 'transient';
}

module.exports = {
  PURPOSE,
  TERMINAL_STATUSES,
  mapStripeStatus,
  readPeriodEnd,
  readSubscriptionIdFromInvoice,
  getStripeClient,
  verifyEvent,
  buildCheckoutParams,
  // additions (B1-b)
  idOf,
  readCustomerId,
  readPriceId,
  hasDefaultPaymentMethod,
  extractPrefill,
  classifyStripeError,
  cleanEmail,
  cleanPlanCode,
  WebhookSignatureError,
  _resetClient() { cachedClient = null; },
};
