const mongoose = require('mongoose');

// Versioned WhatsApp pricing — never hardcode a rate in campaign-send logic;
// always resolve through shared/whatsappRateCard.js#getRate. Rows are never
// edited once effectiveTo is set (a new rate is added as a new row via
// #addRateVersion, which closes the previous row's effectiveTo) so a
// historical campaign's recorded UsageEvent.customerCharge/providerCost never
// silently drifts when Meta or WaFlow changes pricing later.
const schema = new mongoose.Schema({
  countryCode: { type: String, required: true }, // ISO 3166-1 alpha-2, or '*' as the catch-all default
  messageCategory: { type: String, enum: ['marketing', 'utility', 'authentication', 'service'], required: true },
  providerCost:   { type: Number, required: true }, // what Meta actually charges WaFlow
  customerCharge: { type: Number, required: true }, // what's deducted from the merchant's WhatsApp credit
  currency:    { type: String, required: true, default: 'USD' },
  effectiveFrom: { type: Date, required: true },
  effectiveTo:   { type: Date }, // unset = currently in effect
  source:        { type: String }, // e.g. 'meta_published_2026_q1', 'manual_admin_entry'
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ countryCode: 1, messageCategory: 1, effectiveFrom: -1 });
// At most one currently-in-effect (effectiveTo unset) row per country+category —
// same partial-unique idempotency pattern as models/FlowEnrollment.js. Without
// this, two concurrent shared/whatsappRateCard.js#addRateVersion calls (or a
// concurrent #ensureDefaultRates seed) could both leave a row "open",
// corrupting that pair's version history — see that file for the E11000
// handling this backs.
schema.index({ countryCode: 1, messageCategory: 1 }, { unique: true, partialFilterExpression: { effectiveTo: { $exists: false } } });

module.exports = mongoose.model('WhatsAppRateCard', schema);
