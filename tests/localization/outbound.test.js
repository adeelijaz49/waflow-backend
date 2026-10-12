// Unit tests for the outbound localiser (shared/localization/outbound.js + the index.js wrapper), design D3 section 5.
// Models are in-memory fakes; no network, no database. The decision rule is tested rule by rule.
const mockDb = { locale: [], customers: [], langs: [], translations: [], products: [], services: [], calls: { locale: 0, customer: 0, lang: 0, translation: 0 } };

const mockMatch = (doc, filter) => Object.entries(filter || {}).every(([k, cond]) => {
  if (cond && typeof cond === 'object' && '$in' in cond) return cond.$in.map(String).includes(String(doc[k]));
  if (cond && typeof cond === 'object' && '$exists' in cond) return (doc[k] !== undefined) === !!cond.$exists;
  return String(doc[k]) === String(cond);
});
const mockQuery = (valueFn) => { const q = { select: () => q, limit: () => q, sort: () => q, lean: async () => valueFn() }; return q; };

jest.mock('../../models/LocaleSettings', () => ({
  find: (filter) => { mockDb.calls.locale += 1; return mockQuery(() => mockDb.locale.filter((d) => mockMatch(d, filter))); },
  findOne: (filter) => mockQuery(() => mockDb.locale.find((d) => mockMatch(d, filter)) || null),
}));
jest.mock('../../models/Customer', () => ({
  findOne: (filter) => { mockDb.calls.customer += 1; if (mockDb.throwCustomer) throw new Error('db down'); return mockQuery(() => mockDb.customers.find((d) => mockMatch(d, filter)) || null); },
}));
jest.mock('../../models/CustomerLanguage', () => ({
  findOne: (filter) => { mockDb.calls.lang += 1; return mockQuery(() => mockDb.langs.find((d) => mockMatch(d, filter)) || null); },
}));
jest.mock('../../models/ProductTranslation', () => ({
  find: (filter) => { mockDb.calls.translation += 1; return mockQuery(() => mockDb.translations.filter((d) => mockMatch(d, filter))); },
}));
jest.mock('../../models/Product', () => ({ find: (filter) => mockQuery(() => mockDb.products.filter((d) => mockMatch(d, filter))) }));
jest.mock('../../models/Service', () => ({ find: (filter) => mockQuery(() => mockDb.services.filter((d) => mockMatch(d, filter))) }));

const outbound = require('../../shared/localization/outbound');
const localization = require('../../shared/localization');
const catalog = require('../../shared/localization/catalog');

const id = (n) => String(n).padStart(24, '0');
const WS = id(1);
const WS2 = id(2);
const PHONE = '966500000001';
const text = (body, to = PHONE) => ({ messaging_product: 'whatsapp', to, type: 'text', text: { body } });
const EN_CHECKOUT = 'Sorry, checkout is unavailable right now. Please try again.';
const AR_CHECKOUT = catalog.t('ar', 'journey.text.checkoutUnavailable');
const buttons = (body, list, to = PHONE) => ({ messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text: body }, action: { buttons: list.map(([i, title]) => ({ type: 'reply', reply: { id: i, title } })) } } });
const addedBody = (name) => `✅ *${name}* added!\n💰 40.00 SAR\n\n🛒 Cart: 1 item · 40.00 SAR total\n\n_Keep tapping cards to add more, or checkout when ready._`;
const addedButtons = [['continue_shopping', 'Keep Browsing 🛍️'], ['checkout', 'Checkout ✅']];

const ENV_KEYS = ['LOCALIZATION_DISABLED', 'LOCALIZATION_ALLOW_DRAFT_PAGES', 'LOCALIZATION_NAME_POLICY', 'LOCALIZATION_DEBUG'];
const savedEnv = {};
beforeAll(() => { ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; }); });
afterAll(() => { ENV_KEYS.forEach((k) => { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }); });

beforeEach(() => {
  ENV_KEYS.forEach((k) => { delete process.env[k]; });
  Object.assign(mockDb, { locale: [], customers: [], langs: [], translations: [], products: [], services: [], throwCustomer: false, calls: { locale: 0, customer: 0, lang: 0, translation: 0 } });
  outbound._resetForTests();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); outbound._resetForTests(); });

const flagWorkspace = (ws = WS, def = 'en') => mockDb.locale.push({ workspaceId: ws, arabicEnabled: true, defaultCustomerLanguage: def });
const addCustomer = (language, { ws = WS, phone = PHONE, cid = id(100) } = {}) => {
  mockDb.customers.push({ _id: cid, workspaceId: ws, phone });
  if (language) mockDb.langs.push({ workspaceId: ws, customerId: cid, language });
};
const inWs = (ws, fn) => outbound.runWithWorkspace(ws, fn);

