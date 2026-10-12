const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// Boots the REAL server.js (its exported express app) against the throwaway DB and
// proves the localisation wiring end to end:
//   * /api/localization/* is behind requireAuth (401 without a token) and the per-merchant flag;
//   * the public Arabic pages are mounted in front of the existing page handlers;
//   * POST /webhook: a typed Arabic opt-out is handled by the localisation hook, while
//     English STOP / START / ordinary text and English button taps still go through the
//     EXISTING handlers, byte for byte;
//   * the scheduler start does not throw and sweeps/resumes campaigns.
// utils/whatsapp#waPost is replaced by a recorder (server.js's own webhook replies use a local axios helper
// that the sandbox's dead proxy refuses). Localisation replies go through transport.js in
// LOCALIZATION_SEND_MODE=dry_run, so they are captured and never sent.
jest.mock('../../../utils/whatsapp', () => {
  const actual = jest.requireActual('../../../utils/whatsapp');
  return { ...actual, waPost: jest.fn(async () => ({ messages: [{ id: 'wamid.recorded-not-sent' }] })) };
});

process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'itest-secret-not-real';
const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const app = require('../../../server');
const fx = require('./_fixtures');
const waModule = require('../../../utils/whatsapp');
const transport = require('../../../shared/localization/transport');
const settings = require('../../../shared/localization/settings');
const scheduler = require('../../../shared/localization/scheduler');
const hook = require('../../../shared/localization/inboundHook');
const Workspace = require('../../../models/Workspace');
const Customer = require('../../../models/Customer');
const ConsentEvent = require('../../../models/ConsentEvent');
const CustomerLanguage = require('../../../models/CustomerLanguage');
const WhatsAppMessage = require('../../../models/WhatsAppMessage');
const LocalizedCampaign = require('../../../models/LocalizedCampaign');
const LocalizedSend = require('../../../models/LocalizedSend');

jest.setTimeout(90000);

let home; // the workspace the webhook resolves (the OLDEST one, server.js#resolveWebhookWorkspaceId)

beforeAll(async () => {
  await mongoose.connection.asPromise(); // server.js started connecting when it was required
  await fx.connect();
  home = await Workspace.findOne().sort({ createdAt: 1 }).lean();
  if (!home) { const w = await fx.makeWorkspace(); home = w.workspace.toObject(); }
});
afterAll(async () => {
  scheduler.stopLocalizationScheduler();
  await fx.disconnect();
});
beforeEach(() => { transport.clearDryRuns(); hook.resetHandled(); waModule.waPost.mockClear(); });

async function waitFor(fn, { ms = 10000, what = 'condition' } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function webhook(from, message, name = 'Customer') {
  return request(app).post('/webhook').send({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { contacts: [{ profile: { name } }], messages: [{ from, ...message }] } }] }],
  });
}
const wid = () => `wamid.${crypto.randomBytes(8).toString('hex')}`;
const text = (body) => ({ id: wid(), type: 'text', text: { body } });
const events = (customer) => ConsentEvent.find({ customerId: customer._id }).sort({ createdAt: 1 }).lean();
const homeCustomer = (over = {}) => fx.makeCustomer(home._id, over);
const consentState = (doc) => ({ marketingConsent: doc.marketingConsent, optedOut: doc.optedOut, optedOutAt: doc.optedOutAt, marketingConsentAskedAt: doc.marketingConsentAskedAt });

