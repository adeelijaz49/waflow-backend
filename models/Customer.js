const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true },
  firstname: { type: String, required: true },
  lastname:  { type: String, required: true },
  phone:     { type: String, required: true },
  email:     { type: String },
  address:   { type: String },
  notes:     { type: String }, // freeform — e.g. from a CSV import's optional "tags/notes" column
  loyaltyPoints: { type: Number, default: 0 },
  loyaltyPointsUpdatedAt: { type: Date }, // set whenever loyaltyPoints changes — drives the points_balance_reminder flow trigger
  isDemo:    { type: Boolean, default: false }, // flags seeded demo customers (see seed/seed-demo.js)
  optedOut:    { type: Boolean, default: false }, // replied STOP — blocks marketing sends (promotions, loyalty reminders)
  optedOutAt:  { type: Date },
  // Affirmative opt-in — NOT the inverse of optedOut. Defaults to false so every
  // customer starts marketing-ineligible until real consent is captured (WhatsApp
  // button, manual/CSV checkbox). Mutate only via shared/consent.js so every change
  // is logged to ConsentEvent — never set these directly through ops.updateCustomer.
  marketingConsent:        { type: Boolean, default: false },
  marketingConsentAt:      { type: Date },
  marketingConsentMethod:  { type: String, enum: ['whatsapp_button', 'manual_staff_entry'] },
  marketingConsentAskedAt: { type: Date }, // WhatsApp consent button offered once — prevents re-asking on every order/booking
  deletedAt:      { type: Date }, // set by the internal admin tool's erasure action — PII anonymized, record retained for referential integrity
  deletionReason: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('Customer', schema);
