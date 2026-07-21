const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  loyaltyPointsPerUnit: { type: Number, default: 100 }, // points earned per 1 unit of currency
  minPointsPerPurchase: { type: Number, default: 100 },
  currency:             { type: String, default: 'AUD' },
  flowCooldownDays:     { type: Number, default: 3 }, // global cross-flow cooldown — see utils/flowScheduler.js
}, { collection: 'settings' });

module.exports = mongoose.model('Settings', schema);
