const mongoose = require('mongoose');

// phoneId / wabaId are stored trimmed; an empty string means "not set" (so the partial unique index below never sees '').
const trimmed = (v) => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  return t === '' ? undefined : t;
};

const schema = new mongoose.Schema({
  name: { type: String, required: true },
  // Optional per-workspace WhatsApp number (utils/waTenant.js resolves it). A workspace without a phoneId (or with
  // enabled:false) keeps sending from the platform number (WA_PHONE_ID / WA_TOKEN / WA_WABA_ID).
  //   token            LEGACY plaintext field: never read and never written any more (left in place for old documents).
  //   tokenEncrypted   the access token, AES-256-GCM through shared/onboarding/tokenVault.js (bound to this workspace id).
  //                    select:false - it is only ever loaded explicitly by utils/waTenant.js and never returned by an API.
  //   A number added inside the platform WABA needs only phoneId (the platform token is valid for it).
  whatsapp: {
    phoneId: { type: String, set: trimmed },
    token:   { type: String },
    wabaId:  { type: String, set: trimmed },
    tokenEncrypted:     { type: String, select: false },
    tokenKeyVersion:    { type: String },
    displayPhoneNumber: { type: String },
    verifiedName:       { type: String },
    tokenIsValid:       { type: Boolean },
    tokenCheckedAt:     { type: Date },
    // No schema default on purpose: a default would write whatsapp:{enabled:true} into every NEW workspace document.
    // Absent means enabled - only an explicit false switches the number off (back to the platform number).
    enabled:            { type: Boolean },
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

// One workspace per WhatsApp phone number id (inbound routing relies on it). Partial, so the many workspaces without a
// number do not collide on "missing".
schema.index(
  { 'whatsapp.phoneId': 1 },
  { unique: true, partialFilterExpression: { 'whatsapp.phoneId': { $type: 'string' } } },
);

module.exports = require('../utils/indexWatch')(mongoose.model('Workspace', schema)); // a failed index build is logged, not silent
