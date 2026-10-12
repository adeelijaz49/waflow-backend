'use strict';
// Automated Flows overlay — per-language text and approval status for the ENTRY
// message of each Automated Flow (spec §4: "each message node and its buttons
// get per-language text and per-language approval status"). It is a sidecar:
// nothing in models/Flow, Promotion, MessageNode or utils/flowScheduler.js is
// changed (owner's rule: "don't touch existing code").
//
// What a flow sends today: Flow -> (promotionId -> Promotion.entryNodeId, or the
// legacy Flow.entryNodeId) -> MessageNode = an English body with positional {{n}}
// slots, <= 3 buttons, ONE Meta template (language 'en') -> sendCustomFlowTemplate
// with button payloads msgnode_<nodeId>_<position>. So every other language
// version must keep the node's SLOT VALUES and its BUTTON COUNT/ORDER and may
// only change the words. This module:
//   * listFlowMessages  - each workspace flow's entry message with its per-language
//                         status (read-only joins; four bulk queries, no N+1);
//   * localizeMessage   - creates (once) a LocalizedTemplate linked to the node via
//                         linkedMessageNodeId, seeded with the English variant
//                         converted from the node ({{n}} -> named {fields}, one
//                         `flow_button` per node button);
//   * validateFlowButtons - the "keep the node's buttons" rule for ar/bilingual
//                         variants of a node-linked template, exported for the
//                         template service (upsertVariant) to apply on save;
//   * slotFieldsFor / loadOwnedNode - shared with flowBridge.js.
// The live flow engine still sends the English message: making it send the Arabic
// variant needs one hook in utils/flowScheduler.js that is documented, tested and
// NOT applied (see flowBridge.js).
//
// Slot -> merge field. These are the slots the English path fills, in the same
// order (shared/operations.js): PROMOTION_MESSAGE_VARIABLES 1 customerName,
// 2 itemName, 3 priceOrPoints, 4 promoName; FLOW_MESSAGE_VARIABLES per trigger:
// inactive_customer [customerName]; post_purchase_points and
// points_balance_reminder [customerName, pointsBalance]; booking_no_show
// [customerName, serviceName]. tests/localization/flowMessages.test.js reads that
// source file and fails when the two drift apart.
//
// Decisions worth knowing:
//   * The `en` variant is a MIRROR of the node (informational: it feeds "start from
//     the English version" and the side-by-side preview). Its Meta name/status are
//     copied from the node and the list endpoint always reports the node's own
//     templateStatus for English, so a stale mirror can never mislead. English is
//     still submitted, approved and sent by the existing code.
//   * An opt_out quick reply is added to the seed only while the template stays within
//     the 3 visible buttons (WhatsApp collapses a 4th). A 3-button node therefore gets
//     no auto-added opt-out; the marketing rule (validateVariant) then asks the
//     merchant to add one, and validateFlowButtons accepts ONE trailing opt_out/url.
//   * The seed is a faithful copy of the node's text (only {{n}} -> {field}): it is never padded,
//     trimmed or rewritten. Meta rejects a body that starts or ends with a variable (error
//     2388299, META-REALITY §3), so a node written that way (a promotion message ending in {{4}})
//     yields a seed that validateVariant flags with body_starts_with_variable /
//     body_ends_with_variable. Creating the draft is not blocked; the merchant has to add words
//     before that version can be submitted (the template service answers VARIANT_INVALID).
//   * Tenant proof for a node is its own workspaceId (set from the verified token when
//     the node was created) or, for legacy nodes without one, a Flow/Promotion owner in
//     this workspace. ownerId is client-supplied on creation, so it is never trusted
//     across workspaces: owner lookups are always filtered by workspaceId.
const { isObjectIdLike } = require('./scope');
const { LIMITS } = require('./metaConstraints');
const { findVariant } = require('./variantSelection');
const catalog = require('./catalog');

const FLOW_BUTTON = 'flow_button';
const EXTRA_BUTTON_ROLES = Object.freeze(['opt_out', 'url']);
const MAX_FLOWS = 500;
const MAX_TEMPLATE_NAME = 100;
// The footer utils/whatsapp.js#createTemplate adds to every flow template.
const ENGLISH_FLOW_FOOTER = 'Reply STOP to unsubscribe';
const NODE_STATUSES = Object.freeze(['not_created', 'pending', 'approved', 'rejected']);
const NODE_STATUS_TO_META = Object.freeze({ not_created: 'NOT_CREATED', pending: 'PENDING', approved: 'APPROVED', rejected: 'REJECTED' });

