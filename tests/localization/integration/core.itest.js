const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();
const h = require('./helpers/_harness');
const LocaleSettings = require('../../../models/LocaleSettings');
const UserLocalePreference = require('../../../models/UserLocalePreference');
const CustomerLanguage = require('../../../models/CustomerLanguage');
const LocalizedTemplate = require('../../../models/LocalizedTemplate');
const ProductTranslation = require('../../../models/ProductTranslation');
const Product = require('../../../models/Product');
const Service = require('../../../models/Service');
const settings = require('../../../shared/localization/settings');
const customerLanguage = require('../../../shared/localization/customerLanguage');

// Every gated router, one cheap request each (the gate answers before any handler runs, so no AI/Meta/WhatsApp code is reached).
const OID = '000000000000000000000001';
const GATED = [
  ['get', '/customers'], ['get', '/customers/language/template.csv'], ['put', `/customers/${OID}/language`], ['post', '/customers/language/bulk'],
  ['get', '/templates'], ['get', '/templates/library'], ['get', '/templates/meta-usage'], ['post', '/templates'], ['post', `/templates/${OID}/variants/en/submit`],
  ['get', '/campaigns'], ['get', '/campaigns/segments'], ['post', '/campaigns/plan'], ['post', `/campaigns/${OID}/send`],
  ['post', '/ai/translate'], ['post', '/ai/saudi-friendly'], ['post', '/ai/reply-in-arabic'],
  ['get', '/catalog/items'], ['get', '/catalog/export.csv'], ['put', `/catalog/product/${OID}/translation`],
  ['get', '/inbox/conversations'], ['get', `/inbox/conversations/${OID}/context`], ['post', `/inbox/conversations/${OID}/payment-link`],
  ['post', '/ai-mode/message'], ['post', '/ai-mode/confirm'], ['get', '/ai-mode/insights'], ['get', `/ai-mode/session/${OID}`],
  ['get', '/flows/messages'], ['post', `/flows/messages/${OID}/localize`],
  ['get', '/review/summary'],
];
const UNGATED = [['get', '/settings'], ['get', '/settings/overview'], ['get', '/settings/me']];

