// Unit tests for the Inbox tools service (shared/localization/inboxTools.js):
// Arabic-aware conversation search, the language context, the localised payment
// link and the localised loyalty reminder. No database, no Stripe, no WhatsApp:
// every collaborator is a fake. The model fakes EMULATE the Mongo filters the
// service sends ($in / $ne / $exists / equality), so a dropped workspaceId or a
// missing demo/erased guard makes a test fail instead of passing vacuously.
jest.mock('../../utils/whatsapp', () => ({ waPost: jest.fn() })); // shared/consent.js imports it; never called here

const fs = require('fs');
const path = require('path');
const catalog = require('../../shared/localization/catalog');
const { LRM } = require('../../shared/localization/arabicText');
const { extractFields } = require('../../shared/localization/mergeFields');
const { canSendMarketing } = require('../../shared/consent');
const tools = require('../../shared/localization/inboxTools');

const id = (n) => n.toString(16).padStart(24, '0');
const WS = id(1);
const OTHER_WS = id(2);
const USER = id(7);
const CUST = id(100);

// ── fakes ────────────────────────────────────────────────────────────────

function matchValue(actual, cond) {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
    return Object.entries(cond).every(([op, arg]) => {
      if (op === '$in') return arg.map(String).includes(String(actual));
      if (op === '$ne') return String(actual) !== String(arg);
      if (op === '$exists') return (actual !== undefined) === arg;
      throw new Error(`fake model: unsupported operator ${op}`);
    });
  }
  return String(actual) === String(cond);
}
const matches = (doc, filter) => Object.entries(filter).every(([key, cond]) => matchValue(doc[key], cond));

function fakeModel(docs = []) {
  const query = (result) => {
    const q = { select: () => q, sort: () => q, limit: () => q, lean: async () => result };
    return q;
  };
  return {
    find: jest.fn((filter) => query(docs.filter((d) => matches(d, filter)))),
    findOne: jest.fn((filter) => query(docs.find((d) => matches(d, filter)) || null)),
  };
}

const customerDoc = (over = {}) => ({
  _id: CUST, workspaceId: WS, phone: '966501234567', marketingConsent: true, optedOut: false, loyaltyPoints: 120, ...over,
});

const variant = (language, over = {}) => ({
  language,
  body: language === 'ar' ? 'أهلاً {name}، رصيدك الحالي من النقاط: {points}' : 'Hi {name}, your points balance is {points}',
  metaStatus: 'APPROVED', reviewStatus: 'reviewed', metaTemplateName: `wf_loyalty_${language}`, ...over,
});

const template = (n, variants, over = {}) => ({
  _id: id(500 + n), workspaceId: WS, useCase: 'loyalty_reminder', archived: false,
  updatedAt: new Date(Date.UTC(2026, 9, n)), variants, ...over,
});

function makeDeps(over = {}) {
  const stripe = { paymentIntents: { create: jest.fn(async () => ({ id: 'pi_test_123' })) } };
  return {
    stripe,
    Customer: fakeModel(over.customers || [customerDoc()]),
    CustomerLanguage: fakeModel(over.languages || []),
    LocalizedTemplate: fakeModel(over.templates || []),
    Settings: fakeModel(over.settings || [{ workspaceId: WS, currency: 'SAR' }]),
    transport: {
      isDryRun: jest.fn(() => false),
      sendText: jest.fn(async () => ({ dryRun: true, messages: [{ id: 'dryrun.1.abc' }] })),
      extractWamid: (r) => r && r.messages && r.messages[0] && r.messages[0].id,
    },
    catalog,
    appUrl: 'https://app.example.test',
    locks: tools.createLocks(),
    log: jest.fn(),
    getStripe: jest.fn(() => stripe),
    getMerchantDefault: jest.fn(async () => over.merchantDefault || 'en'),
    listConversations: jest.fn(async () => ({ conversations: over.rows || [] })),
    sendManualMessage: jest.fn(async () => ({ _id: id(900) })),
    canSendMarketing: jest.fn(canSendMarketing),
    sendSingle: jest.fn(async () => ({ sent: true, status: 'sent' })),
    ...(over.deps || {}),
  };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to reject');
}
function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}
const expectApiError = (err, status, code) => {
  expect(err).toMatchObject({ status, code, expose: true });
  return err;
};

describe('the model fakes (so the scoping assertions below are meaningful)', () => {
  test('a filter without workspaceId WOULD return another tenant\'s customer', async () => {
    const other = customerDoc({ workspaceId: OTHER_WS });
    const fake = fakeModel([other]);
    expect(await fake.findOne({ _id: CUST }).lean()).toBe(other);
    expect(await fake.findOne({ _id: CUST, workspaceId: WS }).lean()).toBeNull();
  });
  test('$exists:false and $ne:true behave like MongoDB for missing fields', () => {
    expect(matches({ a: 1 }, { deletedAt: { $exists: false } })).toBe(true);
    expect(matches({ deletedAt: new Date() }, { deletedAt: { $exists: false } })).toBe(false);
    expect(matches({}, { isDemo: { $ne: true } })).toBe(true);
    expect(matches({ isDemo: false }, { isDemo: { $ne: true } })).toBe(true);
    expect(matches({ isDemo: true }, { isDemo: { $ne: true } })).toBe(false);
  });
});

// ── 1. Search ────────────────────────────────────────────────────────────

const row = (n, name, phone, preview = null, over = {}) => ({
  customerId: id(1000 + n), name, phone, optedOut: false, unreadCount: 0,
  lastMessageAt: new Date(Date.UTC(2026, 9, 11, 12, 0, 0, n)).toISOString(), lastMessagePreview: preview, tags: [], ...over,
});

const ROWS = {
  A: row(1, 'أَحْمَد المنصوري', '966501234567', 'تم تأكيد حجزك'),
  B: row(2, 'سارة أحمد', '966555000111', 'شكراً جزيلاً'),
  C: row(3, 'إبراهيم العتيبي', '966540000222', 'متى يصل الطلب؟'),
  D: row(4, 'فاطمة', '966590001234', '↩️ نعم، أوافق'),
  E: row(5, 'Sara Ahmed', '14155550123', 'Where is my order?'),
  F: row(6, 'عبد الله القحطاني', '966511112222', ''),
  G: row(7, 'محـــمد', '966522223333', null),
  H: row(8, 'علي', '966533334444', '🛍️ Order placed — 2 item(s)'),
  I: row(9, '966566667777', '966566667777', null),
  J: row(10, 'عبدالله', '966577778888', undefined),
};
const ALL_ROWS = Object.values(ROWS);
const keysFor = (term) => {
  const search = tools.buildSearch(term);
  return Object.entries(ROWS).filter(([, r]) => tools.matchesSearch(search, r)).map(([k]) => k);
};

describe('Arabic-aware search — names', () => {
  test.each([
    ['احمد', ['A', 'B']], // alef-hamza in the stored name, tashkeel on أَحْمَد
    ['أحمد', ['A', 'B']],
    ['أَحْمَد', ['A', 'B']], // tashkeel in the query
    ['ساره', ['B']], // teh marbuta typed as heh
    ['سارة', ['B']],
    ['ابراهيم', ['C']], // alef-hamza-below in the stored name
    ['إبراهيم', ['C']],
    ['فاطمه', ['D']],
    ['على', ['H']], // alef maksura typed for ya
    ['علي', ['H']],
    ['محمد', ['G']], // tatweel in the stored name
    ['محـــمد', ['G']], // tatweel in the query
    ['SARA', ['E']], // Latin is case-insensitive
    ['sara', ['E']],
    ['Sara Ahmed', ['E']],
  ])('"%s" finds %j', (term, expected) => {
    expect(keysFor(term)).toEqual(expected);
  });

  test('tokens are ANDed across the first and last name, in any order', () => {
    expect(keysFor('سارة أحمد')).toEqual(['B']);
    expect(keysFor('احمد ساره')).toEqual(['B']);
    expect(keysFor('ahmed sara')).toEqual(['E']);
    expect(keysFor('ahmed محمد')).toEqual([]);
  });

  test('compound names are found with or without the space (عبد الله / عبدالله)', () => {
    expect(keysFor('عبدالله')).toEqual(['F', 'J']);
    expect(keysFor('عبد الله')).toEqual(['F', 'J']);
    expect(keysFor('عبد')).toEqual(['F', 'J']);
  });

  test('substring match, like the existing search', () => {
    expect(keysFor('ara')).toEqual(['E']);
    expect(keysFor('سار')).toEqual(['B']);
  });

  test('bidi marks and zero-width characters pasted with the query are ignored', () => {
    expect(keysFor('\u{200F}سارة\u{200F}')).toEqual(['B']);
    expect(keysFor('\u{202E}سا\u{200B}رة\u{FEFF}')).toEqual(['B']);
    expect(keysFor('  سارة\u{00A0}\u{00A0}أحمد  ')).toEqual(['B']);
  });

  test('a row without a name or preview never crashes the search', () => {
    const search = tools.buildSearch('x');
    expect(tools.matchesSearch(search, { name: undefined, phone: undefined, lastMessagePreview: undefined })).toBe(false);
    expect(tools.matchesSearch(search, {})).toBe(false);
    expect(tools.matchesSearch(search, null)).toBe(false);
  });
});

