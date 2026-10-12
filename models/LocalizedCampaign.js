const mongoose = require('mongoose');

// A campaign sent with the localisation engine (shared/localization/campaigns.js):
// one LocalizedTemplate, a language mode, and an audience. Standalone from the
// existing Promotion/CampaignMessage models — the existing campaign builder and
// its reporting are untouched. Never hard-deleted: cancel is a status change.
//
// Crash recovery (shared/localization/campaignSender.js): the background sender
// stamps `lastHeartbeatAt` as it works; a `sending` campaign whose heartbeat
// goes stale is taken over by exactly one resumer (compare-and-set on the old
// heartbeat) and `claimedBy` identifies the live runner, so a runner that lost
// its campaign (cancelled, taken over) notices and stops.
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  name:        { type: String, required: true },
  templateId:  { type: mongoose.Schema.Types.ObjectId, ref: 'LocalizedTemplate', required: true },
  templateName: { type: String }, // snapshot at creation — history keeps the name the campaign was sent under
  // per_customer: each customer gets their own language (default);
  // en | ar: one language for everyone (never falls back silently);
  // bilingual: the one-message-both-languages variant.
  languageMode: { type: String, enum: ['per_customer', 'en', 'ar', 'bilingual'], default: 'per_customer' },
  audience: {
    kind:        { type: String, enum: ['all_eligible', 'customer_ids', 'segment'], default: 'all_eligible' },
    customerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Customer' }],
    segmentKey:  { type: String },
    segmentParams: { type: mongoose.Schema.Types.Mixed },
  },
  // Values for merge fields that are the same for every recipient (e.g. {discount}, {date}).
  // Per-customer fields ({name}, {points}) are filled from the customer record at send time.
  fieldValues: { type: mongoose.Schema.Types.Mixed },
  // The EFFECTIVE category (Meta's report + the UTILITY floor: only transactional use cases are
  // ever UTILITY) as of the moment the send was started. The consent gate follows this snapshot
  // (never loosened by a later template edit).
  category: { type: String, enum: ['MARKETING', 'UTILITY'] },
  status: { type: String, enum: ['draft', 'sending', 'sent', 'partial', 'failed', 'cancelled'], default: 'draft', index: true },
  // Snapshot of the preview numbers (without recipient names) at creation / send time.
  plan: { type: mongoose.Schema.Types.Mixed },
  stats: {
    total:   { type: Number, default: 0 },
    sent:    { type: Number, default: 0 },
    failed:  { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    byLanguage: {
      en:        { type: Number, default: 0 },
      ar:        { type: Number, default: 0 },
      bilingual: { type: Number, default: 0 },
    },
  },
  startedAt:  { type: Date },
  finishedAt: { type: Date },
  lastError:  { type: String },
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // ── background sender bookkeeping ──
  claimedAt:       { type: Date },
  claimedBy:       { type: String },  // id of the runner that currently owns the send
  lastHeartbeatAt: { type: Date },
  snapshotAt:      { type: Date },    // recipient rows fully written (LocalizedSend)
  runAttempts:     { type: Number, default: 0 }, // claims/resumes so far — a campaign that keeps dying is failed, not retried forever
}, { timestamps: true });

schema.index({ workspaceId: 1, createdAt: -1 });
schema.index({ status: 1, lastHeartbeatAt: 1 }); // resumeStuckCampaigns
schema.index({ finishedAt: -1 }); // overview "last sent" (Cosmos DB rejects a sort on a field with no index of its own)

module.exports = mongoose.model('LocalizedCampaign', schema);
