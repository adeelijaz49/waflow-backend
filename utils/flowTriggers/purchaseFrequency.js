const Order = require('../../models/Order');
const Customer = require('../../models/Customer');
const FlowEnrollment = require('../../models/FlowEnrollment');

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_ORDER_THRESHOLD = 2;

function windowDays(flow) {
  return flow.inactivityDays || DEFAULT_WINDOW_DAYS; // reuses inactivityDays as "the rolling window", like points_balance_reminder reuses it as a different kind of day-count
}

// DEFECT-03 §8.1: "Purchase frequency — customer shops more than [2] times
// within [X days]." A frequency/count trigger over a rolling window — like
// points_threshold, this fires once per qualifying customer ever (not
// re-fired every tick the window condition keeps holding), since re-notifying
// every 5-minute scheduler tick for as long as someone stays "frequent" would
// spam them.
async function findEligible(flow) {
  const threshold = flow.orderCountThreshold || DEFAULT_ORDER_THRESHOLD;
  const since = new Date(Date.now() - windowDays(flow) * 24 * 60 * 60 * 1000);

  const counts = await Order.aggregate([
    { $match: { status: { $ne: 'cancelled' }, createdAt: { $gte: since } } },
    { $group: { _id: '$customer', orderCount: { $sum: 1 } } },
    { $match: { orderCount: { $gte: threshold } } },
  ]);
  if (!counts.length) return [];

  const customerIds = counts.map(c => c._id);
  const everEnrolled = await FlowEnrollment.find({
    flow: flow._id, customer: { $in: customerIds },
  }).distinct('customer');
  const enrolledSet = new Set(everEnrolled.map(id => id.toString()));
  const remaining = customerIds.filter(id => !enrolledSet.has(id.toString()));
  if (!remaining.length) return [];

  const eligible = await Customer.find({
    _id: { $in: remaining }, optedOut: { $ne: true }, isDemo: { $ne: true },
  }, '_id');
  return eligible.map(c => ({ customerId: c._id }));
}

async function revalidate(flow, enrollment) {
  const customer = await Customer.findById(enrollment.customer);
  if (!customer) return { outcome: 'exit', reason: 'customer_deleted' };
  if (customer.optedOut) return { outcome: 'exit', reason: 'opted_out' };
  if (customer.isDemo) return { outcome: 'exit', reason: 'demo_customer' };
  return { outcome: 'proceed' };
}

// No fixed default template exists for this trigger type — see pointsThreshold.js.
async function buildSend() {
  throw new Error('This flow has no message configured — reference a Promotion or set a custom entry message.');
}

module.exports = { findEligible, revalidate, buildSend };