describe('/api/localization is behind auth and the flag', () => {
  test('401 without a token, with a garbage token, with a token signed by someone else; 200 for settings with a valid token', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    expect((await request(app).get('/api/localization/settings')).status).toBe(401);
    expect((await request(app).get('/api/localization/settings').set('Authorization', 'Bearer nope')).status).toBe(401);
    const { ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');
    const forged = jwt.sign({ sub: String(ws.user._id), workspaceId: String(ws.workspaceId), role: 'owner' }, 'some-other-secret', { issuer: ISSUER, audience: AUDIENCE });
    expect((await request(app).get('/api/localization/settings').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    const res = await request(app).get('/api/localization/settings').set(ws.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ arabicEnabled: false, defaultCustomerLanguage: 'en' });
  });

  test('every other localisation area is 401 anonymous, 402 ARABIC_NOT_ENABLED with the flag off, 200 with it on', async () => {
    const off = await fx.makeWorkspace({ arabic: false });
    const on = await fx.makeWorkspace({ arabic: true });
    for (const area of ['campaigns', 'customers', 'templates', 'catalog', 'flows', 'inbox']) {
      expect((await request(app).get(`/api/localization/${area}`)).status).toBe(401);
      const blocked = await request(app).get(`/api/localization/${area}`).set(off.auth);
      expect([area, blocked.status, blocked.body.code]).toEqual([area, 402, 'ARABIC_NOT_ENABLED']);
    }
    const ok = await request(app).get('/api/localization/campaigns').set(on.auth);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ items: [], total: 0 });
    // the merchant cannot switch the flag on themselves
    const attempt = await request(app).put('/api/localization/settings').set(off.auth).send({ arabicEnabled: true });
    expect(await settings.isArabicEnabled(off.workspaceId)).toBe(false);
    expect([200, 400, 404, 405]).toContain(attempt.status);
  });

  test('the kill switch turns the feature off for everybody without a redeploy', async () => {
    const on = await fx.makeWorkspace({ arabic: true });
    process.env.LOCALIZATION_DISABLED = '1';
    try {
      const res = await request(app).get('/api/localization/campaigns').set(on.auth);
      expect([res.status, res.body.code]).toEqual([402, 'ARABIC_NOT_ENABLED']);
    } finally { delete process.env.LOCALIZATION_DISABLED; }
    expect((await request(app).get('/api/localization/campaigns').set(on.auth)).status).toBe(200);
  });

  test('a workspace id in the URL, query or body can never override the token (tenant isolation through the real app)', async () => {
    const a = await fx.makeWorkspace(); const b = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(a.workspaceId);
    await fx.makeCustomer(a.workspaceId, { language: 'ar' });
    const created = await request(app).post('/api/localization/campaigns').set(a.auth)
      .send({ name: 'Mine', workspaceId: String(b.workspaceId), templateId: String(tpl._id), audience: { kind: 'all_eligible' } });
    expect(created.status).toBe(201);
    expect((await LocalizedCampaign.findById(created.body.id).lean()).workspaceId.toString()).toBe(String(a.workspaceId));
    expect((await request(app).get(`/api/localization/campaigns?workspaceId=${b.workspaceId}`).set(b.auth)).body.total).toBe(0);
  });
});

describe('the public customer pages are mounted in front of the existing handlers', () => {
  test('an Arabic referral landing page for an Arabic-enabled merchant; ?lang=en reaches the existing English handler', async () => {
    await settings.setArabicEnabled({ workspaceId: home._id, enabled: true, grantedBy: 'itest' });
    const ReferralPromotion = require('../../../models/ReferralPromotion');
    const ReferralCode = require('../../../models/ReferralCode');
    const promotion = await ReferralPromotion.create({ workspaceId: home._id, name: 'Bring a friend', status: 'active' });
    const code = crypto.randomBytes(5).toString('hex').toUpperCase();
    await ReferralCode.create({ workspaceId: home._id, referralPromotionId: promotion._id, code, shortUrl: `https://x.test/r/${code}`, status: 'active' });
    const ar = await request(app).get(`/c/${code}?lang=ar`).redirects(0);
    expect(ar.status).toBe(200);
    expect(ar.text).toMatch(/dir="rtl"/);
    expect(ar.headers['content-language']).toBe('ar');
    const en = await request(app).get(`/c/${code}?lang=en`).redirects(0);
    // the existing handler answers (a redirect to wa.me, or its own "link not found" page): never our RTL page
    expect(en.text || '').not.toMatch(/dir="rtl"/);
    expect(en.headers['content-language']).toBeUndefined();
  });

  test('the health route and unrelated paths are untouched', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toBe('Waflow backend running');
  });
});

