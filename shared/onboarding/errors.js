'use strict';
// Stable error-code catalogue of the onboarding flow (DB design 4.7, verbatim)
// plus the OnbError class and the single JSON error responder. The frontend
// maps `code` -> i18n key `onboarding.errors.<CODE>`; `error` is an English
// fallback only. Never 401 (the Angular interceptor logs the user out on 401).
const { safeLog } = require('./config');

// status / nextStep / retryable defaults per code. nextStep values: the /state
// vocabulary (business|number|connect|approvals|customers|products|promotion)
// plus 'billing' for the subscription codes; null = none.
const CODES = Object.freeze({
  // Access
  ONBOARDING_NOT_AVAILABLE:  { status: 404, nextStep: null, retryable: false, message: 'Not found' },
  SUBSCRIPTION_REQUIRED:     { status: 402, nextStep: 'billing', retryable: false, message: 'A subscription is required to continue.' },
  PAYMENT_PENDING:           { status: 402, nextStep: 'billing', retryable: true, message: 'Your payment is still being confirmed.' },
  PAYMENT_PAST_DUE:          { status: 402, nextStep: 'billing', retryable: false, message: 'Update your payment to continue.' },
  SUBSCRIPTION_CANCELLED:    { status: 402, nextStep: 'billing', retryable: false, message: 'Your subscription is cancelled. Reactivate it to continue.' },
  WHATSAPP_NOT_CONNECTED:    { status: 402, nextStep: 'connect', retryable: false, message: 'Connect your WhatsApp Business account to continue.' },
  WHATSAPP_RECONNECT_REQUIRED: { status: 402, nextStep: 'connect', retryable: false, message: 'Reconnect your WhatsApp Business account to continue.' },
  SENDING_NOT_AVAILABLE_YET: { status: 402, nextStep: null, retryable: false, message: 'Sending from your own WhatsApp number is not available yet.' },
  OWNER_ONLY:                { status: 403, nextStep: null, retryable: false, message: 'Only the workspace owner can do this.' },
  NOT_A_MEMBER:              { status: 403, nextStep: null, retryable: false, message: 'You are no longer a member of this workspace.' },
  LEGAL_ACCEPTANCE_REQUIRED: { status: 403, nextStep: null, retryable: false, message: 'Please accept the current terms to continue.' },
  // Input
  VALIDATION_FAILED:         { status: 422, nextStep: null, retryable: false, message: 'Some of the information is not valid.' },
  STEP_PREREQUISITE:         { status: 409, nextStep: null, retryable: false, message: 'Please finish the previous step first.' },
  NUMBER_PERSONAL_WARNING_REQUIRED: { status: 422, nextStep: 'number', retryable: false, message: 'Please confirm you understand the number will be removed from your personal WhatsApp.' },
  NUMBER_ALREADY_CONNECTED:  { status: 409, nextStep: 'connect', retryable: false, message: 'A WhatsApp number is already connected.' },
  RATE_LIMITED:              { status: 429, nextStep: null, retryable: true, message: 'Too many attempts. Please wait a moment and try again.' },
  // Billing
  CHECKOUT_NOT_CONFIGURED:   { status: 503, nextStep: 'billing', retryable: false, message: 'Online payment is not available right now. Please contact us.' },
  PLAN_UNKNOWN:              { status: 422, nextStep: 'billing', retryable: false, message: 'That plan is not available.' },
  SUBSCRIPTION_EXISTS:       { status: 409, nextStep: 'billing', retryable: false, message: 'You already have a subscription.' },
  BILLING_PORTAL_UNAVAILABLE:{ status: 503, nextStep: 'billing', retryable: false, message: 'The billing page is not available right now. Please contact us.' },
  STRIPE_ERROR:              { status: 503, nextStep: 'billing', retryable: true, message: 'The payment service is not reachable right now. Please try again.' },
  // Connect
  CONNECT_NOT_CONFIGURED:    { status: 503, nextStep: 'connect', retryable: false, message: 'Connecting WhatsApp is not available right now. Please contact us.' },
  ENCRYPTION_NOT_CONFIGURED: { status: 503, nextStep: 'connect', retryable: false, message: 'Connecting WhatsApp is not available right now. Please contact us.' },
  CONNECT_IN_PROGRESS:       { status: 409, nextStep: 'connect', retryable: true, message: 'A connection is already in progress.' },
  CONNECT_ATTEMPT_INVALID:   { status: 409, nextStep: 'connect', retryable: true, message: 'This connection attempt has expired. Please start again.' },
  CONNECT_CODE_INVALID_OR_EXPIRED: { status: 422, nextStep: 'connect', retryable: true, message: 'The connection window expired. Please try again.' },
  CONNECT_WABA_MISMATCH:     { status: 409, nextStep: 'connect', retryable: false, message: 'That is not the WhatsApp Business account we expected.' },
  CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT: { status: 409, nextStep: 'number', retryable: false, message: 'This WhatsApp number is already connected to another WaFlow account.' },
  CONNECT_NUMBER_REGISTERED_ELSEWHERE: { status: 409, nextStep: 'number', retryable: false, message: 'This number is registered on another WhatsApp account. Remove it there, wait a few minutes, and try again.' },
  CONNECT_VERIFICATION_FAILED: { status: 422, nextStep: 'connect', retryable: true, message: 'The verification code did not work. Please try again.' },
  CONNECT_CANCELLED:         { status: 422, nextStep: 'connect', retryable: true, message: 'No problem. Connect whenever you are ready.' },
  CONNECT_NO_FACEBOOK_ACCOUNT: { status: 422, nextStep: 'connect', retryable: false, message: 'A Facebook account is needed to connect WhatsApp.' },
  CONNECT_COEXISTENCE_UNAVAILABLE: { status: 422, nextStep: 'number', retryable: false, message: 'Using the same number on the WhatsApp Business app and WaFlow is not available for this number.' },
  CONNECT_REGISTER_RATE_LIMITED: { status: 429, nextStep: 'connect', retryable: true, message: 'Too many registration attempts for this number. Please try again later.' },
  CONNECT_PARTIAL:           { status: 503, nextStep: 'connect', retryable: true, message: 'The connection is partly done. Please continue.' },
  CONNECT_AMBIGUOUS_WABA:    { status: 409, nextStep: 'connect', retryable: false, message: 'We could not tell which WhatsApp Business account to use. Please contact us.' },
  // Meta
  META_UNREACHABLE:          { status: 503, nextStep: null, retryable: true, message: 'WhatsApp (Meta) is not reachable right now. Please try again.' },
  META_ERROR:                { status: 503, nextStep: null, retryable: true, message: 'WhatsApp (Meta) returned an error. Please try again.' },
  META_TOKEN_REVOKED:        { status: 409, nextStep: 'connect', retryable: false, message: 'The WhatsApp connection was removed. Please reconnect.' },
  META_PERMISSION_MISSING:   { status: 409, nextStep: 'connect', retryable: false, message: 'WaFlow is missing a permission on your WhatsApp Business account.' },
  META_RATE_LIMITED:         { status: 429, nextStep: null, retryable: true, message: 'WhatsApp (Meta) asked us to slow down. Please try again later.' },
  META_NOT_CONFIGURED:       { status: 503, nextStep: null, retryable: false, message: 'WhatsApp connection is not configured on the server.' },
  // Templates / test message
  TEMPLATE_LIMIT_REACHED:    { status: 409, nextStep: 'approvals', retryable: false, message: 'The template limit has been reached.' },
  TEMPLATE_REJECTED:         { status: 422, nextStep: 'approvals', retryable: false, message: 'This template was rejected.' },
  TEST_RATE_LIMITED:         { status: 429, nextStep: null, retryable: true, message: 'Too many test messages. Please try again later.' },
  TEST_NO_APPROVED_TEMPLATE: { status: 409, nextStep: 'approvals', retryable: true, message: 'No approved message template is available yet.' },
  TEST_RECIPIENT_OPTED_OUT:  { status: 422, nextStep: null, retryable: false, message: 'This contact opted out of messages.' },
  TEST_PHONE_INVALID:        { status: 422, nextStep: null, retryable: false, message: 'Please enter a valid phone number.' },
  TEST_NUMBER_LIMIT:         { status: 409, nextStep: null, retryable: false, message: 'The limit of test numbers has been reached.' },
  // Additions beyond DB 4.7 (recorded in INTERFACES.md)
  INTERNAL_ERROR:            { status: 500, nextStep: null, retryable: true, message: 'Something went wrong' },
  NOT_IMPLEMENTED:           { status: 503, nextStep: null, retryable: false, message: 'Not available yet' },
});