const FLOW_FIELDS = 'name triggerType status promotionId entryNodeId createdAt';
const NODE_FIELDS = 'workspaceId ownerType ownerId isEntryNode bodyText buttons templateName templateStatus';
const OWNER_FIELDS = 'name triggerType workspaceId';
const TEMPLATE_FIELDS = 'linkedMessageNodeId variants archived createdAt';

// ── Slot maps ─────────────────────────────────────────────────────────────
const PROMOTION_SLOT_FIELDS = Object.freeze(['name', 'item', 'price', 'promo_name']);
const FLOW_SLOT_FIELDS = Object.freeze({
  inactive_customer: Object.freeze(['name']),
  post_purchase_points: Object.freeze(['name', 'points']),
  points_balance_reminder: Object.freeze(['name', 'points']),
  booking_no_show: Object.freeze(['name', 'service']),
});
const NO_SLOTS = Object.freeze([]);

// Fields (index = slot - 1) a node's {{n}} placeholders stand for. Triggers without
// a slot list (points_threshold, purchase_frequency) take no placeholders.
function slotFieldsFor({ ownerType, triggerType } = {}) {
  if (ownerType === 'promotion') return PROMOTION_SLOT_FIELDS;
  return Object.prototype.hasOwnProperty.call(FLOW_SLOT_FIELDS, triggerType) ? FLOW_SLOT_FIELDS[triggerType] : NO_SLOTS;
}

// Only canonical Meta placeholders count: {{1}}, {{2}} ... ({{0}}, {{01}}, {{ 1 }} do not).
const POSITIONAL_RE = /\{\{([1-9]\d*)\}\}/g;

// {{n}} -> {field}. Any other brace in the text cannot be represented in the named
// syntax without changing the message, so it is reported instead of guessed.
// -> { ok: true, text } | { ok: false, reason: 'stray_braces' | 'unknown_slot', slot? }
function slotsToFields(bodyText, slotFields) {
  const source = typeof bodyText === 'string' ? bodyText : '';
  if (/[{}]/.test(source.replace(POSITIONAL_RE, ''))) return { ok: false, reason: 'stray_braces' };
  let unknownSlot = null;
  const text = source.replace(POSITIONAL_RE, (match, n) => {
    const field = slotFields[Number(n) - 1];
    if (!field) {
      if (unknownSlot === null) unknownSlot = Number(n);
      return match;
    }
    return `{${field}}`;
  });
  return unknownSlot === null ? { ok: true, text } : { ok: false, reason: 'unknown_slot', slot: unknownSlot };
}

// The English variant a node is seeded with. Buttons keep the node's order and
// labels (payload = msgnode_<nodeId>_<position>, see flowBridge.js).
function buildSeedVariant(node, slotFields) {
  const converted = slotsToFields(node.bodyText, slotFields);
  if (!converted.ok) return converted;
  const buttons = (node.buttons || []).map((b) => ({ role: FLOW_BUTTON, text: b.label }));
  if (buttons.length < LIMITS.VISIBLE_BUTTONS) buttons.push({ role: 'opt_out', text: catalog.t('en', 'consent.buttonOptOut') });
  return { ok: true, variant: { language: 'en', body: converted.text, footer: ENGLISH_FLOW_FOOTER, buttons, source: 'import' } };
}

// ── Button lock ───────────────────────────────────────────────────────────
// How many flow buttons a variant of this template must carry: the node's own
// buttons when the caller has them (authoritative), else what the template's English
// mirror recorded. null = nothing to compare against.
function expectedFlowButtons(template, nodeButtons) {
  if (Array.isArray(nodeButtons)) return nodeButtons.length;
  const english = findVariant(template, 'en');
  if (!english) return null;
  return (english.buttons || []).filter((b) => b && b.role === FLOW_BUTTON).length;
}

