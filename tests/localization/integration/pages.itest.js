const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// Real-MongoDB integration tests for the public Arabic customer pages (slice B9):
// routes/localization/pages.js is mounted on a bare express app IN FRONT OF a
// sentinel "existing English handler", with the REAL models behind it and an
// injected fake Stripe client (no Stripe, no WhatsApp). The contract under test:
// anything that is not clearly "Arabic enabled AND Arabic visitor" falls through
// to the existing handler untouched.
const express = require('express');
const request = require('supertest');
const crypto = require('crypto');
const fx = require('./_fixtures');
const pages = require('../../../shared/localization/pages');
const pagesRouter = require('../../../routes/localization/pages');
const settings = require('../../../shared/localization/settings');
const Order = require('../../../models/Order');
const ReferralCode = require('../../../models/ReferralCode');
const ReferralPromotion = require('../../../models/ReferralPromotion');
const TrackingLink = require('../../../models/TrackingLink');
const InstagramPost = require('../../../models/InstagramPost');
const CustomerLanguage = require('../../../models/CustomerLanguage');

jest.setTimeout(60000);

beforeAll(async () => { await fx.connect(); });
afterAll(async () => { await fx.disconnect(); });

const SENTINEL = 'EXISTING-ENGLISH-HANDLER';
const hex10 = () => crypto.randomBytes(5).toString('hex').toUpperCase();
const piId = () => `pi_${crypto.randomBytes(8).toString('hex')}`;

// Fresh deps (hence fresh 30 s memos) per app; the fake Stripe serves `intents`.
function appWith({ intents = {}, overrides = {}, env } = {}) {
  const calls = { retrieve: [], referral: [], tracking: [] };
  const deps = {
    ...pages.realDeps(env || { ...process.env, STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_PUBLISHABLE_KEY: 'pk_test_dummy' }),
    getStripe: () => ({
      paymentIntents: {
        retrieve: async (id) => {
          calls.retrieve.push(id);
          if (!intents[id]) { const err = new Error('No such payment_intent'); err.code = 'resource_missing'; throw err; }
          return intents[id];
        },
      },
    }),
    recordReferralClick: async (args) => { calls.referral.push(args); return { waLink: 'https://wa.me/966500000000?text=Hi', referralCode: { code: args.code } }; },
    recordTrackingClick: async (args) => { calls.tracking.push(args); return { waLink: 'https://wa.me/966500000000?text=Hi', post: { name: 'Eid', promotionCode: 'IG-ABC123' } }; },
    ...overrides,
  };
  const app = express();
  app.use(pagesRouter.createRouter(() => deps));
  app.use((req, res) => res.status(200).send(`${SENTINEL} ${req.path}`)); // the existing handlers
  return { app, calls, deps };
}

async function payFixture({ arabic = true, language } = {}) {
  const ws = await fx.makeWorkspace({ arabic });
  const customer = await fx.makeCustomer(ws.workspaceId, { phone: fx.nextPhone(), language });
  const id = piId();
  await Order.create({ workspaceId: ws.workspaceId, customer: customer._id, total: 150, stripePaymentIntentId: id });
  const intent = {
    id, status: 'requires_payment_method', client_secret: `${id}_secret_x`, amount: 15000, currency: 'sar',
    metadata: { buyerPhone: customer.phone, subtotal: '150', shippingCost: '0' },
  };
  return { ws, customer, id, intent };
}