describe('the synchronous gate (mayApply)', () => {
  test('no workspace context: false, no I/O', async () => {
    flagWorkspace(); addCustomer('ar');
    expect(outbound.mayApply(text(EN_CHECKOUT))).toBe(false);
    const body = text(EN_CHECKOUT);
    expect(await outbound.apply(body)).toBe(body);
    expect(mockDb.calls).toEqual({ locale: 0, customer: 0, lang: 0, translation: 0 });
  });
  test('kill switch: false even inside a flagged context', async () => {
    flagWorkspace(); addCustomer('ar');
    process.env.LOCALIZATION_DISABLED = '1';
    await inWs(WS, async () => { expect(outbound.mayApply(text(EN_CHECKOUT))).toBe(false); const b = text(EN_CHECKOUT); expect(await outbound.apply(b)).toBe(b); });
    process.env.LOCALIZATION_DISABLED = 'true';
    await inWs(WS, async () => { expect(outbound.mayApply(text(EN_CHECKOUT))).toBe(false); });
    expect(mockDb.calls.locale).toBe(0);
  });
  test('templates and non text/interactive payloads: false', async () => {
    await inWs(WS, async () => {
      expect(outbound.mayApply({ messaging_product: 'whatsapp', to: PHONE, type: 'template', template: { name: 'x', language: { code: 'en' } } })).toBe(false);
      expect(outbound.mayApply({ messaging_product: 'whatsapp', to: PHONE, type: 'image' })).toBe(false);
      expect(outbound.mayApply(null)).toBe(false);
      expect(outbound.mayApply(undefined)).toBe(false);
    });
  });
  test('first use inside a context loads the snapshot once; afterwards an unflagged workspace is false with no DB access', async () => {
    flagWorkspace(WS2); // another workspace is flagged, ours is not
    await inWs(WS, async () => {
      const b = text(EN_CHECKOUT);
      expect(outbound.mayApply(b)).toBe(true); // snapshot not loaded yet
      expect(await outbound.apply(b)).toBe(b);
      expect(mockDb.calls.locale).toBe(1);
      for (let i = 0; i < 20; i += 1) { expect(outbound.mayApply(text(EN_CHECKOUT))).toBe(false); }
      expect(await outbound.apply(b)).toBe(b);
      expect(mockDb.calls).toEqual({ locale: 1, customer: 0, lang: 0, translation: 0 });
    });
  });
  test('stale-while-revalidate: after 30 s the OLD snapshot answers at once and is refreshed in the background (no await); a failed refresh keeps it', async () => {
    flagWorkspace(); addCustomer('ar');
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    const LocaleSettings = require('../../models/LocaleSettings');
    const origFind = LocaleSettings.find;
    const settle = () => new Promise((r) => setImmediate(r));
    try {
      await inWs(WS, async () => {
        expect((await outbound.apply(text(EN_CHECKOUT))).text.body).toBe(AR_CHECKOUT);
        expect(mockDb.calls.locale).toBe(1);
        now += 29 * 1000;
        expect(outbound.mayApply(text(EN_CHECKOUT))).toBe(true);
        await outbound.apply(text(EN_CHECKOUT));
        await settle();
        expect(mockDb.calls.locale).toBe(1); // not stale yet
        now += 2 * 1000; // 31 s old
        // the refresh hangs: the reply must not wait for it
        let release;
        LocaleSettings.find = () => { mockDb.calls.locale += 1; const q = { select: () => q, limit: () => q, lean: () => new Promise((resolve) => { release = () => resolve([]); }) }; return q; };
        expect(outbound.mayApply(text(EN_CHECKOUT))).toBe(true);
        expect((await outbound.apply(text(EN_CHECKOUT))).text.body).toBe(AR_CHECKOUT); // answered from the stale snapshot while the refresh is pending
        expect(mockDb.calls.locale).toBe(2);
        await outbound.apply(text(EN_CHECKOUT));
        expect(mockDb.calls.locale).toBe(2); // one refresh in flight, shared
        release(); await settle(); // the refresh finished: the workspace is no longer flagged
        const b = text(EN_CHECKOUT);
        expect(outbound.mayApply(b)).toBe(false);
        expect(await outbound.apply(b)).toBe(b);
      });
    } finally { Date.now = realNow; LocaleSettings.find = origFind; }
  });
  test('a FAILING background refresh keeps the previous snapshot (Arabic keeps working) and backs off for 10 s', async () => {
    flagWorkspace(); addCustomer('ar');
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    const LocaleSettings = require('../../models/LocaleSettings');
    const origFind = LocaleSettings.find;
    const settle = () => new Promise((r) => setImmediate(r));
    try {
      await inWs(WS, async () => {
        expect((await outbound.apply(text(EN_CHECKOUT))).text.body).toBe(AR_CHECKOUT);
        now += 31 * 1000;
        LocaleSettings.find = () => { mockDb.calls.locale += 1; throw new Error('cosmos 429'); };
        expect((await outbound.apply(text(EN_CHECKOUT))).text.body).toBe(AR_CHECKOUT);
        await settle();
        expect(mockDb.calls.locale).toBe(2);
        await outbound.apply(text(EN_CHECKOUT)); await settle();
        expect(mockDb.calls.locale).toBe(2); // backing off for 10 s
        now += 11 * 1000;
        LocaleSettings.find = origFind;
        await outbound.apply(text(EN_CHECKOUT)); await settle();
        expect(mockDb.calls.locale).toBe(3);
      });
    } finally { Date.now = realNow; LocaleSettings.find = origFind; }
  });
  test('withoutLocalization (transport sends) is never touched, even for a flagged Arabic customer', async () => {
    flagWorkspace(); addCustomer('ar');
    await inWs(WS, async () => {
      await outbound.apply(text(EN_CHECKOUT)); // load the snapshot
      await outbound.withoutLocalization(async () => {
        const b = text(EN_CHECKOUT);
        expect(outbound.mayApply(b)).toBe(false);
        expect(await outbound.apply(b)).toBe(b);
      });
      expect(outbound.mayApply(text(EN_CHECKOUT))).toBe(true); // outside the bypass: back to normal
    });
  });
  test('a failed snapshot load sends English and backs off instead of hammering the database', async () => {
    jest.spyOn(Date, 'now');
    const LocaleSettings = require('../../models/LocaleSettings');
    const orig = LocaleSettings.find;
    let calls = 0;
    LocaleSettings.find = () => { calls += 1; throw new Error('cosmos 429'); };
    try {
      await inWs(WS, async () => {
        const b = text(EN_CHECKOUT);
        expect(await outbound.apply(b)).toBe(b);
        expect(outbound.mayApply(text(EN_CHECKOUT))).toBe(false); // inside the back-off window
        expect(calls).toBe(1);
      });
    } finally { LocaleSettings.find = orig; }
  });
});

