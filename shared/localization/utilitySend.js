'use strict';
// Arabic SESSION notices for the existing booking / order senders (D1 section 3.4): shared/operations.js
// confirmBooking, rescheduleBooking, declineBooking, cancelBooking and createOrder, and (through the optional
// `localized` argument of shared/consent.js#sendUtilityMessageWithConsentAsk) the four server.js confirmations the
// webhook sends (D3 passes its own catalogue keys).
//
//   sendNotice({ customer | customerId, workspaceId, phone?, localized, withConsentAsk?, refId? })
//     -> null                          not applicable: kill switch / flag off / the customer is not Arabic / the catalogue
//                                      has no Arabic text / a value could not be filled -> the caller's English path runs
//     -> { result, via }               sent (via: 'interactive' | 'session' | 'template')
//     -> throws err.localizedSendFailed = true   a send WAS attempted and failed: the caller must NOT fall through to
//                                      English (no double or wrong-language messages); the caller's own best-effort
//                                      try/catch handles it exactly as it handles an English failure.
//
//   localized = { key, values: (language) => object | Promise<object>, buttons?: [{ id, titleKey }], templateFallback? }
//   `values` is a closure so English never evaluates it and the caller never needs to know the language. The text is
//   the catalogue entry `<key>.ar` with the values filled in (Latin/number values isolated with LRM, links left alone,
//   line breaks of a value kept): every Arabic string is a `draft` (G1: served to flagged merchants'
//   Arabic customers; LOCALIZATION_ALLOW_DRAFT_SESSION=0 requires reviewed copy).
//
// MIRROR of the English semantics, with the 24-hour window handled by Meta's answer instead of a pre-check:
//   (1) consent-ask carrier - only when !marketingConsent && !marketingConsentAskedAt (the English condition; an
//       opted-out customer is never asked): an interactive message carrying the Arabic ask
//       (consentAsk.buildConsentAsk) and consent_yes_/consent_no_<customerId> buttons; on success the ask is stamped
//       (marketingConsentAskedAt, workspace-scoped; not in a dry run); on failure the notice goes as plain text;
//   (2) plain Arabic text (or the interactive rebook button of the cancelled-booking notice, text on failure);
//   (3) when (2) fails with Meta 131047 (outside the 24-hour window) and `templateFallback` maps to an approved +
//       reviewed UTILITY template (only booking_confirmation) that needs nothing but name / service / date / time /
//       business, that template is sent instead. Every other failure is rethrown.
const { isObjectIdLike } = require('./scope');
const { resolveLanguage } = require('./languageDetect');
const { fillFields } = require('./sessionBidi');
const { LIMITS } = require('./metaConstraints');
const { findVariant, checkSendable } = require('./variantSelection');
const { buildSendComponents } = require('./metaTemplates');
const planner = require('./campaignPlanner');
const consentAsk = require('./consentAsk');
const catalog = require('./catalog');
const senderValues = require('./senderValues');
const sender = require('./campaignSender');

