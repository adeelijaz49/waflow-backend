'use strict';
// Meta error classification for the onboarding flow (DB design 6.3): ONE table maps a Graph
// error (code + subcode) or a network failure to { kind, appCode, retryable }, and a second
// table maps the Embedded Signup popup error codes (reported by the browser through
// POST /connect/event) to an outcome. Codes that are not verified against Meta's documentation
// carry `unverified: true` and appear ONLY here (AU4 sections 1.5 and 8).
//
// Pure module: no I/O, nothing executed at require time.

const SUBCODE_DUPLICATE_TEMPLATE = 2388024;

/**
 * Graph error table, evaluated top to bottom (first match wins).
 * match: { codes?: number[], range?: [min, max], subcodes?: number[] }
 */
const TABLE = Object.freeze([
  { id: 'token_revoked', match: { codes: [190, 102] }, kind: 'reconnect', appCode: 'META_TOKEN_REVOKED', retryable: false, note: '190 with subcodes 458/460/463/467, and 102 (session invalid): the merchant must reconnect (HIGH)' },
  { id: 'duplicate_template', match: { codes: [100], subcodes: [SUBCODE_DUPLICATE_TEMPLATE] }, kind: 'duplicate_template', appCode: 'META_ERROR', retryable: false, note: 'template name already exists in that language: adopt the existing template (HIGH)' },
  { id: 'permission', match: { codes: [10], range: [200, 299] }, kind: 'permission', appCode: 'META_PERMISSION_MISSING', retryable: false, note: 'permission denied / missing (HIGH)' },
  { id: 'rate_limited', match: { codes: [4, 17, 32, 613, 80007, 130429, 131056] }, kind: 'retry', appCode: 'META_RATE_LIMITED', retryable: true, note: '4 and 17 documented (HIGH); the others are known from the existing campaign sender' },
  { id: 'register_rate', match: { codes: [133016] }, kind: 'register_rate', appCode: 'CONNECT_REGISTER_RATE_LIMITED', retryable: false, note: '10 register/deregister requests per number per 72 h; never retried in a loop (HIGH)' },
  { id: 'payment', match: { codes: [131042] }, kind: 'payment', appCode: 'META_ERROR', retryable: false, unverified: true, note: 'payment issue: meaning UNVERIFIED (from memory, AU4 10)' },
  { id: 'locked', match: { codes: [131031] }, kind: 'locked', appCode: 'META_ERROR', retryable: false, unverified: true, note: 'account locked: meaning UNVERIFIED' },
  { id: 'not_registered', match: { codes: [133010] }, kind: 'not_registered', appCode: 'META_ERROR', retryable: false, unverified: true, note: 'phone number not registered: meaning UNVERIFIED' },
  { id: 'template', match: { codes: [141002] }, kind: 'template', appCode: 'META_ERROR', retryable: false, note: 'health_status entity error: template not approved (informational, HIGH)' },
]);

const NETWORK_CODES = Object.freeze(['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ERR_NETWORK', 'ERR_SOCKET_CONNECTION_TIMEOUT']);

