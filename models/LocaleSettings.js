const mongoose = require('mongoose');

// Per-workspace localisation settings AND the `arabic_enabled` rollout flag
// (spec §8: "put Arabic behind a per-merchant feature flag so KSA merchants
// can be switched on one at a time"). Deliberately a standalone collection —
// same precedent as models/InstagramEntitlement.js — so the existing
// Workspace/Settings models stay untouched. The flag is only ever changed by
// Waflow staff (routes/adminLocalization.js), never by the merchant.
const schema = new mongoose.Schema({
  workspaceId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, unique: true },
  arabicEnabled: { type: Boolean, default: false },
  arabicEnabledAt: { type: Date },
  arabicEnabledBy: { type: String },
  notes:         { type: String },
  // Merchant-controlled: the language customers get when their own is unknown.
  defaultCustomerLanguage: { type: String, enum: ['en', 'ar'], default: 'en' },
  // Which language comes first in a bilingual (one-message-both-languages) send.
  bilingualOrder: { type: String, enum: ['ar_first', 'en_first'], default: 'ar_first' },
}, { timestamps: true });

module.exports = mongoose.model('LocaleSettings', schema);