describe('Arabic-aware search — last message preview', () => {
  test('matches the preview with the same normalisation', () => {
    expect(keysFor('تاكيد')).toEqual(['A']); // stored with hamza, typed without
    expect(keysFor('تأكيد')).toEqual(['A']);
    expect(keysFor('order')).toEqual(['E', 'H']);
    expect(keysFor('ORDER')).toEqual(['E', 'H']);
  });

  test('both tanween spellings (alef+fathatan and fathatan+alef) and the bare word find the same preview', () => {
    expect(keysFor('شكرا')).toEqual(['B']);
    expect(keysFor('شكرا\u{064B}')).toEqual(['B']);
    expect(keysFor('شكر\u{064B}ا')).toEqual(['B']);
    expect(keysFor('جزيلا')).toEqual(['B']);
  });

  test('a token may match the name while another matches the preview', () => {
    expect(keysFor('sara order')).toEqual(['E']);
    expect(keysFor('سارة شكرا')).toEqual(['B']);
  });
});

describe('Arabic-aware search — phone numbers', () => {
  test.each([
    '+966501234567', '966501234567', '00966501234567', '0501234567', '501234567',
    '+966 50 123 4567', '(966) 50-123-4567', '050 123 4567', '050-123-4567', '+966-50-123-4567',
    '٠٥٠١٢٣٤٥٦٧', '+٩٦٦٥٠١٢٣٤٥٦٧', '۰۵۰۱۲۳۴۵۶۷', '٠٠٩٦٦٥٠١٢٣٤٥٦٧', '٠٥٠ ١٢٣ ٤٥٦٧',
  ])('"%s" finds the customer stored as 966501234567', (term) => {
    expect(keysFor(term)).toEqual(['A']);
  });

  test('a different number does not match', () => {
    expect(keysFor('0501234568')).toEqual([]);
    expect(keysFor('+966501234568')).toEqual([]);
    expect(keysFor('0551234567')).toEqual([]);
  });

  test('short digit fragments match the phone literally (last digits)', () => {
    expect(keysFor('4567')).toEqual(['A']);
    expect(keysFor('1234')).toEqual(['A', 'D']);
    expect(keysFor('٤٥٦٧')).toEqual(['A']);
    expect(keysFor('9999')).toEqual([]);
  });

  test('a phone token ANDed with a name token', () => {
    expect(keysFor('سارة 111')).toEqual(['B']);
    expect(keysFor('سارة 222')).toEqual([]);
    expect(keysFor('احمد 0501234567')).toEqual(['A']);
  });

  test('a customer whose name IS their phone number is found by it', () => {
    expect(keysFor('566667777')).toEqual(['I']);
    expect(keysFor('0566667777')).toEqual(['I']);
  });

  test('a stored phone formatted by hand is compared by its digits', () => {
    const search = tools.buildSearch('0501234567');
    expect(tools.matchesSearch(search, row(50, 'Hand typed', '+966 50 123 4567'))).toBe(true);
    expect(tools.matchesSearch(search, row(51, 'Local format', '050-123-4567'))).toBe(true);
    expect(tools.matchesSearch(search, row(52, 'Arabic digits', '٩٦٦٥٠١٢٣٤٥٦٧'))).toBe(true);
  });

  test('numbers inside text are found in names and previews too', () => {
    const search = tools.buildSearch('150.50');
    expect(tools.matchesSearch(search, row(60, 'X', '1', 'Payment of 150.50 SAR'))).toBe(true);
    expect(tools.matchesSearch(search, row(61, 'X', '1', 'Payment of 99.00 SAR'))).toBe(false);
  });
});

