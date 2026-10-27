const ConsentEvent = require('../models/ConsentEvent');
const Customer = require('../models/Customer');
const { waPost } = require('../utils/whatsapp');

// The single source of truth for "is this customer eligible to receive a
// marketing message." Centralized on purpose — before this, every send path
// duplicated its own `!customer.optedOut` check; this collapses all of them
// to one function/query pair so a second condition (marketingConsent) never
// has to be added independently at each of the ~9 call sites again.
const MARKETING_ELIGIBLE_QUERY = { marketingConsent: true, optedOut: { $ne: true } };

function canSendMarketing(customer) {
  return !!customer && customer.marketingConsent === true && customer.optedOut !== true;
}

// The three states the Customers screen and the audience filters speak about. "not_responded" deliberately covers
// everything that is neither opted in nor opted out - including a legacy "No thanks" decline, which only ever wrote an
// event and never changed the customer.
function deriveConsentStatus(customer) {
  if (!customer) return 'not_responded';
  if (customer.optedOut === true) return 'opted_out';
  if (customer.marketingConsent === true) return 'opted_in';
  return 'not_responded';
}

// Evidence of the customer's own tap, stored on the ConsentEvent next to type/method/source. Only these keys are ever
// copied (a caller cannot overwrite type/method/customer through it). Empty values are dropped rather than stored:
// an explicit null in `inboundWamid` would still be indexed by the unique sparse index and collide.
const EVIDENCE_FIELDS = [
  'promotionId', 'promotionName', 'messageText', 'buttonLabel', 'buttonPosition', 'buttonAction', 'templateName',
  'templateVersion', 'sourceWamid', 'inboundWamid', 'tappedAt', 'receivedAt', 'signature',
];
const EVIDENCE_TEXT_MAX = { messageText: 4096 };
const EVIDENCE_DEFAULT_TEXT_MAX = 500;

function cleanEvidence(evidence) {
  const out = {};
  if (!evidence || typeof evidence !== 'object') return out;
  for (const key of EVIDENCE_FIELDS) {
    let v = evidence[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'string') v = v.slice(0, EVIDENCE_TEXT_MAX[key] || EVIDENCE_DEFAULT_TEXT_MAX);
    if ((key === 'tappedAt' || key === 'receivedAt') && !(v instanceof Date)) {
      v = new Date(v);
      if (Number.isNaN(v.getTime())) continue;
    }
    out[key] = v;
  }
  if (Object.keys(out).length && !out.receivedAt) out.receivedAt = new Date();
  return out;
}

async function recordConsentEvent({ workspaceId, customer, type, method, source, performedBy, campaignMessageId, importJobId, evidence }) {
  return ConsentEvent.create({
    ...cleanEvidence(evidence),
    workspaceId: workspaceId || customer.workspaceId,
    customerId: customer._id,
    phone: customer.phone,
    type, method, source, performedBy, campaignMessageId, importJobId,
  });
}

// What the CUSTOMER record says about how consent was given. It only knows the two values the previous release's schema knows
// (see models/Customer.js): a customer who typed START is recorded as having consented through WhatsApp (whatsapp_button); the
// ConsentEvent keeps the precise method (whatsapp_start_command).
function customerLevelMethod(method) {
  return method === 'whatsapp_start_command' ? 'whatsapp_button' : method;
}

// CONSENT_REQUIRE_SIGNATURE=on: a customer's own opt-in (a tap, or a typed START after an opt-out) is only applied when the webhook
// request carried a valid X-Hub-Signature-256. An opt-out is always honoured. Off by default (WA_APP_SECRET may not be set).
function requireSignature() {
  return require('../utils/envFlag').isOn('CONSENT_REQUIRE_SIGNATURE', false);
}

// Said once at start-up: with the signature required but no way to verify one, no request is ever "valid", so EVERY opt-in tap and START
// is refused (and the customer is not answered). null when the setting is off or the signature can be verified.
// @param {{ secretConfigured?: boolean, mode?: string }} setup  whether WA_APP_SECRET is set, and WEBHOOK_SIGNATURE_MODE (off | log | enforce)
function signatureSetupProblem({ secretConfigured = false, mode = 'log' } = {}) {
  if (!requireSignature()) return null;
  if (secretConfigured && mode !== 'off') return null;
  return 'CONSENT_REQUIRE_SIGNATURE is on but webhook signatures cannot be verified (WA_APP_SECRET is not set, or WEBHOOK_SIGNATURE_MODE=off): '
    + 'every opt-in tap and START will be refused until that is fixed.';
}

function isDuplicateKey(err) {
  return !!err && (err.code === 11000 || /E11000/.test(String(err.message || '')));
}

