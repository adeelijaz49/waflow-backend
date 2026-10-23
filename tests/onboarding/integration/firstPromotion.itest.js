'use strict';
const { useDatabase, connectDb, makeOwnerWorkspace, makeMerchant, graphClient, clock } = require('./_b1eEnv');
useDatabase('firstpromo');

// First-Promotion hand-off on REAL models: read-only counts (MARKETING_ELIGIBLE_QUERY), approved templates learned
// through the real submit + poll path against fakeGraph, sendPolicy rules, and the verified 'done'.
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { createFakeGraph } = require('../_fixtures');
const OnboardingState = require('../../../models/OnboardingState');
const OnboardingTemplate = require('../../../models/OnboardingTemplate');
const Customer = require('../../../models/Customer');
const Product = require('../../../models/Product');
const Service = require('../../../models/Service');
const CampaignMessage = require('../../../models/CampaignMessage');
const Membership = require('../../../models/Membership');
const User = require('../../../models/User');
const starter = require('../../../shared/onboarding/starterTemplates');
const firstPromotion = require('../../../shared/onboarding/firstPromotion');

let g;
let deps;
let clk;

async function merchant(opts = {}) {
  g = createFakeGraph({ wabaId: 'W1', phoneId: 'P1' });
  clk = clock();
  deps = { metaClient: graphClient(g), now: clk.now };
  const m = await makeMerchant(g, { name: `F${Math.random().toString(36).slice(2, 8)}`, ...opts });
  await starter.seedStarterTemplates(m.workspaceId, deps);
  await starter.submitQueued({ workspaceId: m.workspaceId }, deps);
  await starter.submitQueued({ workspaceId: m.workspaceId }, deps);
  return m;
}
async function approve(m, ...keys) {
  for (const key of keys) {
    const row = await OnboardingTemplate.findOne({ workspaceId: m.workspaceId, key, language: 'en' }).lean();
    g.setTemplateStatus(row.metaTemplateName, 'en', 'APPROVED');
  }
  clk.advance(61 * 60 * 1000);
  await starter.pollStatuses({ workspaceId: m.workspaceId, submit: false }, deps);
}
const customer = (m, phone, extra = {}) => Customer.create({ workspaceId: m.workspaceId, firstname: 'A', lastname: 'B', phone, ...extra });
const get = (m) => firstPromotion.getFirstPromotion({ workspaceId: m.workspaceId, userId: m.userId }, deps);
const set = (m, state) => firstPromotion.setFirstPromotionState({ workspaceId: m.workspaceId, state }, deps);
const fp = async (m) => (await OnboardingState.findOne({ workspaceId: m.workspaceId }).lean()).firstPromotion;

beforeAll(async () => {
  await connectDb();
  await Promise.all([Product, Service, CampaignMessage].map((x) => x.init()));
  await makeOwnerWorkspace();
});
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(() => { delete process.env.ONBOARDING_LEGACY_SEND_POLICY; });

