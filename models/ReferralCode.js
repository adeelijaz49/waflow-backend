const mongoose = require('mongoose');

// One row per shareable link — either tied to a specific referrer customer
// (referrerCustomerId set) or the one "generic" social/QR link per promotion
// (referrerCustomerId null). `code` is the only thing that appears in the
// URL — deliberately random, never a phone number or name (see
// shared/referrals.js#generateCode).
const schema = new mongoose.Schema({
  workspaceId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  referralPromotionId:  { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralPromotion', required: true }, // indexed below via the two partial schema.index() calls
  referrerCustomerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true }, // null = generic link
  code:                 { type: String, required: true, unique: true },
  shortUrl:             { type: String, required: true }, // {APP_URL}/r/{code} or /c/{code}
  qrCodeDataUrl:         { type: String }, // data: URL (PNG), generated on demand and cached here
  status:               { type: String, enum: ['active', 'expired', 'disabled'], default: 'active' },
  clickCount:           { type: Number, default: 0 }, // denormalized counter, kept in sync by shared/referrals.js#recordClick
  createdAt:            { type: Date, default: Date.now },
  expiresAt:            { type: Date },
}, { timestamps: { createdAt: false, updatedAt: true } });

// One link per (promotion, referrer) — including referrerCustomerId: null for
// the one generic link per promotion, via a partial index so Mongo's regular
// unique index (which treats every null as distinct) doesn't allow unlimited
// generic links per promotion.
schema.index({ referralPromotionId: 1, referrerCustomerId: 1 }, { unique: true, partialFilterExpression: { referrerCustomerId: { $exists: true } } });
schema.index({ referralPromotionId: 1 }, { unique: true, partialFilterExpression: { referrerCustomerId: { $exists: false } } });

module.exports = mongoose.model('ReferralCode', schema);
