const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
  role:        { type: String, enum: ['owner', 'member'], required: true },
}, { timestamps: true });

schema.index({ userId: 1, workspaceId: 1 }, { unique: true });

module.exports = mongoose.model('Membership', schema);
