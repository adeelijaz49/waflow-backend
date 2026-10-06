const mongoose = require('mongoose');

// Append-only click log — one row per hit on /r/:code or /c/:code, before we
// know whether it ever turns into a real conversation/customer. IP/user-agent
// are hashed, never stored raw (see shared/referrals.js#hashValue), matching
// the privacy rule in the requirements doc.
const schema = new mongoose.Schema({
  workspaceId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  referralPromotionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralPromotion', required: true, index: true },
  referralCodeId:      { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralCode', required: true },
  referrerCustomerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  source:   { type: String }, // e.g. 'whatsapp', 'instagram', 'qr' — from a ?src= query param
  medium:   { type: String }, // e.g. 'customer_share', 'social_post', 'qr_code'
  ipHash:        { type: String },
  userAgentHash: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ referralCodeId: 1, createdAt: -1 });

module.exports = mongoose.model('ReferralClick', schema);
