const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  workspaceId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
  invitedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contactType:     { type: String, enum: ['phone', 'email'], required: true },
  contact:         { type: String, required: true }, // normalized phone (digits) or lowercased email
  role:            { type: String, enum: ['owner', 'member'], default: 'member' },
  status:          { type: String, enum: ['pending', 'accepted', 'revoked'], default: 'pending' },
  expiresAt:       { type: Date, required: true },
}, { timestamps: true });

schema.index({ contact: 1, status: 1 });
schema.index({ workspaceId: 1, status: 1 });

module.exports = mongoose.model('Invite', schema);
