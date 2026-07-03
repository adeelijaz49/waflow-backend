const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  name:            { type: String, required: true },
  description:     { type: String },
  customerType:    { type: String, enum: ['cash', 'points'], default: 'cash' },
  scope:           { type: String, enum: ['products', 'services'], default: 'products' },
  type:            { type: String, enum: ['specific_products', 'store_wide', 'specific_services'], default: 'specific_products' },
  products:        [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  services:        [{ type: mongoose.Schema.Types.ObjectId, ref: 'Service' }],
  categories:      [String],
  discountPercent: { type: Number, min: 0, max: 100, default: 0 },
  pointsPrice:     { type: Number, default: 0 }, // points required per product for redemption
  startDate:       Date,
  endDate:         Date,
  status:          { type: String, enum: ['draft', 'active', 'expired'], default: 'draft' },
  sentAt:          Date,
  sentCount:       { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Promotion', schema);