describe('GET /first-promotion data', () => {
  test('waiting for approval: not ready, missing.template, the plan is still suggested', async () => {
    const m = await merchant();
    const r = await get(m);
    expect(r).toMatchObject({ ready: false, missing: { template: true }, sendPolicy: 'block', builderHint: { path: '/promotions' }, state: 'locked' });
    expect(r.suggestion.templateKey).toBe('promotion_weekend');
    expect(r.suggestion.bodyPreview.en).toMatch(/weekend offer/i);
  });

  test('connected + an approved promotion template: ready; counts follow the consent rules; suggestion follows the products', async () => {
    const m = await merchant();
    await approve(m, 'promotion_weekend', 'promotion_new_arrival');
    await customer(m, '966500000001', { marketingConsent: true });
    await customer(m, '966500000002', { marketingConsent: true });
    await customer(m, '966500000003', { marketingConsent: true, optedOut: true });
    await customer(m, '966500000004', { marketingConsent: false });
    const other = await merchant();
    await customer(other, '966500000099', { marketingConsent: true });
    let r = await get(m);
    expect(r.ready).toBe(true);
    expect(r.suggestion.audience).toEqual({ optedIn: 2, total: 4 });
    expect(r.missing).toEqual({ audience: false, products: true, template: false });
    expect(r.suggestion).toMatchObject({ templateKey: 'promotion_weekend', campaignType: 'store_wide_offer' });
    await Product.create({ workspaceId: m.workspaceId, name: 'Tea', category: 'drinks', basePrice: 5 });
    r = await get(m);
    expect(r.missing.products).toBe(false);
    expect(r.suggestion).toMatchObject({ templateKey: 'promotion_new_arrival', campaignType: 'product_promotion' });
    const o = await get(other);
    expect(o.suggestion.audience).toEqual({ optedIn: 1, total: 1 }); // tenant isolation: never merged with m's customers
  });

  test('services count as something to promote; an inactive product does not', async () => {
    const m = await merchant();
    await Product.create({ workspaceId: m.workspaceId, name: 'Old', category: 'x', basePrice: 1, active: false });
    expect((await get(m)).missing.products).toBe(true);
    await Service.create({ workspaceId: m.workspaceId, name: 'Haircut' });
    expect((await get(m)).missing.products).toBe(false);
  });

  test('the connection must be usable', async () => {
    const m = await merchant();
    await approve(m, 'promotion_weekend');
    expect((await get(m)).ready).toBe(true);
    await require('../../../models/WhatsAppConnection').updateOne({ workspaceId: m.workspaceId }, { $set: { needsReconnect: true } });
    expect((await get(m)).ready).toBe(false);
  });

  test('testRecipient: login phone masked; needsPhone only for an OWNER without a login phone (live Membership); a member never types a number; sendPolicy follows the explicit opt-in', async () => {
    const m = await merchant({ userPhone: '966501234567' });
    expect((await get(m)).testRecipient).toEqual({ masked: '********4567', needsPhone: false });
    // an e-mail-login user WITHOUT a membership is nobody: no number may be typed
    const e = await merchant({ userPhone: null });
    expect((await get(e)).testRecipient).toEqual({ masked: null, needsPhone: false });
    // ... the same user as the workspace OWNER is asked for ONE number
    await Membership.create({ userId: e.userId, workspaceId: e.workspaceId, role: 'owner' });
    expect((await get(e)).testRecipient).toEqual({ masked: null, needsPhone: true });
    // ... a member of that workspace without a phone is never asked (the server would refuse a typed number)
    const member = await User.create({ email: `member${e.workspaceId.slice(-6)}@example.test` });
    await Membership.create({ userId: member._id, workspaceId: e.workspaceId, role: 'member' });
    expect(await firstPromotion.getFirstPromotion({ workspaceId: e.workspaceId, userId: String(member._id) }, deps))
      .toMatchObject({ testRecipient: { masked: null, needsPhone: false } });
    // an owner of ANOTHER workspace has no say here
    const stranger = await User.create({ email: `stranger${e.workspaceId.slice(-6)}@example.test` });
    await Membership.create({ userId: stranger._id, workspaceId: m.workspaceId, role: 'owner' });
    expect(await firstPromotion.getFirstPromotion({ workspaceId: e.workspaceId, userId: String(stranger._id) }, deps))
      .toMatchObject({ testRecipient: { masked: null, needsPhone: false } });
    process.env.ONBOARDING_LEGACY_SEND_POLICY = 'platform_number';
    expect((await get(m)).sendPolicy).toBe('platform_number');
  });

  test('read-only: the sidecar and every other collection are unchanged by a read', async () => {
    const m = await merchant();
    await approve(m, 'promotion_weekend');
    const before = JSON.stringify(await OnboardingState.findOne({ workspaceId: m.workspaceId }).lean());
    const counts = [await Customer.countDocuments({}), await OnboardingTemplate.countDocuments({}), await CampaignMessage.countDocuments({})];
    await get(m);
    await get(m);
    expect(JSON.stringify(await OnboardingState.findOne({ workspaceId: m.workspaceId }).lean())).toBe(before);
    expect([await Customer.countDocuments({}), await OnboardingTemplate.countDocuments({}), await CampaignMessage.countDocuments({})]).toEqual(counts);
  });
});

