'use strict';
// Campaign planner (spec §3.2, §4): the PREVIEW the merchant sees before sending
// and the decision the sender re-takes at send time. Pure given its inputs —
// the audience provider, settings and models are injected (realDeps), so it is
// fully unit-testable and deterministic (customers are processed in _id order).
//
// Never silently wrong (spec §3.2):
//   * explicit `en` / `ar` modes BLOCK a customer whose language has no usable
//     variant (an unusable variant = not Meta-APPROVED, or Arabic/bilingual not
//     yet `reviewed` by a native reader — variantSelection.checkSendable);
//   * `per_customer` falls back customer -> merchant default -> English and
//     LISTS every fallback with its reason ("42 customers will receive English
//     because no approved Arabic version exists"); `bilingual` falls back to the
//     per-customer rule, again with a reason;
//   * `needsAcknowledgement` is true as soon as any fallback or blocked
//     recipient exists — the sender refuses (PLAN_NEEDS_ACK) without it.
//
// Merge fields: `name` (first name), `full_name`, `points` and `business` are
// filled per customer/workspace; everything else must come from `fieldValues`
// (missing ones are reported in `missingFieldValues` and block the send).
//   * {name}: a customer's first name — or a neutral catalogue fallback when it
//     has no letter in it. Customers auto-created by the WhatsApp inbox without a
//     profile name carry their PHONE NUMBER as first name; a message saying
//     "Hi 966501234567" must never go out.
//   * {business}: an explicit `fieldValues.business` wins, then Settings.merchantName,
//     then Workspace.name unless it is the auto-generated "<x>'s Workspace". If none
//     exists it is reported as a missing field value like any other.
//
// EFFECTIVE CATEGORY (live-Meta finding + the UTILITY floor): Meta re-classified both
// UTILITY templates this app ever submitted to MARKETING. Consent gating and audience
// eligibility therefore use `metaCategory || category` — in practice: MARKETING unless the
// template is UTILITY AND no variant reports a non-UTILITY metaCategory (the
// stricter of the two wins; a UTILITY->MARKETING flip adds the category_changed
// warning). On top of that sits the UTILITY FLOOR (category.js): only the transactional
// use cases (payment_reminder, booking_confirmation, booking_reminder, order_confirmation)
// can ever be UTILITY; for every other use case the effective category is MARKETING
// whatever was requested or reported, so a merchant cannot bypass marketing consent by
// labelling a promotion "UTILITY" (a stored or Meta-reported UTILITY on such a template
// adds the category_floored warning). The consent request itself (use case welcome_optin) is the
// exemption: it may go to customers who have not consented (audience.js header).
//
// MARKETING compliance guard (spec §3.4): a MARKETING message must carry the
// opt-out button, so a variant that would be used but has none makes the whole
// campaign unsendable (warning marketing_variant_missing_opt_out). A consent
// request is exempt: its buttons are the opt-in / decline pair.
//
// LRM at send time: wrapping Latin/number parameter values in LRM is OFF by default
// (Meta's own Arabic templates carry no direction marks and the effect on delivery
// is unprobed); LOCALIZATION_WRAP_PARAM_LRM=1 turns it on. The wrapping lives in ONE
// place — metaTemplates.buildSendComponents — so the sender hands it plain values;
// previews (sampleRecipients) always isolate.
//
// Plan warning codes (UI maps `campaigns.warning.<code>`): template_archived,
// marketing_variant_missing_opt_out {language}, audience_ids_not_found {count},
// duplicate_phones_skipped {count}, category_changed {from, to, language},
// category_floored {useCase} (the stored category is UTILITY, or Meta reports UTILITY, but
// the use case is not transactional, so the template is treated as MARKETING), large_audience {count}
// (> 250 recipients: messaging tier TIER_250 caps unique customers per 24 h),
// consent_request_skipped {alreadyConsented, askedRecently}.
const { planAudience, checkSendable, findVariant, LANGUAGE_MODES } = require('./variantSelection');
const { extractFields, sanitizeValue, renderMessageSafe } = require('./mergeFields');
const { isTransactionalUseCase } = require('./category');
const audience = require('./audience');

