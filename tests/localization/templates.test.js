// Unit tests of the templates service: every collaborator is injected (an in-memory
// store with the same single-document atomicity as MongoDB, a fake Meta client, a
// fake transport), so no database, network or WhatsApp call can happen. The real
// Mongoose store is covered separately below with a recording fake model, and the
// documents the service writes are validated against the REAL Mongoose schema.
jest.mock('../../utils/whatsapp', () => { throw new Error('utils/whatsapp.js must not be loaded by these tests'); });
jest.mock('../../utils/tokenManager', () => { throw new Error('utils/tokenManager.js must not be loaded by these tests'); });

const svcModule = require('../../shared/localization/templates');
const { createTemplatesService, createMongoStore, createRateLimiter, TemplateError, internals } = svcModule;
const mt = require('../../shared/localization/metaTemplates');
const catalog = require('../../shared/localization/catalog');
const { classifyInboundText } = require('../../shared/localization/keywords');
const { LRM } = require('../../shared/localization/arabicText');

const WS = '65a1b2c3d4e5f60718293a4b';
const WS2 = '75a1b2c3d4e5f60718293a4b';
const USER = '85a1b2c3d4e5f60718293a4b';
const NODE = '95a1b2c3d4e5f60718293a4b';
const WS3 = '75a1b2c3d4e5f607182940ff'; // a workspace whose last 6 hex digits (the Meta name prefix) differ from WS and WS2
const CUSTOMER = 'a5a1b2c3d4e5f60718293a4b';
const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const OPT_OUT_EN = { role: 'opt_out', text: 'Opt Out' };
const OPT_OUT_AR = { role: 'opt_out', text: 'إلغاء الاشتراك' };
const EN = { body: 'Hi {name}, you have {points} points to use this week.', buttons: [OPT_OUT_EN] };
const AR = { body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}. استبدلها هذا الأسبوع.', buttons: [OPT_OUT_AR] };
const BI = { body: 'مرحباً {name}، لدينا عرض جديد لك اليوم.\n\nHello {name}, we have a new offer for you today.', buttons: [OPT_OUT_AR] };

// ── fakes ────────────────────────────────────────────────────────────────
function makeMemoryStore(now) {
  const docs = [];
  const writes = [];
  let seq = 0;
  const find = (ws, id) => docs.find((d) => d._id === id && d.workspaceId === ws);
  const guardMatches = (v, guard) => Object.entries(guard || {}).every(([k, want]) => (v[k] === undefined ? null : v[k]) === want);
  return {
    docs,
    writes,
    async create(doc) {
      writes.push('create');
      if (docs.some((d) => d.workspaceId === doc.workspaceId && d.key === doc.key)) throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
      seq += 1;
      const stored = structuredClone({ ...doc, _id: seq.toString(16).padStart(24, '0'), createdAt: now(), updatedAt: now() });
      docs.push(stored);
      return structuredClone(stored);
    },
    async findOne(ws, id) {
      const d = find(ws, id);
      return d ? structuredClone(d) : null;
    },
    async list(ws, { useCase, archived } = {}) {
      return docs
        .filter((d) => d.workspaceId === ws && (!useCase || d.useCase === useCase)
          && (archived === 'only' ? d.archived === true : archived === 'include' ? true : d.archived !== true))
        .map((d) => structuredClone(d));
    },
    async setFields(ws, id, set) {
      writes.push('setFields');
      const d = find(ws, id);
      if (!d) return false;
      Object.assign(d, structuredClone(set));
      d.updatedAt = now();
      return true;
    },
    async insertVariant(ws, id, language, variantDoc) {
      writes.push('insertVariant');
      const d = find(ws, id);
      if (!d || d.variants.some((v) => v.language === language)) return false;
      d.variants.push(structuredClone(variantDoc));
      d.updatedAt = now();
      return true;
    },
    async updateVariant(ws, id, language, { guard, set, unset, inc } = {}) {
      writes.push('updateVariant');
      const d = find(ws, id);
      const v = d && d.variants.find((x) => x.language === language && guardMatches(x, guard));
      if (!v) return false;
      Object.assign(v, structuredClone(set || {}));
      for (const key of unset || []) delete v[key];
      for (const [key, by] of Object.entries(inc || {})) v[key] = (v[key] || 0) + by;
      d.updatedAt = now();
      return true;
    },
    async findByMetaNames(names, limit) {
      return docs.filter((d) => d.variants.some((v) => names.includes(v.metaTemplateName))).slice(0, limit).map((d) => structuredClone(d));
    },
    async findRefreshCandidates({ statuses, limit }) {
      return docs
        .filter((d) => d.archived !== true && d.variants.some((v) => statuses.includes(v.metaStatus) && v.metaTemplateName))
        .slice(0, limit)
        .map((d) => structuredClone(d));
    },
  };
}

function makeMeta() {
  const m = {
    configured: true,
    assertCalls: 0,
    submitCalls: [],
    listCalls: [],
    rows: new Map(),
    submitImpl: null,
    listImpl: null,
    async assertConfigured() {
      m.assertCalls += 1;
      if (!m.configured) throw new mt.MetaNotConfiguredError('no token');
      return true;
    },
    async submitTemplate(payload) {
      m.submitCalls.push(payload);
      if (m.submitImpl) return m.submitImpl(payload);
      return { id: `tpl-${m.submitCalls.length}`, status: 'PENDING', category: payload.category };
    },
    async listTemplatesByName(name) {
      m.listCalls.push(name);
      if (m.listImpl) return m.listImpl(name);
      return m.rows.get(name) || [];
    },
    // GET /{id}: the row with that id (any name), or null when Graph does not know it.
    byIdCalls: [],
    byIdImpl: null,
    async getTemplateById(id) {
      m.byIdCalls.push(id);
      if (m.byIdImpl) return m.byIdImpl(id);
      for (const rows of m.rows.values()) {
        const row = rows.find((r) => String(r.id) === String(id));
        if (row) return { ...row };
      }
      return null;
    },
    sinceCalls: [],
    sinceRows: [],
    async listTemplatesSince({ since } = {}) {
      m.sinceCalls.push(since);
      return m.sinceRows;
    },
    usage: { used: 15, limit: 250 },
    usageCalls: 0,
    async getUsage() {
      m.usageCalls += 1;
      if (m.usage instanceof Error) throw m.usage;
      return m.usage;
    },
  };
  return m;
}

function makeTransport() {
  const t = {
    dry: false,
    fail: null,
    sent: [],
    isDryRun: () => t.dry,
    sendTemplate: jest.fn(async (to, args) => {
      if (t.fail) throw t.fail;
      t.sent.push({ to, args });
      return { messages: [{ id: 'wamid.TEST' }] };
    }),
  };
  return t;
}

function setup(over = {}) {
  const clock = { t: T0 };
  const now = () => new Date(clock.t);
  const store = makeMemoryStore(now);
  const meta = makeMeta();
  const transport = makeTransport();
  const enabled = new Set([WS, WS2]);
  const names = { [USER]: 'Noura Al-Harbi' };
  const customers = new Map([[`${WS}:${CUSTOMER}`, { _id: CUSTOMER, firstname: 'Fahad', lastname: 'Al-Qahtani', loyaltyPoints: 250 }]]);
  const library = { listLibrary: jest.fn(() => []), getLibraryEntry: jest.fn(() => null) };
  const deps = {
    store,
    metaClient: meta,
    transport,
    now,
    log: jest.fn(),
    isArabicEnabled: jest.fn(async (ws) => enabled.has(ws)),
    getBilingualOrder: jest.fn(async () => 'ar_first'),
    getReviewerName: jest.fn(async (uid) => names[uid] || null),
    getDefaultCountryCode: jest.fn(async () => '966'),
    getBusinessName: jest.fn(async () => 'متجر الورد'),
    findCustomer: jest.fn(async (ws, id) => customers.get(`${ws}:${id}`) || null),
    getLibrary: () => library,
    getCeiling: () => 90,
    testSendLimiter: createRateLimiter({ limit: 10, windowMs: HOUR, now: () => clock.t }),
    refreshLimiter: createRateLimiter({ limit: 10, windowMs: MIN, now: () => clock.t }),
    ...over,
  };
  const svc = createTemplatesService(deps);
  const advance = (ms) => { clock.t += ms; };
  return { svc, store, meta, transport, deps, clock, advance, enabled, names, customers, library };
}

const seed = (svc, over = {}) => svc.createTemplate({
  workspaceId: WS, userId: USER, name: 'Loyalty reminder', useCase: 'loyalty_reminder',
  variants: [{ language: 'en', ...EN }, { language: 'ar', ...AR }], ...over,
});
const variantOf = (view, language) => view.variants.find((v) => v.language === language);
const storedVariant = (store, language, index = 0) => store.docs[index].variants.find((v) => v.language === language);
const codes = (issues) => issues.map((i) => i.code);

async function rejects(promise, props) {
  let error;
  try { await promise; } catch (e) { error = e; }
  expect(error).toBeInstanceOf(TemplateError);
  expect(error).toMatchObject(props);
  return error;
}

// Submit a variant and have "Meta" approve it; returns the Meta name.
async function approve(ctx, id, language, { category } = {}) {
  const res = await ctx.svc.submitVariant({ workspaceId: WS, id, language });
  const name = res.submission.metaTemplateName;
  ctx.meta.rows.set(name, [{ id: `meta-${name}`, name, language: res.template.variants.find((v) => v.language === language) ? mt.metaLanguageFor({ language }) : 'en', status: 'APPROVED', category: category || 'MARKETING' }]);
  await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: id });
  return name;
}

// ── views ────────────────────────────────────────────────────────────────
describe('toTemplateView', () => {
  const doc = (variants = [], over = {}) => ({ _id: WS, key: 'k', name: 'N', useCase: 'custom', category: 'MARKETING', variants, createdAt: new Date(T0), updatedAt: new Date(T0), ...over });
  const v = (over = {}) => ({ language: 'en', body: 'Hi {name}, welcome back to the shop today.', buttons: [OPT_OUT_EN], ...over });

  test('has exactly the shape of the LocalizedTemplate / TemplateVariant TypeScript types', async () => {
    const { svc } = setup();
    const t = await seed(svc);
    expect(Object.keys(t).sort()).toEqual(['archived', 'category', 'createdAt', 'id', 'key', 'linkedMessageNodeId', 'name', 'updatedAt', 'useCase', 'variants']);
    expect(Object.keys(t.variants[0]).sort()).toEqual([
      'body', 'bilingualOrder', 'buttons', 'footer', 'header', 'language', 'lastError', 'metaCategory', 'metaFlagged', 'metaLastCheckedAt', 'metaPreviousCategory', 'metaStatusRaw', 'metaRejectedReason', 'metaStatus', 'metaTemplateName',
      'notSendableReason', 'reviewStatus', 'reviewedAt', 'reviewedBy', 'sendable', 'source', 'submissionCount', 'submittedAt', 'updatedAt', 'validation',
    ].sort());
    expect(Object.keys(t.variants[0].validation).sort()).toEqual(['errors', 'ok', 'params', 'positionalText', 'warnings']);
    expect(t.id).toMatch(/^[0-9a-f]{24}$/);
    expect(t.createdAt).toBe(new Date(T0).toISOString());
  });

  test('renders validation with the template category (positionalText + params included)', () => {
    const view = svcModule.toTemplateView(doc([v({ language: 'ar', body: AR.body, buttons: [] })]));
    const ar = variantOf(view, 'ar');
    expect(ar.validation.ok).toBe(false);
    expect(codes(ar.validation.errors)).toEqual(['marketing_requires_opt_out_button']);
    expect(ar.validation.params).toEqual(['name', 'points']);
    expect(ar.validation.positionalText).toBe('أهلاً {{1}}، رصيدك الحالي من النقاط: {{2}}. استبدلها هذا الأسبوع.');
    const utility = svcModule.toTemplateView(doc([v({ buttons: [] })], { useCase: 'payment_reminder', category: 'UTILITY' }));
    expect(utility.category).toBe('UTILITY');
    expect(variantOf(utility, 'en').validation.ok).toBe(true);
  });

  test('the UTILITY floor: a stored UTILITY on a non-transactional use case (legacy row) is shown, validated as MARKETING', () => {
    for (const useCase of ['promotion', 'comeback', 'loyalty_reminder', 'points_balance', 'points_expiring', 'referral_invite', 'referral_reward', 'greeting', 'welcome_optin', 'custom']) {
      const view = svcModule.toTemplateView(doc([v({ buttons: [] })], { useCase, category: 'UTILITY' }));
      expect(view.category).toBe('MARKETING');
      expect(codes(variantOf(view, 'en').validation.errors)).toEqual(['marketing_requires_opt_out_button']);
    }
    const noUseCase = svcModule.toTemplateView(doc([v({ buttons: [] })], { useCase: undefined, category: 'UTILITY' }));
    expect([noUseCase.useCase, noUseCase.category]).toEqual(['custom', 'MARKETING']);
    for (const useCase of ['payment_reminder', 'booking_confirmation', 'booking_reminder', 'order_confirmation']) {
      const view = svcModule.toTemplateView(doc([v({ buttons: [] })], { useCase, category: 'UTILITY' }));
      expect(view.category).toBe('UTILITY');
      expect(variantOf(view, 'en').validation.ok).toBe(true);
    }
  });

  test.each([
    [{ metaStatus: 'APPROVED', reviewStatus: 'reviewed', language: 'en' }, true, null],
    [{ metaStatus: 'APPROVED', reviewStatus: 'draft', language: 'en' }, true, null],
    [{ metaStatus: 'APPROVED', reviewStatus: 'reviewed', language: 'ar' }, true, null],
    [{ metaStatus: 'APPROVED', reviewStatus: 'draft', language: 'ar' }, false, 'not_reviewed'],
    [{ metaStatus: 'APPROVED', reviewStatus: 'draft', language: 'bilingual' }, false, 'not_reviewed'],
    [{ metaStatus: 'PENDING', reviewStatus: 'reviewed', language: 'ar' }, false, 'pending'],
    [{ metaStatus: 'IN_APPEAL', reviewStatus: 'reviewed', language: 'ar' }, false, 'pending'],
    [{ metaStatus: 'REJECTED', language: 'en' }, false, 'rejected'],
    [{ metaStatus: 'PAUSED', language: 'en' }, false, 'paused'],
    [{ metaStatus: 'DISABLED', language: 'en' }, false, 'disabled'],
    [{ metaStatus: 'FLAGGED', language: 'en' }, false, 'flagged'],
    [{ metaStatus: 'NOT_CREATED', language: 'en' }, false, 'not_submitted'],
    [{ metaStatus: 'ERROR', language: 'en' }, false, 'not_approved'],
    [{ language: 'en' }, false, 'not_submitted'],
  ])('sendable for %j -> %s (%s)', (over, sendable, reason) => {
    const out = variantOf(svcModule.toTemplateView(doc([v(over)])), over.language);
    expect(out.sendable).toBe(sendable);
    expect(out.notSendableReason).toBe(reason);
  });

  test('variants come out as en, ar, bilingual; missing optional fields become empty strings / nulls; dates are ISO strings', () => {
    const view = svcModule.toTemplateView(doc([
      v({ language: 'bilingual', body: BI.body }), v({ language: 'ar', body: AR.body }), v({ language: 'en', submittedAt: new Date(T0), metaLastCheckedAt: new Date(T0 + 1000) }),
    ]));
    expect(view.variants.map((x) => x.language)).toEqual(['en', 'ar', 'bilingual']);
    const en = view.variants[0];
    expect(en).toMatchObject({ header: '', footer: '', bilingualOrder: null, metaTemplateName: null, metaRejectedReason: null, lastError: null, reviewedBy: null, reviewedAt: null, submissionCount: 0, source: 'merchant', metaStatus: 'NOT_CREATED', reviewStatus: 'draft' });
    expect(en.submittedAt).toBe(new Date(T0).toISOString());
    expect(en.metaLastCheckedAt).toBe(new Date(T0 + 1000).toISOString());
    expect(en.updatedAt).toBe(new Date(T0).toISOString()); // falls back to the template's
    expect(view.variants[2].bilingualOrder).toBe('ar_first'); // default when none stored
  });

  test('accepts hydrated Mongoose documents (toObject) and ObjectId-like values', () => {
    const wrapped = { toObject: () => doc([v()], { _id: { toString: () => WS }, linkedMessageNodeId: { toString: () => NODE } }) };
    const view = svcModule.toTemplateView(wrapped);
    expect(view.id).toBe(WS);
    expect(view.linkedMessageNodeId).toBe(NODE);
  });

  test('button urls are included only for url buttons; unknown dates do not throw', () => {
    const view = svcModule.toTemplateView(doc([v({ buttons: [OPT_OUT_EN, { role: 'url', text: 'Shop', url: 'https://example.com' }], submittedAt: 'garbage' })]));
    expect(view.variants[0].buttons).toEqual([OPT_OUT_EN, { role: 'url', text: 'Shop', url: 'https://example.com' }]);
    expect(view.variants[0].submittedAt).toBeNull();
  });

  test('on a flow-linked template the other languages must keep the flow buttons where English has them (flow_button_mismatch)', () => {
    const flow = (arButtons) => svcModule.toTemplateView(doc([
      v({ language: 'en', buttons: [{ role: 'flow_button', text: 'Shop' }, { role: 'flow_button', text: 'Info' }, OPT_OUT_EN] }),
      v({ language: 'ar', body: AR.body, buttons: arButtons }),
    ], { linkedMessageNodeId: NODE }));
    const good = flow([{ role: 'flow_button', text: 'تسوق' }, { role: 'flow_button', text: 'معلومات' }, OPT_OUT_AR]);
    expect(variantOf(good, 'ar').validation.errors).toEqual([]);
    const swapped = flow([OPT_OUT_AR, { role: 'flow_button', text: 'تسوق' }, { role: 'flow_button', text: 'معلومات' }]);
    expect(variantOf(swapped, 'ar').validation.errors).toContainEqual({ code: 'flow_button_mismatch', field: 'buttons', detail: { expected: 2, found: 2 } });
    const fewer = flow([{ role: 'flow_button', text: 'تسوق' }, OPT_OUT_AR]);
    expect(codes(variantOf(fewer, 'ar').validation.errors)).toContain('flow_button_mismatch');
    expect(variantOf(good, 'en').validation.errors).toEqual([]); // the English variant is the reference
  });

  test('flow buttons on a template that is not linked to a flow message are an error', () => {
    const view = svcModule.toTemplateView(doc([v({ buttons: [{ role: 'flow_button', text: 'Shop' }, OPT_OUT_EN] })]));
    expect(codes(variantOf(view, 'en').validation.errors)).toContain('flow_button_without_message_node');
  });
});