// A Meta redelivery of a tap we already recorded. True only for callers that gave an inboundWamid (the only unique key).
function isRedelivery(err, evidence) {
  return isDuplicateKey(err) && !!(evidence && evidence.inboundWamid);
}

// After a redelivery, the first delivery may have died between "event written" and "customer updated" - so the customer
// update is re-applied. But ONLY when that event is still the customer's latest one: a late redelivery of an old
// "yes" must never undo a later "no".
async function isStillLatestEvent(customer, inboundWamid) {
  // _id order IS creation order (an ObjectId starts with its creation time) and _id is always indexed: Cosmos DB for MongoDB
  // rejects a {createdAt, _id} sort that no compound index serves.
  const latest = await ConsentEvent.findOne({ customerId: customer._id }).sort({ _id: -1 }).lean();
  return !!latest && latest.inboundWamid === inboundWamid;
}

// Every write helper below logs the ConsentEvent BEFORE mutating the Customer
// document — if the process dies between the two, the customer is left
// "logged but not yet applied" (recoverable by re-running), never "applied
// but never logged" (a silent compliance gap with no record it happened).

// Staff / import / customer-form grant. Deliberately does NOT clear optedOut: a staff member ticking "consented" (or a
// CSV import attesting it) must not override a customer's own opt-out. Customer-initiated opt-ins use
// recordCustomerOptIn below.
async function grantMarketingConsent({ customer, method, source, performedBy, workspaceId, campaignMessageId, importJobId }) {
  await recordConsentEvent({ workspaceId, customer, type: 'consent_given', method, source, performedBy, campaignMessageId, importJobId });
  customer.marketingConsent = true;
  customer.marketingConsentAt = new Date();
  customer.marketingConsentMethod = method;
  await customer.save();
  return customer;
}

// The customer opted in by themselves (tapped an opt-in button, or typed START after opting out). Unlike the staff
// grant this also CLEARS optedOut/optedOutAt: they changed their mind, so they are reachable again.
// Returns { customer, duplicate }; duplicate:true = this inboundWamid was already recorded (Meta redelivery), callers
// must not reply a second time.
async function recordCustomerOptIn({ customer, method = 'whatsapp_button', source, workspaceId, evidence, campaignMessageId }) {
  const customerMethod = customerLevelMethod(method);
  try {
    await recordConsentEvent({ workspaceId, customer, type: 'consent_given', method, source, campaignMessageId, evidence });
  } catch (err) {
    if (!isRedelivery(err, evidence)) throw err;
    if (await isStillLatestEvent(customer, evidence.inboundWamid)) {
      customer.marketingConsent = true;
      customer.marketingConsentMethod = customerMethod;
      customer.optedOut = false;
      customer.optedOutAt = null;
      if (!customer.marketingConsentAt) customer.marketingConsentAt = new Date();
      await Customer.updateOne({ _id: customer._id }, { $set: { marketingConsent: true, marketingConsentMethod: customerMethod, optedOut: false, optedOutAt: null, marketingConsentAt: customer.marketingConsentAt } });
    }
    return { customer, duplicate: true };
  }
  customer.marketingConsent = true;
  customer.marketingConsentAt = new Date();
  customer.marketingConsentMethod = customerMethod;
  customer.optedOut = false;
  customer.optedOutAt = null;
  await customer.save();
  return { customer, duplicate: false };
}

// Returns the customer, or { duplicate: true, customer } for a redelivery of an already-recorded tap.
async function withdrawMarketingConsent({ customer, method, source, performedBy, workspaceId, evidence }) {
  try {
    await recordConsentEvent({ workspaceId, customer, type: 'consent_withdrawn', method, source, performedBy, evidence });
  } catch (err) {
    if (!isRedelivery(err, evidence)) throw err;
    if (await isStillLatestEvent(customer, evidence.inboundWamid)) {
      customer.optedOut = true;
      if (!customer.optedOutAt) customer.optedOutAt = new Date();
      await Customer.updateOne({ _id: customer._id }, { $set: { optedOut: true, optedOutAt: customer.optedOutAt } });
    }
    return { customer, duplicate: true };
  }
  customer.optedOut = true;
  customer.optedOutAt = new Date();
  await customer.save();
  return customer;
}

