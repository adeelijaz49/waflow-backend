'use strict';
// Append-only audit trail of Waflow-staff onboarding actions (DB design 2.7),
// same shape and index pair as LocalizationAdminLog. Rows are only ever created.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const schema = new Schema({
  // required for every workspace action; a Meta data-deletion request is not always linked to a workspace (target says which request)
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required() { return this.action !== 'data_deletion_done'; } },
  action:      { type: String, enum: ['enrol', 'unenrol', 'activate', 'deactivate', 'enrol_activate', 'refresh', 'data_deletion_done'], required: true },
  target:      { type: String },
  adminUser:   { type: String, default: 'unknown' },
  notes:       { type: String, default: '' },
  ip:          { type: String },
  before:      { type: Schema.Types.Mixed },
  after:       { type: Schema.Types.Mixed },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ workspaceId: 1, createdAt: -1 });
schema.index({ createdAt: -1 });

module.exports = mongoose.model('OnboardingAdminLog', schema);