describe('search input handling — it is never a pattern', () => {
  // Everything a regex engine would choke on or over-match is plain text here:
  // the expected rows are exactly the ones that LITERALLY contain the characters.
  test.each([
    ['(', ['H']], // only "item(s)" contains a parenthesis
    ['((', []],
    ['[', []],
    ['[a-z', []],
    ['.*', []],
    ['\\', []],
    ['\\d+', ['E', 'H']], // backslash and + fold away, leaving the plain letter "d" (a regex would match every phone)
    ['^$', []],
    ['$ne', []],
    ['{"$ne":null}', []],
    ['|', []],
    ['*', []],
    ['+', []],
    ['?', ['C', 'E']], // the only previews with a question mark (Arabic ؟ is folded to ?)
    ['a{1', []],
    ['(?<=x)', []],
    ['%', []],
    ['$where', ['E']], // plain text "where"
    ['))))))))))', []],
  ])('hostile input %j neither throws nor acts as a pattern -> %j', (term, expected) => {
    const search = tools.buildSearch(term);
    for (const r of ALL_ROWS) expect(() => tools.matchesSearch(search, r)).not.toThrow();
    expect(keysFor(term)).toEqual(expected);
  });

  test('regex metacharacters match literally when the stored text really has them', () => {
    const search = tools.buildSearch('(vip)');
    expect(tools.matchesSearch(search, row(70, 'Sara (VIP)', '1'))).toBe(true);
    expect(tools.matchesSearch(search, row(71, 'Sara VIP', '1'))).toBe(true); // punctuation is folded on both sides
    expect(tools.matchesSearch(tools.buildSearch('.*'), row(72, 'Sara', '1'))).toBe(false);
    expect(tools.matchesSearch(tools.buildSearch('.*'), row(73, 'a.*b', '1'))).toBe(true);
  });

  test('an emoji-only query is matched literally instead of vanishing', () => {
    expect(keysFor('🛍️')).toEqual(['H']);
    expect(keysFor('🙂')).toEqual([]);
  });

  test('empty, blank and invisible-only queries do not filter', () => {
    for (const term of [undefined, null, '', '   ', '\u{200F}', '\u{200B}\u{FEFF}', '\t\n']) {
      expect(tools.buildSearch(term)).toBeNull();
    }
    expect(tools.matchesSearch(null, ROWS.A)).toBe(true);
  });

  test('non-string and oversized queries are rejected with INVALID_INPUT', () => {
    for (const bad of [123, true, {}, { $ne: 'x' }, ['a'], ['a', 'b'], () => 'x']) {
      expectApiError(thrown(() => tools.buildSearch(bad)), 400, 'INVALID_INPUT');
    }
    expect(() => tools.buildSearch('a'.repeat(tools.MAX_SEARCH_LENGTH))).not.toThrow();
    expectApiError(thrown(() => tools.buildSearch('a'.repeat(tools.MAX_SEARCH_LENGTH + 1))), 400, 'INVALID_INPUT');
  });

  test('a long run of digits or spaces stays fast (no regex backtracking)', () => {
    const started = Date.now();
    tools.buildSearch('9'.repeat(200));
    tools.buildSearch(`${'1 '.repeat(99)}x`);
    tools.buildSearch(`${'٠'.repeat(100)}!`);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('searchConversations', () => {
  test('calls the existing list WITHOUT the search term and scoped to the workspace', async () => {
    const deps = makeDeps({ rows: ALL_ROWS });
    await tools.searchConversations({ workspaceId: WS, filter: 'unread', search: 'سارة' }, deps);
    expect(deps.listConversations).toHaveBeenCalledTimes(1);
    const arg = deps.listConversations.mock.calls[0][0];
    expect(Object.keys(arg).sort()).toEqual(['filter', 'workspaceId']);
    expect(arg).toEqual({ workspaceId: WS, filter: 'unread' });
  });

  test('filters the rows in JS and keeps their order and shape (plus language)', async () => {
    const deps = makeDeps({ rows: ALL_ROWS });
    const res = await tools.searchConversations({ workspaceId: WS, search: 'احمد' }, deps);
    expect(res.conversations.map((r) => r.name)).toEqual(['أَحْمَد المنصوري', 'سارة أحمد']);
    expect(res.conversations[0]).toEqual({ ...ROWS.A, language: 'unknown' });
    expect(Object.keys(res)).toEqual(['conversations']);
  });

  test('no search returns every row untouched apart from language', async () => {
    const deps = makeDeps({ rows: ALL_ROWS });
    const res = await tools.searchConversations({ workspaceId: WS }, deps);
    expect(res.conversations).toHaveLength(ALL_ROWS.length);
    expect(res.conversations.map(({ language, ...rest }) => rest)).toEqual(ALL_ROWS);
  });

  test.each([
    ['unread', 'unread'], ['high-value', 'high-value'], ['inactive', 'inactive'], ['recent', 'recent'], ['booking', 'booking'],
    ['all', undefined], [undefined, undefined], ['', undefined], ['bogus', undefined], ['UNREAD', undefined],
    ['constructor', undefined], [['unread'], undefined], [{ $ne: 'x' }, undefined], [5, undefined],
  ])('filter %j is passed to the existing list as %j', async (filter, expected) => {
    const deps = makeDeps({ rows: [] });
    await tools.searchConversations({ workspaceId: WS, filter }, deps);
    expect(deps.listConversations.mock.calls[0][0].filter).toBe(expected);
  });

  test('attaches each row\'s language with ONE query scoped to the workspace and to the matched rows only', async () => {
    const languages = [
      { workspaceId: WS, customerId: ROWS.A.customerId, language: 'ar' },
      { workspaceId: WS, customerId: ROWS.B.customerId, language: 'en' },
      { workspaceId: WS, customerId: ROWS.C.customerId, language: 'ar' },
      { workspaceId: OTHER_WS, customerId: ROWS.D.customerId, language: 'ar' }, // another tenant's doc
    ];
    const deps = makeDeps({ rows: ALL_ROWS, languages });
    const res = await tools.searchConversations({ workspaceId: WS, search: 'احمد' }, deps);
    expect(deps.CustomerLanguage.find).toHaveBeenCalledTimes(1);
    expect(deps.CustomerLanguage.findOne).not.toHaveBeenCalled();
    expect(deps.CustomerLanguage.find.mock.calls[0][0]).toEqual({ workspaceId: WS, customerId: { $in: [ROWS.A.customerId, ROWS.B.customerId] } });
    expect(res.conversations.map((r) => [r.name, r.language])).toEqual([['أَحْمَد المنصوري', 'ar'], ['سارة أحمد', 'en']]);
  });

  test('rows without a language document are "unknown"; another tenant\'s document never leaks', async () => {
    const deps = makeDeps({
      rows: [ROWS.D, ROWS.E],
      languages: [{ workspaceId: OTHER_WS, customerId: ROWS.D.customerId, language: 'ar' }],
    });
    const res = await tools.searchConversations({ workspaceId: WS }, deps);
    expect(res.conversations.map((r) => r.language)).toEqual(['unknown', 'unknown']);
  });

  test('an unexpected stored language value is reported as unknown', async () => {
    const deps = makeDeps({
      rows: [ROWS.A, ROWS.B],
      languages: [
        { workspaceId: WS, customerId: ROWS.A.customerId, language: 'fr' },
        { workspaceId: WS, customerId: ROWS.B.customerId, language: 'unknown' },
      ],
    });
    const res = await tools.searchConversations({ workspaceId: WS }, deps);
    expect(res.conversations.map((r) => r.language)).toEqual(['unknown', 'unknown']);
  });

  test('no matching rows -> no language query at all', async () => {
    const deps = makeDeps({ rows: ALL_ROWS });
    const res = await tools.searchConversations({ workspaceId: WS, search: 'zzzzqqqq' }, deps);
    expect(res).toEqual({ conversations: [] });
    expect(deps.CustomerLanguage.find).not.toHaveBeenCalled();
  });

  test('rejects a bad search before touching the database', async () => {
    const deps = makeDeps({ rows: ALL_ROWS });
    expectApiError(await rejection(tools.searchConversations({ workspaceId: WS, search: ['a', 'b'] }, deps)), 400, 'INVALID_INPUT');
    expectApiError(await rejection(tools.searchConversations({ workspaceId: WS, search: { $ne: null } }, deps)), 400, 'INVALID_INPUT');
    expectApiError(await rejection(tools.searchConversations({ workspaceId: WS, search: 'x'.repeat(500) }, deps)), 400, 'INVALID_INPUT');
    expect(deps.listConversations).not.toHaveBeenCalled();
  });

  test.each([[undefined], [null], [''], ['not-an-object-id'], [{ $ne: null }], [id(1).slice(1)], [`${id(1)}0`]])(
    'refuses to run without a valid workspace (%j): the existing list would go unscoped',
    async (workspaceId) => {
      const deps = makeDeps({ rows: ALL_ROWS });
      expectApiError(await rejection(tools.searchConversations({ workspaceId, search: 'x' }, deps)), 403, 'FORBIDDEN');
      expect(deps.listConversations).not.toHaveBeenCalled();
    },
  );
});

// ── 2. Context ───────────────────────────────────────────────────────────

describe('getContext', () => {
  test('returns the customer\'s language, its source and the effective language', async () => {
    const deps = makeDeps({ languages: [{ workspaceId: WS, customerId: CUST, language: 'ar', languageSource: 'merchant_set' }] });
    expect(await tools.getContext({ workspaceId: WS, customerId: CUST }, deps)).toEqual({
      customerId: CUST, language: 'ar', languageSource: 'merchant_set', effectiveLanguage: 'ar',
    });
  });

  test('a customer without a language uses the merchant default, then English', async () => {
    expect(await tools.getContext({ workspaceId: WS, customerId: CUST }, makeDeps({ merchantDefault: 'ar' }))).toEqual({
      customerId: CUST, language: 'unknown', languageSource: null, effectiveLanguage: 'ar',
    });
    expect(await tools.getContext({ workspaceId: WS, customerId: CUST }, makeDeps({ merchantDefault: 'en' }))).toMatchObject({ effectiveLanguage: 'en' });
    expect(await tools.getContext({ workspaceId: WS, customerId: CUST }, makeDeps({ merchantDefault: 'fr' }))).toMatchObject({ effectiveLanguage: 'en' });
  });

  test('the customer\'s own language beats the merchant default', async () => {
    const deps = makeDeps({ merchantDefault: 'ar', languages: [{ workspaceId: WS, customerId: CUST, language: 'en', languageSource: 'inferred' }] });
    expect(await tools.getContext({ workspaceId: WS, customerId: CUST }, deps)).toMatchObject({ language: 'en', languageSource: 'inferred', effectiveLanguage: 'en' });
  });

  test('"unknown" stored explicitly stays unknown, and a bad source is dropped', async () => {
    const deps = makeDeps({ merchantDefault: 'ar', languages: [{ workspaceId: WS, customerId: CUST, language: 'unknown', languageSource: 'whatever' }] });
    expect(await tools.getContext({ workspaceId: WS, customerId: CUST }, deps)).toEqual({
      customerId: CUST, language: 'unknown', languageSource: null, effectiveLanguage: 'ar',
    });
  });

  test('queries are scoped to the workspace (customer and language)', async () => {
    const deps = makeDeps();
    await tools.getContext({ workspaceId: WS, customerId: CUST }, deps);
    expect(deps.Customer.findOne.mock.calls[0][0]).toEqual({
      _id: CUST, workspaceId: WS, deletedAt: { $exists: false }, isDemo: { $ne: true },
    });
    expect(deps.CustomerLanguage.findOne.mock.calls[0][0]).toEqual({ workspaceId: WS, customerId: CUST });
    expect(deps.getMerchantDefault).toHaveBeenCalledWith(WS);
  });

  test('another tenant\'s customer, demo and erased customers are CUSTOMER_NOT_FOUND', async () => {
    for (const customers of [
      [customerDoc({ workspaceId: OTHER_WS })],
      [customerDoc({ isDemo: true })],
      [customerDoc({ deletedAt: new Date() })],
      [],
    ]) {
      expectApiError(await rejection(tools.getContext({ workspaceId: WS, customerId: CUST }, makeDeps({ customers }))), 404, 'CUSTOMER_NOT_FOUND');
    }
  });

  test('a customer id that is not an ObjectId (or an operator object) is INVALID_ID and never reaches the database', async () => {
    const deps = makeDeps();
    for (const bad of ['nope', '', undefined, null, { $ne: null }, { $gt: '' }, ['a'], id(100).toUpperCase().slice(0, 23), `${id(100)}f`, 12345]) {
      expectApiError(await rejection(tools.getContext({ workspaceId: WS, customerId: bad }, deps)), 400, 'INVALID_ID');
    }
    expect(deps.Customer.findOne).not.toHaveBeenCalled();
  });
});

// ── 3. Payment link ──────────────────────────────────────────────────────

describe('parseAmount', () => {
  test.each([
    [1, 100], [150, 15000], [150.5, 15050], [19.99, 1999], [0.01, 1], [0.07, 7], [1.15, 115], [1000000, 100000000],
    [0.1 + 0.2, 30], ['150', 15000], ['150.5', 15050], ['150.50', 15050], [' 150 ', 15000], ['.5', 50], ['5.', 500],
    ['٢٥٠٫٥٠', 25050], ['١٥٠', 15000], ['۱۵۰', 15000], ['0150', 15000], ['1000000.00', 100000000],
  ])('%j is valid -> %i cents', (input, cents) => {
    expect(tools.parseAmount(input)).toBe(cents);
  });

  test.each([
    [0], [-0], [-1], [-0.01], [NaN], [Infinity], [-Infinity], [1000000.01], [1000001], [1.001], [0.005], [1e-7], [1e21], [8.675],
    [''], [' '], ['abc'], ['1e3'], ['0x10'], ['1,5'], ['1,500.00'], ['1 000'], ['-5'], ['+5'], ['5%'], ['SAR 5'], ['1.2.3'], ['.'], ['٠'], ['0'],
    ['1.001'], ['9'.repeat(40)], ['1'.repeat(33)], ['١٬٥٠٠'],
    [null], [undefined], [true], [false], [[5]], [['5']], [{ $gt: 0 }], [{ amount: 5 }], [() => 5], [BigInt(5)], [Symbol('x')],
  ])('%p is INVALID_AMOUNT', (input) => {
    expectApiError(thrown(() => tools.parseAmount(input)), 400, 'INVALID_AMOUNT');
  });
});

describe('sendPaymentLink — validation and lookups', () => {
  test('an invalid amount is rejected before any lookup, Stripe call or message', async () => {
    const deps = makeDeps();
    expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: { $gt: 0 } }, deps)), 400, 'INVALID_AMOUNT');
    expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 0 }, deps)), 400, 'INVALID_AMOUNT');
    expect(deps.Customer.findOne).not.toHaveBeenCalled();
    expect(deps.stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(deps.sendManualMessage).not.toHaveBeenCalled();
  });

  test('unknown, other-tenant, demo and erased customers are CUSTOMER_NOT_FOUND — nothing is created or sent', async () => {
    for (const customers of [[], [customerDoc({ workspaceId: OTHER_WS })], [customerDoc({ isDemo: true })], [customerDoc({ deletedAt: new Date() })]]) {
      const deps = makeDeps({ customers });
      expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps)), 404, 'CUSTOMER_NOT_FOUND');
      expect(deps.stripe.paymentIntents.create).not.toHaveBeenCalled();
      expect(deps.sendManualMessage).not.toHaveBeenCalled();
    }
  });

  test('a malformed customer id or workspace is rejected first', async () => {
    const deps = makeDeps();
    expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: { $ne: null }, amount: 10 }, deps)), 400, 'INVALID_ID');
    expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: undefined, customerId: CUST, amount: 10 }, deps)), 403, 'FORBIDDEN');
    expect(deps.sendManualMessage).not.toHaveBeenCalled();
  });
});

