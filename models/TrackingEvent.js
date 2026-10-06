const mongoose = require('mongoose');

// Append-only attribution ledger — one row per meaningful step a person
// takes after following a tracking link, from the first click through to a
// completed payment. This is what reporting (shared/instagram.js#getPostReport)
// and the "Instagram-acquired customer" badge in the Inbox/Customer surfaces
// (not yet wired — see feature summary) are both meant to read from.
const schema = new mongoose.Schema({
  trackingLinkId:  { type: mongoose.Schema.Types.ObjectId, ref: 'TrackingLink', required: true, index: true },
  workspaceId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  instagramPostId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstagramPost', required: true, index: true },
  eventType: {
    type: String,
    enum: ['click', 'whatsapp_started', 'customer_created', 'order_created', 'booking_created', 'payment_completed', 'loyalty_joined'],
    required: true,
  },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  orderId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  bookingId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  metadata:   { type: mongoose.Schema.Types.Mixed },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ instagramPostId: 1, eventType: 1 });

module.exports = mongoose.model('TrackingEvent', schema);