const { httpError, asObjectId, isPlainObject, normalizeAudienceSpec, resolveAudience } = audience;

const MAX_FIELD_KEYS = 30;
const MAX_FIELD_VALUE = 500;
const MAX_FIELD_NAME = 64;
const FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const NEWLINE_OR_TAB_RE = /[\r\n\t\u{2028}\u{2029}]/u;
// Directional embeddings/overrides/isolates: a customer-controlled name must not
// be able to reorder the text around it (a WhatsApp profile name is arbitrary).
const BIDI_SPOOF_RE = /[\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
const NAME_MAX = 60;
const FULL_NAME_MAX = 90;
const AUTO_FILLED = Object.freeze(['name', 'full_name', 'points', 'business']);
const LANGUAGES = Object.freeze(['en', 'ar', 'bilingual']);
const MAX_SAMPLES = 3;
const LARGE_AUDIENCE = 250;
const CONSENT_REQUEST_USE_CASE = 'welcome_optin';

function realDeps() {
  return {
    ...audience.realDeps(),
    LocalizedTemplate: require('../../models/LocalizedTemplate'),
    Settings: require('../../models/Settings'),
    Workspace: require('../../models/Workspace'),
    settings: require('./settings'),
    catalog: require('./catalog'),
  };
}

function hasOwn(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function nonBlank(value) {
  return typeof value === 'string' && sanitizeValue(value) !== '';
}

// ── request validation ──────────────────────────────────────────────────────

// -> plain { field: 'value' } with checked names and single-line values.
// Auto-filled fields are accepted here but never used (except `business`).
function normalizeFieldValues(raw) {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw httpError(400, 'INVALID_INPUT', 'fieldValues must be an object');
  const keys = Object.keys(raw);
  if (keys.length > MAX_FIELD_KEYS) throw httpError(400, 'INVALID_INPUT', `fieldValues may contain at most ${MAX_FIELD_KEYS} fields`);
  const out = {};
  for (const key of keys) {
    if (key.length > MAX_FIELD_NAME || !FIELD_KEY_RE.test(key)) {
      throw httpError(400, 'INVALID_INPUT', `Invalid field name "${key.slice(0, 40)}"`);
    }
    let value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (typeof value !== 'string') throw httpError(400, 'INVALID_INPUT', `Value of field "${key}" must be text`);
    if (value.length > MAX_FIELD_VALUE) throw httpError(400, 'INVALID_INPUT', `Value of field "${key}" is too long (max ${MAX_FIELD_VALUE} characters)`);
    if (NEWLINE_OR_TAB_RE.test(value)) throw httpError(400, 'INVALID_INPUT', `Value of field "${key}" cannot contain line breaks or tabs`);
    out[key] = sanitizeValue(value);
  }
  return out;
}

// body: { templateId, languageMode?, audience, fieldValues? } (name is the facade's business)
function normalizePlanRequest(body) {
  const b = isPlainObject(body) ? body : {};
  const templateId = asObjectId(b.templateId, 'templateId');
  let languageMode = 'per_customer';
  if (b.languageMode !== undefined) {
    if (typeof b.languageMode !== 'string' || !LANGUAGE_MODES.includes(b.languageMode)) {
      throw httpError(400, 'INVALID_INPUT', `languageMode must be one of: ${LANGUAGE_MODES.join(', ')}`);
    }
    languageMode = b.languageMode;
  }
  return { templateId, languageMode, audience: normalizeAudienceSpec(b.audience), fieldValues: normalizeFieldValues(b.fieldValues) };
}

// ── merge-field values ──────────────────────────────────────────────────────

function hasLetter(text) { return /\p{L}/u.test(text); }

function personText(raw, max) {
  const text = sanitizeValue(String(raw === undefined || raw === null ? '' : raw).replace(BIDI_SPOOF_RE, ''));
  return Array.from(text).slice(0, max).join('').trim();
}

function displayName(customer) {
  const first = personText(customer.firstname, NAME_MAX);
  const last = personText(customer.lastname, NAME_MAX);
  return [first, last].filter(Boolean).join(' ') || String(customer.phone || '');
}

// The language whose catalogue text stands in for a missing name: the variant's
// own language (a bilingual variant uses the language it starts with).
function leadLanguage(variant) {
  if (variant.language === 'bilingual') return variant.bilingualOrder === 'en_first' ? 'en' : 'ar';
  return variant.language === 'ar' ? 'ar' : 'en';
}

// Language used to isolate Latin/number values inside the PREVIEW text.
function protectionLanguage(variant) {
  return variant.language === 'en' ? 'en' : 'ar';
}

// metaCategory || category, strictest wins, then the UTILITY floor (see the header).
// -> 'MARKETING' | 'UTILITY'. UTILITY needs ALL of: a transactional use case, a stored
// category of UTILITY and no variant that Meta reports as anything but UTILITY.
function effectiveCategory(template) {
  if (!isTransactionalUseCase(template.useCase)) return 'MARKETING';
  if (template.category !== 'UTILITY') return 'MARKETING';
  const flipped = (template.variants || []).some((v) => v && v.metaCategory && String(v.metaCategory).toUpperCase() !== 'UTILITY');
  return flipped ? 'MARKETING' : 'UTILITY';
}

function isConsentRequest(template) { return template.useCase === CONSENT_REQUEST_USE_CASE; }

function requiresOptOut(category, template) { return category === 'MARKETING' && !isConsentRequest(template); }

function variantFieldNames(variant) {
  return extractFields(`${(variant && variant.header) || ''}\n${(variant && variant.body) || ''}`);
}

function hasOptOutButton(variant) {
  return !!variant && Array.isArray(variant.buttons) && variant.buttons.some((b) => b && b.role === 'opt_out');
}

function hasConsentButtons(variant) {
  const roles = !!variant && Array.isArray(variant.buttons) ? variant.buttons.map((b) => b && b.role) : [];
  return roles.includes('opt_in') && roles.includes('decline');
}

// The consent-request exemption (audience.js: reaches customers who have NOT consented) is only
// earned by a message that IS the ask, i.e. carries the opt-in AND decline buttons. A
// `welcome_optin` template whose version has neither (promotional text, only an opt-out button, no
// buttons at all) would otherwise be a marketing message to non-consented customers.
// -> true when this variant may not be sent: a consent request without its two buttons, or any
// other MARKETING message without the opt-out button.
function lacksRequiredButtons(category, template, variant) {
  if (isConsentRequest(template)) return !hasConsentButtons(variant);
  return requiresOptOut(category, template) && !hasOptOutButton(variant);
}

// -> { values: { field: 'raw text' } (null-prototype), missing: [field] } for ONE
// customer and the fields one variant uses.
function valuesForVariant({ customer, variant, fieldValues, business, catalog }) {
  const first = hasLetter(personText(customer.firstname, NAME_MAX)) ? personText(customer.firstname, NAME_MAX) : '';
  const last = personText(customer.lastname, NAME_MAX);
  const fallbackName = catalog.t(leadLanguage(variant), 'campaigns.nameFallback');
  const points = Math.max(0, Math.round(Number(customer.loyaltyPoints) || 0));
  const auto = {
    name: first || fallbackName,
    full_name: first ? Array.from([first, hasLetter(last) ? last : ''].filter(Boolean).join(' ')).slice(0, FULL_NAME_MAX).join('') : fallbackName,
    points: String(points),
  };
  const values = Object.create(null);
  const missing = [];
  for (const field of variantFieldNames(variant)) {
    let value;
    if (field === 'business') value = nonBlank(fieldValues.business) ? fieldValues.business : business;
    else if (hasOwn(auto, field)) value = auto[field];
    else value = hasOwn(fieldValues, field) ? fieldValues[field] : undefined;
    if (nonBlank(value)) values[field] = value;
    else missing.push(field);
  }
  return { values, missing };
}

async function resolveBusinessName(deps, workspaceId) {
  const settings = await deps.Settings.findOne({ workspaceId }).select('merchantName').lean();
  const fromSettings = personText(settings && settings.merchantName, 80);
  if (fromSettings) return fromSettings;
  const workspace = await deps.Workspace.findById(workspaceId).select('name').lean();
  const name = personText(workspace && workspace.name, 80);
  return name && !/'s workspace$/i.test(name) ? name : '';
}

// ── planning ────────────────────────────────────────────────────────────────

function samplePicks(recipients) {
  const chosen = [];
  const seen = new Set();
  for (const r of recipients) {
    if (chosen.length >= MAX_SAMPLES) break;
    if (r.skip || !r.pick || r.pick.blocked) continue;
    const key = `${r.pick.usedLanguage}:${r.pick.fallback}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push(r);
  }
  for (const r of recipients) {
    if (chosen.length >= MAX_SAMPLES) break;
    if (r.skip || !r.pick || r.pick.blocked || chosen.includes(r)) continue;
    chosen.push(r);
  }
  return chosen;
}

function sampleRecipientsFor({ recipients, template, fieldValues, business, catalog }) {
  return samplePicks(recipients).map((r) => {
    const variant = findVariant(template, r.pick.usedLanguage);
    const { values } = valuesForVariant({ customer: r.customer, variant, fieldValues, business, catalog });
    const language = protectionLanguage(variant);
    const preview = [variant.header, variant.body, variant.footer]
      .filter((part) => typeof part === 'string' && part.trim())
      .map((part) => renderMessageSafe(part, values, { language }).text)
      .join('\n\n');
    return { customerId: r.customer.id, name: displayName(r.customer), language: r.pick.usedLanguage, fallback: r.pick.fallback, preview };
  });
}

function blockedList(blockedReasons) {
  return Object.entries(blockedReasons)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1));
}

// Full planning result (the facade and the sender need more than the CampaignPlan):
// -> { plan, recipients: [{ customer, skip, pick }], template, request, context }
async function buildPlan({ workspaceId, request }, deps = realDeps()) {
  if (!workspaceId) throw new Error('workspaceId is required');
  const req = normalizePlanRequest(request);
  const template = await deps.LocalizedTemplate.findOne({ _id: req.templateId, workspaceId }).lean();
  if (!template) throw httpError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
  const category = effectiveCategory(template);
  const consentRequest = isConsentRequest(template);

  const [locale, business] = await Promise.all([deps.settings.getSettings(workspaceId), resolveBusinessName(deps, workspaceId)]);
  const merchantDefault = locale.defaultCustomerLanguage;
  const resolution = await resolveAudience({ workspaceId, audience: req.audience, category, consentRequest }, deps);

  const eligible = resolution.customers.filter((c) => !c.skip);
  const audiencePlan = planAudience(
    template,
    eligible.map((c) => ({ customerId: c.id, language: c.language })),
    { merchantDefault, languageMode: req.languageMode, requireNativeReview: true },
  );
  const picks = new Map(audiencePlan.perCustomer.map((p) => [p.customerId, p]));
  const recipients = resolution.customers.map((customer) => ({
    customer, skip: customer.skip, pick: customer.skip ? null : picks.get(customer.id),
  }));

  const warnings = [];
  let templateError = null;
  if (template.archived) { warnings.push({ code: 'template_archived' }); templateError = 'template_archived'; }
  // The floor acted: a non-transactional use case that is stored as UTILITY (a legacy row, or one edited around the
  // service) or that Meta reports as UTILITY is still treated as MARKETING.
  const reportedUtility = (template.variants || []).some((v) => v && String(v.metaCategory || '').toUpperCase() === 'UTILITY');
  if (!isTransactionalUseCase(template.useCase) && (template.category === 'UTILITY' || reportedUtility)) {
    warnings.push({ code: 'category_floored', detail: { useCase: typeof template.useCase === 'string' && template.useCase ? template.useCase : 'custom' } });
  }
  if (template.category === 'UTILITY' && category === 'MARKETING') {
    for (const language of LANGUAGES) {
      const variant = findVariant(template, language);
      if (variant && variant.metaCategory && String(variant.metaCategory).toUpperCase() !== 'UTILITY') {
        warnings.push({ code: 'category_changed', detail: { from: 'UTILITY', to: 'MARKETING', language } });
      }
    }
  }
  for (const language of LANGUAGES) {
    if (audiencePlan.byLanguage[language] > 0 && lacksRequiredButtons(category, template, findVariant(template, language))) {
      warnings.push({ code: 'marketing_variant_missing_opt_out', detail: { language } });
      templateError = templateError || 'marketing_variant_missing_opt_out';
    }
  }
  if (resolution.notFound > 0) warnings.push({ code: 'audience_ids_not_found', detail: { count: resolution.notFound } });
  if (resolution.skipped.duplicatePhone > 0) warnings.push({ code: 'duplicate_phones_skipped', detail: { count: resolution.skipped.duplicatePhone } });
  if (consentRequest && (resolution.skipped.alreadyConsented > 0 || resolution.skipped.askedRecently > 0)) {
    warnings.push({ code: 'consent_request_skipped', detail: { alreadyConsented: resolution.skipped.alreadyConsented, askedRecently: resolution.skipped.askedRecently } });
  }
  if (audiencePlan.usable > LARGE_AUDIENCE) warnings.push({ code: 'large_audience', detail: { count: audiencePlan.usable } });

  const missingFieldValues = [];
  for (const language of LANGUAGES) {
    if (!(audiencePlan.byLanguage[language] > 0)) continue;
    for (const field of variantFieldNames(findVariant(template, language))) {
      if (missingFieldValues.includes(field) || field === 'name' || field === 'full_name' || field === 'points') continue;
      const provided = hasOwn(req.fieldValues, field) && nonBlank(req.fieldValues[field]);
      if (!provided && !(field === 'business' && business)) missingFieldValues.push(field);
    }
  }

  const variants = LANGUAGES.map((language) => {
    const variant = findVariant(template, language);
    const sendable = checkSendable(variant, { requireNativeReview: true });
    const noOptOut = sendable.ok && lacksRequiredButtons(category, template, variant);
    return {
      language,
      present: !!variant,
      metaStatus: (variant && variant.metaStatus) || 'NOT_CREATED',
      reviewStatus: (variant && variant.reviewStatus) || 'draft',
      sendable: sendable.ok && !noOptOut,
      notSendableReason: noOptOut ? 'no_opt_out_button' : (sendable.ok ? null : sendable.reason),
      recipients: audiencePlan.byLanguage[language] || 0,
    };
  });

  const blocked = blockedList(audiencePlan.blockedReasons);
  const plan = {
    templateId: String(template._id),
    templateName: template.name,
    category,
    languageMode: req.languageMode,
    audience: { selected: resolution.selected, eligible: resolution.eligible },
    skipped: {
      noConsent: resolution.skipped.noConsent,
      optedOut: resolution.skipped.optedOut,
      demo: resolution.skipped.demo,
      invalidPhone: resolution.skipped.invalidPhone,
    },
    byLanguage: audiencePlan.byLanguage,
    fallbacks: audiencePlan.fallbacks,
    blocked,
    variants,
    missingFieldValues,
    warnings,
    canSend: audiencePlan.usable >= 1 && missingFieldValues.length === 0 && !templateError,
    needsAcknowledgement: audiencePlan.fallbacks.length > 0 || blocked.length > 0,
    sampleRecipients: sampleRecipientsFor({ recipients, template, fieldValues: req.fieldValues, business, catalog: deps.catalog }),
  };
  return { plan, recipients, template, request: req, context: { category, consentRequest, merchantDefault, business, templateError } };
}

async function planCampaign({ workspaceId, request }, deps = realDeps()) {
  return (await buildPlan({ workspaceId, request }, deps)).plan;
}

// What is persisted on the campaign: the numbers, never recipient names or the
// rendered text (customer data must not outlive an erasure inside a campaign doc).
function stripSamples(plan) {
  return { ...plan, sampleRecipients: [] };
}

module.exports = {
  AUTO_FILLED, MAX_FIELD_KEYS, MAX_FIELD_VALUE, MAX_SAMPLES, LARGE_AUDIENCE,
  realDeps, normalizeFieldValues, normalizePlanRequest, valuesForVariant, protectionLanguage, leadLanguage, effectiveCategory, isConsentRequest, requiresOptOut,
  variantFieldNames, hasOptOutButton, hasConsentButtons, lacksRequiredButtons, displayName, resolveBusinessName, buildPlan, planCampaign, stripSamples,
};