describe('POST /webhook: typed Arabic opt-out vs the existing English flow', () => {
  test('an Arabic opt-out from a known customer opts them out through the localisation hook only (ConsentEvent + flags + Arabic reply), after the Inbox hook logged it', async () => {
    const c = await homeCustomer({ marketingConsent: true });
    const res = await webhook(c.phone, text('إلغاء الاشتراك'));
    expect(res.status).toBe(200);
    await waitFor(async () => (await Customer.findById(c._id).lean()).optedOut === true, { what: 'the Arabic opt-out' });
    const ev = await events(c);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'consent_withdrawn', method: 'whatsapp_stop_command', phone: c.phone });
    expect(ev[0].source).toContain('Arabic reply');
    const after = await Customer.findById(c._id).lean();
    expect(after.optedOutAt).toBeTruthy();
    // the reply is the localisation hook's (dry-run transport); the existing English handler's source text is absent (exactly one event above)
    const dry = transport.lastDryRuns().filter((d) => d.payload.to === c.phone);
    expect(dry).toHaveLength(1);
    expect(dry[0].payload.text.body).toMatch(/\p{Script=Arabic}{3,}/u);
    // the Inbox hook ran first and logged the inbound text
    expect(await WhatsAppMessage.countDocuments({ workspaceId: home._id, phone: c.phone })).toBeGreaterThanOrEqual(1);
  });

  test('a Meta redelivery of the same Arabic opt-out writes one ConsentEvent', async () => {
    const c = await homeCustomer();
    const msg = text('توقف');
    await webhook(c.phone, msg);
    await waitFor(async () => (await Customer.findById(c._id).lean()).optedOut === true);
    await webhook(c.phone, msg);
    await new Promise((r) => setTimeout(r, 400));
    expect(await events(c)).toHaveLength(1);
  });

  test('an English STOP still goes through the EXISTING handler (its own source text and English reply, no Arabic hook involved)', async () => {
    const c = await homeCustomer({ marketingConsent: true });
    await webhook(c.phone, text('STOP'));
    await waitFor(async () => (await Customer.findById(c._id).lean()).optedOut === true, { what: 'the English opt-out' });
    const ev = await events(c);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'consent_withdrawn', method: 'whatsapp_stop_command', source: 'WhatsApp STOP reply' });
    expect(transport.lastDryRuns().filter((d) => d.payload.to === c.phone)).toHaveLength(0);
  });

  test('English START and ordinary English text are not intercepted; no localisation write happens for them', async () => {
    const c = await homeCustomer({ marketingConsent: true, optedOut: true, optedOutAt: new Date() });
    await webhook(c.phone, text('START'));
    await waitFor(async () => (await Customer.findById(c._id).lean()).optedOut === false, { what: 'the English START reinstatement' });
    expect((await events(c)).map((e) => [e.type, e.source])).toEqual([['consent_reinstated', 'WhatsApp START reply']]);

    const before = consentState(await Customer.findById(c._id).lean());
    transport.clearDryRuns();
    await webhook(c.phone, text('hello there, what do you sell?'));
    await new Promise((r) => setTimeout(r, 500));
    expect(consentState(await Customer.findById(c._id).lean())).toEqual(before);
    expect(await events(c)).toHaveLength(1);
    expect(transport.lastDryRuns().filter((d) => d.payload.to === c.phone)).toHaveLength(0);
  });

  test('an English customer tapping the Opt Out button of a localised campaign (optout_<campaignId>) is opted out by the existing handler', async () => {
    const c = await homeCustomer({ marketingConsent: true });
    await CustomerLanguage.create({ workspaceId: home._id, customerId: c._id, language: 'en', languageSource: 'merchant_set' });
    const campaignId = new mongoose.Types.ObjectId();
    await webhook(c.phone, { id: wid(), type: 'button', button: { payload: `optout_${campaignId}`, text: 'Stop offers' } });
    await waitFor(async () => (await Customer.findById(c._id).lean()).optedOut === true, { what: 'the existing opt-out button handler' });
    const ev = await events(c);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ method: 'whatsapp_optout_button', source: `Opt Out button on promotion ${campaignId}` });
    expect(transport.lastDryRuns().filter((d) => d.payload.to === c.phone)).toHaveLength(0);
  });

  test('an Arabic customer tapping the same button is handled by the localisation hook (Arabic source, Arabic reply)', async () => {
    const c = await homeCustomer({ marketingConsent: true });
    await CustomerLanguage.create({ workspaceId: home._id, customerId: c._id, language: 'ar', languageSource: 'merchant_set' });
    const campaignId = new mongoose.Types.ObjectId();
    await webhook(c.phone, { id: wid(), type: 'button', button: { payload: `optout_${campaignId}`, text: 'إلغاء الاشتراك' } });
    await waitFor(async () => (await Customer.findById(c._id).lean()).optedOut === true, { what: 'the Arabic opt-out button' });
    const ev = await events(c);
    expect(ev).toHaveLength(1);
    expect(ev[0].source).toBe(`Opt Out button on promotion ${campaignId} (Arabic)`);
    expect(transport.lastDryRuns().filter((d) => d.payload.to === c.phone)).toHaveLength(1);
  });

  test('a flag-enabled merchant: an Arabic first message records the language, and the existing flow still runs for it', async () => {
    await settings.setArabicEnabled({ workspaceId: home._id, enabled: true, grantedBy: 'itest' });
    const c = await homeCustomer();
    await webhook(c.phone, text('مرحبا، أريد أن أطلب قهوة'));
    const rec = await waitFor(() => CustomerLanguage.findOne({ customerId: c._id }).lean(), { what: 'the inferred language' });
    expect(rec).toMatchObject({ language: 'ar', languageSource: 'inferred' });
    expect((await Customer.findById(c._id).lean()).optedOut).not.toBe(true);
  });
});

