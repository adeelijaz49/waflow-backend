// Route tests for /api/localization/inbox: the router, the service and the REAL
// default collaborators (realDeps) wired together, with everything that would
// touch the outside world mocked — the models, the existing inbox functions, the
// campaign sender, Stripe, WhatsApp. A stub middleware plays requireAuth. No
// database, no network, nothing sent. Focus: tenant scoping (the workspace comes
// from the token only), operator-injection bodies/ids/queries, error shapes
// ({ error, code } and never upstream text), and double submits.
process.env.APP_URL = 'https://app.example.test';

jest.mock('../../utils/whatsapp', () => ({ waPost: jest.fn() })); // shared/consent.js imports it
jest.mock('../../shared/inbox', () => ({ listConversations: jest.fn(), sendManualMessage: jest.fn() }));
jest.mock('../../shared/localization/campaigns', () => ({ sendSingle: jest.fn() }), { virtual: true });
const mockStripeCtor = jest.fn();
jest.mock('stripe', () => mockStripeCtor);
const mockCreateIntent = jest.fn();
const mockCustomer = { findOne: jest.fn() };
const mockCustomerLanguage = { find: jest.fn(), findOne: jest.fn() };
const mockLocalizedTemplate = { find: jest.fn() };
const mockSettings = { findOne: jest.fn() };
const mockLocaleSettings = { findOne: jest.fn() };
jest.mock('../../models/Customer', () => mockCustomer);
jest.mock('../../models/CustomerLanguage', () => mockCustomerLanguage);
jest.mock('../../models/LocalizedTemplate', () => mockLocalizedTemplate);
jest.mock('../../models/Settings', () => mockSettings);
jest.mock('../../models/LocaleSettings', () => mockLocaleSettings);

const express = require('express');
const request = require('supertest');
const inbox = require('../../shared/inbox');
const campaigns = require('../../shared/localization/campaigns');
const router = require('../../routes/localization/inbox');
const { LRM } = require('../../shared/localization/arabicText');

const id = (n) => n.toString(16).padStart(24, '0');
const WS = id(1);
const OTHER_WS = id(2);
const USER = id(7);
const CUST = id(100);
const BASE = '/api/localization/inbox';

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
const query = (result) => {
  const q = { select: () => q, sort: () => q, limit: () => q, lean: async () => result };
  return q;
};

const customerDoc = (over = {}) => ({
  _id: CUST, workspaceId: WS, phone: '966501234567', marketingConsent: true, optedOut: false, loyaltyPoints: 120, ...over,
});
const variant = (language, over = {}) => ({
  language, body: language === 'ar' ? 'أهلاً {name}، رصيدك الحالي من النقاط: {points}' : 'Hi {name}, your balance is {points}',
  metaStatus: 'APPROVED', reviewStatus: 'reviewed', ...over,
});
const template = (n, variants, over = {}) => ({
  _id: id(500 + n), workspaceId: WS, useCase: 'loyalty_reminder', archived: false, updatedAt: new Date(Date.UTC(2026, 9, n)), variants, ...over,
});
const row = (n, name, phone, preview = null) => ({
  customerId: id(1000 + n), name, phone, optedOut: false, unreadCount: 0,
  lastMessageAt: new Date(Date.UTC(2026, 9, 11, 12, 0, 0, n)).toISOString(), lastMessagePreview: preview, tags: [],
});
const ROWS = [
  row(1, 'أَحْمَد المنصوري', '966501234567', 'تم تأكيد حجزك'),
  row(2, 'سارة أحمد', '966555000111', 'شكراً جزيلاً'),
  row(3, 'Sara Ahmed', '14155550123', 'Where is my order?'),
];

