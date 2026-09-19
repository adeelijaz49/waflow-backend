const mongoose = require('mongoose');

// One per workspace — links it to a Plan and anchors its billing cycle. See
// shared/entitlements.js#getOrCreateSubscription (lazy-provisions this with
// the default 'starter' Plan the first time a workspace's entitlements are
// resolved, so no manual setup step is required) and #resolveCurrentBillingPeriod.
const overridesSchema = new mongoose.Schema({
  // Sparse on purpose — only a field a merchant's custom deal actually needs
  // to differ from their Plan's default gets set here. Undefined means "use
  // the Plan's value", never "zero". See shared/entitlements.js#resolveEntitlements.
  locations:               { type: Number },
  whatsappAccounts:        { type: Number },
  users:                   { type: Number },
  customerProfiles:        { type: Number },
  aiPromptsPerCycle:       { type: Number },
  whatsappCreditPerCycle:  { type: Number },
}, { _id: false });

const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, unique: true, index: true },
  planId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
  status:      { type: String, enum: ['trialing', 'active', 'past_due', 'canceled'], default: 'active' },
  billingProvider: { type: String, enum: ['manual', 'stripe'], default: 'manual' },
  stripeCustomerId:     { type: String },
  stripeSubscriptionId: { type: String },
  // Manual-billing cycle anchor — shared/entitlements.js computes monthly
  // periods from this date. Ignored once billingProvider is 'stripe' and
  // currentPeriodStart/End are populated (from that provider's own webhook,
  // not built in this pass — see shared/entitlements.js's comment on it).
  cycleAnchorDate:   { type: Date, required: true, default: Date.now },
  currentPeriodStart: { type: Date },
  currentPeriodEnd:   { type: Date },
  // When true, an over-limit consumable (AI prompts, WhatsApp credit) is
  // allowed to proceed past 100% instead of being blocked — see
  // shared/entitlements.js#checkEntitlement and middleware/requireEntitlement.js.
  overageBillingEnabled: { type: Boolean, default: false },
  overrides: { type: overridesSchema, default: () => ({}) },
}, { timestamps: true });

module.exports = mongoose.model('Subscription', schema);
