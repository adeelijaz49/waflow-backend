const mongoose = require('mongoose');

// Language bookkeeping for the EXISTING senders (shared/operations.js sendPromotion / sendLoyaltyReminders /
// sendConsentRequests, the referral link text and the booking / order notices) when an Arabic customer of
// a flagged merchant is in the batch (shared/localization/legacySenders.js, utilitySend.js).
//
// A sidecar on purpose:
//   * CampaignMessage keeps being written by the existing code exactly as today (its report and
//     tap/delivery correlation by wamid are unchanged) and has no language field;
//   * LocalizedSend needs a LocalizedCampaign and its resumer would treat a synthetic `sending` campaign
//     as stuck, so legacy sends get their own collection.
// One row per Arabic-resolved customer per run (an Arabic send, an English fallback or a skip). English
// customers get NO row. Never deleted (a status field changes, nothing is removed). No phone number is stored (customerId is
// enough to join back to the Customer; the erasure routine anonymises that record), and `error` is sanitised by the writer.
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
  runId:       { type: String, required: true },
  sender:      { type: String, enum: ['promotion', 'loyalty_reminder', 'consent_request', 'referral_link', 'notice'], required: true },
  refId:       { type: String },                       // promotion id / booking id / order id (informational)
  customerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  requestedLanguage: { type: String, enum: ['ar'], default: 'ar' },
  usedLanguage:      { type: String, enum: ['ar', 'en'], required: true },
  fallback:          { type: Boolean, default: false },
  fallbackReason:    { type: String },
  templateId:        { type: mongoose.Schema.Types.ObjectId, ref: 'LocalizedTemplate' },
  metaTemplateName:  { type: String },
  via:         { type: String, enum: ['template', 'session', 'existing'], default: 'template' },
  status:      { type: String, enum: ['sent', 'failed', 'skipped'], required: true },
  wamid:       { type: String },
  errorCode:   { type: String },
  error:       { type: String },
}, { timestamps: true });

schema.index({ workspaceId: 1, sender: 1, refId: 1 });
schema.index({ workspaceId: 1, wamid: 1 });
schema.index({ runId: 1 });

module.exports = mongoose.model('LocalizedLegacySend', schema);