// ── create ───────────────────────────────────────────────────────────────
describe('createTemplate', () => {
  test('creates a template with variants as drafts, NOT_CREATED at Meta, scoped to the workspace', async () => {
    const { svc, store } = setup();
    const t = await seed(svc);
    expect(t).toMatchObject({ key: 'loyalty_reminder', name: 'Loyalty reminder', useCase: 'loyalty_reminder', category: 'MARKETING', archived: false, linkedMessageNodeId: null });
    expect(t.variants.map((x) => [x.language, x.metaStatus, x.reviewStatus, x.source, x.submissionCount, x.sendable])).toEqual([
      ['en', 'NOT_CREATED', 'draft', 'merchant', 0, false], ['ar', 'NOT_CREATED', 'draft', 'merchant', 0, false],
    ]);
    expect(store.docs).toHaveLength(1);
    expect(store.docs[0]).toMatchObject({ workspaceId: WS, createdBy: USER, archived: false });
    expect(store.docs[0].variants.every((x) => x.contentVersion === 1)).toBe(true);
  });

  test.each([
    ['Loyalty reminder', 'loyalty_reminder'],
    ['  Comeback  OFFER!! ', 'comeback_offer'],
    ['Café déjà-vu', 'cafe_deja_vu'],
    ['عرض نهاية الأسبوع', 'عرض_نهايه_الاسبوع'],
    ['مَرْحَبًا بِكَ', 'مرحبا_بك'],
    ['أهلاً Ahlan 2026', 'اهلا_ahlan_2026'],
    ['🎉', 'template'],
    ['٢٠٢٦ عرض', '2026_عرض'],
  ])('the key of %j is %j', async (name, key) => {
    const { svc } = setup();
    expect((await svc.createTemplate({ workspaceId: WS, name })).key).toBe(key);
  });

  test('a long name gives a key of at most 60 characters', async () => {
    const { svc } = setup();
    const t = await svc.createTemplate({ workspaceId: WS, name: 'word '.repeat(23).trim() }); // 114 characters: inside the 120 name limit, far over the 60 key limit
    expect(Array.from(t.key).length).toBeLessThanOrEqual(60);
  });

  test('a clashing derived key gets a numeric suffix (the name stays); other workspaces may reuse a key', async () => {
    const { svc } = setup();
    expect((await seed(svc)).key).toBe('loyalty_reminder');
    const second = await seed(svc);
    expect([second.key, second.name]).toEqual(['loyalty_reminder_2', 'Loyalty reminder']);
    expect((await seed(svc)).key).toBe('loyalty_reminder_3');
    expect((await seed(svc, { workspaceId: WS2 })).key).toBe('loyalty_reminder');
  });

  test('concurrent creates of the same name all succeed with distinct keys', async () => {
    const { svc } = setup();
    const all = await Promise.all(Array.from({ length: 5 }, () => seed(svc)));
    expect(new Set(all.map((t) => t.key)).size).toBe(5);
  });

  test('an explicit key is used as is; a clash is a 409 TEMPLATE_KEY_TAKEN (never silently renamed)', async () => {
    const { svc } = setup();
    expect((await svc.createTemplate({ workspaceId: WS, name: 'X', key: 'my_key_1' })).key).toBe('my_key_1');
    await rejects(svc.createTemplate({ workspaceId: WS, name: 'Y', key: 'my_key_1' }), { status: 409, code: 'TEMPLATE_KEY_TAKEN' });
    for (const key of ['Bad Key', 'ABC', '', 'a'.repeat(61), 'عربي', 5, {}, ['a']]) {
      await rejects(svc.createTemplate({ workspaceId: WS, name: 'Z', key }), { status: 400, code: 'INVALID_INPUT' });
    }
  });

  test.each([[undefined], [null], [''], ['   '], [5], [{ $ne: null }], [['x']], ['x'.repeat(121)]])('name %j is rejected', async (name) => {
    const { svc } = setup();
    await rejects(svc.createTemplate({ workspaceId: WS, name }), { status: 400, code: 'INVALID_INPUT' });
  });

  test('a name of exactly 120 characters is accepted', async () => {
    const { svc } = setup();
    await expect(svc.createTemplate({ workspaceId: WS, name: 'x'.repeat(120) })).resolves.toMatchObject({ key: expect.any(String) });
  });

  test('use case and category are validated; the category defaults from the use case', async () => {
    const { svc } = setup();
    await rejects(svc.createTemplate({ workspaceId: WS, name: 'A', useCase: 'nope' }), { code: 'INVALID_INPUT' });
    await rejects(svc.createTemplate({ workspaceId: WS, name: 'A', category: 'AUTHENTICATION' }), { code: 'INVALID_INPUT' });
    await rejects(svc.createTemplate({ workspaceId: WS, name: 'A', useCase: { $ne: 1 } }), { code: 'INVALID_INPUT' });
    expect((await svc.createTemplate({ workspaceId: WS, name: 'A' })).category).toBe('MARKETING');
    for (const useCase of ['payment_reminder', 'booking_confirmation', 'booking_reminder', 'order_confirmation']) {
      expect((await svc.createTemplate({ workspaceId: WS, name: useCase, useCase })).category).toBe('UTILITY');
    }
    // Meta re-classified the consent request to MARKETING (live finding): it defaults to MARKETING
    expect((await svc.createTemplate({ workspaceId: WS, name: 'welcome', useCase: 'welcome_optin' })).category).toBe('MARKETING');
    expect((await svc.createTemplate({ workspaceId: WS, name: 'promo', useCase: 'promotion' })).category).toBe('MARKETING');
    expect((await svc.createTemplate({ workspaceId: WS, name: 'explicit', useCase: 'payment_reminder', category: 'MARKETING' })).category).toBe('MARKETING');
    for (const useCase of ['promotion', 'greeting']) expect((await svc.createTemplate({ workspaceId: WS, name: `uc-${useCase}`, useCase })).useCase).toBe(useCase);
  });

  describe('the UTILITY floor on create: only transactional use cases may be stored as UTILITY (corrected, never rejected)', () => {
    const TRANSACTIONAL = ['payment_reminder', 'booking_confirmation', 'booking_reminder', 'order_confirmation'];
    const NON_TRANSACTIONAL = ['promotion', 'comeback', 'loyalty_reminder', 'points_balance', 'points_expiring', 'referral_invite', 'referral_reward', 'greeting', 'welcome_optin', 'custom'];

    test.each(NON_TRANSACTIONAL.flatMap((u) => [[u, 'UTILITY'], [u, 'MARKETING'], [u, undefined]]))(
      'non-transactional %s requested as %s is stored and returned as MARKETING', async (useCase, requested) => {
        const { svc, store } = setup();
        const created = await svc.createTemplate({ workspaceId: WS, name: `t-${useCase}`, useCase, ...(requested ? { category: requested } : {}) });
        expect(created.category).toBe('MARKETING');
        expect(store.docs[0].category).toBe('MARKETING'); // what is STORED, not only what is shown
        expect((await svc.getTemplate({ workspaceId: WS, id: created.id })).category).toBe('MARKETING');
      },
    );

    test.each(TRANSACTIONAL.flatMap((u) => [[u, 'UTILITY', 'UTILITY'], [u, 'MARKETING', 'MARKETING'], [u, undefined, 'UTILITY']]))(
      'transactional %s requested as %s is stored as %s', async (useCase, requested, expected) => {
        const { svc, store } = setup();
        const created = await svc.createTemplate({ workspaceId: WS, name: `t-${useCase}`, useCase, ...(requested ? { category: requested } : {}) });
        expect(created.category).toBe(expected);
        expect(store.docs[0].category).toBe(expected);
      },
    );

    test('a template with no use case (default custom) cannot be UTILITY', async () => {
      const { svc } = setup();
      expect((await svc.createTemplate({ workspaceId: WS, name: 'nothing', category: 'UTILITY' })).category).toBe('MARKETING');
    });

    test('a UTILITY promotion is validated as MARKETING from the first save (the opt-out button is required)', async () => {
      const { svc } = setup();
      const created = await svc.createTemplate({ workspaceId: WS, name: 'sneaky', useCase: 'promotion', category: 'UTILITY', variants: [{ language: 'en', body: 'Hi {name}, 50% off everything today only in store.', buttons: [] }] });
      expect(created.category).toBe('MARKETING');
      expect(codes(variantOf(created, 'en').validation.errors)).toEqual(['marketing_requires_opt_out_button']);
    });
  });

  test('the service use case list matches the Mongoose model enum', () => {
    const model = require('../../models/LocalizedTemplate');
    expect(model.schema.path('useCase').enumValues.slice().sort()).toEqual(internals.USE_CASES.slice().sort());
    expect(model.schema.path('category').enumValues.slice().sort()).toEqual(internals.CATEGORIES.slice().sort());
    expect(model.schema.path('variants').schema.path('language').enumValues.slice().sort()).toEqual(internals.LANGUAGES.slice().sort());
    expect(model.schema.path('variants').schema.path('source').enumValues.slice().sort()).toEqual(internals.SOURCES.slice().sort());
  });

  test('variants: arrays only, at most 3, one per language, known languages, objects', async () => {
    const { svc } = setup();
    const c = (variants) => svc.createTemplate({ workspaceId: WS, name: 'V', variants });
    await rejects(c('x'), { code: 'INVALID_INPUT' });
    await rejects(c({ language: 'en', body: 'x' }), { code: 'INVALID_INPUT' });
    await rejects(c([{ language: 'en', ...EN }, { language: 'en', ...EN }]), { code: 'INVALID_INPUT' });
    await rejects(c([{ language: 'fr', body: 'x' }]), { code: 'INVALID_INPUT' });
    await rejects(c([null]), { code: 'INVALID_INPUT' });
    await rejects(c(['en']), { code: 'INVALID_INPUT' });
    await rejects(c([{ language: 'en' }, { language: 'ar' }, { language: 'bilingual' }, { language: 'en' }]), { code: 'INVALID_INPUT' });
    await expect(c([{ language: 'en' }, { language: 'ar' }, { language: 'bilingual' }])).resolves.toMatchObject({ variants: expect.any(Array) });
  });

  test('only the allow-listed variant fields are stored: a client cannot create an approved or reviewed variant', async () => {
    const { svc, store } = setup();
    const t = await svc.createTemplate({
      workspaceId: WS,
      name: 'Sneaky',
      archived: true,
      workspaceId2: WS2,
      variants: [{
        language: 'ar', ...AR, metaStatus: 'APPROVED', reviewStatus: 'reviewed', reviewedBy: 'Me', reviewedAt: new Date(), submissionCount: 99,
        metaTemplateName: 'wf_stolen_ar_v1', metaTemplateId: '1', contentVersion: 500, _id: 'x', workspaceId: WS2,
      }],
    });
    const stored = store.docs[0].variants[0];
    expect(stored).toMatchObject({ metaStatus: 'NOT_CREATED', reviewStatus: 'draft', submissionCount: 0, contentVersion: 1 });
    for (const key of ['reviewedBy', 'reviewedAt', 'metaTemplateName', 'metaTemplateId', 'workspaceId', '_id']) expect(stored[key]).toBeUndefined();
    expect(store.docs[0].archived).toBe(false);
    expect(variantOf(t, 'ar').sendable).toBe(false);
  });

  test('AI / library / import text is stored with its source and is always a draft', async () => {
    const { svc } = setup();
    for (const source of ['ai', 'library', 'import', 'merchant']) {
      const t = await svc.createTemplate({ workspaceId: WS, name: `S ${source}`, variants: [{ language: 'ar', ...AR, source }] });
      expect(variantOf(t, 'ar')).toMatchObject({ source, reviewStatus: 'draft' });
    }
    await rejects(svc.createTemplate({ workspaceId: WS, name: 'S', variants: [{ language: 'ar', ...AR, source: 'human_reviewed' }] }), { code: 'INVALID_INPUT' });
  });

  test('bilingual variants get the merchant default order unless one is given', async () => {
    const { svc, deps } = setup({ getBilingualOrder: jest.fn(async () => 'en_first') });
    const t = await svc.createTemplate({ workspaceId: WS, name: 'B', variants: [{ language: 'bilingual', ...BI }] });
    expect(variantOf(t, 'bilingual').bilingualOrder).toBe('en_first');
    const explicit = await svc.createTemplate({ workspaceId: WS, name: 'B2', variants: [{ language: 'bilingual', ...BI, bilingualOrder: 'ar_first' }] });
    expect(variantOf(explicit, 'bilingual').bilingualOrder).toBe('ar_first');
    await rejects(svc.createTemplate({ workspaceId: WS, name: 'B3', variants: [{ language: 'bilingual', ...BI, bilingualOrder: 'both' }] }), { code: 'INVALID_INPUT' });
    expect(deps.getBilingualOrder).toHaveBeenCalledTimes(1);
  });

  test('a bilingualOrder on a non-bilingual variant is ignored', async () => {
    const { svc, store } = setup();
    await svc.createTemplate({ workspaceId: WS, name: 'N', variants: [{ language: 'ar', ...AR, bilingualOrder: 'en_first' }] });
    expect(store.docs[0].variants[0].bilingualOrder).toBeUndefined();
  });

  test('ids are validated: workspace, linked flow message; createdBy is only recorded when it is an ObjectId', async () => {
    const { svc, store } = setup();
    for (const workspaceId of [undefined, null, 'abc', { $ne: null }, ['x'], 12]) {
      await rejects(svc.createTemplate({ workspaceId, name: 'X' }), { status: 400, code: 'INVALID_ID' });
    }
    await rejects(svc.createTemplate({ workspaceId: WS, name: 'X', linkedMessageNodeId: { $ne: null } }), { code: 'INVALID_ID' });
    await rejects(svc.createTemplate({ workspaceId: WS, name: 'X', linkedMessageNodeId: 'nope' }), { code: 'INVALID_ID' });
    const linked = await svc.createTemplate({ workspaceId: WS, name: 'Linked', linkedMessageNodeId: NODE, userId: 'not-an-object-id' });
    expect(linked.linkedMessageNodeId).toBe(NODE);
    expect(store.docs[0].createdBy).toBeUndefined();
  });

  test('buttons: unknown roles are refused with issues; too long fields and too many buttons are input errors', async () => {
    const { svc } = setup();
    const err = await rejects(svc.createTemplate({ workspaceId: WS, name: 'X', variants: [{ language: 'en', body: 'x', buttons: [{ role: 'custom', text: 'Hi' }] }] }), { status: 400, code: 'VARIANT_INVALID' });
    expect(err.body.issues).toEqual([{ code: 'invalid_button_role', field: 'buttons.0' }]);
    await rejects(svc.createTemplate({ workspaceId: WS, name: 'X', variants: [{ language: 'en', body: 'x'.repeat(4097) }] }), { code: 'INVALID_INPUT' });
    await rejects(svc.createTemplate({ workspaceId: WS, name: 'X', variants: [{ language: 'en', body: 'x', buttons: Array.from({ length: 21 }, () => OPT_OUT_EN) }] }), { code: 'INVALID_INPUT' });
    await rejects(svc.createTemplate({ workspaceId: WS, name: 'X', variants: [{ language: 'en', body: 'x', buttons: 'nope' }] }), { code: 'INVALID_INPUT' });
    await rejects(svc.createTemplate({ workspaceId: WS, name: 'X', variants: [{ language: 'en', body: 'x', buttons: [null] }] }), { code: 'INVALID_INPUT' });
    await rejects(svc.createTemplate({ workspaceId: WS, name: 'X', variants: [{ language: 'en', body: { $ne: 1 } }] }), { code: 'INVALID_INPUT' });
  });

  test('documents the service writes are valid against the REAL Mongoose schema (and a stale custom role is not)', async () => {
    const Model = require('../../models/LocalizedTemplate');
    const { svc, store } = setup();
    await seed(svc);
    await svc.createTemplate({ workspaceId: WS, name: 'All kinds', variants: [
      { language: 'en', body: 'Hi {name}', buttons: [OPT_OUT_EN, { role: 'url', text: 'Shop', url: 'https://example.com' }] },
      { language: 'bilingual', ...BI },
    ] });
    await svc.createTemplate({ workspaceId: WS, name: 'Linked', linkedMessageNodeId: NODE, variants: [{ language: 'en', body: 'Hi', buttons: [{ role: 'flow_button', text: 'Shop' }] }] });
    for (const doc of store.docs) {
      const { _id, createdAt, updatedAt, ...rest } = structuredClone(doc);
      expect(new Model(rest).validateSync()).toBeUndefined();
    }
    const stale = new Model({ workspaceId: WS, key: 'k', name: 'n', variants: [{ language: 'en', buttons: [{ role: 'custom', text: 'x' }] }] });
    expect(stale.validateSync().message).toMatch(/role/);
  });
});

// ── list ─────────────────────────────────────────────────────────────────
describe('listTemplates', () => {
  async function populated() {
    const ctx = setup();
    const { svc, advance } = ctx;
    ctx.a = await svc.createTemplate({ workspaceId: WS, name: 'Loyalty reminder', useCase: 'loyalty_reminder', variants: [{ language: 'ar', ...AR }] });
    advance(1000);
    ctx.b = await svc.createTemplate({ workspaceId: WS, name: 'عرض نهاية الأسبوع', useCase: 'promotion', variants: [{ language: 'ar', body: 'استمتع بخصم ٢٠٪ هذا الأسبوع يا {name} فقط.', buttons: [OPT_OUT_AR] }] });
    advance(1000);
    ctx.c = await svc.createTemplate({ workspaceId: WS, name: 'Payment reminder', useCase: 'payment_reminder', variants: [{ language: 'en', body: 'Pay for order {order_id} here please.' }] });
    ctx.other = await svc.createTemplate({ workspaceId: WS2, name: 'Other tenant loyalty' });
    return ctx;
  }

  test('only the caller workspace, newest first, with the page envelope', async () => {
    const { svc, a, b, c } = await populated();
    const res = await svc.listTemplates({ workspaceId: WS });
    expect(res.items.map((t) => t.id)).toEqual([c.id, b.id, a.id]);
    expect(res).toMatchObject({ total: 3, page: 1, limit: 200 });
    expect((await svc.listTemplates({ workspaceId: WS2 })).items.map((t) => t.name)).toEqual(['Other tenant loyalty']);
  });

  test('an edit moves a template to the top', async () => {
    const { svc, a, c, advance } = await populated();
    advance(5000);
    await svc.upsertVariant({ workspaceId: WS, id: a.id, language: 'ar', input: { body: `${AR.body} جديد`, buttons: AR.buttons } });
    expect((await svc.listTemplates({ workspaceId: WS })).items[0].id).toBe(a.id);
    expect((await svc.listTemplates({ workspaceId: WS })).items[1].id).toBe(c.id);
  });

  test('archived templates: hidden by default, included with archived=true, alone with archived=only', async () => {
    const { svc, a, b } = await populated();
    await svc.setArchived({ workspaceId: WS, id: a.id, archived: true });
    expect((await svc.listTemplates({ workspaceId: WS })).total).toBe(2);
    expect((await svc.listTemplates({ workspaceId: WS, archived: false })).total).toBe(2);
    expect((await svc.listTemplates({ workspaceId: WS, archived: 'false' })).total).toBe(2);
    for (const archived of [true, 'true', '1', 'include', 'all']) expect((await svc.listTemplates({ workspaceId: WS, archived })).total).toBe(3);
    expect((await svc.listTemplates({ workspaceId: WS, archived: 'only' })).items.map((t) => t.id)).toEqual([a.id]);
    expect((await svc.listTemplates({ workspaceId: WS, archived: 'only' })).items[0].archived).toBe(true);
    expect((await svc.listTemplates({ workspaceId: WS })).items.map((t) => t.id)).not.toContain(a.id);
    expect(b.archived).toBe(false);
  });

  test('use case filter (validated)', async () => {
    const { svc, c } = await populated();
    expect((await svc.listTemplates({ workspaceId: WS, useCase: 'payment_reminder' })).items.map((t) => t.id)).toEqual([c.id]);
    expect((await svc.listTemplates({ workspaceId: WS, useCase: '' })).total).toBe(3);
    for (const useCase of ['nope', { $ne: 1 }, ['payment_reminder']]) await rejects(svc.listTemplates({ workspaceId: WS, useCase }), { code: 'INVALID_INPUT' });
  });

  test.each([
    ['loyalty', ['Loyalty reminder']],
    ['REMINDER', ['Payment reminder', 'Loyalty reminder']],
    ['اسبوع', ['عرض نهاية الأسبوع', 'Loyalty reminder']], // alef/hamza variants and the Arabic body of the other template
    ['الأسبوع', ['عرض نهاية الأسبوع', 'Loyalty reminder']],
    ['نهايه', ['عرض نهاية الأسبوع']], // teh marbuta variant
    ['20', ['عرض نهاية الأسبوع']], // the body says ٢٠ (Arabic-Indic)
    ['٢٠', ['عرض نهاية الأسبوع']],
    ['pay order', ['Payment reminder']], // tokens are ANDed across name and body
    ['loyalty order', []],
    ['   ', ['Payment reminder', 'عرض نهاية الأسبوع', 'Loyalty reminder']],
    ['%^&*()[]{}$.*+?', []],
    ['.*', []],
  ])('search %j -> %j', async (search, names) => {
    const { svc } = await populated();
    expect((await svc.listTemplates({ workspaceId: WS, search })).items.map((t) => t.name)).toEqual(names);
  });

  test('search must be a string and never becomes a query', async () => {
    const { svc } = await populated();
    for (const search of [{ $ne: null }, ['a'], 5]) await rejects(svc.listTemplates({ workspaceId: WS, search }), { code: 'INVALID_INPUT' });
  });

  test('pagination is clamped', async () => {
    const { svc } = await populated();
    expect(await svc.listTemplates({ workspaceId: WS, limit: 2 })).toMatchObject({ total: 3, page: 1, limit: 2, items: expect.any(Array) });
    expect((await svc.listTemplates({ workspaceId: WS, limit: 2, page: 2 })).items).toHaveLength(1);
    expect((await svc.listTemplates({ workspaceId: WS, limit: 2, page: 9 })).items).toHaveLength(0);
    expect((await svc.listTemplates({ workspaceId: WS, limit: '0' })).limit).toBe(1);
    expect((await svc.listTemplates({ workspaceId: WS, limit: 5000 })).limit).toBe(200);
    expect((await svc.listTemplates({ workspaceId: WS, limit: 'abc', page: -3 }))).toMatchObject({ limit: 200, page: 1 });
  });

  test('the workspace id is validated', async () => {
    const { svc } = await populated();
    await rejects(svc.listTemplates({ workspaceId: { $ne: null } }), { code: 'INVALID_ID' });
    await rejects(svc.listTemplates({}), { code: 'INVALID_ID' });
  });
});

