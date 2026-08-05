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
  // Defaults to already-completed so every pre-existing workspace (this field
  // didn't exist before) is unaffected — routes/auth.js's self-serve signup
  // path is the only place that explicitly sets completed:false, so the
  // onboarding wizard only ever triggers for a workspace created after this.
  onboarding: {
    completed:   { type: Boolean, default: true },
    currentStep: { type: Number, default: 1 }, // 1-5 — furthest step reached or skipped at
  },
}, { timestamps: true });

module.exports = mongoose.model('Workspace', schema);
