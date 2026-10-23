'use strict';
// Shared setup for the B1-e integration suites (NOT a test file: no *.itest.js suffix).
// Real models on the throwaway mongod; Meta Graph is the fakeGraph fixture behind the REAL
// metaClient (B1-c); the merchant token is stored through the REAL tokenVault.
const { assertThrowawayDb } = require('./_guard');

function useDatabase(suffix) {
  assertThrowawayDb();
  process.env.MONGODB_URI = `${process.env.MONGODB_URI}_${suffix}`; // each suite owns its database
  assertThrowawayDb();
  process.env.ONBOARDING_FLOW = 'on';
  process.env.WA_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32); // dummy 64-hex key, test only
  delete process.env.ONBOARDING_TEMPLATE_CEILING;
  delete process.env.ONBOARDING_LEGACY_SEND_POLICY;
  delete process.env.ONBOARDING_STARTER_TEMPLATES;
}

const noTrack = { track: async () => {} };

async function connectDb() {
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([
    'OnboardingState', 'WhatsAppConnection', 'OnboardingTemplate', 'OnboardingEvent', 'OnboardingNotification', 'Customer', 'User', 'Workspace',
  ].map((n) => require(`../../../models/${n}`).init()));
  return mongoose;
}

/** An "oldest" owner workspace first (the admin enrolment safeguards refuse the oldest one). */
async function makeOwnerWorkspace() {
  const Workspace = require('../../../models/Workspace');
  const at = new Date('2026-01-01T00:00:00Z');
  await Workspace.collection.insertOne({ name: 'Owner workspace', createdAt: at, updatedAt: at, onboarding: { completed: true, currentStep: 5 } });
}

/**
 * An enrolled + activated merchant workspace with a connected WhatsApp number whose (merchant) token is
 * encrypted at rest. Returns ids as strings.
 */
let phoneSeq = 0;
const uniquePhone = () => `966500${String(++phoneSeq).padStart(6, '0')}`; // User.phone is unique

async function makeMerchant(g, { name = 'Merchant', languages, userPhone, connStatus = 'connected', active = true, uiLanguage } = {}) {
  const Workspace = require('../../../models/Workspace');
  const OnboardingState = require('../../../models/OnboardingState');
  const WhatsAppConnection = require('../../../models/WhatsAppConnection');
  const User = require('../../../models/User');
  const state = require('../../../shared/onboarding/state');
  const vault = require('../../../shared/onboarding/tokenVault');
  const at = new Date();
  const res = await Workspace.collection.insertOne({ name, createdAt: at, updatedAt: at, onboarding: { completed: false, currentStep: 1 } });
  const workspaceId = String(res.insertedId);
  await state.enrol({ workspaceId, by: 'cli:test', activate: active, notes: active ? 'integration test' : undefined }, noTrack);
  const set = {};
  if (languages) set['business.languages'] = languages;
  if (uiLanguage) set['business.uiLanguage'] = uiLanguage;
  if (Object.keys(set).length) await OnboardingState.updateOne({ workspaceId }, { $set: set });
  if (connStatus) {
    await WhatsAppConnection.create({
      workspaceId,
      status: connStatus,
      needsReconnect: false,
      tokenIsValid: true,
      ids: { wabaId: g.ids.wabaId, phoneNumberId: g.ids.phoneId },
      display: { displayPhoneNumber: '+966 55 000 1111', last4: '1111', verifiedName: 'Acme Coffee' },
      tokenEncrypted: vault.encrypt(g.ids.merchantToken, { workspaceId, purpose: 'token' }),
      connectedAt: new Date(Date.now() - 3600 * 1000),
    });
  }
  let userId = null;
  if (userPhone !== null) userId = String((await User.create({ phone: userPhone === undefined ? uniquePhone() : userPhone })).id);
  else userId = String((await User.create({ email: `owner${workspaceId.slice(-6)}@example.test` })).id);
  state.clearCache();
  return { workspaceId, userId };
}

function graphClient(g) {
  const { createMetaGraphClient } = require('../../../shared/onboarding/metaClient');
  return createMetaGraphClient({ http: g.http, appId: g.ids.appId, appSecret: g.ids.appSecret });
}

function clock(start = new Date()) {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
}

module.exports = { useDatabase, connectDb, makeOwnerWorkspace, makeMerchant, graphClient, clock, noTrack };