describe('sendPaymentLink — the message in the customer\'s language', () => {
  test('an English customer gets exactly the message the existing English action sends', async () => {
    const deps = makeDeps({ languages: [{ workspaceId: WS, customerId: CUST, language: 'en' }] });
    const res = await tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 150, performedBy: USER }, deps);
    expect(res).toEqual({ sent: true, messageId: id(900) });
    expect(deps.sendManualMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendManualMessage).toHaveBeenCalledWith({
      customerId: CUST, workspaceId: WS, performedBy: USER, messageType: 'payment',
      body: '💳 Here\'s your payment link for 150.00 SAR:\nhttps://app.example.test/pay/pi_test_123',
    });
  });

  test('an Arabic customer gets the Arabic text, the amount protected by LRM, and a ?lang=ar link', async () => {
    const deps = makeDeps({ languages: [{ workspaceId: WS, customerId: CUST, language: 'ar', languageSource: 'merchant_set' }] });
    await tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 150, performedBy: USER }, deps);
    const { body } = deps.sendManualMessage.mock.calls[0][0];
    expect(body).toBe(`💳 رابط الدفع لمبلغ ${LRM}150.00 SAR${LRM}:\nhttps://app.example.test/pay/pi_test_123?lang=ar`);
    expect(body).not.toMatch(/[{}]/);
    expect(body).not.toContain(`${LRM}https`); // the URL itself is not wrapped (a mark glued to a link breaks link detection)
  });

  test('an unknown-language customer follows the merchant default (ar -> Arabic with ?lang=ar, en -> plain link)', async () => {
    const ar = makeDeps({ merchantDefault: 'ar' });
    await tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 5 }, ar);
    expect(ar.sendManualMessage.mock.calls[0][0].body).toContain('رابط الدفع');
    expect(ar.sendManualMessage.mock.calls[0][0].body).toContain('?lang=ar');
    const en = makeDeps({ merchantDefault: 'en' });
    await tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 5 }, en);
    expect(en.sendManualMessage.mock.calls[0][0].body).toMatch(/^💳 Here's your payment link for/);
    expect(en.sendManualMessage.mock.calls[0][0].body).not.toContain('?lang');
  });

  test('a customer\'s own English beats an Arabic merchant default', async () => {
    const deps = makeDeps({ merchantDefault: 'ar', languages: [{ workspaceId: WS, customerId: CUST, language: 'en' }] });
    await tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 5 }, deps);
    expect(deps.sendManualMessage.mock.calls[0][0].body).toMatch(/^💳 Here's your payment link/);
  });

  test('a trailing slash on APP_URL does not double up', async () => {
    const deps = makeDeps({ deps: { appUrl: 'https://app.example.test//' } });
    await tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 5 }, deps);
    expect(deps.sendManualMessage.mock.calls[0][0].body).toContain('https://app.example.test/pay/pi_test_123');
    expect(deps.sendManualMessage.mock.calls[0][0].body).not.toContain('//pay');
  });

  test('the catalogue entry is missing -> nothing is created or sent (the key itself must never reach a customer)', async () => {
    const deps = makeDeps({ deps: { catalog: { has: () => false, t: (_lang, key) => key } } });
    expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 5 }, deps)), 500, 'INTERNAL');
    expect(deps.stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(deps.sendManualMessage).not.toHaveBeenCalled();
  });
});

