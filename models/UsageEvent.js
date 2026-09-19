const mongoose = require('mongoose');

// Append-only usage ledger — one document per billable/limited action
// (never edited or deleted, same convention as ConsentEvent/PointsLedgerEntry).
// This is what usage-summary counters, the merchant Usage & Limits page's
// history table, and WhatsApp-credit accounting are all computed from — see
// shared/usageLedger.js and shared/entitlements.js#getUsageSummary.
const schema = new mongoose.Schema({
  workspaceId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  billingPeriodId: { type: mongoose.Schema.Types.ObjectId, ref: 'BillingPeriod', required: true, index: true },
  usageType: {
    type: String,
    enum: ['ai_prompt', 'whatsapp_message', 'customer_profile', 'user', 'location', 'whatsapp_account'],
    required: true,
  },
  quantity:       { type: Number, default: 1 },
  providerCost:   { type: Number, default: 0 }, // what WaFlow actually paid (e.g. Meta's per-message cost)
  customerCharge: { type: Number, default: 0 }, // what was deducted from the merchant's credit — see shared/whatsappRateCard.js
  currency:       { type: String, default: 'AUD' },
  relatedCampaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Promotion' },
  relatedMessageId:  { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppMessage' },
  relatedCustomerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  relatedUserId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  metadata:          { type: mongoose.Schema.Types.Mixed },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ workspaceId: 1, billingPeriodId: 1, usageType: 1 });
schema.index({ workspaceId: 1, createdAt: -1 });

module.exports = mongoose.model('UsageEvent', schema);
