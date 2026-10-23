'use strict';
const express = require('express');
const request = require('supertest');
const firstPromotion = require('../../../shared/onboarding/firstPromotion');
const { WS, WS2, USER, makeWorld, seedTemplate, flat } = require('./_b1eKit');

const SAVED = {};
beforeEach(() => { SAVED.p = process.env.ONBOARDING_LEGACY_SEND_POLICY; delete process.env.ONBOARDING_LEGACY_SEND_POLICY; });
afterEach(() => { if (SAVED.p === undefined) delete process.env.ONBOARDING_LEGACY_SEND_POLICY; else process.env.ONBOARDING_LEGACY_SEND_POLICY = SAVED.p; });

const approved = (w, key, language = 'en', extra = {}) => seedTemplate(w, {
  key, language, metaTemplateId: `${key}-${language}`, metaTemplateName: `wf_439011_${key}_${language}_v1`, metaStatus: 'APPROVED',
  source: key === 'setup_test' ? 'setup_test' : 'library', ...extra,
});
const get = (w, extra = {}) => firstPromotion.getFirstPromotion({ workspaceId: WS, userId: USER, ...extra }, w.deps);
// steps.markStep is always injected: the real one talks to the DB
const quietSteps = () => ({ markStep: jest.fn(async () => ({})) });
const set = (w, state, extraDeps = {}) => firstPromotion.setFirstPromotionState({ workspaceId: WS, state }, { ...w.deps, steps: quietSteps(), ...extraDeps });
const writes = (w) => ['Template', 'State', 'Conn', 'Event', 'Customer', 'User', 'Product', 'Service', 'Campaign']
  .flatMap((n) => w[n].calls.filter((c) => /^(create|update|findOneAndUpdate|delete)/.test(c[0])));

describe('getFirstPromotion: readiness', () => {
  test('nothing approved yet: not ready, template missing, the suggestion is still shown', async () => {
    const w = makeWorld();
    const r = await get(w);
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual({ audience: true, products: true, template: true });
    expect(r.suggestion.templateKey).toBe('promotion_weekend');
    expect(r.builderHint).toEqual({ path: '/promotions' });
    expect(r.state).toBe('locked');
  });

  test('connected + one approved library template: ready', async () => {
    const w = makeWorld();
    approved(w, 'promotion_weekend');
    const r = await get(w);
    expect(r.ready).toBe(true);
    expect(r.missing.template).toBe(false);
  });

  test('the setup test template alone does not make a Promotion possible', async () => {
    const w = makeWorld();
    approved(w, 'setup_test');
    const r = await get(w);
    expect(r.missing.template).toBe(true);
    expect(r.ready).toBe(false);
  });

  test.each([
    ['not connected', { connStatus: 'connecting' }],
    ['no connection', { connStatus: null }],
    ['needs reconnect', { needsReconnect: true }],
  ])('%s: never ready, even with an approved template', async (label, opts) => {
    const w = makeWorld(opts);
    approved(w, 'promotion_weekend');
    expect((await get(w)).ready).toBe(false);
  });

  test('audience and products are non-blocking "missing" hints', async () => {
    const w = makeWorld();
    approved(w, 'promotion_weekend');
    const none = await get(w);
    expect(none.missing).toEqual({ audience: true, products: true, template: false }); // no customer has agreed yet
    w.Customer.seed({ workspaceId: WS, phone: '966500000001', marketingConsent: false });
    const noConsent = await get(w);
    expect(noConsent.missing.audience).toBe(true);
    expect(noConsent.suggestion.audience).toEqual({ optedIn: 0, total: 1 });
    expect(noConsent.ready).toBe(true); // a Promotion can still be created and sent later
    w.Product.seed({ workspaceId: WS, name: 'Tea', active: true });
    expect((await get(w)).missing.products).toBe(false);
  });

  test('services count as something to promote; inactive products do not', async () => {
    const w = makeWorld();
    w.Product.seed({ workspaceId: WS, name: 'Old', active: false });
    expect((await get(w)).missing.products).toBe(true);
    w.Service.seed({ workspaceId: WS, name: 'Haircut', active: true });
    expect((await get(w)).missing.products).toBe(false);
  });
});

