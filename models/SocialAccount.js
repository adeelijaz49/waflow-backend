const mongoose = require('mongoose');

// A connected Instagram Professional account for a workspace. Tokens are
// encrypted at rest (see shared/socialTokenCrypto.js) — never store or log
// the plaintext access token. One workspace can only have one 'connected'
// Instagram account at a time for MVP (multi-account support is future work).
const schema = new mongoose.Schema({
  workspaceId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  provider:           { type: String, enum: ['instagram'], default: 'instagram' },
  providerAccountId:  { type: String }, // Instagram user id (graph.instagram.com /me)
  accountName:        { type: String },
  accountHandle:      { type: String },
  accessTokenEncrypted:  { type: String },
  refreshTokenEncrypted: { type: String },
  scopes:             [String],
  tokenExpiresAt:     { type: Date },
  status: {
    type: String,
    enum: ['not_connected', 'connected', 'permission_missing', 'token_expired', 'account_not_eligible', 'reconnect_required', 'error'],
    default: 'not_connected',
  },
  lastError:          { type: String },
  connectedByUserId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

schema.index({ workspaceId: 1, provider: 1 }, { unique: true });

module.exports = mongoose.model('SocialAccount', schema);
