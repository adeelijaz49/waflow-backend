const mongoose = require('mongoose');

const variantSchema = new mongoose.Schema({
  size:  { type: String, required: true },
  color: { type: String, required: true },
  stock: { type: Number, default: 0 },
  sku:   { type: String },
}, { _id: false });

const schema = new mongoose.Schema({
  // Optional for backward compatibility with pre-multi-tenant data and with
  // MCP/GPT Actions callers that don't pass a workspace — see shared/operations.js.
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true },
  name:        { type: String, required: true },
  description: { type: String },
  category:    { type: String, required: true },
  basePrice:   { type: Number, required: true },
  variants:    [variantSchema],
  images:      [String],
  active:      { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Product', schema);
