'use strict';
// Boots the REAL server.js (its exported Express app) inside a SANDBOX process with every external system faked
// (task I1b). Used by the launcher (server.js in this folder), the seed script, the contract dump and the jest e2e
// suites. Order matters and is the whole point of this file: guards -> dummy env -> fakes -> module stubs -> axios
// bridge -> require('server.js'). Nothing here is ever required by the application itself.
//
//   Meta Graph : tests/onboarding/_fixtures/fakeGraph through multiGraph (axios adapter bridge)
//   Stripe     : tests/onboarding/_fixtures/fakeStripe, injected by replacing the `stripe` module's constructor for ONE
//                sandbox key only (any other key still builds the real offline client)
//   Resend     : a stub of the `resend` module whose emails.send feeds tests/onboarding/_fixtures/fakeResend
const { assertSandbox, dbName } = require('./sandbox');
const { createMultiGraph, installAxiosAdapter } = require('./multiGraph');

const SANDBOX_STRIPE_KEY = 'sk_test_onb_e2e_dummy_not_real';
const JWT_SECRET = 'onb-e2e-sandbox-jwt-secret-not-real';
const KEY_HEX = 'a1'.repeat(32);
const ADMIN_USER = 'e2e-admin';
const ADMIN_PASS = 'e2e-admin-pass-not-real';

let booted = null;

function stubModule(name, value) {
  /* global jest */
  if (typeof jest !== 'undefined' && jest && typeof jest.doMock === 'function') { jest.doMock(name, () => value); return; }
  const id = require.resolve(name);
  require.cache[id] = { id, filename: id, loaded: true, exports: value, children: [], paths: [] };
}

/** The e-mail provider fake: Resend's `emails.send` shape ({ data, error }) on top of fakeResend. */
function createMailSink(fakeSend) {
  const fake = fakeSend();
  let failures = 0;
  let failStatus = 503;
  return {
    fake,
    get sent() { return fake.sent; },
    /** The next `n` sends answer an API-level error (what the real Resend SDK does: it resolves { data:null, error }). */
    failNext(n = 1, statusCode = 503) { failures = n; failStatus = statusCode; },
    reset() { fake.sent.length = 0; failures = 0; },
    async emailsSend(payload) {
      if (failures > 0) { failures -= 1; return { data: null, error: { name: 'application_error', statusCode: failStatus } }; }
      try {
        const r = await fake.send(payload);
        return { data: { id: r.id }, error: null };
      } catch (e) {
        return { data: null, error: { name: (e && e.code) || 'error', statusCode: (e && e.statusCode) || 500 } };
      }
    },
  };
}

function applyEnv(opts) {
  const e = process.env;
  const set = {
    ONBOARDING_FLOW: 'on',
    ONBOARDING_CHECKOUT: 'on',
    ONBOARDING_BILLING_PORTAL: 'on',
    ONBOARDING_LEGACY_SEND_POLICY: opts.policy || 'block',
    ONBOARDING_SUPPORT_EMAIL: 'support@waflow.test',
    ONBOARDING_STRIPE_SECRET_KEY: SANDBOX_STRIPE_KEY,
    ONBOARDING_STRIPE_PRICES: JSON.stringify({ basic: 'price_test_basic', pro: 'price_test_pro' }),
    ONBOARDING_PLAN_LABELS: JSON.stringify({ basic: { en: 'Basic' }, pro: { en: 'Pro' } }),
    WA_TOKEN_ENCRYPTION_KEY: KEY_HEX,
    META_ES_APP_ID: 'APP_ID_FIXTURE',
    META_ES_CONFIG_ID: 'CONFIG_ID_FIXTURE',
    WA_APP_ID: 'APP_ID_FIXTURE',
    WA_APP_SECRET: 'APP_SECRET_FIXTURE_0123456789abcdef',
    AUTH_JWT_SECRET: JWT_SECRET,
    AUTH_TEST_MODE: 'true',
    APP_URL: 'http://localhost:3000',
    FRONTEND_URL: 'http://localhost:4200',
    RESEND_API_KEY: 're_dummy_onb_e2e_not_real',
    RESEND_FROM_EMAIL: 'onboarding@waflow.test',
    WA_PHONE_ID: '990000000000001',
    WA_WABA_ID: '990000000000002',
    INTERNAL_ADMIN_USER: ADMIN_USER,
    INTERNAL_ADMIN_PASSWORD: ADMIN_PASS,
    STRIPE_SECRET_KEY: 'sk_test_legacy_dummy_not_real',
    STRIPE_SIGNING_SECRET: 'whsec_legacy_dummy_not_real',
  };
  Object.keys(set).forEach((k) => { e[k] = set[k]; });
  ['ONBOARDING_ENROL_FROM', 'META_ES_APP_SECRET', 'ONBOARDING_UNLOCK_AT', 'ONBOARDING_STRICT_LOCK', 'ONBOARDING_ALLOW_SHARED_KEY', 'ONBOARDING_WEBHOOK_SIGNATURE', 'META_PAYMENT_PROBE', 'ONBOARDING_ACCEPT_TRIALING'].forEach((k) => { delete e[k]; });
  Object.assign(e, opts.env || {});
  return set;
}

