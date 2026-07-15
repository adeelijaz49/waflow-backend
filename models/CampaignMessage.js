const mongoose = require('mongoose');

// One document per outbound WhatsApp message tied to a promotion, loyalty
// reminder, or booking notification. Written at send time (status:'sent'),
// updated by the webhook's status callbacks (delivered/read/failed) and by
// inbound button-tap correlation (clickedAt), then backfilled with the
// resulting order once one is attributed — this is what campaign reporting
// (sent/delivered/clicked/ordered/revenue) and customer WhatsApp history
// are both built from.
const schema = new mongoose.Schema({
  kind:         { type: String, enum: ['promotion', 'booking_notification', 'loyalty_reminder'], required: true, default: 'promotion' },
  promotion:    { type: mongoose.Schema.Types.ObjectId, ref: 'Promotion' },
  booking:      { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  customer:     { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  phone:        { type: String, required: true }, // denormalized — survives customer deletion, matches webhook `from`
  wamid:        { type: String }, // WhatsApp message id from the send response — join key for status/click correlation
  messageType:  { type: String, enum: ['interactive', 'template', 'text'] },
  templateName: String,
  status:       { type: String, enum: ['queued', 'sent', 'delivered', 'read', 'failed'], default: 'queued' },
  statusReason: String,
  sentAt:       Date,
  deliveredAt:  Date,
  readAt:       Date,
  clickedAt:    Date,
  order:        { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  revenue:      { type: Number, default: 0 },
  pointsIssued: { type: Number, default: 0 },
}, { timestamps: true });

schema.index({ promotion: 1, customer: 1 });
schema.index({ customer: 1, createdAt: -1 });
schema.index({ wamid: 1 }, { unique: true, sparse: true });
schema.index({ status: 1 });

module.exports = mongoose.model('CampaignMessage', schema);
