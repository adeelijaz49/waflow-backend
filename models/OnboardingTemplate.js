'use strict';
// Starter templates on the MERCHANT's own WhatsApp account (DB design 2.6).
// Deliberately not LocalizedTemplate rows (those are swept with the platform client).
const mongoose = require('mongoose');
const { Schema } = mongoose;

const schema = new Schema({
  workspaceId:             { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  key:                     { type: String, required: true },
  language:                { type: String, enum: ['en', 'ar'], required: true },
  revision:                { type: Number, default: 1 },
  metaTemplateName:        { type: String },
  metaTemplateId:          { type: String },
  category:                { type: String },
  metaStatus:              { type: String },
  metaStatusRaw:           { type: String },
  rejectedReason:          { type: String },
  rejectionRecommendation: { type: String },
  qualityScore:            { type: String },
  submittedAt:             { type: Date },
  submitClaimedAt:         { type: Date },
  attempts:                { type: Number, default: 0 },
  lastCheckedAt:           { type: Date },
  lastErrorCode:           { type: String },
  source:                  { type: String, enum: ['library', 'setup_test'], default: 'library' },
  blockedReason:           { type: String, enum: ['arabic_not_reviewed', 'legal', 'limit', 'invalid', null], default: null },
  // the WhatsApp Business account (WABA id) the Meta ids / statuses of this row belong to: a connection to ANOTHER account re-queues the row
  wabaId:                  { type: String },
}, { timestamps: true });

schema.index({ workspaceId: 1, key: 1, language: 1 }, { unique: true });
schema.index({ workspaceId: 1, metaTemplateId: 1 });
schema.index({ workspaceId: 1, metaTemplateName: 1 });

module.exports = mongoose.model('OnboardingTemplate', schema);
