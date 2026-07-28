const mongoose = require('mongoose');

// A merchant-configured lifecycle-messaging automation. One document per
// trigger the merchant has set up — see utils/flowScheduler.js for how these
// get evaluated and utils/flowTriggers/ for the per-triggerType logic.
const schema = new mongoose.Schema({
  name:        { type: String, required: true },
  triggerType: {
    type: String,
    enum: [
      'inactive_customer', 'post_purchase_points', 'points_balance_reminder', 'booking_no_show',
      // DEFECT-03 §8.1: new rule metrics beyond the original 4.
      'points_threshold', 'purchase_frequency',
    ],
    required: true,
  },
  status: { type: String, enum: ['active', 'paused'], default: 'paused' }, // safe by default, like Promotion.status
  // Used by inactive_customer (days since last order), points_balance_reminder
  // (days since points balance last changed), and purchase_frequency (the
  // rolling window to count orders within). Defaulted per triggerType in
  // shared/operations.js#createFlow, not here — the sensible default differs by type.
  inactivityDays: Number,
  // Used by post_purchase_points (hours after Order.paidAt) and booking_no_show
  // (hours after the booking's no-show transition). Same per-type default pattern.
  delayHours: Number,
  // DEFECT-03 §8.1 new metrics' own thresholds — kept as separate named fields
  // rather than a generic {metric,operator,value} blob so each trigger file's
  // query logic stays as explicit/typed as the original 4 (see utils/flowTriggers/*).
  pointsThreshold:     Number, // points_threshold: fire once a customer's balance reaches/exceeds this
  orderCountThreshold: Number, // purchase_frequency: order count within inactivityDays (the "window") to fire
  templateName: String, // auto-set at creation from a fixed triggerType -> template constant map; unset when promotionId is used
  cooldownDaysOverride: Number, // optional per-flow override of Settings.flowCooldownDays
  lastRunAt: Date, // bookkeeping only — last scheduler tick that swept this flow
  // DEFECT-03: "A Flow = a trigger condition + a reference to an existing
  // Promotion." All message content/branching lives in the Promotion
  // (DEFECT-02) — the Flow contributes only the condition side. Requires the
  // referenced Promotion to have an approved custom entry message before this
  // flow can be activated (mirrors the entryNodeId guard below exactly).
  promotionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Promotion' },
  // §8.3: cascade/escalation sequences (e.g. win-back at 30/60/90 days) are
  // modeled as independent rules with a mutually-exclusive condition, not a
  // native sequence concept (confirmed with product) — this flow only
  // enrolls a customer who already has a non-completed (messaged/exited, not
  // completed) FlowEnrollment for the referenced prior-stage flow. Optional;
  // unset means no such dependency.
  requiresPriorFlowId: { type: mongoose.Schema.Types.ObjectId, ref: 'Flow' },
  // Legacy (pre-DEFECT-03) merchant-authored entry message (see
  // models/MessageNode.js) — additive: when unset, this flow sends its fixed
  // hardcoded triggerType template exactly as before. Superseded by
  // promotionId for new flows (message authoring now lives in Promotions),
  // kept working as-is for any flow already using it.
  entryNodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageNode' },
}, { timestamps: true });

module.exports = mongoose.model('Flow', schema);