// ── get / update / archive ───────────────────────────────────────────────
describe('getTemplate / getTemplateDoc / updateTemplate / setArchived', () => {
  test('get returns the view; the doc accessor returns the stored (lean) document; other tenants get TEMPLATE_NOT_FOUND', async () => {
    const { svc } = setup();
    const t = await seed(svc);
    expect((await svc.getTemplate({ workspaceId: WS, id: t.id })).id).toBe(t.id);
    const doc = await svc.getTemplateDoc(WS, t.id);
    expect(doc).toMatchObject({ _id: t.id, workspaceId: WS, key: 'loyalty_reminder' });
    expect(Array.isArray(doc.variants)).toBe(true);
    await rejects(svc.getTemplate({ workspaceId: WS2, id: t.id }), { status: 404, code: 'TEMPLATE_NOT_FOUND' });
    await rejects(svc.getTemplateDoc(WS2, t.id), { status: 404, code: 'TEMPLATE_NOT_FOUND' });
    await rejects(svc.getTemplate({ workspaceId: WS, id: 'b'.repeat(24) }), { status: 404, code: 'TEMPLATE_NOT_FOUND' });
  });

  test.each([['nope'], [''], [undefined], [{ $ne: null }], [['a'.repeat(24)]], ['g'.repeat(24)], ['a'.repeat(23)], [12345]])('id %j is INVALID_ID (400), never a query', async (id) => {
    const { svc } = setup();
    await rejects(svc.getTemplate({ workspaceId: WS, id }), { status: 400, code: 'INVALID_ID' });
    await rejects(svc.updateTemplate({ workspaceId: WS, id, patch: { name: 'x' } }), { status: 400, code: 'INVALID_ID' });
    await rejects(svc.setArchived({ workspaceId: WS, id, archived: true }), { status: 400, code: 'INVALID_ID' });
    await rejects(svc.upsertVariant({ workspaceId: WS, id, language: 'en', input: {} }), { status: 400, code: 'INVALID_ID' });
    await rejects(svc.submitVariant({ workspaceId: WS, id, language: 'en' }), { status: 400, code: 'INVALID_ID' });
    await rejects(svc.reviewVariant({ workspaceId: WS, id, language: 'en', status: 'reviewed' }), { status: 400, code: 'INVALID_ID' });
    await rejects(svc.testSendVariant({ workspaceId: WS, id, language: 'en', phone: '0501234567' }), { status: 400, code: 'INVALID_ID' });
    await rejects(svc.validateVariantFor({ workspaceId: WS, id, language: 'en', input: {} }), { status: 400, code: 'INVALID_ID' });
    await rejects(svc.refreshTemplate({ workspaceId: WS, templateId: id }), { status: 400, code: 'INVALID_ID' });
  });

  test('rename / use case / category are allow-listed and validated; an empty patch changes nothing', async () => {
    const { svc, store } = setup();
    const t = await seed(svc);
    const renamed = await svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { name: '  New name  ', useCase: 'comeback', key: 'hacked', archived: true, workspaceId: WS2, variants: [] } });
    expect(renamed).toMatchObject({ name: 'New name', useCase: 'comeback', key: 'loyalty_reminder', archived: false, category: 'MARKETING' });
    expect(renamed.variants).toHaveLength(2);
    expect(store.docs[0].workspaceId).toBe(WS);
    const writes = store.writes.length;
    await svc.updateTemplate({ workspaceId: WS, id: t.id, patch: {} });
    expect(store.writes.length).toBe(writes);
    await rejects(svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { name: '   ' } }), { code: 'INVALID_INPUT' });
    await rejects(svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { name: { $set: 1 } } }), { code: 'INVALID_INPUT' });
    await rejects(svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { useCase: 'x' } }), { code: 'INVALID_INPUT' });
    await rejects(svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { category: 'X' } }), { code: 'INVALID_INPUT' });
    await rejects(svc.updateTemplate({ workspaceId: WS, id: t.id, patch: null }), { code: 'INVALID_INPUT' });
    await rejects(svc.updateTemplate({ workspaceId: WS, id: t.id, patch: [] }), { code: 'INVALID_INPUT' });
    await rejects(svc.updateTemplate({ workspaceId: WS2, id: t.id, patch: { name: 'Mine now' } }), { code: 'TEMPLATE_NOT_FOUND' });
    expect(store.docs[0].name).toBe('New name');
  });

  test('archive / unarchive flip the flag and never delete', async () => {
    const { svc, store } = setup();
    const t = await seed(svc);
    expect((await svc.setArchived({ workspaceId: WS, id: t.id, archived: true })).archived).toBe(true);
    expect(store.docs[0].archived).toBe(true);
    expect((await svc.setArchived({ workspaceId: WS, id: t.id, archived: false })).archived).toBe(false);
    expect(store.docs).toHaveLength(1);
    await rejects(svc.setArchived({ workspaceId: WS2, id: t.id, archived: true }), { code: 'TEMPLATE_NOT_FOUND' });
    expect(store.docs[0].archived).toBe(false);
  });

  test('changing the CATEGORY drops every submitted variant back to NOT_CREATED (what Meta approved no longer applies); an unchanged category does not', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    const name = await approve(ctx, t.id, 'en');
    expect(variantOf(await ctx.svc.getTemplate({ workspaceId: WS, id: t.id }), 'en').metaStatus).toBe('APPROVED');
    const before = storedVariant(ctx.store, 'en').contentVersion;
    const same = await ctx.svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { category: 'MARKETING' } });
    expect(variantOf(same, 'en').metaStatus).toBe('APPROVED');
    // UTILITY is only possible for a transactional use case, so the use case moves with the category
    const changed = await ctx.svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { useCase: 'payment_reminder', category: 'UTILITY' } });
    expect(changed.category).toBe('UTILITY');
    expect(variantOf(changed, 'en')).toMatchObject({ metaStatus: 'NOT_CREATED', sendable: false, metaTemplateName: name, submissionCount: 1 });
    expect(storedVariant(ctx.store, 'en').contentVersion).toBe(before + 1);
    expect(storedVariant(ctx.store, 'ar').contentVersion).toBe(2); // unsubmitted variants are version-bumped too, so nothing in flight can re-attach
    expect(ctx.store.docs[0].category).toBe('UTILITY');
  });

  describe('the UTILITY floor on update (corrected, never rejected)', () => {
    test.each(['promotion', 'comeback', 'loyalty_reminder', 'points_balance', 'points_expiring', 'referral_invite', 'referral_reward', 'greeting', 'welcome_optin', 'custom'])(
      'patching category UTILITY on a %s template keeps it MARKETING and leaves Meta\'s approval alone', async (useCase) => {
        const ctx = setup();
        const t = await seed(ctx.svc);
        await ctx.svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { useCase } });
        await approve(ctx, t.id, 'en');
        const out = await ctx.svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { category: 'UTILITY' } });
        expect(out.category).toBe('MARKETING'); // the corrected value is returned
        expect(ctx.store.docs[0].category).toBe('MARKETING'); // and stored
        expect(variantOf(out, 'en').metaStatus).toBe('APPROVED'); // nothing changed, so nothing was invalidated
      },
    );

    test('changing a transactional template\'s use case to a marketing one moves the category to MARKETING and drops Meta\'s approval under UTILITY', async () => {
      const ctx = setup();
      const t = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Pay', useCase: 'payment_reminder', variants: [{ language: 'en', body: 'Hi {name}, please complete payment for order {order_id} today.', buttons: [] }] });
      expect(t.category).toBe('UTILITY');
      await approve(ctx, t.id, 'en', { category: 'UTILITY' });
      expect(variantOf(await ctx.svc.getTemplate({ workspaceId: WS, id: t.id }), 'en').metaStatus).toBe('APPROVED');
      const out = await ctx.svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { useCase: 'promotion' } });
      expect(out).toMatchObject({ useCase: 'promotion', category: 'MARKETING' });
      expect(ctx.store.docs[0]).toMatchObject({ useCase: 'promotion', category: 'MARKETING' });
      expect(variantOf(out, 'en').metaStatus).toBe('NOT_CREATED');
    });

    test('use case AND category in one patch are floored together: promotion + UTILITY -> MARKETING; payment_reminder + UTILITY -> UTILITY', async () => {
      const ctx = setup();
      const t = await seed(ctx.svc);
      expect((await ctx.svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { useCase: 'promotion', category: 'UTILITY' } })).category).toBe('MARKETING');
      expect((await ctx.svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { useCase: 'payment_reminder', category: 'UTILITY' } })).category).toBe('UTILITY');
      expect(ctx.store.docs[0].category).toBe('UTILITY');
    });

    test('changing a use case between marketing ones, or a transactional one to another, changes no category', async () => {
      const ctx = setup();
      const t = await seed(ctx.svc);
      await approve(ctx, t.id, 'en');
      const out = await ctx.svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { useCase: 'comeback' } });
      expect(out.category).toBe('MARKETING');
      expect(variantOf(out, 'en').metaStatus).toBe('APPROVED');

      const pay = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Pay', useCase: 'payment_reminder', variants: [{ language: 'en', body: 'Hi {name}, please complete payment for order {order_id} today.', buttons: [] }] });
      await approve(ctx, pay.id, 'en', { category: 'UTILITY' });
      const moved = await ctx.svc.updateTemplate({ workspaceId: WS, id: pay.id, patch: { useCase: 'booking_reminder' } });
      expect(moved.category).toBe('UTILITY');
      expect(variantOf(moved, 'en').metaStatus).toBe('APPROVED');
    });

    test('a legacy row (UTILITY on a promotion) is shown as MARKETING; an unrelated patch (rename) leaves what is stored alone', async () => {
      const ctx = setup();
      const t = await seed(ctx.svc);
      await ctx.svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { useCase: 'promotion' } });
      ctx.store.docs[0].category = 'UTILITY'; // written before the floor existed
      expect((await ctx.svc.getTemplate({ workspaceId: WS, id: t.id })).category).toBe('MARKETING');
      const renamed = await ctx.svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { name: 'Renamed' } });
      expect(renamed.category).toBe('MARKETING');
      expect(ctx.store.docs[0].category).toBe('UTILITY'); // no side effect on Meta approvals from a rename
      const fixed = await ctx.svc.updateTemplate({ workspaceId: WS, id: t.id, patch: { category: 'UTILITY' } });
      expect(fixed.category).toBe('MARKETING');
      expect(ctx.store.docs[0].category).toBe('MARKETING'); // touching the category normalises the stored value
    });
  });
});

// ── upsertVariant ────────────────────────────────────────────────────────
describe('upsertVariant', () => {
  test('creates a missing variant as a draft', async () => {
    const { svc, store } = setup();
    const t = await svc.createTemplate({ workspaceId: WS, name: 'T' });
    const out = await svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, header: ' عرض ', footer: 'تذييل' } });
    expect(variantOf(out, 'ar')).toMatchObject({ header: 'عرض', footer: 'تذييل', body: AR.body, metaStatus: 'NOT_CREATED', reviewStatus: 'draft', source: 'merchant', submissionCount: 0 });
    expect(store.docs[0].variants).toHaveLength(1);
    expect(store.docs[0].variants[0].contentVersion).toBe(1);
  });

  test('an unchanged save is a no-op: Meta approval, review and version survive', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    await approve(ctx, t.id, 'en');
    await ctx.svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'en', status: 'reviewed', userId: USER });
    const writes = ctx.store.writes.length;
    const out = await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'en', input: { ...EN } });
    expect(ctx.store.writes.length).toBe(writes);
    expect(variantOf(out, 'en')).toMatchObject({ metaStatus: 'APPROVED', reviewStatus: 'reviewed', sendable: true });
    // whitespace-only differences (trailing spaces, CRLF) are not content changes
    const again = await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'en', input: { body: `  ${EN.body.replace('this week', 'this week')}  \r\n`, buttons: [{ role: 'opt_out', text: ' Opt Out ' }] } });
    expect(ctx.store.writes.length).toBe(writes);
    expect(variantOf(again, 'en').metaStatus).toBe('APPROVED');
  });

  // The stored variant starts as: body EN.body, buttons [opt-out, URL "Shop"].
  const URL_SHOP = { role: 'url', text: 'Shop', url: 'https://example.com/a' };
  const change = {
    header: { header: 'New header' },
    body: { body: `${EN.body} Extra.` },
    footer: { footer: 'Footer now' },
    'button text': { buttons: [{ role: 'opt_out', text: 'Stop' }, URL_SHOP] },
    'button role': { buttons: [{ role: 'decline', text: 'Opt Out' }, URL_SHOP] },
    'button added': { buttons: [OPT_OUT_EN, URL_SHOP, { role: 'decline', text: 'No' }] },
    'button url': { buttons: [OPT_OUT_EN, { ...URL_SHOP, url: 'https://example.com/b' }] },
    'buttons reordered': { buttons: [URL_SHOP, OPT_OUT_EN] },
  };
  test.each(Object.entries(change))('changing the %s resets Meta status and review, keeps the submission history, bumps the version', async (_, patch) => {
    const ctx = setup();
    const t = await ctx.svc.createTemplate({ workspaceId: WS, name: 'T', variants: [{ language: 'en', body: EN.body, buttons: [OPT_OUT_EN, URL_SHOP] }] });
    const name = await approve(ctx, t.id, 'en');
    await ctx.svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'en', status: 'reviewed', userId: USER });
    const base = structuredClone(storedVariant(ctx.store, 'en')); // a copy: the store mutates its variant in place
    expect(base).toMatchObject({ metaStatus: 'APPROVED', reviewStatus: 'reviewed' });
    const out = await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'en', input: { body: base.body, buttons: base.buttons, ...patch } });
    const v = variantOf(out, 'en');
    expect(v).toMatchObject({ metaStatus: 'NOT_CREATED', reviewStatus: 'draft', reviewedBy: null, reviewedAt: null, sendable: false, submissionCount: 1, metaTemplateName: name, lastError: null, metaRejectedReason: null, metaLastCheckedAt: null });
    expect(storedVariant(ctx.store, 'en').contentVersion).toBe(base.contentVersion + 1);
    expect(storedVariant(ctx.store, 'en').metaTemplateId).toBe(base.metaTemplateId); // history kept
    expect(storedVariant(ctx.store, 'en').reviewedById).toBeUndefined();
  });

  test('a changed variant is submitted under a NEW Meta name; the old name is never reused', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    const v1 = await approve(ctx, t.id, 'ar');
    await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} جديد` } });
    const second = await ctx.svc.submitVariant({ workspaceId: WS, id: t.id, language: 'ar' });
    expect(v1).toMatch(/_ar_v1$/);
    expect(second.submission.metaTemplateName).toMatch(/_ar_v2$/);
    expect(second.submission.metaTemplateName).not.toBe(v1);
  });

  test('editing one language leaves the others untouched', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    await approve(ctx, t.id, 'en');
    await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} جديد` } });
    expect(variantOf(await ctx.svc.getTemplate({ workspaceId: WS, id: t.id }), 'en').metaStatus).toBe('APPROVED');
  });

  test('a save marked source "ai" is always a draft, even when the text equals a reviewed variant', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    await ctx.svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'ar', status: 'reviewed', userId: USER });
    expect(variantOf(await ctx.svc.getTemplate({ workspaceId: WS, id: t.id }), 'ar').reviewStatus).toBe('reviewed');
    const same = await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, source: 'ai' } });
    expect(variantOf(same, 'ar')).toMatchObject({ reviewStatus: 'draft', reviewedBy: null, source: 'ai' });
    expect(storedVariant(ctx.store, 'ar').contentVersion).toBe(1); // text unchanged: nothing re-approved or re-versioned
    await ctx.svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'ar', status: 'reviewed', userId: USER });
    const changed = await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} ترجمة`, source: 'ai' } });
    expect(variantOf(changed, 'ar')).toMatchObject({ reviewStatus: 'draft', source: 'ai', metaStatus: 'NOT_CREATED' });
  });

  test('an AI-sourced approved variant with unchanged text keeps its Meta approval (the text did not change) but loses review', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    await approve(ctx, t.id, 'ar');
    await ctx.svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'ar', status: 'reviewed', userId: USER });
    const out = await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, source: 'ai' } });
    expect(variantOf(out, 'ar')).toMatchObject({ metaStatus: 'APPROVED', reviewStatus: 'draft', sendable: false, notSendableReason: 'not_reviewed' });
  });

  test('a merchant edit after an AI save records the merchant as the source', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} ١`, source: 'ai' } });
    const out = await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} ٢` } });
    expect(variantOf(out, 'ar').source).toBe('merchant');
  });

  test('a rejected variant that is edited resets the rejection reason and error', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    const name = (await ctx.svc.submitVariant({ workspaceId: WS, id: t.id, language: 'ar' })).submission.metaTemplateName;
    ctx.meta.rows.set(name, [{ id: 'x', name, language: 'ar', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', category: 'MARKETING' }]);
    await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id });
    expect(variantOf(await ctx.svc.getTemplate({ workspaceId: WS, id: t.id }), 'ar')).toMatchObject({ metaStatus: 'REJECTED', metaRejectedReason: 'INVALID_FORMAT' });
    const out = await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} تعديل` } });
    expect(variantOf(out, 'ar')).toMatchObject({ metaStatus: 'NOT_CREATED', metaRejectedReason: null });
  });

  test('editing a variant while its submission is in flight clears the in-flight marker (the new text can be submitted straight away)', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    storedVariant(ctx.store, 'ar').submittingAt = new Date(T0);
    await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} جديد` } });
    expect(storedVariant(ctx.store, 'ar').submittingAt).toBeUndefined();
  });

  test('NUL characters are removed and line endings normalised; invisible text is kept as typed', async () => {
    const { svc, store } = setup();
    const t = await svc.createTemplate({ workspaceId: WS, name: 'T' });
    await svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'en', input: { body: 'Line one\u{0000}\r\nLine two\rLine three {name}', buttons: [] } });
    expect(store.docs[0].variants[0].body).toBe('Line one\nLine two\nLine three {name}');
  });

  test('input limits and shapes', async () => {
    const { svc } = setup();
    const t = await seed(svc);
    const up = (input, language = 'en') => svc.upsertVariant({ workspaceId: WS, id: t.id, language, input });
    await rejects(up({ body: 'x'.repeat(4097) }), { code: 'INVALID_INPUT' });
    await rejects(up({ body: 'ok', header: 'x'.repeat(301) }), { code: 'INVALID_INPUT' });
    await rejects(up({ body: 'ok', footer: 'x'.repeat(301) }), { code: 'INVALID_INPUT' });
    await rejects(up({ body: 'ok', buttons: [{ role: 'opt_out', text: 'x'.repeat(101) }] }), { code: 'INVALID_INPUT' });
    await rejects(up({ body: 'ok', buttons: [{ role: 'url', text: 'x', url: `https://e.com/${'a'.repeat(2100)}` }] }), { code: 'INVALID_INPUT' });
    await rejects(up({ body: 'ok', buttons: Array.from({ length: 21 }, (_, i) => ({ role: 'decline', text: `b${i}` })) }), { code: 'INVALID_INPUT' });
    await rejects(up({ body: 'ok', source: 'robot' }), { code: 'INVALID_INPUT' });
    await rejects(up({ body: 'ok', bilingualOrder: 'x' }), { code: 'INVALID_INPUT' });
    await rejects(up(null), { code: 'INVALID_INPUT' });
    await rejects(up('text'), { code: 'INVALID_INPUT' });
    await rejects(up([]), { code: 'INVALID_INPUT' });
    await rejects(up({ body: ['a'] }), { code: 'INVALID_INPUT' });
    await rejects(up({ body: 'ok' }, 'fr'), { code: 'INVALID_INPUT' });
    await rejects(up({ body: 'ok' }, null), { code: 'INVALID_INPUT' });
    await rejects(up({ body: 'ok', buttons: [{ role: 'custom', text: 'x' }] }), { status: 400, code: 'VARIANT_INVALID' });
  });

  test('a variant with problems is still SAVED as a draft when the problems are validation issues (the editor autosaves)', async () => {
    const { svc } = setup();
    const t = await svc.createTemplate({ workspaceId: WS, name: 'T' });
    const out = await svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { body: '', buttons: [{ role: 'opt_out', text: '' }, { role: 'url', text: 'x', url: 'http://insecure.example' }] } });
    expect(variantOf(out, 'ar').validation.ok).toBe(false);
    expect(codes(variantOf(out, 'ar').validation.errors)).toEqual(expect.arrayContaining(['body_required', 'button_label_empty', 'button_url_not_https']));
  });

  test('only the allow-listed fields are written', async () => {
    const { svc, store } = setup();
    const t = await seed(svc);
    await svc.upsertVariant({
      workspaceId: WS, id: t.id, language: 'en',
      input: { body: 'New body for {name} today.', buttons: [OPT_OUT_EN], metaStatus: 'APPROVED', reviewStatus: 'reviewed', submissionCount: 50, contentVersion: 99, metaTemplateName: 'x', reviewedBy: 'me', language: 'ar', workspaceId: WS2 },
    });
    expect(storedVariant(store, 'en')).toMatchObject({ language: 'en', metaStatus: 'NOT_CREATED', reviewStatus: 'draft', submissionCount: 0, contentVersion: 2 });
    expect(storedVariant(store, 'en').metaTemplateName).toBeUndefined();
    expect(storedVariant(store, 'en').reviewedBy).toBeUndefined();
  });

  test('tenant isolation: another workspace cannot edit; the template is simply not found', async () => {
    const { svc, store } = setup();
    const t = await seed(svc);
    await rejects(svc.upsertVariant({ workspaceId: WS2, id: t.id, language: 'en', input: { body: 'hijack' } }), { status: 404, code: 'TEMPLATE_NOT_FOUND' });
    expect(storedVariant(store, 'en').body).toBe(EN.body);
  });

  test('bilingual: the order defaults to the merchant default, is kept when omitted later, and changing it is a content change', async () => {
    const ctx = setup({ getBilingualOrder: jest.fn(async () => 'en_first') });
    const t = await ctx.svc.createTemplate({ workspaceId: WS, name: 'T' });
    const created = await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'bilingual', input: { ...BI } });
    expect(variantOf(created, 'bilingual').bilingualOrder).toBe('en_first');
    const same = await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'bilingual', input: { ...BI } });
    expect(storedVariant(ctx.store, 'bilingual').contentVersion).toBe(1);
    expect(variantOf(same, 'bilingual').bilingualOrder).toBe('en_first');
    const flipped = await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'bilingual', input: { ...BI, bilingualOrder: 'ar_first' } });
    expect(variantOf(flipped, 'bilingual').bilingualOrder).toBe('ar_first');
    expect(storedVariant(ctx.store, 'bilingual').contentVersion).toBe(2);
  });

  test('a concurrent change is retried against the fresh state (optimistic concurrency), then gives up with a 409', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    const realUpdate = ctx.store.updateVariant.bind(ctx.store);
    let conflicts = 1;
    ctx.store.updateVariant = async (...args) => {
      if (conflicts > 0) { conflicts -= 1; await realUpdate(args[0], args[1], args[2], { guard: args[3].guard, set: { footer: 'edited elsewhere' }, inc: { contentVersion: 1 } }); }
      return realUpdate(...args);
    };
    const out = await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'en', input: { ...EN, body: 'mine' } });
    expect(variantOf(out, 'en').body).toBe('mine');
    expect(storedVariant(ctx.store, 'en').body).toBe('mine');
    ctx.store.updateVariant = async () => false;
    await rejects(ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'en', input: { ...EN, body: 'again' } }), { status: 409, code: 'INTERNAL' });
  });

  test('two concurrent adds of the same new language leave exactly one variant (the loser takes the update path)', async () => {
    const { svc, store } = setup();
    const t = await svc.createTemplate({ workspaceId: WS, name: 'T' });
    await Promise.all([
      svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'en', input: { body: 'first writer' } }),
      svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'en', input: { body: 'second writer' } }),
    ]);
    expect(store.docs[0].variants).toHaveLength(1);
    expect(['first writer', 'second writer']).toContain(store.docs[0].variants[0].body);
  });

  test('concurrent saves of two different variants both land (positional writes never clobber each other)', async () => {
    const { svc, store } = setup();
    const t = await seed(svc);
    await Promise.all([
      svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'en', input: { ...EN, body: 'English edit {name} now.' } }),
      svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: 'تعديل عربي {name} الآن.' } }),
    ]);
    expect(storedVariant(store, 'en').body).toBe('English edit {name} now.');
    expect(storedVariant(store, 'ar').body).toBe('تعديل عربي {name} الآن.');
  });
});