describe('sendPaymentLink — the Stripe PaymentIntent', () => {
  test('is created exactly like the existing action: cents, lower-case currency, automatic payment methods, same metadata keys (+ the workspace the Stripe webhook credits)', async () => {
    const deps = makeDeps();
    await tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: '150.50' }, deps);
    expect(deps.stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(deps.stripe.paymentIntents.create).toHaveBeenCalledWith({
      amount: 15050, currency: 'sar', automatic_payment_methods: { enabled: true },
      metadata: { buyerPhone: '966501234567', source: 'inbox_manual_payment_link', workspaceId: WS },
    });
  });

  test('uses the workspace\'s own currency; lower-case is normalised; no setting means AUD; other tenants\' settings are ignored', async () => {
    const lower = makeDeps({ settings: [{ workspaceId: WS, currency: ' sar ' }] });
    await tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, lower);
    expect(lower.stripe.paymentIntents.create.mock.calls[0][0].currency).toBe('sar');
    expect(lower.sendManualMessage.mock.calls[0][0].body).toContain('10.00 SAR');

    const none = makeDeps({ settings: [{ workspaceId: OTHER_WS, currency: 'USD' }] });
    await tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, none);
    expect(none.Settings.findOne.mock.calls[0][0]).toEqual({ workspaceId: WS });
    expect(none.stripe.paymentIntents.create.mock.calls[0][0].currency).toBe('aud');
    expect(none.sendManualMessage.mock.calls[0][0].body).toContain('$10.00');

    const blank = makeDeps({ settings: [{ workspaceId: WS, currency: '   ' }] });
    await tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, blank);
    expect(blank.stripe.paymentIntents.create.mock.calls[0][0].currency).toBe('aud');
  });

  test.each([['riyal'], ['SA'], ['S4R'], ['KWD'], ['bhd'], ['OMR'], ['JPY'], ['KRW']])(
    'a currency setting of %j cannot be charged safely at x100 -> STRIPE_UNAVAILABLE, nothing created or sent',
    async (currency) => {
      const deps = makeDeps({ settings: [{ workspaceId: WS, currency }] });
      expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps)), 503, 'STRIPE_UNAVAILABLE');
      expect(deps.stripe.paymentIntents.create).not.toHaveBeenCalled();
      expect(deps.sendManualMessage).not.toHaveBeenCalled();
    },
  );

  test('no Stripe key -> 503 STRIPE_UNAVAILABLE and nothing is sent', async () => {
    const deps = makeDeps({ deps: { getStripe: jest.fn(() => null) } });
    expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps)), 503, 'STRIPE_UNAVAILABLE');
    expect(deps.sendManualMessage).not.toHaveBeenCalled();
  });

  test('a Stripe failure is sanitised: STRIPE_UNAVAILABLE, no provider text, no message sent', async () => {
    const deps = makeDeps();
    deps.stripe.paymentIntents.create.mockRejectedValue(Object.assign(new Error('Invalid API Key provided: sk_live_****secret'), { type: 'StripeAuthenticationError', code: 'api_key_invalid' }));
    const err = expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps)), 503, 'STRIPE_UNAVAILABLE');
    expect(err.message).not.toMatch(/sk_live|secret|API Key/i);
    expect(deps.sendManualMessage).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalled();
    expect(JSON.stringify(deps.log.mock.calls)).not.toMatch(/sk_live|secret/);
  });

  test('Stripe saying the amount is too small/large is the staff member\'s INVALID_AMOUNT', async () => {
    for (const code of ['amount_too_small', 'amount_too_large']) {
      const deps = makeDeps();
      deps.stripe.paymentIntents.create.mockRejectedValue(Object.assign(new Error('Amount must be at least $0.50'), { type: 'StripeInvalidRequestError', code }));
      const err = expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 0.1 }, deps)), 400, 'INVALID_AMOUNT');
      expect(err.message).not.toContain('$0.50');
    }
  });

  test('a Stripe answer without an id is treated as a failure', async () => {
    const deps = makeDeps();
    deps.stripe.paymentIntents.create.mockResolvedValue({});
    expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps)), 503, 'STRIPE_UNAVAILABLE');
    expect(deps.sendManualMessage).not.toHaveBeenCalled();
  });
});

describe('sendPaymentLink — sending, failures, double clicks, dry run', () => {
  test('a WhatsApp failure is META_ERROR with no upstream text', async () => {
    const deps = makeDeps();
    const upstream = Object.assign(new Error('Request failed with status code 400'), {
      isAxiosError: true, status: 400, code: 'ERR_BAD_REQUEST', response: { status: 400, data: { error: { code: 131030, message: 'Recipient 966501234567 not allowed' } } },
    });
    deps.sendManualMessage.mockRejectedValue(upstream);
    const err = expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps)), 502, 'META_ERROR');
    expect(err.message).not.toMatch(/966|400|allowed/);
    expect(JSON.stringify(deps.log.mock.calls)).not.toContain('966501234567'); // phone numbers are never logged
  });

  test('"Customer not found" from the existing sender maps to CUSTOMER_NOT_FOUND; anything else is a generic INTERNAL', async () => {
    const gone = makeDeps();
    gone.sendManualMessage.mockRejectedValue(new Error('Customer not found'));
    expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, gone)), 404, 'CUSTOMER_NOT_FOUND');
    const broken = makeDeps();
    broken.sendManualMessage.mockRejectedValue(new Error('E11000 duplicate key collection: whatsappmessages'));
    const err = expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, broken)), 500, 'INTERNAL');
    expect(err.message).not.toMatch(/E11000|whatsappmessages/);
  });

  test('a double click: the second concurrent request is RATE_LIMITED and creates nothing; afterwards it works again', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const deps = makeDeps({ deps: { sendManualMessage: jest.fn(async () => { await gate; return { _id: id(900) }; }) } });
    const first = tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps);
    await new Promise((resolve) => setImmediate(resolve)); // let the first call reach sendManualMessage
    expectApiError(await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps)), 429, 'RATE_LIMITED');
    expect(deps.stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toEqual({ sent: true, messageId: id(900) });
    await expect(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps)).resolves.toMatchObject({ sent: true });
    expect(deps.stripe.paymentIntents.create).toHaveBeenCalledTimes(2);
  });

  test('the lock is released after a failure, and is per customer', async () => {
    const deps = makeDeps({ customers: [customerDoc(), customerDoc({ _id: id(101), phone: '966500000002' })] });
    deps.stripe.paymentIntents.create.mockRejectedValueOnce(new Error('boom'));
    await rejection(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps));
    await expect(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps)).resolves.toMatchObject({ sent: true });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    deps.sendManualMessage.mockImplementationOnce(async () => { await gate; return { _id: id(900) }; });
    const slow = tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(tools.sendPaymentLink({ workspaceId: WS, customerId: id(101), amount: 10 }, deps)).resolves.toMatchObject({ sent: true });
    release();
    await slow;
  });

  test('the performer is only passed on when it is a real id', async () => {
    const deps = makeDeps();
    await tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10, performedBy: { $ne: null } }, deps);
    expect(deps.sendManualMessage.mock.calls[0][0].performedBy).toBeUndefined();
  });

  test('the answer carries no extra keys and no message id when the sender returned none', async () => {
    const deps = makeDeps({ deps: { sendManualMessage: jest.fn(async () => ({})) } });
    const res = await tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps);
    expect(res).toEqual({ sent: true, messageId: undefined });
    expect(Object.keys(JSON.parse(JSON.stringify(res)))).toEqual(['sent']);
  });

  test('LOCALIZATION_SEND_MODE=dry_run: no Stripe, no existing sender (it talks to Meta directly); the text goes to the dry-run buffer', async () => {
    const deps = makeDeps({ languages: [{ workspaceId: WS, customerId: CUST, language: 'ar' }] });
    deps.transport.isDryRun.mockReturnValue(true);
    deps.getStripe.mockReturnValue(null);
    const res = await tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps);
    expect(res).toEqual({ sent: true, messageId: 'dryrun.1.abc' });
    expect(deps.getStripe).not.toHaveBeenCalled();
    expect(deps.stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(deps.sendManualMessage).not.toHaveBeenCalled();
    expect(deps.transport.sendText).toHaveBeenCalledTimes(1);
    const [to, body] = deps.transport.sendText.mock.calls[0];
    expect(to).toBe('966501234567');
    expect(body).toContain('/pay/pi_dry_run?lang=ar');
  });
});

