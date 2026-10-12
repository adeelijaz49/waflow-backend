'use strict';
// Which Arabic version (a LocalizedTemplate `ar` variant) an EXISTING sender uses, and why it cannot.
// Deterministic rules, one per sender (D1 design, section 3.3):
//
//   promotion         (1) the version linked to the promotion's approved custom entry message
//                         (LocalizedTemplate.linkedMessageNodeId = promotion.entryNodeId; buttons keep the node's
//                         flow buttons, an opt_out may follow), else (2) the version linked to the promotion itself
//                         (LocalizedTemplate.linkedPromotionId; buttons shop_now + opt_out). A generic workspace-wide
//                         "promotion" template is NEVER used: it would describe a different offer.
//   loyalty_reminder  an unlinked template of use case loyalty_reminder, then points_balance (the English reminder
//                     this replaces is "template first"): MARKETING with an opt_out button.
//   consent_request   an unlinked welcome_optin template carrying BOTH the opt_in and the decline button.
//
// A candidate is USABLE when its Arabic variant is APPROVED by Meta and marked `reviewed` by a native reader
// (variantSelection.checkSendable), was submitted (has its Meta name), carries the buttons the sender needs (a
// MARKETING message needs its opt-out, planner.lacksRequiredButtons) and every merge field it uses can be filled
// by the sender (senderValues.unfillableFields). Usable beats unusable; then the rank above; then the newest
// `updatedAt`; then the _id (sorted in memory: Cosmos DB wants an index for every sort).
//
// -> { source: 'entry_node' | 'promotion' | 'none', template, variant, usable, reason, ... } where `reason` is why the
// best candidate cannot be used (no_arabic_version, a checkSendable reason, no_opt_out_button, no_consent_buttons,
// buttons_mismatch, field_values_missing:<field>) and null when it can.
const { findVariant, checkSendable } = require('./variantSelection');
const planner = require('./campaignPlanner');
const { validateFlowButtons } = require('./flowMessages');
const senderValues = require('./senderValues');

const LOYALTY_USE_CASES = Object.freeze(['loyalty_reminder', 'points_balance']);
const ROLE_SETS = Object.freeze({
  entry_node: Object.freeze(['flow_button', 'opt_out', 'url']),
  promotion: Object.freeze(['shop_now', 'opt_out', 'url']),
  loyalty_reminder: Object.freeze(['opt_out', 'url']),
  consent_request: Object.freeze(['opt_in', 'decline', 'url']),
});

