const mongoose = require('mongoose');

// A purchased/granted top-up on one entitlement dimension. An 'active' add-on
// (not expired) contributes its quantity on top of the Plan/override limit
// for its `type` — see shared/entitlements.js#resolveEntitlements. A
// consumable type (aiPromptsPerCycle/whatsappCreditPerCycle) re-applies every
// billing period for as long as the add-on stays active; a durable type
// (locations/whatsappAccounts/users/customerProfiles) just raises the
// standing count limit. expiresAt is optional — durable/recurring add-ons
// typically leave it unset; a one-time top-up sets it.
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  type: {
    type: String,
    enum: ['locations', 'whatsappAccounts', 'users', 'customerProfiles', 'aiPromptsPerCycle', 'whatsappCreditPerCycle'],
    required: true,
  },
  quantity: { type: Number, required: true },
  status:   { type: String, enum: ['pending_payment', 'active', 'expired', 'cancelled', 'failed'], default: 'pending_payment' },
  activatedAt: { type: Date },
  expiresAt:   { type: Date },
  source:        { type: String, enum: ['manual', 'stripe'], default: 'manual' },
  stripePriceId: { type: String },
  notes:         { type: String },
}, { timestamps: true });

schema.index({ workspaceId: 1, status: 1, type: 1 });

module.exports = mongoose.model('AddOn', schema);
