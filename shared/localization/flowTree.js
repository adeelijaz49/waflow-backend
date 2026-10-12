'use strict';
// Read-only message TREES of the Automated Flows / Promotion conversations with their per-language versions
// (backlog A2 + A4, spec section 4): the entry message AND every branching follow-up, depth-first, each with
// the languages that exist for it. Feeds the hub's Automated Flows tab (GET /flows/tree) and the existing
// Conversation Flow Viewer (GET /flows/owners/:ownerType/:ownerId/tree).
//
//   buildFlowTrees({ workspaceId })                      -> { items: FlowTreeRow[] }
//   buildOwnerTree({ workspaceId, ownerType, ownerId })  -> { ownerType, ownerId, messageSource, nodes }
//   buildPromotionTrees({ workspaceId })                 -> { items: PromotionTreeRow[], truncated }
//
// buildPromotionTrees lists the Promotions that have a custom entry message (a MessageNode, any template
// status) and are NOT sent by any Flow of the workspace: a promotion sent from the Promotions screen (custom entry
// message + branching follow-ups handled by server.js handleMessageNodeTap) needs no Flow, so without this its
// follow-ups would be unreachable in the hub. A promotion that a flow sends appears under the flow only (never
// twice). Rows carry the same TreeNode shape (versions, canAddArabic ...) as flow rows.
//
// Cost: bulk queries only (flows, promotions, message nodes level by level through nextAction.targetNodeId,
// linked templates, Arabic follow-up rows): no per-flow or per-node query. At most 500 flows are listed.
// Safety: every query carries the workspace (message nodes are fetched by _id and then proven to be this
// workspace's: own workspaceId, or - legacy rows without one - owned by a flow/promotion of this workspace);
// the walk is cycle-safe and stops at depth 3 (the MessageNode limit); a node reachable twice appears once.
// Nothing here writes.
//
// messageSource: 'promotion' (the flow sends its Promotion's entry message), 'custom_entry' (legacy
// Flow.entryNodeId), 'default_template' (the fixed English template shared by every workspace: no nodes, no
// Arabic: pick a Promotion to send, see D2 section 3.2). A Promotion owner without a custom entry message
// is also 'default_template' (its fixed announcement is English only).
const { isObjectIdLike } = require('./scope');
const { checkSendable } = require('./variantSelection');
const { validateFlowButtons } = require('./flowMessages');
const followUps = require('./flowFollowUps');

const MAX_FLOWS = 500;
const MAX_DEPTH = 3;
// Promotion rows: scan at most MAX_PROMOTIONS_SCANNED promotions (the "has an entry message" filter runs in
// memory: no $exists / $ne scan on Cosmos) and return at most MAX_PROMOTION_ROWS trees.
const MAX_PROMOTIONS_SCANNED = 1000;
const MAX_PROMOTION_ROWS = 200;
const NODE_FIELDS = 'workspaceId ownerType ownerId isEntryNode bodyText buttons templateName templateStatus';
const FLOW_FIELDS = 'name triggerType status promotionId entryNodeId createdAt';
const PROMOTION_FIELDS = 'name status entryNodeId createdAt';
const PROMOTION_STATUSES = Object.freeze(['draft', 'active', 'expired']);
const NODE_STATUSES = Object.freeze(['not_created', 'pending', 'approved', 'rejected']);
const NODE_STATUS_TO_META = Object.freeze({ not_created: 'NOT_CREATED', pending: 'PENDING', approved: 'APPROVED', rejected: 'REJECTED' });

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function realDeps() {
  return {
    Flow: require('../../models/Flow'),
    Promotion: require('../../models/Promotion'),
    MessageNode: require('../../models/MessageNode'),
    LocalizedTemplate: require('../../models/LocalizedTemplate'),
    LocalizedFlowNode: require('../../models/LocalizedFlowNode'),
    log: (...args) => console.error('[localization]', ...args),
  };
}

