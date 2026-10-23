'use strict';
// WhatsApp onboarding flow: switches, env readers, constants and the PII-safe
// logging helpers. NOTHING is cached at load time: every reader reads
// process.env on each call, so tests (and the CLI) can flip behaviour freely,
// and with ONBOARDING_FLOW unset every hook is a single synchronous env read.

/** The one flag. Only the exact string 'on' enables the flow. */
function enabled() {
  return process.env.ONBOARDING_FLOW === 'on';
}

function str(name) {
  const v = process.env[name];
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function isOn(name) { return str(name) === 'on'; }

/** 'block' (default) | 'platform_number' (explicit owner opt-in for supervised pilots, D5). */
function legacySendPolicy() { return str('ONBOARDING_LEGACY_SEND_POLICY') === 'platform_number' ? 'platform_number' : 'block'; }
/** 'connected' (default, D6) | 'finished'. */
function unlockAt() { return str('ONBOARDING_UNLOCK_AT') === 'finished' ? 'finished' : 'connected'; }
function strictLock() { return isOn('ONBOARDING_STRICT_LOCK'); }

// ISO 8601 date, or date + time WITH an explicit zone (Z or +HH:MM). A date-time without a zone is read in the server's local time zone
// by JavaScript (a 3 hour shift between a Riyadh machine and UTC Azure), so it is refused: auto-enrolment then stays OFF (fail safe).
const ENROL_FROM_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

/**
 * ISO cutover timestamp for auto-enrolment of new self-serve signups; null = auto-enrolment OFF.
 * Accepted: 2026-11-01, 2026-11-01T00:00:00Z, 2026-11-01T03:00:00+03:00 (always write the Z / offset). Refused (null, so auto-enrolment
 * stays off): a date-time without a zone, an impossible calendar date (2026-02-30, which JavaScript would roll over to 2026-03-02), anything else.
 */
function enrolFrom() {
  const raw = str('ONBOARDING_ENROL_FROM');
  if (!raw) return null;
  const m = ENROL_FROM_RE.exec(raw);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, day));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== day) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function checkoutEnabled() { return isOn('ONBOARDING_CHECKOUT'); }
function billingPortalEnabled() { return isOn('ONBOARDING_BILLING_PORTAL'); }
function acceptTrialing() { return isOn('ONBOARDING_ACCEPT_TRIALING'); }
/** Default on (D7); only the exact value 'off' disables the browser-triggered refresh. */
function reconcileOnDemand() { return str('ONBOARDING_BILLING_RECONCILE_ON_DEMAND') !== 'off'; }

function stripeSecretKey() { return str('ONBOARDING_STRIPE_SECRET_KEY') || str('STRIPE_SECRET_KEY'); }
function stripeWebhookSecrets() {
  return [str('ONBOARDING_STRIPE_WEBHOOK_SECRET'), str('ONBOARDING_STRIPE_WEBHOOK_SECRET_PREV')].filter(Boolean);
}
function parseJsonObject(name) {
  const raw = str(name);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) {
    return {};
  }
}
function stripePrices() {
  const parsed = parseJsonObject('ONBOARDING_STRIPE_PRICES');
  const out = {};
  for (const k of Object.keys(parsed)) {
    if (/^[A-Za-z0-9_-]{1,40}$/.test(k) && typeof parsed[k] === 'string' && parsed[k].trim()) out[k] = parsed[k].trim();
  }
  return out;
}
function planLabels() { return parseJsonObject('ONBOARDING_PLAN_LABELS'); }

/** 'off' | 'log' | 'enforce'; invalid/unset -> enforce when the flow is on, else off (DB 6.9). */
function webhookSignatureMode() {
  const v = str('ONBOARDING_WEBHOOK_SIGNATURE');
  if (v === 'off' || v === 'log' || v === 'enforce') return v;
  return enabled() ? 'enforce' : 'off';
}
function dropUnknownWaba() { return isOn('ONBOARDING_DROP_UNKNOWN_WABA'); }

function schedulerIntervalMs() {
  const n = Number(str('ONBOARDING_SCHEDULER_INTERVAL_MS'));
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 10 * 60 * 1000;
}

const DEFAULT_STARTER_KEYS = Object.freeze([
  'welcome_optin', 'promotion_weekend', 'promotion_new_arrival', 'comeback', 'points_balance', 'order_confirmation', 'booking_confirmation',
]);
function starterTemplateKeys() {
  const raw = str('ONBOARDING_STARTER_TEMPLATES');
  if (!raw) return DEFAULT_STARTER_KEYS.slice();
  const keys = raw.split(',').map((s) => s.trim()).filter((s) => /^[a-z0-9_]{1,60}$/.test(s));
  return keys.length ? keys : DEFAULT_STARTER_KEYS.slice();
}
function templateCeiling() {
  const n = Number(str('ONBOARDING_TEMPLATE_CEILING'));
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 90;
}

/** Support channel (D15): both null -> the UI links to the existing /support page. */
function supportConfig() {
  const waDigits = (str('ONBOARDING_SUPPORT_WHATSAPP') || '').replace(/\D/g, '');
  return {
    email: str('ONBOARDING_SUPPORT_EMAIL'),
    whatsapp: waDigits.length >= 8 && waDigits.length <= 15 ? waDigits : null,
    fallbackPath: '/support',
    deskEmail: str('SUPPORT_DESK_EMAIL'),
  };
}

