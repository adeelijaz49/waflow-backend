'use strict';
// The marketing-consent ASK in the customer's language (spec §3.4): an
// interactive reply-button message with an opt-in and a decline button.
//   buildConsentAsk(language, {customerId, lead})  -> pure payload description
//   sendConsentAsk({customer, language, transport}) -> sends it + records the ask
//
// It mirrors, field for field, what the existing
// shared/consent.js#sendUtilityMessageWithConsentAsk does for English:
//   * button ids  consent_yes_<customerId> / consent_no_<customerId> — the SAME
//     prefixes the webhook already routes (server.js consent_yes_/consent_no_ and
//     inboundHook.js for Arabic), so a tap is handled by the existing consent
//     write path and nothing new is invented;
//   * the ask is recorded by setting Customer.marketingConsentAskedAt AFTER a
//     successful send (a failed send must not claim the customer was asked), and
//     asked at most once per customer, never to someone who already consented;
//     additionally never to an opted-out customer (Meta-reality rule).
// consent.js exports no helper for the recording step, so it is mirrored here
// (as a workspace-scoped updateOne) rather than changing that file.
//
// WINDOW: an interactive message is only deliverable inside the 24-hour service
// window (the customer wrote to us within 24h). Outside it the send fails; this
// module reports `send_failed` and writes nothing, and the caller falls back to
// its plain-text confirmation (or the approved consent-request template).
//
// The transport's sendButtons has no footer field, so the opt-out hint
// (consent.footerOptOutHint) is returned from buildConsentAsk for callers that can
// render it (templates) but is not part of the interactive send.
const catalog = require('./catalog');
const { LIMITS } = require('./metaConstraints');

const YES_PREFIX = 'consent_yes_';
const NO_PREFIX = 'consent_no_';

function realDeps() {
  return {
    Customer: require('../../models/Customer'),
    log: (...a) => console.error('[localization]', ...a),
  };
}

function charLength(title) { return Array.from(title).length; }

// -> { body, footer, buttons: [{ role, idPrefix, id?, title }] }
// `lead` (optional) is a preceding message body (e.g. an order confirmation) the
// ask is appended to, exactly like the English carrier does.
function buildConsentAsk(language, { customerId, lead } = {}) {
  const lang = language === 'ar' ? 'ar' : 'en';
  const ask = catalog.t(lang, 'consent.askSuffix');
  const withId = (prefix) => (customerId ? { id: `${prefix}${customerId}` } : {});
  return {
    language: lang,
    body: lead ? `${lead}\n\n${ask}` : ask,
    footer: catalog.t(lang, 'consent.footerOptOutHint'),
    buttons: [
      { role: 'opt_in', idPrefix: YES_PREFIX, ...withId(YES_PREFIX), title: catalog.t(lang, 'consent.buttonOptIn') },
      { role: 'decline', idPrefix: NO_PREFIX, ...withId(NO_PREFIX), title: catalog.t(lang, 'consent.buttonDecline') },
    ],
  };
}

// -> { sent: true, wamid? } | { sent: false, reason }
// reason: no_customer | already_consented | opted_out | already_asked | too_long | send_failed
// Never throws.
async function sendConsentAsk({ customer, language, transport, lead } = {}, deps = realDeps()) {
  try {
    if (!customer || !customer._id || !customer.phone) return { sent: false, reason: 'no_customer' };
    // Demo data never reaches Meta, and an erased customer is not contacted.
    if (customer.isDemo === true || customer.deletedAt) return { sent: false, reason: 'no_customer' };
    if (customer.marketingConsent) return { sent: false, reason: 'already_consented' };
    if (customer.optedOut) return { sent: false, reason: 'opted_out' };
    if (customer.marketingConsentAskedAt) return { sent: false, reason: 'already_asked' };

    const ask = buildConsentAsk(language, { customerId: customer._id, lead });
    if (charLength(ask.body) > LIMITS.BODY || ask.buttons.some((b) => charLength(b.title) > LIMITS.BUTTON_LABEL)) {
      return { sent: false, reason: 'too_long' };
    }

    let result;
    try {
      result = await transport.sendButtons(customer.phone, { body: ask.body, buttons: ask.buttons.map((b) => ({ id: b.id, title: b.title })) });
    } catch (err) {
      deps.log('consent ask send failed:', err && err.message);
      return { sent: false, reason: 'send_failed' };
    }

    // The message is out: record the ask. A failure here must not turn a delivered
    // ask into an error (the worst case is the customer being asked once more).
    try {
      const filter = { _id: customer._id };
      if (customer.workspaceId) filter.workspaceId = customer.workspaceId;
      await deps.Customer.updateOne(filter, { $set: { marketingConsentAskedAt: new Date() } });
    } catch (err) {
      deps.log('recording the consent ask failed:', err && err.message);
    }
    const wamid = typeof transport.extractWamid === 'function' ? transport.extractWamid(result) : undefined;
    return wamid ? { sent: true, wamid } : { sent: true };
  } catch (err) {
    try { deps.log('sendConsentAsk failed:', err && err.message); } catch (e) { /* ignore */ }
    return { sent: false, reason: 'send_failed' };
  }
}

module.exports = { YES_PREFIX, NO_PREFIX, buildConsentAsk, sendConsentAsk };
