'use strict';
// Idempotency ledger of inbound webhook deliveries (Stripe events, Meta
// entries, Meta callbacks). The string _id gives de-duplication for free (DB design 2.7).
const mongoose = require('mongoose');
const { Schema } = mongoose;

const schema = new Schema({
  _id:         { type: String },
  source:      { type: String },
  type:        { type: String },
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace' },
  status:      { type: String, enum: ['processing', 'done', 'ignored', 'unmatched', 'failed'], default: 'processing' },
  attempts:    { type: Number, default: 0 },
  outcome:     { type: String },
  startedAt:   { type: Date },
  finishedAt:  { type: Date },
  errorCode:   { type: String },
});

schema.index({ status: 1 });

module.exports = mongoose.model('OnboardingInbound', schema);
