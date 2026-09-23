const mongoose = require('mongoose');

// Append-only "who accepted what, which version, when" record — entries are
// never edited or deleted (same convention as ConsentEvent.js). Written
// exclusively by shared/legalAcceptance.js's helpers, never directly.
// Acceptance status is always computed live from this log against
// shared/legalDocuments.js's current version — there is no cached "accepted"
// boolean anywhere else to fall out of sync.
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  documentSlug: {
    type: String,
    enum: ['terms_of_service', 'privacy_policy', 'acceptable_use_policy', 'data_processing_agreement', 'refund_cancellation_policy'],
    required: true,
  },
  documentVersion: { type: String, required: true },
  // Which UI flow produced this row — the combined ToS+Privacy+AUP step logs
  // three rows (one per document) with the same flow value; the DPA is its
  // own separate step, logged once.
  flow: { type: String, enum: ['combined_tos_privacy_aup', 'dpa'], required: true },
  ipAddress: { type: String },
  userAgent: { type: String },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ userId: 1, documentSlug: 1, createdAt: -1 });
schema.index({ workspaceId: 1, documentSlug: 1, createdAt: -1 });

module.exports = mongoose.model('LegalAcceptance', schema);
