// Bulk-campaign WhatsApp credit: estimate cost before sending, reserve it so
// a second campaign can't over-commit the same credit, then reconcile the
// reservation against what was actually sent once the campaign completes.
//
// Currency note: an estimate/reservation is priced in whatever currency
// shared/whatsappRateCard.js#getRate resolves for the given country+category,
// and compared directly against the workspace's credit balance (denominated
// in utils/settingsCache.js#getCurrency()) — no FX conversion is performed.
// This matches the rest of the app's existing single-currency-per-workspace
// assumption; an admin setting up the rate card for a workspace should use
// that workspace's own currency (see routes/adminEntitlements.js).
const CreditReservation = require('../models/CreditReservation');
const { getUsageSummary, getOrCreateSubscription, resolveCurrentBillingPeriod, toId } = require('./entitlements');
const { getRate } = require('./whatsappRateCard');
const { recordUsageEvent } = require('./usageLedger');

// Scoped to the *current* billing period only — mirrors how creditRow.used
// itself resets every cycle (see shared/entitlements.js#getUsageSummary).
// A reservation that's abandoned (its campaign never reconciles or
// releases it — a crashed job, a forgotten manual step) stops counting
// against balance once its cycle ends, rather than silently shrinking every
// future cycle's credit forever. It stays visible (and releasable) in the
// admin billing tool either way.
async function sumActiveReservations(workspaceId, billingPeriodId) {
  const agg = await CreditReservation.aggregate([
    { $match: { workspaceId: toId(workspaceId), billingPeriodId: toId(billingPeriodId), status: 'reserved' } },
    { $group: { _id: null, total: { $sum: '$estimatedCost' } } },
  ]);
  return agg[0]?.total || 0;
}

// What the merchant sees before confirming a bulk send — recipients,
// category, unit/total cost, current credit balance (net of any other
// in-flight reservation), and whether this send needs a top-up.
async function estimateCampaignCost({ workspaceId, recipientCount, countryCode, category = 'marketing' }) {
  if (!recipientCount || recipientCount < 1) throw new Error('recipientCount must be at least 1');

  const rate = await getRate({ countryCode, category });
  const unitCost = rate.customerCharge;
  const estimatedCost = +(unitCost * recipientCount).toFixed(4);

  const subscription = await getOrCreateSubscription(workspaceId);
  const period = await resolveCurrentBillingPeriod(workspaceId, { subscription });
  const [summary, reservedTotal] = await Promise.all([
    getUsageSummary(workspaceId),
    sumActiveReservations(workspaceId, period._id),
  ]);
  const creditRow = summary.usage.find(u => u.type === 'whatsappCreditPerCycle');
  const currentBalance = +(Math.max(0, creditRow.limit - creditRow.used - reservedTotal)).toFixed(4);
  const balanceAfterSend = +(currentBalance - estimatedCost).toFixed(4);
  const overage = summary.subscription.overageBillingEnabled;

  return {
    recipientCount, category, countryCode: countryCode || null,
    unitCost, estimatedCost, currency: rate.currency,
    currentBalance, balanceAfterSend,
    requiresTopUp: balanceAfterSend < 0 && !overage,
    shortfall: balanceAfterSend < 0 ? +Math.abs(balanceAfterSend).toFixed(4) : 0,
  };
}

class InsufficientCreditError extends Error {
  constructor(estimate) {
    super(`Insufficient WhatsApp credit: this send needs ${estimate.estimatedCost} ${estimate.currency} but only ${estimate.currentBalance} ${estimate.currency} is available.`);
    this.code = 'INSUFFICIENT_CREDIT';
    this.details = estimate;
  }
}

