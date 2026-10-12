'use strict';
// Arabic versions of branching FOLLOW-UP messages (backlog A4). A follow-up is a MessageNode that is not an
// entry node: the bot sends it as a free-form reply (text or interactive buttons) after the customer taps a
// button of the previous message, inside the 24-hour window that tap just opened. So an Arabic follow-up
// needs NO Meta approval, only native review (spec section 8), and the sender (followUpSender.js) uses it
// only when this module says it is `sendable`.
//
// This file is the single truth for the rules, shared by the authoring routes, the tree listing and the
// sender:
//   * evaluateVariant(node, owner, variant) -> { issues, warnings, stale, sendable, slotFields }  (pure)
//   * getFollowUp / saveVariant / reviewVariant   (the store; every query is workspace-scoped)
//
// Structure rules (the English node stays the single source of truth for structure):
//   * Merge fields: Arabic text uses named {field} placeholders only, from the node's slot list
//     (flowMessages.slotFieldsFor) or {name} when that list is empty: the English reply ALWAYS substitutes
//     {{1}} with the customer's first name, whatever the trigger.
//   * Buttons keep the node's POSITIONS (the tap payload is msgnode_<nodeId>_<position>); nextAction is never
//     stored here. Labels are 1-20 code points and unique (WhatsApp rejects duplicate reply titles).
//   * Body: non-empty, no {{1}} / stray braces, at most 1024 code points when the node has buttons
//     (interactive body limit), 4096 without (text limit). Hidden / bidi characters are stripped on save.
//   * `stale`: the English node (body or any button position/label) changed after this row was written
//     (sourceHash). A stale row is never sent: an offer or price edited in English must not keep going out in
//     an old Arabic version. The merchant re-saves and re-reviews.
//   * `sendable` = no issues && reviewStatus 'reviewed' && !stale.
// Saving never rejects a structurally sane draft (partial and AI drafts are savable); it returns `issues`.
// Any change to the text, the labels or the English source resets the review to `draft` and bumps
// `contentVersion`; marking `reviewed` is refused while issues exist or the row is stale, and is guarded by
// `contentVersion` (a review is tied to the exact text that was read). There is no delete: "turn off" = back
// to draft. AI text is stored with source 'ai' but changes nothing about the gate.
const crypto = require('crypto');
const { isObjectIdLike } = require('./scope');
const { stripInvisibles } = require('./arabicText');
const { findInvalidPlaceholders, extractFields } = require('./mergeFields');
const { validateButtonLabel, charLength } = require('./metaConstraints');
const { slotFieldsFor, slotsToFields, loadOwnedNode } = require('./flowMessages');

const FOLLOWUP_LIMITS = Object.freeze({ bodyInteractive: 1024, bodyText: 4096, label: 20 });
// Storage caps for what a client may send (validation still reports the lower WhatsApp limits).
const STORAGE_CAPS = Object.freeze({ body: 8000, label: 200, buttons: 3 });
const MAX_ATTEMPTS = 3;
const REVIEW_STATUSES = Object.freeze(['draft', 'reviewed']);
const SOURCES = Object.freeze(['merchant', 'ai']);
const PRIVATE_USE_ZWJ = '\u{E000}';

class FollowUpError extends Error {
  constructor(status, code, message, { issues } = {}) {
    super(message);
    this.name = 'FollowUpError';
    this.status = status;
    this.code = code;
    this.expose = true;
    this.body = { error: message, code, ...(issues ? { issues } : {}) };
  }
}

// ── Pure rules ────────────────────────────────────────────────────────────
function slotFieldsOf(node, owner) {
  const fields = slotFieldsFor({ ownerType: node && node.ownerType, triggerType: owner && owner.triggerType });
  return fields.length ? Array.from(fields) : ['name'];
}

function sortedButtons(node) {
  return (Array.isArray(node && node.buttons) ? node.buttons : [])
    .map((b) => [Number(b.position), String(b.label === undefined || b.label === null ? '' : b.label)])
    .sort((a, b) => a[0] - b[0]);
}

// Fingerprint of what the Arabic text was written against.
function hashSource(node) {
  const text = JSON.stringify([String((node && node.bodyText) || ''), sortedButtons(node)]);
  return crypto.createHash('sha1').update(text).digest('hex');
}

// Hidden / bidi characters out; a ZWJ between two emoji (a family or profession emoji) is kept.
function cleanText(value) {
  const text = typeof value === 'string' ? value : '';
  const guarded = text
    .split(PRIVATE_USE_ZWJ).join('')
    .replace(/(\p{Extended_Pictographic}\u{FE0F}?)\u{200D}(?=\p{Extended_Pictographic})/gu, `$1${PRIVATE_USE_ZWJ}`);
  return stripInvisibles(guarded).split(PRIVATE_USE_ZWJ).join('\u{200D}');
}