describe('createLocks', () => {
  test('hold, refuse a second holder, release, and expire a stale hold', () => {
    let now = 1000;
    const locks = tools.createLocks(50, () => now);
    expect(locks.acquire('k')).toBe(true);
    expect(locks.acquire('k')).toBe(false);
    expect(locks.acquire('other')).toBe(true);
    now += 49;
    expect(locks.acquire('k')).toBe(false);
    now += 2; // expired: a crashed request cannot block the action forever
    expect(locks.acquire('k')).toBe(true);
    locks.release('k');
    expect(locks.acquire('k')).toBe(true);
  });
});

// ── 4. Loyalty reminder ──────────────────────────────────────────────────

const loyalty = (deps, extra = {}) => tools.sendLoyaltyReminder({ workspaceId: WS, customerId: CUST, performedBy: USER, ...extra }, deps);
const NO_VARIANT = { sent: false, reason: 'no_approved_variant', fallbackAvailable: true };

describe('sendLoyaltyReminder — which variant', () => {
  test('an Arabic customer with an approved + reviewed Arabic variant is sent it via the campaign sender, in explicit Arabic mode', async () => {
    const deps = makeDeps({
      languages: [{ workspaceId: WS, customerId: CUST, language: 'ar' }],
      templates: [template(1, [variant('en'), variant('ar')])],
    });
    expect(await loyalty(deps)).toEqual({ sent: true });
    expect(deps.sendSingle).toHaveBeenCalledTimes(1);
    expect(deps.sendSingle).toHaveBeenCalledWith({
      workspaceId: WS, templateId: id(501), customerId: CUST, fieldValues: {}, languageMode: 'ar', createdBy: USER,
    });
  });

  test('an English customer gets the English variant (English does not need native review)', async () => {
    const deps = makeDeps({
      languages: [{ workspaceId: WS, customerId: CUST, language: 'en' }],
      templates: [template(1, [variant('en', { reviewStatus: 'draft' }), variant('ar')])],
    });
    expect(await loyalty(deps)).toEqual({ sent: true });
    expect(deps.sendSingle.mock.calls[0][0]).toMatchObject({ languageMode: 'en' });
  });

  test('an unknown-language customer follows the merchant default', async () => {
    const templates = [template(1, [variant('en'), variant('ar')])];
    const ar = makeDeps({ merchantDefault: 'ar', templates });
    await loyalty(ar);
    expect(ar.sendSingle.mock.calls[0][0].languageMode).toBe('ar');
    const en = makeDeps({ merchantDefault: 'en', templates });
    await loyalty(en);
    expect(en.sendSingle.mock.calls[0][0].languageMode).toBe('en');
  });

  test.each([
    ['draft (not natively reviewed)', variant('ar', { reviewStatus: 'draft' })],
    ['pending at Meta', variant('ar', { metaStatus: 'PENDING' })],
    ['rejected by Meta', variant('ar', { metaStatus: 'REJECTED' })],
    ['paused', variant('ar', { metaStatus: 'PAUSED' })],
    ['never submitted', variant('ar', { metaStatus: 'NOT_CREATED' })],
  ])('an Arabic variant that is %s is NOT sent: no_approved_variant (and no silent English)', async (_label, arabic) => {
    const deps = makeDeps({
      languages: [{ workspaceId: WS, customerId: CUST, language: 'ar' }],
      templates: [template(1, [variant('en'), arabic])], // English IS approved — still must not be used
    });
    expect(await loyalty(deps)).toEqual(NO_VARIANT);
    expect(deps.sendSingle).not.toHaveBeenCalled();
  });

  test('no templates at all, only other use cases, archived, linked-to-a-flow, or other tenants\' templates -> no_approved_variant', async () => {
    const approved = [variant('en'), variant('ar')];
    for (const templates of [
      [],
      [template(1, approved, { useCase: 'comeback' })],
      [template(1, approved, { archived: true })],
      [template(1, approved, { linkedMessageNodeId: id(77) })],
      [template(1, approved, { workspaceId: OTHER_WS })],
      [template(1, [])],
    ]) {
      const deps = makeDeps({ languages: [{ workspaceId: WS, customerId: CUST, language: 'ar' }], templates });
      expect(await loyalty(deps)).toEqual(NO_VARIANT);
      expect(deps.sendSingle).not.toHaveBeenCalled();
    }
  });

  test('the template query is scoped: workspace, use case, not archived', async () => {
    const deps = makeDeps({ templates: [] });
    await loyalty(deps);
    expect(deps.LocalizedTemplate.find.mock.calls[0][0]).toEqual({ workspaceId: WS, useCase: 'loyalty_reminder', archived: { $ne: true } });
  });

  test('the most recently updated usable template wins; an older one is used when the newer has no usable variant', async () => {
    const older = template(1, [variant('en'), variant('ar')]);
    const newer = template(2, [variant('en'), variant('ar')]);
    const lang = [{ workspaceId: WS, customerId: CUST, language: 'ar' }];
    const both = makeDeps({ languages: lang, templates: [older, newer] });
    await loyalty(both);
    expect(both.sendSingle.mock.calls[0][0].templateId).toBe(newer._id);

    const newerNoArabic = template(3, [variant('en')]);
    const fallbackToOlder = makeDeps({ languages: lang, templates: [newerNoArabic, older] });
    await loyalty(fallbackToOlder);
    expect(fallbackToOlder.sendSingle.mock.calls[0][0].templateId).toBe(older._id);
  });

  test('templates without a timestamp are still ordered deterministically', async () => {
    const a = template(4, [variant('en')], { updatedAt: undefined, _id: id(601) });
    const b = template(5, [variant('en')], { updatedAt: 'garbage', _id: id(602) });
    const deps = makeDeps({ languages: [{ workspaceId: WS, customerId: CUST, language: 'en' }], templates: [a, b] });
    await loyalty(deps);
    expect(deps.sendSingle.mock.calls[0][0].templateId).toBe(id(602));
  });
});

describe('sendLoyaltyReminder — consent and points come first', () => {
  test.each([
    ['never consented', { marketingConsent: false }],
    ['consent flag missing', { marketingConsent: undefined }],
    ['opted out', { optedOut: true }],
    ['consented but opted out', { marketingConsent: true, optedOut: true }],
  ])('%s -> no_consent, nothing looked up or sent', async (_label, patch) => {
    const deps = makeDeps({
      customers: [customerDoc(patch)],
      languages: [{ workspaceId: WS, customerId: CUST, language: 'ar' }],
      templates: [template(1, [variant('en'), variant('ar')])],
    });
    expect(await loyalty(deps)).toEqual({ sent: false, reason: 'no_consent', fallbackAvailable: false });
    expect(deps.canSendMarketing).toHaveBeenCalledWith(expect.objectContaining({ _id: CUST }));
    expect(deps.LocalizedTemplate.find).not.toHaveBeenCalled();
    expect(deps.sendSingle).not.toHaveBeenCalled();
  });

  test('no consent wins over "no approved variant" (no point offering an English fallback that would be refused)', async () => {
    const deps = makeDeps({ customers: [customerDoc({ marketingConsent: false })], templates: [] });
    expect(await loyalty(deps)).toMatchObject({ reason: 'no_consent', fallbackAvailable: false });
  });

  test.each([[0], [undefined], [null], [-5], ['0']])('loyaltyPoints %j -> no_points (the existing reminder also skips customers without points)', async (loyaltyPoints) => {
    const deps = makeDeps({ customers: [customerDoc({ loyaltyPoints })], templates: [template(1, [variant('en')])] });
    expect(await loyalty(deps)).toEqual({ sent: false, reason: 'no_points', fallbackAvailable: false });
    expect(deps.sendSingle).not.toHaveBeenCalled();
  });

  test('unknown, other-tenant, demo and erased customers are CUSTOMER_NOT_FOUND', async () => {
    for (const customers of [[], [customerDoc({ workspaceId: OTHER_WS })], [customerDoc({ isDemo: true })], [customerDoc({ deletedAt: new Date() })]]) {
      const deps = makeDeps({ customers, templates: [template(1, [variant('en')])] });
      expectApiError(await rejection(loyalty(deps)), 404, 'CUSTOMER_NOT_FOUND');
      expect(deps.sendSingle).not.toHaveBeenCalled();
    }
  });

  test('invalid ids and workspace are rejected up front', async () => {
    const deps = makeDeps();
    expectApiError(await rejection(tools.sendLoyaltyReminder({ workspaceId: WS, customerId: { $ne: null } }, deps)), 400, 'INVALID_ID');
    expectApiError(await rejection(tools.sendLoyaltyReminder({ workspaceId: null, customerId: CUST }, deps)), 403, 'FORBIDDEN');
    expect(deps.Customer.findOne).not.toHaveBeenCalled();
  });
});

