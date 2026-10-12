'use strict';
// Shared harness for the localisation integration tests: one real mongoose connection to the
// THROWAWAY mongod, three fresh workspaces per run (A flagged, B flagged, C unflagged) with real
// User/Membership documents and real JWTs signed like routes/auth.js issueSessionToken, and the real
// routers mounted behind the real requireAuth exactly as server.js does. Nothing is ever deleted:
// every run uses brand-new ObjectIds, so leftovers from earlier runs cannot collide.
const { assertThrowawayDb } = require('../_guard');
assertThrowawayDb();
// No dotenv (never load a real .env): a fixed test secret for the JWTs signed below.
process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'itest-only-secret';
process.env.LOCALIZATION_SEND_MODE = 'dry_run';
// shared/inbox.js builds a Stripe client at require time; a dummy key keeps it constructible (nothing ever calls Stripe).
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_itest_only';

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { requireAuth, JWT_SECRET, ISSUER, AUDIENCE } = require('../../../../middleware/requireAuth');

const MODELS = [
  'Workspace', 'User', 'Membership', 'Customer', 'CustomerLanguage', 'LocaleSettings', 'Settings', 'LocalizedTemplate',
  'Product', 'Service', 'ProductTranslation', 'Flow', 'Promotion', 'MessageNode', 'Order', 'CampaignMessage',
  'LocalizationAdminLog', 'SchedulerLock', 'WhatsAppMessage', 'LocalizedCampaign', 'LocalizedSend',
];

async function connect() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI);
  // Build the declared indexes (unique ones matter: the services rely on them). createIndexes only adds.
  for (const name of MODELS) {
    try { await require(`../../../../models/${name}`).createIndexes(); } catch (e) { if (e.code !== 85 && e.code !== 86) throw e; }
  }
}

function tokenFor(userId, workspaceId, role = 'owner') {
  return jwt.sign({ sub: String(userId), workspaceId: String(workspaceId), role }, JWT_SECRET, { expiresIn: '1h', issuer: ISSUER, audience: AUDIENCE });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/localization', requireAuth, require('../../../../routes/localization'));
  return app;
}

async function makeTenant(label, { flagged }) {
  const Workspace = require('../../../../models/Workspace');
  const User = require('../../../../models/User');
  const Membership = require('../../../../models/Membership');
  const settings = require('../../../../shared/localization/settings');
  const ws = await Workspace.create({ name: `itest ${label} ${Date.now()}` });
  const tag = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const user = await User.create({ name: `Reviewer ${label}`, email: `itest-${label.toLowerCase()}-${tag}@example.test` });
  await Membership.create({ userId: user._id, workspaceId: ws._id, role: 'owner' });
  if (flagged) await settings.setArabicEnabled({ workspaceId: ws._id, enabled: true, grantedBy: 'itest' });
  return { ws, wsId: ws._id, user, userId: user._id, token: tokenFor(user._id, ws._id) };
}

async function setup() {
  await connect();
  const app = buildApp();
  const A = await makeTenant('A', { flagged: true });
  const B = await makeTenant('B', { flagged: true });
  const C = await makeTenant('C', { flagged: false });
  const api = (tenant) => {
    const t = tenant && tenant.token;
    const wrap = (verb) => (url) => { const r = request(app)[verb](`/api/localization${url}`); return t ? r.set('Authorization', `Bearer ${t}`) : r; };
    return { get: wrap('get'), post: wrap('post'), put: wrap('put') };
  };
  return { app, A, B, C, api, anon: api(null) };
}

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
// Unique Saudi-looking 12-digit phone per call.
let phoneSeq = Math.floor(Math.random() * 9e6);
const phone = () => `9665${String(10000000 + (phoneSeq++ % 89999999)).padStart(8, '0')}`.slice(0, 12);

async function makeCustomer(workspaceId, fields = {}) {
  const Customer = require('../../../../models/Customer');
  return Customer.create({ workspaceId, firstname: 'Test', lastname: uniq(), phone: phone(), ...fields });
}

module.exports = { mongoose, request, connect, setup, tokenFor, makeTenant, makeCustomer, uniq, phone, buildApp };
