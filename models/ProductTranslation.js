const mongoose = require('mongoose');

// Optional Arabic name/description for a product or service (spec §3.6),
// stored beside — not inside — models/Product.js and models/Service.js, so the
// existing catalogue code is untouched. Text is only ever written by the
// merchant (or by an AI draft the merchant confirmed): machine-translated
// content is saved as `draft` (spec §8) and is never auto-applied.
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
  kind:        { type: String, enum: ['product', 'service'], required: true },
  refId:       { type: mongoose.Schema.Types.ObjectId, required: true }, // Product._id or Service._id
  language:    { type: String, enum: ['ar'], default: 'ar' },
  name:        { type: String, default: '' },
  description: { type: String, default: '' },
  status:      { type: String, enum: ['draft', 'reviewed'], default: 'draft' },
  source:      { type: String, enum: ['merchant', 'csv', 'ai'], default: 'merchant' },
  reviewedBy:  { type: String },
  reviewedAt:  { type: Date },
  updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

schema.index({ workspaceId: 1, kind: 1, refId: 1, language: 1 }, { unique: true });

module.exports = mongoose.model('ProductTranslation', schema);
