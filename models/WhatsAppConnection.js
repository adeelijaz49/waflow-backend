'use strict';
// WhatsApp onboarding flow: the merchant's own WhatsApp Business connection
// (DB design 2.2). Secrets (tokenEncrypted, pinEncrypted) are select:false and
// only ever hold tokenVault v1 envelopes.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const connStep = () => ({
  status:    { type: String, enum: ['pending', 'done', 'skipped', 'failed'], default: 'pending' },
  at:        { type: Date },
  errorCode: { type: String },
});

const schema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  status: {
    type: String,
    enum: ['not_connected', 'connecting', 'waba_only', 'connected', 'needs_attention', 'reconnect_required', 'disconnected', 'error'],
    default: 'not_connected',
  },
  ids: {
    wabaId:          { type: String },
    phoneNumberId:   { type: String },
    businessId:      { type: String },
    wabaSource:      { type: String, enum: ['event', 'debug_token', null], default: null },
    onboardingEvent: { type: String },
    platformType:    { type: String },
    isOnBizApp:      { type: Boolean },
    metaUserId:      { type: String },
  },
  display: {
    displayPhoneNumber: { type: String },
    last4:              { type: String },
    verifiedName:       { type: String },
  },
  tokenEncrypted:           { type: String, select: false },
  tokenKeyVersion:          { type: String },
  tokenExpiresAt:           { type: Date, default: null },
  tokenDataAccessExpiresAt: { type: Date },
  tokenIsValid:             { type: Boolean },
  tokenCheckedAt:           { type: Date },
  pinEncrypted:             { type: String, select: false },
  registration: {
    registeredAt:  { type: Date },
    attempts:      { type: Number, default: 0 },
    lastErrorCode: { type: String },
  },
  webhook: {
    subscribed:   { type: Boolean },
    subscribedAt: { type: Date },
    checkedAt:    { type: Date },
  },
  verification: {
    businessRaw: { type: String },
    mapped:      { type: String, enum: ['done', 'waiting', 'needs_you', 'unknown'] },
    checkedAt:   { type: Date },
  },
  displayName: {
    requested:        { type: String },
    nameStatusRaw:    { type: String },
    newName:          { type: String },
    newNameStatusRaw: { type: String },
    decision:         { type: String },
    rejectionReason:  { type: String },
    mapped:           { type: String, enum: ['done', 'waiting', 'needs_you', 'unknown'] },
    checkedAt:        { type: Date },
    editsLast30d:     { type: [Date], default: undefined },
  },
  payment: {
    status:                { type: String, enum: ['unknown', 'merchant_confirmed', 'probe_positive'], default: 'unknown' },
    confirmedAt:           { type: Date },
    probeFundingIdPresent: { type: Boolean },
    checkedAt:             { type: Date },
  },
  messagingLimit: {
    raw:         { type: String },
    tierNumber:  { type: Number, default: null },
    checkedAt:   { type: Date },
    lastEventAt: { type: Date },
  },
  quality: {
    ratingRaw: { type: String },
    checkedAt: { type: Date },
  },
  health: {
    canSend:   { type: String, enum: ['AVAILABLE', 'LIMITED', 'BLOCKED', null], default: null },
    issues:    { type: [{ entityType: String, code: String, solutionKey: String, _id: false }], default: undefined },
    checkedAt: { type: Date },
  },
  needsReconnect:    { type: Boolean, default: false },
  reconnectReason:   { type: String },
  lastStatusCheckAt: { type: Date },
  nextCheckAt:       { type: Date },
  checkFailures:     { type: Number, default: 0 },
  lastError: {
    code:    { type: String },
    subcode: { type: String },
    kind:    { type: String },
    at:      { type: Date },
  },
  connectAttempt: {
    id:           { type: String },
    createdAt:    { type: Date },
    expectWabaId: { type: String },
    usedAt:       { type: Date },
    codeHash:     { type: String },
    result:       { type: Schema.Types.Mixed },
    // the phone number id the BROWSER reported in the popup: a hint only (never an id, never a claim) until the phone step verified it
    phoneHint:    { type: String },
  },
  connectLockUntil: { type: Date },
  connectSteps: {
    exchange:   connStep(),
    debugToken: connStep(),
    phone:      connStep(),
    register:   connStep(),
    subscribe:  connStep(),
    details:    connStep(),
  },
  connectedAt:          { type: Date },
  connectedByUserId:    { type: String },
  disconnectedAt:       { type: Date },
  disconnectedByUserId: { type: String },
}, { timestamps: true });

schema.index({ workspaceId: 1 }, { unique: true });
schema.index({ 'ids.wabaId': 1 });
schema.index({ 'ids.phoneNumberId': 1 });
schema.index({ nextCheckAt: 1 });

module.exports = mongoose.model('WhatsAppConnection', schema);
