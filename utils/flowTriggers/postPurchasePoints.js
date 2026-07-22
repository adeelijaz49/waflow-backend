const Order = require('../../models/Order');
const Customer = require('../../models/Customer');
const FlowEnrollment = require('../../models/FlowEnrollment');
const { sendPostPurchaseTemplate, sendCustomFlowTemplate } = require('../whatsapp');

const DEFAULT_DELAY_HOURS = 2;
const LOOKBACK_SLACK_MS = 24 * 60 * 60 * 1000; // covers a scheduler outage without ever full-scanning Orders

function delayMs(flow) {
  return (flow.delayHours ?? DEFAULT_DELAY_HOURS) * 60 * 60 * 1000;
}

// One enrollment attempt per order, ever — dedup checks sourceRef across all
// enrollment states (not just live ones), so an order that already resolved
// (sent, or exited because it got refunded) is never reconsidered.
async function findEligible(flow) {
  const lookbackSince = new Date(Date.now() - delayMs(flow) - LOOKBACK_SLACK_MS);
  const candidates = await Order.find({ paymentStatus: 'paid', paidAt: { $gte: lookbackSince } }, '_id customer');
  if (!candidates.length) return [];

  const orderIds = candidates.map(o => o._id);
  const alreadyAttempted = await FlowEnrollment.find({ flow: flow._id, sourceRef: { $in: orderIds } }).distinct('sourceRef');
  const attemptedSet = new Set(alreadyAttempted.map(id => id.toString()));

  return candidates
    .filter(o => !attemptedSet.has(o._id.toString()))
    .map(o => ({ customerId: o.customer, sourceModel: 'Order', sourceRef: o._id }));
}

async function revalidate(flow, enrollment) {
  const customer = await Customer.findById(enrollment.customer);
  if (!customer) return { outcome: 'exit', reason: 'customer_deleted' };
  if (customer.optedOut) return { outcome: 'exit', reason: 'opted_out' };

  const order = await Order.findById(enrollment.sourceRef);
  if (!order) return { outcome: 'exit', reason: 'order_deleted' };
  if (order.paymentStatus === 'refunded' || order.paymentStatus === 'failed') {
    return { outcome: 'exit', reason: 'order_refunded' };
  }
  if (!order.paidAt) return { outcome: 'exit', reason: 'order_not_paid' };

  const dueAt = order.paidAt.getTime() + delayMs(flow);
  if (Date.now() < dueAt) return { outcome: 'skip' };

  return { outcome: 'proceed' };
}

// entryNode is the flow's merchant-authored custom entry message (see
// models/MessageNode.js), already resolved and confirmed 'approved' by the
// caller (utils/flowScheduler.js#processEnrollment) — undefined/null means
// this flow has no custom entry configured, so send the fixed default exactly
// as before.
async function buildSend(flow, enrollment, customer, entryNode) {
  if (entryNode) {
    const buttonPayloads = entryNode.buttons.map(b => `msgnode_${entryNode._id}_${b.position}`);
    return sendCustomFlowTemplate(customer.phone, entryNode.templateName, [customer.firstname || 'Valued Customer', customer.loyaltyPoints], buttonPayloads);
  }
  return sendPostPurchaseTemplate(customer.phone, customer.firstname, customer.loyaltyPoints, flow._id.toString(), enrollment._id.toString());
}

module.exports = { findEligible, revalidate, buildSend };
