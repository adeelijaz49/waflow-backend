const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  workspaceId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message:      { type: String, required: true },
  contactEmail: { type: String, required: true },
  // Kept true regardless of send outcome — the ticket itself is the source of
  // truth (never lost even if the email fails), matching Invite's sendWarning
  // pattern in routes/workspaces.js.
  emailSent:    { type: Boolean, default: false },
}, { timestamps: true });

schema.index({ workspaceId: 1, createdAt: -1 });

module.exports = mongoose.model('SupportTicket', schema);