function setModels({ customers = [customerDoc()], languages = [], templates = [], settings = [{ workspaceId: WS, currency: 'SAR' }], localeDefault = 'en' } = {}) {
  mockCustomer.findOne.mockImplementation((f) => query(customers.find((d) => matches(d, f)) || null));
  mockCustomerLanguage.find.mockImplementation((f) => query(languages.filter((d) => matches(d, f))));
  mockCustomerLanguage.findOne.mockImplementation((f) => query(languages.find((d) => matches(d, f)) || null));
  mockLocalizedTemplate.find.mockImplementation((f) => query(templates.filter((d) => matches(d, f))));
  mockSettings.findOne.mockImplementation((f) => query(settings.find((d) => matches(d, f)) || null));
  mockLocaleSettings.findOne.mockImplementation(() => query({ defaultCustomerLanguage: localeDefault }));
}

function buildApp({ user = { id: USER, workspaceId: WS, role: 'owner' } } = {}) {
  const app = express();
  app.use(express.json());
  if (user) app.use((req, res, next) => { req.user = user; next(); });
  app.use(BASE, router);
  return app;
}

let app;
let consoleError;
const savedEnv = { key: process.env.STRIPE_SECRET_KEY, mode: process.env.LOCALIZATION_SEND_MODE };

beforeEach(() => {
  jest.clearAllMocks();
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  delete process.env.LOCALIZATION_SEND_MODE;
  mockStripeCtor.mockImplementation(() => ({ paymentIntents: { create: mockCreateIntent } }));
  mockCreateIntent.mockReset().mockResolvedValue({ id: 'pi_test_123' });
  inbox.listConversations.mockReset().mockResolvedValue({ conversations: ROWS });
  inbox.sendManualMessage.mockReset().mockResolvedValue({ _id: id(900) });
  campaigns.sendSingle.mockReset().mockResolvedValue({ sent: true, status: 'sent', usedLanguage: 'ar', fallback: false });
  setModels();
  app = buildApp();
});