// The English node as the author and the AI see it: {{n}} -> {field}. bodyFields is null (+ slotProblem)
// when the text cannot be expressed that way (unknown slot, stray braces); it stays authorable.
function englishOf(node, owner) {
  const slotFields = slotFieldsOf(node, owner);
  const converted = slotsToFields(node.bodyText, slotFields);
  return {
    bodyText: String(node.bodyText || ''),
    bodyFields: converted.ok ? converted.text : null,
    slotProblem: converted.ok ? null : { reason: converted.reason, ...(converted.slot ? { slot: converted.slot } : {}) },
    slotFields,
    buttons: sortedButtons(node).map(([position, label]) => ({ position, label })),
  };
}

function bodyLimitFor(node) {
  return Array.isArray(node && node.buttons) && node.buttons.length ? FOLLOWUP_LIMITS.bodyInteractive : FOLLOWUP_LIMITS.bodyText;
}

function isStale(node, row) {
  return !row || !row.sourceHash || row.sourceHash !== hashSource(node);
}

// variant: { body, buttons: [{ position, text }], reviewStatus?, sourceHash? }
// -> { issues: ValidationIssue[], warnings: ValidationIssue[], stale, sendable, slotFields }
function evaluateVariant(node, owner, variant) {
  const slotFields = slotFieldsOf(node, owner);
  const issues = [];
  const warnings = [];
  const v = variant || {};
  const body = typeof v.body === 'string' ? v.body : '';

  if (!body.trim()) issues.push({ code: 'body_required', field: 'body' });
  for (const code of findInvalidPlaceholders(body)) issues.push({ code, field: 'body' });
  const used = extractFields(body);
  for (const field of used) {
    if (!slotFields.includes(field)) issues.push({ code: 'followup_unknown_field', field: 'body', detail: { field } });
  }
  const max = bodyLimitFor(node);
  const length = charLength(body);
  if (length > max) issues.push({ code: 'body_too_long', field: 'body', detail: { length, max } });

  const nodePositions = sortedButtons(node).map(([position]) => position);
  const stored = Array.isArray(v.buttons) ? v.buttons : [];
  const foundPositions = stored.map((b) => Number(b && b.position)).sort((a, b) => a - b);
  const sameSet = nodePositions.length === foundPositions.length && nodePositions.every((p, i) => p === foundPositions[i]);
  if (!sameSet) issues.push({ code: 'followup_button_mismatch', field: 'buttons', detail: { expected: nodePositions.length, found: foundPositions.length } });

  const seen = new Set();
  for (const position of nodePositions) {
    const button = stored.find((b) => Number(b && b.position) === position);
    if (!button) continue; // reported as a mismatch above
    const field = `button_${position}`;
    const check = validateButtonLabel(button.text);
    if (!check.ok) {
      issues.push({ code: check.code, field, ...(check.max ? { detail: { length: check.length, max: check.max } } : {}) });
      continue;
    }
    const key = String(button.text).trim().toLowerCase();
    if (seen.has(key)) issues.push({ code: 'duplicate_button_label', field });
    seen.add(key);
  }

  // English uses a field that the Arabic text leaves out: allowed, but worth a look.
  const english = englishOf(node, owner);
  if (english.bodyFields && body.trim()) {
    for (const field of extractFields(english.bodyFields)) {
      if (!used.includes(field)) warnings.push({ code: 'followup_field_dropped', field: 'body', detail: { field } });
    }
  }

  const stale = isStale(node, v);
  return { issues, warnings, stale, sendable: issues.length === 0 && v.reviewStatus === 'reviewed' && !stale, slotFields };
}

// ── Input ─────────────────────────────────────────────────────────────────
function invalidInput(message) {
  return new FollowUpError(400, 'INVALID_INPUT', message);
}

// Client input -> { body, buttons: [{ position, text }], source }. Throws 400 only for things that are not
// even structurally sane; everything else is a savable draft whose problems come back as `issues`.
function normalizeInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (typeof raw.body !== 'string') throw invalidInput('body must be a string');
  if (raw.body.length > STORAGE_CAPS.body) throw invalidInput('body is too long');
  const list = raw.buttons === undefined ? [] : raw.buttons;
  if (!Array.isArray(list) || list.length > STORAGE_CAPS.buttons) throw invalidInput('buttons must be an array of at most 3 entries');
  const buttons = list.map((b) => {
    const position = b && Number(b.position);
    if (!b || typeof b !== 'object' || !Number.isInteger(position) || position < 0 || position > 2) throw invalidInput('each button needs a position from 0 to 2');
    if (b.text !== undefined && typeof b.text !== 'string') throw invalidInput('button text must be a string');
    const text = cleanText(b.text || '');
    if (text.length > STORAGE_CAPS.label) throw invalidInput('button text is too long');
    return { position, text };
  });
  const source = raw.source === undefined ? 'merchant' : raw.source;
  if (!SOURCES.includes(source)) throw invalidInput('source must be merchant or ai');
  return { body: cleanText(raw.body), buttons: buttons.sort((a, b) => a.position - b.position), source };
}

