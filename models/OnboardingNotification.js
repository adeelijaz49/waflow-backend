'use strict';
// In-app notifications of the onboarding flow (DB design 2.5). The unique
// {workspaceId, dedupeKey} index makes notify() idempotent.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const schema = new Schema({
  workspaceId:   { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  dedupeKey:     { type: String, required: true },
  kind:          { type: String, required: true },
  severity:      { type: String, enum: ['info', 'success', 'warning', 'action'], default: 'info' },
  titleKey:      { type: String },
  bodyKey:       { type: String },
  params:        { type: Schema.Types.Mixed },
  actionPath:    { type: String },
  readAt:        { type: Date, default: null },
  emailSentAt:   { type: Date },
  emailAttempts: { type: Number, default: 0 },
  emailError:    { type: String },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ workspaceId: 1, dedupeKey: 1 }, { unique: true });
schema.index({ workspaceId: 1, createdAt: -1 });

module.exports = mongoose.model('OnboardingNotification', schema);
