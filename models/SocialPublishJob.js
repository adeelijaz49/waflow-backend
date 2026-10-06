const mongoose = require('mongoose');

// One row per publish attempt for a scheduled InstagramPost — append-style
// audit trail of every try (not just the latest), so a flaky Meta API call
// that eventually succeeds on retry #2 still leaves a visible record of
// attempt #1's failure. shared/instagram.js's scheduler creates a new job
// per due post and updates it through its own lifecycle; retries create
// additional job rows rather than mutating history away.
const schema = new mongoose.Schema({
  instagramPostId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstagramPost', required: true, index: true },
  workspaceId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  scheduledAt:  { type: Date, required: true },
  status:       { type: String, enum: ['pending', 'processing', 'success', 'failed', 'cancelled'], default: 'pending' },
  attempts:     { type: Number, default: 0 },
  lastAttemptAt: { type: Date },
  nextRetryAt:   { type: Date },
  errorCode:    { type: String },
  errorMessage: { type: String },
}, { timestamps: true });

schema.index({ status: 1, nextRetryAt: 1 });

module.exports = mongoose.model('SocialPublishJob', schema);