// ── validate endpoint ────────────────────────────────────────────────────
describe('validateVariantFor', () => {
  test('validates the stored variant when no draft is given', async () => {
    const { svc } = setup();
    const t = await seed(svc);
    const res = await svc.validateVariantFor({ workspaceId: WS, id: t.id, language: 'ar', input: {} });
    expect(res).toEqual({ ok: true, errors: [], warnings: [], positionalText: 'أهلاً {{1}}، رصيدك الحالي من النقاط: {{2}}. استبدلها هذا الأسبوع.', params: ['name', 'points'] });
  });

  test('validates an unsaved draft (the live validation of the editor) without saving it', async () => {
    const { svc, store } = setup();
    const t = await seed(svc);
    const res = await svc.validateVariantFor({ workspaceId: WS, id: t.id, language: 'ar', input: { body: '', buttons: [] } });
    expect(res.ok).toBe(false);
    expect(codes(res.errors)).toEqual(expect.arrayContaining(['body_required', 'marketing_requires_opt_out_button']));
    expect(storedVariant(store, 'ar').body).toBe(AR.body);
  });

  test('an unsaved draft may be for a language that has no stored variant yet', async () => {
    const { svc } = setup();
    const t = await svc.createTemplate({ workspaceId: WS, name: 'T' });
    const res = await svc.validateVariantFor({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR } });
    expect(res.ok).toBe(true);
    await rejects(svc.validateVariantFor({ workspaceId: WS, id: t.id, language: 'ar', input: {} }), { status: 404, code: 'VARIANT_NOT_FOUND' });
    await rejects(svc.validateVariantFor({ workspaceId: WS, id: t.id, language: 'ar', input: undefined }), { status: 404, code: 'VARIANT_NOT_FOUND' });
  });

  test('a draft with an unknown button role is REPORTED, not refused; hard input limits still apply', async () => {
    const { svc } = setup();
    const t = await seed(svc);
    const res = await svc.validateVariantFor({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, buttons: [{ role: 'custom', text: 'x' }, OPT_OUT_AR] } });
    expect(res.errors).toContainEqual({ code: 'invalid_button_role', field: 'buttons.0' });
    await rejects(svc.validateVariantFor({ workspaceId: WS, id: t.id, language: 'ar', input: { body: 'x'.repeat(5000) } }), { code: 'INVALID_INPUT' });
  });

  test('uses the template category, linked flow message and the draft bilingual order', async () => {
    const { svc } = setup();
    const utility = await svc.createTemplate({ workspaceId: WS, name: 'U', useCase: 'payment_reminder' });
    expect((await svc.validateVariantFor({ workspaceId: WS, id: utility.id, language: 'ar', input: { body: 'مرحباً {name}، نذكّرك بإتمام الدفع لطلبك.' } })).ok).toBe(true);
    const linked = await svc.createTemplate({ workspaceId: WS, name: 'L', linkedMessageNodeId: NODE });
    const res = await svc.validateVariantFor({ workspaceId: WS, id: linked.id, language: 'ar', input: { ...AR, buttons: [{ role: 'flow_button', text: 'تسوق' }, OPT_OUT_AR] } });
    expect(res.errors).toEqual([]);
    const bi = await svc.validateVariantFor({ workspaceId: WS, id: linked.id, language: 'bilingual', input: { ...BI, bilingualOrder: 'en_first' } });
    expect(codes(bi.warnings)).toContain('bilingual_order_mismatch');
  });

  test('tenant isolation', async () => {
    const { svc } = setup();
    const t = await seed(svc);
    await rejects(svc.validateVariantFor({ workspaceId: WS2, id: t.id, language: 'ar', input: {} }), { code: 'TEMPLATE_NOT_FOUND' });
  });
});

// ── review ───────────────────────────────────────────────────────────────
describe('reviewVariant', () => {
  test('marks reviewed with the signed-in user name + id and the time; back to draft clears them', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    ctx.advance(MIN);
    const out = await ctx.svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'ar', status: 'reviewed', userId: USER });
    expect(variantOf(out, 'ar')).toMatchObject({ reviewStatus: 'reviewed', reviewedBy: 'Noura Al-Harbi', reviewedAt: new Date(T0 + MIN).toISOString() });
    expect(storedVariant(ctx.store, 'ar').reviewedById).toBe(USER);
    expect(variantOf(out, 'en').reviewStatus).toBe('draft');
    const back = await ctx.svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'ar', status: 'draft', userId: USER });
    expect(variantOf(back, 'ar')).toMatchObject({ reviewStatus: 'draft', reviewedBy: null, reviewedAt: null });
    expect(storedVariant(ctx.store, 'ar').reviewedById).toBeUndefined();
  });

  test('English variants can be reviewed too (optional)', async () => {
    const { svc } = setup();
    const t = await seed(svc);
    expect(variantOf(await svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'en', status: 'reviewed', userId: USER }), 'en').reviewStatus).toBe('reviewed');
  });

  test('an unknown or nameless reviewer, a failing lookup and a non-ObjectId user id never block the review', async () => {
    const ctx = setup({ getReviewerName: jest.fn(async (uid) => { if (uid === 'boom') throw new Error('db'); return null; }) });
    const t = await seed(ctx.svc);
    const out = await ctx.svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'ar', status: 'reviewed', userId: USER });
    expect(variantOf(out, 'ar').reviewedBy).toBe('Reviewer');
    const out2 = await ctx.svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'en', status: 'reviewed', userId: 'boom' });
    expect(variantOf(out2, 'en')).toMatchObject({ reviewStatus: 'reviewed', reviewedBy: 'Reviewer' });
    expect(storedVariant(ctx.store, 'en').reviewedById).toBeUndefined();
    expect(ctx.deps.log).toHaveBeenCalled();
  });

  test('only non-empty variants can be marked reviewed (draft is always allowed)', async () => {
    const { svc } = setup();
    const t = await svc.createTemplate({ workspaceId: WS, name: 'T', variants: [{ language: 'ar', body: '' }, { language: 'en', body: '   ' }] });
    const err = await rejects(svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'ar', status: 'reviewed', userId: USER }), { status: 400, code: 'VARIANT_INVALID' });
    expect(err.body.issues).toEqual([{ code: 'body_required', field: 'body' }]);
    await rejects(svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'en', status: 'reviewed', userId: USER }), { code: 'VARIANT_INVALID' });
    await expect(svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'ar', status: 'draft', userId: USER })).resolves.toBeDefined();
  });

  test('status and language are validated; missing variants are VARIANT_NOT_FOUND; other tenants get TEMPLATE_NOT_FOUND', async () => {
    const { svc } = setup();
    const t = await seed(svc);
    for (const status of ['approved', undefined, null, '', { $ne: 1 }, ['reviewed']]) await rejects(svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'ar', status }), { code: 'INVALID_INPUT' });
    await rejects(svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'fr', status: 'reviewed' }), { code: 'INVALID_INPUT' });
    await rejects(svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'bilingual', status: 'reviewed' }), { status: 404, code: 'VARIANT_NOT_FOUND' });
    await rejects(svc.reviewVariant({ workspaceId: WS2, id: t.id, language: 'ar', status: 'reviewed', userId: USER }), { status: 404, code: 'TEMPLATE_NOT_FOUND' });
  });

  test('the review is tied to the text that was read: if it changes first, the review applies to the fresh text, never to a stale version', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    const real = ctx.store.updateVariant.bind(ctx.store);
    let raced = false;
    ctx.store.updateVariant = async (ws, id, language, args) => {
      if (!raced) {
        raced = true;
        await real(ws, id, language, { guard: { contentVersion: args.guard.contentVersion }, set: { body: 'edited in another tab {name}' }, inc: { contentVersion: 1 } });
      }
      return real(ws, id, language, args);
    };
    const out = await ctx.svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'ar', status: 'reviewed', userId: USER });
    expect(variantOf(out, 'ar').reviewStatus).toBe('reviewed');
    expect(storedVariant(ctx.store, 'ar').body).toBe('edited in another tab {name}');
    expect(storedVariant(ctx.store, 'ar').contentVersion).toBe(2);
  });

  test('gives up with a 409 after repeated conflicts', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    ctx.store.updateVariant = async () => false;
    await rejects(ctx.svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'ar', status: 'reviewed', userId: USER }), { status: 409 });
  });

  test('editing a reviewed variant drops it back to draft', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    await ctx.svc.reviewVariant({ workspaceId: WS, id: t.id, language: 'ar', status: 'reviewed', userId: USER });
    const out = await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, footer: 'تذييل جديد' } });
    expect(variantOf(out, 'ar')).toMatchObject({ reviewStatus: 'draft', reviewedBy: null });
  });
});

// ── submit ───────────────────────────────────────────────────────────────
describe('submitVariant', () => {
  const submit = (ctx, id, language = 'ar') => ctx.svc.submitVariant({ workspaceId: WS, id, language });

  test('success: builds the Meta payload, persists PENDING with name/id/language/time, counts the attempt, clears errors', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    ctx.advance(MIN);
    const res = await submit(ctx, t.id);
    expect(res.submission).toEqual({ metaTemplateName: 'wf_293a4b_loyalty_reminder_ar_v1', metaStatus: 'PENDING', dryRun: false });
    const v = variantOf(res.template, 'ar');
    expect(v).toMatchObject({ metaStatus: 'PENDING', metaTemplateName: 'wf_293a4b_loyalty_reminder_ar_v1', submissionCount: 1, lastError: null, submittedAt: new Date(T0 + MIN).toISOString(), metaLastCheckedAt: new Date(T0 + MIN).toISOString(), sendable: false, notSendableReason: 'pending' });
    expect(storedVariant(ctx.store, 'ar')).toMatchObject({ metaTemplateId: 'tpl-1', metaLanguage: 'ar', metaCategory: 'MARKETING' });
    expect(storedVariant(ctx.store, 'ar').submittingAt).toBeUndefined();
    expect(ctx.meta.submitCalls).toHaveLength(1);
    expect(variantOf(res.template, 'en').metaStatus).toBe('NOT_CREATED'); // the other language is untouched
    expect(res.template.id).toBe(t.id);
  });

  test('the Meta payload is language ar, positional, with Arabic examples, the default footer and the opt-out quick reply', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    await submit(ctx, t.id);
    expect(ctx.meta.submitCalls[0]).toEqual({
      name: 'wf_293a4b_loyalty_reminder_ar_v1',
      language: 'ar',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'أهلاً {{1}}، رصيدك الحالي من النقاط: {{2}}. استبدلها هذا الأسبوع.', example: { body_text: [['سارة', '120']] } },
        { type: 'FOOTER', text: 'لإلغاء الاشتراك أرسل: إلغاء الاشتراك' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'إلغاء الاشتراك' }] },
      ],
    });
    await submit(ctx, t.id, 'en');
    expect(ctx.meta.submitCalls[1]).toMatchObject({ name: 'wf_293a4b_loyalty_reminder_en_v1', language: 'en' });
    expect(ctx.meta.submitCalls[1].components.find((c) => c.type === 'FOOTER').text).toBe('Reply STOP to unsubscribe');
    expect(ctx.meta.submitCalls[1].components[0].example).toEqual({ body_text: [['Sara', '120']] });
  });

  test('the footer: the merchant\'s own is kept; none is added without an opt-out button; the stored variant is not changed', async () => {
    const ctx = setup();
    const own = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Own footer', variants: [{ language: 'ar', ...AR, footer: 'تذييلي الخاص' }] });
    await submit(ctx, own.id);
    expect(ctx.meta.submitCalls[0].components.find((c) => c.type === 'FOOTER').text).toBe('تذييلي الخاص');
    const utility = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Utility', useCase: 'payment_reminder', variants: [{ language: 'ar', body: 'مرحباً {name}، نذكّرك بإتمام الدفع لطلبك رقم {order_id} اليوم.' }] });
    await submit(ctx, utility.id);
    expect(ctx.meta.submitCalls[1].components.find((c) => c.type === 'FOOTER')).toBeUndefined();
    const t = await seed(ctx.svc);
    await submit(ctx, t.id);
    expect(storedVariant(ctx.store, 'ar', 2).footer).toBe(''); // the default footer is added to the submission only
  });

  test('revisions: v1, then v2 after an edit; a failed attempt also burns its revision, so no name is ever used twice', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    await submit(ctx, t.id);
    for (let i = 0; i < 3; i += 1) {
      await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} ${i}` } });
      if (i === 1) ctx.meta.submitImpl = async () => { throw new mt.MetaApiError({ code: 100, message: 'Template exists' }); };
      else ctx.meta.submitImpl = null;
      await submit(ctx, t.id).catch(() => {});
    }
    const names = ctx.meta.submitCalls.map((c) => c.name);
    expect(names).toEqual([
      'wf_293a4b_loyalty_reminder_ar_v1', 'wf_293a4b_loyalty_reminder_ar_v2', 'wf_293a4b_loyalty_reminder_ar_v3', 'wf_293a4b_loyalty_reminder_ar_v4',
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(storedVariant(ctx.store, 'ar').submissionCount).toBe(4);
  });

  test('a variant that is invalid is refused with its issues; nothing is sent, claimed or changed', async () => {
    const ctx = setup();
    const t = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Bad', variants: [{ language: 'ar', body: 'مرحباً {name}، عرض اليوم', buttons: [] }] });
    const writes = ctx.store.writes.length;
    const err = await rejects(submit(ctx, t.id), { status: 400, code: 'VARIANT_INVALID' });
    expect(codes(err.body.issues)).toEqual(['marketing_requires_opt_out_button']);
    expect(ctx.meta.submitCalls).toHaveLength(0);
    expect(ctx.meta.assertCalls).toBe(0);
    expect(ctx.store.writes.length).toBe(writes);
    expect(storedVariant(ctx.store, 'ar').submissionCount).toBe(0);
  });

  test.each([
    ['empty body', { body: '' }, 'body_required'],
    ['a button label over 20 characters', { buttons: [OPT_OUT_AR, { role: 'decline', text: 'x'.repeat(21) }] }, 'button_label_too_long'],
    ['an http URL button', { buttons: [OPT_OUT_AR, { role: 'url', text: 'تصفح', url: 'http://example.com' }] }, 'button_url_not_https'],
    ['a field in a URL button', { buttons: [OPT_OUT_AR, { role: 'url', text: 'تصفح', url: 'https://example.com/{name}' }] }, 'button_url_has_field'],
    ['URL before quick reply', { buttons: [{ role: 'url', text: 'تصفح', url: 'https://example.com' }, OPT_OUT_AR] }, 'buttons_wrong_order'],
    ['a flow button without a linked flow message', { buttons: [{ role: 'flow_button', text: 'تسوق' }, OPT_OUT_AR] }, 'flow_button_without_message_node'],
    ['Meta-style {{1}}', { body: 'مرحباً {{1}} بك في المتجر اليوم' }, 'meta_positional_syntax'],
    ['an over-long footer', { footer: 'x'.repeat(61) }, 'footer_too_long'],
  ])('refuses %s', async (_, patch, code) => {
    const ctx = setup();
    const t = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Bad', variants: [{ language: 'ar', ...AR, ...patch }] });
    const err = await rejects(submit(ctx, t.id), { status: 400, code: 'VARIANT_INVALID' });
    expect(codes(err.body.issues)).toContain(code);
    expect(ctx.meta.submitCalls).toHaveLength(0);
  });

  test.each(['PENDING', 'IN_APPEAL', 'APPROVED'])('%s with unchanged content -> 409 ALREADY_SUBMITTED; no Meta call, no claim', async (status) => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    await submit(ctx, t.id);
    storedVariant(ctx.store, 'ar').metaStatus = status;
    const calls = ctx.meta.submitCalls.length;
    const count = storedVariant(ctx.store, 'ar').submissionCount;
    await rejects(submit(ctx, t.id), { status: 409, code: 'ALREADY_SUBMITTED' });
    expect(ctx.meta.submitCalls.length).toBe(calls);
    expect(storedVariant(ctx.store, 'ar').submissionCount).toBe(count);
  });

  test.each(['NOT_CREATED', 'REJECTED', 'PAUSED', 'DISABLED', 'FLAGGED', 'ERROR'])('%s can be (re)submitted — under a new revision', async (status) => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    await submit(ctx, t.id);
    Object.assign(storedVariant(ctx.store, 'ar'), { metaStatus: status });
    const res = await submit(ctx, t.id);
    expect(res.submission.metaTemplateName).toMatch(/_v2$/);
    expect(variantOf(res.template, 'ar').metaStatus).toBe('PENDING');
  });

  test('dry-run: validates and reports the name that WOULD be used, changes nothing, never touches Meta', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    ctx.transport.dry = true;
    ctx.meta.assertConfigured = async () => { throw new Error('Meta must not be contacted in dry-run'); };
    ctx.meta.submitTemplate = async () => { throw new Error('Meta must not be contacted in dry-run'); };
    const writes = ctx.store.writes.length;
    const res = await submit(ctx, t.id);
    expect(res.submission).toEqual({ metaTemplateName: 'wf_293a4b_loyalty_reminder_ar_v1', metaStatus: 'NOT_CREATED', dryRun: true });
    expect(variantOf(res.template, 'ar')).toMatchObject({ metaStatus: 'NOT_CREATED', submissionCount: 0, metaTemplateName: null });
    expect(ctx.store.writes.length).toBe(writes);
    expect(storedVariant(ctx.store, 'ar').submissionCount).toBe(0);
    // an invalid variant is still refused in dry-run, and so is an already-submitted one
    const bad = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Bad', variants: [{ language: 'ar', body: '', buttons: [] }] });
    await rejects(submit(ctx, bad.id), { code: 'VARIANT_INVALID' });
    storedVariant(ctx.store, 'ar').metaStatus = 'PENDING';
    await rejects(submit(ctx, t.id), { code: 'ALREADY_SUBMITTED' });
  });

  test('Meta not configured: 503 META_NOT_CONFIGURED before anything is claimed (no revision burned)', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    ctx.meta.configured = false;
    const writes = ctx.store.writes.length;
    await rejects(submit(ctx, t.id), { status: 503, code: 'META_NOT_CONFIGURED' });
    expect(ctx.store.writes.length).toBe(writes);
    expect(storedVariant(ctx.store, 'ar').submissionCount).toBe(0);
    expect(ctx.meta.submitCalls).toHaveLength(0);
  });

  test('Meta error: 502 META_ERROR with the sanitised error, lastError stored, state unchanged, revision burned, marker cleared', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    ctx.meta.submitImpl = async () => { throw new mt.MetaApiError({ code: 100, subcode: 2388023, message: 'Template content invalid' }, { httpStatus: 400 }); };
    const err = await rejects(submit(ctx, t.id), { status: 502, code: 'META_ERROR' });
    expect(err.body).toEqual({ error: 'WhatsApp (Meta) could not process the request', code: 'META_ERROR', metaError: { code: 100, subcode: 2388023, message: 'Template content invalid' } });
    expect(storedVariant(ctx.store, 'ar')).toMatchObject({ metaStatus: 'NOT_CREATED', lastError: 'Template content invalid (100)', submissionCount: 1 });
    expect(storedVariant(ctx.store, 'ar').submittingAt).toBeUndefined();
    expect(storedVariant(ctx.store, 'ar').metaTemplateName).toBeUndefined();
    const view = variantOf(await ctx.svc.getTemplate({ workspaceId: WS, id: t.id }), 'ar');
    expect(view).toMatchObject({ lastError: 'Template content invalid (100)', metaStatus: 'NOT_CREATED' });
    // the next attempt works and clears the error
    ctx.meta.submitImpl = null;
    const ok = await submit(ctx, t.id);
    expect(ok.submission.metaTemplateName).toMatch(/_v2$/);
    expect(variantOf(ok.template, 'ar').lastError).toBeNull();
  });

  test('an unexpected failure shape (a plain error from the client) still becomes a sanitised META_ERROR', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    ctx.meta.submitImpl = async () => { throw new Error('boom: internal detail'); };
    const err = await rejects(submit(ctx, t.id), { status: 502, code: 'META_ERROR' });
    expect(JSON.stringify(err.body)).not.toContain('internal detail');
    expect(storedVariant(ctx.store, 'ar').lastError).toBe('WhatsApp (Meta) request failed');
  });

  test('a double click: only ONE call reaches Meta, the others get 409 ALREADY_SUBMITTED', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    ctx.meta.submitImpl = async (payload) => { await new Promise((r) => setTimeout(r, 25)); return { id: 'tpl-1', status: 'PENDING', category: payload.category }; };
    const results = await Promise.allSettled([submit(ctx, t.id), submit(ctx, t.id), submit(ctx, t.id), submit(ctx, t.id)]);
    expect(ctx.meta.submitCalls).toHaveLength(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect(r.reason).toMatchObject({ status: 409, code: 'ALREADY_SUBMITTED' });
    expect(storedVariant(ctx.store, 'ar')).toMatchObject({ metaStatus: 'PENDING', submissionCount: 1 });
  });

  test('two languages of one template can be submitted at the same time (different variants, different names)', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    ctx.meta.submitImpl = async (payload) => { await new Promise((r) => setTimeout(r, 10)); return { id: payload.name, status: 'PENDING', category: payload.category }; };
    const [en, ar] = await Promise.all([submit(ctx, t.id, 'en'), submit(ctx, t.id, 'ar')]);
    expect(en.submission.metaTemplateName).toMatch(/_en_v1$/);
    expect(ar.submission.metaTemplateName).toMatch(/_ar_v1$/);
    expect(variantOf(await ctx.svc.getTemplate({ workspaceId: WS, id: t.id }), 'en').metaStatus).toBe('PENDING');
    expect(variantOf(await ctx.svc.getTemplate({ workspaceId: WS, id: t.id }), 'ar').metaStatus).toBe('PENDING');
  });

  test('an in-flight marker older than two minutes is stale (the process died mid-call): submitting works again, under a new revision', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    Object.assign(storedVariant(ctx.store, 'ar'), { submittingAt: new Date(T0), submissionCount: 1 });
    ctx.advance(MIN);
    await rejects(submit(ctx, t.id), { status: 409, code: 'ALREADY_SUBMITTED' });
    ctx.advance(2 * MIN);
    const res = await submit(ctx, t.id);
    expect(res.submission.metaTemplateName).toMatch(/_ar_v2$/);
  });

  test('the text changed while Meta was being called: the new text is NOT marked pending (a stale approval must never attach to it)', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    ctx.meta.submitImpl = async (payload) => {
      await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} نص جديد` } });
      return { id: 'tpl-old', status: 'PENDING', category: payload.category };
    };
    const res = await submit(ctx, t.id);
    expect(res.submission.metaStatus).toBe('PENDING'); // what happened at Meta for the OLD text
    const stored = storedVariant(ctx.store, 'ar');
    expect(stored).toMatchObject({ metaStatus: 'NOT_CREATED', body: `${AR.body} نص جديد` });
    expect(stored.metaTemplateId).toBeUndefined();
    expect(variantOf(res.template, 'ar')).toMatchObject({ metaStatus: 'NOT_CREATED', body: `${AR.body} نص جديد` });
    expect(ctx.deps.log).toHaveBeenCalled();
  });

  test('Meta may answer with a final status straight away; the answer is stored as reported (a missing one is PENDING, an unknown one the non-sendable ERROR)', async () => {
    for (const [reported, stored] of [['APPROVED', 'APPROVED'], ['REJECTED', 'REJECTED'], ['pending', 'PENDING'], ['WEIRD', 'ERROR'], [undefined, 'PENDING']]) {
      const ctx = setup();
      const t = await seed(ctx.svc);
      ctx.meta.submitImpl = async (payload) => ({ id: 'x', status: reported, category: payload.category });
      const res = await submit(ctx, t.id);
      expect(res.submission.metaStatus).toBe(stored);
      expect(storedVariant(ctx.store, 'ar').metaStatus).toBe(stored);
    }
  });

  test('the UTILITY floor on submit: a legacy UTILITY row for a non-transactional use case is submitted to Meta as MARKETING', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc); // loyalty_reminder, stored MARKETING, with an opt-out button
    ctx.store.docs[0].category = 'UTILITY'; // written before the floor existed
    await submit(ctx, t.id, 'en');
    expect(ctx.meta.submitCalls[0].category).toBe('MARKETING');
    expect(ctx.meta.submitCalls[0].components.some((c) => c.type === 'BUTTONS')).toBe(true); // validated and built as MARKETING: the opt-out button is in it
  });

  test('a category Meta reports as MARKETING escalates a UTILITY template (consent rules follow the stricter category)', async () => {
    const ctx = setup();
    const t = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Util', useCase: 'payment_reminder', variants: [{ language: 'ar', body: 'مرحباً {name}، نذكّرك بإتمام الدفع لطلبك رقم {order_id} اليوم.' }] });
    expect(t.category).toBe('UTILITY');
    ctx.meta.submitImpl = async () => ({ id: 'x', status: 'PENDING', category: 'MARKETING' });
    await submit(ctx, t.id);
    expect(ctx.meta.submitCalls[0].category).toBe('UTILITY');
    expect(ctx.store.docs[0].category).toBe('MARKETING');
    expect(storedVariant(ctx.store, 'ar').metaCategory).toBe('MARKETING');
  });

  test('bilingual: the Meta language code and example follow the declared order; the name carries _bi_', async () => {
    const ctx = setup();
    const t = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Both', variants: [{ language: 'bilingual', ...BI, bilingualOrder: 'ar_first' }] });
    const first = await submit(ctx, t.id, 'bilingual');
    expect(first.submission.metaTemplateName).toBe('wf_293a4b_both_bi_v1');
    expect(ctx.meta.submitCalls[0].language).toBe('ar');
    expect(storedVariant(ctx.store, 'bilingual').metaLanguage).toBe('ar');
    const en = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Both en', variants: [{ language: 'bilingual', body: 'Hello {name}, we have a new offer for you today.\n\nمرحباً {name}، لدينا عرض جديد لك اليوم.', buttons: [OPT_OUT_EN], bilingualOrder: 'en_first' }] });
    await submit(ctx, en.id, 'bilingual');
    expect(ctx.meta.submitCalls[1].language).toBe('en');
    expect(ctx.meta.submitCalls[1].components.find((c) => c.type === 'FOOTER').text).toBe('Reply STOP to unsubscribe'); // footer in the first language
  });

  test('an Arabic-only template name still produces a valid Meta name (short id fallback)', async () => {
    const ctx = setup();
    const t = await ctx.svc.createTemplate({ workspaceId: WS, name: 'عرض نهاية الأسبوع', variants: [{ language: 'ar', ...AR }] });
    const res = await submit(ctx, t.id);
    expect(res.submission.metaTemplateName).toMatch(/^wf_293a4b_عرض/.test(res.submission.metaTemplateName) ? /never/ : /^wf_293a4b_[a-z0-9]{1,8}_ar_v1$/);
    expect(res.submission.metaTemplateName).toMatch(/^[a-z0-9_]+$/);
  });

  test('URL buttons go out after the quick replies, in Meta shape', async () => {
    const ctx = setup();
    const t = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Links', variants: [{ language: 'ar', ...AR, buttons: [OPT_OUT_AR, { role: 'url', text: 'تصفح العروض', url: 'https://waflowtech.com/offers' }] }] });
    await submit(ctx, t.id);
    expect(ctx.meta.submitCalls[0].components.find((c) => c.type === 'BUTTONS').buttons).toEqual([
      { type: 'QUICK_REPLY', text: 'إلغاء الاشتراك' }, { type: 'URL', text: 'تصفح العروض', url: 'https://waflowtech.com/offers' },
    ]);
  });

  test('missing template / variant, bad language, other tenants', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    await rejects(submit(ctx, t.id, 'bilingual'), { status: 404, code: 'VARIANT_NOT_FOUND' });
    await rejects(submit(ctx, 'b'.repeat(24)), { status: 404, code: 'TEMPLATE_NOT_FOUND' });
    await rejects(submit(ctx, t.id, 'fr'), { status: 400, code: 'INVALID_INPUT' });
    await rejects(ctx.svc.submitVariant({ workspaceId: WS2, id: t.id, language: 'ar' }), { status: 404, code: 'TEMPLATE_NOT_FOUND' });
    expect(ctx.meta.submitCalls).toHaveLength(0);
  });

  test('a flow-linked template whose Arabic flow buttons do not match English cannot be submitted', async () => {
    const ctx = setup();
    const t = await ctx.svc.createTemplate({
      workspaceId: WS, name: 'Flow', linkedMessageNodeId: NODE, variants: [
        { language: 'en', body: 'Hi {name}, check our new arrivals today.', buttons: [{ role: 'flow_button', text: 'Shop' }, OPT_OUT_EN] },
        { language: 'ar', body: 'مرحباً {name}، تعرّف على وصولاتنا الجديدة اليوم.', buttons: [OPT_OUT_AR, { role: 'flow_button', text: 'تسوق' }] },
      ],
    });
    const err = await rejects(submit(ctx, t.id), { code: 'VARIANT_INVALID' });
    expect(codes(err.body.issues)).toEqual(['flow_button_mismatch']);
    await expect(submit(ctx, t.id, 'en')).resolves.toBeDefined();
  });
});

