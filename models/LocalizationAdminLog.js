'use strict';
// Append-only audit trail of Waflow-staff changes to the per-merchant Arabic
// flag. AdminAuditLog's `action` enum is closed (and owned by the compliance
// feature), so localisation keeps its own small collection. Rows are only ever
// created, never updated or deleted.
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
  action:      { type: String, enum: ['enable', 'disable'], required: true },
  adminUser:   { type: String, default: 'unknown' }, // Basic-auth user, or 'cli:<os user>' from the script
  notes:       { type: String, default: '' },
  ip:          { type: String },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ workspaceId: 1, createdAt: -1 });
schema.index({ createdAt: -1 }); // the admin page sorts one workspace's log by createdAt; Cosmos DB wants an index on the sort field itself (as AdminAuditLog has)

module.exports = mongoose.model('LocalizationAdminLog', schema);
