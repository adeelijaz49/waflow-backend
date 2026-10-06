const mongoose = require('mongoose');

// The core per-friend tracking record — one document per "someone followed a
// referral link and (maybe) became a customer." Created at first click for a
// customer-specific link (referrerCustomerId already known), or at the
// moment a friend's WhatsApp message carrying a referral code arrives for a
// generic link (see shared/referrals.js#handleInboundReferralCode). Its
// `status` is the single source of truth the reporting/reward logic reads.
const schema = new mongoose.Schema({
  workspaceId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  referralPromotionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralPromotion', required: true, index: true },
  referralCodeId:      { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralCode', required: true },
  referrerCustomerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true }, // null until attributed (generic link) or always set (customer-specific link)
  referredCustomerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true }, // set once the friend has a real Customer record
  referredPhoneHash:   { type: String }, // set at whatsapp_started, before a full Customer profile necessarily exists

  status: {
    type: String,
    enum: ['link_created', 'clicked', 'whatsapp_started', 'customer_created', 'qualified', 'reward_pending', 'reward_issued', 'rejected', 'expired', 'voided'],
    default: 'link_created',
    index: true,
  },
  attributionSource: { type: String, enum: ['click', 'whatsapp_code', 'landing_flow'] },

  firstClickAt:       { type: Date },
  whatsappStartedAt:  { type: Date },
  customerCreatedAt:  { type: Date },
  qualifiedAt:        { type: Date },
  rewardIssuedAt:     { type: Date },

  orderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  revenueAmount: { type: Number, default: 0 },

  rewardType:   { type: String },
  rewardValue:  { type: Number },
  rewardStatus: { type: String, enum: ['none', 'pending_approval', 'issued', 'rejected'], default: 'none' },
  rejectionReason: { type: String },
}, { timestamps: true });

schema.index({ workspaceId: 1, referralPromotionId: 1, status: 1 });
// One reward per referred customer per promotion — the core anti-abuse rule
// ("a referral should only be rewarded once per referred customer per
// promotion"). Partial so multiple not-yet-attributed (referredCustomerId
// unset) clicks for the same promotion don't collide with each other.
schema.index({ referralPromotionId: 1, referredCustomerId: 1 }, { unique: true, partialFilterExpression: { referredCustomerId: { $exists: true } } });

module.exports = mongoose.model('Referral', schema);
