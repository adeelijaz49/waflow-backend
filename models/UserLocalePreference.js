const mongoose = require('mongoose');

// A staff member's own screen language ("platform user language", spec §2 —
// stored now, applied to the whole dashboard only from Phase 5) and their AI
// reply-language override (spec §6: "replies in the language the user wrote
// in; user can override in settings").
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  uiLanguage:  { type: String, enum: ['en', 'ar'], default: 'en' },
  aiLanguage:  { type: String, enum: ['auto', 'en', 'ar'], default: 'auto' },
}, { timestamps: true });

schema.index({ workspaceId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('UserLocalePreference', schema);
