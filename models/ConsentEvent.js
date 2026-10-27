const mongoose = require('mongoose');

// Append-only "who/what/when/how" record of every marketing-consent state
// transition — entries are never edited or deleted (same convention as
// PointsLedgerEntry.js). Written exclusively by shared/consent.js's helpers,
// never directly, so this log can never silently fall out of sync with
// Customer.marketingConsent/optedOut.
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  customerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
  phone:       { type: String, required: true }, // denormalized — survives customer deletion, matches CampaignMessage.phone precedent
  type:        { type: String, enum: ['consent_given', 'consent_withdrawn', 'consent_reinstated', 'consent_declined'], required: true },
  // Opt-in method is deliberately just these two — the customer tapped a
  // WhatsApp button themselves, or a merchant/staff member entered it on
  // their behalf (Add Customer checkbox, CSV import attestation, the
  // customer-detail "Mark as consented" action — source captures which).
  // Opt-out/reinstate mechanisms keep their own distinct values.
  method:      { type: String, enum: ['whatsapp_button', 'manual_staff_entry', 'whatsapp_stop_command', 'whatsapp_start_command', 'whatsapp_optout_button'], required: true },
  source:      { type: String }, // free text, e.g. "Add Customer form", "CSV import job <id>"
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // null when the customer self-served via WhatsApp
  campaignMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'CampaignMessage' },
  importJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'ImportJob' },
  // ── Evidence of a customer's own tap (all optional; written only by shared/promoConsentTap.js and the START/STOP
  // handlers). The point is to be able to show, later, exactly what the customer was asked and what they pressed. ──
  promotionId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Promotion' },
  promotionName:   String,
  messageText:     String, // the message text exactly as the customer saw it
  buttonLabel:     String, // the label of the button they pressed, as WhatsApp reported it
  buttonPosition:  Number,
  buttonAction:    String, // opt_in / opt_out / interested / end_flow
  templateName:    String,
  templateVersion: Number,
  sourceWamid:     String, // the message that was tapped (our outbound wamid)
  // The customer's own message id. UNIQUE (sparse): a Meta redelivery of the same tap hits E11000 instead of writing a
  // second event. Never store null here - a sparse index still indexes an explicit null - leave the field out.
  inboundWamid:    String,
  tappedAt:        Date,   // WhatsApp's own timestamp of the tap (UTC)
  receivedAt:      Date,   // when this server processed it
  signature:       { type: String, enum: ['valid', 'invalid', 'missing', 'unconfigured', null] }, // X-Hub-Signature-256 verdict of the webhook request
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ customerId: 1, createdAt: -1 });
schema.index({ workspaceId: 1, type: 1, createdAt: -1 });
schema.index({ workspaceId: 1, promotionId: 1, type: 1, createdAt: -1 });
schema.index({ inboundWamid: 1 }, { unique: true, sparse: true });

module.exports = require('../utils/indexWatch')(mongoose.model('ConsentEvent', schema)); // a failed index build is logged, not silent
