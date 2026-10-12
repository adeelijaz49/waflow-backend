const mongoose = require('mongoose');
const { BUTTON_ROLES } = require('../shared/localization/metaConstraints');

// A message template with one VARIANT PER LANGUAGE (spec §3.2). Meta approves
// each language separately, so every variant carries its own body, buttons,
// Meta template name/status and its own native-review status (spec §8).
// A `bilingual` variant holds one message containing both languages.
// Standalone from the existing MessageNode/Promotion models: nothing here
// changes how existing templates are created, stored or sent.
//
// Variants are only ever written with positional updates guarded by
// `contentVersion` (shared/localization/templates.js): a save, a submit, a
// review and a status refresh can never overwrite each other's work, and a
// reviewed/approved state can never be attached to text that changed meanwhile.
// Graph's template statuses (FLAGGED is NOT one: it is a webhook event, kept in metaFlagged) plus our own
// NOT_CREATED (never submitted at this content) and ERROR (a status Graph reported that we do not know —
// the text goes to metaStatusRaw; an unknown value must never make a save throw and stop the poller).
const META_STATUSES = ['NOT_CREATED', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL',
  'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED', 'ARCHIVED', 'ERROR'];

const buttonSchema = new mongoose.Schema({
  role: { type: String, enum: BUTTON_ROLES, required: true },
  text: { type: String, default: '' },         // an empty label is a savable draft; validation blocks submitting it
  url:  { type: String },                      // role 'url' only: a static https link
}, { _id: false });

const variantSchema = new mongoose.Schema({
  language: { type: String, enum: ['en', 'ar', 'bilingual'], required: true },
  bilingualOrder: { type: String, enum: ['ar_first', 'en_first'] }, // bilingual variants only
  header:  { type: String },
  body:    { type: String, default: '' },
  footer:  { type: String },
  buttons: { type: [buttonSchema], default: [] },
  contentVersion: { type: Number, default: 1 }, // +1 on every change to header/body/footer/buttons/bilingualOrder

  // ── Meta submission / approval ──
  metaTemplateName: { type: String },          // unique per variant AND revision, see shared/localization/templates.js
  metaTemplateId:   { type: String },
  metaLanguage:     { type: String },          // code sent to Meta: 'ar' | 'en'
  metaStatus:       { type: String, enum: META_STATUSES, default: 'NOT_CREATED' },
  metaStatusRaw:    { type: String },          // the status text exactly as Graph reported it
  metaFlagged:      { type: Boolean, default: false }, // a "flagged" event was seen (webhook); never a status
  metaCategory:     { type: String },          // category Meta reports for the submitted template (it may reclassify)
  metaPreviousCategory: { type: String },      // set when Meta re-classified (e.g. UTILITY -> MARKETING)
  metaQualityScore: { type: String },          // GREEN | YELLOW | RED | UNKNOWN
  rejectedContent:  { type: [String], default: undefined }, // hashes of text Meta rejected: never resubmitted unchanged
  metaRejectedReason: { type: String },
  metaLastCheckedAt:  { type: Date },
  submittedAt:        { type: Date },
  submissionCount:    { type: Number, default: 0 }, // submission ATTEMPTS: every attempt burns a revision (and a Meta name)
  submittingAt:       { type: Date },           // set while a submission is in flight; stale after a couple of minutes
  lastError:          { type: String },

  // ── Native-review workflow (spec §8): machine/AI text is ALWAYS saved as draft ──
  reviewStatus: { type: String, enum: ['draft', 'reviewed'], default: 'draft' },
  reviewedBy:   { type: String },               // reviewer's display name
  reviewedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt:   { type: Date },
  source:       { type: String, enum: ['merchant', 'library', 'ai', 'import'], default: 'merchant' },
}, { timestamps: true });

const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  key:         { type: String, required: true },   // slug, unique per workspace
  name:        { type: String, required: true },
  useCase: {
    type: String,
    enum: ['comeback', 'loyalty_reminder', 'points_balance', 'points_expiring', 'payment_reminder', 'booking_confirmation',
      'booking_reminder', 'order_confirmation', 'referral_invite', 'referral_reward', 'welcome_optin', 'promotion', 'greeting', 'custom'],
    default: 'custom',
  },
  // The REQUESTED category. UTILITY is only honoured for the transactional use cases (payment_reminder,
  // booking_confirmation, booking_reminder, order_confirmation): the service stores MARKETING for every other
  // use case and the planner/sender floor the effective category the same way (shared/localization/category.js),
  // so a raw UTILITY here never bypasses marketing consent. What Meta reports lives in variants[].metaCategory.
  category: { type: String, enum: ['MARKETING', 'UTILITY'], default: 'MARKETING' },
  variants: { type: [variantSchema], default: [] },
  // Optional link to an existing Automated Flows MessageNode: lets merchants
  // author and track Arabic variants of a flow message (Phase 2) without
  // touching models/MessageNode.js.
  linkedMessageNodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageNode' },
  // Optional link to an existing Promotion (no custom entry message needed): the Arabic version that
  // shared/operations.js#sendPromotion sends to Arabic customers of that promotion (legacySenders.js).
  // Enables the `shop_now` button role (payload promo_<promotionId>). Deliberately NOT indexed: the collection already exists in
  // production (first build), so no new index is created on it; lookups use the workspaceId index (a workspace has few templates).
  linkedPromotionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Promotion' },
  archived:  { type: Boolean, default: false },       // never hard-deleted
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

schema.index({ workspaceId: 1, key: 1 }, { unique: true });
schema.index({ workspaceId: 1, linkedMessageNodeId: 1 });

module.exports = mongoose.model('LocalizedTemplate', schema);
module.exports.META_STATUSES = META_STATUSES;