// START. Two cases:
//  * the customer is opted out (STOP, or an opt-out button): this is a fresh, customer-initiated opt-in. It is recorded as
//    consent_given (method whatsapp_start_command, source "START after opt-out") and clears the opt-out - whether or not
//    they had ever opted in before, because a person who says START is asking to hear from the business.
//  * the customer is not opted out but had consented: as before (consent_reinstated, returns true).
// A customer who never opted in and never opted out stays as it was - a bare START never fabricates consent - and the
// function returns false. Returns true (or { duplicate: true, customer } for a redelivery: truthy, so callers that only
// test the result keep working, and callers that care can check .duplicate) when the customer is reachable again.
async function reinstateMarketingConsent({ customer, method, source, performedBy, workspaceId, evidence, signature }) {
  if (customer.optedOut === true) {
    // A forged START must not undo an opt-out: with CONSENT_REQUIRE_SIGNATURE=on the request has to be Meta-signed (the verdict
    // comes from the caller, or from the evidence it passed). Not applied = false, as for a START that never consented.
    const verdict = signature !== undefined ? signature : (evidence && evidence.signature);
    if (requireSignature() && verdict !== 'valid') return false;
    const out = await recordCustomerOptIn({
      customer, method: 'whatsapp_start_command', source: 'START after opt-out', workspaceId, evidence,
    });
    return out.duplicate ? { duplicate: true, customer } : true;
  }
  if (!customer.marketingConsent) return false;
  try {
    await recordConsentEvent({ workspaceId, customer, type: 'consent_reinstated', method, source, performedBy, evidence });
  } catch (err) {
    if (!isRedelivery(err, evidence)) throw err;
    return { duplicate: true, customer };
  }
  customer.optedOut = false;
  customer.optedOutAt = null;
  await customer.save();
  return true;
}

// Logs the event (no customer change). Returns the event, or { duplicate: true } for a redelivery.
async function declineMarketingConsent({ customer, method, source, performedBy, workspaceId, evidence }) {
  try {
    return await recordConsentEvent({ workspaceId, customer, type: 'consent_declined', method, source, performedBy, evidence });
  } catch (err) {
    if (!isRedelivery(err, evidence)) throw err;
    return { duplicate: true };
  }
}

// Method A carrier — sends a utility confirmation (order/booking) as a plain
// text message, UNLESS the customer hasn't yet been asked for marketing
// consent, in which case the same body rides as an interactive button message
// offering "Yes, sign me up" / "No thanks". Asked at most once per customer
// (marketingConsentAskedAt), regardless of which of the 5 call sites fires
// first. Used by shared/operations.js#createOrder/confirmBooking and
// server.js's payment-success/points-redemption/cash-booking confirmations.
async function sendUtilityMessageWithConsentAsk({ customer, workspaceId, body, localized }) {
  // Arabic localisation (shared/localization/utilitySend.js): a customer of a flagged merchant whose language is Arabic gets the
  // Arabic notice instead. Callers pass `localized` only when they have an Arabic version; English callers (and every customer
  // who is not Arabic, or when the feature is off) fall through to the unchanged code below. A flagged error means an Arabic
  // send was attempted and failed: it is rethrown, never retried in English.
  if (localized) {
    try {
      const out = await require('./localization/utilitySend').sendNotice({ customer, workspaceId, localized, withConsentAsk: true, body });
      if (out) return out.result;
    } catch (err) { if (err && err.localizedSendFailed) throw err; }
  }
  if (!customer.marketingConsent && !customer.marketingConsentAskedAt) {
    try {
      const result = await waPost({
        messaging_product: 'whatsapp', to: customer.phone, type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: `${body}\n\nWould you like occasional offers & updates from us on WhatsApp?` },
          action: { buttons: [
            { type: 'reply', reply: { id: `consent_yes_${customer._id}`, title: 'Yes, sign me up' } },
            { type: 'reply', reply: { id: `consent_no_${customer._id}`,  title: 'No thanks' } },
          ] },
        },
      });
      await Customer.findByIdAndUpdate(customer._id, { marketingConsentAskedAt: new Date() });
      return result;
    } catch (err) {
      // Interactive session sends can fail outside the 24h window (e.g.
      // confirmBooking firing hours after the customer's own message) — never
      // let the consent ask block or replace the core utility confirmation.
      console.error('[consent] interactive consent-ask send failed, falling back to plain text:', err.message);
    }
  }
  return waPost({ messaging_product: 'whatsapp', to: customer.phone, type: 'text', text: { body } });
}

module.exports = {
  MARKETING_ELIGIBLE_QUERY,
  canSendMarketing,
  deriveConsentStatus,
  grantMarketingConsent,
  recordCustomerOptIn,
  withdrawMarketingConsent,
  reinstateMarketingConsent,
  declineMarketingConsent,
  sendUtilityMessageWithConsentAsk,
  requireSignature,
  signatureSetupProblem,
};
