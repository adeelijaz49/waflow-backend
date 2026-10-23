'use strict';
// Cross-tenant uniqueness of a WABA / phone number without any new unique
// index: the string _id ('waba:<id>' | 'phone:<id>') is always unique (DB design 2.7).
// Release = set releasedAt; rows are never deleted.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const schema = new Schema({
  _id:         { type: String },
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  claimedAt:   { type: Date },
  releasedAt:  { type: Date, default: null },
});

module.exports = mongoose.model('WhatsAppClaim', schema);
