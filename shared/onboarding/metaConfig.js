'use strict';
// Meta (WhatsApp Cloud API / Embedded Signup) constants of the onboarding flow
// (DB design 6.1). Every constant that could not be verified against current
// Meta docs is tagged in CONFIDENCE and lives ONLY here, so a correction is a
// one-file change. Readers are functions (env read per call, nothing at load).
function str(name) {
  const v = process.env[name];
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

const CONFIDENCE = Object.freeze({
  GRAPH_VERSION: 'HIGH',
  GRAPH_BASE: 'HIGH',
  EXCHANGE_REDIRECT_URI: 'UNVERIFIED',
  DEBUG_TOKEN_AUTH: 'HIGH',
  ES_EXTRAS: 'HIGH (coexistence flow selection in v4 UNVERIFIED)',
  PHONE_FIELDS_FULL: 'MEDIUM (name_status is documented as beta: field negotiation falls back to the core list)',
  PHONE_FIELDS_CORE: 'HIGH',
  WABA_FIELDS: 'HIGH',
  VERIFICATION_MAP: 'HIGH (enum), mapping is ours',
  NAME_STATUS_MAP: 'MEDIUM',
  NAME_REJECTION_KEYS: 'HIGH',
  TIER_MAP: 'HIGH (limit is per business portfolio since Oct 2025)',
  HEALTH_MAP: 'HIGH',
  MERCHANT_WEBHOOK_FIELDS: 'HIGH (names)',
  META_PAYMENT_HELP_URL: 'MEDIUM',
  META_PAYMENT_SETTINGS_URL: 'LOW',
  META_SECURITY_CENTER_URL: 'LOW',
  META_WHATSAPP_MANAGER_URL: 'LOW',
  APPSECRET_PROOF: 'HIGH (docs) / applicability to business tokens not stated',
  REGISTER_PIN_LENGTH: 'HIGH',
  REQUEST_TIMEOUT_MS: 'ours',
  DISPLAY_NAME_LIMITS: 'UNVERIFIED (Meta enforces its own rules; ours only blocks empty/oversized input)',
  DISPLAY_NAME_EDITS_PER_30D: 'HIGH (10 changes per 30 days after a rejection)',
  PAYMENT_METHOD_API: 'NONE (Meta documents no API that reads a payment method: self-attestation, D11)',
});

function GRAPH_VERSION() { return str('WA_GRAPH_VERSION') || 'v25.0'; }
function GRAPH_BASE() { return `https://graph.facebook.com/${GRAPH_VERSION()}`; }
/** Parameter omitted from the code exchange when null (UNVERIFIED whether it is required for Embedded Signup). */
function EXCHANGE_REDIRECT_URI() { return str('ES_EXCHANGE_REDIRECT_URI'); }
/** App token `APP_ID|APP_SECRET` as the `access_token` query parameter (the form already used by utils/tokenManager.js). Alt: 'header'. */
const DEBUG_TOKEN_AUTH = 'query';

/** Embedded Signup `extras` (v4 needs an object, default {}). */
function ES_EXTRAS() {
  const raw = str('ES_EXTRAS');
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) { return {}; }
}

const PHONE_FIELDS_FULL = 'id,display_phone_number,verified_name,name_status,new_display_name,new_name_status,quality_rating,code_verification_status,status,platform_type,is_on_biz_app,whatsapp_business_manager_messaging_limit,throughput';
const PHONE_FIELDS_CORE = 'id,display_phone_number,verified_name,quality_rating,status';

function paymentProbe() { return str('META_PAYMENT_PROBE') === 'on'; }
function WABA_FIELDS() {
  const base = 'id,name,currency,message_template_namespace,business_verification_status,health_status,whatsapp_business_manager_messaging_limit,ownership_type,country,status';
  return paymentProbe() ? `${base},primary_funding_id` : base;
}

const VERIFICATION_MAP = Object.freeze({
  verified: 'done',
  pending: 'waiting', pending_submission: 'waiting',
  not_verified: 'needs_you', pending_need_more_info: 'needs_you', rejected: 'needs_you', failed: 'needs_you',
  expired: 'needs_you', revoked: 'needs_you', ineligible: 'needs_you',
});
const NAME_STATUS_MAP = Object.freeze({
  APPROVED: 'done', AVAILABLE_WITHOUT_REVIEW: 'done',
  PENDING_REVIEW: 'waiting',
  DECLINED: 'needs_you', EXPIRED: 'needs_you', NONE: 'needs_you',
});
/** Meta rejection reason -> i18n key (the UI never shows Meta's raw text). */
const NAME_REJECTION_KEYS = Object.freeze({
  NAME_EMPLOYEE_ISSUE: 'onboarding.approvals.nameRejection.NAME_EMPLOYEE_ISSUE',
  NAME_INDIVIDUAL_ISSUE: 'onboarding.approvals.nameRejection.NAME_INDIVIDUAL_ISSUE',
  NAME_ENDCLIENT_NOTRELATED: 'onboarding.approvals.nameRejection.NAME_ENDCLIENT_NOTRELATED',
  NAME_FORMAT_UNACCEPTABLE: 'onboarding.approvals.nameRejection.NAME_FORMAT_UNACCEPTABLE',
  NAME_NOT_CONSISTENT: 'onboarding.approvals.nameRejection.NAME_NOT_CONSISTENT',
  UNKNOWN: 'onboarding.approvals.nameRejection.UNKNOWN',
});
const TIER_MAP = Object.freeze({
  TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000,
  TIER_UNLIMITED: null, UNTIERED: null,
});
const HEALTH_MAP = Object.freeze({ AVAILABLE: 'AVAILABLE', LIMITED: 'LIMITED', BLOCKED: 'BLOCKED' });