/** The four subscription codes + the two connection codes + the policy code (4.4), all HTTP 402. */
const ACCESS_CODES = Object.freeze([
  'SUBSCRIPTION_REQUIRED', 'PAYMENT_PENDING', 'PAYMENT_PAST_DUE', 'SUBSCRIPTION_CANCELLED',
  'WHATSAPP_NOT_CONNECTED', 'WHATSAPP_RECONNECT_REQUIRED', 'SENDING_NOT_AVAILABLE_YET',
]);

class OnbError extends Error {
  /**
   * @param {string} code a key of CODES
   * @param {{message?:string,status?:number,nextStep?:string|null,retryable?:boolean,details?:object,retry?:object,retryAfterSec?:number,cause?:Error,extra?:object}} [opts]
   *   extra: plain top-level keys added to the JSON body (only keys that do not collide with the standard ones), e.g. { subscription }
   */
  constructor(code, opts = {}) {
    const def = CODES[code] || CODES.INTERNAL_ERROR;
    super(opts.message || def.message);
    this.name = 'OnbError';
    this.code = CODES[code] ? code : 'INTERNAL_ERROR';
    this.status = Number.isInteger(opts.status) ? opts.status : def.status;
    this.nextStep = opts.nextStep !== undefined ? opts.nextStep : def.nextStep;
    this.retryable = opts.retryable !== undefined ? !!opts.retryable : def.retryable;
    if (opts.details !== undefined) this.details = opts.details;
    if (opts.retry !== undefined) this.retry = opts.retry;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec;
    if (opts.cause) this.cause = opts.cause;
    if (opts.extra && typeof opts.extra === 'object') this.extra = opts.extra;
  }
}

