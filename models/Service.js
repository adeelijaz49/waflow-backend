const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true },
  name:        { type: String, required: true },
  description: String,
  category:    String,
  duration:    { type: Number, default: 60 }, // minutes
  basePrice:   { type: Number, default: 0 },
  pointsPrice: { type: Number, default: 0 },
  images:      [String],
  active:      { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Service', schema);