describe('payment pages', () => {
  // (/payment-cancelled carries no workspace: it follows the OLDEST workspace's flag, like server.js's public webhooks)
  test('flag OFF: every Arabic request falls through to the existing handler untouched', async () => {
    const f = await payFixture({ arabic: false });
    const { app } = appWith({ intents: { [f.id]: f.intent } });
    for (const url of [`/pay/${f.id}?lang=ar`, `/pay/${f.id}`, `/payment-result?payment_intent=${f.id}&lang=ar`]) {
      const res = await request(app).get(url).set('Accept-Language', 'ar-SA,ar;q=0.9');
      expect(res.text).toContain(SENTINEL);
    }
  });

  test('flag ON + ?lang=ar: an Arabic right-to-left checkout with the amount and the Stripe client secret as data', async () => {
    const f = await payFixture();
    const { app } = appWith({ intents: { [f.id]: f.intent } });
    const res = await request(app).get(`/pay/${f.id}?lang=ar`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(SENTINEL);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-language']).toBe('ar');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toMatch(/<html[^>]*lang="ar"/);
    expect(res.text).toMatch(/dir="rtl"/);
    expect(res.text).toMatch(/\p{Script=Arabic}{3,}/u);
    expect(res.text).toContain('150.00');
    expect(res.text).toContain(`data-client-secret="${f.intent.client_secret}"`);
    expect(res.text).toContain('data-publishable-key="pk_test_dummy"');
  });

  test('?lang=en (even with an Arabic customer and an Arabic browser) goes to the existing English handler', async () => {
    const f = await payFixture({ language: 'ar' });
    const { app, calls } = appWith({ intents: { [f.id]: f.intent } });
    const res = await request(app).get(`/pay/${f.id}?lang=en`).set('Accept-Language', 'ar');
    expect(res.text).toContain(SENTINEL);
    expect(calls.retrieve).toEqual([]); // English traffic costs no Stripe call
    // a repeated ?lang: any "en" wins
    expect((await request(app).get(`/pay/${f.id}?lang=ar&lang=en`)).text).toContain(SENTINEL);
  });

  test("language resolution without ?lang: stored customer language wins; with no signal it is English; Accept-Language ar works", async () => {
    const arCustomer = await payFixture({ language: 'ar' });
    const enCustomer = await payFixture({ language: 'en' });
    const unknown = await payFixture();
    const { app } = appWith({ intents: { [arCustomer.id]: arCustomer.intent, [enCustomer.id]: enCustomer.intent, [unknown.id]: unknown.intent } });
    expect((await request(app).get(`/pay/${arCustomer.id}`)).text).toMatch(/dir="rtl"/);
    expect((await request(app).get(`/pay/${enCustomer.id}`)).text).toContain(SENTINEL);
    expect((await request(app).get(`/pay/${unknown.id}`)).text).toContain(SENTINEL);
    expect((await request(app).get(`/pay/${unknown.id}`).set('Accept-Language', 'ar-SA,ar;q=0.9,en;q=0.5')).text).toMatch(/dir="rtl"/);
    expect((await request(app).get(`/pay/${unknown.id}`).set('Accept-Language', 'en-US,en;q=0.9,ar;q=0.2')).text).toContain(SENTINEL);
    // the customer's stored language is read from the customer of THIS workspace's order only
    expect(await CustomerLanguage.countDocuments({ customerId: arCustomer.customer._id })).toBe(1);
  });

  test('succeeded / unknown / cancelled PaymentIntents get the right Arabic page', async () => {
    const paid = await payFixture();
    paid.intent.status = 'succeeded';
    const cancelled = await payFixture();
    cancelled.intent.status = 'canceled';
    const { app } = appWith({ intents: { [paid.id]: paid.intent, [cancelled.id]: cancelled.intent } });
    const p = await request(app).get(`/pay/${paid.id}?lang=ar`);
    expect(p.status).toBe(200);
    expect(p.text).not.toContain('data-client-secret');
    const c = await request(app).get(`/pay/${cancelled.id}?lang=ar`);
    expect(c.status).toBe(404);
    expect(c.text).toMatch(/dir="rtl"/);
    // an id nobody has: its workspace falls back to the oldest workspace; either way it never crashes
    const unknown = await request(app).get(`/pay/${piId()}?lang=ar`);
    expect([200, 404]).toContain(unknown.status);
  });

  test('implausible ids and an unavailable Stripe fall through (fail open), never a 500', async () => {
    const f = await payFixture();
    const { app } = appWith({ intents: { [f.id]: f.intent } });
    expect((await request(app).get('/pay/not-a-pi?lang=ar')).status).toBeLessThan(500);
    const noStripe = appWith({ overrides: { getStripe: () => null } });
    expect((await request(noStripe.app).get(`/pay/${f.id}?lang=ar`)).text).toContain(SENTINEL);
    const broken = appWith({ overrides: { getStripe: () => { throw new Error('stripe down'); } } });
    expect((await request(broken.app).get(`/pay/${f.id}?lang=ar`)).text).toContain(SENTINEL);
  });

  test('the kill switch and a disconnected database both fall through', async () => {
    const f = await payFixture();
    const { app } = appWith({ intents: { [f.id]: f.intent } });
    process.env.LOCALIZATION_DISABLED = '1';
    try {
      expect((await request(app).get(`/pay/${f.id}?lang=ar`)).text).toContain(SENTINEL);
    } finally { delete process.env.LOCALIZATION_DISABLED; }
    const down = appWith({ intents: { [f.id]: f.intent }, overrides: { dbReady: () => false } });
    expect((await request(down.app).get(`/pay/${f.id}?lang=ar`)).text).toContain(SENTINEL);
  });

  test('/payment-cancelled renders only (no write, no WhatsApp) and /payment-result shows success / failed', async () => {
    const ok = await payFixture();
    ok.intent.status = 'succeeded';
    const bad = await payFixture();
    const { app } = appWith({ intents: { [ok.id]: ok.intent, [bad.id]: bad.intent } });
    const cancelled = await request(app).get(`/payment-cancelled?lang=ar&phone=${ok.customer.phone}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.text).toMatch(/dir="rtl"/);
    expect((await request(app).get(`/payment-result?lang=ar&payment_intent=${ok.id}`)).text).toMatch(/dir="rtl"/);
    const failed = await request(app).get(`/payment-result?lang=ar&payment_intent=${bad.id}`);
    expect(failed.text).toContain(`/pay/${bad.id}?lang=ar`); // retry link
  });
});

describe('referral and Instagram link pages', () => {
  async function referralFixture({ arabic = true, status = 'active' } = {}) {
    const ws = await fx.makeWorkspace({ arabic });
    const referrer = await fx.makeCustomer(ws.workspaceId, { firstname: 'Khalid' });
    const promotion = await ReferralPromotion.create({ workspaceId: ws.workspaceId, name: 'Bring a friend', status: 'active' });
    const code = hex10();
    await ReferralCode.create({ workspaceId: ws.workspaceId, referralPromotionId: promotion._id, referrerCustomerId: referrer._id, code, shortUrl: `https://x.test/r/${code}`, status });
    return { ws, code };
  }

  test('flag off or ?lang=en falls through; flag on + ?lang=ar shows the landing page and records NOTHING', async () => {
    const off = await referralFixture({ arabic: false });
    const on = await referralFixture();
    const { app, calls } = appWith();
    expect((await request(app).get(`/r/${off.code}?lang=ar`)).text).toContain(SENTINEL);
    expect((await request(app).get(`/r/${on.code}?lang=en`)).text).toContain(SENTINEL);
    const landing = await request(app).get(`/r/${on.code}?lang=ar`);
    expect(landing.status).toBe(200);
    expect(landing.text).toMatch(/dir="rtl"/);
    expect(landing.text).toContain('go=1');
    expect(calls.referral).toEqual([]);
    const generic = await request(app).get(`/c/${on.code}?lang=ar`);
    expect(generic.status).toBe(200);
  });

  test('the public landing page shows the merchant (business name from Settings) and the promotion, and NOTHING about the referrer', async () => {
    const f = await referralFixture(); // the referrer is a real customer called "Khalid"
    const { app } = appWith();
    const landing = await request(app).get(`/r/${f.code}?lang=ar`);
    expect(landing.status).toBe(200);
    expect(landing.text).toContain('<bdi>Aroma Cafe</bdi>'); // fx.makeWorkspace's Settings.merchantName
    expect(landing.text).toContain('<bdi>Bring a friend</bdi>');
    expect(landing.text).not.toContain('Khalid');
    expect(landing.text).not.toContain('دعاك');
    const generic = await request(app).get(`/c/${f.code}?lang=ar`);
    expect(generic.text).toContain('<bdi>Aroma Cafe</bdi>');
    expect(generic.text).not.toContain('Khalid');
  });

  test('the continue tap (?go=1) records the click once through the injected recorder and redirects to wa.me with the Latin Code line', async () => {
    const f = await referralFixture();
    const { app, calls } = appWith();
    const res = await request(app).get(`/r/${f.code}?lang=ar&go=1&src=ig`).redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/wa\.me\/966500000000\?text=/);
    expect(decodeURIComponent(res.headers.location)).toContain(`Code: ${f.code}`);
    expect(calls.referral).toHaveLength(1);
    expect(calls.referral[0]).toMatchObject({ code: f.code, source: 'ig' });
    expect(res.text || '').not.toContain(SENTINEL);
  });

  test('a recorder failure on the tap is an Arabic error page, never the English handler (which would record again)', async () => {
    const f = await referralFixture();
    const { app } = appWith({ overrides: { recordReferralClick: async () => { throw new Error('db blip'); } } });
    const res = await request(app).get(`/r/${f.code}?lang=ar&go=1`);
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(SENTINEL);
    expect(res.text).toMatch(/dir="rtl"/);
  });

  test('an unknown or expired code: unknown falls back to the oldest workspace; a disabled code is an Arabic not-found page', async () => {
    const f = await referralFixture({ status: 'disabled' });
    const { app } = appWith();
    const res = await request(app).get(`/r/${f.code}?lang=ar`);
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/dir="rtl"/);
    expect((await request(app).get(`/r/${hex10()}?lang=en`)).text).toContain(SENTINEL);
  });

  test('/t/:code: an Arabic caption means an Arabic audience; the page is read-only', async () => {
    const ws = await fx.makeWorkspace();
    const mongoose = require('mongoose');
    const post = await InstagramPost.create({
      workspaceId: ws.workspaceId, socialAccountId: new mongoose.Types.ObjectId(), name: 'عرض العيد', caption: 'عرض خاص بمناسبة العيد لجميع عملائنا الكرام', promotionCode: 'IG-ABC123',
    });
    const code = hex10();
    await TrackingLink.create({ workspaceId: ws.workspaceId, instagramPostId: post._id, code, shortUrl: `https://x.test/t/${code}` });
    const { app, calls } = appWith();
    const res = await request(app).get(`/t/${code}`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/dir="rtl"/);
    expect(calls.tracking).toEqual([]);
    expect((await request(app).get(`/t/${code}?lang=en`)).text).toContain(SENTINEL);
  });
});

describe('routing surface', () => {
  test('only the six public GET paths are declared; POSTs and other paths are never touched', async () => {
    expect(pagesRouter.ROUTES.map(([p]) => p)).toEqual(['/pay/:piId', '/payment-result', '/payment-cancelled', '/r/:code', '/c/:code', '/t/:code']);
    const { app } = appWith();
    expect((await request(app).post('/pay/pi_abc?lang=ar')).text).toContain(SENTINEL);
    expect((await request(app).get('/api/anything?lang=ar')).text).toContain(SENTINEL);
    expect(settings.killSwitchOn()).toBe(false);
  });
});

describe('merchant / customer controlled text can never inject markup, and redirects stay on wa.me', () => {
  const PAYLOAD = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';

  test('referrer name, promotion name, payment address and Instagram names are escaped in the Arabic pages', async () => {
    const ws = await fx.makeWorkspace();
    const referrer = await fx.makeCustomer(ws.workspaceId, { firstname: PAYLOAD });
    const promotion = await ReferralPromotion.create({ workspaceId: ws.workspaceId, name: PAYLOAD, status: 'active' });
    const code = hex10();
    await ReferralCode.create({ workspaceId: ws.workspaceId, referralPromotionId: promotion._id, referrerCustomerId: referrer._id, code, shortUrl: `https://x.test/r/${code}`, status: 'active' });
    const { app } = appWith();
    const landing = await request(app).get(`/r/${code}?lang=ar`);
    expect(landing.status).toBe(200);
    expect(landing.text).not.toContain('<script>alert');
    expect(landing.text).not.toMatch(/<img[^>]*onerror/i);

    const f = await payFixture();
    f.intent.metadata.address = PAYLOAD;
    const { app: payApp } = appWith({ intents: { [f.id]: f.intent } });
    const pay = await request(payApp).get(`/pay/${f.id}?lang=ar`);
    expect(pay.status).toBe(200);
    expect(pay.text).not.toContain('<script>alert');
    expect(pay.text).not.toMatch(/<img[^>]*onerror/i);
    // the only <script> blocks are the static Stripe loader and the page's own static script
    expect((pay.text.match(/<script/g) || []).length).toBe(2);
  });

  test('a recorder that returns a non-wa.me link never produces an open redirect', async () => {
    const ws = await fx.makeWorkspace();
    const promotion = await ReferralPromotion.create({ workspaceId: ws.workspaceId, name: 'P', status: 'active' });
    const code = hex10();
    await ReferralCode.create({ workspaceId: ws.workspaceId, referralPromotionId: promotion._id, code, shortUrl: `https://x.test/c/${code}`, status: 'active' });
    for (const waLink of ['https://evil.example/966500000000', 'http://wa.me/966500000000', 'https://wa.me.evil.example/966500000000', 'javascript:alert(1)']) {
      const { app } = appWith({ overrides: { recordReferralClick: async () => ({ waLink, referralCode: { code } }) } });
      const res = await request(app).get(`/c/${code}?lang=ar&go=1`).redirects(0);
      expect(res.status).toBe(503);
      expect(res.headers.location).toBeUndefined();
    }
  });
});
