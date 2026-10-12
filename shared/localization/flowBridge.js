'use strict';
// Bridge between the live Automated Flows engine (utils/flowScheduler.js) and the
// Arabic variants authored through the Flows overlay (flowMessages.js). WIRED: the flow
// engine calls sendLocalizedFlowMessage right after its atomic claim (THE HOOK below), so only an
// Arabic-speaking customer of a flagged workspace with a ready Arabic version gets Arabic; everyone
// else gets the English message exactly as before.
//
//   resolveFlowMessage({ workspaceId, messageNodeId, customerId, fieldValues })
//     -> { templateName, languageCode, usedLanguage, bodyParams, buttonPayloads, components, templateId }
//      | null
// null always means "use the existing English path, unchanged". It is returned unless ALL of:
//   * the workspace has arabic_enabled (and LOCALIZATION_DISABLED is off);
//   * the node is an entry node of this workspace with a live (non-archived) linked template;
//   * the customer is messageable: this workspace's, not erased, not demo, marketing-consented,
//     not opted out (defence in depth: the engine already checked before its claim);
//   * the customer's resolved language (customer -> merchant default -> English) is NOT English;
//   * the variant picked for them (variantSelection.pickVariant, per_customer) is a non-English
//     one that is APPROVED by Meta and marked `reviewed` by a native reader;
//   * that variant still matches the node's buttons (flowMessages.validateFlowButtons), has
//     its Meta name AND carries a recipient-visible opt-out button (role opt_out): every Automated Flow
//     message is marketing, whatever use case the linked template was given (a UTILITY-floor use case
//     such as order_confirmation does not lift the rule), so a version without the button is never sent
//     (REASON_NO_OPT_OUT, review R2-02); and every {field} it uses can be filled for this customer.
// Pass { explain: {} } in the args to learn WHY a null was returned for this reason (explain.reason).
// It never throws and never sends anything.
//
// bodyParams follow the ARABIC variant's own positional order (toPositional of its body) and every
// field gets the value the English path would pass for it: name = first name, points = balance,
// item / price / promo_name from the promotion (shared/operations.js resolvePromoItems; the cash price is the same
// amount and currency as the English one but written the Arabic way, 45.00 ر.س, by senderValues.formatMoney); item names use a
// REVIEWED Arabic product/service translation when one exists. Arabic-friendly fallbacks replace
// the English ones ("Valued Customer" -> عميلنا العزيز) and a phone-number "first name" counts as
// no name. `components` come from metaTemplates.buildSendComponents — the same builder the template
// test-send and the campaign sender use (templates.js re-exports it) — so values are sanitised for
// WhatsApp and a missing value or dead button is refused rather than sent. Latin/number values get
// direction marks (LRM) inside Arabic text ONLY when LOCALIZATION_WRAP_PARAM_LRM=1: off by default,
// because Meta's own Arabic templates carry none (META-REALITY §4). That gate lives in the builder
// alone; this file never reads the variable (the points phrase it composes asks the builder too), so
// the bridge cannot diverge from the test-send and the campaign sender.
// Also fillable: full_name, business (Settings.merchantName). Anything else (e.g. {service} of
// a legacy booking_no_show node) must be passed in `fieldValues`; otherwise the result is null
// rather than a message with a hole in it. Payloads: flow buttons keep msgnode_<nodeId>_<position>
// (the node's own button positions), an opt_out button sends optout_<nodeId>, url buttons need none.
//
// THE HOOK (applied). In utils/flowScheduler.js processEnrollment(), right after the atomic claim
// (`if (!claimed) return;`), inside a try/catch so a load or runtime error can never burn the claim:
//
//   let localized = null;
//   try { localized = await require('../shared/localization/flowBridge').sendLocalizedFlowMessage({ flow, enrollment: claimed, customer }); } catch (_) { localized = null; }
//   if (localized && localized.record) { await CampaignMessage.create(localized.record).catch(() => {}); return; }
//
// sendLocalizedFlowMessage never throws: it returns null (the English code below runs untouched)
// unless an Arabic variant applies, in which case it sends through transport.js (honours
// LOCALIZATION_SEND_MODE=dry_run) and returns the CampaignMessage row to write - with the flow's
// workspaceId, which the engine's own rows lack (R5 2.7), so delivery/read/tap callbacks can find
// it. The kill switch and the workspace flag are checked FIRST (cached 30 s): an unflagged workspace costs
// no further read. The English entry node must be APPROVED (the English path sends only an approved node;
// an edited-and-resubmitted one must not go out in Arabic with old content). {service} of a legacy
// booking_no_show node is read lazily from the enrollment's booking (workspace-scoped).
// After the claim a send is attempted ONCE and recorded even when it fails (like the engine,
// a claimed enrollment is never retried and never falls back to English: no double sends).
// Follow-up (branching) messages are handled by followUpSender.js (server.js handleMessageNodeTap); the four
// built-in default templates have no Arabic overlay (D2 3.2: pick a Promotion to send, then localise it).
const { isObjectIdLike } = require('./scope');
const { resolveLanguage } = require('./languageDetect');
const { pickVariant } = require('./variantSelection');
const { toPositional, MissingMergeFieldError } = require('./mergeFields');
const { toWesternDigits } = require('./arabicText');
const { formatMoney } = require('./senderValues');
const { buildSendComponents, metaLanguageFor, SendComponentsError } = require('./metaTemplates');
const catalog = require('./catalog');
const { validateFlowButtons, loadOwnedNode } = require('./flowMessages');