// An ar/bilingual variant of a node-linked template must keep the node's buttons: the first N
// buttons are the N flow buttons, in the node's order (the tap payload is positional), and
// only opt_out / url buttons may follow them. English variants mirror the node and are not
// constrained; templates that are not node-linked are never constrained. `variant.language`
// must be set. Label text is free (that is the point of a translation).
// -> ValidationIssue[]: { code: 'flow_button_mismatch', field, detail: { expected, found, position? } } — the
// same code and detail keys the template service reports for its own (index-based) check.
function validateFlowButtons(template, variant, { nodeButtons } = {}) {
  if (!template || !template.linkedMessageNodeId || !variant || variant.language === 'en') return [];
  const expected = expectedFlowButtons(template, nodeButtons);
  if (expected === null) return [];
  const buttons = Array.isArray(variant.buttons) ? variant.buttons : [];
  const actual = buttons.filter((b) => b && b.role === FLOW_BUTTON).length;
  const issues = [];
  const report = (field, extra) => issues.push({ code: 'flow_button_mismatch', field, detail: { expected, found: actual, ...extra } });
  if (actual !== expected) report('buttons');
  buttons.forEach((button, i) => {
    const role = button && button.role;
    const allowed = i < expected ? role === FLOW_BUTTON : EXTRA_BUTTON_ROLES.includes(role);
    if (!allowed) report(`buttons.${i}`, { position: i });
  });
  return issues;
}

// ── Errors and input checks ───────────────────────────────────────────────
function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function notLocalizable(message) {
  return httpError(422, 'NODE_NOT_LOCALIZABLE', message);
}

// Ids are canonicalised to lower-case hex: they end up in a template key, which only allows [a-z0-9_].
function requireWorkspace(workspaceId) {
  if (!isObjectIdLike(workspaceId)) throw httpError(403, 'FORBIDDEN', 'A workspace is required');
  return String(workspaceId).toLowerCase();
}

function requireNodeId(value) {
  if (!isObjectIdLike(value)) throw httpError(400, 'INVALID_ID', 'Invalid message id');
  return String(value).toLowerCase();
}

function realDeps() {
  return {
    Flow: require('../../models/Flow'),
    Promotion: require('../../models/Promotion'),
    MessageNode: require('../../models/MessageNode'),
    LocalizedTemplate: require('../../models/LocalizedTemplate'),
    // The template service belongs to another slice and only `localize` needs it.
    get templates() { return require('./templates'); },
    log: (...args) => console.error('[localization]', ...args),
  };
}

// ── Ownership ─────────────────────────────────────────────────────────────
// -> { node, owner } | null. null = the node is not provably this workspace's (missing,
// another workspace's, or a legacy node whose owner is not in this workspace). `owner` is the
// Flow/Promotion that owns it IN THIS WORKSPACE (with `kind`), or null when the node is ours
// but its declared owner is missing / elsewhere.
async function loadOwnedNode(deps, workspaceId, nodeId) {
  const node = await deps.MessageNode.findOne({ _id: nodeId }).select(NODE_FIELDS).lean();
  if (!node) return null;
  const nodeWorkspace = node.workspaceId ? String(node.workspaceId) : null;
  if (nodeWorkspace && nodeWorkspace !== String(workspaceId)) return null;
  const kind = node.ownerType === 'promotion' ? 'promotion' : 'flow';
  const Owner = kind === 'promotion' ? deps.Promotion : deps.Flow;
  const found = isObjectIdLike(node.ownerId)
    ? await Owner.findOne({ _id: node.ownerId, workspaceId }).select(OWNER_FIELDS).lean()
    : null;
  if (!found && !nodeWorkspace) return null;
  return { node, owner: found ? { ...found, kind } : null };
}

// ── Listing ───────────────────────────────────────────────────────────────
function unique(list) { return Array.from(new Set(list)); }
function timeOf(value) { return value ? (new Date(value).getTime() || 0) : 0; }
function newestFirst(a, b) { return (timeOf(b.createdAt) - timeOf(a.createdAt)) || (String(b._id) < String(a._id) ? -1 : 1); }
function oldestFirst(a, b) { return String(a._id) < String(b._id) ? -1 : 1; }
function reviewOf(variant) { return variant && variant.reviewStatus === 'reviewed' ? 'reviewed' : 'draft'; }

// English always comes from the node (the authoritative record of the existing
// English template); other languages from the linked template's variants.
function variantStatuses(template, node) {
  const byLanguage = new Map(((template && template.variants) || []).map((v) => [v.language, v]));
  const rows = [{ language: 'en', metaStatus: NODE_STATUS_TO_META[node.templateStatus] || 'NOT_CREATED', reviewStatus: reviewOf(byLanguage.get('en')) }];
  for (const language of ['ar', 'bilingual']) {
    const variant = byLanguage.get(language);
    if (variant) rows.push({ language, metaStatus: variant.metaStatus || 'NOT_CREATED', reviewStatus: reviewOf(variant) });
  }
  return rows;
}