function toInt(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d{1,9}$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

function matches(m, code, subcode) {
  if (code === null) return false;
  if (m.subcodes && !m.subcodes.includes(subcode)) return false;
  if (m.codes && m.codes.includes(code)) return true;
  if (m.range && code >= m.range[0] && code <= m.range[1]) return true;
  return false;
}

/** Pull { code, subcode, httpStatus, network } out of a MetaGraphError, a Graph body or a loose shape. */
function normalise(input) {
  const out = { code: null, subcode: null, httpStatus: null, network: false };
  if (!input || typeof input !== 'object') return out;
  const body = input.data && input.data.error ? input.data.error : (input.error && typeof input.error === 'object' ? input.error : null);
  if (typeof input.networkCode === 'string' && NETWORK_CODES.includes(input.networkCode)) out.network = true;
  if (typeof input.code === 'string' && NETWORK_CODES.includes(input.code)) out.network = true;
  if (body) {
    out.code = toInt(body.code);
    out.subcode = toInt(body.error_subcode !== undefined ? body.error_subcode : body.subcode);
  } else {
    out.code = out.network ? null : toInt(input.code);
    out.subcode = toInt(input.subcode !== undefined ? input.subcode : input.error_subcode);
  }
  out.httpStatus = toInt(input.httpStatus !== undefined ? input.httpStatus : input.status);
  return out;
}

/**
 * Classify a Graph failure.
 * @param {object} errOrShape MetaGraphError | { code, subcode, httpStatus } | { error:{code,error_subcode} } | { status, data:{error} } | network error
 * @returns {{ kind: string, appCode: string, retryable: boolean, unverified?: boolean }}
 */
function classify(errOrShape) {
  const n = normalise(errOrShape);
  if (n.network) return { kind: 'network', appCode: 'META_UNREACHABLE', retryable: true };
  for (const row of TABLE) {
    if (matches(row.match, n.code, n.subcode)) {
      const out = { kind: row.kind, appCode: row.appCode, retryable: row.retryable };
      if (row.unverified) out.unverified = true;
      return out;
    }
  }
  if (n.code === null && n.httpStatus !== null && n.httpStatus >= 500) return { kind: 'unknown', appCode: 'META_ERROR', retryable: true };
  if (n.httpStatus === 429) return { kind: 'retry', appCode: 'META_RATE_LIMITED', retryable: true };
  return { kind: 'unknown', appCode: 'META_ERROR', retryable: n.httpStatus !== null && n.httpStatus >= 500 };
}

// ---- Embedded Signup popup error codes (AU4 1.5, HIGH) ------------------------------------------------------------
const POPUP_REGISTERED_ELSEWHERE = Object.freeze([3441030, 3441049, 2655094, 2655082, 2655049, 2494028, 2655093]);
const POPUP_VERIFICATION_FAILED = Object.freeze([2388091, 2593039, 2388093, 2593037, 2494158, 3441033, 3441046, 1675004, 1390006, 1390008]);
const POPUP_COEXISTENCE = Object.freeze([3441042, 3441045, 4563015, 2655095, 2655048, 3441041, 3441047]);

const OUTCOME_ROWS = Object.freeze({
  CONNECT_NUMBER_REGISTERED_ELSEWHERE: { outcome: 'error', nextStep: 'number' },
  CONNECT_VERIFICATION_FAILED: { outcome: 'error', nextStep: 'connect' },
  CONNECT_COEXISTENCE_UNAVAILABLE: { outcome: 'error', nextStep: 'number' },
  CONNECT_CANCELLED: { outcome: 'cancelled', nextStep: 'connect' },
  CONNECT_NO_FACEBOOK_ACCOUNT: { outcome: 'no_facebook', nextStep: 'connect' },
  META_ERROR: { outcome: 'error', nextStep: 'connect' },
});

function outcomeFor(code) {
  const row = OUTCOME_ROWS[code];
  return { outcome: row.outcome, code, nextStep: row.nextStep, copyKey: `onboarding.errors.${code}` };
}

/**
 * Map a popup report to the outcome the UI shows.
 *  - NO_FACEBOOK (the merchant tapped "I do not have a Facebook account") -> CONNECT_NO_FACEBOOK_ACCOUNT
 *  - CANCEL / ERROR with a known Embedded Signup error code -> its CONNECT_* code
 *  - CANCEL without an error code (any current step) -> CONNECT_CANCELLED
 *  - ERROR / CANCEL with an unknown error code -> META_ERROR (generic "try again")
 * @param {{ event: string, errorCode?: number|string|null, currentStep?: string }} input
 * @returns {{ outcome: 'cancelled'|'error'|'no_facebook', code: string, nextStep: string, copyKey: string }}
 */
function popupOutcome(input) {
  const { event, errorCode } = input || {};
  const ev = String(event || '').toUpperCase();
  if (ev === 'NO_FACEBOOK') return outcomeFor('CONNECT_NO_FACEBOOK_ACCOUNT');
  const code = toInt(errorCode);
  if (code !== null) {
    if (POPUP_REGISTERED_ELSEWHERE.includes(code)) return outcomeFor('CONNECT_NUMBER_REGISTERED_ELSEWHERE');
    if (POPUP_VERIFICATION_FAILED.includes(code)) return outcomeFor('CONNECT_VERIFICATION_FAILED');
    if (POPUP_COEXISTENCE.includes(code)) return outcomeFor('CONNECT_COEXISTENCE_UNAVAILABLE');
    return outcomeFor('META_ERROR');
  }
  if (ev === 'ERROR') return outcomeFor('META_ERROR');
  return outcomeFor('CONNECT_CANCELLED');
}

module.exports = {
  TABLE,
  classify,
  popupOutcome,
  // additions (documented in B1-c.md)
  NETWORK_CODES,
  POPUP_CODES: Object.freeze({
    CONNECT_NUMBER_REGISTERED_ELSEWHERE: POPUP_REGISTERED_ELSEWHERE,
    CONNECT_VERIFICATION_FAILED: POPUP_VERIFICATION_FAILED,
    CONNECT_COEXISTENCE_UNAVAILABLE: POPUP_COEXISTENCE,
  }),
  SUBCODE_DUPLICATE_TEMPLATE,
};