const unique = (list) => Array.from(new Set(list));
const timeOf = (value) => (value ? (new Date(value).getTime() || 0) : 0);
const newestFirst = (a, b) => (timeOf(b.createdAt) - timeOf(a.createdAt)) || (String(b._id) < String(a._id) ? -1 : 1);
const oldestFirst = (a, b) => (String(a._id) < String(b._id) ? -1 : 1);

function requireWorkspace(workspaceId) {
  if (!isObjectIdLike(workspaceId)) throw httpError(403, 'FORBIDDEN', 'A workspace is required');
  return String(workspaceId).toLowerCase();
}

// ── Data loading ──────────────────────────────────────────────────────────
// Level by level from the entry nodes along send_message targets (<= MAX_DEPTH + 1 queries in total).
async function loadNodeMap(deps, entryIds) {
  const map = new Map();
  let frontier = unique(entryIds);
  for (let level = 0; level <= MAX_DEPTH && frontier.length; level += 1) {
    const docs = await deps.MessageNode.find({ _id: { $in: frontier } }).select(NODE_FIELDS).lean();
    const next = [];
    for (const doc of docs) {
      map.set(String(doc._id), doc);
      for (const button of doc.buttons || []) {
        const target = button && button.nextAction && button.nextAction.targetNodeId;
        if (target && isObjectIdLike(target)) next.push(String(target));
      }
    }
    frontier = unique(next).filter((id) => !map.has(id));
  }
  return map;
}

function sendMessageTarget(button) {
  const action = button && button.nextAction;
  return action && action.type === 'send_message' && action.targetNodeId && isObjectIdLike(action.targetNodeId) ? String(action.targetNodeId) : null;
}

// Depth-first, parent before child, children in button-position order; each node once.
function walk(entryId, nodeMap, accept) {
  const out = [];
  const visited = new Set();
  const visit = (id, parentNodeId, parentButtonPosition, depth) => {
    if (depth > MAX_DEPTH || visited.has(id)) return;
    const node = nodeMap.get(id);
    if (!node || !accept(node)) return;
    visited.add(id);
    out.push({ node, parentNodeId, parentButtonPosition, depth });
    const buttons = (node.buttons || []).slice().sort((a, b) => a.position - b.position);
    for (const button of buttons) {
      const target = sendMessageTarget(button);
      if (target) visit(target, id, button.position, depth + 1);
    }
  };
  visit(String(entryId), null, null, 0);
  return out;
}

// ── Versions ──────────────────────────────────────────────────────────────
function reviewOf(variant) { return variant && variant.reviewStatus === 'reviewed' ? 'reviewed' : 'draft'; }

// Per-language buttons of an entry variant, matched to the node's own positions: the first N flow_button
// entries ARE the node's buttons in order; opt-out / link buttons have no position.
function entryVariantButtons(variant, node) {
  const positions = (node.buttons || []).map((b) => b.position);
  let flowIndex = 0;
  return (variant.buttons || []).map((b) => {
    const isFlow = b.role === 'flow_button';
    const position = isFlow ? (positions[flowIndex] === undefined ? null : positions[flowIndex]) : null;
    if (isFlow) flowIndex += 1;
    return { position, role: b.role, text: b.text || '' };
  });
}

function entryVersions(node, template, english) {
  const versions = [{
    language: 'en',
    body: english.bodyFields === null ? english.bodyText : english.bodyFields,
    buttons: (node.buttons || []).map((b) => ({ position: b.position, role: 'flow_button', text: b.label })), // stored order, like the template seed
    metaStatus: NODE_STATUS_TO_META[node.templateStatus] || 'NOT_CREATED',
    reviewStatus: null,
    stale: false,
    sendable: null,
    contentVersion: null,
    editUrl: null,
  }];
  const byLanguage = new Map(((template && template.variants) || []).map((v) => [v.language, v]));
  for (const language of ['ar', 'bilingual']) {
    const variant = byLanguage.get(language);
    if (!variant) continue;
    const sendable = checkSendable(variant, { requireNativeReview: true }).ok
      && typeof variant.metaTemplateName === 'string' && variant.metaTemplateName.length > 0
      && validateFlowButtons(template, variant, { nodeButtons: node.buttons }).length === 0;
    versions.push({
      language,
      body: variant.body || '',
      buttons: entryVariantButtons(variant, node),
      metaStatus: variant.metaStatus || 'NOT_CREATED',
      reviewStatus: reviewOf(variant),
      // Entry versions have no staleness gate (D2 risk 4): the English-approved check is the sender's.
      stale: false,
      sendable: language === 'ar' ? sendable : false, // only an Arabic version is ever sent by the engine
      contentVersion: variant.contentVersion || 1,
      editUrl: `/arabic/templates/${String(template._id)}`,
    });
  }
  return versions;
}