describe('getFirstPromotion: audience counts follow the marketing-consent rules', () => {
  test('optedIn counts marketingConsent:true and not optedOut; total counts the workspace; other workspaces are ignored', async () => {
    const w = makeWorld();
    w.Customer.seed({ workspaceId: WS, phone: '1', marketingConsent: true });
    w.Customer.seed({ workspaceId: WS, phone: '2', marketingConsent: true, optedOut: false });
    w.Customer.seed({ workspaceId: WS, phone: '3', marketingConsent: true, optedOut: true });
    w.Customer.seed({ workspaceId: WS, phone: '4', marketingConsent: false });
    w.Customer.seed({ workspaceId: WS2, phone: '5', marketingConsent: true });
    const r = await get(w);
    expect(r.suggestion.audience).toEqual({ optedIn: 2, total: 4 });
    const filters = w.Customer.calls.filter((c) => c[0] === 'countDocuments').map((c) => c[1]);
    expect(filters).toContainEqual({ workspaceId: WS, marketingConsent: true, optedOut: { $ne: true }, deletedAt: { $exists: false } }); // MARKETING_ELIGIBLE_QUERY + not erased
  });
  test('ruling 5: erased customers (deletedAt set) are in neither the opted-in nor the total audience count', async () => {
    const w = makeWorld();
    w.Customer.seed({ workspaceId: WS, phone: '1', marketingConsent: true });
    w.Customer.seed({ workspaceId: WS, phone: '2', marketingConsent: true, deletedAt: new Date('2026-10-01T00:00:00Z') });
    w.Customer.seed({ workspaceId: WS, phone: '3', marketingConsent: false, deletedAt: new Date('2026-10-01T00:00:00Z') });
    const r = await get(w);
    expect(r.suggestion.audience).toEqual({ optedIn: 1, total: 1 });
  });
});