describe('the scheduler', () => {
  test('the start line used by server.js does not throw, is idempotent, and can be stopped', async () => {
    scheduler.stopLocalizationScheduler();
    const stubTemplates = { refreshPending: async () => ({ stubbed: true }) }; // never call Meta from a test
    // a stub lock so the test does not hold the real TTL lock of the shared throwaway DB
    const stubLock = { findOneAndUpdate: async () => true, create: async () => ({}) };
    const deps = { ...scheduler.realDeps(), SchedulerLock: () => stubLock, templates: () => stubTemplates, log: () => {} };
    let handle;
    expect(() => { handle = scheduler.startLocalizationScheduler({ intervalMs: 3600 * 1000, deps }); }).not.toThrow();
    expect(handle).toBeTruthy();
    expect(scheduler.startLocalizationScheduler({ intervalMs: 3600 * 1000, deps })).toBe(handle);
    scheduler.stopLocalizationScheduler();
    // and the exact call server.js makes (default deps, default interval) can be made and stopped without throwing
    expect(() => scheduler.startLocalizationScheduler({ deps: { ...deps } })).not.toThrow();
    scheduler.stopLocalizationScheduler();
  });

  test('the TTL lock lets exactly one of several simultaneous instances sweep', async () => {
    const deps = { ...scheduler.realDeps(), log: () => {} };
    // free the lock if an earlier run left it held (an update, never a delete)
    await require('../../../models/SchedulerLock').updateOne({ _id: scheduler.LOCK_ID }, { $set: { lockedUntil: new Date(0) } });
    expect(await scheduler.acquireLock(deps, 1000)).toBe(true);
    const results = await Promise.all([1, 2, 3, 4].map(() => scheduler.acquireLock(deps, 1000)));
    expect(results.filter(Boolean)).toHaveLength(0); // the winner above still holds it for ~1 s
    await new Promise((r) => setTimeout(r, 1100));
    const race = await Promise.all([1, 2, 3, 4].map(() => scheduler.acquireLock(deps, 1000)));
    expect(race.filter(Boolean)).toHaveLength(1);
  });

  test('a sweep resumes a campaign whose runner died (stale heartbeat) and finishes it in dry-run, once', async () => {
    const ws = await fx.makeWorkspace({ arabic: true });
    const tpl = await fx.makeTemplate(ws.workspaceId);
    const customers = [await fx.makeCustomer(ws.workspaceId, { language: 'ar' }), await fx.makeCustomer(ws.workspaceId, { language: 'en' })];
    const campaigns = require('../../../shared/localization/campaigns');
    const created = await campaigns.create({ workspaceId: ws.workspaceId, userId: ws.user._id, body: { name: 'Crashed', templateId: String(tpl._id), audience: { kind: 'all_eligible' } } });
    await LocalizedCampaign.updateOne({ _id: created.id }, { $set: { status: 'sending', claimedBy: 'dead', claimedAt: new Date(), startedAt: new Date(), lastHeartbeatAt: new Date(Date.now() - 30 * 60 * 1000), runAttempts: 1 } });
    const deps = { ...scheduler.realDeps(), templates: () => ({ refreshPending: async () => null }), log: () => {} };
    const sweep = await scheduler.runSweepOnce(deps);
    expect(sweep.campaigns.resumed).toBeGreaterThanOrEqual(1);
    const done = await waitFor(async () => {
      const doc = await LocalizedCampaign.findById(created.id).lean();
      return doc.status !== 'sending' ? doc : null;
    }, { what: 'the resumed campaign to finish' });
    expect(done.status).toBe('sent');
    expect(done.stats).toMatchObject({ total: 2, sent: 2 });
    expect(await LocalizedSend.countDocuments({ campaignId: created.id, status: 'sent' })).toBe(2);
    const reached = transport.lastDryRuns().map((d) => d.payload.to);
    for (const c of customers) expect(reached.filter((p) => p === c.phone)).toHaveLength(1);
    // a second sweep does nothing more
    const again = await scheduler.runSweepOnce(deps);
    expect((await LocalizedSend.countDocuments({ campaignId: created.id, status: 'sent' }))).toBe(2);
    expect(again.skipped).toBe(false);
  });
});

