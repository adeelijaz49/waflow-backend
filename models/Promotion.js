const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  name:            { type: String, required: true },
  description:     { type: String },
  type:            { type: String, enum: ['specific_products', 'store_wide'], required: true },
  products:        [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  categories:      [String],
  discountPercent: { type: Number, required: true, min: 1, max: 100 },
  startDate:       Date,
  endDate:         Date,
  status:          { type: String, enum: ['draft', 'active', 'expired'], default: 'draft' },
  sentAt:          Date,
  sentCount:       { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Promotion', schema);
