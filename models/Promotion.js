const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  workspaceId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true },
  name:            { type: String, required: true },
  description:     { type: String },
  customerType:    { type: String, enum: ['cash', 'points'], default: 'cash' },
  scope:           { type: String, enum: ['products', 'services'], default: 'products' },
  type:            { type: String, enum: ['specific_products', 'store_wide', 'specific_services'], default: 'specific_products' },
  // Which guided path the merchant used to create this — drives suggested defaults/copy in the UI, not read elsewhere.
  campaignType:    { type: String, enum: ['product_promotion', 'service_booking_campaign', 'loyalty_reminder', 'inactive_customer_comeback', 'store_wide_offer'] },
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
}, { timestamps: true });

module.exports = mongoose.model('Promotion', schema);