describe('delivery callbacks join the localised campaign report (existing status handler + CampaignMessage rows)', () => {
  test('delivered / read / failed status webhooks update the campaign report per language, and a later "sent" never downgrades', async () => {
    await settings.setArabicEnabled({ workspaceId: home._id, enabled: true, grantedBy: 'itest' });
    const sender = require('../../../shared/localization/campaignSender');
    const campaigns = require('../../../shared/localization/campaigns');
    const tpl = await fx.makeTemplate(home._id);
    const ar1 = await fx.makeCustomer(home._id, { language: 'ar' });
    const ar2 = await fx.makeCustomer(home._id, { language: 'ar' });
    const en1 = await fx.makeCustomer(home._id, { language: 'en' });
    // a live-shaped fake transport (not dry run) so CampaignMessage rows are written; never reaches WhatsApp
    let n = 0;
    const live = {
      isDryRun: () => false,
      extractWamid: transport.extractWamid,
      sendTemplate: async () => { n += 1; return { messages: [{ id: `wamid.status-${fx.uniq()}-${n}` }] }; },
    };
    const jobs = [];
    const deps = { ...campaigns.realDeps(), transport: live, sleep: async () => {}, schedule: (fn) => jobs.push(fn), log: () => {} };
    // only the three customers of this test: address them explicitly (the shared home workspace holds older test customers)
    const created = await campaigns.create({
      workspaceId: home._id, userId: null,
      body: { name: 'Status join', templateId: String(tpl._id), audience: { kind: 'customer_ids', customerIds: [ar1, ar2, en1].map((c) => String(c._id)) } },
    }, deps);
    await sender.startSend({ workspaceId: home._id, campaignId: created.id }, deps);
    while (jobs.length) await jobs.shift()();
    const rows = await LocalizedSend.find({ campaignId: created.id }).lean();
    const wamidOf = (c) => rows.find((r) => String(r.customerId) === String(c._id)).wamid;

    const statuses = (list) => request(app).post('/webhook').send({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: list } }] }] });
    await statuses([{ id: wamidOf(ar1), status: 'delivered' }, { id: wamidOf(ar1), status: 'read' }, { id: wamidOf(ar2), status: 'delivered' }, { id: wamidOf(en1), status: 'failed', errors: [{ title: 'Undeliverable' }] }]);
    const CampaignMessage = require('../../../models/CampaignMessage');
    await waitFor(async () => (await CampaignMessage.findOne({ wamid: wamidOf(en1) }).lean()).status === 'failed', { what: 'the failed callback' });
    await statuses([{ id: wamidOf(ar1), status: 'sent' }]); // an out-of-order older status must not downgrade "read"
    await new Promise((r) => setTimeout(r, 300));
    expect((await CampaignMessage.findOne({ wamid: wamidOf(ar1) }).lean()).status).toBe('read');

    const report = await campaigns.report({ workspaceId: home._id, id: created.id });
    expect(report.byLanguage.ar).toMatchObject({ sent: 2, delivered: 2, read: 1, failed: 0 });
    expect(report.byLanguage.en).toMatchObject({ sent: 0, failed: 1 });
    const recipients = await campaigns.recipients({ workspaceId: home._id, id: created.id, query: { language: 'ar' } });
    expect(recipients.items.map((i) => i.deliveryStatus).sort()).toEqual(['delivered', 'read']);
  });
});
