const mongoose = require('mongoose');

// Smart Insights (shared/insights.js) computes every card fresh from live
// data on each request — nothing about an insight's content is ever stored.
// This model exists solely to persist the merchant's *response* to one:
// dismissed or actioned. There is no "expired" status here — an insight
// that's no longer true simply isn't generated again next time, so expiry
// needs no bookkeeping of its own.
//
// insightKey is deterministic per rule (see shared/insights.js), e.g.
// "inactive_customers_30" or a week-bucketed "best_campaign_2026W38" for
// weekly-cadence rules, so a naturally new week/value produces a new key
// without this collection needing to track staleness itself. Where the same
// key can recur with a different underlying value (e.g. the inactive count
// changing from 20 to 35), metricValueAtAction records what the merchant
// actually saw when they dismissed/actioned it — shared/insights.js only
// honors this row while the freshly-computed metric still matches.
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  insightKey:  { type: String, required: true },
  status:      { type: String, enum: ['dismissed', 'actioned'], required: true },
  metricValueAtAction: Number,
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ workspaceId: 1, insightKey: 1 }, { unique: true });

module.exports = mongoose.model('InsightState', schema);