// ── refresh ──────────────────────────────────────────────────────────────
describe('status refresh', () => {
  const row = (name, language, status, extra = {}) => ({ id: `meta-${name}`, name, language, status, category: 'MARKETING', ...extra });

  test('maps Meta status by name AND language; rows of other languages or longer names are ignored', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    const name = (await ctx.svc.submitVariant({ workspaceId: WS, id: t.id, language: 'ar' })).submission.metaTemplateName;
    ctx.meta.rows.set(name, [row(name, 'en', 'REJECTED'), row(`${name}0`, 'ar', 'REJECTED'), row(name, 'ar', 'APPROVED')]);
    ctx.advance(MIN);
    const res = await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id });
    expect(res).toMatchObject({ checked: 1, changed: 1, notFound: 0, unknown: 0, errors: 0 });
    expect(ctx.meta.listCalls).toEqual([name]);
    const v = storedVariant(ctx.store, 'ar');
    expect(v).toMatchObject({ metaStatus: 'APPROVED', metaTemplateId: `meta-${name}`, metaCategory: 'MARKETING', metaLastCheckedAt: new Date(T0 + MIN) });
    expect(variantOf(await ctx.svc.getTemplate({ workspaceId: WS, id: t.id }), 'ar')).toMatchObject({ metaStatus: 'APPROVED', sendable: false, notSendableReason: 'not_reviewed' });
  });

  test.each([
    ['APPROVED', 'APPROVED'], ['PENDING', 'PENDING'], ['REJECTED', 'REJECTED'], ['PAUSED', 'PAUSED'], ['DISABLED', 'DISABLED'], ['IN_APPEAL', 'IN_APPEAL'],
    ['DELETED', 'DELETED'], ['PENDING_DELETION', 'PENDING_DELETION'], ['LIMIT_EXCEEDED', 'LIMIT_EXCEEDED'], ['ARCHIVED', 'ARCHIVED'],
    ['FLAGGED', 'ERROR'], ['BRAND_NEW_STATE', 'ERROR'], // not a Graph status / unknown: non-sendable, raw text kept, never a throw
  ])('Meta %s -> %s', async (reported, expected) => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    const name = (await ctx.svc.submitVariant({ workspaceId: WS, id: t.id, language: 'ar' })).submission.metaTemplateName;
    ctx.meta.rows.set(name, [row(name, 'ar', reported)]);
    await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id });
    expect(storedVariant(ctx.store, 'ar').metaStatus).toBe(expected);
    expect(storedVariant(ctx.store, 'ar').metaStatusRaw).toBe(reported);
    expect(variantOf(await ctx.svc.getTemplate({ workspaceId: WS, id: t.id }), 'ar')).toMatchObject({ metaStatusRaw: reported, sendable: false });
  });

  test('the rejection reason is stored with REJECTED, "NONE" means none, and it is cleared when the status moves on', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    const name = (await ctx.svc.submitVariant({ workspaceId: WS, id: t.id, language: 'ar' })).submission.metaTemplateName;
    const refresh = () => ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id });
    ctx.meta.rows.set(name, [row(name, 'ar', 'REJECTED', { rejected_reason: 'INVALID_FORMAT' })]);
    expect((await refresh()).changed).toBe(1);
    expect(variantOf(await ctx.svc.getTemplate({ workspaceId: WS, id: t.id }), 'ar')).toMatchObject({ metaStatus: 'REJECTED', metaRejectedReason: 'INVALID_FORMAT', notSendableReason: 'rejected' });
    ctx.meta.rows.set(name, [row(name, 'ar', 'REJECTED', { rejected_reason: 'ABUSIVE_CONTENT' })]);
    expect((await refresh()).changed).toBe(1); // the reason alone changed
    expect(storedVariant(ctx.store, 'ar').metaRejectedReason).toBe('ABUSIVE_CONTENT');
    ctx.meta.rows.set(name, [row(name, 'ar', 'APPROVED', { rejected_reason: 'NONE' })]);
    expect((await refresh()).changed).toBe(1);
    expect(storedVariant(ctx.store, 'ar').metaRejectedReason).toBeUndefined();
    ctx.meta.rows.set(name, [row(name, 'ar', 'REJECTED', { rejected_reason: 'NONE' })]);
    await refresh();
    expect(storedVariant(ctx.store, 'ar').metaRejectedReason).toBeUndefined();
    expect(storedVariant(ctx.store, 'ar').metaStatus).toBe('REJECTED');
  });

  test('idempotent: an unchanged status reports changed 0 but records the check time', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    const name = (await ctx.svc.submitVariant({ workspaceId: WS, id: t.id, language: 'ar' })).submission.metaTemplateName;
    ctx.meta.rows.set(name, [row(name, 'ar', 'PENDING')]);
    ctx.advance(5 * MIN);
    const first = await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id });
    const second = await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id });
    expect([first.changed, second.changed]).toEqual([0, 0]);
    expect(storedVariant(ctx.store, 'ar').metaLastCheckedAt).toEqual(new Date(T0 + 5 * MIN));
    expect(storedVariant(ctx.store, 'ar').metaStatus).toBe('PENDING');
  });

  test('variants that were never submitted are skipped without any Meta call (including ones reset to NOT_CREATED that still carry an old name)', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    expect(await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id })).toMatchObject({ checked: 0, changed: 0 });
    await ctx.svc.submitVariant({ workspaceId: WS, id: t.id, language: 'ar' });
    await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} جديد` } });
    expect(storedVariant(ctx.store, 'ar').metaTemplateName).toBeTruthy();
    expect(await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id })).toMatchObject({ checked: 0 });
    expect(ctx.meta.listCalls).toHaveLength(0);
  });

  test('a status we do not know becomes the non-sendable ERROR (raw text kept) and is reported; a template Meta does not list is reported as notFound', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    const ar = (await ctx.svc.submitVariant({ workspaceId: WS, id: t.id, language: 'ar' })).submission.metaTemplateName;
    const en = (await ctx.svc.submitVariant({ workspaceId: WS, id: t.id, language: 'en' })).submission.metaTemplateName;
    ctx.meta.rows.set(ar, [row(ar, 'ar', 'BRAND_NEW_STATE')]);
    const res = await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id });
    expect(res).toMatchObject({ checked: 2, changed: 1, unknown: 1, notFound: 1 });
    expect(storedVariant(ctx.store, 'ar')).toMatchObject({ metaStatus: 'ERROR', metaStatusRaw: 'BRAND_NEW_STATE' });
    expect(storedVariant(ctx.store, 'en').metaStatus).toBe('PENDING');
    expect(storedVariant(ctx.store, 'en').metaLastCheckedAt).toBeDefined();
    expect(ctx.meta.listCalls.sort()).toEqual([ar, en].sort());
  });

  test('a manual refresh also re-checks APPROVED variants (Meta may pause or disable them later)', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    const name = await approve(ctx, t.id, 'ar');
    ctx.meta.rows.set(name, [row(name, 'ar', 'PAUSED')]);
    const res = await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id });
    expect(res.changed).toBe(1);
    expect(storedVariant(ctx.store, 'ar').metaStatus).toBe('PAUSED');
  });

  test('a category Meta reports can only make a template stricter (UTILITY -> MARKETING), never looser', async () => {
    const ctx = setup();
    const t = await ctx.svc.createTemplate({ workspaceId: WS, name: 'U', useCase: 'payment_reminder', variants: [{ language: 'ar', body: 'مرحباً {name}، نذكّرك بإتمام الدفع لطلبك رقم {order_id} اليوم.' }] });
    const name = (await ctx.svc.submitVariant({ workspaceId: WS, id: t.id, language: 'ar' })).submission.metaTemplateName;
    ctx.meta.rows.set(name, [row(name, 'ar', 'APPROVED', { category: 'UTILITY' })]);
    await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id });
    expect(ctx.store.docs[0].category).toBe('UTILITY');
    ctx.meta.rows.set(name, [row(name, 'ar', 'APPROVED', { category: 'MARKETING' })]);
    await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id });
    expect(ctx.store.docs[0].category).toBe('MARKETING');
    const m = await seed(ctx.svc);
    const mName = (await ctx.svc.submitVariant({ workspaceId: WS, id: m.id, language: 'ar' })).submission.metaTemplateName;
    ctx.meta.rows.set(mName, [row(mName, 'ar', 'APPROVED', { category: 'UTILITY' })]);
    await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: m.id });
    expect(ctx.store.docs[1].category).toBe('MARKETING');
  });

  test('a result is never written onto text that changed after it was read (guarded by the content version)', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    const name = (await ctx.svc.submitVariant({ workspaceId: WS, id: t.id, language: 'ar' })).submission.metaTemplateName;
    ctx.meta.listImpl = async () => {
      await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} جديد` } });
      return [row(name, 'ar', 'APPROVED')];
    };
    await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id });
    expect(storedVariant(ctx.store, 'ar')).toMatchObject({ metaStatus: 'NOT_CREATED', body: `${AR.body} جديد` });
  });

  test('manual refresh: a Meta failure is surfaced (502/503); nothing is changed', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    await ctx.svc.submitVariant({ workspaceId: WS, id: t.id, language: 'ar' });
    ctx.meta.listImpl = async () => { throw new mt.MetaApiError({ code: 190, message: 'Token expired' }); };
    const err = await rejects(ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id }), { status: 502, code: 'META_ERROR' });
    expect(err.body.metaError).toEqual({ code: 190, message: 'Token expired' });
    ctx.meta.listImpl = async () => { throw new mt.MetaNotConfiguredError('x'); };
    await rejects(ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id }), { status: 503, code: 'META_NOT_CONFIGURED' });
    expect(storedVariant(ctx.store, 'ar').metaStatus).toBe('PENDING');
  });

  test('dry-run: refreshing does nothing and does not call Meta', async () => {
    const ctx = setup();
    const t = await seed(ctx.svc);
    await ctx.svc.submitVariant({ workspaceId: WS, id: t.id, language: 'ar' });
    ctx.transport.dry = true;
    expect(await ctx.svc.refreshTemplate({ workspaceId: WS, templateId: t.id })).toMatchObject({ checked: 0, changed: 0, dryRun: true });
    expect(await ctx.svc.refreshStatuses({ workspaceId: WS, templateId: t.id })).toEqual({ checked: 0, changed: 0 });
    expect(await ctx.svc.refreshStatuses({ workspaceId: WS })).toEqual({ checked: 0, changed: 0 });
    expect(await ctx.svc.refreshPending({})).toMatchObject({ checked: 0, dryRun: true });
    expect(ctx.meta.listCalls).toHaveLength(0);
  });

  describe('refreshStatuses (POST /templates/refresh-status)', () => {
    test('one template or every live template of the workspace; returns only { checked, changed }', async () => {
      const ctx = setup();
      const a = await seed(ctx.svc);
      const b = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Second', variants: [{ language: 'ar', ...AR }] });
      const other = await seed(ctx.svc, { workspaceId: WS2 });
      const archived = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Old', variants: [{ language: 'ar', ...AR }] });
      const names = {};
      for (const [tpl, ws] of [[a, WS], [b, WS], [other, WS2], [archived, WS]]) {
        names[tpl.id] = (await ctx.svc.submitVariant({ workspaceId: ws, id: tpl.id, language: 'ar' })).submission.metaTemplateName;
        ctx.meta.rows.set(names[tpl.id], [row(names[tpl.id], 'ar', 'APPROVED')]);
      }
      await ctx.svc.setArchived({ workspaceId: WS, id: archived.id, archived: true });
      const one = await ctx.svc.refreshStatuses({ workspaceId: WS, templateId: a.id });
      expect(one).toEqual({ checked: 1, changed: 1 });
      ctx.meta.listCalls.length = 0;
      const all = await ctx.svc.refreshStatuses({ workspaceId: WS });
      expect(all).toEqual({ checked: 2, changed: 1 }); // a (already approved), b; not the other tenant, not the archived one
      // `a` already learned its Meta id (GET /{id}); `b` was approved under a different id, so it falls back to the name lookup
      expect(ctx.meta.byIdCalls).toContain(`meta-${names[a.id]}`);
      expect(ctx.meta.listCalls).toEqual([names[b.id]]);
    });

    test('a template of another workspace is not found', async () => {
      const ctx = setup();
      const t = await seed(ctx.svc);
      await rejects(ctx.svc.refreshStatuses({ workspaceId: WS2, templateId: t.id }), { status: 404, code: 'TEMPLATE_NOT_FOUND' });
      await rejects(ctx.svc.refreshStatuses({ workspaceId: WS, templateId: 'nope' }), { status: 400, code: 'INVALID_ID' });
    });

    test('rate limited per workspace: 10 per minute, then 429 RATE_LIMITED with a retry hint; other workspaces are unaffected', async () => {
      const ctx = setup();
      for (let i = 0; i < 10; i += 1) await ctx.svc.refreshStatuses({ workspaceId: WS });
      const err = await rejects(ctx.svc.refreshStatuses({ workspaceId: WS }), { status: 429, code: 'RATE_LIMITED' });
      expect(err.retryAfterSeconds).toBeGreaterThan(0);
      expect(err.retryAfterSeconds).toBeLessThanOrEqual(60);
      await expect(ctx.svc.refreshStatuses({ workspaceId: WS2 })).resolves.toEqual({ checked: 0, changed: 0 });
      ctx.advance(61 * 1000);
      await expect(ctx.svc.refreshStatuses({ workspaceId: WS })).resolves.toEqual({ checked: 0, changed: 0 });
    });
  });

  describe('refreshPending (the scheduler)', () => {
    async function pending(ctx, workspaceId = WS, name = 'Pending one') {
      const t = await ctx.svc.createTemplate({ workspaceId, name, variants: [{ language: 'ar', ...AR }] });
      const submitted = await ctx.svc.submitVariant({ workspaceId, id: t.id, language: 'ar' });
      return { t, name: submitted.submission.metaTemplateName };
    }

    test('only PENDING / IN_APPEAL / PAUSED variants are checked; APPROVED, REJECTED and unsubmitted ones are left alone', async () => {
      const ctx = setup();
      const seen = [];
      for (const status of ['PENDING', 'IN_APPEAL', 'PAUSED', 'APPROVED', 'REJECTED', 'DISABLED']) {
        const p = await pending(ctx, WS, `T ${status}`);
        storedVariant(ctx.store, 'ar', ctx.store.docs.length - 1).metaStatus = status;
        seen.push([status, p.name]);
      }
      await ctx.svc.createTemplate({ workspaceId: WS, name: 'never submitted', variants: [{ language: 'ar', ...AR }] });
      ctx.advance(2 * HOUR);
      const res = await ctx.svc.refreshPending({});
      expect(ctx.meta.listCalls.sort()).toEqual(seen.filter(([s]) => ['PENDING', 'IN_APPEAL', 'PAUSED'].includes(s)).map(([, n]) => n).sort());
      expect(res.checked).toBe(3);
    });

    test('only merchants with the Arabic flag on are touched (others cost no Meta call)', async () => {
      const ctx = setup();
      const a = await pending(ctx, WS, 'On');
      const b = await pending(ctx, WS2, 'Off');
      ctx.enabled.delete(WS2);
      ctx.advance(HOUR);
      await ctx.svc.refreshPending({});
      expect(ctx.meta.listCalls).toEqual([a.name]);
      expect(ctx.deps.isArabicEnabled).toHaveBeenCalledWith(WS2);
      expect(b.name).toBeTruthy();
    });

    test('a failing flag lookup skips that merchant instead of failing the sweep', async () => {
      const ctx = setup({ isArabicEnabled: jest.fn(async (ws) => { if (ws === WS2) throw new Error('db down'); return true; }) });
      await pending(ctx, WS2, 'Broken flag');
      const ok = await pending(ctx, WS, 'Fine');
      ctx.advance(HOUR);
      await expect(ctx.svc.refreshPending({})).resolves.toMatchObject({ checked: 1 });
      expect(ctx.meta.listCalls).toEqual([ok.name]);
    });

    test('archived templates are not swept', async () => {
      const ctx = setup();
      const p = await pending(ctx);
      await ctx.svc.setArchived({ workspaceId: WS, id: p.t.id, archived: true });
      ctx.advance(HOUR);
      expect((await ctx.svc.refreshPending({})).checked).toBe(0);
    });

    test('back-off: checked every ~5 minutes in the first hour, every 15 minutes in the first day, then hourly', async () => {
      const ctx = setup();
      const p = await pending(ctx);
      const sweep = async () => { ctx.meta.listCalls.length = 0; await ctx.svc.refreshPending({}); return ctx.meta.listCalls.length; };
      ctx.advance(2 * MIN);
      expect(await sweep()).toBe(0); // just submitted and just checked
      ctx.advance(3 * MIN);
      expect(await sweep()).toBe(1); // 5 min later
      ctx.advance(MIN);
      expect(await sweep()).toBe(0);
      ctx.advance(2 * HOUR);
      expect(await sweep()).toBe(1);
      ctx.advance(10 * MIN);
      expect(await sweep()).toBe(0); // in the first day: every 15 minutes
      ctx.advance(6 * MIN);
      expect(await sweep()).toBe(1);
      ctx.advance(24 * HOUR);
      expect(await sweep()).toBe(1);
      ctx.advance(30 * MIN);
      expect(await sweep()).toBe(0); // after a day: hourly
      ctx.advance(31 * MIN);
      expect(await sweep()).toBe(1);
      expect(p.t.id).toBeTruthy();
    });

    test('applies what it finds; the limit caps the number of Meta calls, oldest check first', async () => {
      const ctx = setup();
      const names = [];
      for (let i = 0; i < 4; i += 1) {
        const p = await pending(ctx, WS, `Batch ${i}`);
        names.push(p.name);
        ctx.advance(MIN);
      }
      ctx.advance(HOUR);
      for (const n of names) ctx.meta.rows.set(n, [row(n, 'ar', 'APPROVED')]);
      const first = await ctx.svc.refreshPending({ limit: 2 });
      expect(first).toMatchObject({ checked: 2, changed: 2 });
      expect(ctx.meta.listCalls).toEqual(names.slice(0, 2));
      ctx.meta.listCalls.length = 0;
      await ctx.svc.refreshPending({ limit: 2 });
      expect(ctx.meta.listCalls).toEqual(names.slice(2));
    });

    test('never throws on a Meta failure: counts it, gives up after three, stops at once when Meta is not configured', async () => {
      const ctx = setup();
      for (let i = 0; i < 5; i += 1) await pending(ctx, WS, `Fail ${i}`);
      ctx.advance(HOUR);
      ctx.meta.listImpl = async () => { throw new mt.MetaApiError({ code: 190, message: 'Token expired' }); };
      const res = await ctx.svc.refreshPending({});
      expect(res).toMatchObject({ checked: 0, errors: 3 });
      expect(ctx.meta.listCalls).toHaveLength(3);
      ctx.meta.listCalls.length = 0;
      ctx.meta.listImpl = async () => { throw new mt.MetaNotConfiguredError('x'); };
      expect((await ctx.svc.refreshPending({})).errors).toBe(1);
      expect(ctx.meta.listCalls).toHaveLength(1);
      expect(storedVariant(ctx.store, 'ar').metaStatus).toBe('PENDING');
    });

    test('with nothing pending it makes no call at all, and the default limit is 50', async () => {
      const ctx = setup();
      await expect(ctx.svc.refreshPending()).resolves.toMatchObject({ checked: 0, changed: 0 });
      for (let i = 0; i < 3; i += 1) await pending(ctx, WS, `P${i}`);
      ctx.advance(HOUR);
      await expect(ctx.svc.refreshPending({ limit: 0 })).resolves.toMatchObject({ checked: 1 }); // clamped to at least 1
      await expect(ctx.svc.refreshPending({ limit: 'abc' })).resolves.toMatchObject({ checked: 2 });
    });
  });
});

