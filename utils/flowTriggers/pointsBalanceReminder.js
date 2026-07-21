const Customer = require('../../models/Customer');
const FlowEnrollment = require('../../models/FlowEnrollment');
const { sendPointsNudgeTemplate } = require('../whatsapp');

const DEFAULT_INACTIVITY_DAYS = 30;

function cutoffFor(flow) {
  const days = flow.inactivityDays || DEFAULT_INACTIVITY_DAYS;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// Soft nudge, not real expiry (resolved with the user during planning — no
// per-earn ledger exists). Eligible: balance > 0 and hasn't changed (earned
// or redeemed) in N days. loyaltyPointsUpdatedAt is unset for customers who
// haven't had a points-affecting event since this field was introduced —
// treated as ineligible here (not "infinitely stale") since a one-time
// backfill script sets it for existing balances; see seed/backfill-loyalty-updated-at.js.
async function findEligible(flow) {
  const cutoff = cutoffFor(flow);

  const stale = await Customer.find({
    loyaltyPoints: { $gt: 0 },
    loyaltyPointsUpdatedAt: { $lte: cutoff },
    optedOut: { $ne: true },
  }, '_id');
  if (!stale.length) return [];

  const customerIds = stale.map(c => c._id);
  const alreadyEnrolled = await FlowEnrollment.find({
    flow: flow._id, customer: { $in: customerIds }, state: { $in: ['enrolled', 'messaged'] },
  }).distinct('customer');
  const enrolledSet = new Set(alreadyEnrolled.map(id => id.toString()));

  return stale
    .filter(c => !enrolledSet.has(c._id.toString()))
    .map(c => ({ customerId: c._id }));
}

async function revalidate(flow, enrollment) {
  const customer = await Customer.findById(enrollment.customer);
  if (!customer) return { outcome: 'exit', reason: 'customer_deleted' };
  if (customer.optedOut) return { outcome: 'exit', reason: 'opted_out' };
  if (customer.loyaltyPoints <= 0) return { outcome: 'exit', reason: 'points_redeemed' };

  const cutoff = cutoffFor(flow);
  if (!customer.loyaltyPointsUpdatedAt || customer.loyaltyPointsUpdatedAt > cutoff) {
    // Balance changed (earned more or redeemed) after enrollment but before
    // send — the nudge is stale either way, so don't send it now. They'll be
    // re-evaluated fresh on a later tick if they go quiet again.
    return { outcome: 'exit', reason: 'points_changed' };
  }

  return { outcome: 'proceed' };
}

async function buildSend(flow, enrollment, customer) {
  return sendPointsNudgeTemplate(customer.phone, customer.firstname, customer.loyaltyPoints, flow._id.toString(), enrollment._id.toString());
}

module.exports = { findEligible, revalidate, buildSend };