// ── Store ─────────────────────────────────────────────────────────────────
function realDeps() {
  return {
    Flow: require('../../models/Flow'),
    Promotion: require('../../models/Promotion'),
    MessageNode: require('../../models/MessageNode'),
    LocalizedFlowNode: require('../../models/LocalizedFlowNode'),
    getReviewerName: async (userId) => {
      if (!isObjectIdLike(userId)) return null;
      const user = await require('../../models/User').findById(userId).select('name phone').lean();
      return user ? (user.name || user.phone || null) : null;
    },
    now: () => new Date(),
    log: (...args) => console.error('[localization]', ...args),
  };
}

function requireWorkspace(workspaceId) {
  if (!isObjectIdLike(workspaceId)) throw new FollowUpError(403, 'FORBIDDEN', 'A workspace is required');
  return String(workspaceId).toLowerCase();
}

function requireNodeId(value) {
  if (!isObjectIdLike(value)) throw new FollowUpError(400, 'INVALID_ID', 'Invalid message id');
  return String(value).toLowerCase();
}

function plain(doc) {
  return doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
}

// -> { node, owner } for a node that is provably this workspace's follow-up (404 / 422 otherwise).
async function loadFollowUpContext(deps, workspaceId, nodeId) {
  const owned = await loadOwnedNode(deps, workspaceId, nodeId);
  if (!owned) throw new FollowUpError(404, 'NODE_NOT_FOUND', 'Flow message not found');
  if (owned.node.isEntryNode) {
    throw new FollowUpError(422, 'NODE_NOT_LOCALIZABLE', 'The first message of a flow is a WhatsApp template: use the template editor for its Arabic version');
  }
  return owned;
}

function findRow(deps, workspaceId, nodeId) {
  return deps.LocalizedFlowNode.findOne({ workspaceId, messageNodeId: nodeId, language: 'ar' }).lean();
}

function variantView(node, owner, row) {
  const evaluation = evaluateVariant(node, owner, row);
  return {
    variant: {
      language: 'ar',
      body: row.body || '',
      buttons: (row.buttons || []).map((b) => ({ position: b.position, text: b.text })),
      contentVersion: row.contentVersion || 1,
      reviewStatus: row.reviewStatus === 'reviewed' ? 'reviewed' : 'draft',
      reviewedBy: row.reviewedBy || null,
      reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null,
      source: row.source === 'ai' ? 'ai' : 'merchant',
      stale: evaluation.stale,
      sendable: evaluation.sendable,
    },
    evaluation,
  };
}

// The answer of every follow-up endpoint:
// { messageNodeId, ownerType, ownerId, english: {...}, variant: null | {...}, issues, warnings, stale, sendable }
function toView(node, owner, row) {
  const english = englishOf(node, owner);
  const base = {
    messageNodeId: String(node._id),
    ownerType: node.ownerType === 'promotion' ? 'promotion' : 'flow',
    ownerId: node.ownerId ? String(node.ownerId) : null,
    english,
  };
  if (!row) return { ...base, variant: null, issues: [], warnings: [], stale: false, sendable: false };
  const { variant, evaluation } = variantView(node, owner, row);
  return { ...base, variant, issues: evaluation.issues, warnings: evaluation.warnings, stale: evaluation.stale, sendable: evaluation.sendable };
}

async function getFollowUp({ workspaceId, nodeId } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const nid = requireNodeId(nodeId);
  const { node, owner } = await loadFollowUpContext(deps, ws, nid);
  return toView(node, owner, await findRow(deps, ws, nid));
}

function sameButtons(a, b) {
  const left = (a || []).map((x) => `${x.position}:${x.text}`).sort().join('|');
  const right = (b || []).map((x) => `${x.position}:${x.text}`).sort().join('|');
  return left === right;
}

function isDuplicateKey(err) {
  return !!err && (err.code === 11000 || err.code === 11001);
}

