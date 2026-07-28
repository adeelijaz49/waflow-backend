const Customer = require('../../models/Customer');
const FlowEnrollment = require('../../models/FlowEnrollment');

// DEFECT-03 §8.1: "Points threshold — customer earns more than [1000] points."
// A value-crossing trigger, not a recurring reminder (unlike
// points_balance_reminder) — a customer is only ever enrolled once per flow,
// ever, regardless of past enrollment state, since "crossed 1000 points" is a
// one-time event, not a condition to keep re-notifying about.
async function findEligible(flow) {
  const threshold = flow.pointsThreshold || 0;

  const qualifying = await Customer.find({
    loyaltyPoints: { $gte: threshold },
    optedOut: { $ne: true },
    isDemo: { $ne: true },
  }, '_id');
  if (!qualifying.length) return [];

  const customerIds = qualifying.map(c => c._id);
  // Unlike the original 4 triggers (which only exclude *live* enrollments —
  // state 'enrolled'/'messaged' — since their condition can recur), this
  // excludes ANY prior enrollment ever, live or resolved, matching the
  // one-time "crossing" semantics above.
  const everEnrolled = await FlowEnrollment.find({
    flow: flow._id, customer: { $in: customerIds },
  }).distinct('customer');
  const enrolledSet = new Set(everEnrolled.map(id => id.toString()));

  return qualifying
    .filter(c => !enrolledSet.has(c._id.toString()))
    .map(c => ({ customerId: c._id }));
}

async function revalidate(flow, enrollment) {
  const customer = await Customer.findById(enrollment.customer);
  if (!customer) return { outcome: 'exit', reason: 'customer_deleted' };
  if (customer.optedOut) return { outcome: 'exit', reason: 'opted_out' };
  if (customer.isDemo) return { outcome: 'exit', reason: 'demo_customer' };
  // Points dropped below threshold (e.g. redeemed) between enrollment and
  // send — the crossing that triggered this is no longer true.
  if (customer.loyaltyPoints < (flow.pointsThreshold || 0)) return { outcome: 'exit', reason: 'points_dropped_below_threshold' };

  return { outcome: 'proceed' };
}

// No fixed default template exists for this trigger type (introduced
// post-DEFECT-03, "promotion-reference only") — flowScheduler.js's
// processEnrollment only calls this when neither flow.promotionId nor
// flow.entryNodeId resolved to an approved template, so surfacing a clear
// error is correct here rather than silently no-op'ing.
async function buildSend() {
  throw new Error('This flow has no message configured — reference a Promotion or set a custom entry message.');
}

module.exports = { findEligible, revalidate, buildSend };
