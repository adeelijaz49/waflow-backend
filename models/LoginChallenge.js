const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  method:     { type: String, enum: ['whatsapp_otp', 'email_link'], required: true },
  contact:    { type: String, required: true }, // normalized phone (digits-only) or lowercased email
  codeHash:   { type: String, required: true }, // SHA-256 of the 6-digit code or the magic-link token
  attempts:   { type: Number, default: 0 },
  consumedAt: { type: Date },
  validUntil: { type: Date }, // when the code / link stops working (minutes after it was made); rows written before this field ended at expiresAt
  expiresAt:  { type: Date, required: true }, // when the ROW is cleaned away (TTL index): a day and an hour, because the rate limits count the rows
}, { timestamps: true });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ contact: 1, method: 1, createdAt: -1 }); // recent-request lookups for rate limiting

module.exports = mongoose.model('LoginChallenge', schema);