// Holds the estimated cost against the workspace's credit before a bulk
// send starts. Throws InsufficientCreditError (never silently sends partial)
// when the estimate can't be covered and overage billing isn't enabled —
// the caller must block the send or send the merchant to buy more credit.
async function reserveCredit({ workspaceId, recipientCount, countryCode, category = 'marketing', campaignId }) {
  const estimate = await estimateCampaignCost({ workspaceId, recipientCount, countryCode, category });
  if (estimate.requiresTopUp) throw new InsufficientCreditError(estimate);

  const subscription = await getOrCreateSubscription(workspaceId);
  const period = await resolveCurrentBillingPeriod(workspaceId, { subscription });

  return CreditReservation.create({
    workspaceId, billingPeriodId: period._id, campaignId,
    recipientCount, countryCode, messageCategory: category,
    unitCost: estimate.unitCost, estimatedCost: estimate.estimatedCost, currency: estimate.currency,
    status: 'reserved',
  });
}

// Turns a reservation into real ledger entries — one UsageEvent per actually
// billable message (failed sends are never billed), using the rate card at
// reconciliation time so a mid-campaign rate change reflects reality. Marks
// the reservation 'reconciled' with the true total; any gap between
// estimatedCost and actualCost is just the natural estimate-vs-actual drift,
// not separately refunded/charged — the ledger (not the reservation) is the
// source of truth for what was actually spent.
//
// Every resulting UsageEvent is stamped with the RESERVATION's own
// billingPeriodId (the cycle the send actually happened in), not whatever
// cycle is current when reconciliation runs — those can differ if
// reconciliation is delayed past a cycle rollover, and billing a delayed
// send against the wrong (current) cycle would misattribute real spend.
//
// The status is atomically claimed ('reserved' -> 'reconciling') via
// findOneAndUpdate before any billing happens, so a duplicate/concurrent
// call for the same reservationId (e.g. a retried completion webhook) sees
// it's no longer 'reserved' and bails instead of double-billing every
// message a second time.
async function reconcileReservation({ reservationId, actualMessages = [] }) {
  const reservation = await CreditReservation.findOneAndUpdate(
    { _id: reservationId, status: 'reserved' },
    { $set: { status: 'reconciling' } },
  );
  if (!reservation) {
    const existing = await CreditReservation.findById(reservationId);
    if (!existing) throw new Error('Reservation not found');
    throw new Error(`Reservation is already ${existing.status}`);
  }

  let actualCost = 0;
  for (const msg of actualMessages) {
    if (msg.status === 'failed') continue;
    const rate = await getRate({ countryCode: msg.countryCode || reservation.countryCode, category: msg.category || reservation.messageCategory });
    actualCost += rate.customerCharge;
    await recordUsageEvent({
      workspaceId: reservation.workspaceId, usageType: 'whatsapp_message', quantity: 1,
      providerCost: rate.providerCost, customerCharge: rate.customerCharge, currency: rate.currency,
      relatedCampaignId: reservation.campaignId, relatedMessageId: msg.messageId, relatedCustomerId: msg.customerId,
      billingPeriodId: reservation.billingPeriodId,
      metadata: { wamid: msg.wamid, reservationId: String(reservation._id) },
    });
  }

  return CreditReservation.findByIdAndUpdate(
    reservation._id,
    { status: 'reconciled', actualCost: +actualCost.toFixed(4), reconciledAt: new Date() },
    { new: true },
  );
}

// Frees a reservation's held credit without billing anything — e.g. the
// merchant cancelled the campaign before it actually sent. Atomic for the
// same reason as reconcileReservation, even though releasing twice is
// harmless on its own — it's the one consistent pattern for every status
// transition on this model.
async function releaseReservation({ reservationId }) {
  const released = await CreditReservation.findOneAndUpdate(
    { _id: reservationId, status: 'reserved' },
    { $set: { status: 'released' } },
    { new: true },
  );
  if (released) return released;

  const existing = await CreditReservation.findById(reservationId);
  if (!existing) throw new Error('Reservation not found');
  return existing; // already reconciled/released/etc. — no-op, not an error
}

module.exports = { estimateCampaignCost, reserveCredit, reconcileReservation, releaseReservation, InsufficientCreditError };
