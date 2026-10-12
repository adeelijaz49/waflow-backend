'use strict';
// Campaign service facade (routes/localization/campaigns.js calls only this):
// create / list / get / cancel / plan / segments / send / recipients / report,
// plus the two functions other slices call — sendSingle (Inbox "send loyalty
// reminder") and resumeStuckCampaigns (the scheduler).
//
// Everything is workspace-scoped (workspaceId always comes from the verified
// token, never the body), ids go through assertObjectId, request bodies reach
// the database only through explicit allow-lists, and nothing is ever deleted:
// cancel is a status change. The send itself lives in campaignSender.js.
//
// The persisted `plan` is a preview aid only (the sender re-plans at send time)
// and carries no recipient names (campaignPlanner.stripSamples).
const planner = require('./campaignPlanner');
const sender = require('./campaignSender');
const { SEGMENTS, httpError, asObjectId, isPlainObject } = require('./audience');

const CAMPAIGN_STATUSES = Object.freeze(['draft', 'sending', 'sent', 'partial', 'failed', 'cancelled']);
const SEND_STATUSES = Object.freeze([
  'queued', 'sending', 'sent', 'failed', 'skipped_no_consent', 'skipped_opted_out', 'skipped_blocked',
  'skipped_no_credit', 'skipped_demo', 'skipped_error',
]);
const LANGUAGES = Object.freeze(['en', 'ar', 'bilingual']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_PAGE = 100000;
const MAX_NAME = 120;
const DELIVERY_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

function realDeps() { return sender.realDeps(); }

// ── helpers ─────────────────────────────────────────────────────────────────

function iso(value) { return value ? new Date(value).toISOString() : null; }

function plain(doc) { return doc && typeof doc.toObject === 'function' ? doc.toObject() : doc; }

function wholeNumber(value, fallback) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,9}$/.test(value)) return Number(value);
  return fallback;
}

function parsePaging(query) {
  const q = isPlainObject(query) ? query : {};
  const page = Math.min(Math.max(wholeNumber(q.page, 1), 1), MAX_PAGE);
  const limit = Math.min(Math.max(wholeNumber(q.limit, DEFAULT_LIMIT), 1), MAX_LIMIT);
  return { page, limit };
}

