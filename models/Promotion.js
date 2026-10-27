const mongoose = require('mongoose');

// Both of these are single nested sub-schemas on purpose (not plain nested objects): a nested path holding an array
// would write an empty `customerIds: []` into every promotion ever created, and "has a sendRequest" would then be
// true for all of them. As sub-schemas they stay undefined until something sets them.
const consentWordingAckSchema = new mongoose.Schema({
  at:       Date,
  by:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  textHash: String, // hash of the consent wording the merchant acknowledged
}, { _id: false });

// "The merchant asked to send this promotion while its custom message was not approved by Meta yet": remembered so the
// screen can say "approved, you can now send the messages you intended" (see shared/templateApproval.js).
const sendRequestSchema = new mongoose.Schema({
  customerIds: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Customer' }],
    validate: { validator: (v) => !v || v.length <= 2000, message: 'A send request can hold at most 2000 customers.' },
  },
  requestedAt:      Date,
  requestedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedNoticeAt: Date, // set when the template was approved while this request was open
  dismissedAt:      Date,
}, { _id: false });

const schema = new mongoose.Schema({
  workspaceId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true },
  name:            { type: String, required: true },
  description:     { type: String },
  customerType:    { type: String, enum: ['cash', 'points'], default: 'cash' },
  scope:           { type: String, enum: ['products', 'services'], default: 'products' },
  type:            { type: String, enum: ['specific_products', 'store_wide', 'specific_services'], default: 'specific_products' },
  // Which guided path the merchant used to create this — drives suggested defaults/copy in the UI, not read elsewhere.
  campaignType:    { type: String, enum: ['product_promotion', 'service_booking_campaign', 'loyalty_reminder', 'inactive_customer_comeback', 'store_wide_offer', 'consent_request'] },
  // What the promotion is for. 'consent_request' = "ask customers to opt in": the audience is customers who have NOT
  // opted in (instead of only those who have) and its quick-reply buttons carry opt-in/opt-out actions. Existing
  // documents read as 'standard' via the default.
  purpose:         { type: String, enum: ['standard', 'consent_request'], default: 'standard' },
  consentWordingAck: { type: consentWordingAckSchema },
  sendRequest:     { type: sendRequestSchema },
  products:        [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  services:        [{ type: mongoose.Schema.Types.ObjectId, ref: 'Service' }],
  categories:      [String],
  discountPercent: { type: Number, min: 0, max: 100, default: 0 },
  pointsPrice:     { type: Number, default: 0 }, // points required per product for redemption
  startDate:       Date,
  endDate:         Date,
  status:          { type: String, enum: ['draft', 'active', 'expired'], default: 'draft' },
  sentAt:          Date,
  sentCount:       { type: Number, default: 0 },
  isDemo:          { type: Boolean, default: false }, // flags seeded demo promotions (see seed/seed-demo.js)
  // Optional merchant-authored entry message (see models/MessageNode.js), same
  // pattern as Flow.entryNodeId (DEFECT-02) — additive: unset means the fixed
  // built-in announcement/template is sent exactly as before. When set (and
  // its MessageNode.templateStatus is 'approved'), that custom template is
  // sent instead, and its buttons can branch to further MessageNodes.
  entryNodeId:     { type: mongoose.Schema.Types.ObjectId, ref: 'MessageNode' },
  // Additive, isolated feature (see shared/promotionCarousel.js + utils/whatsappCarousel.js) —
  // completely separate send path from the default. Existing documents have no
  // value for this field; Mongoose applies the schema default on hydrate, so
  // every promotion that existed before this field was added reads as
  // 'separate' automatically — no migration needed.
  sendFormat:      { type: String, enum: ['separate', 'carousel'], default: 'separate' },
}, { timestamps: true });

module.exports = mongoose.model('Promotion', schema);
