const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
  product:     { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  productName: String,
  category:    String,
  size:        String,
  color:       String,
  quantity:    { type: Number, default: 1 },
  unitPrice:   Number,
}, { _id: false });

const schema = new mongoose.Schema({
  customer:           { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  items:              [itemSchema],
  subtotal:           Number,
  shippingCost:       { type: Number, default: 0 },
  shippingAddress:    String,
  loyaltyPointsUsed:  { type: Number, default: 0 },
  loyaltyDiscount:    { type: Number, default: 0 },
  total:              Number,
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'],
    default: 'delivered',
  },
  loyaltyPointsEarned: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Order', schema);
