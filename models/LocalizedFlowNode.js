const mongoose = require('mongoose');

// The Arabic version of a branching FOLLOW-UP message (a MessageNode that is not an entry node) of an
// Automated Flow or a Promotion conversation. Follow-ups are free-form replies sent inside the 24-hour
// window opened by the customer's button tap, so they need no Meta approval, only native review
// (spec section 8). One row per (workspace, node, language); only 'ar' exists in v1 (the enum is kept
// open so 'bilingual' can be added without a migration).
//
// Standalone from models/MessageNode.js: the English node (body, buttons, nextAction) stays the single
// source of truth for structure. `buttons` here carry only the Arabic LABEL per button POSITION: the tap
// payload is positional (msgnode_<nodeId>_<position>) and nextAction is never copied.
//
// `sourceHash` fingerprints the English node (body + button positions/labels) at the time this row was
// written. When the English text is edited later the hash no longer matches, the row is "stale" and the
// sender falls back to English until the merchant re-saves and re-reviews (an offer or price changed in
// English must not keep going out in an old Arabic version).
//
// Writes are single-document updates guarded by `contentVersion` (a review is tied to the exact text that
// was read); rows are never deleted ("turn off" = set the review back to draft).
const buttonSchema = new mongoose.Schema({
  position: { type: Number, required: true, min: 0, max: 2 },
  text:     { type: String, default: '' }, // an empty label is a savable draft; validation blocks sending it
}, { _id: false });

const schema = new mongoose.Schema({
  workspaceId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  messageNodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageNode', required: true },
  language:      { type: String, enum: ['ar'], default: 'ar', required: true },
  ownerType:     { type: String, enum: ['flow', 'promotion'] },
  ownerId:       { type: mongoose.Schema.Types.ObjectId },
  body:          { type: String, default: '' },
  buttons:       { type: [buttonSchema], default: [] },
  contentVersion: { type: Number, default: 1 },
  sourceHash:    { type: String },
  reviewStatus:  { type: String, enum: ['draft', 'reviewed'], default: 'draft' },
  reviewedBy:    { type: String },
  reviewedById:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt:    { type: Date },
  source:        { type: String, enum: ['merchant', 'ai'], default: 'merchant' },
  createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// New collection: a unique index is safe on Cosmos DB for MongoDB here.
schema.index({ workspaceId: 1, messageNodeId: 1, language: 1 }, { unique: true });

module.exports = mongoose.model('LocalizedFlowNode', schema);