/**
 * @param {{policy?:'block'|'platform_number', env?:object}} [opts]
 * @returns {Promise<object>} { app, mongoose, graph, stripe, mail, clock, env, db, stop }
 */
async function boot(opts = {}) {
  if (booted) return booted;
  assertSandbox();

  // fixtures first (fakeStripe loads the REAL stripe package here: it keeps that handle for its offline signatures)
  const F = require('../_fixtures');
  const RealStripe = require('stripe');
  const axios = require('axios');

  applyEnv(opts);
  const clock = F.fixedClock(new Date());
  const graph = createMultiGraph({ clock, platformToken: 'EAAPLATFORMdummyTOKEN_0123456789_abcdefghijklmnopqrstuvwxyz' });
  process.env.WA_TOKEN = graph.platformToken;
  const stripe = F.createFakeStripe({ clock });
  process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET = stripe.webhookSecret;
  delete process.env.ONBOARDING_STRIPE_WEBHOOK_SECRET_PREV;
  const mail = createMailSink(F.createFakeSend);
  // The launcher and the seed are DIFFERENT processes on ONE database: the fake Stripe numbers its ids (sessions, subscriptions,
  // events) from 1 in every process, and the webhook ledger / workspace lookup are keyed by those ids. Start each process at a
  // different offset so an id of this process never collides with one the seed already stored.
  const idOffset = 200 + (Date.now() % 800);
  for (let i = 0; i < idOffset; i += 1) {
    F.makeEvent({ type: 'noop' });
    await stripe.checkout.sessions.create({ mode: 'subscription', success_url: 'https://example.test/x', line_items: [{ price: 'price_offset', quantity: 1 }] });
  }
  stripe.calls.length = 0;

  function StripeStub(key, options) {
    if (key === SANDBOX_STRIPE_KEY) return stripe;
    return new RealStripe(key, options);
  }
  Object.setPrototypeOf(StripeStub, RealStripe);
  StripeStub.prototype = RealStripe.prototype;
  StripeStub.default = StripeStub;
  StripeStub.Stripe = StripeStub;
  stubModule('stripe', StripeStub);
  stubModule('resend', { Resend: class FakeResendClient { constructor() { this.emails = { send: (p) => mail.emailsSend(p) }; } } });
  const uninstallAxios = installAxiosAdapter(axios, graph.http);

  const app = require('../../../server');
  const mongoose = require('mongoose');
  await mongoose.connection.asPromise();
  const models = ['OnboardingState', 'WhatsAppConnection', 'WhatsAppClaim', 'OnboardingEvent', 'OnboardingSupportRequest', 'OnboardingNotification',
    'OnboardingTemplate', 'OnboardingInbound', 'OnboardingAdminLog', 'Membership', 'User', 'Workspace', 'LoginChallenge'];
  await Promise.all(models.map((m) => require(`../../../models/${m}`).init()));

  booted = {
    app, mongoose, graph, stripe, mail, clock, db: dbName(),
    ids: { stripeKey: SANDBOX_STRIPE_KEY },
    env: { jwtSecret: JWT_SECRET, adminUser: ADMIN_USER, adminPass: ADMIN_PASS, appSecret: 'APP_SECRET_FIXTURE_0123456789abcdef', stripeWebhookSecret: stripe.webhookSecret },
    model: (name) => require(`../../../models/${name}`),
    async stop() { uninstallAxios(); await mongoose.disconnect(); booted = null; },
  };
  return booted;
}

module.exports = { boot, SANDBOX_STRIPE_KEY, JWT_SECRET, KEY_HEX, ADMIN_USER, ADMIN_PASS, createMailSink };