describe('sendLoyaltyReminder — merge fields the sender cannot fill', () => {
  const arabicWithDate = variant('ar', { body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}. استبدلها قبل {date} واستمتع بمكافأتك.' });
  const lang = [{ workspaceId: WS, customerId: CUST, language: 'ar' }];

  test('a template that needs {date} cannot be sent without it: 422 FIELD_VALUES_MISSING naming the field; nothing is sent', async () => {
    const deps = makeDeps({ languages: lang, templates: [template(1, [arabicWithDate])] });
    const err = expectApiError(await rejection(loyalty(deps)), 422, 'FIELD_VALUES_MISSING');
    expect(err.message).toContain('date');
    expect(deps.sendSingle).not.toHaveBeenCalled();
  });

  test('a merchant-supplied value is passed to the sender', async () => {
    const deps = makeDeps({ languages: lang, templates: [template(1, [arabicWithDate])] });
    expect(await loyalty(deps, { fieldValues: { date: '30 نوفمبر' } })).toEqual({ sent: true });
    expect(deps.sendSingle.mock.calls[0][0].fieldValues).toEqual({ date: '30 نوفمبر' });
  });

  test('a template using only name/full_name/points/business needs nothing', async () => {
    const body = 'مرحباً {name}، {business} يذكّرك: رصيدك من النقاط {points}، {full_name}';
    const deps = makeDeps({ languages: lang, templates: [template(1, [variant('ar', { body })])] });
    expect(extractFields(body).every((f) => tools.AUTO_FILLED_FIELDS.includes(f))).toBe(true);
    expect(await loyalty(deps)).toEqual({ sent: true });
  });

  test('a header variable counts too', async () => {
    const deps = makeDeps({ languages: lang, templates: [template(1, [variant('ar', { header: 'عرض {discount}%' })])] });
    expectApiError(await rejection(loyalty(deps)), 422, 'FIELD_VALUES_MISSING');
  });

  test('a usable template that needs no extra value is preferred over a newer one that does', async () => {
    const needsDate = template(2, [arabicWithDate]);
    const plain = template(1, [variant('ar')]);
    const deps = makeDeps({ languages: lang, templates: [needsDate, plain] });
    expect(await loyalty(deps)).toEqual({ sent: true });
    expect(deps.sendSingle.mock.calls[0][0].templateId).toBe(plain._id);
  });

  test('a client can never override the per-customer fields (points, name…): they are dropped', async () => {
    const deps = makeDeps({ languages: lang, templates: [template(1, [arabicWithDate])] });
    await loyalty(deps, { fieldValues: { points: '999999', name: 'Hacker', full_name: 'x', business: 'y', date: '1 Jan' } });
    expect(deps.sendSingle.mock.calls[0][0].fieldValues).toEqual({ date: '1 Jan' });
  });
});

describe('parseFieldValues', () => {
  test('absent -> {}; values are sanitised like template parameters; numbers become text', () => {
    expect(tools.parseFieldValues(undefined)).toEqual({});
    expect(tools.parseFieldValues(null)).toEqual({});
    expect(tools.parseFieldValues({ date: ' 30\nNov\t2026 ', amount: 150 })).toEqual({ date: '30 Nov 2026', amount: '150' });
  });

  test.each([
    ['a string', 'date=1'], ['an array', [{ date: '1' }]], ['a number', 5], ['true', true],
    ['an invalid field name', { Date: 'x' }], ['a leading digit', { '1a': 'x' }], ['a prototype key', JSON.parse('{"__proto__": "x"}')], ['a dash', { 'a-b': 'x' }],
    ['an object value', { date: { $ne: 1 } }], ['an array value', { date: ['1'] }], ['a boolean value', { date: true }], ['null value', { date: null }],
    ['NaN', { date: NaN }], ['an empty value', { date: '' }], ['a blank value', { date: '  \n ' }],
    ['an oversized value', { date: 'x'.repeat(501) }],
    ['too many fields', Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`f${i}`, 'x']))],
  ])('%s is INVALID_INPUT', (_label, input) => {
    expectApiError(thrown(() => tools.parseFieldValues(input)), 400, 'INVALID_INPUT');
  });

  test('exactly 30 fields of exactly 500 characters are accepted', () => {
    const input = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, 'x'.repeat(500)]));
    expect(Object.keys(tools.parseFieldValues(input))).toHaveLength(30);
  });
});

describe('sendLoyaltyReminder — what the campaign sender answers', () => {
  const ready = (sendSingle) => makeDeps({
    languages: [{ workspaceId: WS, customerId: CUST, language: 'ar' }],
    templates: [template(1, [variant('ar')])],
    deps: { sendSingle },
  });

  test('sent -> { sent: true } (with the message id when the sender reports one)', async () => {
    expect(await loyalty(ready(jest.fn(async () => ({ sent: true, status: 'sent', usedLanguage: 'ar', fallback: false }))))).toEqual({ sent: true });
    expect(await loyalty(ready(jest.fn(async () => ({ sent: true, wamid: 'wamid.ABC' }))))).toEqual({ sent: true, messageId: 'wamid.ABC' });
  });

  test.each([
    [{ sent: false, status: 'skipped_no_consent', reason: 'no_consent' }, { sent: false, reason: 'no_consent', fallbackAvailable: false }],
    [{ sent: false, status: 'skipped_opted_out' }, { sent: false, reason: 'no_consent', fallbackAvailable: false }],
    [{ sent: false, reason: 'opted_out' }, { sent: false, reason: 'no_consent', fallbackAvailable: false }],
    [{ sent: false, status: 'skipped_blocked', reason: 'ar_pending' }, NO_VARIANT],
    [{ sent: false, reason: 'no_usable_variant' }, NO_VARIANT],
    [{ sent: false, reason: 'ar_not_reviewed' }, NO_VARIANT],
  ])('sender answer %j maps to %j', async (outcome, expected) => {
    expect(await loyalty(ready(jest.fn(async () => outcome)))).toEqual(expected);
  });

  test.each([
    [{ sent: false, status: 'failed', reason: '(#131047) Re-engagement message to 966501234567' }],
    [{ sent: false, status: 'skipped_error' }],
    [{ sent: false }],
    [undefined],
    [null],
  ])('any other not-sent answer %j is a sanitised META_ERROR', async (outcome) => {
    const deps = ready(jest.fn(async () => outcome));
    const err = expectApiError(await rejection(loyalty(deps)), 502, 'META_ERROR');
    expect(err.message).not.toMatch(/131047|966/);
  });

  test('contract errors the sender throws keep their status and code but never their text', async () => {
    for (const [code, status] of [['FIELD_VALUES_MISSING', 422], ['META_ERROR', 502], ['META_NOT_CONFIGURED', 503], ['CUSTOMER_NOT_FOUND', 404], ['TEMPLATE_NOT_FOUND', 404]]) {
      const deps = ready(jest.fn(async () => { throw Object.assign(new Error('internal detail: token EAAB123'), { status, code }); }));
      const err = expectApiError(await rejection(loyalty(deps)), status, code);
      expect(err.message).not.toContain('EAAB123');
    }
  });

  test('TEMPLATE_UNUSABLE / NOTHING_TO_SEND from the sender mean there is no usable version', async () => {
    for (const code of ['TEMPLATE_UNUSABLE', 'NOTHING_TO_SEND']) {
      expect(await loyalty(ready(jest.fn(async () => { throw Object.assign(new Error('x'), { status: 422, code }); })))).toEqual(NO_VARIANT);
    }
  });

  test('unexpected errors (database, axios, module missing) become a generic INTERNAL', async () => {
    const axiosLike = Object.assign(new Error('Request failed with status code 400'), { isAxiosError: true, status: 400, code: 'ERR_BAD_REQUEST' });
    for (const failure of [new Error('connect ECONNREFUSED 10.0.0.5:27017'), axiosLike, Object.assign(new Error("Cannot find module './campaigns'"), { code: 'MODULE_NOT_FOUND' })]) {
      const deps = ready(jest.fn(async () => { throw failure; }));
      const err = expectApiError(await rejection(loyalty(deps)), 500, 'INTERNAL');
      expect(err.message).toBe('Something went wrong');
    }
  });

  test('a double click: the second concurrent reminder is RATE_LIMITED and sends nothing', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const deps = ready(jest.fn(async () => { await gate; return { sent: true }; }));
    const first = loyalty(deps);
    await new Promise((resolve) => setImmediate(resolve));
    expectApiError(await rejection(loyalty(deps)), 429, 'RATE_LIMITED');
    expect(deps.sendSingle).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toEqual({ sent: true });
    await expect(loyalty(deps)).resolves.toEqual({ sent: true });
  });

  test('the actions\' locks are independent of each other', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const deps = makeDeps({
      languages: [{ workspaceId: WS, customerId: CUST, language: 'ar' }],
      templates: [template(1, [variant('ar')])],
      deps: { sendSingle: jest.fn(async () => { await gate; return { sent: true }; }) },
    });
    const reminder = loyalty(deps);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(tools.sendPaymentLink({ workspaceId: WS, customerId: CUST, amount: 10 }, deps)).resolves.toMatchObject({ sent: true });
    release();
    await reminder;
  });
});

