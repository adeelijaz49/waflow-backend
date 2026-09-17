const mongoose = require('mongoose');

// One document per real WhatsApp message the merchant sees in the WhatsApp
// Inbox — inbound customer messages, and outbound messages sent manually
// from the inbox composer (including generated payment links). Campaign/
// loyalty/booking-notification sends are NOT duplicated in here — those
// already have a record in CampaignMessage, and the Inbox conversation
// thread (see shared/inbox.js#getThread) merges that collection in at read
// time instead of writing a second copy of the same send.
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true },
  customer:    { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
  phone:       { type: String, required: true }, // denormalized — survives customer deletion, matches CampaignMessage.phone precedent
  direction:   { type: String, enum: ['inbound', 'outbound'], required: true },
  // 'manual' covers both a customer's free-form reply and a staff-typed
  // outbound message — the other values exist so a future send path (or a
  // richer quick action) can tag its own WhatsAppMessage rows distinctly
  // without a schema change.
  messageType: { type: String, enum: ['manual', 'campaign', 'order', 'payment', 'loyalty', 'booking', 'system'], default: 'manual' },
  messageBody: { type: String },
  mediaUrl:    { type: String },
  wamid:       { type: String }, // WhatsApp message id — join key for delivery/read status callbacks
  campaign:    { type: mongoose.Schema.Types.ObjectId, ref: 'CampaignMessage' },
  order:       { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  booking:     { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  deliveryStatus: { type: String, enum: ['queued', 'sent', 'delivered', 'read', 'failed'], default: 'sent' },
  statusReason: String,
  sentAt:      { type: Date },
  receivedAt:  { type: Date },
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // staff member who sent a manual message; null for inbound
}, { timestamps: true });

schema.index({ workspaceId: 1, customer: 1, createdAt: -1 });
schema.index({ wamid: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('WhatsAppMessage', schema);
