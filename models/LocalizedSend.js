const mongoose = require('mongoose');

// One row per (campaign, customer): which language they were sent, whether a
// fallback happened and why, and the WhatsApp message id. The unique index on
// (campaignId, customerId) makes sending idempotent — a retry can never send a
// customer the same campaign twice. Append-style log: rows are updated through
// the send lifecycle but never deleted.
//
// Lifecycle: queued -> sending (claimed by the sender, atomically) -> sent |
// failed. Rows that never reach WhatsApp are written straight as skipped_*:
// no_consent / opted_out (consent), blocked (no usable language variant),
// demo (the owner's demo data is never sent to Meta), error (invalid or
// duplicate phone, missing customer, ...). `errorCode` is the machine reason
// (Meta's error code for failed sends, our own short code for skips).
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  campaignId:  { type: mongoose.Schema.Types.ObjectId, ref: 'LocalizedCampaign', required: true },
  customerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  phone:       { type: String, required: true }, // denormalised, same precedent as CampaignMessage/ConsentEvent
  requestedLanguage: { type: String },
  usedLanguage:      { type: String, enum: ['en', 'ar', 'bilingual'] },
  fallback:          { type: Boolean, default: false },
  fallbackReason:    { type: String },
  metaTemplateName:  { type: String },
  status: {
    type: String,
    enum: ['queued', 'sending', 'sent', 'failed', 'skipped_no_consent', 'skipped_opted_out', 'skipped_blocked', 'skipped_no_credit', 'skipped_demo', 'skipped_error'],
    default: 'queued',
  },
  wamid: { type: String },
  sentAt: { type: Date },
  error: { type: String },     // sanitised, English, for the merchant's eyes
  errorCode: { type: String }, // Meta error code (failed) or our own reason code (skipped_*)
}, { timestamps: true });

schema.index({ campaignId: 1, customerId: 1 }, { unique: true });
schema.index({ campaignId: 1, status: 1 });
schema.index({ workspaceId: 1, wamid: 1 });

module.exports = mongoose.model('LocalizedSend', schema);