// ── test send ────────────────────────────────────────────────────────────
describe('testSendVariant', () => {
  const send = (ctx, id, phone, language = 'ar') => ctx.svc.testSendVariant({ workspaceId: WS, id, language, phone });

  async function approved(ctx, over = {}) {
    const t = await ctx.svc.createTemplate({
      workspaceId: WS, name: 'Test send', variants: [
        { language: 'ar', ...AR, buttons: [{ role: 'opt_in', text: 'نعم، أوافق' }, { role: 'decline', text: 'لا، شكراً' }, OPT_OUT_AR, { role: 'url', text: 'تصفح', url: 'https://example.com' }] },
        { language: 'en', ...EN },
      ], ...over,
    });
    await approve(ctx, t.id, 'ar');
    return t;
  }

  test('sends an APPROVED variant (still a draft review-wise) to the typed phone via the transport, with sample values and inert button payloads', async () => {
    const ctx = setup();
    const t = await approved(ctx);
    expect(variantOf(await ctx.svc.getTemplate({ workspaceId: WS, id: t.id }), 'ar').reviewStatus).toBe('draft');
    await expect(send(ctx, t.id, '0501234567')).resolves.toEqual({ sent: true, dryRun: false });
    expect(ctx.transport.sendTemplate).toHaveBeenCalledTimes(1);
    const { to, args } = ctx.transport.sent[0];
    expect(to).toBe('966501234567');
    expect(args.name).toMatch(/^wf_293a4b_test_send_ar_v1$/);
    expect(args.languageCode).toBe('ar');
    expect(args.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'سارة' }, { type: 'text', text: '120' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `consent_yes_${'0'.repeat(24)}` }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: `consent_no_${'0'.repeat(24)}` }] },
      { type: 'button', sub_type: 'quick_reply', index: '2', parameters: [{ type: 'payload', payload: 'l10ntest_optout' }] },
    ]);
  });

  describe('the test-send opt-out button must be inert: a tester tapping "Stop" must not opt their own customer record out', () => {
    // Every payload prefix the existing webhook dispatches on (server.js startsWith chains) plus the Arabic hook's.
    const fs = require('fs');
    const path = require('path');
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
    const prefixesIn = (source) => Array.from(source.matchAll(/\.startsWith\((["'])([^"']+)\1\)/g), (m) => m[2]);
    const hookPrefixes = ['shared/localization/inboundHook.js', 'shared/localization/consentAsk.js']
      .flatMap((rel) => Array.from(read(rel).matchAll(/const (?:YES|NO|OPT_OUT)_PREFIX = '([^']+)'/g), (m) => m[1]));

    test('the payload is l10ntest_optout, not an optout_ payload', () => {
      expect(internals.TEST_OPT_OUT_PAYLOAD).toBe('l10ntest_optout');
      expect(internals.TEST_OPT_OUT_PAYLOAD.startsWith('optout_')).toBe(false);
    });

    test('no prefix the English webhook (server.js) or the Arabic hook dispatches on matches it (a source scan: adding such a handler later fails this test)', () => {
      const prefixes = [...prefixesIn(read('server.js')), ...hookPrefixes];
      expect(prefixes).toEqual(expect.arrayContaining(['optout_', 'consent_yes_', 'consent_no_', 'msgnode_', 'promo_'])); // the scan really sees the handlers
      expect(hookPrefixes.sort()).toEqual(['consent_no_', 'consent_yes_', 'optout_']);
      const hits = prefixes.filter((p) => internals.TEST_OPT_OUT_PAYLOAD.startsWith(p));
      expect(hits).toEqual([]);
    });

    test('every opt-out button of a test send carries it, whatever the language or position', async () => {
      const ctx = setup();
      const t = await approved(ctx);
      await send(ctx, t.id, '0501234567', 'ar');
      await send(ctx, t.id, '0501234567', 'ar');
      for (const { args } of ctx.transport.sent) {
        const payloads = args.components.filter((c) => c.type === 'button').map((c) => c.parameters[0].payload);
        expect(payloads.filter((p) => /optout/i.test(p))).toEqual(['l10ntest_optout']);
        expect(payloads.some((p) => p.startsWith('optout_'))).toBe(false);
      }
    });
  });

  test('flow buttons carry the linked node id and their position (inert: no message row exists for a test send)', async () => {
    const ctx = setup();
    const t = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Flow test', linkedMessageNodeId: NODE, variants: [{ language: 'en', body: 'Hi {name}, check our new arrivals today.', buttons: [{ role: 'flow_button', text: 'Shop' }, OPT_OUT_EN] }] });
    await approve(ctx, t.id, 'en');
    await send(ctx, t.id, '0501234567', 'en');
    expect(ctx.transport.sent[0].args.components.filter((c) => c.type === 'button').map((c) => c.parameters[0].payload)).toEqual([`msgnode_${NODE}_0`, 'l10ntest_optout']);
    expect(ctx.transport.sent[0].args.components[0].parameters[0].text).toBe('Sara');
  });

  test.each([
    ['0501234567', '966501234567'],
    ['050 123 4567', '966501234567'],
    ['+966 50 123 4567', '966501234567'],
    ['00966501234567', '966501234567'],
    ['(966) 50-123-4567', '966501234567'],
    ['٠٥٠١٢٣٤٥٦٧', '966501234567'],
    ['+٩٦٦٥٠١٢٣٤٥٦٧', '966501234567'],
    ['\u{200F}+966501234567\u{200E}', '966501234567'],
    ['501234567', '966501234567'],
    ['966501234567', '966501234567'],
    ['+44 7700 900123', '447700900123'],
    [966501234567, '966501234567'],
  ])('phone %j -> %s', async (phone, expected) => {
    const ctx = setup();
    const t = await approved(ctx);
    await send(ctx, t.id, phone);
    expect(ctx.transport.sent[0].to).toBe(expected);
  });

  test('a local number uses the workspace default country code', async () => {
    const ctx = setup({ getDefaultCountryCode: jest.fn(async () => '971') });
    const t = await approved(ctx);
    await send(ctx, t.id, '0501234567');
    expect(ctx.transport.sent[0].to).toBe('971501234567');
  });

  test.each([[undefined], [null], [''], ['   '], ['abc'], ['050-abc-4567'], ['1234567'], ['+1234567'], ['1'.repeat(16)], ['+'.concat('1'.repeat(16))], [{ $ne: null }], [['0501234567']], [true], ['0501234567; DROP'], ['x'.repeat(41)], ['٠٥٠'], ['+966 50 123 4567 ext 12']])('phone %j -> 400 INVALID_PHONE, no send, no rate-limit slot used', async (phone) => {
    const ctx = setup();
    const t = await approved(ctx);
    await rejects(send(ctx, t.id, phone), { status: 400, code: 'INVALID_PHONE' });
    expect(ctx.transport.sendTemplate).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i += 1) await send(ctx, t.id, '0501234567'); // all ten slots are still free
  });

  test.each(['NOT_CREATED', 'PENDING', 'IN_APPEAL', 'REJECTED', 'PAUSED', 'DISABLED', 'FLAGGED', 'ERROR'])('a %s variant cannot be test-sent: 409 NOT_APPROVED', async (status) => {
    const ctx = setup();
    const t = await approved(ctx);
    storedVariant(ctx.store, 'ar').metaStatus = status;
    await rejects(send(ctx, t.id, '0501234567'), { status: 409, code: 'NOT_APPROVED' });
    expect(ctx.transport.sendTemplate).not.toHaveBeenCalled();
  });

  test('an approved variant without a Meta name is not sent (corrupt data never reaches Meta)', async () => {
    const ctx = setup();
    const t = await approved(ctx);
    delete storedVariant(ctx.store, 'ar').metaTemplateName;
    await rejects(send(ctx, t.id, '0501234567'), { code: 'NOT_APPROVED' });
  });

  test('missing template or variant, bad language, other tenant', async () => {
    const ctx = setup();
    const t = await approved(ctx);
    await rejects(send(ctx, t.id, '0501234567', 'bilingual'), { status: 404, code: 'VARIANT_NOT_FOUND' });
    await rejects(send(ctx, 'b'.repeat(24), '0501234567'), { status: 404, code: 'TEMPLATE_NOT_FOUND' });
    await rejects(send(ctx, t.id, '0501234567', 'fr'), { status: 400, code: 'INVALID_INPUT' });
    await rejects(ctx.svc.testSendVariant({ workspaceId: WS2, id: t.id, language: 'ar', phone: '0501234567' }), { status: 404, code: 'TEMPLATE_NOT_FOUND' });
    expect(ctx.transport.sendTemplate).not.toHaveBeenCalled();
  });

  test('limited to 10 per workspace per hour (429 RATE_LIMITED + retry hint); the window slides; other workspaces are independent', async () => {
    const ctx = setup();
    const t = await approved(ctx);
    for (let i = 0; i < 10; i += 1) await send(ctx, t.id, '0501234567');
    const err = await rejects(send(ctx, t.id, '0501234567'), { status: 429, code: 'RATE_LIMITED' });
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(ctx.transport.sent).toHaveLength(10);
    ctx.advance(30 * MIN);
    await rejects(send(ctx, t.id, '0501234567'), { code: 'RATE_LIMITED' });
    ctx.advance(31 * MIN);
    await expect(send(ctx, t.id, '0501234567')).resolves.toMatchObject({ sent: true });
    const other = await seed(ctx.svc, { workspaceId: WS2, name: 'Other' });
    ctx.meta.rows.clear();
    const res = await ctx.svc.submitVariant({ workspaceId: WS2, id: other.id, language: 'ar' });
    ctx.meta.rows.set(res.submission.metaTemplateName, [row2(res.submission.metaTemplateName)]);
    await ctx.svc.refreshTemplate({ workspaceId: WS2, templateId: other.id });
    await expect(ctx.svc.testSendVariant({ workspaceId: WS2, id: other.id, language: 'ar', phone: '0501234567' })).resolves.toMatchObject({ sent: true });
    function row2(name) { return { id: 'x', name, language: 'ar', status: 'APPROVED', category: 'MARKETING' }; }
  });

  test('a failed send still uses a slot (no hammering) and surfaces a sanitised META_ERROR', async () => {
    const ctx = setup();
    const t = await approved(ctx);
    ctx.transport.fail = Object.assign(new Error('Request failed'), { config: { headers: { Authorization: 'Bearer SECRETSECRETSECRETSECRET' } }, response: { status: 400, data: { error: { code: 132001, message: 'Template name does not exist in the translation', error_user_msg: 'Bearer ABCDEFGHIJKLMNOP leaked?' } } } });
    const err = await rejects(send(ctx, t.id, '0501234567'), { status: 502, code: 'META_ERROR' });
    expect(err.body.metaError.code).toBe(132001);
    expect(JSON.stringify(err.body)).not.toMatch(/SECRET|ABCDEFGHIJKLMNOP/);
    ctx.transport.fail = null;
    for (let i = 0; i < 9; i += 1) await send(ctx, t.id, '0501234567');
    await rejects(send(ctx, t.id, '0501234567'), { code: 'RATE_LIMITED' });
  });

  test('a transport error that is not an axios error is still a generic META_ERROR (nothing internal leaks)', async () => {
    const ctx = setup();
    const t = await approved(ctx);
    ctx.transport.fail = new Error('ECONNRESET at 10.0.0.5');
    const err = await rejects(send(ctx, t.id, '0501234567'), { status: 502, code: 'META_ERROR' });
    expect(JSON.stringify(err.body)).not.toContain('10.0.0.5');
  });

  test('dry-run is reported back (the transport logs instead of sending)', async () => {
    const ctx = setup();
    const t = await approved(ctx);
    ctx.transport.dry = true;
    await expect(send(ctx, t.id, '0501234567')).resolves.toEqual({ sent: true, dryRun: true });
  });
});

// ── preview ──────────────────────────────────────────────────────────────
describe('renderPreview', () => {
  const preview = (ctx, variant, extra = {}) => ctx.svc.renderPreview({ workspaceId: WS, variant, ...extra });

  test('Arabic: sample values in Arabic, Latin/number values direction-protected, buttons echoed', async () => {
    const ctx = setup();
    const out = await preview(ctx, { language: 'ar', ...AR, body: 'أهلاً {name}، رصيدك {points} نقطة، الكود {code} والتاريخ {date}.' });
    expect(out.language).toBe('ar');
    expect(out.body).toBe(`أهلاً سارة، رصيدك ${LRM}120${LRM} نقطة، الكود ${LRM}AB12CD34${LRM} والتاريخ 30 نوفمبر.`);
    expect(out.usedValues).toEqual({ name: 'سارة', points: '120', code: 'AB12CD34', date: '30 نوفمبر' });
    expect(out.missingFields).toEqual([]);
    expect(out.buttons).toEqual([OPT_OUT_AR]);
    expect(out.header).toBe('');
  });

  test('English: plain samples, no direction marks; the default footer is previewed because it will be sent', async () => {
    const ctx = setup();
    const out = await preview(ctx, { language: 'en', ...EN });
    expect(out).toMatchObject({ language: 'en', body: 'Hi Sara, you have 120 points to use this week.', footer: 'Reply STOP to unsubscribe', header: '' });
    const own = await preview(ctx, { language: 'en', ...EN, footer: 'My footer' });
    expect(own.footer).toBe('My footer');
    const none = await preview(ctx, { language: 'en', body: 'Plain {name}', buttons: [] });
    expect(none.footer).toBe('');
  });

  test('given values beat the customer\'s, which beat samples; numbers are accepted; values are sanitised', async () => {
    const ctx = setup();
    const out = await preview(ctx, { language: 'en', body: 'Hi {name} ({full_name}), {points} points, discount {discount}% at {business}.' }, {
      customerId: CUSTOMER, fieldValues: { name: 'Override\nName', discount: 15 },
    });
    expect(out.body).toBe('Hi Override Name (Fahad Al-Qahtani), 250 points, discount 15% at متجر الورد.');
    expect(out.usedValues).toEqual({ name: 'Override Name', full_name: 'Fahad Al-Qahtani', points: '250', discount: '15', business: 'متجر الورد' });
  });

  test('bilingual: each paragraph is protected according to its own language; one value per field', async () => {
    const ctx = setup();
    const out = await preview(ctx, { language: 'bilingual', ...BI, bilingualOrder: 'ar_first' });
    expect(out.body).toBe(`مرحباً سارة، لدينا عرض جديد لك اليوم.\n\nHello سارة, we have a new offer for you today.`);
    const withLatin = await preview(ctx, { language: 'bilingual', ...BI }, { fieldValues: { name: 'Sara' } });
    expect(withLatin.body).toBe(`مرحباً ${LRM}Sara${LRM}، لدينا عرض جديد لك اليوم.\n\nHello Sara, we have a new offer for you today.`);
    const enFirst = await preview(ctx, { language: 'bilingual', body: 'Hello {name}, we have an offer today.\n\nمرحباً {name}، لدينا عرض اليوم.', bilingualOrder: 'en_first', buttons: [OPT_OUT_EN] });
    expect(enFirst.body).toBe(`Hello Sara, we have an offer today.\n\nمرحباً ${LRM}Sara${LRM}، لدينا عرض اليوم.`);
    expect(enFirst.footer).toBe('Reply STOP to unsubscribe');
  });

  test('header and footer variables are rendered too', async () => {
    const ctx = setup();
    const out = await preview(ctx, { language: 'ar', ...AR, header: 'عرض خاص لك يا {name}' });
    expect(out.header).toBe('عرض خاص لك يا سارة');
  });

  test('fields nobody can fill stay as {field} in the text and are listed in missingFields', async () => {
    const ctx = setup();
    const out = await preview(ctx, { language: 'en', body: 'Hi {name}, your {coupon_zz} and {other_field} are ready today.', buttons: [] });
    expect(out.body).toBe('Hi Sara, your {coupon_zz} and {other_field} are ready today.');
    expect(out.missingFields).toEqual(['coupon_zz', 'other_field']);
    expect(out.usedValues).toEqual({ name: 'Sara' });
    const filled = await preview(ctx, { language: 'en', body: 'Your {coupon_zz} is ready today.', buttons: [] }, { fieldValues: { coupon_zz: 'SAVE10' } });
    expect(filled.body).toBe('Your SAVE10 is ready today.');
    expect(filled.missingFields).toEqual([]);
  });

  test('a field named like an Object.prototype member is missing, never an inherited function', async () => {
    const ctx = setup();
    const out = await preview(ctx, { language: 'en', body: 'Hello {constructor} and {toString} today.', buttons: [] });
    expect(out.body).toBe('Hello {constructor} and {toString} today.');
    expect(out.missingFields).toEqual(['constructor', 'toString']);
    const given = await preview(ctx, { language: 'en', body: 'Hello {constructor} today.', buttons: [] }, { fieldValues: { constructor: 'Own' } });
    expect(given.body).toBe('Hello Own today.');
  });

  test('a preview never changes anything and never needs a stored template', async () => {
    const ctx = setup();
    await preview(ctx, { language: 'ar', ...AR });
    expect(ctx.store.writes).toEqual([]);
    expect(ctx.store.docs).toEqual([]);
  });

  test('customer previews: other workspaces\' customers and unknown ids are CUSTOMER_NOT_FOUND; injection is INVALID_ID', async () => {
    const ctx = setup();
    await rejects(preview(ctx, { language: 'en', ...EN }, { customerId: 'b'.repeat(24) }), { status: 404, code: 'CUSTOMER_NOT_FOUND' });
    await rejects(ctx.svc.renderPreview({ workspaceId: WS2, variant: { language: 'en', ...EN }, customerId: CUSTOMER }), { status: 404, code: 'CUSTOMER_NOT_FOUND' });
    for (const customerId of [{ $ne: null }, ['a'], 'nope', 12]) await rejects(preview(ctx, { language: 'en', ...EN }, { customerId }), { status: 400, code: 'INVALID_ID' });
    await expect(preview(ctx, { language: 'en', ...EN }, { customerId: '' })).resolves.toBeDefined();
    await expect(preview(ctx, { language: 'en', ...EN }, { customerId: null })).resolves.toBeDefined();
  });

  test('input validation: variant, language, field values, hard limits', async () => {
    const ctx = setup();
    for (const variant of [undefined, null, 'x', [], 5]) await rejects(ctx.svc.renderPreview({ workspaceId: WS, variant }), { code: 'INVALID_INPUT' });
    await rejects(preview(ctx, { language: 'fr', body: 'x' }), { code: 'INVALID_INPUT' });
    await rejects(preview(ctx, { body: 'x' }), { code: 'INVALID_INPUT' });
    await rejects(preview(ctx, { language: 'en', body: 'x'.repeat(4097) }), { code: 'INVALID_INPUT' });
    for (const fieldValues of ['x', [], 5, { name: { $ne: 1 } }, { name: ['a'] }, { name: true }, { name: null }, { 'bad key': 'x' }, { 1: 'x' }, { _hidden: 'x' }, { name: 'x'.repeat(501) }, { name: Infinity }, Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`f${i}`, 'v']))]) {
      await rejects(preview(ctx, { language: 'en', ...EN }, { fieldValues }), { code: 'INVALID_INPUT' });
    }
    await expect(preview(ctx, { language: 'en', ...EN }, { fieldValues: JSON.parse('{"__proto__": "x"}') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(preview(ctx, { language: 'en', ...EN }, { fieldValues: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, 'v'])) })).resolves.toBeDefined();
    await expect(preview(ctx, { language: 'en', ...EN }, { fieldValues: { name: 'x'.repeat(500) } })).resolves.toBeDefined();
    await rejects(ctx.svc.renderPreview({ workspaceId: { $ne: null }, variant: { language: 'en', ...EN } }), { code: 'INVALID_ID' });
  });

  test('a draft with an unknown button role can still be previewed (the preview is lenient; storing and submitting are not)', async () => {
    const ctx = setup();
    const out = await preview(ctx, { language: 'en', body: 'Hi {name}', buttons: [{ role: 'custom', text: 'Odd' }] });
    expect(out.buttons).toEqual([{ role: 'custom', text: 'Odd' }]);
  });

  test('url buttons keep their url', async () => {
    const ctx = setup();
    const out = await preview(ctx, { language: 'en', body: 'Hi {name}', buttons: [{ role: 'url', text: 'Shop', url: 'https://example.com' }] });
    expect(out.buttons).toEqual([{ role: 'url', text: 'Shop', url: 'https://example.com' }]);
  });
});