describe('the language rule (customer > workspace default > en)', () => {
  test('Arabic customer of a flagged workspace gets Arabic; the payload is a NEW object with the same envelope', async () => {
    flagWorkspace(); addCustomer('ar');
    await inWs(WS, async () => {
      const b = text(EN_CHECKOUT);
      const out = await outbound.apply(b);
      expect(out).not.toBe(b);
      expect(out.text.body).toBe(AR_CHECKOUT);
      expect(out.to).toBe(PHONE);
      expect(b.text.body).toBe(EN_CHECKOUT); // original untouched
    });
  });
  test('English customer: the SAME object comes back', async () => {
    flagWorkspace(); addCustomer('en');
    await inWs(WS, async () => { const b = text(EN_CHECKOUT); expect(await outbound.apply(b)).toBe(b); });
  });
  test('known customer without a language row (or unknown language) falls to the workspace default; the customer own language beats the default', async () => {
    flagWorkspace(WS, 'ar'); addCustomer('unknown', { cid: id(101), phone: '966500000002' }); addCustomer('en', { cid: id(102), phone: '966500000003' }); addCustomer(null, { cid: id(103), phone: '966500000004' });
    await inWs(WS, async () => {
      expect((await outbound.apply(text(EN_CHECKOUT, '966500000002'))).text.body).toBe(AR_CHECKOUT); // language row says unknown: default ar
      expect((await outbound.apply(text(EN_CHECKOUT, '966500000004'))).text.body).toBe(AR_CHECKOUT); // customer without any language row: default ar
      const en = text(EN_CHECKOUT, '966500000003');
      expect(await outbound.apply(en)).toBe(en); // known English customer: English
    });
  });
  test('R2-01: a recipient that is not a customer of the context workspace gets English even when the workspace default is Arabic (also cached, negative result included)', async () => {
    flagWorkspace(WS, 'ar'); addCustomer('ar');
    mockDb.customers.push({ _id: id(500), workspaceId: WS2, phone: '966500000009' }); // a customer of ANOTHER workspace
    await inWs(WS, async () => {
      const stranger = text(EN_CHECKOUT, '966500000009');
      expect(await outbound.apply(stranger)).toBe(stranger); // the original payload object
      const random = text(EN_CHECKOUT, '966500000008');
      expect(await outbound.apply(random)).toBe(random);
      const callsAfter = { ...mockDb.calls };
      expect(await outbound.apply(stranger)).toBe(stranger);
      expect(await outbound.apply(random)).toBe(random);
      expect(mockDb.calls).toEqual(callsAfter); // the negative result is served from the 20 s cache: no new lookups
      expect((await outbound.apply(text(EN_CHECKOUT))).text.body).toBe(AR_CHECKOUT); // a real Arabic customer of this workspace is unaffected
    });
  });
  test('R2-01: the unknown recipient is looked up workspace-scoped with the exact phone, like the existing handlers', async () => {
    flagWorkspace(WS, 'ar');
    const Customer = require('../../models/Customer');
    const seen = [];
    const orig = Customer.findOne;
    Customer.findOne = (filter) => { seen.push(filter); return orig(filter); };
    try {
      await inWs(WS, async () => { await outbound.apply(text(EN_CHECKOUT, '966500000008')); });
    } finally { Customer.findOne = orig; }
    expect(seen).toEqual([{ workspaceId: WS, phone: '966500000008' }]);
  });
  test('cached 20 s per (workspace, phone) and shared between concurrent callers; noteLanguage makes a new language visible at once', async () => {
    flagWorkspace(); addCustomer('en');
    await inWs(WS, async () => {
      await Promise.all([outbound.apply(text(EN_CHECKOUT)), outbound.apply(text(EN_CHECKOUT)), outbound.apply(text(EN_CHECKOUT))]);
      expect(mockDb.calls.customer).toBe(1);
      mockDb.langs[0].language = 'ar'; // DB changed, cache still English
      expect((await outbound.apply(text(EN_CHECKOUT))).text.body).toBe(EN_CHECKOUT);
      outbound.noteLanguage(WS, PHONE, 'ar');
      expect((await outbound.apply(text(EN_CHECKOUT))).text.body).toBe(AR_CHECKOUT);
    });
  });
  test('the cache expires', async () => {
    flagWorkspace(); addCustomer('en');
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      await inWs(WS, async () => {
        await outbound.apply(text(EN_CHECKOUT));
        mockDb.langs[0].language = 'ar';
        now += 21 * 1000;
        expect((await outbound.apply(text(EN_CHECKOUT))).text.body).toBe(AR_CHECKOUT);
      });
    } finally { Date.now = realNow; }
  });
  test('noteLanguage ignores junk and never throws', () => {
    expect(() => outbound.noteLanguage(undefined, undefined, 'ar')).not.toThrow();
    expect(() => outbound.noteLanguage(WS, PHONE, 'fr')).not.toThrow();
    expect(() => outbound.noteLanguage(WS, '', 'ar')).not.toThrow();
  });
  test('another workspace (flagged, other customers) does not leak: customers are looked up inside the context workspace', async () => {
    flagWorkspace(WS); flagWorkspace(WS2);
    addCustomer('ar', { ws: WS2, cid: id(200) }); // the Arabic customer lives in WS2 only
    await inWs(WS, async () => { const b = text(EN_CHECKOUT); expect(await outbound.apply(b)).toBe(b); });
    await inWs(WS2, async () => { expect((await outbound.apply(text(EN_CHECKOUT))).text.body).toBe(AR_CHECKOUT); });
  });
});

