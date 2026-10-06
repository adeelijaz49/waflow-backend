const mongoose = require('mongoose');

// A minimal, standalone discount/voucher record — created by the referral
// engine for both "friend" and "referrer" voucher-type rewards. Deliberately
// not wired into checkout (that lives in existing order-creation code this
// feature doesn't touch) — redemption is tracked manually for now, via
// routes/referrals.js, by whoever (merchant or customer) presents the code.
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  code:        { type: String, required: true, unique: true },
  type:        { type: String, enum: ['fixed_discount', 'percent_discount', 'free_item'], required: true },
  value:       { type: Number, default: 0 }, // currency amount, percent, or unused for free_item
  label:       { type: String }, // free-text description, e.g. "Free dessert"
  customerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  sourceReferralId: { type: mongoose.Schema.Types.ObjectId, ref: 'Referral' },
  status:      { type: String, enum: ['active', 'redeemed', 'expired', 'voided'], default: 'active' },
  redeemedAt:  { type: Date },
  redeemedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  expiresAt:   { type: Date },
}, { timestamps: true });

schema.index({ workspaceId: 1, customerId: 1, status: 1 });

module.exports = mongoose.model('Voucher', schema);
