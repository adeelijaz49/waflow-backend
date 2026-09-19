const mongoose = require('mongoose');

// Append-only audit trail for every manual entitlement/credit change made
// from the internal-admin billing tool (routes/adminEntitlements.js) —
// required for pilots, support issues and founding-merchant deals so any
// override is traceable to who made it, when, and why. adminUser is the
// HTTP Basic Auth username from middleware/requireInternalAdmin.js (this
// codebase has no User record for internal staff, same precedent as
// AdminAuditLog.js storing req.adminIp instead of a user ref).
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  adminUser:   { type: String, required: true },
  // e.g. 'overrides.users', 'plan', 'overageBillingEnabled', 'creditGrant',
  // 'addOn:<addOnId>.status' — free-form but always dot-path-shaped so it's
  // legible in a support/dispute review without a lookup table.
  field:    { type: String, required: true },
  oldValue: { type: mongoose.Schema.Types.Mixed },
  newValue: { type: mongoose.Schema.Types.Mixed },
  reason:   { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ workspaceId: 1, createdAt: -1 });

module.exports = mongoose.model('EntitlementAdjustment', schema);