describe('matching, policy and fail-open', () => {
  beforeEach(() => { flagWorkspace(); addCustomer('ar'); });

  test('unmatched English (merchant text) stays English and is logged once per message', async () => {
    await inWs(WS, async () => {
      const b = text('Hello, your order is on its way!');
      expect(await outbound.apply(b)).toBe(b);
      expect(await outbound.apply(text('Hello, your order is on its way!'))).toEqual(b);
    });
    const logged = console.warn.mock.calls.filter((c) => /no Arabic shape/.test(String(c[0])));
    expect(logged).toHaveLength(1);
    expect(String(logged[0][0])).not.toMatch(/Hello|order|way/); // review R1-05/R2-05: no message text in the log
  });
  test('LOCALIZATION_ALLOW_DRAFT_PAGES=0: draft journey copy is not served', async () => {
    process.env.LOCALIZATION_ALLOW_DRAFT_PAGES = '0';
    await inWs(WS, async () => { const b = text(EN_CHECKOUT); expect(await outbound.apply(b)).toBe(b); });
  });
  test('a database error while looking the customer up sends English (fail-open)', async () => {
    mockDb.throwCustomer = true;
    await inWs(WS, async () => { const b = text(EN_CHECKOUT); expect(await outbound.apply(b)).toBe(b); });
  });
  test('names: only REVIEWED translations are used; a draft one stays English', async () => {
    mockDb.products.push({ _id: id(300), workspaceId: WS, name: 'Red Hat' }, { _id: id(301), workspaceId: WS, name: 'Blue Shirt' });
    mockDb.translations.push(
      { workspaceId: WS, kind: 'product', refId: id(300), language: 'ar', name: 'قبعة حمراء', status: 'reviewed', source: 'merchant' },
      { workspaceId: WS, kind: 'product', refId: id(301), language: 'ar', name: 'قميص أزرق', status: 'draft', source: 'merchant' },
    );
    await inWs(WS, async () => {
      expect((await outbound.apply(buttons(addedBody('Red Hat'), addedButtons))).interactive.body.text).toContain('*قبعة حمراء*');
      expect((await outbound.apply(buttons(addedBody('Blue Shirt'), addedButtons))).interactive.body.text).toContain('*Blue Shirt*');
    });
  });
  test('LOCALIZATION_NAME_POLICY=human also accepts merchant/csv drafts but never AI drafts', async () => {
    process.env.LOCALIZATION_NAME_POLICY = 'human';
    mockDb.products.push({ _id: id(300), workspaceId: WS, name: 'Red Hat' }, { _id: id(301), workspaceId: WS, name: 'Blue Shirt' });
    mockDb.translations.push(
      { workspaceId: WS, kind: 'product', refId: id(300), language: 'ar', name: 'قبعة حمراء', status: 'draft', source: 'csv' },
      { workspaceId: WS, kind: 'product', refId: id(301), language: 'ar', name: 'قميص أزرق', status: 'draft', source: 'ai' },
    );
    await inWs(WS, async () => {
      expect((await outbound.apply(buttons(addedBody('Red Hat'), addedButtons))).interactive.body.text).toContain('*قبعة حمراء*');
      expect((await outbound.apply(buttons(addedBody('Blue Shirt'), addedButtons))).interactive.body.text).toContain('*Blue Shirt*');
    });
  });
  test('an English name used by two items with different Arabic names is not translated; a variant suffix is kept', async () => {
    mockDb.products.push({ _id: id(300), workspaceId: WS, name: 'Hat' }, { _id: id(301), workspaceId: WS, name: 'Hat' }, { _id: id(302), workspaceId: WS, name: 'Scarf' });
    mockDb.translations.push(
      { workspaceId: WS, kind: 'product', refId: id(300), language: 'ar', name: 'قبعة', status: 'reviewed' },
      { workspaceId: WS, kind: 'product', refId: id(301), language: 'ar', name: 'طاقية', status: 'reviewed' },
      { workspaceId: WS, kind: 'product', refId: id(302), language: 'ar', name: 'وشاح', status: 'reviewed' },
    );
    await inWs(WS, async () => {
      expect((await outbound.apply(buttons(addedBody('Hat'), addedButtons))).interactive.body.text).toContain('*Hat*');
      expect((await outbound.apply(buttons(addedBody('Scarf (M · Blue)'), addedButtons))).interactive.body.text).toContain('*وشاح (M · Blue)*');
    });
  });
  test('translations of another workspace are never used', async () => {
    mockDb.products.push({ _id: id(300), workspaceId: WS2, name: 'Red Hat' });
    mockDb.translations.push({ workspaceId: WS2, kind: 'product', refId: id(300), language: 'ar', name: 'قبعة حمراء', status: 'reviewed' });
    await inWs(WS, async () => { expect((await outbound.apply(buttons(addedBody('Red Hat'), addedButtons))).interactive.body.text).toContain('*Red Hat*'); });
  });
  test('more than 5,000 Arabic names disables the name map (English names) instead of loading everything', async () => {
    mockDb.translations = Array.from({ length: 5001 }, (_, i) => ({ workspaceId: WS, kind: 'product', refId: id(1000 + i), language: 'ar', name: 'اسم', status: 'reviewed' }));
    await inWs(WS, async () => { expect((await outbound.apply(buttons(addedBody('Red Hat'), addedButtons))).interactive.body.text).toContain('*Red Hat*'); });
  });
  test('the pay link gets ?lang=ar', async () => {
    const body = '🛒 *Your Order Summary*\n\n1. Red Hat — 40.00 SAR\n\nSubtotal: 40.00 SAR\nShipping: 0.50 SAR\n*Total: 40.50 SAR*\n\n📍 Delivering to:\n1 Main St\n\nPay securely:\nhttps://app.example/pay/pi_3Abc123';
    await inWs(WS, async () => { expect((await outbound.apply(text(body))).text.body).toContain('https://app.example/pay/pi_3Abc123?lang=ar'); });
  });
  test('concurrent contexts of two workspaces never see each other', async () => {
    flagWorkspace(WS2); addCustomer('en', { ws: WS2, cid: id(201) }); // same phone: Arabic in WS, English in WS2
    const results = await Promise.all([
      inWs(WS, async () => { await new Promise((r) => setTimeout(r, 5)); return outbound.apply(text(EN_CHECKOUT)); }),
      inWs(WS2, async () => { await new Promise((r) => setTimeout(r, 1)); return outbound.apply(text(EN_CHECKOUT)); }),
      inWs(WS, async () => outbound.apply(text(EN_CHECKOUT))),
    ]);
    expect(results.map((r) => r.text.body)).toEqual([AR_CHECKOUT, EN_CHECKOUT, AR_CHECKOUT]);
  });
  test('enterContext (the webhook hunk) scopes the rest of an async chain and leaves the caller untouched', async () => {
    const handler = async () => {
      await new Promise((r) => setTimeout(r, 1)); // like: await resolveWebhookWorkspaceId()
      outbound.enterContext(WS);
      await new Promise((r) => setTimeout(r, 1));
      return outbound.apply(text(EN_CHECKOUT));
    };
    const [a, b] = await Promise.all([handler(), handler()]);
    expect(a.text.body).toBe(AR_CHECKOUT);
    expect(b.text.body).toBe(AR_CHECKOUT);
    expect(outbound.mayApply(text(EN_CHECKOUT))).toBe(false); // the caller's frame stayed clean
    expect(() => outbound.enterContext(undefined)).not.toThrow();
    expect(() => outbound.enterContext(null)).not.toThrow();
  });
  test('refreshFlags picks up an un-flagged workspace at once', async () => {
    await inWs(WS, async () => { expect((await outbound.apply(text(EN_CHECKOUT))).text.body).toBe(AR_CHECKOUT); });
    mockDb.locale = mockDb.locale.filter((d) => String(d.workspaceId) !== WS);
    await outbound.refreshFlags();
    await inWs(WS, async () => { const b = text(EN_CHECKOUT); expect(outbound.mayApply(b)).toBe(false); expect(await outbound.apply(b)).toBe(b); });
  });
  test('refreshFlags in a process that never loaded the snapshot does nothing (no database work)', async () => {
    outbound._resetForTests();
    await outbound.refreshFlags();
    expect(mockDb.calls.locale).toBe(0);
  });
});

