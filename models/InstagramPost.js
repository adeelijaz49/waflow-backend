const mongoose = require('mongoose');

// A single Instagram promotion/post — deliberately standalone (not a
// sub-document of models/Promotion.js), same reasoning as
// models/ReferralPromotion.js: this whole feature stays additive and
// isolated. Promotion-setup fields (name, goal, offer, dates) live directly
// on the post rather than a separate wrapper entity, since for MVP one
// promotion = one Instagram post (no multi-post campaign grouping yet).
const schema = new mongoose.Schema({
  workspaceId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  socialAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialAccount', required: true },

  name: { type: String, required: true },
  goal: {
    type: String,
    enum: ['new_customers', 'promote_product', 'promote_service', 'fill_quiet_slots', 'launch_branch', 'promote_loyalty', 'promote_referral', 'weekend_sales', 'seasonal'],
    default: 'new_customers',
  },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
  offerDescription: { type: String },
  startsAt: { type: Date },
  endsAt:   { type: Date },

  postType: { type: String, enum: ['image', 'video', 'reel'], default: 'image' },
  mediaUrl:     { type: String },
  thumbnailUrl: { type: String },
  caption:  { type: String },
  hashtags: [String],

  whatsappCtaText: { type: String },
  destinationAction: {
    type: String,
    enum: ['start_conversation', 'claim_offer', 'book_service', 'order_product', 'join_loyalty', 'use_referral', 'landing_page'],
    default: 'start_conversation',
  },
  trackingLinkId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackingLink' },
  // The code embedded in the WhatsApp deep-link message for inbound
  // detection — see shared/instagram.js#handleInboundTrackingCode. Same
  // mechanism as the Referral Promotions feature's "Code: XXXXXXXXXX".
  promotionCode: { type: String },

  scheduledAt:  { type: Date },
  publishedAt:  { type: Date },
  status: { type: String, enum: ['draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled'], default: 'draft', index: true },
  providerPostId:      { type: String },
  providerContainerId: { type: String },
  errorCode:    { type: String },
  errorMessage: { type: String },

  createdByUserId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

schema.index({ workspaceId: 1, status: 1, scheduledAt: 1 });

module.exports = mongoose.model('InstagramPost', schema);