function toNodeRow(node, template) {
  return {
    messageNodeId: String(node._id),
    bodyText: node.bodyText || '',
    buttons: (node.buttons || []).map((b) => ({ position: b.position, label: b.label })),
    templateStatus: NODE_STATUSES.includes(node.templateStatus) ? node.templateStatus : 'not_created',
    localizedTemplateId: template ? String(template._id) : null,
    variantStatus: variantStatuses(template, node),
  };
}

// GET /flows/messages -> { items: FlowMessageRow[] }. Four bulk queries (flows,
// promotions, nodes, linked templates), each filtered by workspace where the
// collection has one; flows without a workspace never match. A flow whose entry
// message cannot be resolved (built-in template, missing/foreign node) is still listed,
// with no nodes. Like the engine, a flow with promotionId uses ONLY its promotion's entry node.
async function listFlowMessages({ workspaceId } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const flows = (await deps.Flow.find({ workspaceId: ws }).select(FLOW_FIELDS).limit(MAX_FLOWS).lean()).sort(newestFirst);
  if (!flows.length) return { items: [] };

  const promotionIds = unique(flows.map((f) => f.promotionId).filter(Boolean).map(String));
  const promotions = promotionIds.length
    ? await deps.Promotion.find({ _id: { $in: promotionIds }, workspaceId: ws }).select('entryNodeId').lean()
    : [];
  const entryByPromotion = new Map(promotions.map((p) => [String(p._id), p.entryNodeId ? String(p.entryNodeId) : null]));
  const entryNodeIdOf = (flow) => {
    if (flow.promotionId) return entryByPromotion.get(String(flow.promotionId)) || null;
    return flow.entryNodeId ? String(flow.entryNodeId) : null;
  };

  const nodeIds = unique(flows.map(entryNodeIdOf).filter(Boolean));
  const nodes = nodeIds.length ? await deps.MessageNode.find({ _id: { $in: nodeIds } }).select(NODE_FIELDS).lean() : [];
  const nodeById = new Map(nodes
    .filter((n) => n.isEntryNode && (!n.workspaceId || String(n.workspaceId) === ws))
    .map((n) => [String(n._id), n]));

  const templates = nodeById.size
    ? await deps.LocalizedTemplate.find({ workspaceId: ws, linkedMessageNodeId: { $in: Array.from(nodeById.keys()) }, archived: { $ne: true } }).select(TEMPLATE_FIELDS).lean()
    : [];
  const templateByNode = new Map();
  for (const template of templates.sort(oldestFirst)) {
    const key = String(template.linkedMessageNodeId);
    if (!templateByNode.has(key)) templateByNode.set(key, template);
  }

  return {
    items: flows.map((flow) => {
      const node = nodeById.get(entryNodeIdOf(flow));
      return {
        flowId: String(flow._id),
        flowName: flow.name || '',
        triggerType: flow.triggerType,
        status: flow.status === 'active' ? 'active' : 'paused',
        promotionId: flow.promotionId ? String(flow.promotionId) : null,
        nodes: node ? [toNodeRow(node, templateByNode.get(String(node._id)))] : [],
      };
    }),
  };
}

// ── Localize ──────────────────────────────────────────────────────────────
function templateNameFor(owner) {
  const name = typeof owner.name === 'string' ? owner.name.trim() : '';
  return Array.from(name || catalog.t('en', 'flows.templateNameFallback')).slice(0, MAX_TEMPLATE_NAME).join('');
}

// The existing linked template (oldest live one; else the oldest archived one, brought back
// so "Add Arabic version" after an archive restores the merchant's work instead of forking it).
async function findLinkedTemplate(deps, workspaceId, nodeId) {
  const docs = (await deps.LocalizedTemplate.find({ workspaceId, linkedMessageNodeId: nodeId }).select(TEMPLATE_FIELDS).lean()).sort(oldestFirst);
  const live = docs.find((d) => !d.archived);
  if (live) return live;
  if (!docs.length) return null;
  const restored = await deps.LocalizedTemplate.findOneAndUpdate(
    { _id: docs[0]._id, workspaceId },
    { $set: { archived: false } },
    { returnDocument: 'after' },
  ).lean();
  return restored || null;
}