describe('never holds a customer-facing reply (review R4-2 / R1-04 / R2-07)', () => {
  const slow = (ms, valueFn) => { const q = { select: () => q, limit: () => q, sort: () => q, lean: () => new Promise((resolve) => { setTimeout(() => resolve(valueFn()), ms); }) }; return q; };
  const track = (p) => { const s = { done: false }; p.then(() => { s.done = true; }); return s; };
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }); });
  afterEach(() => { jest.useRealTimers(); });

  test('the very first snapshot load is awaited for at most 1.5 s, then the ORIGINAL payload goes out; the load continues and serves the next message', async () => {
    flagWorkspace(); addCustomer('ar');
    const LocaleSettings = require('../../models/LocaleSettings');
    const orig = LocaleSettings.find;
    LocaleSettings.find = (filter) => { mockDb.calls.locale += 1; return slow(10 * 1000, () => mockDb.locale.filter((d) => mockMatch(d, filter))); };
    try {
      await inWs(WS, async () => {
        const b = text(EN_CHECKOUT);
        const p = outbound.apply(b);
        const state = track(p);
        await jest.advanceTimersByTimeAsync(1499);
        expect(state.done).toBe(false);
        await jest.advanceTimersByTimeAsync(2);
        expect(await p).toBe(b); // the same object: no Arabic, no delay beyond the budget
        expect(console.error.mock.calls.filter((c) => /first load took more than 1500 ms/.test(String(c.join(' '))))).toHaveLength(1);
        // a second message while the load is still running shares it (no second read) and is not held either
        // V-FIX-X: after the timeout the first load is treated like a failed one for 10 s, so the next messages are not held at all
        const b2 = text(EN_CHECKOUT);
        const p2 = outbound.apply(b2);
        const state2 = track(p2);
        await jest.advanceTimersByTimeAsync(0);
        expect(state2.done).toBe(true);
        expect(await p2).toBe(b2);
        await jest.advanceTimersByTimeAsync(1600);
        expect(mockDb.calls.locale).toBe(1);
        // the load finishes in the background: the next message is localised
        await jest.advanceTimersByTimeAsync(9000);
        expect((await outbound.apply(text(EN_CHECKOUT))).text.body).toBe(AR_CHECKOUT);
      });
    } finally { LocaleSettings.find = orig; }
  });
  test('the whole awaited part of apply() is raced against 2 s: a slow customer lookup sends the original body, once-per-minute log', async () => {
    flagWorkspace(); addCustomer('ar');
    await inWs(WS, async () => {
      expect((await outbound.apply(text(EN_CHECKOUT))).text.body).toBe(AR_CHECKOUT); // snapshot loaded, everything fast
      const Customer = require('../../models/Customer');
      const orig = Customer.findOne;
      Customer.findOne = (filter) => slow(5 * 1000, () => mockDb.customers.find((d) => mockMatch(d, filter)) || null);
      try {
        const b = text(EN_CHECKOUT, '966500000042');
        const p = outbound.apply(b);
        const state = track(p);
        await jest.advanceTimersByTimeAsync(1999);
        expect(state.done).toBe(false);
        await jest.advanceTimersByTimeAsync(2);
        expect(await p).toBe(b);
        const slowLogs = () => console.error.mock.calls.filter((c) => /took more than 2000 ms/.test(String(c.join(' ')))).length;
        expect(slowLogs()).toBe(1);
        const b2 = text(EN_CHECKOUT, '966500000043');
        const p2 = outbound.apply(b2);
        await jest.advanceTimersByTimeAsync(2100);
        expect(await p2).toBe(b2);
        expect(slowLogs()).toBe(1); // rate-limited
        await jest.advanceTimersByTimeAsync(61 * 1000);
        const b3 = text(EN_CHECKOUT, '966500000044');
        const p3 = outbound.apply(b3);
        await jest.advanceTimersByTimeAsync(2100);
        expect(await p3).toBe(b3);
        expect(slowLogs()).toBe(2);
      } finally { Customer.findOne = orig; }
    });
  });
  test('a slow Arabic-names load is covered by the same budget', async () => {
    flagWorkspace(); addCustomer('ar');
    const Translation = require('../../models/ProductTranslation');
    const orig = Translation.find;
    Translation.find = () => slow(5 * 1000, () => []);
    try {
      await inWs(WS, async () => {
        const b = buttons(addedBody('Red Hat'), addedButtons);
        const p = outbound.apply(b);
        await jest.advanceTimersByTimeAsync(2100);
        expect(await p).toBe(b);
      });
    } finally { Translation.find = orig; }
  });
  test('a loaded snapshot is never awaited: a hanging refresh of a stale snapshot does not delay the reply at all', async () => {
    flagWorkspace(); addCustomer('ar');
    await inWs(WS, async () => {
      expect((await outbound.apply(text(EN_CHECKOUT))).text.body).toBe(AR_CHECKOUT);
      await jest.advanceTimersByTimeAsync(31 * 1000);
      const LocaleSettings = require('../../models/LocaleSettings');
      const orig = LocaleSettings.find;
      LocaleSettings.find = () => { mockDb.calls.locale += 1; return slow(60 * 1000, () => []); };
      try {
        const p = outbound.apply(text(EN_CHECKOUT));
        const state = track(p);
        await jest.advanceTimersByTimeAsync(0); // no timers advanced: only microtasks
        expect(state.done).toBe(true);
        expect((await p).text.body).toBe(AR_CHECKOUT);
      } finally { LocaleSettings.find = orig; }
    });
  });
  test('paymentLinkBody is raced against 2 s too (null = keep the English text)', async () => {
    flagWorkspace(); addCustomer('ar');
    const args = { workspaceId: WS, phone: PHONE, amount: '150.00 SAR', url: 'https://app.example/pay/pi_3Abc123' };
    expect(await outbound.paymentLinkBody(args)).toContain('150.00');
    const Customer = require('../../models/Customer');
    const orig = Customer.findOne;
    Customer.findOne = (filter) => slow(5 * 1000, () => mockDb.customers.find((d) => mockMatch(d, filter)) || null);
    try {
      const p = outbound.paymentLinkBody({ ...args, phone: '966500000077' });
      await jest.advanceTimersByTimeAsync(2100);
      expect(await p).toBeNull();
    } finally { Customer.findOne = orig; }
  });
});

