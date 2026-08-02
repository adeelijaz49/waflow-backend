const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  // Optional, not unique — pre-multi-tenant Settings docs (and any caller that
  // doesn't pass a workspace) have none, and getLoyaltySettings()/
  // updateLoyaltySettings() fall back to the oldest/global doc in that case.
  // See shared/operations.js.
  workspaceId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true },
  loyaltyPointsPerUnit: { type: Number, default: 100 }, // points earned per 1 unit of currency
  minPointsPerPurchase: { type: Number, default: 100 },
  currency:             { type: String, default: 'AUD' },
  flowCooldownDays:     { type: Number, default: 3 }, // global cross-flow cooldown — see utils/flowScheduler.js
  merchantName:         { type: String, default: '' }, // greets the merchant in AI Mode
}, { collection: 'settings' });

module.exports = mongoose.model('Settings', schema);