describe('getFirstPromotion: the suggestion', () => {
  test('preference: weekend offer, or the new-arrivals product promotion when there are products; first APPROVED wins', async () => {
    const w = makeWorld();
    approved(w, 'comeback');
    expect((await get(w)).suggestion).toMatchObject({ templateKey: 'comeback', campaignType: 'store_wide_offer' });
    approved(w, 'promotion_weekend');
    expect((await get(w)).suggestion).toMatchObject({ templateKey: 'promotion_weekend', campaignType: 'store_wide_offer' });
    approved(w, 'promotion_new_arrival');
    expect((await get(w)).suggestion.templateKey).toBe('promotion_weekend'); // no products yet
    w.Product.seed({ workspaceId: WS, name: 'Tea', active: true });
    expect((await get(w)).suggestion).toMatchObject({ templateKey: 'promotion_new_arrival', campaignType: 'product_promotion' });
  });

  test('loyalty reminder maps to its campaign type; a non-promotion approved template is still a valid fallback', async () => {
    const w = makeWorld();
    approved(w, 'points_balance');
    expect((await get(w)).suggestion).toMatchObject({ templateKey: 'points_balance', campaignType: 'loyalty_reminder' });
    const w2 = makeWorld();
    approved(w2, 'order_confirmation');
    const r = await get(w2);
    expect(r.suggestion).toMatchObject({ templateKey: 'order_confirmation', campaignType: 'store_wide_offer' });
    expect(r.missing.template).toBe(false);
  });

  test('titles and a rendered preview in both languages (sample values, no raw placeholders)', async () => {
    const w = makeWorld();
    const r = await get(w);
    expect(r.suggestion.titleKey).toBe('onboarding.promotion.first.suggest');
    expect(r.suggestion.title).toEqual({ en: 'Weekend offer', ar: expect.any(String) });
    expect(r.suggestion.bodyPreview.en).toMatch(/weekend offer/i);
    expect(r.suggestion.bodyPreview.ar).toMatch(/[\u{0600}-\u{06FF}]/u);
    for (const lang of ['en', 'ar']) {
      expect(r.suggestion.bodyPreview[lang]).not.toMatch(/[{}]/);
      expect(r.suggestion.bodyPreview[lang]).not.toMatch(/[\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u);
    }
  });

  test('the campaign types are the ones the Promotions builder accepts', async () => {
    const valid = new Set(['store_wide_offer', 'product_promotion', 'loyalty_reminder']);
    for (const key of ['promotion_weekend', 'promotion_new_arrival', 'comeback', 'points_balance', 'order_confirmation', 'booking_confirmation']) {
      const w = makeWorld();
      approved(w, key);
      expect(valid.has((await get(w)).suggestion.campaignType)).toBe(true);
    }
  });
});

describe('getFirstPromotion: send policy and test recipient', () => {
  test('sendPolicy is block by default and platform_number only by the explicit opt-in', async () => {
    const w = makeWorld();
    expect((await get(w)).sendPolicy).toBe('block');
    process.env.ONBOARDING_LEGACY_SEND_POLICY = 'platform_number';
    expect((await get(w)).sendPolicy).toBe('platform_number');
    process.env.ONBOARDING_LEGACY_SEND_POLICY = 'anything else';
    expect((await get(w)).sendPolicy).toBe('block');
  });

  test('testRecipient: the login phone masked, or needsPhone for an e-mail-login OWNER', async () => {
    const w = makeWorld();
    expect((await get(w)).testRecipient).toEqual({ masked: '********4567', needsPhone: false });
    const w2 = makeWorld({ userPhone: null });
    expect((await get(w2)).testRecipient).toEqual({ masked: null, needsPhone: true });
    w2.State.rows[0].firstPromotion.testPhoneMasked = '********9999';
    expect((await get(w2)).testRecipient).toEqual({ masked: '********9999', needsPhone: true });
    expect(flat(await get(w))).not.toContain('966501234567');
  });

  test('testRecipient (review R2-03): a member without a login phone, or a user with no live Membership, is never asked for a number', async () => {
    for (const role of ['member', null]) {
      const w = makeWorld({ userPhone: null, role });
      w.State.rows[0].firstPromotion.testNumberMasked = '********9999'; // the workspace's number is the owner's business, not a member's
      expect((await get(w)).testRecipient).toEqual({ masked: null, needsPhone: false });
    }
    // the owner sees the workspace test number masked; the newer field wins over the legacy one
    const w = makeWorld({ userPhone: null });
    Object.assign(w.State.rows[0].firstPromotion, { testPhoneMasked: '********1111', testNumberMasked: '********2222' });
    expect((await get(w)).testRecipient).toEqual({ masked: '********2222', needsPhone: true });
    // a user WITH a login phone is served from that phone whatever the role
    expect((await get(makeWorld({ role: 'member' }))).testRecipient).toEqual({ masked: '********4567', needsPhone: false });
    // the role is read live: a failing Membership read counts as "not an owner" (fail closed), the rest of the answer is unaffected
    const broken = makeWorld({ userPhone: null });
    broken.Membership.failWith = new Error('db down');
    expect(await get(broken)).toMatchObject({ testRecipient: { masked: null, needsPhone: false }, missing: { template: true }, state: 'locked' });
  });

  test('the state of the hand-off is reported', async () => {
    const w = makeWorld();
    w.State.rows[0].firstPromotion.state = 'skipped';
    expect((await get(w)).state).toBe('skipped');
  });
});

describe('getFirstPromotion: read-only, fail-soft, tenant-safe', () => {
  test('it never writes anything', async () => {
    const w = makeWorld();
    approved(w, 'promotion_weekend');
    await get(w);
    expect(writes(w)).toEqual([]);
  });

  test('a failing read degrades the answer, it does not break the screen', async () => {
    const w = makeWorld();
    approved(w, 'promotion_weekend');
    w.Customer.failWith = new Error('db down');
    w.Product.failWith = new Error('db down');
    const r = await get(w);
    expect(r.ready).toBe(true);
    expect(r.suggestion.audience).toEqual({ optedIn: 0, total: 0 });
    expect(r.missing.audience).toBe(false); // unknown, not "missing"
    expect(r.missing.products).toBe(false);
  });

  test('another workspace\'s templates, customers and connection are never used', async () => {
    const w = makeWorld();
    w.Template.seed({ workspaceId: WS2, key: 'promotion_weekend', language: 'en', metaTemplateName: 'x', metaStatus: 'APPROVED', source: 'library' });
    w.Customer.seed({ workspaceId: WS2, phone: '1', marketingConsent: true });
    const r = await firstPromotion.getFirstPromotion({ workspaceId: WS2, userId: USER }, w.deps);
    expect(r.ready).toBe(false); // WS2 has no connection row
    expect(r.suggestion.audience).toEqual({ optedIn: 1, total: 1 });
    const mine = await get(w);
    expect(mine.missing.template).toBe(true);
    expect(mine.suggestion.audience).toEqual({ optedIn: 0, total: 0 });
  });
});

describe('setFirstPromotionState', () => {
  test('rejects anything but started | skipped | done', async () => {
    const w = makeWorld();
    for (const bad of ['', 'ready', 'locked', 'DONE', undefined, null, 5]) {
      await expect(set(w, bad)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, details: { reason: 'INVALID_STATE' } });
    }
    expect(writes(w)).toEqual([]);
  });

  test('policy block (default): skipped and started are accepted, done is refused with the reason', async () => {
    const w = makeWorld();
    const s1 = await set(w, 'started');
    expect(s1).toMatchObject({ state: 'started', sendPolicy: 'block' });
    expect(s1.firstPromotion.startedAt).toEqual(w.clock.now());
    expect(w.State.rows[0].firstPromotion).toMatchObject({ state: 'started', startedAt: w.clock.now() });
    await expect(set(w, 'done')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, details: { reason: 'SENDING_NOT_AVAILABLE_YET', sendPolicy: 'block' } });
    expect(w.State.rows[0].firstPromotion.state).toBe('started');
    const s2 = await set(w, 'skipped');
    expect(s2).toMatchObject({ state: 'skipped', sendPolicy: 'block' });
    expect(w.State.rows[0].firstPromotion.state).toBe('skipped');
  });

  test('done is refused under block even when promotions were sent (the platform number is never a merchant\'s sender)', async () => {
    const w = makeWorld();
    w.Campaign.seed({ workspaceId: WS, kind: 'promotion', status: 'sent', createdAt: new Date('2026-10-15T08:00:00Z') });
    await expect(set(w, 'done')).rejects.toMatchObject({ details: { reason: 'SENDING_NOT_AVAILABLE_YET' } });
  });

  test('started never moves a finished state backwards; skipped does not undo done', async () => {
    const w = makeWorld();
    await set(w, 'skipped');
    expect((await set(w, 'started')).state).toBe('skipped');
    w.State.rows[0].firstPromotion.state = 'done';
    expect((await set(w, 'started')).state).toBe('done');
    expect((await set(w, 'skipped')).state).toBe('done');
  });

  test('the second started keeps the first startedAt', async () => {
    const w = makeWorld();
    await set(w, 'started');
    const first = w.State.rows[0].firstPromotion.startedAt;
    w.clock.advance(60000);
    await set(w, 'started');
    expect(w.State.rows[0].firstPromotion.startedAt).toEqual(first);
  });

  describe('policy platform_number', () => {
    beforeEach(() => { process.env.ONBOARDING_LEGACY_SEND_POLICY = 'platform_number'; });

    test('done only when a promotion message was created since the connection (read-only count)', async () => {
      const w = makeWorld();
      await expect(set(w, 'done')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'NO_PROMOTION_SENT' } });
      w.Campaign.seed({ workspaceId: WS, kind: 'promotion', status: 'failed', createdAt: new Date('2026-10-15T08:00:00Z') });
      w.Campaign.seed({ workspaceId: WS, kind: 'consent_request', status: 'sent', createdAt: new Date('2026-10-15T08:00:00Z') });
      w.Campaign.seed({ workspaceId: WS, kind: 'promotion', status: 'sent', createdAt: new Date('2026-10-13T08:00:00Z') }); // before connectedAt
      w.Campaign.seed({ workspaceId: WS2, kind: 'promotion', status: 'sent', createdAt: new Date('2026-10-15T08:00:00Z') });
      await expect(set(w, 'done')).rejects.toMatchObject({ details: { reason: 'NO_PROMOTION_SENT' } });
      w.Campaign.seed({ workspaceId: WS, kind: 'promotion', status: 'sent', createdAt: new Date('2026-10-15T08:30:00Z') });
      const r = await set(w, 'done');
      expect(r).toMatchObject({ state: 'done', sendPolicy: 'platform_number' });
      expect(w.State.rows[0].firstPromotion).toMatchObject({ state: 'done', doneAt: w.clock.now() });
    });

    test('best effort: when the count itself fails, done is accepted', async () => {
      const w = makeWorld();
      w.Campaign.failWith = new Error('db down');
      await expect(set(w, 'done')).resolves.toMatchObject({ state: 'done' });
    });

    test('done needs a connection with a connectedAt', async () => {
      const w = makeWorld({ connStatus: null });
      await expect(set(w, 'done')).rejects.toMatchObject({ details: { reason: 'NOT_CONNECTED' } });
    });
  });

  test('the "promotion" step is marked best-effort (in_progress / skipped / done); a failing steps module does not break the answer', async () => {
    const w = makeWorld();
    const steps = { markStep: jest.fn(async () => ({})) };
    await set(w, 'started', { steps });
    await set(w, 'skipped', { steps });
    expect(steps.markStep.mock.calls.map((c) => c.slice(0, 3))).toEqual([[WS, 'promotion', 'in_progress'], [WS, 'promotion', 'skipped']]);
    process.env.ONBOARDING_LEGACY_SEND_POLICY = 'platform_number';
    const w2 = makeWorld();
    const broken = { markStep: jest.fn(() => { const e = new Error('later'); e.code = 'NOT_IMPLEMENTED'; throw e; }) };
    await expect(set(w2, 'skipped', { steps: broken })).resolves.toMatchObject({ state: 'skipped' });
    expect(w2.State.rows[0].firstPromotion.state).toBe('skipped');
  });

  test('a workspace that is not enrolled is not available; another workspace\'s state is never touched', async () => {
    const w = makeWorld();
    await expect(firstPromotion.setFirstPromotionState({ workspaceId: WS2, state: 'skipped' }, { ...w.deps, steps: quietSteps() })).rejects.toMatchObject({ code: 'ONBOARDING_NOT_AVAILABLE', status: 404 });
    expect(w.State.rows[0].firstPromotion.state).toBe('locked');
  });
});

