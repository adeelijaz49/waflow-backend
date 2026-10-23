'use strict';
// "Need help?" / number-help requests of the onboarding flow (DB design 2.4).
// SupportTicket is deliberately not reused (no category/step, unescaped mail).
const mongoose = require('mongoose');
const { Schema } = mongoose;

const schema = new Schema({
  workspaceId:   { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  userId:        { type: Schema.Types.ObjectId, ref: 'User' },
  kind:          { type: String, enum: ['number_help', 'help', 'payment_help'], required: true },
  step:          { type: String },
  lastErrorCode: { type: String },
  message:       { type: String, maxlength: 500 },
  businessName:  { type: String },
  contactEmail:  { type: String },
  status:        { type: String, enum: ['open', 'handled'], default: 'open' },
  emailSentAt:   { type: Date },
  emailError:    { type: String },
  handledBy:     { type: String },
  handledAt:     { type: Date },
  // The 10-minute window the request was made in (floor(now / 10 min)). With the unique index below it makes the de-duplication ATOMIC:
  // two simultaneous requests of one workspace and kind create ONE row (E11000 = duplicate), however many arrive at once.
  windowKey:     { type: String },
}, { timestamps: true });

schema.index({ workspaceId: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });
// UNIQUE, on this NEW collection only (created empty at first use): one request per workspace, kind and 10-minute window
schema.index({ workspaceId: 1, kind: 1, windowKey: 1 }, { unique: true });

module.exports = mongoose.model('OnboardingSupportRequest', schema);