describe('enterContext skips AsyncLocalStorage when it cannot matter (review R1-01)', () => {
  // Each case runs in its own async chain (after a first await) like the webhook handler; the outcome is observed through
  // mayApply: a context that was entered makes it true while no snapshot is loaded, no context makes it false.
  const inHandler = (fn) => (async () => { await new Promise((r) => setTimeout(r, 1)); return fn(); })();

  test('kill switch on: nothing is entered', async () => {
    process.env.LOCALIZATION_DISABLED = '1';
    const entered = await inHandler(() => { outbound.enterContext(WS); delete process.env.LOCALIZATION_DISABLED; return outbound.mayApply(text(EN_CHECKOUT)); });
    expect(entered).toBe(false);
  });
  test('no snapshot loaded yet: it still enters (the first send loads the snapshot)', async () => {
    flagWorkspace(WS2);
    expect(await inHandler(() => { outbound.enterContext(WS); return outbound.mayApply(text(EN_CHECKOUT)); })).toBe(true);
    expect(mockDb.calls.locale).toBe(0); // entering does no I/O
  });
  test('snapshot loaded and the workspace is not flagged: nothing is entered; a flagged workspace still enters', async () => {
    flagWorkspace(WS2); addCustomer('ar', { ws: WS2, cid: id(200) });
    await inWs(WS2, async () => { await outbound.apply(text(EN_CHECKOUT)); }); // loads the snapshot
    expect(await inHandler(() => { outbound.enterContext(WS); return outbound.mayApply(text(EN_CHECKOUT)); })).toBe(false);
    expect(await inHandler(() => { outbound.enterContext(WS2); return outbound.mayApply(text(EN_CHECKOUT)); })).toBe(true);
    expect(await inHandler(async () => { outbound.enterContext(WS2); await new Promise((r) => setTimeout(r, 1)); return (await outbound.apply(text(EN_CHECKOUT))).text.body; })).toBe(AR_CHECKOUT);
  });
  test('an unflagged installation still sees a flag change: enterContext refreshes a stale snapshot in the background, the next message enters', async () => {
    flagWorkspace(WS2);
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    const settle = () => new Promise((r) => setImmediate(r));
    try {
      await inWs(WS2, async () => { await outbound.apply(text(EN_CHECKOUT)); });
      expect(mockDb.calls.locale).toBe(1);
      now += 31 * 1000;
      flagWorkspace(WS); addCustomer('ar');
      expect(await inHandler(() => { outbound.enterContext(WS); return outbound.mayApply(text(EN_CHECKOUT)); })).toBe(false); // stale snapshot still says unflagged
      await settle();
      expect(mockDb.calls.locale).toBe(2); // ... but the refresh was started
      expect(await inHandler(async () => { outbound.enterContext(WS); await new Promise((r) => setTimeout(r, 1)); return (await outbound.apply(text(EN_CHECKOUT))).text.body; })).toBe(AR_CHECKOUT);
    } finally { Date.now = realNow; }
  });
});

