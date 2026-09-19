// Records and lists UsageEvent rows — the append-only ledger every billable/
// limited action writes to. By default every write resolves the caller's
// *current* BillingPeriod itself, so a normal metered action (an AI prompt,
// a manual WhatsApp send) always lands in whichever cycle is live right now.
// Pass billingPeriodId explicitly only when the usage genuinely belongs to a
// specific past cycle — e.g. shared/creditReservation.js#reconcileReservation
// billing a campaign against the period its reservation was actually made
// in, which can differ from "now" if reconciliation runs after a cycle
// rolls over.
const UsageEvent = require('../models/UsageEvent');
const { resolveCurrentBillingPeriod, toId } = require('./entitlements');

async function recordUsageEvent({
  workspaceId, usageType, quantity = 1, providerCost = 0, customerCharge = 0, currency,
  relatedCampaignId, relatedMessageId, relatedCustomerId, relatedUserId, metadata,
  billingPeriodId,
}) {
  if (!workspaceId) throw new Error('workspaceId is required');
  if (!usageType) throw new Error('usageType is required');

  const resolvedBillingPeriodId = billingPeriodId || (await resolveCurrentBillingPeriod(workspaceId))._id;
  return UsageEvent.create({
    workspaceId, billingPeriodId: resolvedBillingPeriodId, usageType, quantity, providerCost, customerCharge,
    currency, relatedCampaignId, relatedMessageId, relatedCustomerId, relatedUserId, metadata,
  });
}

async function listUsageEvents({ workspaceId, usageType, billingPeriodId, page = 1, limit = 50 }) {
  const filter = { workspaceId };
  if (usageType) filter.usageType = usageType;
  if (billingPeriodId) filter.billingPeriodId = billingPeriodId;

  const skip = (page - 1) * limit;
  const [events, total] = await Promise.all([
    UsageEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    UsageEvent.countDocuments(filter),
  ]);
  return { events, total, page, pages: Math.ceil(total / limit) || 1 };
}

module.exports = { recordUsageEvent, listUsageEvents };
