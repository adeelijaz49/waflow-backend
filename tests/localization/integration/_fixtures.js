'use strict';
// Shared helpers for the DB-backed integration tests (*.itest.js). Not a test file.
// Only ever used against the throwaway mongod (see _guard.js). Tests create data and
// leave it: every test makes its OWN workspace so nothing collides, and nothing here
// deletes or drops anything.
const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();
process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'itest-secret-not-real';
process.env.LOCALIZATION_SEND_MODE = process.env.LOCALIZATION_SEND_MODE || 'dry_run';
// modules that build a Stripe client at require time need a (dummy) key when dotenv is not loaded; never a real one
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_not_real';

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const MODELS = [
  'Workspace', 'User', 'Membership', 'Customer', 'Order', 'Settings', 'LocaleSettings', 'CustomerLanguage', 'ConsentEvent',
  'CampaignMessage', 'LocalizedTemplate', 'LocalizedCampaign', 'LocalizedSend', 'AiChatSession',
];

async function connect() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  }
  // unique indexes must exist before a duplicate-key behaviour can be tested
  for (const name of MODELS) {
    try { await require(`../../../models/${name}`).init(); } catch (err) { if (!/Cannot find module/.test(err.message)) throw err; }
  }
}

async function disconnect() {
  await mongoose.disconnect();
}

let seq = 0;
function uniq() { seq += 1; return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`; }

function tokenFor({ userId, workspaceId, role = 'owner' }) {
  const { JWT_SECRET, ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');
  return jwt.sign({ sub: String(userId), workspaceId: String(workspaceId), role }, JWT_SECRET, { expiresIn: '1h', issuer: ISSUER, audience: AUDIENCE });
}

// Real Workspace + User + Membership; optionally the Arabic flag on.
async function makeWorkspace({ arabic = true, merchantName = 'Aroma Cafe', defaultCustomerLanguage } = {}) {
  const Workspace = require('../../../models/Workspace');
  const User = require('../../../models/User');
  const Membership = require('../../../models/Membership');
  const Settings = require('../../../models/Settings');
  const settings = require('../../../shared/localization/settings');
  const tag = uniq();
  const workspace = await Workspace.create({ name: `ws-${tag}` });
  const user = await User.create({ email: `owner-${tag}@example.test`, name: 'Owner' });
  await Membership.create({ userId: user._id, workspaceId: workspace._id, role: 'owner' });
  await Settings.create({ workspaceId: workspace._id, merchantName });
  if (arabic) await settings.setArabicEnabled({ workspaceId: workspace._id, enabled: true, grantedBy: 'itest' });
  if (defaultCustomerLanguage) await settings.updateMerchantSettings(workspace._id, { defaultCustomerLanguage });
  const token = tokenFor({ userId: user._id, workspaceId: workspace._id });
  return { workspace, workspaceId: workspace._id, user, token, auth: { Authorization: `Bearer ${token}` } };
}

let phoneSeq = 0;
function nextPhone() { phoneSeq += 1; return `9665${String(10000000 + (Date.now() % 1000000) * 10 + phoneSeq).slice(-8)}`; }

async function makeCustomer(workspaceId, over = {}) {
  const Customer = require('../../../models/Customer');
  const CustomerLanguage = require('../../../models/CustomerLanguage');
  const { language, ...fields } = over;
  const customer = await Customer.create({
    workspaceId, firstname: 'Sara', lastname: 'Test', phone: nextPhone(), marketingConsent: true, ...fields,
  });
  if (language) {
    await CustomerLanguage.create({ workspaceId, customerId: customer._id, language, languageSource: 'merchant_set' });
  }
  return customer;
}

function variant(language, over = {}) {
  const body = language === 'ar' ? 'مرحبا {name}، لديك {points} نقطة في {business}' : 'Hi {name}, you have {points} points at {business}';
  const buttons = [{ role: 'opt_out', text: language === 'ar' ? 'إلغاء الاشتراك' : 'Stop offers' }];
  return {
    language, body, buttons, metaTemplateName: `tpl_${language}_${uniq()}`, metaLanguage: language,
    metaStatus: 'APPROVED', reviewStatus: language === 'en' ? 'draft' : 'reviewed', ...over,
  };
}

async function makeTemplate(workspaceId, { languages = ['en', 'ar'], category = 'MARKETING', useCase = 'promotion', variants, over = {} } = {}) {
  const LocalizedTemplate = require('../../../models/LocalizedTemplate');
  const tag = uniq();
  return LocalizedTemplate.create({
    workspaceId, key: `t-${tag}`, name: `Template ${tag}`, category, useCase,
    variants: variants || languages.map((l) => variant(l)), ...over,
  });
}

module.exports = { connect, disconnect, uniq, tokenFor, makeWorkspace, makeCustomer, makeTemplate, variant, nextPhone };
