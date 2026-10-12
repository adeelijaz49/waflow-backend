'use strict';
// The language PLAN for the existing sender screens (D1 section 3.8): what each selected customer would receive if
// the merchant pressed Send in the legacy composer (promotion), the loyalty-reminder dialog or the consent-request
// dialog. READ-ONLY and advisory: no network, no writes, and the existing /send routes are never gated by it
// ("English fallback" is what happens today). It runs the SAME decision code as the send (legacySenders.decide), so
// plan and send cannot drift.
//
//   planPromotionSend({ workspaceId, promotionId, customerIds, includeIds }) -> PromotionSendPlan
//   planSender({ workspaceId, sender: 'loyalty_reminder' | 'consent_request', customerIds?, includeIds }) -> SenderSendPlan
//
// It does NOT use audience.resolveAudience (2000-id cap, de-duplication the real send does not apply): "eligible"
// is exactly the existing filter (canSendMarketing, demo exempt for a promotion / loyalty reminder).
const { assertObjectId, assertObjectIdArray } = require('./scope');
const audience = require('./audience');
const legacySenders = require('./legacySenders');
const senderVariants = require('./senderVariants');
const { isTransactionalUseCase } = require('./category');
const { describeMetaError } = require('./statusErrors');

const MAX_CUSTOMERS = 5000;
const LARGE_AUDIENCE = 250; // messaging tier TIER_250: unique customers per 24 h (same figure as the campaign planner)
const CUSTOMER_FIELDS = 'workspaceId firstname lastname phone loyaltyPoints marketingConsent marketingConsentAskedAt optedOut isDemo deletedAt';
const SENDER_KINDS = Object.freeze(['loyalty_reminder', 'consent_request']);

