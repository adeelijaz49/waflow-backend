// Shared in-memory fakes for the legacy-sender suites (legacySenders / legacyPlan / senderVariants / utilitySend /
// sendersRoute tests). Not a test file. Every collaborator honours the query filters it is given, the transport is a
// jest.fn (no WhatsApp call, ever) and the Meta component builder and the decision code are the REAL ones, so what
// the tests assert is what would go to Meta.
const { extractWamid } = require('../../shared/localization/transport');

const id = (n) => String(n).padStart(24, '0');
const WS = id(0xa1);
const OTHER_WS = id(0xb2);

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, cond]) => {
    const actual = doc[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ('$in' in cond) return cond.$in.map(String).includes(String(actual));
      if ('$ne' in cond) return String(actual) !== String(cond.$ne);
      if ('$gt' in cond) return Number(actual) > Number(cond.$gt);
      if ('$exists' in cond) return cond.$exists ? actual !== undefined : actual === undefined;
    }
    return actual !== undefined && String(actual) === String(cond);
  });
}

function chain(read) {
  const q = { select: () => q, populate: () => q, sort: () => q, limit: () => q, lean: async () => read(), then: (resolve, reject) => Promise.resolve(read()).then(resolve, reject) };
  return q;
}

function fakeModel(docs = []) {
  return {
    docs,
    find: jest.fn((filter) => chain(() => structuredClone(docs.filter((d) => matches(d, filter))))),
    findOne: jest.fn((filter) => chain(() => { const hit = docs.find((d) => matches(d, filter)); return hit ? structuredClone(hit) : null; })),
    findById: jest.fn((value) => chain(() => { const hit = docs.find((d) => String(d._id) === String(value)); return hit ? structuredClone(hit) : null; })),
    create: jest.fn(async (doc) => { const row = { _id: id(docs.length + 900), ...doc }; docs.push(row); return row; }),
    updateOne: jest.fn(async (filter, update) => {
      const hit = docs.find((d) => matches(d, filter));
      if (hit && update && update.$set) Object.assign(hit, update.$set);
      return { matchedCount: hit ? 1 : 0 };
    }),
  };
}

const OPT_OUT = Object.freeze({ role: 'opt_out', text: 'إلغاء الاشتراك' });
const SHOP_NOW = Object.freeze({ role: 'shop_now', text: 'تسوق الآن' });

const arabicVariant = (over = {}) => ({
  language: 'ar',
  body: 'أهلاً {name}، جرّب {item} بسعر {price} ضمن {promo_name}',
  footer: 'لإلغاء الاشتراك أرسل: إلغاء الاشتراك',
  buttons: [{ ...SHOP_NOW }, { ...OPT_OUT }],
  metaStatus: 'APPROVED', reviewStatus: 'reviewed', metaTemplateName: 'wf_0000a1_promo_ar_v1', metaLanguage: 'ar', ...over,
});

const englishVariant = (over = {}) => ({ language: 'en', body: 'Hi {name}', buttons: [{ role: 'opt_out', text: 'Opt Out' }], metaStatus: 'APPROVED', metaTemplateName: 'wf_en', metaLanguage: 'en', ...over });

let templateSeq = 0;
const template = (over = {}) => {
  templateSeq += 1;
  return {
    _id: id(0x500 + templateSeq), workspaceId: WS, key: `t${templateSeq}`, name: `Template ${templateSeq}`, useCase: 'promotion', category: 'MARKETING',
    variants: [arabicVariant()], archived: false, updatedAt: new Date(Date.UTC(2026, 9, 1 + (templateSeq % 20))), ...over,
  };
};

const PROMOTION_ID = id(10);
const promotionDoc = (over = {}) => ({
  _id: PROMOTION_ID, workspaceId: WS, name: 'Summer Sale', customerType: 'cash', scope: 'products', discountPercent: 20, pointsPrice: 0,
  isDemo: false, sendFormat: 'separate', products: [], services: [], endDate: new Date(Date.UTC(2026, 10, 30)), ...over,
});
const productDoc = (over = {}) => ({ _id: id(30), name: 'Coffee beans', basePrice: 50, ...over });

let customerSeq = 0;
const customerDoc = (over = {}) => {
  customerSeq += 1;
  return {
    _id: id(0x100 + customerSeq), workspaceId: WS, firstname: 'Sara', lastname: 'Ahmed', phone: `96650000${String(1000 + customerSeq)}`,
    loyaltyPoints: 125, marketingConsent: true, optedOut: false, isDemo: false, ...over,
  };
};

// customers: [{ doc, language }] helper -> docs + CustomerLanguage rows
function world({ customers = [], languages = {}, templates = [], nodes = [], settingsByWs = {}, flagged = [WS], currency = 'SAR', merchantName = 'Aroma Cafe', items = [] } = {}) {
  const sent = [];
  const rows = [];
  const campaignMessages = [];
  const transport = {
    isDryRun: jest.fn(() => false),
    sendTemplate: jest.fn(async (to, payload) => { sent.push({ to, ...payload }); return { messages: [{ id: `wamid.${sent.length}` }] }; }),
    sendText: jest.fn(async (to, body) => { sent.push({ to, text: body }); return { messages: [{ id: `wamid.t${sent.length}` }] }; }),
    sendButtons: jest.fn(async (to, payload) => { sent.push({ to, buttons: payload }); return { messages: [{ id: `wamid.b${sent.length}` }] }; }),
    extractWamid,
  };
  const settings = {
    killSwitchOn: jest.fn(() => false),
    isArabicEnabled: jest.fn(async (ws) => flagged.map(String).includes(String(ws))),
    getSettings: jest.fn(async (ws) => ({ defaultCustomerLanguage: (settingsByWs[String(ws)] && settingsByWs[String(ws)].defaultCustomerLanguage) || 'en' })),
  };
  const CustomerLanguage = fakeModel(Object.entries(languages).map(([customerId, language]) => ({ workspaceId: (customers.find((c) => String(c._id) === customerId) || {}).workspaceId || WS, customerId, language })));
  const deps = {
    settings,
    transport,
    Customer: fakeModel(customers),
    CustomerLanguage,
    LocalizedTemplate: fakeModel(templates),
    MessageNode: fakeModel(nodes),
    LocalizedLegacySend: Object.assign(fakeModel(rows), { rows }),
    CampaignMessage: Object.assign(fakeModel(campaignMessages), { rows: campaignMessages }),
    Settings: fakeModel([{ workspaceId: WS, merchantName }, { workspaceId: OTHER_WS, merchantName: 'Other Shop' }]),
    Workspace: fakeModel([{ _id: WS, name: 'Aroma' }]),
    Product: fakeModel(items), Service: fakeModel([]),
    catalogTranslations: { resolveItemNames: jest.fn(async () => new Map()) },
    consent: { canSendMarketing: (c) => !!c && c.marketingConsent === true && c.optedOut !== true },
    getCurrency: jest.fn(async () => currency),
    sleep: jest.fn(async () => {}),
    now: () => Date.UTC(2026, 9, 12),
    newRunId: () => 'run1',
    log: jest.fn(),
    sendTimeoutMs: 1000,
  };
  return { deps, sent, rows, campaignMessages, transport };
}

module.exports = {
  id, WS, OTHER_WS, PROMOTION_ID, matches, chain, fakeModel, OPT_OUT, SHOP_NOW, arabicVariant, englishVariant, template, promotionDoc, productDoc, customerDoc, world,
};
