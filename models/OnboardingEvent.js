'use strict';
// Append-only onboarding analytics (DB design 2.3). No PII: every row goes
// through shared/onboarding/analytics.js#sanitizeEvent before it is written.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const schema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  type: {
    type: String,
    enum: ['step_enter', 'step_complete', 'step_skip', 'step_fail', 'connect_event', 'connect_result', 'status_change',
      'payment_state', 'template_status', 'send_blocked', 'help_opened', 'notification', 'webhook_dropped', 'admin'],
    required: true,
  },
  step:       { type: String },
  code:       { type: String },
  reason:     { type: String },
  durationMs: { type: Number },
  meta:       { type: Schema.Types.Mixed },
  at:         { type: Date, default: Date.now },
});

schema.index({ workspaceId: 1, at: -1 });
schema.index({ type: 1, code: 1 });
schema.index({ type: 1, step: 1 });

module.exports = mongoose.model('OnboardingEvent', schema);
