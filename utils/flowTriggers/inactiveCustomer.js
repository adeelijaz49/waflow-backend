const Order = require('../../models/Order');
const Customer = require('../../models/Customer');
const FlowEnrollment = require('../../models/FlowEnrollment');
const { sendWinbackTemplate } = require('../whatsapp');

const DEFAULT_INACTIVITY_DAYS = 60;

function cutoffFor(flow) {
  const days = flow.inactivityDays || DEFAULT_INACTIVITY_DAYS;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// Customers whose most recent non-cancelled order is older than the flow's
// cutoff. Customers with zero orders ever are excluded — there's no prior
// relationship to win back. This is a fresh aggregation rather than a reuse
// of getRecommendedCustomers (pool-relative RFM scoring, wrong shape for a
// merchant-configured fixed-day threshold).
async function findEligible(flow) {
  const cutoff = cutoffFor(flow);

  const stale = await Order.aggregate([
    { $match: { status: { $ne: 'cancelled' } } },
    { $group: { _id: '$customer', lastOrderAt: { $max: '$createdAt' } } },
    { $match: { lastOrderAt: { $lt: cutoff } } },
  ]);
  if (!stale.length) return [];

  const customerIds = stale.map(s => s._id);

  // Pre-filter against already-live enrollments — an optimization, not the
  // correctness guarantee (that's FlowEnrollment's partial unique index +
  // the scheduler catching E11000 on a losing concurrent insert).
  const alreadyEnrolled = await FlowEnrollment.find({
    flow: flow._id, customer: { $in: customerIds }, state: { $in: ['enrolled', 'messaged'] },
  }).distinct('customer');
  const enrolledSet = new Set(alreadyEnrolled.map(id => id.toString()));
  const remaining = customerIds.filter(id => !enrolledSet.has(id.toString()));
  if (!remaining.length) return [];

  const eligible = await Customer.find({ _id: { $in: remaining }, optedOut: { $ne: true } }, '_id');
  return eligible.map(c => ({ customerId: c._id }));
}

async function revalidate(flow, enrollment) {
  const customer = await Customer.findById(enrollment.customer);
  if (!customer) return { outcome: 'exit', reason: 'customer_deleted' };
  if (customer.optedOut) return { outcome: 'exit', reason: 'opted_out' };

  const cutoff = cutoffFor(flow);
  const mostRecent = await Order.findOne({ customer: customer._id, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 });
  // Matches findEligible's own policy (which requires order history to enroll
  // at all) — if their only qualifying orders got cancelled/removed since
  // enrollment, there's no longer a stale relationship to win back.
  if (!mostRecent) return { outcome: 'exit', reason: 'no_order_history' };
  if (mostRecent.createdAt >= cutoff) return { outcome: 'exit', reason: 'reordered' };

  return { outcome: 'proceed' };
}

async function buildSend(flow, enrollment, customer) {
  return sendWinbackTemplate(customer.phone, customer.firstname, flow._id.toString(), enrollment._id.toString());
}

module.exports = { findEligible, revalidate, buildSend };
