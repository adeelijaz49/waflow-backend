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
  // What originated this order, and its live Stripe payment state.
  source:                { type: String, enum: ['campaign', 'manual', 'booking', 'product'], default: 'product' },
  promotion:              { type: mongoose.Schema.Types.ObjectId, ref: 'Promotion' },
  campaignMessage:        { type: mongoose.Schema.Types.ObjectId, ref: 'CampaignMessage' },
  stripePaymentIntentId:  String,
  paymentStatus:          { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
  paidAt:                 Date,
}, { timestamps: true });

module.exports = mongoose.model('Order', schema);