function timeOf(value) {
  const t = value ? new Date(value).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

function byNewest(a, b) {
  return (timeOf(b.template.updatedAt) - timeOf(a.template.updatedAt)) || (String(b.template._id) < String(a.template._id) ? -1 : 1);
}

function isUnlinked(template) { return !template.linkedMessageNodeId && !template.linkedPromotionId; }

// Candidate templates with their rank (lower = preferred), loaded from the models. Injectable: deps.LocalizedTemplate.
async function listCandidates(deps, { workspaceId, sender, promotion, node }) {
  const live = { workspaceId, archived: { $ne: true } };
  if (sender === 'promotion') {
    const out = [];
    if (promotion && promotion.entryNodeId && node) {
      const linked = await deps.LocalizedTemplate.find({ ...live, linkedMessageNodeId: promotion.entryNodeId }).lean();
      linked.forEach((template) => out.push({ rank: 1, source: 'entry_node', template }));
    }
    if (promotion && promotion._id) {
      const linked = await deps.LocalizedTemplate.find({ ...live, linkedPromotionId: promotion._id }).lean();
      linked.forEach((template) => out.push({ rank: 2, source: 'promotion', template }));
    }
    return out;
  }
  if (sender === 'loyalty_reminder') {
    const docs = await deps.LocalizedTemplate.find({ ...live, useCase: { $in: LOYALTY_USE_CASES } }).lean();
    return docs.filter(isUnlinked).map((template) => ({ rank: LOYALTY_USE_CASES.indexOf(template.useCase) + 1, source: 'unlinked', template }));
  }
  if (sender === 'consent_request') {
    const docs = await deps.LocalizedTemplate.find({ ...live, useCase: 'welcome_optin' }).lean();
    return docs.filter(isUnlinked).map((template) => ({ rank: 1, source: 'unlinked', template }));
  }
  return [];
}

// Why this Arabic variant cannot be sent by this sender (null = it can). Pure.
function evaluate(candidate, { sender, node, available }) {
  const { template, source } = candidate;
  const variant = findVariant(template, 'ar');
  const base = {
    source, template, variant,
    templateId: String(template._id),
    templateName: template.name,
    metaStatus: (variant && variant.metaStatus) || 'NOT_CREATED',
    reviewStatus: (variant && variant.reviewStatus) || 'draft',
    hasOptOut: planner.hasOptOutButton(variant),
    hasShopButton: !!variant && (variant.buttons || []).some((b) => b && b.role === 'shop_now'),
    missingFields: [],
    notSendableReason: null,
    sendable: false,
    reason: null,
  };
  if (!variant) return { ...base, reason: 'no_arabic_version' };

  const sendable = checkSendable(variant, { requireNativeReview: true });
  if (!sendable.ok) return { ...base, notSendableReason: sendable.reason, reason: sendable.reason };
  if (!variant.metaTemplateName) return { ...base, notSendableReason: 'not_submitted', reason: 'not_submitted' };
  base.sendable = true;

  const category = planner.effectiveCategory(template);
  if (sender === 'consent_request') {
    if (!planner.hasConsentButtons(variant)) return { ...base, reason: 'no_consent_buttons' };
  } else if (planner.lacksRequiredButtons(category, template, variant)
    // A promotion send is marketing whatever the stored use case/category says: the recipient-visible opt-out button is
    // required for BOTH sources (node-linked and promotion-linked), review R2-02.
    || (sender === 'promotion' && !planner.hasOptOutButton(variant))) {
    return { ...base, reason: 'no_opt_out_button' };
  }

  const roles = (variant.buttons || []).map((b) => b && b.role);
  const allowed = ROLE_SETS[source === 'entry_node' ? 'entry_node' : sender] || [];
  if (roles.some((role) => !allowed.includes(role))) return { ...base, reason: 'buttons_mismatch' };
  if (source === 'entry_node' && validateFlowButtons(template, variant, { nodeButtons: node && node.buttons }).length) {
    return { ...base, reason: 'buttons_mismatch' };
  }

  const missing = senderValues.unfillableFields(planner.variantFieldNames(variant), sender, available);
  if (missing.length) return { ...base, missingFields: missing, reason: `field_values_missing:${missing[0]}` };
  return base;
}

function sortEvaluated(a, b) {
  const usableA = a.reason === null ? 0 : 1;
  const usableB = b.reason === null ? 0 : 1;
  if (usableA !== usableB) return usableA - usableB;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return byNewest({ template: a.template }, { template: b.template });
}

// -> Choice (see the header). `available` = { business, promotion: promotionValues } as senderValues.unfillableFields takes it.
async function resolveVariant(deps, { workspaceId, sender, promotion, node, available }) {
  const candidates = await listCandidates(deps, { workspaceId, sender, promotion, node });
  const evaluated = candidates
    .map((candidate) => ({ ...evaluate(candidate, { sender, node, available }), rank: candidate.rank }))
    .filter((e) => e.variant) // a template with no Arabic version is not a candidate for the Arabic one
    .sort(sortEvaluated);
  if (!evaluated.length) {
    return {
      source: 'none', template: null, variant: null, usable: false, reason: 'no_arabic_version',
      templateId: null, templateName: null, metaStatus: null, reviewStatus: null, sendable: false, notSendableReason: null,
      hasOptOut: false, hasShopButton: false, missingFields: [],
    };
  }
  const best = evaluated[0];
  return { ...best, usable: best.reason === null };
}

// The plan / report view of a Choice: only plain data (never the template document).
function describeChoice(choice) {
  return {
    source: choice.source,
    templateId: choice.templateId,
    templateName: choice.templateName,
    language: 'ar',
    metaStatus: choice.metaStatus,
    reviewStatus: choice.reviewStatus,
    sendable: !!choice.usable,
    notSendableReason: choice.usable ? null : (choice.reason || choice.notSendableReason || null),
    hasOptOut: !!choice.hasOptOut,
    hasShopButton: !!choice.hasShopButton,
    missingFields: choice.missingFields || [],
  };
}

// Payload per button of the chosen variant, aligned with variant.buttons (the shape buildSendComponents takes).
//   promotion / entry_node  flow_button -> msgnode_<nodeId>_<node button position>, opt_out -> optout_<promotionId>
//   promotion / promotion   shop_now -> promo_<promotionId> (the payload the English announcement uses), opt_out -> optout_<promotionId>
//   loyalty_reminder        opt_out -> optout_loyalty_reminder
//   consent_request         opt_in -> consent_yes_<customerId>, decline -> consent_no_<customerId>
// `testMode` swaps the opt-out payload for an inert one (a tester tapping Stop must not opt anyone out).
// -> array | null (null = a button this sender cannot carry: never send a dead button)
const TEST_OPT_OUT_PAYLOAD = 'l10ntest_optout';

function buttonPayloads({ choice, sender, promotion, node, customer, testMode = false }) {
  const variant = choice.variant;
  if (!variant) return null;
  const payloads = [];
  let flowIndex = 0;
  for (const button of Array.isArray(variant.buttons) ? variant.buttons : []) {
    const role = button && button.role;
    if (role === 'url') { payloads.push(undefined); continue; }
    if (role === 'opt_out') {
      if (testMode) payloads.push(TEST_OPT_OUT_PAYLOAD);
      else if (sender === 'promotion') payloads.push(`optout_${promotion._id}`);
      else if (sender === 'loyalty_reminder') payloads.push('optout_loyalty_reminder');
      else return null;
    } else if (role === 'shop_now' && sender === 'promotion' && choice.source === 'promotion') {
      payloads.push(`promo_${promotion._id}`);
    } else if (role === 'flow_button' && sender === 'promotion' && choice.source === 'entry_node') {
      const nodeButton = ((node && node.buttons) || [])[flowIndex];
      flowIndex += 1;
      if (!nodeButton) return null;
      payloads.push(`msgnode_${node._id}_${nodeButton.position}`);
    } else if (role === 'opt_in' && sender === 'consent_request' && customer) {
      payloads.push(`consent_yes_${customer._id}`);
    } else if (role === 'decline' && sender === 'consent_request' && customer) {
      payloads.push(`consent_no_${customer._id}`);
    } else {
      return null;
    }
  }
  return payloads;
}

module.exports = {
  LOYALTY_USE_CASES, ROLE_SETS, TEST_OPT_OUT_PAYLOAD,
  listCandidates, evaluate, resolveVariant, describeChoice, buttonPayloads,
};
