const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  name: { type: String, required: true },
  // Optional per-workspace override — falls back to the platform WA_PHONE_ID/
  // WA_TOKEN/WA_WABA_ID env vars until a workspace configures its own number.
  whatsapp: {
    phoneId: { type: String },
    token:   { type: String },
    wabaId:  { type: String },
  },
}, { timestamps: true });

module.exports = mongoose.model('Workspace', schema);
