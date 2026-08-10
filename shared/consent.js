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

async function recordConsentEvent({ workspaceId, customer, type, method, source, performedBy, campaignMessageId, importJobId }) {
  return ConsentEvent.create({
    workspaceId: workspaceId || customer.workspaceId,
    customerId: customer._id,
    phone: customer.phone,
    type, method, source, performedBy, campaignMessageId, importJobId,
  });
}

// Every write helper below logs the ConsentEvent BEFORE mutating the Customer
// document — if the process dies between the two, the customer is left
// "logged but not yet applied" (recoverable by re-running), never "applied
// but never logged" (a silent compliance gap with no record it happened).

async function grantMarketingConsent({ customer, method, source, performedBy, workspaceId, campaignMessageId, importJobId }) {
  await recordConsentEvent({ workspaceId, customer, type: 'consent_given', method, source, performedBy, campaignMessageId, importJobId });
  customer.marketingConsent = true;
  customer.marketingConsentAt = new Date();
  customer.marketingConsentMethod = method;
  await customer.save();
  return customer;
}

async function withdrawMarketingConsent({ customer, method, source, performedBy, workspaceId }) {
  await recordConsentEvent({ workspaceId, customer, type: 'consent_withdrawn', method, source, performedBy });
  customer.optedOut = true;
  customer.optedOutAt = new Date();
  await customer.save();
  return customer;
}

// Only reinstates if the customer had genuinely consented before opting out —
// never fabricates consent from a bare START reply. Returns whether it
// actually reinstated, so callers (e.g. the STOP/START webhook handler) can
// vary their reply copy accordingly.
async function reinstateMarketingConsent({ customer, method, source, performedBy, workspaceId }) {
  if (!customer.marketingConsent) return false;
  await recordConsentEvent({ workspaceId, customer, type: 'consent_reinstated', method, source, performedBy });
  customer.optedOut = false;
  customer.optedOutAt = null;
  await customer.save();
  return true;
}

async function declineMarketingConsent({ customer, method, source, performedBy, workspaceId }) {
  return recordConsentEvent({ workspaceId, customer, type: 'consent_declined', method, source, performedBy });
}

// Method A carrier — sends a utility confirmation (order/booking) as a plain
// text message, UNLESS the customer hasn't yet been asked for marketing
// consent, in which case the same body rides as an interactive button message
// offering "Yes, sign me up" / "No thanks". Asked at most once per customer
// (marketingConsentAskedAt), regardless of which of the 5 call sites fires
// first. Used by shared/operations.js#createOrder/confirmBooking and
// server.js's payment-success/points-redemption/cash-booking confirmations.
async function sendUtilityMessageWithConsentAsk({ customer, workspaceId, body }) {
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
  grantMarketingConsent,
  withdrawMarketingConsent,
  reinstateMarketingConsent,
  declineMarketingConsent,
  sendUtilityMessageWithConsentAsk,
};
