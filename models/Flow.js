const mongoose = require('mongoose');

// A merchant-configured lifecycle-messaging automation. One document per
// trigger the merchant has set up — see utils/flowScheduler.js for how these
// get evaluated and utils/flowTriggers/ for the per-triggerType logic.
const schema = new mongoose.Schema({
  name:        { type: String, required: true },
  triggerType: {
    type: String,
    enum: ['inactive_customer', 'post_purchase_points', 'points_balance_reminder', 'booking_no_show'],
    required: true,
  },
  status: { type: String, enum: ['active', 'paused'], default: 'paused' }, // safe by default, like Promotion.status
  // Used by inactive_customer (days since last order) and points_balance_reminder
  // (days since points balance last changed). Defaulted per triggerType in
  // shared/operations.js#createFlow, not here — the sensible default differs by type.
  inactivityDays: Number,
  // Used by post_purchase_points (hours after Order.paidAt) and booking_no_show
  // (hours after the booking's no-show transition). Same per-type default pattern.
  delayHours: Number,
  templateName: String, // auto-set at creation from a fixed triggerType -> template constant map
  cooldownDaysOverride: Number, // optional per-flow override of Settings.flowCooldownDays
  lastRunAt: Date, // bookkeeping only — last scheduler tick that swept this flow
}, { timestamps: true });

module.exports = mongoose.model('Flow', schema);
