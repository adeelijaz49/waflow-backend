const mongoose = require('mongoose');

// A named plan template — global, not per-workspace. shared/entitlements.js
// resolves a workspace's *effective* limits as this plan's entitlements,
// overridden field-by-field by Subscription.overrides, plus any active
// AddOn quantities — see shared/entitlements.js#resolveEntitlements.
const entitlementsSchema = new mongoose.Schema({
  locations:               { type: Number, default: 1 },
  whatsappAccounts:        { type: Number, default: 1 },
  users:                   { type: Number, default: 1 },
  customerProfiles:        { type: Number, default: 500 },
  aiPromptsPerCycle:       { type: Number, default: 100 },
  whatsappCreditPerCycle:  { type: Number, default: 10 }, // in `currency` below
}, { _id: false });

const schema = new mongoose.Schema({
  code:        { type: String, required: true, unique: true }, // e.g. 'starter', 'growth', 'pro'
  name:        { type: String, required: true },
  description: { type: String },
  // One-off plans built for a specific merchant (founding merchant, reseller
  // deal, enterprise contract) — not offered on a public plan picker. See
  // shared/entitlements.js's default-plan lazy-provisioning, which only ever
  // picks a non-custom plan.
  isCustom:     { type: Boolean, default: false },
  active:       { type: Boolean, default: true },
  entitlements: { type: entitlementsSchema, default: () => ({}) },
  currency:     { type: String, default: 'AUD' },
  priceMonthly: { type: Number, default: 0 }, // informational only — no payment-provider price binding yet
}, { timestamps: true });

module.exports = mongoose.model('Plan', schema);