afterEach(() => {
  consoleError.mockRestore();
  if (savedEnv.key === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = savedEnv.key;
  if (savedEnv.mode === undefined) delete process.env.LOCALIZATION_SEND_MODE; else process.env.LOCALIZATION_SEND_MODE = savedEnv.mode;
});

const waitFor = async (predicate) => {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never became true');
};

const expectError = (res, status, code) => {
  expect(res.status).toBe(status);
  expect(Object.keys(res.body).sort()).toEqual(['code', 'error']);
  expect(res.body.code).toBe(code);
  expect(typeof res.body.error).toBe('string');
};

describe('GET /conversations', () => {
  test('returns the existing envelope with a language on each row', async () => {
    setModels({ languages: [{ workspaceId: WS, customerId: ROWS[0].customerId, language: 'ar', languageSource: 'inferred' }] });
    const res = await request(app).get(`${BASE}/conversations`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['conversations']);
    expect(res.body.conversations).toEqual([{ ...ROWS[0], language: 'ar' }, { ...ROWS[1], language: 'unknown' }, { ...ROWS[2], language: 'unknown' }]);
  });

  test('Arabic search: diacritics, alef variants and digits are normalised', async () => {
    const byName = async (term) => (await request(app).get(`${BASE}/conversations`).query({ search: term })).body.conversations.map((r) => r.name);
    expect(await byName('احمد')).toEqual(['أَحْمَد المنصوري', 'سارة أحمد']);
    expect(await byName('ساره')).toEqual(['سارة أحمد']);
    expect(await byName('تاكيد')).toEqual(['أَحْمَد المنصوري']);
    expect(await byName('٠٥٠١٢٣٤٥٦٧')).toEqual(['أَحْمَد المنصوري']);
    expect(await byName('+966 50 123 4567')).toEqual(['أَحْمَد المنصوري']);
    expect(await byName('zzzz')).toEqual([]);
  });

  test('the existing list is called with the TOKEN\'s workspace and never with a search term', async () => {
    await request(app).get(`${BASE}/conversations`).query({ search: 'سارة', filter: 'unread', workspaceId: OTHER_WS });
    expect(inbox.listConversations).toHaveBeenCalledTimes(1);
    const arg = inbox.listConversations.mock.calls[0][0];
    expect(arg).toEqual({ workspaceId: WS, filter: 'unread' });
    expect(Object.keys(arg).sort()).toEqual(['filter', 'workspaceId']);
  });

  test('the language lookup is one query scoped to the token\'s workspace', async () => {
    await request(app).get(`${BASE}/conversations`).query({ workspaceId: OTHER_WS });
    expect(mockCustomerLanguage.find).toHaveBeenCalledTimes(1);
    expect(mockCustomerLanguage.find.mock.calls[0][0].workspaceId).toBe(WS);
  });

  test('an unknown filter means "all"', async () => {
    await request(app).get(`${BASE}/conversations`).query({ filter: 'drop table' });
    expect(inbox.listConversations.mock.calls[0][0].filter).toBeUndefined();
  });

  test('a repeated search parameter (array) and an oversized one are INVALID_INPUT', async () => {
    expectError(await request(app).get(`${BASE}/conversations?search=a&search=b`), 400, 'INVALID_INPUT');
    expectError(await request(app).get(`${BASE}/conversations`).query({ search: 'x'.repeat(201) }), 400, 'INVALID_INPUT');
    expect(inbox.listConversations).not.toHaveBeenCalled();
  });

  test('an operator-style query key is just an unknown parameter, never a filter', async () => {
    const res = await request(app).get(`${BASE}/conversations?search[$ne]=x&filter[$ne]=unread`);
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(ROWS.length);
    expect(inbox.listConversations.mock.calls[0][0]).toEqual({ workspaceId: WS, filter: undefined });
  });

  test.each(['(', '[', '.*', '\\', '+966', '((((', '$where', '%'])('the hostile search %j is a normal 200 (the existing search would have crashed on a regex)', async (term) => {
    const res = await request(app).get(`${BASE}/conversations`).query({ search: term });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.conversations)).toBe(true);
  });

  test('an unexpected failure is a generic INTERNAL: no stack, no connection string; the reason is logged for operators', async () => {
    inbox.listConversations.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED mongodb://admin:hunter2@10.0.0.5:27017'), { code: 'ECONNREFUSED' }));
    const res = await request(app).get(`${BASE}/conversations`);
    expectError(res, 500, 'INTERNAL');
    expect(res.text).not.toMatch(/hunter2|mongodb|ECONNREFUSED|stack| at /);
    expect(consoleError.mock.calls.flat().join(' ')).toContain('ECONNREFUSED');
  });

  test('a request with no authenticated user is FORBIDDEN and runs nothing', async () => {
    const res = await request(buildApp({ user: null })).get(`${BASE}/conversations`);
    expectError(res, 403, 'FORBIDDEN');
    expect(inbox.listConversations).not.toHaveBeenCalled();
  });

  test('a token whose workspace is not an id is FORBIDDEN (the existing list would otherwise go unscoped)', async () => {
    for (const workspaceId of [undefined, '', 'nope', { $ne: null }]) {
      const res = await request(buildApp({ user: { id: USER, workspaceId } })).get(`${BASE}/conversations`);
      expectError(res, 403, 'FORBIDDEN');
    }
    expect(inbox.listConversations).not.toHaveBeenCalled();
  });
});