// ── library ──────────────────────────────────────────────────────────────
describe('library', () => {
  const entry = (over = {}) => ({
    key: 'comeback', useCase: 'comeback', category: 'MARKETING', name: { en: 'Comeback offer', ar: 'عرض العودة' }, fields: ['name', 'discount'],
    variants: {
      en: { body: 'Hi {name}, we miss you! Enjoy {discount}% off your next order.', buttons: [OPT_OUT_EN], source: 'library' },
      ar: { body: 'أهلاً {name}، اشتقنا لك! خصم {discount}% على طلبك القادم.', buttons: [OPT_OUT_AR], source: 'library' },
    },
    ...over,
  });

  test('listLibrary delegates to the library module', async () => {
    const ctx = setup();
    ctx.library.listLibrary.mockReturnValue([entry()]);
    expect(await ctx.svc.listLibrary()).toEqual([entry()]);
  });

  test('creates a template with en + ar variants from the library: source library, draft, NOT_CREATED', async () => {
    const ctx = setup();
    ctx.library.getLibraryEntry.mockReturnValue(entry({ variants: { en: { ...entry().variants.en, reviewStatus: 'reviewed', metaStatus: 'APPROVED' }, ar: { ...entry().variants.ar, reviewStatus: 'reviewed' } } }));
    const t = await ctx.svc.createFromLibrary({ workspaceId: WS, userId: USER, libraryKey: 'comeback' });
    expect(ctx.library.getLibraryEntry).toHaveBeenCalledWith('comeback');
    expect(t).toMatchObject({ name: 'Comeback offer', key: 'comeback_offer', useCase: 'comeback', category: 'MARKETING' });
    expect(t.variants.map((v) => [v.language, v.source, v.reviewStatus, v.metaStatus, v.sendable])).toEqual([['en', 'library', 'draft', 'NOT_CREATED', false], ['ar', 'library', 'draft', 'NOT_CREATED', false]]);
    expect(ctx.store.docs[0].createdBy).toBe(USER);
    expect(variantOf(t, 'ar').validation.ok).toBe(true);
  });

  test('the UTILITY floor applies to a library copy too: only a transactional entry stays UTILITY', async () => {
    const ctx = setup();
    ctx.library.getLibraryEntry.mockReturnValue(entry({ key: 'sneaky', useCase: 'promotion', category: 'UTILITY', name: { en: 'Sneaky promo' } }));
    const floored = await ctx.svc.createFromLibrary({ workspaceId: WS, libraryKey: 'sneaky' });
    expect(floored.category).toBe('MARKETING');
    expect(ctx.store.docs[0].category).toBe('MARKETING');
    for (const useCase of ['payment_reminder', 'booking_confirmation', 'booking_reminder', 'order_confirmation']) {
      ctx.library.getLibraryEntry.mockReturnValue(entry({ key: useCase, useCase, category: 'UTILITY', name: { en: `Util ${useCase}` } }));
      expect((await ctx.svc.createFromLibrary({ workspaceId: WS, libraryKey: useCase })).category).toBe('UTILITY');
    }
  });

  test('the name gets " 2", " 3" ... while the key is taken; an explicit name keeps its own key suffixing', async () => {
    const ctx = setup();
    ctx.library.getLibraryEntry.mockReturnValue(entry());
    const names = [];
    for (let i = 0; i < 3; i += 1) names.push((await ctx.svc.createFromLibrary({ workspaceId: WS, libraryKey: 'comeback' })).name);
    expect(names).toEqual(['Comeback offer', 'Comeback offer 2', 'Comeback offer 3']);
    expect(ctx.store.docs.map((d) => d.key)).toEqual(['comeback_offer', 'comeback_offer_2', 'comeback_offer_3']);
    const mine = await ctx.svc.createFromLibrary({ workspaceId: WS, libraryKey: 'comeback', name: '  My comeback  ' });
    expect([mine.name, mine.key]).toEqual(['My comeback', 'my_comeback']);
    const again = await ctx.svc.createFromLibrary({ workspaceId: WS, libraryKey: 'comeback', name: 'My comeback' });
    expect([again.name, again.key]).toEqual(['My comeback', 'my_comeback_2']);
  });

  test('another workspace gets the plain name again', async () => {
    const ctx = setup();
    ctx.library.getLibraryEntry.mockReturnValue(entry());
    await ctx.svc.createFromLibrary({ workspaceId: WS, libraryKey: 'comeback' });
    expect((await ctx.svc.createFromLibrary({ workspaceId: WS2, libraryKey: 'comeback' })).name).toBe('Comeback offer');
  });

  test('unknown key -> 404 NOT_FOUND; the key must be a string', async () => {
    const ctx = setup();
    await rejects(ctx.svc.createFromLibrary({ workspaceId: WS, libraryKey: 'nope' }), { status: 404, code: 'NOT_FOUND' });
    for (const libraryKey of [undefined, null, '', '  ', 5, { $ne: 1 }, ['comeback']]) await rejects(ctx.svc.createFromLibrary({ workspaceId: WS, libraryKey }), { status: 400, code: 'INVALID_INPUT' });
    await rejects(ctx.svc.createFromLibrary({ workspaceId: { $ne: null }, libraryKey: 'comeback' }), { code: 'INVALID_ID' });
  });

  test('an entry with only one language creates just that variant; the bilingual order default is not consulted', async () => {
    const ctx = setup();
    ctx.library.getLibraryEntry.mockReturnValue(entry({ variants: { ar: entry().variants.ar } }));
    const t = await ctx.svc.createFromLibrary({ workspaceId: WS, libraryKey: 'comeback' });
    expect(t.variants.map((v) => v.language)).toEqual(['ar']);
    expect(ctx.deps.getBilingualOrder).not.toHaveBeenCalled();
  });

  test('a UTILITY entry stays UTILITY (no opt-out button needed)', async () => {
    const ctx = setup();
    ctx.library.getLibraryEntry.mockReturnValue(entry({ key: 'payment_reminder', useCase: 'payment_reminder', category: 'UTILITY', name: { en: 'Payment reminder', ar: 'تذكير بالدفع' }, variants: { en: { body: 'Hi {name}, please complete payment for order {order_id}.', buttons: [] }, ar: { body: 'مرحباً {name}، نذكّرك بإتمام الدفع لطلبك رقم {order_id}.', buttons: [] } } }));
    const t = await ctx.svc.createFromLibrary({ workspaceId: WS, libraryKey: 'payment_reminder' });
    expect(t.category).toBe('UTILITY');
    expect(t.variants.every((v) => v.validation.ok)).toBe(true);
  });
});

// ── the Mongoose store (recording fake model) ────────────────────────────
describe('createMongoStore', () => {
  function fakeModel() {
    const calls = [];
    const query = (value) => ({ limit() { return this; }, lean() { return this; }, then: (res, rej) => Promise.resolve(value).then(res, rej) });
    return {
      calls,
      create: async (doc) => { calls.push({ op: 'create', doc }); return { toObject: () => ({ _id: 'new', ...doc }) }; },
      findOne: (filter) => { calls.push({ op: 'findOne', filter }); return query({ _id: 'x' }); },
      find: (filter) => { calls.push({ op: 'find', filter }); return query([{ _id: 'x' }]); },
      updateOne: async (filter, update) => { calls.push({ op: 'updateOne', filter, update }); return { matchedCount: filter._id === 'missing' ? 0 : 1 }; },
    };
  }
  const make = () => { const model = fakeModel(); return { model, store: createMongoStore(() => model) }; };

  test('every query and write is scoped by workspaceId (the scheduler candidate query is the one cross-workspace read)', async () => {
    const { model, store } = make();
    await store.findOne(WS, 'tid');
    await store.list(WS, { useCase: 'comeback', archived: 'only' });
    await store.setFields(WS, 'tid', { name: 'x' });
    await store.insertVariant(WS, 'tid', 'ar', { language: 'ar' });
    await store.updateVariant(WS, 'tid', 'ar', { guard: { contentVersion: 1 }, set: { body: 'x' }, unset: ['lastError'], inc: { contentVersion: 1 } });
    await store.create({ workspaceId: WS, key: 'k' });
    for (const call of model.calls.filter((c) => c.op !== 'create')) expect(call.filter.workspaceId).toBe(WS);
    expect(model.calls.find((c) => c.op === 'create').doc.workspaceId).toBe(WS);
  });

  test('list: archived modes and use case become filters; default hides archived', async () => {
    const { model, store } = make();
    await store.list(WS);
    await store.list(WS, { archived: 'include' });
    await store.list(WS, { archived: 'only', useCase: 'greeting' });
    expect(model.calls.map((c) => c.filter)).toEqual([
      { workspaceId: WS, archived: { $ne: true } },
      { workspaceId: WS },
      { workspaceId: WS, useCase: 'greeting', archived: true },
    ]);
  });

  test('variant writes use the positional operator behind an $elemMatch guard; inserts only while the language is absent', async () => {
    const { model, store } = make();
    expect(await store.updateVariant(WS, 'tid', 'ar', { guard: { contentVersion: null, submissionCount: 2 }, set: { body: 'x', metaStatus: 'PENDING' }, unset: ['lastError', 'submittingAt'], inc: { submissionCount: 1 } })).toBe(true);
    expect(model.calls[0]).toEqual({
      op: 'updateOne',
      filter: { _id: 'tid', workspaceId: WS, variants: { $elemMatch: { language: 'ar', contentVersion: null, submissionCount: 2 } } },
      update: {
        $set: { 'variants.$.body': 'x', 'variants.$.metaStatus': 'PENDING' },
        $unset: { 'variants.$.lastError': '', 'variants.$.submittingAt': '' },
        $inc: { 'variants.$.submissionCount': 1 },
      },
    });
    await store.insertVariant(WS, 'tid', 'ar', { language: 'ar', body: 'b' });
    expect(model.calls[1]).toEqual({ op: 'updateOne', filter: { _id: 'tid', workspaceId: WS, 'variants.language': { $ne: 'ar' } }, update: { $push: { variants: { language: 'ar', body: 'b' } } } });
  });

  test('operators are only included when there is something to apply; a miss reports false', async () => {
    const { model, store } = make();
    await store.updateVariant(WS, 'tid', 'ar', { guard: {}, inc: { contentVersion: 1 } });
    expect(model.calls[0].update).toEqual({ $inc: { 'variants.$.contentVersion': 1 } });
    expect(await store.updateVariant(WS, 'missing', 'ar', { guard: {}, set: { a: 1 } })).toBe(false);
    expect(await store.setFields(WS, 'missing', { name: 'x' })).toBe(false);
    expect(await store.insertVariant(WS, 'missing', 'ar', {})).toBe(false);
  });

  test('the refresh candidate query selects non-archived templates with a submitted variant in the wanted statuses', async () => {
    const { model, store } = make();
    await store.findRefreshCandidates({ statuses: ['PENDING', 'PAUSED'], limit: 7 });
    expect(model.calls[0].filter).toEqual({
      archived: { $ne: true },
      variants: { $elemMatch: { metaStatus: { $in: ['PENDING', 'PAUSED'] }, metaTemplateName: { $exists: true, $ne: null } } },
    });
  });

  test('create returns the plain document; client-controlled ids never go into a filter unvalidated (the service validates them first)', async () => {
    const { store } = make();
    expect(await store.create({ workspaceId: WS, key: 'k' })).toMatchObject({ _id: 'new', key: 'k' });
    const ctx = setup();
    await rejects(ctx.svc.getTemplate({ workspaceId: WS, id: { $ne: null } }), { code: 'INVALID_ID' });
  });

  test('nothing in the service or the store can delete (no delete/remove/drop operations exist)', () => {
    const { store } = make();
    expect(Object.keys(store).sort()).toEqual(['create', 'findByMetaNames', 'findOne', 'findRefreshCandidates', 'insertVariant', 'list', 'setFields', 'updateVariant']);
    const source = require('fs').readFileSync(require.resolve('../../shared/localization/templates'), 'utf8');
    expect(source).not.toMatch(/deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|\.remove\(|\.drop\(|dropCollection|bulkWrite/);
  });
});

// ── rate limiter ─────────────────────────────────────────────────────────
describe('createRateLimiter', () => {
  test('allows `limit` takes per window per key, then refuses with a retry hint; the window slides', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t });
    expect([rl.take('a'), rl.take('a'), rl.take('a')].every((r) => r.ok)).toBe(true);
    expect(rl.take('a')).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(rl.take('b').ok).toBe(true);
    t = 999;
    expect(rl.take('a').ok).toBe(false);
    t = 1000;
    expect(rl.take('a').ok).toBe(true);
  });
  test('refused takes do not extend the penalty', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    rl.take('k');
    for (let i = 0; i < 50; i += 1) { t += 10; rl.take('k'); }
    t = 1000;
    expect(rl.take('k').ok).toBe(true);
  });
});

// ── catalogue + exports + errors ─────────────────────────────────────────
describe('catalogue defaults (catalog/templates.json)', () => {
  beforeAll(() => catalog.reload());

  test('the default marketing footer exists in both languages, fits the 60-character footer limit and is a draft', () => {
    const entry = catalog.listEntries().find((e) => e.key === 'templates.defaultMarketingFooter');
    expect(entry).toMatchObject({ en: 'Reply STOP to unsubscribe', ar: 'لإلغاء الاشتراك أرسل: إلغاء الاشتراك', status: 'draft' });
    expect(Array.from(entry.en).length).toBeLessThanOrEqual(60);
    expect(Array.from(entry.ar).length).toBeLessThanOrEqual(60);
  });

  test('the keyword the Arabic footer asks the customer to send is recognised as an opt-out (and so is the English one)', () => {
    const arabic = catalog.t('ar', 'templates.defaultMarketingFooter').split(':').pop().trim();
    expect(classifyInboundText(arabic)).toMatchObject({ kind: 'opt_out' });
    expect(classifyInboundText(catalog.t('en', 'templates.defaultMarketingFooter').replace(/^Reply\s+/i, '').replace(/\s+to unsubscribe$/i, ''))).toMatchObject({ kind: 'opt_out' });
  });

  test('Arabic copy follows the glossary: واتساب never Latin, tanween written alef + fathatan, Western digits only', () => {
    const ar = catalog.t('ar', 'templates.defaultMarketingFooter');
    expect(ar).not.toMatch(/whatsapp/i);
    expect(ar).not.toMatch(/\u{064B}\u{0627}/u);
    expect(ar).not.toMatch(/[\u{0660}-\u{0669}]/u);
  });
});

