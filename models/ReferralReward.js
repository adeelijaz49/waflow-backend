const mongoose = require('mongoose');

// Append-only record of an actually-issued (or pending/rejected) reward —
// kept separate from Referral itself so a referral's reward can be voided/
// re-approved without losing the history of what was attempted. Mirrors the
// ConsentEvent/PointsLedgerEntry "never edited or deleted" convention.
const schema = new mongoose.Schema({
  workspaceId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  referralId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Referral', required: true, index: true },
  referrerCustomerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  referredCustomerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  rewardType:  { type: String, required: true }, // mirrors ReferralPromotion.referrerRewardType
  rewardValue: { type: Number, default: 0 },
  voucherId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher' },
  status: { type: String, enum: ['pending_approval', 'issued', 'rejected', 'voided'], default: 'issued' },
  approvedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  issuedAt: { type: Date },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ workspaceId: 1, referrerCustomerId: 1, createdAt: -1 });

module.exports = mongoose.model('ReferralReward', schema);
