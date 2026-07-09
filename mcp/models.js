const mongoose = require('mongoose');

// Dynamically-registered OAuth clients (RFC 7591). Public clients only — no secret,
// PKCE (S256) is required at the authorize step instead.
const oauthClientSchema = new mongoose.Schema({
  clientId:     { type: String, required: true, unique: true },
  clientName:   String,
  redirectUris: { type: [String], required: true },
}, { timestamps: true });

// Refresh tokens are stored hashed (never the raw token) so a DB read alone
// can't be replayed as a live credential.
const oauthRefreshTokenSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  clientId:  { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
oauthRefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = {
  OAuthClient:       mongoose.models.OAuthClient       || mongoose.model('OAuthClient', oauthClientSchema),
  OAuthRefreshToken: mongoose.models.OAuthRefreshToken || mongoose.model('OAuthRefreshToken', oauthRefreshTokenSchema),
};