function followUpVersions(node, owner, row) {
  if (!row) return [];
  const view = followUps.evaluateVariant(node, owner, row);
  return [{
    language: 'ar',
    body: row.body || '',
    buttons: (row.buttons || []).slice().sort((a, b) => a.position - b.position).map((b) => ({ position: b.position, role: 'flow_button', text: b.text || '' })),
    metaStatus: 'NOT_REQUIRED',
    reviewStatus: reviewOf(row),
    stale: view.stale,
    sendable: view.sendable,
    contentVersion: row.contentVersion || 1,
    editUrl: `/arabic/flows?node=${String(node._id)}`,
  }];
}

function toTreeNode(item, ctx) {
  const { node, parentNodeId, parentButtonPosition, depth } = item;
  const id = String(node._id);
  const isEntry = node.isEntryNode === true;
  const owner = ctx.ownerOf(node);
  const english = followUps.englishOf(node, owner);
  const template = isEntry ? ctx.templateByNode.get(id) : null;
  const row = isEntry ? null : ctx.rowByNode.get(id);
  const versions = isEntry ? entryVersions(node, template, english) : followUpVersions(node, owner, row);
  let canAdd;
  let addUrl = null;
  if (isEntry) {
    const hasArabic = !!(template && (template.variants || []).some((v) => v.language === 'ar'));
    canAdd = !hasArabic && !english.slotProblem && !!owner;
    if (canAdd) addUrl = template ? `/arabic/templates/${String(template._id)}` : `/arabic/flows?node=${id}`;
  } else {
    canAdd = !row;
    if (canAdd) addUrl = `/arabic/flows?node=${id}`;
  }
  return {
    messageNodeId: id,
    parentNodeId,
    parentButtonPosition,
    depth,
    isEntry,
    bodyText: english.bodyText,
    bodyFields: english.bodyFields,
    slotProblem: english.slotProblem,
    slotFields: english.slotFields,
    buttons: english.buttons.map((b) => {
      const source = (node.buttons || []).find((x) => x.position === b.position) || {};
      const action = source.nextAction || {};
      return { position: b.position, label: b.label, action: action.type || 'end_flow', targetNodeId: action.type === 'send_message' && action.targetNodeId ? String(action.targetNodeId) : null };
    }),
    templateStatus: isEntry ? (NODE_STATUSES.includes(node.templateStatus) ? node.templateStatus : 'not_created') : null,
    versions,
    canAddArabic: canAdd,
    addArabicUrl: addUrl,
  };
}

