const mongoose = require('mongoose');

// One document per customer's pass through a Flow. sourceModel/sourceRef is
// the event that caused enrollment (an Order or Booking) — only set for the
// two event-sourced triggers (post_purchase_points, booking_no_show). order/
// booking is the *resulting* conversion after the flow's message lands a
// sale or a rebook — distinct from sourceRef, the *cause*.
const schema = new mongoose.Schema({
  flow:     { type: mongoose.Schema.Types.ObjectId, ref: 'Flow', required: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  state:    { type: String, enum: ['enrolled', 'messaged', 'exited', 'completed'], default: 'enrolled' },
  enrolledAt: { type: Date, default: Date.now },
  messagedAt: Date,
  exitedAt:   Date,
  exitReason: String, // e.g. 'reordered', 'points_changed', 'points_redeemed', 'order_refunded', 'opted_out'
  sourceModel: { type: String, enum: ['Order', 'Booking'] },
  sourceRef:   { type: mongoose.Schema.Types.ObjectId, refPath: 'sourceModel' },
  order:   { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
}, { timestamps: true });

// Prevents double-enrollment even under concurrent scheduler ticks — a second
// concurrent insert for the same (flow, customer) while one is already live
// hits E11000, which the scheduler catches and treats as "already enrolled."
// Scoped to live states only, so a customer can be re-enrolled later once
// their prior pass through this flow has resolved.
schema.index(
  { flow: 1, customer: 1 },
  { unique: true, partialFilterExpression: { state: { $in: ['enrolled', 'messaged'] } } },
);

schema.index({ flow: 1, state: 1 }); // send-sweep's per-flow pending-enrollment query
schema.index({ sourceRef: 1 }, { sparse: true }); // per-order/per-booking dedup for event-sourced triggers

module.exports = mongoose.model('FlowEnrollment', schema);
