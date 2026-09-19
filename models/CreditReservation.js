const mongoose = require('mongoose');

// A hold against a workspace's WhatsApp credit for a bulk campaign, created
// before sending and reconciled against the campaign's real UsageEvents
// afterward — see shared/creditReservation.js. While 'reserved', this
// reservation's estimatedCost counts against available credit (alongside
// this cycle's real UsageEvent totals) so a second campaign can't
// over-commit credit the first one is already holding.
const schema = new mongoose.Schema({
  workspaceId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  billingPeriodId: { type: mongoose.Schema.Types.ObjectId, ref: 'BillingPeriod', required: true },
  campaignId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Promotion' },
  recipientCount:  { type: Number, required: true },
  countryCode:     { type: String },
  messageCategory: { type: String },
  unitCost:        { type: Number },
  estimatedCost:   { type: Number, required: true },
  currency:        { type: String, required: true },
  // 'reconciling' is a short-lived transitional claim — see
  // shared/creditReservation.js#reconcileReservation, which atomically flips
  // 'reserved' -> 'reconciling' via findOneAndUpdate before doing any real
  // work, so a duplicate/concurrent reconcile call (e.g. a retried
  // completion webhook) sees the reservation is no longer 'reserved' and
  // bails out instead of double-billing every message a second time.
  status: { type: String, enum: ['reserved', 'reconciling', 'reconciled', 'released', 'insufficient'], default: 'reserved' },
  actualCost:   { type: Number },
  reconciledAt: { type: Date },
}, { timestamps: true });

schema.index({ workspaceId: 1, status: 1 });

module.exports = mongoose.model('CreditReservation', schema);
