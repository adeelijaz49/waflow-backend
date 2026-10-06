const mongoose = require('mongoose');

// One row per trackable link — currently always generated for exactly one
// InstagramPost (one link per post, matching "every Instagram post must
// generate a unique WaFlow tracking link"). `code` is the only thing that
// appears in the URL — random, never a phone number or name, same
// convention as models/ReferralCode.js.
const schema = new mongoose.Schema({
  workspaceId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  instagramPostId: { type: mongoose.Schema.Types.ObjectId, ref: 'InstagramPost', required: true, unique: true },
  source: { type: String, default: 'instagram' },
  medium: { type: String, default: 'social' },
  content: { type: String }, // free-text content identifier (e.g. post name) for reporting
  code:     { type: String, required: true, unique: true },
  shortUrl: { type: String, required: true }, // {APP_URL}/t/{code}
  destinationUrl: { type: String }, // resolved wa.me link, cached for display
  clicks:       { type: Number, default: 0 },
  uniqueClicks: { type: Number, default: 0 },
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model('TrackingLink', schema);