function realDeps() {
  return {
    ...legacySenders.realDeps(),
    Promotion: require('../../models/Promotion'),
    LocalizedLegacySend: require('../../models/LocalizedLegacySend'),
    CampaignMessage: require('../../models/CampaignMessage'),
  };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function bump(map, key, by = 1) { map.set(key, (map.get(key) || 0) + by); }

const byCountThenReason = (a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1);

function entries(map) {
  return Array.from(map, ([reason, count]) => ({ reason, count })).sort(byCountThenReason);
}

async function findCustomers(deps, workspaceId, ids) {
  const out = [];
  for (const slice of audience.chunk(ids, 1000)) {
    out.push(...await deps.Customer.find({ workspaceId, _id: { $in: slice } }).select(CUSTOMER_FIELDS).lean());
  }
  return out;
}

// Same-phone duplicates inside the selection (the real send messages each record: it does not de-duplicate).
function duplicatePhoneCount(customers) {
  const seen = new Map();
  for (const c of customers) {
    const phone = audience.normalizeRecipientPhone(c.phone);
    if (phone) bump(seen, phone);
  }
  let duplicates = 0;
  for (const count of seen.values()) if (count > 1) duplicates += count - 1;
  return duplicates;
}

// Runs `decide` for every customer. -> tallies + (optionally) the id buckets.
async function classify(run, customers, { demoOf }) {
  const tally = {
    ar: 0, en: 0, demo: 0, excluded: 0,
    fallbacks: new Map(), blocked: new Map(),
    arabicIds: [], fallbackIds: [], excludedIds: [],
  };
  for (const customer of customers) {
    if (demoOf(customer)) { tally.demo += 1; continue; }
    let d;
    try {
      d = await run.decide(customer);
    } catch (err) {
      d = { action: 'english', reason: 'internal_error', arabic: run.isArabic(customer) };
    }
    const id = String(customer._id);
    if (d.action === 'arabic') { tally.ar += 1; tally.arabicIds.push(id); }
    else if (d.action === 'exclude' || d.action === 'skip') {
      tally.excluded += 1;
      tally.excludedIds.push(id);
      bump(tally.blocked, d.action === 'exclude' ? d.reason : 'template_unusable');
    } else {
      tally.en += 1;
      if (d.arabic && d.reason) { bump(tally.fallbacks, d.reason); tally.fallbackIds.push(id); }
    }
  }
  return tally;
}

function warningsFor({ tally, choice, customers, carousel }) {
  const warnings = [];
  if (carousel) warnings.push({ code: 'carousel_english_only' });
  for (const { reason, count } of entries(tally.fallbacks)) warnings.push({ code: 'arabic_fallback', detail: { count, reason } });
  if (choice && choice.template) {
    const useCase = choice.template.useCase || 'custom';
    if (choice.template.category === 'UTILITY' && !isTransactionalUseCase(useCase)) warnings.push({ code: 'category_floored', detail: { useCase } });
  }
  if (choice && choice.reason === 'no_opt_out_button') warnings.push({ code: 'marketing_variant_missing_opt_out', detail: { language: 'ar' } });
  if (choice && choice.usable && choice.source === 'promotion' && !choice.hasShopButton) warnings.push({ code: 'no_shop_now_button' });
  if (tally.ar + tally.en > LARGE_AUDIENCE) warnings.push({ code: 'large_audience', detail: { count: tally.ar + tally.en } });
  const duplicates = duplicatePhoneCount(customers);
  if (duplicates > 0) warnings.push({ code: 'duplicate_phones_in_selection', detail: { count: duplicates } });
  return warnings;
}

function consentCounts(requested, eligibleCount) {
  const optedOut = requested.filter((c) => c.optedOut).length;
  return { optedOut, noConsent: requested.length - eligibleCount - optedOut };
}

async function variantInfo(run, workspaceId) {
  try {
    const ctx = await run.workspaceContext(String(workspaceId));
    return { choice: ctx.choice, info: senderVariants.describeChoice(ctx.choice) };
  } catch (err) {
    return { choice: null, info: null };
  }
}

function finish({ base, tally, requestedCount, eligibleCount, skippedCounts, choice, info, customers, includeIds, carousel }) {
  const fallbacks = entries(tally.fallbacks).map(({ reason, count }) => ({ from: 'ar', to: 'en', reason, count }));
  const blocked = entries(tally.blocked);
  const plan = {
    ...base,
    selected: requestedCount,
    eligible: eligibleCount,
    skipped: {
      noConsent: skippedCounts.noConsent,
      optedOut: skippedCounts.optedOut,
      demoSimulated: tally.demo,
      optedOutSamePhone: tally.blocked.get('opted_out_same_phone') || 0,
    },
    byLanguage: { ar: tally.ar, en: tally.en },
    fallbacks,
    blocked,
    variant: carousel ? null : info,
    warnings: warningsFor({ tally, choice, customers, carousel }),
    canSend: true,
    needsAcknowledgement: fallbacks.length > 0 || blocked.length > 0,
  };
  if (includeIds) plan.buckets = { arabic: tally.arabicIds, englishFallback: tally.fallbackIds, excluded: tally.excludedIds };
  return plan;
}

// ── promotion ───────────────────────────────────────────────────────────────

async function planPromotionSend({ workspaceId, promotionId, customerIds, includeIds = false } = {}, deps = realDeps()) {
  if (!workspaceId) throw httpError(403, 'FORBIDDEN', 'A workspace is required');
  const ws = String(workspaceId);
  const promoId = assertObjectId(promotionId, 'promotionId');
  const ids = assertObjectIdArray(customerIds === undefined ? [] : customerIds, 'customerIds', { max: MAX_CUSTOMERS });
  const promotion = await deps.Promotion.findOne({ _id: promoId, workspaceId: ws }).populate('products').populate('services');
  if (!promotion) throw httpError(404, 'PROMOTION_NOT_FOUND', 'Promotion not found');

  const requested = ids.length ? await findCustomers(deps, ws, ids) : [];
  const eligible = requested.filter((c) => deps.consent.canSendMarketing(c) || promotion.isDemo || c.isDemo);
  const counts = consentCounts(requested, eligible.length);
  const base = { promotionId: String(promotion._id), promotionName: promotion.name, sendFormat: promotion.sendFormat || 'separate' };
  const carousel = promotion.sendFormat === 'carousel';

  // Carousel promotions are sent by a different module (shared/promotionCarousel.js): English only.
  if (carousel) {
    const demoOf = (c) => !!(promotion.isDemo || c.isDemo);
    const demo = eligible.filter(demoOf).length;
    const tally = { ar: 0, en: eligible.length - demo, demo, fallbacks: new Map(), blocked: new Map(), arabicIds: [], fallbackIds: [], excludedIds: [] };
    return finish({ base, tally, requestedCount: requested.length, eligibleCount: eligible.length, skippedCounts: counts, choice: null, info: null, customers: eligible, includeIds, carousel: true });
  }

  const items = await require('./senderValues').loadPromotionItems(deps, promotion);
  const run = await legacySenders.buildRun({ sender: 'promotion', workspaceId: ws, customers: eligible, promotion, items }, deps, { assumeFlagged: [ws] });
  const tally = await classify(run, eligible, { demoOf: (c) => !!(promotion.isDemo || c.isDemo) });
  const { choice, info } = await variantInfo(run, ws);
  return finish({ base, tally, requestedCount: requested.length, eligibleCount: eligible.length, skippedCounts: counts, choice, info, customers: eligible, includeIds, carousel: false });
}

// ── loyalty reminder / consent request ──────────────────────────────────────

// The audience filters of shared/operations.js (sendLoyaltyReminders / consentRequestEligibleFilter), restated here
// so the plan never loads the Stripe-backed operations module; tests/localization/legacyPlan.test.js pins them to
// the source text so they cannot drift silently.
function consentEligibleFilter(workspaceId, ids) {
  return {
    workspaceId,
    marketingConsent: { $ne: true },
    marketingConsentAskedAt: { $exists: false },
    optedOut: { $ne: true },
    isDemo: { $ne: true },
    ...(ids && ids.length ? { _id: { $in: ids } } : {}),
  };
}

async function planSender({ workspaceId, sender: kind, customerIds, includeIds = false } = {}, deps = realDeps()) {
  if (!workspaceId) throw httpError(403, 'FORBIDDEN', 'A workspace is required');
  if (!SENDER_KINDS.includes(kind)) throw httpError(404, 'SENDER_NOT_FOUND', 'Unknown sender');
  const ws = String(workspaceId);
  const ids = customerIds === undefined || customerIds === null ? [] : assertObjectIdArray(customerIds, 'customerIds', { max: MAX_CUSTOMERS });

  let requested;
  let eligible;
  let skippedCounts;
  let noPoints = 0;
  if (kind === 'loyalty_reminder') {
    const filter = ids.length ? { workspaceId: ws, _id: { $in: ids } } : { workspaceId: ws, loyaltyPoints: { $gt: 0 } };
    requested = await deps.Customer.find(filter).select(CUSTOMER_FIELDS).limit(MAX_CUSTOMERS + 1).lean();
    if (requested.length > MAX_CUSTOMERS) throw httpError(400, 'INVALID_INPUT', `At most ${MAX_CUSTOMERS} customers can be planned at once`);
    const consented = requested.filter((c) => deps.consent.canSendMarketing(c) || c.isDemo);
    eligible = consented.filter((c) => c.loyaltyPoints); // the sender skips customers without points
    noPoints = consented.length - eligible.length;
    skippedCounts = consentCounts(requested, consented.length);
  } else {
    requested = await deps.Customer.find(consentEligibleFilter(ws, ids)).select(CUSTOMER_FIELDS).limit(MAX_CUSTOMERS + 1).lean();
    if (requested.length > MAX_CUSTOMERS) throw httpError(400, 'INVALID_INPUT', `At most ${MAX_CUSTOMERS} customers can be planned at once`);
    eligible = requested;
    skippedCounts = { noConsent: 0, optedOut: 0 };
  }

  const run = await legacySenders.buildRun({ sender: kind, workspaceId: ws, customers: eligible }, deps, { assumeFlagged: [ws] });
  const tally = await classify(run, eligible, { demoOf: (c) => kind === 'loyalty_reminder' && !!c.isDemo });
  const { choice, info } = await variantInfo(run, ws);
  const plan = finish({ base: {}, tally, requestedCount: requested.length, eligibleCount: eligible.length, skippedCounts, choice, info, customers: eligible, includeIds, carousel: false });
  if (kind === 'loyalty_reminder') plan.skipped.noPoints = noPoints;
  return plan;
}

// ── per-language send report ────────────────────────────────────────────────

const MAX_REPORT_ROWS = 20000;
const emptyFunnel = () => ({ sent: 0, failed: 0, skipped: 0, delivered: 0, read: 0, clicked: 0, ordered: 0, deliveryFailed: 0 });

// GET /promotions/:id/send-report: what the legacy sends of this promotion did for ARABIC-resolved customers
// (LocalizedLegacySend rows: an Arabic send, an English fallback or a skip), joined by wamid with the delivery funnel
// the existing code keeps in CampaignMessage. English customers have no row here: they are in the normal campaign
// report (shared/operations.js getCampaignReport), which counts every message exactly as before.
async function reportPromotionSends({ workspaceId, promotionId } = {}, deps = realDeps()) {
  if (!workspaceId) throw httpError(403, 'FORBIDDEN', 'A workspace is required');
  const ws = String(workspaceId);
  const promoId = assertObjectId(promotionId, 'promotionId');
  const promotion = await deps.Promotion.findOne({ _id: promoId, workspaceId: ws }).select('name').lean();
  if (!promotion) throw httpError(404, 'PROMOTION_NOT_FOUND', 'Promotion not found');

  const rows = await deps.LocalizedLegacySend.find({ workspaceId: ws, sender: 'promotion', refId: promoId })
    .select('runId customerId usedLanguage fallbackReason status wamid errorCode createdAt').limit(MAX_REPORT_ROWS + 1).lean();
  const truncated = rows.length > MAX_REPORT_ROWS;
  if (truncated) rows.length = MAX_REPORT_ROWS;

  const wamids = rows.filter((r) => r.wamid && r.status === 'sent').map((r) => r.wamid);
  const tracked = new Map();
  for (const slice of audience.chunk(wamids, 1000)) {
    const messages = await deps.CampaignMessage.find({ workspaceId: ws, promotion: promoId, wamid: { $in: slice } })
      .select('wamid status deliveredAt readAt clickedAt order errorCode statusReason').lean();
    for (const m of messages) tracked.set(m.wamid, m);
  }

  const byLanguage = { ar: emptyFunnel(), en: emptyFunnel() };
  const fallbacks = new Map();
  const skipped = new Map();
  const deliveryErrors = new Map(); // C3: Meta error code of a delivery that came back failed -> count ('' = no code)
  const runs = new Set();
  const customers = new Set();
  let lastRunAt = null;
  for (const row of rows) {
    runs.add(row.runId);
    customers.add(String(row.customerId));
    if (row.createdAt && (!lastRunAt || new Date(row.createdAt) > lastRunAt)) lastRunAt = new Date(row.createdAt);
    const funnel = byLanguage[row.usedLanguage === 'ar' ? 'ar' : 'en'];
    if (row.status === 'skipped') { funnel.skipped += 1; bump(skipped, row.errorCode || 'skipped'); continue; }
    if (row.status === 'failed') funnel.failed += 1;
    if (row.status === 'sent') {
      funnel.sent += 1;
      const m = tracked.get(row.wamid);
      if (m) {
        if (m.deliveredAt || m.status === 'delivered' || m.status === 'read') funnel.delivered += 1;
        if (m.readAt || m.status === 'read') funnel.read += 1;
        if (m.clickedAt) funnel.clicked += 1;
        if (m.order) funnel.ordered += 1;
        if (m.status === 'failed') { funnel.deliveryFailed += 1; bump(deliveryErrors, m.errorCode ? String(m.errorCode) : ''); } // C3: the status callback said failed
      }
    }
    if (row.usedLanguage === 'en' && row.fallbackReason) bump(fallbacks, row.fallbackReason);
  }
  return {
    promotionId: promoId,
    promotionName: promotion.name,
    runs: runs.size,
    arabicCustomers: customers.size,
    byLanguage,
    fallbacks: entries(fallbacks),
    skipped: entries(skipped),
    deliveryErrors: entries(deliveryErrors).map(({ reason, count }) => ({ code: reason || null, count, ...describeMetaError(reason) })), // C3
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    truncated,
  };
}

module.exports = {
  MAX_CUSTOMERS, LARGE_AUDIENCE, SENDER_KINDS, realDeps, consentEligibleFilter, planPromotionSend, planSender, reportPromotionSends, classify,
};