describe('the unmatched-message log carries no message text (review R1-05 / R2-05)', () => {
  beforeEach(() => { flagWorkspace(); addCustomer('ar'); });
  const shapeLogs = () => console.warn.mock.calls.map((c) => String(c[0])).filter((l) => /no Arabic shape/.test(l));

  test('a fingerprint hash and the length are logged; the text never is; one line per fingerprint (digits are masked)', async () => {
    await inWs(WS, async () => {
      await outbound.apply(text('Order 111 for Ahmed Al-Qahtani is ready at 12 Main St'));
      await outbound.apply(text('Order 222 for Ahmed Al-Qahtani is ready at 12 Main St')); // same shape, other digits: one line
      await outbound.apply(text('A completely different message for Layla'));
    });
    const lines = shapeLogs();
    expect(lines).toHaveLength(2);
    lines.forEach((l) => { expect(l).toMatch(/shape=[0-9a-f]{10} len=\d+$/); expect(l).not.toMatch(/Ahmed|Layla|Order|Main St|ready|message/); });
    expect(lines[0]).toContain('len=53');
    expect(lines[0]).not.toBe(lines[1]);
    // stable across restarts of the process: the same text hashes to the same id
    outbound._resetForTests(); flagWorkspace(); addCustomer('ar'); console.warn.mockClear();
    await inWs(WS, async () => { await outbound.apply(text('Order 333 for Ahmed Al-Qahtani is ready at 12 Main St')); });
    expect(shapeLogs()[0]).toBe(lines[0]);
  });
  test('interactive messages log the same way, and a payload without text logs a constant', async () => {
    await inWs(WS, async () => {
      await outbound.apply(buttons('Special hello for Omar', [['a', 'Yes']]));
      await outbound.apply({ messaging_product: 'whatsapp', to: PHONE, type: 'interactive', interactive: { type: 'list', action: {} } });
    });
    const lines = shapeLogs();
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toMatch(/Omar|Special/);
    expect(lines[1]).toMatch(/shape=none len=0/);
  });
  test('LOCALIZATION_DEBUG=1 logs the payload but masks the recipient to its last 4 digits', async () => {
    process.env.LOCALIZATION_DEBUG = '1';
    await inWs(WS, async () => { await outbound.apply(text('Debug hello for Sara')); });
    expect(shapeLogs()).toHaveLength(0);
    const dbg = console.error.mock.calls.filter((c) => /no Arabic shape/.test(String(c[0])));
    expect(dbg).toHaveLength(1);
    const dump = String(dbg[0][1]);
    expect(dump).toContain('Debug hello for Sara');
    expect(dump).toContain('"to":"...0001"');
    expect(dump).not.toContain(PHONE);
    expect(String(dbg[0][0])).not.toContain(PHONE);
  });
});