// ── error normalisation, wiring and hygiene ──────────────────────────────

describe('toApiError', () => {
  test('keeps our own contract errors and replaces everything else with a generic INTERNAL (logging the real reason)', () => {
    const log = jest.fn();
    const ours = Object.assign(new Error('nope'), { status: 404, code: 'CUSTOMER_NOT_FOUND', expose: true });
    expect(tools.toApiError(ours, log)).toBe(ours);
    const mongo = Object.assign(new Error('E11000 duplicate key'), { code: 11000, status: 409 });
    const mapped = tools.toApiError(mongo, log);
    expect(mapped).toMatchObject({ status: 500, code: 'INTERNAL', message: 'Something went wrong', expose: true });
    expect(log).toHaveBeenCalledWith('inbox request failed:', 'E11000 duplicate key');
    expect(tools.toApiError(undefined, log)).toMatchObject({ status: 500, code: 'INTERNAL' });
    expect(tools.toApiError('a string', log)).toMatchObject({ status: 500, code: 'INTERNAL' });
  });
});

describe('the default collaborators', () => {
  const savedKey = process.env.STRIPE_SECRET_KEY;
  const savedMode = process.env.LOCALIZATION_SEND_MODE;
  const restore = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  afterEach(() => {
    restore('STRIPE_SECRET_KEY', savedKey);
    restore('LOCALIZATION_SEND_MODE', savedMode);
  });

  test('realDeps is built without loading Stripe, the existing inbox, or the campaign sender', () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.LOCALIZATION_SEND_MODE;
    const deps = tools.realDeps();
    for (const key of ['listConversations', 'sendManualMessage', 'canSendMarketing', 'sendSingle', 'getStripe', 'getMerchantDefault']) {
      expect(typeof deps[key]).toBe('function');
    }
    for (const key of ['Customer', 'CustomerLanguage', 'LocalizedTemplate', 'Settings']) expect(typeof deps[key].findOne).toBe('function');
    expect(deps.getStripe()).toBeNull(); // no key -> no client, no throw
    expect(typeof deps.appUrl).toBe('string');
    expect(deps.transport.isDryRun()).toBe(false);
  });

  test('canSendMarketing is the real consent predicate', () => {
    const deps = tools.realDeps();
    expect(deps.canSendMarketing({ marketingConsent: true, optedOut: false })).toBe(true);
    expect(deps.canSendMarketing({ marketingConsent: true, optedOut: true })).toBe(false);
    expect(deps.canSendMarketing({ marketingConsent: false })).toBe(false);
    expect(deps.canSendMarketing(null)).toBe(false);
  });
});

describe('the payment-link catalogue entry', () => {
  beforeAll(() => catalog.reload());

  test('exists in both languages as a draft with the same placeholders', () => {
    expect(catalog.has('inbox.paymentLink')).toBe(true);
    const entry = catalog.listEntries().find((e) => e.key === 'inbox.paymentLink');
    expect(entry.status).toBe('draft');
    expect(entry.needsLegalApproval).toBe(false);
    expect(extractFields(entry.en)).toEqual(['amount', 'link']);
    expect(extractFields(entry.ar)).toEqual(['amount', 'link']);
  });

  test('English is the text the existing English action sends; Arabic is Arabic, in Western digits, using the glossary term', () => {
    expect(catalog.t('en', 'inbox.paymentLink', { amount: '$5.00', link: 'https://x.test/pay/pi_1' })).toBe('💳 Here\'s your payment link for $5.00:\nhttps://x.test/pay/pi_1');
    const ar = catalog.t('ar', 'inbox.paymentLink');
    expect(ar).toContain('رابط الدفع');
    expect(ar).not.toMatch(/[\u{0660}-\u{0669}\u{06F0}-\u{06F9}]/u);
    expect(ar).not.toMatch(/whatsapp/i);
  });

  test('Latin amounts are wrapped in LRM inside the Arabic text, links are not', () => {
    const text = catalog.t('ar', 'inbox.paymentLink', { amount: '150.00 SAR', link: 'https://x.test/pay/pi_1?lang=ar' });
    expect(text).toContain(`${LRM}150.00 SAR${LRM}`);
    expect(text).toContain('\nhttps://x.test/pay/pi_1?lang=ar');
  });
});

describe('source hygiene of this slice', () => {
  const root = path.join(__dirname, '..', '..');
  const files = ['shared/localization/inboxTools.js', 'routes/localization/inbox.js', 'shared/localization/catalog/inbox.json'];
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

  test.each(files)('%s deletes nothing, never calls Meta/WhatsApp directly, never spreads a request body', (rel) => {
    const source = read(rel);
    expect(source).not.toMatch(/\b(?:deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|findOneAndRemove|findByIdAndRemove|dropDatabase|dropCollection)\b/);
    expect(source).not.toMatch(/\.(?:remove|drop)\(/);
    expect(source).not.toMatch(/\bwaPost\b|utils\/whatsapp|graph\.facebook/);
    expect(source).not.toMatch(/\.\.\.\s*req\.body|\.\.\.\s*body\b/);
  });

  test('the service stays require-safe: the heavy modules are only required inside functions', () => {
    const topLevel = read('shared/localization/inboxTools.js').split('\n').filter((line) => /^const .*require\(/.test(line)).join('\n');
    expect(topLevel).not.toMatch(/\.\.\/inbox|\.\.\/consent|\.\/campaigns|stripe|operations/);
  });

  test('Stripe is built lazily from the environment key', () => {
    expect(read('shared/localization/inboxTools.js')).toMatch(/new Stripe\(key\)/);
    expect(read('shared/localization/inboxTools.js')).toMatch(/process\.env\.STRIPE_SECRET_KEY/);
  });
});
