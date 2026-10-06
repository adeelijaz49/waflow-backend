const mongoose = require('mongoose');

// A merchant-authored "refer a friend" campaign — deliberately standalone
// (not a sub-document of models/Promotion.js) so this whole feature stays
// additive and isolated; it doesn't require or modify any existing
// Promotion record. See shared/referrals.js for the engine built on top.
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  name:        { type: String, required: true },
  description: { type: String },
  startsAt:    { type: Date },
  endsAt:      { type: Date },
  status:      { type: String, enum: ['draft', 'active', 'paused', 'ended'], default: 'draft' },

  // Friend (new customer) reward — what the referred friend receives.
  friendRewardType:  { type: String, enum: ['none', 'fixed_discount', 'percent_discount', 'voucher', 'free_item', 'loyalty_points'], default: 'percent_discount' },
  friendRewardValue: { type: Number, default: 0 },
  friendRewardLabel: { type: String }, // free-text for free_item/voucher, e.g. "Free dessert"

  // Referrer reward — what the original customer receives once the
  // qualifying action is met.
  referrerRewardType:  { type: String, enum: ['none', 'loyalty_points', 'fixed_discount', 'percent_discount', 'voucher', 'free_item', 'manual'], default: 'loyalty_points' },
  referrerRewardValue: { type: Number, default: 0 },
  referrerRewardLabel: { type: String },

  // When the referrer actually earns their reward.
  qualifyingAction: {
    type: String,
    enum: ['link_clicked', 'whatsapp_started', 'customer_created', 'first_order', 'payment_completed', 'first_booking', 'loyalty_joined', 'minimum_spend'],
    default: 'first_order',
  },
  minimumSpend: { type: Number, default: 0 }, // only used when qualifyingAction === 'minimum_spend'

  maxRewardsPerReferrer: { type: Number, default: 0 }, // 0 = unlimited
  maxTotalRewards:       { type: Number, default: 0 }, // 0 = unlimited
  requiresManualApproval: { type: Boolean, default: false },
  termsText: { type: String },

  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

schema.index({ workspaceId: 1, status: 1 });

module.exports = mongoose.model('ReferralPromotion', schema);
