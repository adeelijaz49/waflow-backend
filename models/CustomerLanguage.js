const mongoose = require('mongoose');

// A customer's language (spec §3.1: customers.language + language_source).
// Kept in its own collection keyed by customerId instead of a new field on
// models/Customer.js — the existing customer model and every code path that
// reads or writes customers stay byte-for-byte unchanged.
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
  customerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  language:    { type: String, enum: ['en', 'ar', 'unknown'], default: 'unknown' },
  languageSource: { type: String, enum: ['merchant_set', 'csv_import', 'inferred', 'customer_chose'] },
  // Inference bookkeeping: we try on each inbound text message until a
  // determinate language is found (an emoji-only first message must not lock
  // the customer into 'unknown' forever), but never overwrite merchant_set /
  // csv_import / customer_chose values.
  inferenceAttempts: { type: Number, default: 0 },
  inferredConfidence: { type: Number },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

schema.index({ workspaceId: 1, customerId: 1 }, { unique: true });
schema.index({ workspaceId: 1, language: 1 });

module.exports = mongoose.model('CustomerLanguage', schema);