function mapVerification(raw) {
  if (raw === undefined || raw === null) return 'unknown';
  const k = String(raw).toLowerCase();
  return Object.prototype.hasOwnProperty.call(VERIFICATION_MAP, k) ? VERIFICATION_MAP[k] : 'unknown';
}
function mapNameStatus(raw) {
  if (raw === undefined || raw === null) return 'unknown';
  const k = String(raw).toUpperCase();
  return Object.prototype.hasOwnProperty.call(NAME_STATUS_MAP, k) ? NAME_STATUS_MAP[k] : 'unknown';
}
/** Tier value (string enum or integer) -> { raw, tierNumber }. Unknown -> raw only (tierNumber null). */
function tierFromRaw(value) {
  if (value === undefined || value === null || value === '') return { raw: null, tierNumber: null };
  if (typeof value === 'number' && Number.isFinite(value)) return { raw: String(value), tierNumber: value };
  const raw = String(value).slice(0, 40);
  if (/^\d+$/.test(raw)) return { raw, tierNumber: Number(raw) };
  const k = raw.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(TIER_MAP, k)) return { raw, tierNumber: TIER_MAP[k] };
  return { raw, tierNumber: null };
}

const MERCHANT_WEBHOOK_FIELDS = Object.freeze([
  'account_update', 'phone_number_name_update', 'phone_number_quality_update', 'business_capability_update',
  'account_alerts', 'message_template_status_update', 'template_category_update', 'messages',
]);

function META_PAYMENT_HELP_URL() { return str('META_PAYMENT_HELP_URL') || 'https://www.facebook.com/business/help/488291839463771'; }
function META_PAYMENT_SETTINGS_URL() { return str('META_PAYMENT_SETTINGS_URL') || 'https://business.facebook.com/billing_hub/payment_methods'; }
function META_SECURITY_CENTER_URL() { return str('META_SECURITY_CENTER_URL') || 'https://business.facebook.com/settings/security'; }
function META_WHATSAPP_MANAGER_URL() { return 'https://business.facebook.com/wa/manage/home/'; }

function APPSECRET_PROOF_ON() { return str('META_APPSECRET_PROOF') === 'on'; }
const REGISTER_PIN_LENGTH = 6;
const REQUEST_TIMEOUT_MS = 20000;
const DISPLAY_NAME_MIN = 3;
const DISPLAY_NAME_MAX = 512;
const DISPLAY_NAME_EDITS_PER_30D = 10;

function metaEsAppId() { return str('META_ES_APP_ID') || str('WA_APP_ID'); }
function metaEsConfigId() { return str('META_ES_CONFIG_ID'); }

/**
 * The Graph `http` port (INTERFACES 0.2): resolves { status, data, headers } for EVERY HTTP status;
 * network failures reject with { code, message }. axios is required lazily.
 */
function defaultHttp() {
  return {
    request(cfg) {
      const axios = require('axios');
      return axios.request({ ...cfg, validateStatus: () => true }).then(
        (r) => ({ status: r.status, data: r.data, headers: r.headers }),
        (e) => { throw { code: e && e.code ? e.code : 'ECONNRESET', message: e && e.message ? String(e.message).slice(0, 200) : 'network error' }; }, // eslint-disable-line no-throw-literal
      );
    },
  };
}

module.exports = {
  CONFIDENCE,
  GRAPH_VERSION, GRAPH_BASE, EXCHANGE_REDIRECT_URI, DEBUG_TOKEN_AUTH, ES_EXTRAS,
  PHONE_FIELDS_FULL, PHONE_FIELDS_CORE, WABA_FIELDS,
  VERIFICATION_MAP, NAME_STATUS_MAP, NAME_REJECTION_KEYS, TIER_MAP, HEALTH_MAP,
  mapVerification, mapNameStatus, tierFromRaw,
  MERCHANT_WEBHOOK_FIELDS,
  META_PAYMENT_HELP_URL, META_PAYMENT_SETTINGS_URL, META_SECURITY_CENTER_URL, META_WHATSAPP_MANAGER_URL,
  APPSECRET_PROOF_ON, REGISTER_PIN_LENGTH, REQUEST_TIMEOUT_MS,
  DISPLAY_NAME_MIN, DISPLAY_NAME_MAX, DISPLAY_NAME_EDITS_PER_30D,
  metaEsAppId, metaEsConfigId, paymentProbe, defaultHttp,
};
