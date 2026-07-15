const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  serviceId:            { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  slotId:               { type: mongoose.Schema.Types.ObjectId, ref: 'TimeSlot', required: true },
  customerId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  phone:                { type: String, required: true },
  customerName:         String,
  status:               { type: String, enum: ['requested', 'confirmed', 'cancelled', 'rescheduled', 'completed', 'no-show'], default: 'confirmed' },
  paymentType:          { type: String, enum: ['cash', 'points', 'free', 'pay_later'], default: 'cash' },
  amount:               { type: Number, default: 0 },
  pointsUsed:           { type: Number, default: 0 },
  stripePaymentIntentId: String,
  notes:                String,
}, { timestamps: true });

module.exports = mongoose.model('Booking', schema);
