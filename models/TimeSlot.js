const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  serviceId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  date:        { type: String, required: true }, // "YYYY-MM-DD"
  startTime:   { type: String, required: true }, // "09:00"
  endTime:     { type: String, required: true }, // "10:00"
  capacity:    { type: Number, default: 1 },
  bookedCount: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('TimeSlot', schema);
