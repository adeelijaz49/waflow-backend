'use strict';
// Append-only audit trail of WaFlow super-admin actions (shared/platformAdmin.js identities) on customers (tenants):
// who created one, entered it, renamed it, added a member, changed its WhatsApp number, and every change made while inside it
// (act_as_write: method + path, never the body). Modelled on
// LocalizationAdminLog, but with a named actor. Rows are only ever created: the hooks below refuse every update and delete,
// so the trail cannot be edited through this model. `detail` is small and never holds a secret (no tokens, no full contacts).
const mongoose = require('mongoose');

const ACTIONS = ['create_tenant', 'enter', 'exit', 'rename', 'add_member', 'set_whatsapp', 'clear_whatsapp', 'verify_whatsapp', 'act_as_write'];

const schema = new mongoose.Schema({
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  actorLabel:  { type: String, default: '' }, // masked contact (a***@d***.com / ******1234), never the full one
  action:      { type: String, enum: ACTIONS, required: true },
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace' },
  ip:          { type: String }, // behind Azure's front end this is the front end itself - see forwardedFor
  forwardedFor: { type: String }, // the X-Forwarded-For header as received (capped): the real client address is its LAST entry
  userAgent:   { type: String },
  detail:      { type: mongoose.Schema.Types.Mixed },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ workspaceId: 1, createdAt: -1 });
schema.index({ createdAt: -1 }); // Cosmos DB wants an index on the sort field itself (as AdminAuditLog has)
schema.index({ actorUserId: 1, createdAt: -1 });

function refuse() {
  throw new Error('PlatformAuditLog is append-only');
}
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  schema.pre(op, refuse);
}
schema.pre('save', function () {
  if (!this.isNew) refuse();
});
schema.pre('deleteOne', { document: true, query: false }, refuse);

const Model = require('../utils/indexWatch')(mongoose.model('PlatformAuditLog', schema)); // a failed index build is logged, not silent
Model.ACTIONS = ACTIONS;

module.exports = Model;
