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
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ customerId: 1, createdAt: -1 });
schema.index({ workspaceId: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model('ConsentEvent', schema);