function allowSharedKey() { return str('ONBOARDING_ALLOW_SHARED_KEY') === '1'; }

/** The PLATFORM's own WhatsApp ids (env WA_WABA_ID / WA_PHONE_ID) as trimmed strings; null for an unset value. */
function platformIds() {
  return { wabaId: str('WA_WABA_ID'), phoneNumberId: str('WA_PHONE_ID') };
}

/**
 * Is this WhatsApp Business account (WABA id) or phone number id the PLATFORM's own (used by every legacy send and by the single-workspace
 * webhook)? A merchant must never be able to connect it: the connection would own the platform ids, and disconnecting it would remove
 * the production webhook subscription. false when the env values are unset, for empty ids and for anything that is not the same string.
 * @param {{wabaId?:*, phoneNumberId?:*}} ids
 * @returns {boolean}
 */
function isPlatformAccount(ids) {
  const o = ids && typeof ids === 'object' ? ids : {};
  const p = platformIds();
  const norm = (v) => (v === undefined || v === null ? '' : String(v).trim());
  const w = norm(o.wabaId);
  const ph = norm(o.phoneNumberId);
  return !!((p.wabaId && w && w === p.wabaId) || (p.phoneNumberId && ph && ph === p.phoneNumberId));
}

function normaliseUrl(raw, fallback) {
  const v = raw || fallback;
  const withScheme = /^https?:\/\//.test(v) ? v : `https://${v}`;
  return withScheme.replace(/\/+$/, '');
}
function frontendUrl() { return normaliseUrl(str('FRONTEND_URL'), 'http://localhost:4200'); }
function appUrl() { return normaliseUrl(str('APP_URL'), `http://localhost:${str('PORT') || 3000}`); }

// ── Constants ───────────────────────────────────────────────────────────────
const STEP_KEYS = Object.freeze(['business', 'number', 'connect', 'approvals', 'promotion']);
const STEP_INDEX = Object.freeze({ business: 1, number: 2, connect: 3, approvals: 4, promotion: 5 });
const NEXT_STEPS = Object.freeze(['business', 'number', 'connect', 'approvals', 'customers', 'products', 'promotion']);
// DECISIONS C9
const INDUSTRY_KEYS = Object.freeze(['restaurant', 'salon_beauty', 'fashion', 'grocery', 'electronics', 'health', 'fitness', 'home_furniture', 'services', 'other']);
const COUNTRY_CODES = Object.freeze(['SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'OTHER']);
const LANGUAGES = Object.freeze(['en', 'ar']);
/** WhatsAppConnection.status values that count as "connected" for the access rule. */
const CONNECTED_LIKE = Object.freeze(['connected', 'needs_attention']);

// ── PII-safe logging ────────────────────────────────────────────────────────
/** Mask a phone number to its last 4 digits: '+966501234567' -> '*********4567'. */
function maskPhone(value) {
  const digits = String(value === undefined || value === null ? '' : value).replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return '*'.repeat(digits.length - 4) + digits.slice(-4);
}

const TOKEN_LIKE = /[A-Za-z0-9_\-]{40,}/g;
// 9-15 digit runs (optionally with a leading + and common separators) that look like a phone number.
const PHONE_LIKE = /(?<![A-Za-z0-9])\+?\d[\d\s().-]{7,16}\d(?![A-Za-z0-9])/g;

// Keys whose string values are never logged. 'code' is redacted unless it is a catalogue code (e.g. META_ERROR).
const SECRET_KEY = /^(code|pin|authorization|password|signed_request)$|token|secret|password$/i;
const CATALOG_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

function scrubString(s) {
  return String(s)
    .replace(TOKEN_LIKE, '[redacted]')
    .replace(PHONE_LIKE, (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 9 && digits.length <= 15 ? maskPhone(digits) : m;
    });
}

/** Apply the masking to strings, arrays, plain objects and Errors (to {code,message}). */
function scrub(value, depth = 0) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { code: value.code, message: scrubString(value.message || '') };
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).slice(0, 40)) {
      if (SECRET_KEY.test(k) && typeof value[k] === 'string' && !(k.toLowerCase() === 'code' && CATALOG_CODE.test(value[k]))) { out[k] = '[redacted]'; continue; }
      out[k] = scrub(value[k], depth + 1);
    }
    return out;
  }
  return String(value);
}

/** console[level](tag, ...scrubbed args). Never throws. */
function safeLog(level, tag, ...args) {
  try {
    const fn = typeof console[level] === 'function' ? console[level] : console.log;
    fn.call(console, tag, ...args.map((a) => scrub(a)));
  } catch (_) { /* logging must never break a request */ }
}

module.exports = {
  enabled, legacySendPolicy, unlockAt, strictLock, enrolFrom,
  checkoutEnabled, billingPortalEnabled, acceptTrialing, reconcileOnDemand,
  stripeSecretKey, stripeWebhookSecrets, stripePrices, planLabels,
  webhookSignatureMode, dropUnknownWaba, schedulerIntervalMs,
  starterTemplateKeys, templateCeiling, supportConfig, allowSharedKey, platformIds, isPlatformAccount,
  frontendUrl, appUrl,
  STEP_KEYS, STEP_INDEX, NEXT_STEPS, INDUSTRY_KEYS, COUNTRY_CODES, LANGUAGES, CONNECTED_LIKE, DEFAULT_STARTER_KEYS,
  maskPhone, safeLog, scrub,
};
