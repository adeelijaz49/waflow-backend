const mongoose = require('mongoose');

// Deliberately NOT part of the Entitlements engine built earlier (shared/
// entitlements.js / models/Plan.js etc.) — that system's AddOn.type enum is
// a fixed, closed set of 6 general plan dimensions, and extending it would
// mean modifying an existing file. This is its own minimal, standalone
// feature flag instead: one document per workspace, default disabled
// (matches the spec's "Social Growth Add-On" positioning — off until
// granted), toggled only via routes/adminInstagram.js (staff-only).
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, unique: true },
  enabled:     { type: Boolean, default: false },
  grantedAt:   { type: Date },
  grantedBy:   { type: String }, // admin Basic-Auth username, same convention as EntitlementAdjustment.adminUser
  notes:       { type: String },
}, { timestamps: true });

module.exports = mongoose.model('InstagramEntitlement', schema);