// roots: [{ entryNodeId|null, ownerKey }] -> Map(index -> TreeNode[])
async function assemble(deps, ws, { roots, flowById, promotionById }) {
  const ownerOf = (node) => {
    const map = node.ownerType === 'promotion' ? promotionById : flowById;
    const found = isObjectIdLike(node.ownerId) ? map.get(String(node.ownerId)) : null;
    return found ? { ...found, kind: node.ownerType === 'promotion' ? 'promotion' : 'flow' } : null;
  };
  // Tenant proof (same rule as flowMessages.loadOwnedNode): own workspaceId, else a declared owner of this workspace.
  const accept = (node) => (node.workspaceId ? String(node.workspaceId) === ws : !!ownerOf(node));

  const nodeMap = await loadNodeMap(deps, roots.map((r) => r.entryNodeId).filter(Boolean));
  const walked = roots.map((root) => {
    if (!root.entryNodeId) return [];
    const entry = nodeMap.get(String(root.entryNodeId));
    if (!entry || !entry.isEntryNode) return [];
    return walk(root.entryNodeId, nodeMap, accept);
  });

  const entryIds = unique(walked.flatMap((list) => list.filter((i) => i.node.isEntryNode === true).map((i) => String(i.node._id))));
  const followUpIds = unique(walked.flatMap((list) => list.filter((i) => i.node.isEntryNode !== true).map((i) => String(i.node._id))));
  const templates = entryIds.length
    ? await deps.LocalizedTemplate.find({ workspaceId: ws, linkedMessageNodeId: { $in: entryIds }, archived: { $ne: true } }).select('linkedMessageNodeId variants archived createdAt').lean()
    : [];
  const rows = followUpIds.length
    ? await deps.LocalizedFlowNode.find({ workspaceId: ws, messageNodeId: { $in: followUpIds }, language: 'ar' }).lean()
    : [];
  const templateByNode = new Map();
  for (const template of templates.sort(oldestFirst)) {
    const key = String(template.linkedMessageNodeId);
    if (!templateByNode.has(key)) templateByNode.set(key, template);
  }
  const rowByNode = new Map(rows.map((row) => [String(row.messageNodeId), row]));
  const ctx = { ownerOf, templateByNode, rowByNode };
  return walked.map((list) => list.map((item) => toTreeNode(item, ctx)));
}

function sourceOf(flow) {
  if (flow.promotionId) return 'promotion';
  return flow.entryNodeId ? 'custom_entry' : 'default_template';
}

// GET /flows/tree
async function buildFlowTrees({ workspaceId } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const flows = (await deps.Flow.find({ workspaceId: ws }).select(FLOW_FIELDS).limit(MAX_FLOWS).lean()).sort(newestFirst);
  if (!flows.length) return { items: [] };

  const promotionIds = unique(flows.map((f) => f.promotionId).filter(Boolean).map(String));
  const promotions = promotionIds.length
    ? await deps.Promotion.find({ _id: { $in: promotionIds }, workspaceId: ws }).select('name entryNodeId').lean()
    : [];
  const promotionById = new Map(promotions.map((p) => [String(p._id), p]));
  const flowById = new Map(flows.map((f) => [String(f._id), f]));

  // Like the engine: a flow with promotionId uses ONLY its promotion's entry node.
  const roots = flows.map((flow) => {
    if (flow.promotionId) {
      const promotion = promotionById.get(String(flow.promotionId));
      return { entryNodeId: promotion && promotion.entryNodeId ? String(promotion.entryNodeId) : null };
    }
    return { entryNodeId: flow.entryNodeId ? String(flow.entryNodeId) : null };
  });
  const trees = await assemble(deps, ws, { roots, flowById, promotionById });
  return {
    items: flows.map((flow, i) => {
      const promotion = flow.promotionId ? promotionById.get(String(flow.promotionId)) : null;
      return {
        flowId: String(flow._id),
        flowName: flow.name || '',
        triggerType: flow.triggerType,
        status: flow.status === 'active' ? 'active' : 'paused',
        promotionId: flow.promotionId ? String(flow.promotionId) : null,
        promotionName: promotion ? (promotion.name || '') : null,
        messageSource: sourceOf(flow),
        nodes: trees[i],
      };
    }),
  };
}