describe('module surface', () => {
  test('exports the interface other slices code against', () => {
    for (const name of ['toTemplateView', 'createTemplate', 'getTemplateDoc', 'upsertVariant', 'renderPreview', 'refreshPending', 'refreshTemplate', 'buildSendComponents']) {
      expect(typeof svcModule[name]).toBe('function');
    }
    expect(svcModule.buildSendComponents).toBe(mt.buildSendComponents);
  });

  test('TemplateError carries the full JSON body the route sends', () => {
    const e = new TemplateError(400, 'VARIANT_INVALID', 'msg', { issues: [{ code: 'x' }] });
    expect(e).toMatchObject({ status: 400, code: 'VARIANT_INVALID', expose: true, body: { error: 'msg', code: 'VARIANT_INVALID', issues: [{ code: 'x' }] } });
    expect(new TemplateError(502, 'META_ERROR', 'm', { metaError: { code: 1, message: 'x' } }).body).toEqual({ error: 'm', code: 'META_ERROR', metaError: { code: 1, message: 'x' } });
    expect(new TemplateError(404, 'TEMPLATE_NOT_FOUND', 'm').body).toEqual({ error: 'm', code: 'TEMPLATE_NOT_FOUND' });
  });

  test('requiring the module has no side effects: no database, no network, no timers', () => {
    expect(typeof createTemplatesService).toBe('function');
    expect(require('../../shared/localization/templates')).toBe(svcModule);
  });
});

// ── live-Meta findings (META-REALITY) ────────────────────────────────────
describe('live-Meta behaviour', () => {
  const submit = (ctx, id, language = 'ar') => ctx.svc.submitVariant({ workspaceId: WS, id, language });
  const refresh = (ctx, id) => ctx.svc.refreshTemplate({ workspaceId: WS, templateId: id });
  const row = (name, language, status, extra = {}) => ({ id: `meta-${name}`, name, language, status, category: 'MARKETING', ...extra });
  const UTILITY_AR = 'مرحباً {name}، نذكّرك بإتمام الدفع لطلبك رقم {order_id} اليوم.';

  describe('the create response is stored as Meta reports it', () => {
    test('id, status and category are persisted; a re-classification at creation is remembered and escalates the template', async () => {
      const ctx = setup();
      const t = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Pay', useCase: 'payment_reminder', variants: [{ language: 'ar', body: UTILITY_AR }] });
      ctx.meta.submitImpl = async () => ({ id: '777', status: 'PENDING', category: 'MARKETING' });
      const res = await submit(ctx, t.id);
      expect(ctx.meta.submitCalls[0].category).toBe('UTILITY');
      expect(storedVariant(ctx.store, 'ar')).toMatchObject({ metaTemplateId: '777', metaStatus: 'PENDING', metaStatusRaw: 'PENDING', metaCategory: 'MARKETING', metaPreviousCategory: 'UTILITY', metaFlagged: false });
      expect(variantOf(res.template, 'ar')).toMatchObject({ metaCategory: 'MARKETING', metaPreviousCategory: 'UTILITY', metaStatusRaw: 'PENDING', metaFlagged: false });
      expect(ctx.store.docs[0].category).toBe('MARKETING');
    });

    test('an unchanged category leaves no previous category; a missing one clears the old values', async () => {
      const ctx = setup();
      const t = await seed(ctx.svc);
      await submit(ctx, t.id);
      expect(storedVariant(ctx.store, 'ar')).toMatchObject({ metaCategory: 'MARKETING' });
      expect(storedVariant(ctx.store, 'ar').metaPreviousCategory).toBeUndefined();
      await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} جديد` } });
      ctx.meta.submitImpl = async () => ({ id: '9', status: 'PENDING', category: null });
      await submit(ctx, t.id);
      expect(storedVariant(ctx.store, 'ar').metaCategory).toBeUndefined();
    });
  });

  describe('text Meta rejected is never resubmitted unchanged', () => {
    async function rejected(ctx) {
      const t = await seed(ctx.svc);
      const name = (await submit(ctx, t.id)).submission.metaTemplateName;
      ctx.meta.rows.set(name, [row(name, 'ar', 'REJECTED', { rejected_reason: 'INVALID_FORMAT' })]);
      await refresh(ctx, t.id);
      return t;
    }

    test('resubmitting the rejected text is a 409 REJECTED_UNCHANGED and nothing is sent', async () => {
      const ctx = setup();
      const t = await rejected(ctx);
      expect(storedVariant(ctx.store, 'ar').rejectedContent).toHaveLength(1);
      const calls = ctx.meta.submitCalls.length;
      await rejects(submit(ctx, t.id), { status: 409, code: 'REJECTED_UNCHANGED' });
      expect(ctx.meta.submitCalls).toHaveLength(calls);
      expect(storedVariant(ctx.store, 'ar').submissionCount).toBe(1); // no revision was burnt
    });

    test('changed text can be submitted (new name); changing it BACK to the rejected text is refused again', async () => {
      const ctx = setup();
      const t = await rejected(ctx);
      await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} نص جديد` } });
      const second = await submit(ctx, t.id);
      expect(second.submission.metaTemplateName).toMatch(/_ar_v2$/);
      ctx.meta.rows.set(second.submission.metaTemplateName, [row(second.submission.metaTemplateName, 'ar', 'APPROVED')]);
      await refresh(ctx, t.id);
      await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR } });
      expect(storedVariant(ctx.store, 'ar').metaStatus).toBe('NOT_CREATED');
      await rejects(submit(ctx, t.id), { status: 409, code: 'REJECTED_UNCHANGED' });
    });

    test('rejections are remembered once per text and only the newest few are kept', async () => {
      const ctx = setup();
      const t = await rejected(ctx);
      await refresh(ctx, t.id); // the same rejection seen again adds nothing
      expect(storedVariant(ctx.store, 'ar').rejectedContent).toHaveLength(1);
      for (let i = 0; i < 7; i += 1) {
        await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} ${i}` } });
        const { submission } = await submit(ctx, t.id);
        ctx.meta.rows.set(submission.metaTemplateName, [row(submission.metaTemplateName, 'ar', 'REJECTED')]);
        await refresh(ctx, t.id);
      }
      expect(storedVariant(ctx.store, 'ar').rejectedContent).toHaveLength(5);
    });
  });

  describe('submission ceiling (META_TEMPLATE_LIMIT)', () => {
    test('at or above the ceiling a submission is refused with 409 and changes nothing', async () => {
      const ctx = setup();
      const t = await seed(ctx.svc);
      ctx.meta.usage = { used: 90, limit: 250 };
      const error = await rejects(submit(ctx, t.id), { status: 409, code: 'META_TEMPLATE_LIMIT' });
      expect(error.message).toMatch(/90/);
      expect(ctx.meta.submitCalls).toHaveLength(0);
      expect(storedVariant(ctx.store, 'ar')).toMatchObject({ submissionCount: 0, metaStatus: 'NOT_CREATED' });
      expect(storedVariant(ctx.store, 'ar').submittingAt).toBeUndefined();
    });

    test('below the ceiling it goes through; an unreadable count does not block (Meta enforces its own limit)', async () => {
      const ctx = setup();
      const t = await seed(ctx.svc);
      ctx.meta.usage = { used: 89, limit: 250 };
      await submit(ctx, t.id, 'ar');
      ctx.meta.usage = new mt.MetaApiError({ message: 'down' });
      await submit(ctx, t.id, 'en');
      expect(ctx.meta.submitCalls).toHaveLength(2);
      expect(ctx.deps.log).toHaveBeenCalledWith('template usage unavailable:', 'down');
    });

    test('dry-run never asks Meta; "not configured" is reported before the ceiling is looked at', async () => {
      const ctx = setup();
      const t = await seed(ctx.svc);
      ctx.transport.dry = true;
      ctx.meta.usage = { used: 500, limit: 250 };
      await expect(submit(ctx, t.id)).resolves.toMatchObject({ submission: { dryRun: true } });
      expect(ctx.meta.usageCalls).toBe(0);
      ctx.transport.dry = false;
      ctx.meta.configured = false;
      await rejects(submit(ctx, t.id), { status: 503, code: 'META_NOT_CONFIGURED' });
      expect(ctx.meta.usageCalls).toBe(0);
    });

    test('LOCALIZATION_TEMPLATE_CEILING sets the ceiling; anything unusable means 90', async () => {
      const ctx = setup();
      const { getCeiling, ...rest } = ctx.deps; // the real default reads the environment
      const svc = createTemplatesService(rest);
      try {
        delete process.env.LOCALIZATION_TEMPLATE_CEILING;
        expect((await svc.getMetaUsage()).ceiling).toBe(90);
        process.env.LOCALIZATION_TEMPLATE_CEILING = '5';
        expect(await svc.getMetaUsage()).toMatchObject({ ceiling: 5, used: 15, atCeiling: true });
        for (const bad of ['abc', '0', '-3', '']) {
          process.env.LOCALIZATION_TEMPLATE_CEILING = bad;
          expect((await svc.getMetaUsage()).ceiling).toBe(90);
        }
      } finally {
        delete process.env.LOCALIZATION_TEMPLATE_CEILING;
      }
    });

    test('GET meta-usage: { used, limit, ceiling, atCeiling }; nulls when Meta cannot be reached or in dry-run', async () => {
      const ctx = setup();
      expect(await ctx.svc.getMetaUsage()).toEqual({ used: 15, limit: 250, ceiling: 90, atCeiling: false });
      ctx.meta.usage = { used: 90, limit: 250 };
      expect(await ctx.svc.getMetaUsage()).toMatchObject({ used: 90, atCeiling: true });
      ctx.meta.usage = new mt.MetaNotConfiguredError('no token');
      expect(await ctx.svc.getMetaUsage()).toEqual({ used: null, limit: null, ceiling: 90, atCeiling: false });
      ctx.meta.usage = { used: 15, limit: 250 };
      ctx.transport.dry = true;
      const calls = ctx.meta.usageCalls;
      expect(await ctx.svc.getMetaUsage()).toEqual({ used: null, limit: null, ceiling: 90, atCeiling: false });
      expect(ctx.meta.usageCalls).toBe(calls);
    });
  });

  describe('polling by id', () => {
    test('GET /{id} is used when the id is known (no name search); category, previous category and quality are stored', async () => {
      const ctx = setup();
      const t = await seed(ctx.svc);
      const name = (await submit(ctx, t.id)).submission.metaTemplateName;
      const id = storedVariant(ctx.store, 'ar').metaTemplateId;
      ctx.meta.rows.set(name, [{ id, name, language: 'ar', status: 'APPROVED', category: 'UTILITY', previous_category: 'MARKETING', quality_score: { score: 'green' }, rejected_reason: 'NONE' }]);
      expect(await refresh(ctx, t.id)).toMatchObject({ checked: 1, changed: 1 });
      expect(ctx.meta.byIdCalls).toEqual([id]);
      expect(ctx.meta.listCalls).toEqual([]);
      expect(storedVariant(ctx.store, 'ar')).toMatchObject({ metaStatus: 'APPROVED', metaStatusRaw: 'APPROVED', metaCategory: 'UTILITY', metaPreviousCategory: 'MARKETING', metaQualityScore: 'GREEN' });
      expect(storedVariant(ctx.store, 'ar').metaRejectedReason).toBeUndefined();
    });

    test('a category that differs from the one seen before is remembered as the previous one', async () => {
      const ctx = setup();
      const t = await seed(ctx.svc);
      const name = (await submit(ctx, t.id)).submission.metaTemplateName;
      const id = storedVariant(ctx.store, 'ar').metaTemplateId;
      ctx.meta.rows.set(name, [row(name, 'ar', 'APPROVED', { id, category: 'UTILITY' })]);
      await refresh(ctx, t.id);
      ctx.meta.rows.set(name, [row(name, 'ar', 'APPROVED', { id, category: 'MARKETING' })]);
      await refresh(ctx, t.id);
      expect(storedVariant(ctx.store, 'ar')).toMatchObject({ metaCategory: 'MARKETING', metaPreviousCategory: 'UTILITY' });
    });

    test('when Graph does not know the id (null or error 100) the exact name + language lookup takes over', async () => {
      const ctx = setup();
      const t = await seed(ctx.svc);
      const name = (await submit(ctx, t.id)).submission.metaTemplateName;
      ctx.meta.rows.set(name, [row(name, 'en', 'REJECTED'), row(name, 'ar', 'APPROVED')]);
      ctx.meta.byIdImpl = async () => null;
      await refresh(ctx, t.id);
      expect(ctx.meta.listCalls).toEqual([name]);
      expect(storedVariant(ctx.store, 'ar').metaStatus).toBe('APPROVED');
      ctx.meta.byIdImpl = async () => { throw new mt.MetaApiError({ code: 100, message: 'Unsupported get request' }); };
      ctx.meta.rows.set(name, [row(name, 'ar', 'PAUSED')]);
      await refresh(ctx, t.id);
      expect(ctx.meta.listCalls).toEqual([name, name]);
      expect(storedVariant(ctx.store, 'ar').metaStatus).toBe('PAUSED');
    });

    test('any other Graph error fails a manual refresh with 502 META_ERROR and writes nothing', async () => {
      const ctx = setup();
      const t = await seed(ctx.svc);
      await submit(ctx, t.id);
      ctx.meta.byIdImpl = async () => { throw new mt.MetaApiError({ code: 190, message: 'Token expired' }); };
      await rejects(refresh(ctx, t.id), { status: 502, code: 'META_ERROR' });
      expect(storedVariant(ctx.store, 'ar')).toMatchObject({ metaStatus: 'PENDING', metaLastCheckedAt: new Date(T0) }); // still as submitted
      expect(ctx.meta.listCalls).toEqual([]);
    });
  });

  describe('delta sweep (sweepSince)', () => {
    async function twoSubmitted(ctx) {
      const t = await seed(ctx.svc);
      const ar = (await submit(ctx, t.id, 'ar')).submission.metaTemplateName;
      const en = (await submit(ctx, t.id, 'en')).submission.metaTemplateName;
      return { t, ar, en };
    }

    test('rows are matched to variants by id or exact name + language across workspaces; others are ignored', async () => {
      const ctx = setup();
      const { ar, en } = await twoSubmitted(ctx);
      ctx.enabled.add(WS3);
      const other = await seed(ctx.svc, { workspaceId: WS3 });
      const otherName = (await ctx.svc.submitVariant({ workspaceId: WS3, id: other.id, language: 'ar' })).submission.metaTemplateName;
      ctx.meta.sinceRows = [
        row(ar, 'ar', 'APPROVED', { id: 'zzz' }), // matched by exact name + language
        row(en, 'ar', 'REJECTED'), // right name, wrong language: ignored
        row(otherName, 'ar', 'REJECTED', { rejected_reason: 'SCAM' }),
        row('somebody_elses_template', 'ar', 'APPROVED'), // not ours (no wf_ prefix)
        row(`${ar}_x`, 'ar', 'REJECTED'), // a longer name is not our template
      ];
      const res = await ctx.svc.sweepSince({ since: new Date(T0) });
      expect(ctx.meta.sinceCalls).toEqual([new Date(T0)]);
      expect(res).toMatchObject({ rows: 4, matched: 2, changed: 2, notFound: 0, errors: 0 });
      expect(storedVariant(ctx.store, 'ar')).toMatchObject({ metaStatus: 'APPROVED', metaTemplateId: 'zzz' });
      expect(storedVariant(ctx.store, 'en').metaStatus).toBe('PENDING');
      expect(storedVariant(ctx.store, 'ar', 1)).toMatchObject({ metaStatus: 'REJECTED', metaRejectedReason: 'SCAM' });
      expect(storedVariant(ctx.store, 'ar', 1).rejectedContent).toHaveLength(1);
    });

    test('a variant edited after its submission (NOT_CREATED) is never touched; nor is a workspace without the Arabic flag', async () => {
      const ctx = setup();
      const { t, ar } = await twoSubmitted(ctx);
      await ctx.svc.upsertVariant({ workspaceId: WS, id: t.id, language: 'ar', input: { ...AR, body: `${AR.body} جديد` } });
      ctx.meta.sinceRows = [row(ar, 'ar', 'APPROVED')];
      expect(await ctx.svc.sweepSince({})).toMatchObject({ matched: 0, changed: 0 });
      expect(storedVariant(ctx.store, 'ar').metaStatus).toBe('NOT_CREATED');
      ctx.enabled.add(WS3);
      const other = await seed(ctx.svc, { workspaceId: WS3 });
      const otherName = (await ctx.svc.submitVariant({ workspaceId: WS3, id: other.id, language: 'ar' })).submission.metaTemplateName;
      ctx.enabled.delete(WS3);
      ctx.meta.sinceRows = [row(otherName, 'ar', 'APPROVED')];
      expect(await ctx.svc.sweepSince({})).toMatchObject({ matched: 0 });
      expect(storedVariant(ctx.store, 'ar', 1).metaStatus).toBe('PENDING');
    });

    test('Graph failures are reported, never thrown; dry-run calls nothing', async () => {
      const ctx = setup();
      ctx.meta.listTemplatesSince = async () => { throw new mt.MetaApiError({ message: 'down' }); };
      expect(await ctx.svc.sweepSince({})).toMatchObject({ errors: 1, matched: 0 });
      ctx.transport.dry = true;
      ctx.meta.listTemplatesSince = async () => { throw new Error('must not be called'); };
      expect(await ctx.svc.sweepSince({})).toMatchObject({ dryRun: true, rows: 0 });
    });

    test('an unknown status found by the sweep is stored as ERROR and later re-polled by the scheduler', async () => {
      const ctx = setup();
      const { ar } = await twoSubmitted(ctx);
      ctx.meta.sinceRows = [row(ar, 'ar', 'SOMETHING_NEW')];
      expect(await ctx.svc.sweepSince({})).toMatchObject({ matched: 1, unknown: 1 });
      expect(storedVariant(ctx.store, 'ar')).toMatchObject({ metaStatus: 'ERROR', metaStatusRaw: 'SOMETHING_NEW' });
      ctx.meta.rows.set(ar, [row(ar, 'ar', 'APPROVED', { id: storedVariant(ctx.store, 'ar').metaTemplateId })]);
      ctx.advance(2 * HOUR);
      await ctx.svc.refreshPending({});
      expect(storedVariant(ctx.store, 'ar').metaStatus).toBe('APPROVED');
    });
  });

  describe('Meta-compatible text is required before submitting', () => {
    test.each([
      ['starts with a variable', { body: '{name}، أهلاً بك في متجرنا اليوم وشكراً لك.', buttons: [OPT_OUT_AR] }, 'body_starts_with_variable'],
      ['ends with a variable', { body: 'أهلاً بك في متجرنا اليوم يا {name}', buttons: [OPT_OUT_AR] }, 'body_ends_with_variable'],
      ['has no Arabic', { body: 'Hello there {name} welcome back to our shop today.', buttons: [OPT_OUT_AR] }, 'arabic_variant_has_no_arabic'],
      ['carries a direction mark', { body: `أهلاً ${String.fromCodePoint(0x200e)}{name}، رصيدك الحالي من النقاط: {points}. استبدلها هذا الأسبوع.`, buttons: [OPT_OUT_AR] }, 'direction_marks_in_text'],
    ])('an Arabic body that %s is a 400 VARIANT_INVALID and nothing is sent', async (_, input, code) => {
      const ctx = setup();
      const t = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Bad', variants: [{ language: 'ar', ...input }] });
      const error = await rejects(submit(ctx, t.id), { status: 400, code: 'VARIANT_INVALID' });
      expect(codes(error.body.issues)).toContain(code);
      expect(ctx.meta.submitCalls).toHaveLength(0);
      expect(storedVariant(ctx.store, 'ar').submissionCount).toBe(0);
    });

    test('the consent request is MARKETING with opt-in + decline: valid without an opt-out button, and submitted as MARKETING', async () => {
      const ctx = setup();
      const t = await ctx.svc.createTemplate({
        workspaceId: WS, name: 'Welcome', useCase: 'welcome_optin',
        variants: [{ language: 'ar', body: 'حياك الله يا {name} في {business}، هل تود استلام عروضنا وتحديثاتنا عبر واتساب؟', buttons: [{ role: 'opt_in', text: 'نعم، أوافق' }, { role: 'decline', text: 'لا، شكراً' }] }],
      });
      expect(t.category).toBe('MARKETING');
      expect(variantOf(t, 'ar').validation.ok).toBe(true);
      await submit(ctx, t.id);
      expect(ctx.meta.submitCalls[0]).toMatchObject({ category: 'MARKETING', language: 'ar' });
      expect(ctx.meta.submitCalls[0].components.find((c) => c.type === 'BUTTONS').buttons.map((b) => b.type)).toEqual(['QUICK_REPLY', 'QUICK_REPLY']);
    });

    test('a decline button alone does not satisfy the marketing opt-out rule', async () => {
      const ctx = setup();
      const t = await ctx.svc.createTemplate({ workspaceId: WS, name: 'Decline only', variants: [{ language: 'ar', body: AR.body, buttons: [{ role: 'decline', text: 'لا، شكراً' }] }] });
      expect(codes(variantOf(t, 'ar').validation.errors)).toContain('marketing_requires_opt_out_button');
    });
  });

  describe('test sends carry no direction marks by default', () => {
    test('Latin/number sample values reach the transport as they are', async () => {
      const ctx = setup();
      const t = await seed(ctx.svc);
      const name = await approve(ctx, t.id, 'ar');
      expect(name).toMatch(/_ar_v1$/);
      await ctx.svc.testSendVariant({ workspaceId: WS, id: t.id, language: 'ar', phone: '0551234567' });
      const text = JSON.stringify(ctx.transport.sent[0].args.components);
      for (const mark of [0x200e, 0x200f, 0x061c]) expect(text.includes(String.fromCodePoint(mark))).toBe(false);
    });
  });
});