describe('routes (mini app)', () => {
  const { createRouter } = require('../../../routes/onboarding/test');
  const mkApp = (w, user = { id: USER, workspaceId: WS, role: 'owner' }) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = user; next(); });
    app.use(createRouter({ moduleDeps: { ...w.deps, steps: quietSteps() }, rateLimitDeps: { limiter: require('../../../shared/onboarding/rateLimit').createLimiter() } }));
    return app;
  };

  test('GET /first-promotion', async () => {
    const w = makeWorld();
    approved(w, 'promotion_weekend');
    const res = await request(mkApp(w)).get('/first-promotion');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ready: true, sendPolicy: 'block', builderHint: { path: '/promotions' }, testRecipient: { masked: '********4567', needsPhone: false } });
    expect(res.body.suggestion).toMatchObject({ templateKey: 'promotion_weekend', campaignType: 'store_wide_offer' });
  });

  test('POST /first-promotion/state: skipped ok, done refused under block, invalid state 422, non-string ignored', async () => {
    const w = makeWorld();
    const app = mkApp(w);
    const done = await request(app).post('/first-promotion/state').send({ state: 'done' });
    expect(done.status).toBe(422);
    expect(done.body).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'SENDING_NOT_AVAILABLE_YET' } });
    expect((await request(app).post('/first-promotion/state').send({ state: { $ne: 1 } })).status).toBe(422);
    expect((await request(app).post('/first-promotion/state').send({})).status).toBe(422);
    const ok = await request(app).post('/first-promotion/state').send({ state: 'skipped' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: 'skipped', sendPolicy: 'block' });
  });

  test('the workspace comes from the token', async () => {
    const w = makeWorld();
    const res = await request(mkApp(w, { id: 'x', workspaceId: WS2, role: 'owner' })).post('/first-promotion/state').send({ workspaceId: WS, state: 'skipped' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ONBOARDING_NOT_AVAILABLE');
    expect(w.State.rows[0].firstPromotion.state).toBe('locked');
  });
});
