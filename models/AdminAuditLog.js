const mongoose = require('mongoose');

// Append-only trail of every /internal-admin action — backs both the admin
// tool's own audit history and utils/breachAlert.js's anomaly checks. Not
// scoped to a workspace on purpose: the internal admin tool is Waflow-staff
// facing and searches across all workspaces.
const schema = new mongoose.Schema({
  action: { type: String, enum: ['login_success', 'login_failed', 'search', 'view_customer', 'correct_customer', 'delete_customer'], required: true },
  ip: String,
  targetCustomerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  targetPhone:       String,
  targetWorkspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace' },
  detail: mongoose.Schema.Types.Mixed,
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ createdAt: -1 });
schema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model('AdminAuditLog', schema);
