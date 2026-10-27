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
  // Deliberately still ONLY these two values: the precise method (typed START, a button...) lives on the ConsentEvent. A value the
  // previous release's schema does not know would make every later save of this customer fail there (a STOP included) after a rollback.
  marketingConsentMethod:  { type: String, enum: ['whatsapp_button', 'manual_staff_entry'] },
  marketingConsentAskedAt: { type: Date }, // WhatsApp consent button offered once — prevents re-asking on every order/booking
  deletedAt:      { type: Date }, // set by the internal admin tool's erasure action — PII anonymized, record retained for referential integrity
  deletionReason: { type: String },
  // ── WhatsApp Inbox conversation state (see shared/inbox.js) ───────────────
  // Kept on the customer record rather than a separate conversation model —
  // there is exactly one WhatsApp thread per customer, so a second collection
  // would only add a join. Written by shared/inbox.js's inbound-message and
  // manual-send paths; never touched by any other existing code path.
  unreadCount:         { type: Number, default: 0 },
  lastMessageAt:       { type: Date },
  lastMessagePreview:  { type: String },
  conversationStatus:  { type: String, enum: ['open', 'resolved'], default: 'open' },
  assignedTo:          { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// Every inbound message and every typed STOP / START looks the sender up by phone across ALL customers (the shared number serves
// many): a single-field index keeps that lookup from scanning the whole collection as customers grow. (Single-field on purpose:
// Cosmos DB for MongoDB builds those on an existing collection; compound / unique ones need an empty one.)
schema.index({ phone: 1 });

module.exports = mongoose.model('Customer', schema);