const CUSTOMER_FIELDS = 'firstname lastname loyaltyPoints optedOut marketingConsent isDemo deletedAt phone';
const PHONE_LIKE_RE = /^\+?[\d\s().-]{7,}$/; // the Inbox names customers it only knows by number after the number
const MAX_REASON = 300;
// Internal reason code (same code the hub's version validation reports) when the Arabic variant lacks the opt-out button.
const REASON_NO_OPT_OUT = 'marketing_requires_opt_out_button';

function realDeps() {
  return {
    settings: require('./settings'),
    transport: require('./transport'),
    consent: require('../consent'),
    Flow: require('../../models/Flow'),
    Promotion: require('../../models/Promotion'),
    MessageNode: require('../../models/MessageNode'),
    LocalizedTemplate: require('../../models/LocalizedTemplate'),
    CustomerLanguage: require('../../models/CustomerLanguage'),
    Customer: require('../../models/Customer'),
    Settings: require('../../models/Settings'),
    ProductTranslation: require('../../models/ProductTranslation'),
    Booking: require('../../models/Booking'),
    Service: require('../../models/Service'),
    getCurrency: () => require('../../utils/settingsCache').getCurrency(), // the same currency the English price uses
    // shared/operations.js builds a Stripe client when loaded: only load it when a promotion's values are needed.
    get ops() { return require('../operations'); },
    log: (...args) => console.error('[localization]', ...args),
  };
}

// ── Values ────────────────────────────────────────────────────────────────
function usableName(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text && !PHONE_LIKE_RE.test(toWesternDigits(text)) ? text : '';
}

function countText(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : '0';
}

// The count inside a phrase composed here ("5 نقاط") is a Latin/number parameter value like any other,
// so it gets exactly what the shared builder gives such a value: direction marks around it only when
// LOCALIZATION_WRAP_PARAM_LRM=1 (off by default). Asking the builder, instead of reading the variable
// here, keeps ONE gate for everything this bridge sends.
function countParameter(count) {
  const [component] = buildSendComponents({ variant: { language: 'ar', body: '{n}' }, values: { n: String(count) } });
  return component.parameters[0].text;
}

// Arabic number agreement for a counted noun (CLDR): 1 نقطة واحدة, 2 نقطتان, x3..x10 نقاط, other نقطة.
// The catalogue text is read WITHOUT params: catalog.t would add its own, always-on, marks around {n}.
function arabicPointsPhrase(value) {
  const n = Number(value);
  const count = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  const lastTwo = count % 100;
  if (count === 1) return catalog.t('ar', 'flows.pointsOne');
  if (count === 2) return catalog.t('ar', 'flows.pointsTwo');
  const key = lastTwo >= 3 && lastTwo <= 10 ? 'flows.pointsFew' : 'flows.pointsMany';
  return catalog.t('ar', key).replace('{n}', () => countParameter(count));
}

// Caller-supplied values (strings / finite numbers only), prototype-safe.
function overridesFrom(fieldValues) {
  const out = Object.create(null);
  if (!fieldValues || typeof fieldValues !== 'object' || Array.isArray(fieldValues)) return out;
  for (const [key, raw] of Object.entries(fieldValues)) {
    const value = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
    if (typeof value === 'string' && value.trim()) out[key] = value;
  }
  return out;
}

async function arabicItemName(deps, workspaceId, promotion, item) {
  const kind = promotion.scope === 'services' ? 'service' : 'product';
  const translation = await deps.ProductTranslation
    .findOne({ workspaceId, kind, refId: item._id, language: 'ar', status: 'reviewed' })
    .select('name')
    .lean();
  const arabic = translation && typeof translation.name === 'string' ? translation.name.trim() : '';
  return arabic || (typeof item.name === 'string' ? item.name.trim() : '');
}

