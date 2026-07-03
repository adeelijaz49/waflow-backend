const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  firstname: { type: String, required: true },
  lastname:  { type: String, required: true },
  phone:     { type: String, required: true },
  email:     { type: String },
  address:   { type: String },
  loyaltyPoints: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Customer', schema);
