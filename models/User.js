const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  // Digits-only, matching Customer.phone's existing storage convention.
  phone: { type: String, unique: true, sparse: true },
  email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  name:  { type: String },
}, { timestamps: true });

schema.pre('validate', function () {
  if (!this.phone && !this.email) throw new Error('A user needs at least a phone or an email');
});

module.exports = mongoose.model('User', schema);