// Copy what the existing English template already is onto the `en` variant (best effort: the
// list endpoint reports English straight from the node, this only makes the editor truthful).
async function mirrorEnglishStatus(deps, { workspaceId, templateId, node }) {
  const metaStatus = NODE_STATUS_TO_META[node.templateStatus];
  if (!metaStatus || metaStatus === 'NOT_CREATED') return false;
  const set = { 'variants.$.metaStatus': metaStatus, 'variants.$.metaLanguage': 'en', 'variants.$.submissionCount': 1 };
  if (node.templateName) set['variants.$.metaTemplateName'] = node.templateName;
  try {
    await deps.LocalizedTemplate.updateOne({ _id: templateId, workspaceId, 'variants.language': 'en' }, { $set: set });
    return true;
  } catch (err) {
    deps.log('could not mirror the English template status (ignored):', err && err.message);
    return false;
  }
}

async function createLinkedTemplate(deps, { workspaceId, userId, nodeId, node, owner }) {
  const seed = buildSeedVariant(node, slotFieldsFor({ ownerType: node.ownerType, triggerType: owner.triggerType }));
  if (!seed.ok) {
    throw notLocalizable(seed.reason === 'unknown_slot'
      ? `This message uses placeholder {{${seed.slot}}}, which this flow does not fill, so it cannot get language versions`
      : 'This message contains curly braces that are not {{1}}-style placeholders, so it cannot get language versions');
  }
  const created = await deps.templates.createTemplate({
    workspaceId,
    userId,
    name: templateNameFor(owner),
    key: `flow_message_${nodeId}`, // stable per node: a second concurrent create collides instead of forking
    useCase: 'custom',
    category: 'MARKETING',
    variants: [seed.variant],
    linkedMessageNodeId: nodeId,
  });
  const templateId = created && created.id;
  if (!templateId || !(await mirrorEnglishStatus(deps, { workspaceId, templateId, node }))) return created;
  const doc = await deps.LocalizedTemplate.findOne({ _id: templateId, workspaceId }).lean();
  return doc ? deps.templates.toTemplateView(doc) : created;
}

async function localizeOnce({ workspaceId, userId, nodeId }, deps) {
  const owned = await loadOwnedNode(deps, workspaceId, nodeId);
  if (!owned) throw httpError(404, 'NODE_NOT_FOUND', 'Flow message not found');
  const { node, owner } = owned;
  if (!node.isEntryNode) throw notLocalizable('Only the first message of a flow can have language versions; follow-up messages are sent as free-form replies');

  const existing = await findLinkedTemplate(deps, workspaceId, nodeId);
  if (existing) return { template: await deps.templates.toTemplateView(existing), created: false };

  if (!owner) throw notLocalizable('This message is not attached to a flow or promotion of this workspace');
  try {
    return { template: await createLinkedTemplate(deps, { workspaceId, userId, nodeId, node, owner }), created: true };
  } catch (err) {
    if (!err || (err.code !== 'TEMPLATE_KEY_TAKEN' && err.code !== 11000)) throw err;
    // Another request created the node's template first (the key is unique per node): use it.
    const winner = await findLinkedTemplate(deps, workspaceId, nodeId);
    if (!winner) throw err;
    return { template: await deps.templates.toTemplateView(winner), created: false };
  }
}

// Requests for the same node in this process share ONE run, so a double click cannot
// create two templates; followers report created:false.
const inflight = new Map();

// POST /flows/messages/:messageNodeId/localize -> { template: LocalizedTemplate view, created }
// 404 NODE_NOT_FOUND (not this workspace's) / 422 NODE_NOT_LOCALIZABLE (follow-up node, no owner,
// placeholders the flow cannot fill) / 400 INVALID_ID. Idempotent.
async function localizeMessage({ workspaceId, userId, messageNodeId } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const nodeId = requireNodeId(messageNodeId);
  const key = `${ws}:${nodeId}`;
  const running = inflight.get(key);
  if (running) return { template: (await running).template, created: false };
  const job = localizeOnce({ workspaceId: ws, userId, nodeId }, deps);
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

module.exports = {
  PROMOTION_SLOT_FIELDS,
  FLOW_SLOT_FIELDS,
  slotFieldsFor,
  slotsToFields,
  buildSeedVariant,
  validateFlowButtons,
  loadOwnedNode,
  listFlowMessages,
  localizeMessage,
  realDeps,
};
