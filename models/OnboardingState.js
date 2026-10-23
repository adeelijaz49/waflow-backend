'use strict';
// WhatsApp onboarding flow: one sidecar document per ENROLLED workspace.
// Absence of a document = legacy workspace = never gated (DB design 2.1).
// Enum values are only validated on write; unknown values read back unchanged
// (Meta/Stripe values change over time).
const mongoose = require('mongoose');
const { Schema } = mongoose;

const stepSchema = () => ({
  status:      { type: String, enum: ['todo', 'in_progress', 'done', 'skipped'], default: 'todo' },
  enteredAt:   { type: Date },
  completedAt: { type: Date },
  attempts:    { type: Number, default: 0 },
});

const promptSchema = () => ({
  state:     { type: String, enum: ['pending', 'done', 'skipped'], default: 'pending' },
  updatedAt: { type: Date },
});

const schema = new Schema({
  workspaceId:   { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  enrolled:      { type: Boolean, default: true },
  enrolledAt:    { type: Date },
  enrolledVia:   { type: String, enum: ['auto_signup', 'admin'] },
  enrolledBy:    { type: String },
  unenrolledAt:  { type: Date },
  unenrolledBy:  { type: String },
  r1Applied:     { type: Boolean, default: false },
  schemaVersion: { type: Number, default: 1 },

  subscription: {
    state:  { type: String, enum: ['none', 'pending', 'active', 'past_due', 'cancelled'], default: 'none' },
    source: { type: String, enum: ['stripe', 'admin', null], default: null },
    stripe: {
      customerId:              { type: String },
      subscriptionId:          { type: String },
      status:                  { type: String },
      priceId:                 { type: String },
      planCode:                { type: String },
      currentPeriodEnd:        { type: Date },
      cancelAtPeriodEnd:       { type: Boolean },
      lastEventId:             { type: String },
      lastEventCreated:        { type: Number },
      lastSyncedAt:            { type: Date },
      checkoutSessionId:       { type: String },
      checkoutStartedAt:       { type: Date },
      lastPaymentFailedAt:     { type: Date },
      lastPaymentFailureCode:  { type: String },
      hasDefaultPaymentMethod: { type: Boolean },
    },
    admin: {
      active: { type: Boolean, default: false },
      by:     { type: String },
      at:     { type: Date },
      notes:  { type: String },
    },
    activatedAt: { type: Date },
    pastDueAt:   { type: Date },
    cancelledAt: { type: Date },
    changedAt:   { type: Date },
  },
  prefill: {
    businessName: { type: String },
    email:        { type: String },
    planCode:     { type: String },
    source:       { type: String, enum: ['stripe_checkout', 'admin'] },
    capturedAt:   { type: Date },
  },

  progress: {
    currentStep:    { type: Number, default: 1 },
    furthestStep:   { type: Number, default: 1 },
    startedAt:      { type: Date },
    lastActivityAt: { type: Date },
    completedAt:    { type: Date },
    status:         { type: String, enum: ['in_progress', 'paused_number', 'waiting_meta', 'completed'], default: 'in_progress' },
  },
  steps: {
    business:  stepSchema(),
    number:    stepSchema(),
    connect:   stepSchema(),
    approvals: stepSchema(),
    promotion: stepSchema(),
  },

  business: {
    name:                { type: String },
    country:             { type: String, default: 'SA' },
    industry:            { type: String },
    website:             { type: String },
    instagram:           { type: String },
    crNumber:            { type: String },
    crSkipped:           { type: Boolean },
    crSkippedAt:         { type: Date },
    verificationNeedsCr: { type: Boolean },
    contactEmail:        { type: String },
    // true when the OWNER (live Membership read) typed the contact e-mail: only such an address is ever used for notification mail (review R2-09)
    contactEmailByOwner: { type: Boolean },
    uiLanguage:          { type: String, enum: ['en', 'ar'], default: 'en' },
    languages:           { type: [String], default: undefined },
  },
  number: {
    path:                        { type: String, enum: ['A', 'B', null], default: null },
    hasNumber:                   { type: Boolean },
    usage:                       { type: String, enum: ['unused', 'personal', 'business_app', 'landline', null], default: null },
    usageAnsweredAt:             { type: Date },
    personalWarningAcknowledged: { type: Boolean, default: false },
    businessAppChoice:           { type: String, enum: ['coexistence', 'migrate', 'different_number', null], default: null },
    numberReady:                 { type: Boolean, default: false },
    pausedAt:                    { type: Date },
    reminderCount:               { type: Number, default: 0 },
    lastReminderAt:              { type: Date },
    helpRequestedAt:             { type: Date },
    helpRequestId:               { type: String },
  },
  prompts: {
    customers:  promptSchema(),
    products:   promptSchema(),
    promptedAt: { type: Date },
  },
  firstPromotion: {
    state:            { type: String, enum: ['locked', 'ready', 'started', 'done', 'skipped'], default: 'locked' },
    suggestedKey:     { type: String },
    testMessageCount: { type: Number, default: 0 },
    lastTestAt:       { type: Date },
    testPhoneMasked:  { type: String },
    // the workspace's ONE typed test number (an owner who logs in without a phone): masked + last 4 + an HMAC keyed with a server secret, never the digits
    testNumberMasked: { type: String },
    testNumberLast4:  { type: String },
    testNumberHash:   { type: String },
    testNumberSetAt:  { type: Date },
    testNumberSetBy:  { type: String },
    startedAt:        { type: Date },
    doneAt:           { type: Date },
  },
  lastError: {
    code: { type: String },
    step: { type: String },
    at:   { type: Date },
  },
  ui: {
    seenNotificationsAt: { type: Date },
  },
}, { timestamps: true });

schema.index({ workspaceId: 1 }, { unique: true });
schema.index({ 'subscription.stripe.subscriptionId': 1 });
schema.index({ 'subscription.stripe.customerId': 1 });
schema.index({ 'progress.status': 1 });

module.exports = mongoose.model('OnboardingState', schema);