// GET /flows/promotion-trees -> { items: PromotionTreeRow[], truncated: boolean }
// Equality / $in queries only, no sort in the database (newest first is applied in memory), every query carries
// the workspace. Flows are read with the same query as buildFlowTrees (same <= 500 set), so a promotion is
// excluded exactly when /tree lists a flow that sends it. A promotion whose entry message cannot be resolved
// (missing or another workspace's node) has nothing to show and is left out.
async function buildPromotionTrees({ workspaceId } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const flows = await deps.Flow.find({ workspaceId: ws }).select(FLOW_FIELDS).limit(MAX_FLOWS).lean();
  const usedByFlow = new Set(flows.map((f) => f.promotionId).filter(Boolean).map(String));

  const scanned = await deps.Promotion.find({ workspaceId: ws }).select(PROMOTION_FIELDS).limit(MAX_PROMOTIONS_SCANNED).lean();
  let truncated = scanned.length >= MAX_PROMOTIONS_SCANNED;
  if (truncated) deps.log(`promotion trees: only the first ${MAX_PROMOTIONS_SCANNED} promotions of the workspace were scanned`);
  let candidates = scanned
    .filter((p) => p.entryNodeId && isObjectIdLike(p.entryNodeId) && !usedByFlow.has(String(p._id)))
    .sort(newestFirst);
  if (candidates.length > MAX_PROMOTION_ROWS) {
    deps.log(`promotion trees: ${candidates.length} promotions have a message, only the newest ${MAX_PROMOTION_ROWS} are listed`);
    candidates = candidates.slice(0, MAX_PROMOTION_ROWS);
    truncated = true;
  }
  if (!candidates.length) return { items: [], truncated };

  const promotionById = new Map(candidates.map((p) => [String(p._id), p]));
  const trees = await assemble(deps, ws, {
    roots: candidates.map((p) => ({ entryNodeId: String(p.entryNodeId) })),
    flowById: new Map(),
    promotionById,
  });
  const items = [];
  candidates.forEach((promotion, i) => {
    const nodes = trees[i];
    if (!nodes.length) return;
    const entry = nodes.find((n) => n.isEntry) || nodes[0];
    items.push({
      ownerType: 'promotion',
      promotionId: String(promotion._id),
      promotionName: promotion.name || '',
      promotionStatus: PROMOTION_STATUSES.includes(promotion.status) ? promotion.status : 'draft',
      messageSource: 'promotion',
      entryTemplateStatus: entry.templateStatus,
      nodes,
    });
  });
  return { items, truncated };
}

// GET /flows/owners/:ownerType/:ownerId/tree
async function buildOwnerTree({ workspaceId, ownerType, ownerId } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  if (ownerType !== 'flow' && ownerType !== 'promotion') throw httpError(400, 'INVALID_INPUT', 'ownerType must be flow or promotion');
  if (!isObjectIdLike(ownerId)) throw httpError(400, 'INVALID_ID', 'Invalid id');
  const id = String(ownerId).toLowerCase();

  let messageSource;
  let entryNodeId = null;
  const flowById = new Map();
  const promotionById = new Map();
  if (ownerType === 'promotion') {
    const promotion = await deps.Promotion.findOne({ _id: id, workspaceId: ws }).select('name entryNodeId').lean();
    if (!promotion) throw httpError(404, 'NODE_NOT_FOUND', 'Flow or promotion not found');
    promotionById.set(id, promotion);
    entryNodeId = promotion.entryNodeId ? String(promotion.entryNodeId) : null;
    messageSource = entryNodeId ? 'promotion' : 'default_template';
  } else {
    const flow = await deps.Flow.findOne({ _id: id, workspaceId: ws }).select(FLOW_FIELDS).lean();
    if (!flow) throw httpError(404, 'NODE_NOT_FOUND', 'Flow or promotion not found');
    flowById.set(id, flow);
    messageSource = sourceOf(flow);
    if (flow.promotionId) {
      const promotion = await deps.Promotion.findOne({ _id: flow.promotionId, workspaceId: ws }).select('name entryNodeId').lean();
      if (promotion) {
        promotionById.set(String(promotion._id), promotion);
        entryNodeId = promotion.entryNodeId ? String(promotion.entryNodeId) : null;
      }
    } else if (flow.entryNodeId) {
      entryNodeId = String(flow.entryNodeId);
    }
  }
  const [nodes] = await assemble(deps, ws, { roots: [{ entryNodeId }], flowById, promotionById });
  return { ownerType, ownerId: id, messageSource, nodes };
}

module.exports = { buildFlowTrees, buildOwnerTree, buildPromotionTrees, MAX_PROMOTION_ROWS, MAX_PROMOTIONS_SCANNED, realDeps };
