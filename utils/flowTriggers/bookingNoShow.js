const Booking = require('../../models/Booking');
const Customer = require('../../models/Customer');
const FlowEnrollment = require('../../models/FlowEnrollment');
const { sendNoShowTemplate } = require('../whatsapp');

const DEFAULT_DELAY_HOURS = 1;

function delayMs(flow) {
  return (flow.delayHours ?? DEFAULT_DELAY_HOURS) * 60 * 60 * 1000;
}

// One enrollment attempt per booking, ever — dedup checks sourceRef across all
// enrollment states, so a booking that already resolved (sent, or exited
// because its status moved off no-show) is never reconsidered.
async function findEligible(flow) {
  const cutoff = new Date(Date.now() - delayMs(flow));
  const candidates = await Booking.find(
    { status: 'no-show', customerId: { $ne: null }, updatedAt: { $lte: cutoff } },
    '_id customerId',
  );
  if (!candidates.length) return [];

  const bookingIds = candidates.map(b => b._id);
  const alreadyAttempted = await FlowEnrollment.find({ flow: flow._id, sourceRef: { $in: bookingIds } }).distinct('sourceRef');
  const attemptedSet = new Set(alreadyAttempted.map(id => id.toString()));

  return candidates
    .filter(b => !attemptedSet.has(b._id.toString()))
    .map(b => ({ customerId: b.customerId, sourceModel: 'Booking', sourceRef: b._id }));
}

async function revalidate(flow, enrollment) {
  const customer = await Customer.findById(enrollment.customer);
  if (!customer) return { outcome: 'exit', reason: 'customer_deleted' };
  if (customer.optedOut) return { outcome: 'exit', reason: 'opted_out' };

  const booking = await Booking.findById(enrollment.sourceRef);
  if (!booking) return { outcome: 'exit', reason: 'booking_deleted' };
  // Nothing today updates a no-show booking for an unrelated reason, but if it
  // ever did, this would (harmlessly) push the delay clock out further.
  if (booking.status !== 'no-show') return { outcome: 'exit', reason: 'status_changed' };

  return { outcome: 'proceed' };
}

async function buildSend(flow, enrollment, customer) {
  const booking = await Booking.findById(enrollment.sourceRef).populate('serviceId');
  if (!booking) throw new Error('Booking not found for no-show send');
  return sendNoShowTemplate(
    customer.phone, customer.firstname, booking.serviceId?.name,
    booking.serviceId?._id?.toString(), booking._id.toString(),
  );
}

module.exports = { findEligible, revalidate, buildSend };
