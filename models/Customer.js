const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  firstname: { type: String, required: true },
  lastname:  { type: String, required: true },
  phone:     { type: String, required: true },
  email:     { type: String },
  address:   { type: String },
  loyaltyPoints: { type: Number, default: 0 },
  isDemo:    { type: Boolean, default: false }, // flags seeded demo customers (see seed/seed-demo.js)
  optedOut:    { type: Boolean, default: false }, // replied STOP — blocks marketing sends (promotions, loyalty reminders)
  optedOutAt:  { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('Customer', schema);