describe('GET /conversations/:customerId/context', () => {
  test('returns the language context', async () => {
    setModels({ languages: [{ workspaceId: WS, customerId: CUST, language: 'ar', languageSource: 'merchant_set' }] });
    const res = await request(app).get(`${BASE}/conversations/${CUST}/context`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ customerId: CUST, language: 'ar', languageSource: 'merchant_set', effectiveLanguage: 'ar' });
  });

  test('effective language falls back to the merchant default, then English', async () => {
    setModels({ localeDefault: 'ar' });
    expect((await request(app).get(`${BASE}/conversations/${CUST}/context`)).body).toEqual({
      customerId: CUST, language: 'unknown', languageSource: null, effectiveLanguage: 'ar',
    });
  });

  test('the customer filter uses the token\'s workspace (not the query\'s) and hides demo and erased customers', async () => {
    await request(app).get(`${BASE}/conversations/${CUST}/context`).query({ workspaceId: OTHER_WS });
    expect(mockCustomer.findOne.mock.calls[0][0]).toEqual({ _id: CUST, workspaceId: WS, deletedAt: { $exists: false }, isDemo: { $ne: true } });
  });

  test('another tenant\'s customer, a demo customer and an erased customer are 404 CUSTOMER_NOT_FOUND', async () => {
    for (const customers of [[customerDoc({ workspaceId: OTHER_WS })], [customerDoc({ isDemo: true })], [customerDoc({ deletedAt: new Date() })]]) {
      setModels({ customers });
      expectError(await request(app).get(`${BASE}/conversations/${CUST}/context`), 404, 'CUSTOMER_NOT_FOUND');
    }
  });

  test.each([['nope'], [encodeURIComponent('{"$ne":null}')], [encodeURIComponent('{"$gt":""}')], [`${CUST}0`], [CUST.slice(1)], ['%00'], [encodeURIComponent('[$ne]')]])(
    'the id %j is INVALID_ID and never reaches the database',
    async (badId) => {
      expectError(await request(app).get(`${BASE}/conversations/${badId}/context`), 400, 'INVALID_ID');
      expect(mockCustomer.findOne).not.toHaveBeenCalled();
    },
  );
});

