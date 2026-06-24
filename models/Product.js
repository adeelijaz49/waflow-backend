const mongoose = require('mongoose');

const variantSchema = new mongoose.Schema({
  size:  { type: String, required: true },
  color: { type: String, required: true },
  stock: { type: Number, default: 0 },
  sku:   { type: String },
}, { _id: false });

const schema = new mongoose.Schema({
  name:        { type: String, required: true },
  description: { type: String },
  category:    { type: String, required: true },
  basePrice:   { type: Number, required: true },
  variants:    [variantSchema],
  images:      [String],
  active:      { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Product', schema);