// item / price / promo_name for a promotion-owned node (the slots shared/operations.js fills from the
// promotion). A cash promotion without any item has no knowable price: left unfilled.
async function promotionValues(deps, workspaceId, promotionId, customer, needed) {
  const promotion = await deps.Promotion.findOne({ _id: promotionId, workspaceId }).populate('products').populate('services').lean();
  if (!promotion) return {};
  const isPoints = promotion.customerType === 'points';
  const items = needed.has('item') || (needed.has('price') && !isPoints) ? await deps.ops.resolvePromoItems(promotion) : [];
  const first = items && items[0];
  const out = { promo_name: promotion.name };
  if (needed.has('item')) out.item = (first && await arabicItemName(deps, workspaceId, promotion, first)) || catalog.t('ar', 'flows.fallbackItem');
  if (needed.has('price')) {
    if (isPoints) out.price = arabicPointsPhrase(promotion.pointsPrice);
    else if (first) {
      // The English path writes "45.00 SAR" (ops.buildPromoEntryNodeParams); an Arabic message writes "45.00 ر.س"
      // (R5-6, GLOSSARY): the same amount (base price less the discount) and currency, Arabic currency formatting.
      const amount = +(Number(first.basePrice) * (1 - (Number(promotion.discountPercent) || 0) / 100)).toFixed(2);
      const price = formatMoney(amount, await deps.getCurrency(), 'ar');
      if (price) out.price = price;
    }
  }
  return out;
}

// field -> raw value for exactly the fields the variant uses (caller values win).
async function collectValues(deps, { workspaceId, owner, node, customer, needed, fieldValues, fieldValuesFor }) {
  const values = Object.create(null);
  const overrides = overridesFrom(fieldValues);
  for (const field of needed) if (overrides[field] !== undefined) values[field] = overrides[field];
  // Lazily computed extras (e.g. {service} of a booking no-show flow): asked for only while some needed field is
  // still open; caller-supplied fieldValues win. (needed) -> { field: value }.
  if (typeof fieldValuesFor === 'function' && Array.from(needed).some((field) => values[field] === undefined)) {
    const extra = overridesFrom(await fieldValuesFor(needed));
    for (const field of needed) if (values[field] === undefined && extra[field] !== undefined) values[field] = extra[field];
  }
  const open = (field) => needed.has(field) && values[field] === undefined;
  const set = (field, value) => { if (typeof value === 'string' && value.trim()) values[field] = value; };

  const first = usableName(customer.firstname);
  if (open('name')) set('name', first || catalog.t('ar', 'flows.fallbackName'));
  if (open('full_name')) set('full_name', first ? `${first} ${usableName(customer.lastname)}`.trim() : catalog.t('ar', 'flows.fallbackName'));
  if (open('points')) set('points', countText(customer.loyaltyPoints));
  if (open('business')) {
    const settings = await deps.Settings.findOne({ workspaceId }).select('merchantName').lean();
    set('business', settings && settings.merchantName);
  }
  if (owner.kind === 'promotion' && ['item', 'price', 'promo_name'].some(open)) {
    const derived = await promotionValues(deps, workspaceId, node.ownerId, customer, needed);
    for (const [field, value] of Object.entries(derived)) if (open(field)) set(field, value);
  }
  return values;
}

// {service} for a flow whose trigger is a booking (the legacy booking_no_show entry message): the booking's
// service name, in its REVIEWED Arabic translation when one exists, else the service's own name, else the
// Arabic fallback. A booking that cannot be found in this workspace yields nothing (the field stays open, so the
// caller falls back to English exactly as the English path, which fails on a missing booking, would).
async function serviceFieldValue(deps, { workspaceId, bookingId } = {}) {
  if (!isObjectIdLike(workspaceId) || !isObjectIdLike(bookingId)) return {};
  const booking = await deps.Booking.findOne({ _id: bookingId, workspaceId }).select('serviceId').lean();
  if (!booking) return {};
  let name = '';
  if (isObjectIdLike(booking.serviceId)) {
    const translation = await deps.ProductTranslation
      .findOne({ workspaceId, kind: 'service', refId: booking.serviceId, language: 'ar', status: 'reviewed' })
      .select('name')
      .lean();
    name = translation && typeof translation.name === 'string' ? translation.name.trim() : '';
    if (!name) {
      const service = await deps.Service.findOne({ _id: booking.serviceId, workspaceId }).select('name').lean();
      name = service && typeof service.name === 'string' ? service.name.trim() : '';
    }
  }
  return { service: name || catalog.t('ar', 'flows.fallbackService') };
}