describe('index.js wrapper (what both waPost functions call)', () => {
  test('returns the very same object synchronously when nothing applies', () => {
    const b = text(EN_CHECKOUT);
    expect(localization.localizeOutbound(b)).toBe(b);
    expect(localization.localizeOutbound(null)).toBeNull();
    expect(localization.localizeOutbound(undefined)).toBeUndefined();
  });
  test('returns a promise of the Arabic payload when it applies', async () => {
    flagWorkspace(); addCustomer('ar');
    await inWs(WS, async () => {
      const b = text(EN_CHECKOUT);
      const out = localization.localizeOutbound(b);
      expect(out).not.toBe(b);
      expect(typeof out.then).toBe('function');
      expect((await out).text.body).toBe(AR_CHECKOUT);
    });
  });
  test('enterContext wrapper never throws', () => { expect(() => localization.enterContext(WS)).not.toThrow(); expect(() => localization.enterContext()).not.toThrow(); });
});

describe('paymentLinkBody (Inbox hunk I1)', () => {
  const args = { workspaceId: WS, phone: PHONE, amount: '150.00 SAR', url: 'https://app.example/pay/pi_3Abc123' };
  test('Arabic customer of a flagged workspace: Arabic text with SAR sign and ?lang=ar', async () => {
    flagWorkspace(); addCustomer('ar');
    const body = await outbound.paymentLinkBody(args);
    expect(body).toContain('150.00 ر.س');
    expect(body).toContain('https://app.example/pay/pi_3Abc123?lang=ar');
    expect(body).not.toMatch(/Here's/);
  });
  test('null (= keep the English text) for: English customer, unflagged workspace, kill switch, draft policy, junk', async () => {
    flagWorkspace(); addCustomer('en');
    expect(await outbound.paymentLinkBody(args)).toBeNull();
    outbound._resetForTests(); mockDb.langs = []; addCustomer('ar', { cid: id(101), phone: '966500000007' });
    expect(await outbound.paymentLinkBody({ ...args, workspaceId: WS2, phone: '966500000007' })).toBeNull(); // WS2 not flagged
    process.env.LOCALIZATION_DISABLED = '1';
    expect(await outbound.paymentLinkBody({ ...args, phone: '966500000007' })).toBeNull();
    delete process.env.LOCALIZATION_DISABLED;
    process.env.LOCALIZATION_ALLOW_DRAFT_PAGES = '0';
    expect(await outbound.paymentLinkBody({ ...args, phone: '966500000007' })).toBeNull();
    delete process.env.LOCALIZATION_ALLOW_DRAFT_PAGES;
    expect(await outbound.paymentLinkBody({})).toBeNull();
    expect(await outbound.paymentLinkBody({ ...args, url: '' })).toBeNull();
  });
});