describe('POST /conversations/:customerId/payment-link', () => {
  const post = (body, customerId = CUST) => request(app).post(`${BASE}/conversations/${customerId}/payment-link`).send(body);

  test('English customer: 201, the existing message text, the PaymentIntent like the existing action', async () => {
    const res = await post({ amount: 150 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ sent: true, messageId: id(900) });
    expect(mockCreateIntent).toHaveBeenCalledTimes(1);
    expect(mockCreateIntent).toHaveBeenCalledWith({
      amount: 15000, currency: 'sar', automatic_payment_methods: { enabled: true },
      metadata: { buyerPhone: '966501234567', source: 'inbox_manual_payment_link', workspaceId: WS }, // + the customer (tenant) the Stripe webhook credits
    });
    expect(inbox.sendManualMessage).toHaveBeenCalledWith({
      customerId: CUST, workspaceId: WS, performedBy: USER, messageType: 'payment',
      body: '💳 Here\'s your payment link for 150.00 SAR:\nhttps://app.example.test/pay/pi_test_123',
    });
  });

  test('Arabic customer: Arabic text, LRM-protected amount, ?lang=ar link', async () => {
    setModels({ languages: [{ workspaceId: WS, customerId: CUST, language: 'ar', languageSource: 'merchant_set' }] });
    const res = await post({ amount: '٢٥٠٫٥٠' });
    expect(res.status).toBe(201);
    expect(mockCreateIntent.mock.calls[0][0].amount).toBe(25050);
    expect(inbox.sendManualMessage.mock.calls[0][0].body).toBe(`💳 رابط الدفع لمبلغ ${LRM}250.50 SAR${LRM}:\nhttps://app.example.test/pay/pi_test_123?lang=ar`);
  });

  test('only the amount is read from the body: the tenant, customer, sender, text, type and currency cannot be chosen by the client', async () => {
    const res = await post({
      amount: 150, workspaceId: OTHER_WS, customerId: id(999), performedBy: id(888), body: 'pwned', messageType: 'manual', currency: 'usd', metadata: { x: 1 },
    });
    expect(res.status).toBe(201);
    expect(inbox.sendManualMessage).toHaveBeenCalledWith({
      customerId: CUST, workspaceId: WS, performedBy: USER, messageType: 'payment',
      body: expect.stringContaining('150.00 SAR'),
    });
    expect(inbox.sendManualMessage.mock.calls[0][0].body).not.toContain('pwned');
    expect(mockCreateIntent.mock.calls[0][0].currency).toBe('sar');
    expect(mockCreateIntent.mock.calls[0][0].metadata).toEqual({ buyerPhone: '966501234567', source: 'inbox_manual_payment_link', workspaceId: WS });
    expect(mockCustomer.findOne.mock.calls[0][0]).toMatchObject({ _id: CUST, workspaceId: WS });
  });

  test.each([
    [{}], [{ amount: null }], [{ amount: { $gt: 0 } }], [{ amount: { $ne: null } }], [{ amount: [150] }], [{ amount: 'abc' }], [{ amount: '' }],
    [{ amount: 0 }], [{ amount: -1 }], [{ amount: 1000000.01 }], [{ amount: 1.005 }], [{ amount: true }], [{ amount: '1e3' }], [{ amount: '0x10' }], [{ amount: '1,5' }],
  ])('the body %j is 400 INVALID_AMOUNT: no PaymentIntent, no message', async (body) => {
    expectError(await post(body), 400, 'INVALID_AMOUNT');
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(inbox.sendManualMessage).not.toHaveBeenCalled();
  });

  test('no JSON body at all, or a non-JSON body, is INVALID_AMOUNT — not a crash', async () => {
    expectError(await request(app).post(`${BASE}/conversations/${CUST}/payment-link`), 400, 'INVALID_AMOUNT');
    expectError(await request(app).post(`${BASE}/conversations/${CUST}/payment-link`).type('form').send('amount=5'), 400, 'INVALID_AMOUNT');
    expectError(await request(app).post(`${BASE}/conversations/${CUST}/payment-link`).send([150]), 400, 'INVALID_AMOUNT');
  });

  test('bad ids are INVALID_ID; unknown or other-tenant customers are 404 and create nothing', async () => {
    expectError(await post({ amount: 10 }, encodeURIComponent('{"$ne":null}')), 400, 'INVALID_ID');
    setModels({ customers: [customerDoc({ workspaceId: OTHER_WS })] });
    expectError(await post({ amount: 10 }), 404, 'CUSTOMER_NOT_FOUND');
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(inbox.sendManualMessage).not.toHaveBeenCalled();
  });

  test('no Stripe key -> 503 STRIPE_UNAVAILABLE, nothing sent', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    expectError(await post({ amount: 10 }), 503, 'STRIPE_UNAVAILABLE');
    expect(inbox.sendManualMessage).not.toHaveBeenCalled();
  });

  test('a Stripe failure never leaks provider text', async () => {
    mockCreateIntent.mockRejectedValue(Object.assign(new Error('Invalid API Key provided: sk_test_****abcd'), { type: 'StripeAuthenticationError', code: 'api_key_invalid' }));
    const res = await post({ amount: 10 });
    expectError(res, 503, 'STRIPE_UNAVAILABLE');
    expect(res.text).not.toMatch(/sk_test|API Key|abcd/);
    expect(inbox.sendManualMessage).not.toHaveBeenCalled();
  });

  test('a WhatsApp failure is 502 META_ERROR without the upstream text or number', async () => {
    inbox.sendManualMessage.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
      isAxiosError: true, status: 400, code: 'ERR_BAD_REQUEST', response: { status: 400, data: { error: { code: 131030, message: 'Recipient 966501234567 is not in the allowed list' } } },
    }));
    const res = await post({ amount: 10 });
    expectError(res, 502, 'META_ERROR');
    expect(res.text).not.toMatch(/966501234567|allowed list|ERR_BAD_REQUEST|status code/);
  });

  test('a double click: one request is served, the concurrent duplicate is 429 RATE_LIMITED, and only one PaymentIntent exists', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    inbox.sendManualMessage.mockImplementation(async () => { await gate; return { _id: id(900) }; });
    const first = post({ amount: 10 }).then((res) => res);
    await waitFor(() => inbox.sendManualMessage.mock.calls.length === 1);
    expectError(await post({ amount: 10 }), 429, 'RATE_LIMITED');
    release();
    expect((await first).status).toBe(201);
    expect(mockCreateIntent).toHaveBeenCalledTimes(1);
    expect((await post({ amount: 10 })).status).toBe(201); // released afterwards
  });

  test('LOCALIZATION_SEND_MODE=dry_run: no Stripe and no existing sender (which talks to Meta directly) — a safe local run', async () => {
    process.env.LOCALIZATION_SEND_MODE = 'dry_run';
    delete process.env.STRIPE_SECRET_KEY;
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await post({ amount: 10 });
      expect(res.status).toBe(201);
      expect(res.body.sent).toBe(true);
      expect(res.body.messageId).toMatch(/^dryrun\./);
      expect(mockCreateIntent).not.toHaveBeenCalled();
      expect(inbox.sendManualMessage).not.toHaveBeenCalled();
      const transport = require('../../shared/localization/transport');
      const last = transport.lastDryRuns().pop();
      expect(last.payload).toMatchObject({ to: '966501234567', type: 'text' });
      expect(last.payload.text.body).toContain('/pay/pi_dry_run');
      transport.clearDryRuns();
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('POST /conversations/:customerId/loyalty-reminder', () => {
  const post = (body, customerId = CUST) => request(app).post(`${BASE}/conversations/${customerId}/loyalty-reminder`).send(body);
  const arabicReady = (over = {}) => setModels({
    languages: [{ workspaceId: WS, customerId: CUST, language: 'ar' }],
    templates: [template(1, [variant('en'), variant('ar')])],
    ...over,
  });

  test('an Arabic customer is sent the approved Arabic variant through the campaign sender, scoped to the token', async () => {
    arabicReady();
    const res = await post({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(campaigns.sendSingle).toHaveBeenCalledWith({
      workspaceId: WS, templateId: id(501), customerId: CUST, fieldValues: {}, languageMode: 'ar', createdBy: USER,
    });
  });

  test('works with no body at all', async () => {
    arabicReady();
    const res = await request(app).post(`${BASE}/conversations/${CUST}/loyalty-reminder`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
  });

  test('the template query is scoped to the token\'s workspace even if the body names another', async () => {
    arabicReady();
    await post({ workspaceId: OTHER_WS, customerId: id(999), templateId: id(666), languageMode: 'en', useCase: 'comeback' });
    expect(mockLocalizedTemplate.find.mock.calls[0][0]).toEqual({ workspaceId: WS, useCase: 'loyalty_reminder', archived: { $ne: true } });
    const arg = campaigns.sendSingle.mock.calls[0][0];
    expect(arg).toMatchObject({ workspaceId: WS, customerId: CUST, templateId: id(501), languageMode: 'ar' });
  });

  test('another tenant\'s template is never used', async () => {
    arabicReady({ templates: [template(1, [variant('en'), variant('ar')], { workspaceId: OTHER_WS })] });
    const res = await post({});
    expect(res.body).toEqual({ sent: false, reason: 'no_approved_variant', fallbackAvailable: true });
    expect(campaigns.sendSingle).not.toHaveBeenCalled();
  });

  test('no approved Arabic version -> 200 no_approved_variant with the fallback on offer (never a silent English send)', async () => {
    arabicReady({ templates: [template(1, [variant('en'), variant('ar', { metaStatus: 'PENDING' })])] });
    const res = await post({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false, reason: 'no_approved_variant', fallbackAvailable: true });
    expect(campaigns.sendSingle).not.toHaveBeenCalled();
  });

  test('an approved Arabic variant that is still a draft (not natively reviewed) is not sent', async () => {
    arabicReady({ templates: [template(1, [variant('en'), variant('ar', { reviewStatus: 'draft' })])] });
    expect((await post({})).body.reason).toBe('no_approved_variant');
    expect(campaigns.sendSingle).not.toHaveBeenCalled();
  });

  test('an English customer gets the English variant', async () => {
    setModels({ languages: [{ workspaceId: WS, customerId: CUST, language: 'en' }], templates: [template(1, [variant('en'), variant('ar')])] });
    expect((await post({})).body).toEqual({ sent: true });
    expect(campaigns.sendSingle.mock.calls[0][0].languageMode).toBe('en');
  });

  test.each([
    [{ marketingConsent: false }], [{ optedOut: true }], [{ marketingConsent: true, optedOut: true }],
  ])('a customer with %j gets no_consent and nothing is sent', async (patch) => {
    arabicReady({ customers: [customerDoc(patch)] });
    const res = await post({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false, reason: 'no_consent', fallbackAvailable: false });
    expect(campaigns.sendSingle).not.toHaveBeenCalled();
    expect(mockLocalizedTemplate.find).not.toHaveBeenCalled();
  });

  test('a customer without loyalty points gets no_points', async () => {
    arabicReady({ customers: [customerDoc({ loyaltyPoints: 0 })] });
    expect((await post({})).body).toEqual({ sent: false, reason: 'no_points', fallbackAvailable: false });
    expect(campaigns.sendSingle).not.toHaveBeenCalled();
  });

  test('a template that needs {date} is 422 FIELD_VALUES_MISSING until the value is supplied in fieldValues', async () => {
    const body = 'أهلاً {name}، رصيدك الحالي من النقاط: {points}. استبدلها قبل {date} واستمتع بمكافأتك.';
    arabicReady({ templates: [template(1, [variant('ar', { body })])] });
    const missing = await post({});
    expectError(missing, 422, 'FIELD_VALUES_MISSING');
    expect(missing.body.error).toContain('date');
    const supplied = await post({ fieldValues: { date: '30 نوفمبر', points: '999999' } });
    expect(supplied.body).toEqual({ sent: true });
    expect(campaigns.sendSingle.mock.calls[0][0].fieldValues).toEqual({ date: '30 نوفمبر' });
  });

  test.each([
    [{ fieldValues: 'x' }], [{ fieldValues: ['a'] }], [{ fieldValues: { $ne: 1 } }], [{ fieldValues: { date: { $ne: 1 } } }],
    [{ fieldValues: { Date: 'x' } }], [{ fieldValues: { date: '' } }], [{ fieldValues: { date: 'x'.repeat(501) } }], [{ fieldValues: 5 }],
  ])('the body %j is 400 INVALID_INPUT and sends nothing', async (body) => {
    arabicReady();
    expectError(await post(body), 400, 'INVALID_INPUT');
    expect(campaigns.sendSingle).not.toHaveBeenCalled();
  });

  test('unknown, other-tenant, demo and erased customers are 404 CUSTOMER_NOT_FOUND; bad ids are INVALID_ID', async () => {
    for (const customers of [[], [customerDoc({ workspaceId: OTHER_WS })], [customerDoc({ isDemo: true })], [customerDoc({ deletedAt: new Date() })]]) {
      arabicReady({ customers });
      expectError(await post({}), 404, 'CUSTOMER_NOT_FOUND');
    }
    expectError(await post({}, encodeURIComponent('{"$ne":null}')), 400, 'INVALID_ID');
    expect(campaigns.sendSingle).not.toHaveBeenCalled();
  });

  test('a sender that fails is a sanitised error: no internals, no upstream text', async () => {
    arabicReady();
    campaigns.sendSingle.mockRejectedValue(Object.assign(new Error('E11000 duplicate key collection: localizedsends index: campaignId_1 dup key'), { code: 11000 }));
    const res = await post({});
    expectError(res, 500, 'INTERNAL');
    expect(res.text).not.toMatch(/E11000|localizedsends|campaignId/);
    expect(consoleError.mock.calls.flat().join(' ')).toContain('E11000');
  });

  test('a sender answering "failed" is 502 META_ERROR with no detail', async () => {
    arabicReady();
    campaigns.sendSingle.mockResolvedValue({ sent: false, status: 'failed', reason: '(#131047) Re-engagement message', errorCode: 131047 });
    const res = await post({});
    expectError(res, 502, 'META_ERROR');
    expect(res.text).not.toMatch(/131047|Re-engagement/);
  });

  test('a double click: the concurrent duplicate is 429 RATE_LIMITED and only one reminder is sent', async () => {
    arabicReady();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    campaigns.sendSingle.mockImplementation(async () => { await gate; return { sent: true }; });
    const first = post({}).then((res) => res);
    await waitFor(() => campaigns.sendSingle.mock.calls.length === 1);
    expectError(await post({}), 429, 'RATE_LIMITED');
    release();
    expect((await first).body).toEqual({ sent: true });
    expect(campaigns.sendSingle).toHaveBeenCalledTimes(1);
  });
});