// ── Template target and button payloads ───────────────────────────────────
// What was submitted to Meta: the stored name/language win (the same rule as the template test-send).
function metaTarget(variant) {
  const templateName = typeof variant.metaTemplateName === 'string' ? variant.metaTemplateName : '';
  const languageCode = (typeof variant.metaLanguage === 'string' && variant.metaLanguage) || metaLanguageFor(variant);
  return templateName && languageCode ? { templateName, languageCode } : null;
}

// Payloads aligned with variant.buttons (the shape buildSendComponents takes). Flow buttons carry the
// node's OWN button positions; nothing but flow / opt-out / url buttons can exist here (null otherwise).
function buttonPayloadsFor(variant, node) {
  const nodeButtons = node.buttons || [];
  const payloads = [];
  let flowIndex = 0;
  for (const button of Array.isArray(variant.buttons) ? variant.buttons : []) {
    if (button.role === 'flow_button') {
      const nodeButton = nodeButtons[flowIndex];
      flowIndex += 1;
      if (!nodeButton) return null;
      payloads.push(`msgnode_${node._id}_${nodeButton.position}`);
    } else if (button.role === 'opt_out') {
      payloads.push(`optout_${node._id}`);
    } else if (button.role === 'url') {
      payloads.push(undefined); // a static link: Meta needs no component for it
    } else {
      return null;
    }
  }
  return payloads;
}

// ── Resolution ────────────────────────────────────────────────────────────
async function oldestLiveTemplate(deps, workspaceId, nodeId) {
  const docs = await deps.LocalizedTemplate.find({ workspaceId, linkedMessageNodeId: nodeId, archived: { $ne: true } }).lean();
  return docs.sort((a, b) => (String(a._id) < String(b._id) ? -1 : 1))[0] || null;
}

// A flow message is always marketing: the variant must carry the opt_out quick reply the customer can tap.
function hasOptOutButton(variant) {
  return !!variant && Array.isArray(variant.buttons) && variant.buttons.some((b) => b && b.role === 'opt_out');
}

function isMessageable(deps, customer) {
  return !!customer && !customer.deletedAt && !customer.isDemo && deps.consent.canSendMarketing(customer);
}

async function resolve(args, deps) {
  const { workspaceId, messageNodeId, customerId } = args;
  const explain = args.explain && typeof args.explain === 'object' ? args.explain : null;
  if (![workspaceId, messageNodeId, customerId].every(isObjectIdLike)) return null;
  const ws = String(workspaceId);
  if (deps.settings.killSwitchOn() || !(await deps.settings.isArabicEnabled(ws))) return null;

  const template = await oldestLiveTemplate(deps, ws, String(messageNodeId));
  if (!template) return null;

  const customer = await deps.Customer.findOne({ _id: customerId, workspaceId: ws }).select(CUSTOMER_FIELDS).lean();
  if (!isMessageable(deps, customer)) return null;

  const stored = await deps.CustomerLanguage.findOne({ workspaceId: ws, customerId }).select('language').lean();
  const customerLanguage = stored && stored.language;
  const merchantDefault = (await deps.settings.getSettings(ws)).defaultCustomerLanguage;
  // An English customer is never routed to another language, whatever state the English mirror variant is in.
  if (resolveLanguage(customerLanguage, merchantDefault) === 'en') return null;

  const pick = pickVariant(template, { customerLanguage, merchantDefault, languageMode: 'per_customer', requireNativeReview: true });
  const variant = pick.variant;
  if (!variant || pick.usedLanguage === 'en') return null;
  const target = metaTarget(variant);
  if (!target) return null;

  const owned = await loadOwnedNode(deps, ws, String(messageNodeId));
  if (!owned || !owned.owner || !owned.node.isEntryNode) return null;
  const { node, owner } = owned;
  // English parity: the English path sends only an APPROVED entry node (an edited, resubmitted one is pending).
  if (node.templateStatus !== 'approved') return null;
  if (validateFlowButtons(template, variant, { nodeButtons: node.buttons }).length) return null;
  if (!hasOptOutButton(variant)) {
    if (explain) explain.reason = REASON_NO_OPT_OUT;
    return null;
  }
  const buttonPayloads = buttonPayloadsFor(variant, node);
  if (!buttonPayloads) return null;

  const needed = new Set([...toPositional(variant.header || '').params, ...toPositional(variant.body || '').params]);
  const values = await collectValues(deps, { workspaceId: ws, owner, node, customer, needed, fieldValues: args.fieldValues, fieldValuesFor: args.fieldValuesFor });
  let components;
  try {
    components = buildSendComponents({ variant, values, buttonPayloads });
  } catch (err) {
    // A value nobody can fill / a dead button: never send a message with a hole in it.
    if (err instanceof MissingMergeFieldError || err instanceof SendComponentsError) return null;
    throw err;
  }
  const body = components.find((c) => c.type === 'body');
  return {
    templateName: target.templateName,
    languageCode: target.languageCode,
    usedLanguage: pick.usedLanguage,
    bodyParams: body ? body.parameters.map((p) => p.text) : [],
    buttonPayloads: buttonPayloads.filter((p) => typeof p === 'string'),
    components,
    templateId: String(template._id),
  };
}

