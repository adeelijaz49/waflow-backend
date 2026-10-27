const mongoose = require('mongoose');

// A merchant-configured message + up to 3 CTA buttons, optionally branching to
// further MessageNodes on tap. ownerType was originally kept generic for a
// possible future Promotions retrofit — that retrofit has since landed
// (DEFECT-02: message/button editing is available directly in Promotions too,
// via Promotion.entryNodeId — see shared/operations.js#sendPromotion).
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
  // opt_in / opt_out / interested are the consent actions (entry nodes only, see shared/promoConsentTap.js); end_flow is
  // what the screen shows as "None".
  type: { type: String, enum: ['send_message', 'end_flow', 'apply_discount', 'redeem_points', 'opt_in', 'opt_out', 'interested'], required: true },
  targetNodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageNode' }, // only for send_message
  replyText: { type: String, maxlength: 1000 }, // optional confirmation sent after the tap (consent actions)
}, { _id: false });

// maxlength 25 is the template quick-reply limit (entry nodes). Follow-up nodes are sent as interactive reply buttons
// (limit 20): that stricter limit is enforced in shared/operations.js#validateButtons, which knows which node it is.
const buttonSchema = new mongoose.Schema({
  position: { type: Number, required: true, min: 0, max: 2 },
  label:    { type: String, required: true, maxlength: 25 },
  nextAction: { type: nextActionSchema, required: true },
}, { _id: false });

// Exactly what was submitted to Meta for the current template version. A consent record must quote the words the
// customer saw, not whatever the merchant has typed into the editor since.
const snapshotButtonSchema = new mongoose.Schema({
  position:  Number,
  label:     String,
  action:    String,
  replyText: String,
}, { _id: false });
const templateSnapshotSchema = new mongoose.Schema({
  bodyText: String,
  footer:   String,
  language: String,
  buttons:  [snapshotButtonSchema],
}, { _id: false });

const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true },
  ownerType: { type: String, enum: ['flow', 'promotion'], required: true },
  ownerId:   { type: mongoose.Schema.Types.ObjectId, required: true },
  isEntryNode: { type: Boolean, default: false },
  bodyText:  { type: String, required: true }, // stores literal {{1}}/{{2}} tokens, same format the existing hardcoded flow bodies use
  templateName:   String, // set once a dynamically-generated template is submitted — only meaningful for entry nodes
  templateStatus: { type: String, enum: ['not_created', 'pending', 'approved', 'rejected'], default: 'not_created' },
  // Template lifecycle (all optional, written by shared/operations.js and shared/templateApproval.js).
  templateVersion:        Number,
  templateSubmittedAt:    Date,
  templateApprovedAt:     Date,
  templateRejectedReason: String,
  templateCategory:       String,
  templateLastCheckedAt:  Date,
  templateWabaId:         String, // the WhatsApp Business Account the template was submitted to
  templateSnapshot:       { type: templateSnapshotSchema },
  depth: { type: Number, default: 0, max: 3 },
  buttons: {
    type: [buttonSchema],
    validate: { validator: (v) => v.length <= 3, message: 'A message can have at most 3 buttons.' },
  },
}, { timestamps: true });

schema.index({ ownerType: 1, ownerId: 1 });

module.exports = mongoose.model('MessageNode', schema);