describe('POST /first-promotion/state', () => {
  test('policy block: started and skipped accepted (step marked through steps.markStep), done refused with the reason', async () => {
    const m = await merchant();
    expect(await set(m, 'started')).toMatchObject({ state: 'started', sendPolicy: 'block' });
    expect(await fp(m)).toMatchObject({ state: 'started' });
    expect((await fp(m)).startedAt).toBeInstanceOf(Date);
    expect((await OnboardingState.findOne({ workspaceId: m.workspaceId }).lean()).steps.promotion.status).toBe('in_progress');
    await expect(set(m, 'done')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, details: { reason: 'SENDING_NOT_AVAILABLE_YET' } });
    expect((await fp(m)).state).toBe('started');
    expect(await set(m, 'skipped')).toMatchObject({ state: 'skipped' });
    expect((await OnboardingState.findOne({ workspaceId: m.workspaceId }).lean()).steps.promotion.status).toBe('skipped');
    expect((await set(m, 'started')).state).toBe('skipped'); // never backwards
  });

  test('policy platform_number: done only after a promotion message exists since the connection', async () => {
    process.env.ONBOARDING_LEGACY_SEND_POLICY = 'platform_number';
    const m = await merchant();
    await expect(set(m, 'done')).rejects.toMatchObject({ details: { reason: 'NO_PROMOTION_SENT' } });
    const c = await customer(m, '966500000010', { marketingConsent: true });
    const before = new Date(Date.now() - 48 * 3600 * 1000); // before the connection
    await CampaignMessage.create({ workspaceId: m.workspaceId, kind: 'promotion', customer: c._id, phone: '966500000010', status: 'sent', createdAt: before, sentAt: before });
    await CampaignMessage.create({ workspaceId: m.workspaceId, kind: 'promotion', customer: c._id, phone: '966500000010', status: 'failed' });
    await expect(set(m, 'done')).rejects.toMatchObject({ details: { reason: 'NO_PROMOTION_SENT' } });
    const other = await merchant();
    const oc = await customer(other, '966500000011');
    await CampaignMessage.create({ workspaceId: other.workspaceId, kind: 'promotion', customer: oc._id, phone: '966500000011', status: 'sent' });
    await expect(set(m, 'done')).rejects.toMatchObject({ details: { reason: 'NO_PROMOTION_SENT' } }); // another workspace's send does not count
    await CampaignMessage.create({ workspaceId: m.workspaceId, kind: 'promotion', customer: c._id, phone: '966500000010', status: 'sent', sentAt: new Date() });
    const r = await set(m, 'done');
    expect(r).toMatchObject({ state: 'done', sendPolicy: 'platform_number' });
    expect(await fp(m)).toMatchObject({ state: 'done' });
    expect((await fp(m)).doneAt).toBeInstanceOf(Date);
    expect((await OnboardingState.findOne({ workspaceId: m.workspaceId }).lean()).steps.promotion.status).toBe('done');
  });

  test('invalid state and a workspace that is not enrolled', async () => {
    const m = await merchant();
    await expect(set(m, 'locked')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'INVALID_STATE' } });
    await expect(firstPromotion.setFirstPromotionState({ workspaceId: String(new mongoose.Types.ObjectId()), state: 'skipped' }, deps)).rejects.toMatchObject({ code: 'ONBOARDING_NOT_AVAILABLE' });
  });
});

describe('routes (mini app, real modules)', () => {
  const { createRouter } = require('../../../routes/onboarding/test');
  function mkApp(m) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { id: m.userId, workspaceId: m.workspaceId, role: 'owner' }; next(); });
    app.use(createRouter({ moduleDeps: deps, rateLimitDeps: { limiter: require('../../../shared/onboarding/rateLimit').createLimiter() } }));
    return app;
  }

  test('GET /first-promotion and POST /first-promotion/state', async () => {
    const m = await merchant();
    await approve(m, 'promotion_weekend');
    const app = mkApp(m);
    const res = await request(app).get('/first-promotion');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ready: true, sendPolicy: 'block', testRecipient: { needsPhone: false } });
    expect(JSON.stringify(res.body)).not.toMatch(/EAAFXT|wf_[0-9a-f]{6}_/);
    const done = await request(app).post('/first-promotion/state').send({ state: 'done' });
    expect(done.status).toBe(422);
    expect(done.body.details.reason).toBe('SENDING_NOT_AVAILABLE_YET');
    const skipped = await request(app).post('/first-promotion/state').send({ state: 'skipped', workspaceId: 'ignored' });
    expect(skipped.status).toBe(200);
    expect(skipped.body.state).toBe('skipped');
  });
});