const MAX_TEXT = 4096; // WhatsApp text message limit
const OUTSIDE_WINDOW_CODE = '131047';
const TEMPLATE_FALLBACKS = Object.freeze({
  booking_confirmation: Object.freeze({ useCase: 'booking_confirmation', fields: Object.freeze(['name', 'service', 'date', 'time', 'business']) }),
});
const BIDI_SPOOF_RE = /[\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
const CONTROL_RE = /[\u{0000}-\u{0009}\u{000B}-\u{001F}\u{007F}-\u{009F}]/gu; // every control character except \n

function realDeps() {
  return {
    ...planner.realDeps(),
    transport: require('./transport'),
    Customer: require('../../models/Customer'),
    CustomerLanguage: require('../../models/CustomerLanguage'),
    LocalizedLegacySend: require('../../models/LocalizedLegacySend'),
    now: () => Date.now(),
    log: (...args) => console.error('[localization]', ...args),
  };
}

function wsKey(value) { return value ? String(value) : ''; }

function arabicEntry(key) {
  const entry = typeof key === 'string' ? catalog.load().get(key) : null;
  return entry && entry.ar ? entry : null;
}

function draftAllowed(entries) {
  if (process.env.LOCALIZATION_ALLOW_DRAFT_SESSION !== '0') return true;
  return entries.every((entry) => entry && entry.status === 'reviewed');
}

// {field} -> value. A field without a value stays in place (the caller refuses such a message).
// Direction marks follow the ONE session rule of sessionBidi.js (none next to the * / _ of a bold or italic pair).
function renderSession(raw, values) {
  const { text, missing } = fillFields(raw, (name) => {
    const given = values && Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
    if (given === undefined || given === null || String(given).trim() === '') return null;
    const clean = String(given).replace(/\r\n?/g, '\n').replace(BIDI_SPOOF_RE, '').replace(CONTROL_RE, ' ').trim();
    if (!clean) return null;
    return { value: clean, isolate: !(/^https?:\/\//i.test(clean) || clean.includes('\n')) };
  });
  return { text, missing: missing.length > 0 };
}

function failure(err) {
  const flagged = err && typeof err === 'object' ? err : new Error(String(err));
  flagged.localizedSendFailed = true;
  return flagged;
}

async function resolveCustomer(args, deps) {
  if (args.customer && args.customer._id) return args.customer;
  if (!isObjectIdLike(args.customerId)) return null;
  const filter = { _id: args.customerId };
  if (isObjectIdLike(args.workspaceId)) filter.workspaceId = args.workspaceId;
  return deps.Customer.findOne(filter).select('workspaceId firstname lastname phone marketingConsent marketingConsentAskedAt optedOut isDemo deletedAt').lean();
}

async function writeRow(deps, row) {
  try { await deps.LocalizedLegacySend.create({ requestedLanguage: 'ar', usedLanguage: 'ar', runId: row.runId, ...row }); } catch (err) {
    deps.log('could not write the notice language row (ignored):', err && err.message);
  }
}

// Stored error text never carries a phone number (review R4-3): any run of 7+ digits (with the usual separators) is masked.
const PHONE_LIKE = /\+?\d(?:[ ().-]?\d){6,}/g;
function plainError(err) {
  const text = err && err.message !== undefined ? err.message : err;
  return String(text === undefined || text === null ? '' : text).replace(PHONE_LIKE, '[number]').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function errorCodeOf(err) {
  try { return sender.describeSendError(err).code; } catch (e) { return 'send_failed'; }
}

// The approved + reviewed UTILITY template that stands in for a plain text outside the 24-hour window.
async function findFallbackTemplate(deps, ws, fallbackKey) {
  const spec = TEMPLATE_FALLBACKS[fallbackKey];
  if (!spec) return null;
  const docs = await deps.LocalizedTemplate.find({ workspaceId: ws, useCase: spec.useCase, archived: { $ne: true } }).lean();
  const sorted = docs
    .filter((t) => !t.linkedMessageNodeId && !t.linkedPromotionId)
    .sort((a, b) => (new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()) || (String(b._id) < String(a._id) ? -1 : 1));
  for (const template of sorted) {
    const variant = findVariant(template, 'ar');
    if (!variant || !checkSendable(variant, { requireNativeReview: true }).ok || !variant.metaTemplateName) continue;
    if (planner.effectiveCategory(template) !== 'UTILITY') continue;
    if ((variant.buttons || []).length) continue; // a UTILITY booking confirmation carries no buttons: never send one with a dead payload
    const fields = planner.variantFieldNames(variant);
    if (fields.some((f) => !spec.fields.includes(f))) continue;
    return { template, variant, fields };
  }
  return null;
}

async function sendFallbackTemplate(deps, { ws, phone, found, values, customer }) {
  const business = await planner.resolveBusinessName(deps, ws);
  const given = Object.assign(Object.create(null), values, { name: senderValues.nameValue(customer), business });
  const components = buildSendComponents({ variant: found.variant, values: given, buttonPayloads: [] });
  return deps.transport.sendTemplate(phone, {
    name: found.variant.metaTemplateName, languageCode: (found.variant.metaLanguage || 'ar'), components,
  });
}

async function stampAsk(deps, customer, ws) {
  if (deps.transport.isDryRun()) return;
  try {
    const filter = { _id: customer._id };
    if (isObjectIdLike(ws)) filter.workspaceId = ws;
    await deps.Customer.updateOne(filter, { $set: { marketingConsentAskedAt: new Date(deps.now()) } });
  } catch (err) {
    deps.log('recording the consent ask failed (ignored):', err && err.message);
  }
}

function askEntriesReviewed() {
  return draftAllowed(['consent.askSuffix', 'consent.buttonOptIn', 'consent.buttonDecline', 'consent.footerOptOutHint'].map(arabicEntry));
}

async function sendNotice(args, deps = realDeps()) {
  let prepared;
  try {
    const { localized } = args || {};
    if (!localized || typeof localized.values !== 'function') return null;
    if (deps.settings.killSwitchOn()) return null;
    const entry = arabicEntry(localized.key);
    if (!entry || !draftAllowed([entry])) return null;

    // The flag of the workspace the caller knows (cached, read-only) comes first: unflagged merchants cost no customer read.
    const knownWs = wsKey(args.workspaceId) || wsKey(args.customer && args.customer.workspaceId);
    if (isObjectIdLike(knownWs) && !(await deps.settings.isArabicEnabled(knownWs))) return null;
    const customer = await resolveCustomer(args, deps);
    if (!customer || customer.deletedAt) return null;
    const ws = wsKey(customer.workspaceId) || wsKey(args.workspaceId);
    if (!isObjectIdLike(ws) || !(await deps.settings.isArabicEnabled(ws))) return null;

    const stored = await deps.CustomerLanguage.findOne({ workspaceId: ws, customerId: customer._id }).select('language').lean();
    const merchantDefault = (await deps.settings.getSettings(ws)).defaultCustomerLanguage;
    if (resolveLanguage(stored && stored.language, merchantDefault) !== 'ar') return null;

    const phone = (args.phone && String(args.phone)) || (customer.phone && String(customer.phone));
    if (!phone) return null;
    const values = await localized.values('ar');
    const { text, missing } = renderSession(entry.ar, values);
    if (missing || !text.trim() || Array.from(text).length > MAX_TEXT) return null;
    prepared = { customer, ws, phone, values, text, localized };
  } catch (err) {
    try { deps.log('Arabic notice skipped (the English message is used):', err && err.message); } catch (e) { /* ignore */ }
    return null;
  }

  // From here a send is attempted: nothing falls back to English any more.
  const { customer, ws, phone, values, text, localized } = prepared;
  const rowBase = { workspaceId: ws, sender: 'notice', refId: args.refId ? String(args.refId) : undefined, customerId: customer._id, runId: `notice_${Number(deps.now()).toString(36)}` };

  const needAsk = args.withConsentAsk === true && !customer.marketingConsent && !customer.marketingConsentAskedAt && !customer.optedOut && askEntriesReviewed();
  if (needAsk) {
    try {
      const ask = consentAsk.buildConsentAsk('ar', { customerId: customer._id, lead: text });
      const fits = Array.from(ask.body).length <= LIMITS.BODY && ask.buttons.every((b) => Array.from(b.title).length <= LIMITS.BUTTON_LABEL);
      if (fits) {
        const result = await deps.transport.sendButtons(phone, { body: ask.body, buttons: ask.buttons.map((b) => ({ id: b.id, title: b.title })) });
        await stampAsk(deps, customer, ws);
        await writeRow(deps, { ...rowBase, via: 'session', status: 'sent', wamid: safeWamid(deps, result) });
        return { result, via: 'interactive' };
      }
    } catch (err) {
      deps.log('Arabic consent-ask send failed, falling back to plain text:', err && err.message);
    }
  }

  let result;
  try {
    result = await sendPlain(deps, phone, text, localized);
  } catch (err) {
    if (errorCodeOf(err) === OUTSIDE_WINDOW_CODE && localized.templateFallback) {
      try {
        const found = await findFallbackTemplate(deps, ws, localized.templateFallback);
        if (found) {
          const viaTemplate = await sendFallbackTemplate(deps, { ws, phone, found, values, customer });
          await writeRow(deps, { ...rowBase, via: 'template', status: 'sent', wamid: safeWamid(deps, viaTemplate), templateId: found.template._id, metaTemplateName: found.variant.metaTemplateName });
          return { result: viaTemplate, via: 'template' };
        }
      } catch (templateErr) {
        await writeRow(deps, { ...rowBase, via: 'template', status: 'failed', errorCode: errorCodeOf(templateErr), error: plainError(templateErr) });
        throw failure(templateErr);
      }
    }
    await writeRow(deps, { ...rowBase, via: 'session', status: 'failed', errorCode: errorCodeOf(err), error: plainError(err) });
    throw failure(err);
  }
  await writeRow(deps, { ...rowBase, via: 'session', status: 'sent', wamid: safeWamid(deps, result) });
  return { result, via: 'session' };
}

// Plain text, or the interactive reply button(s) of the notice (text when the interactive send fails, like the English one).
async function sendPlain(deps, phone, text, localized) {
  const buttons = Array.isArray(localized.buttons) ? localized.buttons : [];
  if (buttons.length) {
    const prepared = buttons.map((b) => ({ id: b.id, title: catalog.t('ar', b.titleKey) }));
    const fits = Array.from(text).length <= LIMITS.BODY && prepared.every((b) => b.id && Array.from(b.title).length <= LIMITS.BUTTON_LABEL);
    if (fits) {
      try { return await deps.transport.sendButtons(phone, { body: text, buttons: prepared }); } catch (err) { /* plain text below, like the English notice */ }
    }
  }
  return deps.transport.sendText(phone, text);
}

function safeWamid(deps, result) {
  try { return deps.transport.extractWamid(result) || undefined; } catch (err) { return undefined; }
}

module.exports = { MAX_TEXT, OUTSIDE_WINDOW_CODE, TEMPLATE_FALLBACKS, realDeps, renderSession, findFallbackTemplate, sendNotice };