async function saveVariant({ workspaceId, userId, nodeId, input } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const nid = requireNodeId(nodeId);
  const { node, owner } = await loadFollowUpContext(deps, ws, nid);
  const norm = normalizeInput(input);
  const sourceHash = hashSource(node);
  const ownerFields = { ownerType: node.ownerType === 'promotion' ? 'promotion' : 'flow', ...(node.ownerId ? { ownerId: node.ownerId } : {}) };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const row = await findRow(deps, ws, nid);
    if (!row) {
      try {
        const created = await deps.LocalizedFlowNode.create({
          workspaceId: ws, messageNodeId: nid, language: 'ar', ...ownerFields,
          body: norm.body, buttons: norm.buttons, contentVersion: 1, sourceHash,
          reviewStatus: 'draft', source: norm.source, ...(isObjectIdLike(userId) ? { createdBy: userId } : {}),
        });
        return toView(node, owner, plain(created));
      } catch (err) {
        if (isDuplicateKey(err)) continue; // another save created it first: merge into that row
        throw err;
      }
    }
    // An identical save of a row that is still in step with the English node changes nothing.
    if (row.body === norm.body && sameButtons(row.buttons, norm.buttons) && row.sourceHash === sourceHash) {
      return toView(node, owner, row);
    }
    const updated = await deps.LocalizedFlowNode.findOneAndUpdate(
      { _id: row._id, workspaceId: ws, contentVersion: row.contentVersion },
      {
        $set: { body: norm.body, buttons: norm.buttons, sourceHash, source: norm.source, reviewStatus: 'draft', ...ownerFields },
        $unset: { reviewedBy: '', reviewedById: '', reviewedAt: '' },
        $inc: { contentVersion: 1 },
      },
      { returnDocument: 'after' },
    ).lean();
    if (updated) return toView(node, owner, updated);
  }
  throw new FollowUpError(409, 'CONFLICT', 'This message was changed by someone else: reload it and try again');
}

async function reviewerName(deps, userId) {
  try {
    return (await deps.getReviewerName(userId)) || 'Reviewer';
  } catch (err) {
    deps.log('reviewer lookup failed:', err && err.message);
    return 'Reviewer';
  }
}

async function reviewVariant({ workspaceId, userId, nodeId, status, contentVersion } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const nid = requireNodeId(nodeId);
  if (!REVIEW_STATUSES.includes(status)) throw invalidInput('status must be reviewed or draft');
  if (!Number.isInteger(contentVersion) || contentVersion < 1) throw invalidInput('contentVersion is required');
  const { node, owner } = await loadFollowUpContext(deps, ws, nid);
  const row = await findRow(deps, ws, nid);
  if (!row) throw new FollowUpError(404, 'VARIANT_NOT_FOUND', 'There is no Arabic version of this message yet');
  // The review is tied to the exact text that was read.
  if ((row.contentVersion || 1) !== contentVersion) throw new FollowUpError(409, 'CONFLICT', 'This message was changed by someone else: reload it and try again');

  if (status === 'reviewed') {
    const evaluation = evaluateVariant(node, owner, row);
    if (evaluation.issues.length) throw new FollowUpError(400, 'VARIANT_INVALID', 'Fix the problems in this Arabic version before marking it as reviewed', { issues: evaluation.issues });
    if (evaluation.stale) throw new FollowUpError(409, 'STALE_SOURCE', 'The English message changed after this Arabic version was written: save the Arabic version again first');
  } else if (row.reviewStatus !== 'reviewed') {
    return toView(node, owner, row); // already a draft
  }

  const update = status === 'reviewed'
    ? { $set: { reviewStatus: 'reviewed', reviewedBy: await reviewerName(deps, userId), reviewedAt: deps.now(), ...(isObjectIdLike(userId) ? { reviewedById: userId } : {}) } }
    : { $set: { reviewStatus: 'draft' }, $unset: { reviewedBy: '', reviewedById: '', reviewedAt: '' } };
  if (status === 'reviewed' && !isObjectIdLike(userId)) update.$unset = { reviewedById: '' };
  const updated = await deps.LocalizedFlowNode.findOneAndUpdate(
    { _id: row._id, workspaceId: ws, contentVersion: row.contentVersion },
    update,
    { returnDocument: 'after' },
  ).lean();
  if (!updated) throw new FollowUpError(409, 'CONFLICT', 'This message was changed by someone else: reload it and try again');
  return toView(node, owner, updated);
}

module.exports = {
  FOLLOWUP_LIMITS,
  FollowUpError,
  slotFieldsOf,
  hashSource,
  cleanText,
  englishOf,
  bodyLimitFor,
  isStale,
  evaluateVariant,
  normalizeInput,
  toView,
  getFollowUp,
  saveVariant,
  reviewVariant,
  realDeps,
};