describe('gating, settings, overview and review summary on real MongoDB', () => {
  let ctx; let a; let b; let c;
  beforeAll(async () => {
    ctx = await h.setup();
    a = ctx.api(ctx.A); b = ctx.api(ctx.B); c = ctx.api(ctx.C);
  });

  describe('every router: 401 without a token, 402 ARABIC_NOT_ENABLED for an unflagged workspace', () => {
    test.each(GATED)('%s %s', async (verb, url) => {
      const anon = await ctx.anon[verb](url).send({});
      expect(anon.status).toBe(401);
      const bad = await h.request(ctx.app)[verb](`/api/localization${url}`).set('Authorization', 'Bearer not.a.jwt').send({});
      expect(bad.status).toBe(401);
      const gated = await c[verb](url).send({});
      expect(gated.status).toBe(402);
      expect(gated.body.code).toBe('ARABIC_NOT_ENABLED');
    });

    test.each(UNGATED)('%s %s works for the unflagged workspace (the locked-state UI needs it) but still needs a token', async (verb, url) => {
      expect((await ctx.anon[verb](url)).status).toBe(401);
      expect((await c[verb](url)).status).toBe(200);
    });

    test('a token for a workspace with no LocaleSettings at all is gated, not a 500', async () => {
      const ghost = h.tokenFor('000000000000000000000002', '000000000000000000000003');
      const r = await h.request(ctx.app).get('/api/localization/customers').set('Authorization', `Bearer ${ghost}`);
      expect(r.status).toBe(402);
    });
  });

  describe('flag semantics on the real collection', () => {
    test('reads never create documents (the webhook hook calls isArabicEnabled for every inbound message)', async () => {
      const fresh = await h.makeTenant('Fresh', { flagged: false });
      expect(await settings.isArabicEnabled(fresh.wsId)).toBe(false);
      await settings.getSettings(fresh.wsId);
      await ctx.api(fresh).get('/settings');
      await ctx.api(fresh).get('/settings/overview');
      expect(await LocaleSettings.countDocuments({ workspaceId: fresh.wsId })).toBe(0);
    });

    test('cache: a direct DB flip is invisible until invalidate(); setArabicEnabled invalidates immediately', async () => {
      const t = await h.makeTenant('Cache', { flagged: false });
      expect(await settings.isArabicEnabled(t.wsId)).toBe(false); // cached false
      await LocaleSettings.create({ workspaceId: t.wsId, arabicEnabled: true });
      expect(await settings.isArabicEnabled(t.wsId)).toBe(false); // still cached (<= 30 s)
      settings.invalidate(t.wsId);
      expect(await settings.isArabicEnabled(t.wsId)).toBe(true);
      await settings.setArabicEnabled({ workspaceId: t.wsId, enabled: false, grantedBy: 'itest' });
      expect(await settings.isArabicEnabled(t.wsId)).toBe(false);
      expect((await ctx.api(t).get('/customers')).status).toBe(402);
      await settings.setArabicEnabled({ workspaceId: t.wsId, enabled: true, grantedBy: 'itest', notes: 'pilot' });
      expect((await ctx.api(t).get('/customers')).status).toBe(200);
      const doc = await LocaleSettings.findOne({ workspaceId: t.wsId }).lean();
      expect(doc).toMatchObject({ arabicEnabled: true, arabicEnabledBy: 'itest', notes: 'pilot' });
      expect(doc.arabicEnabledAt).toBeTruthy();
    });

    test('kill switch: LOCALIZATION_DISABLED closes the gate for flagged workspaces and isArabicEnabled reports false', async () => {
      for (const value of ['1', 'true']) {
        process.env.LOCALIZATION_DISABLED = value; settings.clearCache();
        try {
          expect(settings.killSwitchOn()).toBe(true);
          expect(await settings.isArabicEnabled(ctx.A.wsId)).toBe(false);
          const r = await a.get('/customers');
          expect(r.status).toBe(402); expect(r.body.code).toBe('ARABIC_NOT_ENABLED');
          expect((await a.get('/settings')).status).toBe(200); // settings stay readable
        } finally { delete process.env.LOCALIZATION_DISABLED; settings.clearCache(); }
      }
      expect((await a.get('/customers')).status).toBe(200);
    });

    test('the unique index on LocaleSettings.workspaceId exists', async () => {
      await expect(LocaleSettings.create({ workspaceId: ctx.A.wsId })).rejects.toMatchObject({ code: 11000 });
    });
  });

  describe('/settings', () => {
    test('merchant fields are writable; the flag is not (not by the owner, not via a body workspaceId)', async () => {
      const put = await a.put('/settings').send({ defaultCustomerLanguage: 'ar', bilingualOrder: 'en_first' });
      expect(put.status).toBe(200); expect(put.body).toMatchObject({ arabicEnabled: true, defaultCustomerLanguage: 'ar', bilingualOrder: 'en_first' });
      const attack = await c.put('/settings').send({ arabicEnabled: true, workspaceId: String(ctx.A.wsId), defaultCustomerLanguage: 'en' });
      expect(attack.status).toBe(200); expect(attack.body.arabicEnabled).toBe(false);
      expect((await c.get('/customers')).status).toBe(402);
      expect((await a.get('/settings')).body.defaultCustomerLanguage).toBe('ar'); // A untouched by C's body
      expect((await LocaleSettings.findOne({ workspaceId: ctx.C.wsId }).lean()).arabicEnabled).toBe(false);
    });

    test('invalid values and operator bodies are 400s', async () => {
      expect((await a.put('/settings').send({ defaultCustomerLanguage: 'fr' })).status).toBe(400);
      expect((await a.put('/settings').send({ defaultCustomerLanguage: { $ne: null } })).status).toBe(400);
      expect((await a.put('/settings').send({ bilingualOrder: ['ar_first'] })).status).toBe(400);
      expect((await a.put('/settings/me').send({ uiLanguage: { $gt: '' } })).status).toBe(400);
      expect((await a.put('/settings/me').send({ aiLanguage: 'klingon' })).status).toBe(400);
    });

    test('8 concurrent first-time PUTs for a new workspace all succeed and leave one row (upsert vs unique index)', async () => {
      const t = await h.makeTenant('Upsert', { flagged: false });
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => ctx.api(t).put('/settings').send({ defaultCustomerLanguage: i % 2 ? 'ar' : 'en' })));
      expect(rs.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(await LocaleSettings.countDocuments({ workspaceId: t.wsId })).toBe(1);
      const me = await Promise.all(Array.from({ length: 8 }, (_, i) => ctx.api(t).put('/settings/me').send({ uiLanguage: i % 2 ? 'ar' : 'en' })));
      expect(me.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(await UserLocalePreference.countDocuments({ workspaceId: t.wsId, userId: t.userId })).toBe(1);
    });

    test('/settings/me is per user and per workspace', async () => {
      await a.put('/settings/me').send({ uiLanguage: 'ar', aiLanguage: 'ar' });
      expect((await a.get('/settings/me')).body).toEqual({ uiLanguage: 'ar', aiLanguage: 'ar' });
      expect((await b.get('/settings/me')).body).toEqual({ uiLanguage: 'en', aiLanguage: 'auto' });
      const crossToken = h.tokenFor(ctx.A.userId, ctx.B.wsId, 'member');
      const r = await h.request(ctx.app).get('/api/localization/settings/me').set('Authorization', `Bearer ${crossToken}`);
      expect(r.body).toEqual({ uiLanguage: 'en', aiLanguage: 'auto' });
    });
  });

  describe('overview + review summary aggregations ($exists:false / $ne filters) with real documents', () => {
    const W = {};
    beforeAll(async () => {
      W.t = await h.makeTenant('Overview', { flagged: true });
      const ws = W.t.wsId;
      W.api = ctx.api(W.t);
      const mk = (extra) => h.makeCustomer(ws, extra);
      W.en = await mk({}); W.ar = await mk({}); W.unknownRow = await mk({}); W.none = await mk({});
      W.erased = await mk({ deletedAt: new Date() }); W.demo = await mk({ isDemo: true });
      await CustomerLanguage.create({ workspaceId: ws, customerId: W.en._id, language: 'en', languageSource: 'merchant_set' });
      await CustomerLanguage.create({ workspaceId: ws, customerId: W.ar._id, language: 'ar', languageSource: 'merchant_set' });
      await CustomerLanguage.create({ workspaceId: ws, customerId: W.unknownRow._id, language: 'unknown' });
      // sidecar rows of customers outside the managed set (erased / demo)
      await CustomerLanguage.create({ workspaceId: ws, customerId: W.erased._id, language: 'ar', languageSource: 'merchant_set' });
      await CustomerLanguage.create({ workspaceId: ws, customerId: W.demo._id, language: 'en', languageSource: 'merchant_set' });
      // another tenant's rows must never count
      const other = await h.makeCustomer(ctx.B.wsId, {});
      await CustomerLanguage.create({ workspaceId: ctx.B.wsId, customerId: other._id, language: 'ar', languageSource: 'merchant_set' });
      const v = (language, metaStatus, reviewStatus, body = 'نص') => ({ language, metaStatus, reviewStatus, body });
      await LocalizedTemplate.create({ workspaceId: ws, key: 'o1', name: 'o1', variants: [v('en', 'APPROVED', 'draft', 'en'), v('ar', 'APPROVED', 'reviewed')] });
      await LocalizedTemplate.create({ workspaceId: ws, key: 'o2', name: 'o2', variants: [v('ar', 'PENDING', 'draft'), v('bilingual', 'REJECTED', 'draft')] });
      await LocalizedTemplate.create({ workspaceId: ws, key: 'o3', name: 'o3', variants: [v('ar', 'NOT_CREATED', 'draft'), v('bilingual', 'NOT_CREATED', 'draft', '   ')] }); // blank body is not counted
      await LocalizedTemplate.create({ workspaceId: ws, key: 'o4', name: 'o4', archived: true, variants: [v('ar', 'APPROVED', 'draft')] }); // archived: ignored
      await LocalizedTemplate.create({ workspaceId: ws, key: 'o5', name: 'o5', variants: [v('en', 'APPROVED', 'draft')] }); // English only
      const p1 = await Product.create({ workspaceId: ws, name: 'P1', category: 'c', basePrice: 1 });
      await Product.create({ workspaceId: ws, name: 'P2', category: 'c', basePrice: 1 });
      await Product.create({ workspaceId: ws, name: 'P3 inactive', category: 'c', basePrice: 1, active: false });
      const s1 = await Service.create({ workspaceId: ws, name: 'S1' });
      await ProductTranslation.create({ workspaceId: ws, kind: 'product', refId: p1._id, name: 'م١', status: 'reviewed' });
      await ProductTranslation.create({ workspaceId: ws, kind: 'service', refId: s1._id, name: 'خ١' });
    });

    test('overview counts: customers by language ignore erased/demo sidecar rows and other tenants', async () => {
      const r = await W.api.get('/settings/overview');
      expect(r.status).toBe(200);
      // 4 managed customers: one en, one ar, two without a usable language
      expect(r.body.customers).toEqual({ total: 4, en: 1, ar: 1, unknown: 2 });
      expect(await customerLanguage.getCounts(W.t.wsId)).toMatchObject({ en: 1, ar: 1, unknown: 2, total: 4 }); // the customers page agrees with the hub
    });

    test('overview template buckets: Arabic + bilingual variants only, archived and blank ones excluded', async () => {
      const r = await W.api.get('/settings/overview');
      expect(r.body.templates).toMatchObject({ total: 4, withArabic: 3, arabicApproved: 1, arabicPending: 1, arabicRejected: 1, arabicNotSubmitted: 1, arabicOther: 0 });
      expect(r.body.review.templatesDraft).toBe(3);
    });

    test('review summary: template draft/reviewed and catalogue draft/reviewed/missing from real counts', async () => {
      const r = await W.api.get('/review/summary');
      expect(r.status).toBe(200);
      expect(r.body.templates).toEqual({ draft: 3, reviewed: 1 });
      expect(r.body.catalog).toEqual({ draft: 1, reviewed: 1, missing: 1 }); // P2 has no translation; inactive P3 not counted
      expect(r.body.backendStrings.total).toBeGreaterThan(0);
    });

    test('the unflagged workspace gets zeros from the overview and 402 from the review summary', async () => {
      const r = await c.get('/settings/overview');
      expect(r.body.customers).toEqual({ total: 0, en: 0, ar: 0, unknown: 0 });
      expect((await c.get('/review/summary')).status).toBe(402);
      const rb = await b.get('/review/summary');
      expect(rb.body.templates).toEqual({ draft: 0, reviewed: 0 });
    });
  });
});
