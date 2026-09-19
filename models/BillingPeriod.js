const mongoose = require('mongoose');

// One document per billing-cycle instance for a workspace — what UsageEvent
// and CreditReservation attach to via billingPeriodId, so "usage this cycle"
// is always a query against a real period record rather than a recomputed
// date range. Created on demand by
// shared/entitlements.js#resolveCurrentBillingPeriod the first time it's
// needed for a given cycle; never created speculatively for future cycles.
const schema = new mongoose.Schema({
  workspaceId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', required: true },
  periodStart:    { type: Date, required: true },
  periodEnd:      { type: Date, required: true },
  source:         { type: String, enum: ['manual', 'stripe'], default: 'manual' },
  stripeInvoiceId: { type: String },
}, { timestamps: true });

// Unique, not just indexed — shared/entitlements.js#resolveCurrentBillingPeriod
// relies on a real E11000 to detect a concurrent create for the same cycle
// (two requests racing to lazily provision the same workspace+period).
schema.index({ workspaceId: 1, periodStart: 1 }, { unique: true });

module.exports = mongoose.model('BillingPeriod', schema);