async function resolveFlowMessage(args, deps = realDeps()) {
  try {
    return await resolve(args || {}, deps);
  } catch (err) {
    (deps.log || console.error)('flow message resolution failed (the English path continues):', err && err.message);
    return null;
  }
}

// ── Sending (what the hook calls) ─────────────────────────────────────────
// The node the engine would send for this flow: the promotion's entry node when the flow has a
// promotionId (and ONLY that), else the legacy flow.entryNodeId; null for the built-in templates.
async function entryNodeIdOf(deps, flow, workspaceId) {
  if (flow.promotionId) {
    const promotion = await deps.Promotion.findOne({ _id: flow.promotionId, workspaceId }).select('entryNodeId').lean();
    return promotion && promotion.entryNodeId ? String(promotion.entryNodeId) : null;
  }
  return flow.entryNodeId ? String(flow.entryNodeId) : null;
}

function failureReason(err) {
  const meta = err && err.response && err.response.data && err.response.data.error;
  return String((meta && meta.message) || (err && err.message) || 'Send failed').slice(0, MAX_REASON);
}

function safeWamid(deps, result) {
  try { return deps.transport.extractWamid(result); } catch (err) { return undefined; }
}

// {service} source for the one trigger whose legacy entry node needs it (booking_no_show, no Promotion).
function fieldValuesForFlow(deps, flow, enrollment, workspaceId) {
  if (flow.triggerType !== 'booking_no_show' || flow.promotionId || enrollment.sourceModel !== 'Booking') return undefined;
  return (needed) => (needed.has('service') ? serviceFieldValue(deps, { workspaceId, bookingId: enrollment.sourceRef }) : {});
}

// -> null (the English path runs) | { record, sent, dryRun, templateName, usedLanguage }.
// From the moment the send is attempted nothing below can throw, so a null can never follow a real send.
async function sendLocalizedFlowMessage(args, deps = realDeps()) {
  const { flow, enrollment, customer } = args || {};
  let loc;
  let nodeId;
  let workspaceId;
  try {
    if (!flow || !enrollment || !customer || !isObjectIdLike(flow.workspaceId)) return null;
    workspaceId = String(flow.workspaceId);
    // The kill switch and the workspace flag come FIRST (cached 30 s): an unflagged workspace costs no further read.
    if (deps.settings.killSwitchOn() || !(await deps.settings.isArabicEnabled(workspaceId))) return null;
    nodeId = await entryNodeIdOf(deps, flow, workspaceId);
    if (!nodeId) return null;
    loc = await resolveFlowMessage({ workspaceId, messageNodeId: nodeId, customerId: customer._id, fieldValuesFor: fieldValuesForFlow(deps, flow, enrollment, workspaceId) }, deps);
    if (!loc) return null;
  } catch (err) {
    (deps.log || console.error)('localized flow send skipped (the English path continues):', err && err.message);
    return null;
  }

  let result;
  let failure;
  let sent = true;
  try {
    result = await deps.transport.sendTemplate(customer.phone, { name: loc.templateName, languageCode: loc.languageCode, components: loc.components });
  } catch (err) {
    sent = false; // not derived from `err`: anything can be thrown, including a falsy value
    failure = err;
  }
  return {
    sent,
    dryRun: !!(result && result.dryRun),
    templateName: loc.templateName,
    usedLanguage: loc.usedLanguage,
    record: {
      workspaceId,
      kind: 'flow',
      flow: flow._id,
      flowEnrollment: enrollment._id,
      promotion: flow.promotionId || undefined,
      customer: customer._id,
      phone: customer.phone,
      wamid: sent ? safeWamid(deps, result) : undefined,
      messageType: 'template',
      templateName: loc.templateName,
      messageNode: nodeId,
      status: sent ? 'sent' : 'failed',
      statusReason: sent ? undefined : failureReason(failure),
      sentAt: new Date(),
    },
  };
}

module.exports = { REASON_NO_OPT_OUT, resolveFlowMessage, sendLocalizedFlowMessage, arabicPointsPhrase, collectValues, usableName, serviceFieldValue, realDeps };