function isOnbError(e) { return e instanceof OnbError; }
function statusFor(code) { return (CODES[code] || CODES.INTERNAL_ERROR).status; }
/** Throw an OnbError (convenience for guard clauses). */
function fail(code, opts) { throw new OnbError(code, opts); }

function bodyOf(err) {
  const body = { error: err.message, code: err.code };
  if (err.nextStep !== undefined && err.nextStep !== null) body.nextStep = err.nextStep;
  if (err.retryable !== undefined) body.retryable = !!err.retryable;
  if (err.details !== undefined) body.details = err.details;
  if (err.retry !== undefined) body.retry = err.retry;
  if (err.extra && typeof err.extra === 'object') {
    for (const k of Object.keys(err.extra)) if (!(k in body)) body[k] = err.extra[k];
  }
  return body;
}

/**
 * Write the JSON error body. Never 401 (mapped to 403). Non-OnbError errors
 * become 500 INTERNAL_ERROR (or 503 NOT_IMPLEMENTED for stubs) and only their
 * code/message are logged (scrubbed).
 */
function respond(res, err) {
  let e = err;
  if (!(e instanceof OnbError)) {
    if (e && e.code === 'NOT_IMPLEMENTED') {
      e = new OnbError('NOT_IMPLEMENTED');
    } else if (e && e.code === 'ENCRYPTION_NOT_CONFIGURED') {
      e = new OnbError('ENCRYPTION_NOT_CONFIGURED');
    } else {
      safeLog('error', '[onboarding] unexpected error:', e && e.code ? e.code : '', e && e.message ? e.message : '');
      e = new OnbError('INTERNAL_ERROR');
    }
  }
  const status = e.status === 401 ? 403 : e.status;
  if (res.headersSent) return res;
  if (e.retryAfterSec !== undefined && typeof res.set === 'function') res.set('Retry-After', String(Math.max(1, Math.ceil(e.retryAfterSec))));
  return res.status(status).json(bodyOf(e));
}

module.exports = { CODES, ACCESS_CODES, OnbError, isOnbError, statusFor, fail, respond, bodyOf };