function optionalEnum(value, allowed, label) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw httpError(400, 'INVALID_INPUT', `${label} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function cleanName(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_NAME * 4) throw httpError(400, 'INVALID_INPUT', 'name is required (max 120 characters)');
  const name = raw.replace(/[\u{0}-\u{1F}\u{7F}\u{2028}\u{2029}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!name) throw httpError(400, 'INVALID_INPUT', 'name is required');
  if (Array.from(name).length > MAX_NAME) throw httpError(400, 'INVALID_INPUT', `name is too long (max ${MAX_NAME} characters)`);
  return name;
}

function viewStats(stats) {
  const s = stats || {};
  const byLanguage = s.byLanguage || {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    total: n(s.total), sent: n(s.sent), failed: n(s.failed), skipped: n(s.skipped),
    byLanguage: { en: n(byLanguage.en), ar: n(byLanguage.ar), bilingual: n(byLanguage.bilingual) },
  };
}

function viewAudience(audience, { withIds }) {
  const a = audience || {};
  const view = { kind: a.kind || 'all_eligible' };
  if (a.kind === 'customer_ids' && withIds) view.customerIds = (a.customerIds || []).map(String);
  if (a.kind === 'segment') {
    view.segmentKey = a.segmentKey;
    const p = a.segmentParams || {};
    view.segmentParams = {};
    if (p.language !== undefined) view.segmentParams.language = p.language;
    if (p.days !== undefined) view.segmentParams.days = p.days;
    if (p.minPoints !== undefined) view.segmentParams.minPoints = p.minPoints;
  }
  return view;
}

function viewFieldValues(raw) {
  const out = {};
  if (isPlainObject(raw)) for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') out[key] = value;
  return out;
}

// LocalizedCampaignView (localization.types.ts). `list` views leave out the chosen
// customer ids (a campaign can hold thousands) and the plan's sample previews.
function toView(doc, { list = false } = {}) {
  const plan = doc.plan && typeof doc.plan === 'object' ? { ...doc.plan, sampleRecipients: [] } : null;
  return {
    id: String(doc._id),
    name: doc.name,
    templateId: String(doc.templateId),
    templateName: doc.templateName || (plan && plan.templateName) || '',
    languageMode: doc.languageMode || 'per_customer',
    audience: viewAudience(doc.audience, { withIds: !list }),
    fieldValues: viewFieldValues(doc.fieldValues),
    status: doc.status,
    plan,
    stats: viewStats(doc.stats),
    startedAt: iso(doc.startedAt),
    finishedAt: iso(doc.finishedAt),
    lastError: doc.lastError || null,
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
}

function audienceDoc(spec) {
  const doc = { kind: spec.kind };
  if (spec.kind === 'customer_ids') doc.customerIds = spec.customerIds;
  if (spec.kind === 'segment') { doc.segmentKey = spec.segmentKey; doc.segmentParams = spec.segmentParams; }
  return doc;
}

async function mustFindCampaign(deps, workspaceId, id, select) {
  const cid = asObjectId(id, 'campaign id');
  const query = deps.LocalizedCampaign.findOne({ _id: cid, workspaceId });
  const doc = await (select ? query.select(select) : query).lean();
  if (!doc) throw httpError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
  return doc;
}

// ── endpoints ───────────────────────────────────────────────────────────────

function segments() {
  return { items: SEGMENTS.map((s) => ({ key: s.key, params: [...s.params] })) };
}

async function plan({ workspaceId, body }, deps = realDeps()) {
  return planner.planCampaign({ workspaceId, request: body }, deps);
}

async function create({ workspaceId, userId, body }, deps = realDeps()) {
  const b = isPlainObject(body) ? body : {};
  const name = cleanName(b.name);
  const request = planner.normalizePlanRequest(b);
  const built = await planner.buildPlan({ workspaceId, request }, deps);
  if (built.plan.warnings.some((w) => w.code === 'template_archived')) {
    throw httpError(422, 'TEMPLATE_UNUSABLE', 'This template is archived');
  }
  const doc = await deps.LocalizedCampaign.create({
    workspaceId,
    name,
    templateId: built.template._id,
    templateName: built.template.name,
    languageMode: request.languageMode,
    audience: audienceDoc(request.audience),
    fieldValues: request.fieldValues,
    category: built.plan.category,
    status: 'draft',
    plan: planner.stripSamples(built.plan),
    ...(userId && /^[a-fA-F0-9]{24}$/.test(String(userId)) ? { createdBy: String(userId) } : {}),
  });
  return toView(plain(doc));
}

async function list({ workspaceId, query }, deps = realDeps()) {
  const q = isPlainObject(query) ? query : {};
  const status = optionalEnum(q.status, CAMPAIGN_STATUSES, 'status');
  const { page, limit } = parsePaging(q);
  const filter = { workspaceId, ...(status ? { status } : {}) };
  const [items, total] = await Promise.all([
    // _id order IS creation order (an ObjectId starts with its creation time) and _id is always
    // indexed: Cosmos DB for MongoDB rejects a {createdAt, _id} sort that has no compound index.
    deps.LocalizedCampaign.find(filter).sort({ _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    deps.LocalizedCampaign.countDocuments(filter),
  ]);
  return { items: items.map((doc) => toView(doc, { list: true })), total, page, limit };
}

async function get({ workspaceId, id }, deps = realDeps()) {
  return toView(await mustFindCampaign(deps, workspaceId, id));
}

async function send({ workspaceId, id, acknowledge }, deps = realDeps()) {
  const { campaign } = await sender.startSend({ workspaceId, campaignId: id, acknowledge }, deps);
  return { campaign: toView(campaign) };
}

// draft | sending -> cancelled. A running sender notices on its next iteration (at
// most the one message already in flight still goes out); recipients not reached
// yet are closed as skipped. Cancelling a cancelled campaign is a no-op.
async function cancel({ workspaceId, id }, deps = realDeps()) {
  const cid = asObjectId(id, 'campaign id');
  const cancelled = await deps.LocalizedCampaign.findOneAndUpdate(
    { _id: cid, workspaceId, status: { $in: ['draft', 'sending'] } },
    { $set: { status: 'cancelled', finishedAt: new Date(deps.now()) } },
    { returnDocument: 'after' },
  ).lean();
  if (!cancelled) {
    const existing = await mustFindCampaign(deps, workspaceId, cid);
    if (existing.status === 'cancelled') return toView(existing);
    throw httpError(409, 'CAMPAIGN_NOT_DRAFT', 'This campaign has already finished');
  }
  try {
    await sender.cancelQueuedRows(deps, { campaignId: cancelled._id, workspaceId });
    const { stats } = sender.statsFromGroups(await sender.aggregateRows(deps, { campaignId: cancelled._id, workspaceId }));
    const refreshed = await deps.LocalizedCampaign.findOneAndUpdate(
      { _id: cancelled._id, workspaceId, status: 'cancelled' }, { $set: { stats } }, { returnDocument: 'after' },
    ).lean();
    return toView(refreshed || cancelled);
  } catch (err) {
    // The campaign IS cancelled; a running sender closes the leftover rows itself.
    deps.log('closing the recipients of a cancelled campaign failed:', err && err.message);
    return toView(cancelled);
  }
}

function deliveryOf(row, message) {
  if (row.status !== 'sent') return null;
  if (message && DELIVERY_STATUSES.has(message.status)) return message.status;
  return 'sent';
}

async function messageStatuses(deps, workspaceId, wamids) {
  const map = new Map();
  for (let i = 0; i < wamids.length; i += 1000) {
    const rows = await deps.CampaignMessage.find({ workspaceId, wamid: { $in: wamids.slice(i, i + 1000) } }).select('wamid status').lean();
    for (const row of rows) map.set(row.wamid, row);
  }
  return map;
}

async function recipients({ workspaceId, id, query }, deps = realDeps()) {
  const campaign = await mustFindCampaign(deps, workspaceId, id, '_id');
  const q = isPlainObject(query) ? query : {};
  const status = optionalEnum(q.status, SEND_STATUSES, 'status');
  const language = optionalEnum(q.language, LANGUAGES, 'language');
  const { page, limit } = parsePaging(q);
  const filter = { campaignId: campaign._id, workspaceId, ...(status ? { status } : {}), ...(language ? { usedLanguage: language } : {}) };

  const [rows, total] = await Promise.all([
    deps.LocalizedSend.find(filter).sort({ _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    deps.LocalizedSend.countDocuments(filter),
  ]);
  const customers = rows.length
    ? await deps.Customer.find({ _id: { $in: rows.map((r) => r.customerId) }, workspaceId }).select('firstname lastname phone').lean()
    : [];
  const byCustomer = new Map(customers.map((c) => [String(c._id), c]));
  const messages = await messageStatuses(deps, workspaceId, rows.map((r) => r.wamid).filter(Boolean));

  const items = rows.map((row) => {
    const customer = byCustomer.get(String(row.customerId));
    return {
      customerId: String(row.customerId),
      // The CURRENT customer record wins: an erased customer shows as anonymised
      // instead of resurfacing the number kept on the send row.
      name: customer ? planner.displayName(customer) : row.phone,
      phone: customer ? String(customer.phone || '') : row.phone,
      requestedLanguage: row.requestedLanguage || null,
      usedLanguage: row.usedLanguage || null,
      fallback: !!row.fallback,
      fallbackReason: row.fallbackReason || null,
      status: row.status,
      deliveryStatus: deliveryOf(row, messages.get(row.wamid)),
      wamid: row.wamid || null,
      error: row.error || null,
      errorCode: row.errorCode || null,
    };
  });
  return { items, total, page, limit };
}

function emptyFunnel() { return { sent: 0, delivered: 0, read: 0, failed: 0 }; }

// Per language: sent -> delivered -> read as a funnel (cumulative, like the existing
// campaign report), `failed` = rejected at send time or later reported failed by
// the delivery webhook.
async function report({ workspaceId, id }, deps = realDeps()) {
  const campaign = await mustFindCampaign(deps, workspaceId, id);
  const campaignId = campaign._id;
  const groups = await sender.aggregateRows(deps, { campaignId, workspaceId });
  const { stats, byStatus } = sender.statsFromGroups(groups);

  const byLanguage = { en: emptyFunnel(), ar: emptyFunnel(), bilingual: emptyFunnel() };
  for (const group of groups) {
    if (group._id.status === 'failed' && byLanguage[group._id.usedLanguage]) byLanguage[group._id.usedLanguage].failed += group.count;
  }
  const sentRows = await deps.LocalizedSend.find({ campaignId, workspaceId, status: 'sent' }).select('wamid usedLanguage').lean();
  const messages = await messageStatuses(deps, workspaceId, sentRows.map((r) => r.wamid).filter(Boolean));
  for (const row of sentRows) {
    const bucket = byLanguage[row.usedLanguage];
    if (!bucket) continue;
    const message = messages.get(row.wamid);
    const status = message && DELIVERY_STATUSES.has(message.status) ? message.status : 'sent';
    if (status === 'failed') { bucket.failed += 1; continue; }
    bucket.sent += 1;
    if (status === 'delivered' || status === 'read') bucket.delivered += 1;
    if (status === 'read') bucket.read += 1;
  }
  const fallbackCount = await deps.LocalizedSend.countDocuments({ campaignId, workspaceId, status: 'sent', fallback: true });

  const orderedStatus = {};
  for (const status of SEND_STATUSES) if (byStatus[status]) orderedStatus[status] = byStatus[status];
  return { campaignId: String(campaignId), status: campaign.status, stats, byLanguage, byStatus: orderedStatus, fallbackCount };
}

module.exports = {
  CAMPAIGN_STATUSES, SEND_STATUSES, MAX_LIMIT, DEFAULT_LIMIT,
  realDeps, toView, parsePaging, segments, plan, create, list, get, send, cancel, recipients, report,
  sendSingle: sender.sendSingle,
  resumeStuckCampaigns: sender.resumeStuckCampaigns,
};
