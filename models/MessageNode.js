const mongoose = require('mongoose');

// A merchant-configured message + up to 3 CTA buttons, optionally branching to
// further MessageNodes on tap. ownerType is kept generic for a possible future
// Promotions retrofit, but v1 only ever creates ownerType:'flow' nodes — no
// abstraction beyond the field exists yet.
//
// requiresTemplate/delayMinutes from the original spec are deliberately not
// modeled here: whether a node needs a template is always exactly isEntryNode
// (computed, not stored — see utils/flowTriggers/*), and there's no delayed-send
// mechanism in this codebase, so every follow-up sends synchronously inside the
// webhook handler that resolves the tap.
// nextAction is declared as its own explicit Schema (not a plain nested object
// literal) — a nested object whose own key is literally named "type" is a
// well-known Mongoose gotcha: Mongoose reads that inner `type` key as the
// SchemaType definition for the whole field and silently drops any sibling
// keys (targetNodeId here). Passing an explicit Schema instance as the `type`
// value sidesteps the ambiguity entirely.
const nextActionSchema = new mongoose.Schema({
  type: { type: String, enum: ['send_message', 'end_flow', 'apply_discount', 'redeem_points'], required: true },
  targetNodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageNode' }, // only for send_message
}, { _id: false });

const buttonSchema = new mongoose.Schema({
  position: { type: Number, required: true, min: 0, max: 2 },
  label:    { type: String, required: true, maxlength: 20 },
  nextAction: { type: nextActionSchema, required: true },
}, { _id: false });

const schema = new mongoose.Schema({
  ownerType: { type: String, enum: ['flow'], required: true },
  ownerId:   { type: mongoose.Schema.Types.ObjectId, required: true },
  isEntryNode: { type: Boolean, default: false },
  bodyText:  { type: String, required: true }, // stores literal {{1}}/{{2}} tokens, same format the existing hardcoded flow bodies use
  templateName:   String, // set once a dynamically-generated template is submitted — only meaningful for entry nodes
  templateStatus: { type: String, enum: ['not_created', 'pending', 'approved', 'rejected'], default: 'not_created' },
  depth: { type: Number, default: 0, max: 3 },
  buttons: {
    type: [buttonSchema],
    validate: { validator: (v) => v.length <= 3, message: 'A message can have at most 3 buttons.' },
  },
}, { timestamps: true });

schema.index({ ownerType: 1, ownerId: 1 });

module.exports = mongoose.model('MessageNode', schema);
