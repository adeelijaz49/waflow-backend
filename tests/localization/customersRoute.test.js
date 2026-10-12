// HTTP-level tests for /api/localization/customers: a bare Express app with a stub
// auth middleware (sets req.user like requireAuth does) and in-memory models
// substituted for the Mongoose ones — no database, no network. The point of most
// tests here is TENANT ISOLATION and INPUT HARDENING at the route boundary.
const express = require('express');
const request = require('supertest');

jest.mock('../../models/Customer', () => new (require('./helpers/fakeMongo').FakeModel)([]));
jest.mock('../../models/CustomerLanguage', () => new (require('./helpers/fakeMongo').FakeModel)([], { unique: ['workspaceId', 'customerId'], defaults: { language: 'unknown', inferenceAttempts: 0 } }));
jest.mock('../../models/Settings', () => new (require('./helpers/fakeMongo').FakeModel)([]));
jest.mock('../../models/LocaleSettings', () => new (require('./helpers/fakeMongo').FakeModel)([]));

const Customer = require('../../models/Customer');
const CustomerLanguage = require('../../models/CustomerLanguage');
const Settings = require('../../models/Settings');
const LocaleSettings = require('../../models/LocaleSettings');
const { oid } = require('./helpers/fakeMongo');
const { BOM, parseCsv } = require('../../shared/localization/csv');

const W1 = oid(0xa1);
const W2 = oid(0xa2);
const USER = oid(0xbb);
let seq = 0x5000;

const cust = (firstname, lastname, phone, extra = {}, workspaceId = W1) => ({ _id: oid(seq++), workspaceId, firstname, lastname, phone, ...extra });
const lang = (customer, language, languageSource) => ({ _id: oid(seq++), workspaceId: customer.workspaceId, customerId: customer._id, language, languageSource });

let c;

function resetData() {
  c = {
    sara: cust('سارة', 'أحمد', '966500000001'),
    zed: cust('Zed', 'Last', '966500000002'),
    mona: cust('Mona', 'Mona', '966500000003'),
    erased: cust('Deleted', 'Customer', 'deleted-x', { deletedAt: new Date() }),
    demo: cust('Demo', 'Person', '61400000001', { isDemo: true }),
    theirs: cust('Their', 'Customer', '966500000001', {}, W2),
    theirs2: cust('Other', 'Person', '966500000009', {}, W2),
  };
  Customer.docs = Object.values(c);
  CustomerLanguage.docs = [lang(c.sara, 'ar', 'inferred'), lang(c.theirs, 'en', 'merchant_set')];
  LocaleSettings.docs = [{ _id: oid(seq++), workspaceId: W1, defaultCustomerLanguage: 'ar' }];
  Settings.docs = [];
  for (const m of [Customer, CustomerLanguage, Settings, LocaleSettings]) { m.calls = []; m.hooks = {}; }
}

function makeApp({ queryParser } = {}) {
  const app = express();
  if (queryParser) app.set('query parser', queryParser);
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: USER, workspaceId: req.get('x-test-workspace') || W1, role: 'owner' };
    next();
  });
  app.use('/api/localization/customers', require('../../routes/localization/customers'));
  return app;
}

const BASE = '/api/localization/customers';
const names = (body) => body.items.map((i) => i.name);

// Every model call carried the token's workspace and never the attacker's.
function expectOnlyWorkspace(allowed, forbidden) {
  const seen = [];
  for (const model of [Customer, CustomerLanguage, Settings]) {
    for (const call of model.calls) {
      if (call.method === 'bulkWrite') for (const op of call.operations) seen.push(String(op.updateOne.filter.workspaceId));
      else seen.push(String(call.filter.workspaceId));
    }
  }
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((w) => w === allowed)).toBe(true);
  expect(JSON.stringify([Customer.calls, CustomerLanguage.calls, Settings.calls])).not.toContain(forbidden);
}

beforeEach(resetData);

describe('GET /customers', () => {
  test('returns the CustomerLanguageList contract', async () => {
    const res = await request(makeApp()).get(BASE);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(Object.keys(res.body).sort()).toEqual(['counts', 'items', 'limit', 'page', 'total']);
    expect(res.body).toMatchObject({ total: 3, page: 1, limit: 50, counts: { en: 0, ar: 1, unknown: 2, total: 3 } });
    expect(names(res.body)).toEqual(['Mona', 'Zed Last', 'سارة أحمد']);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(['effectiveLanguage', 'id', 'language', 'languageSource', 'marketingConsent', 'name', 'optedOut', 'phone']);
    // merchant default (ar) applies to customers without a language
    expect(res.body.items.find((i) => i.name === 'Mona')).toMatchObject({ language: 'unknown', languageSource: null, effectiveLanguage: 'ar' });
  });

  test('the workspace comes from the token even if the query claims another one', async () => {
    const res = await request(makeApp()).get(BASE).query({ workspaceId: W2, workspace: W2, ws: W2, workspace_id: W2 });
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(['Mona', 'Zed Last', 'سارة أحمد']);
    expectOnlyWorkspace(W1, W2);
  });

  test('another workspace\'s token sees only that workspace', async () => {
    const res = await request(makeApp()).get(BASE).set('x-test-workspace', W2);
    expect(names(res.body)).toEqual(['Other Person', 'Their Customer']);
    expect(res.body.counts).toMatchObject({ total: 2, en: 1 });
    expectOnlyWorkspace(W2, W1);
  });

  test('language, search, page and limit query parameters', async () => {
    const app = makeApp();
    let res = await request(app).get(BASE).query({ language: 'unknown' });
    expect(names(res.body)).toEqual(['Mona', 'Zed Last']);
    res = await request(app).get(BASE).query({ language: 'ar' });
    expect(names(res.body)).toEqual(['سارة أحمد']);
    res = await request(app).get(BASE).query({ search: 'احمد' });
    expect(names(res.body)).toEqual(['سارة أحمد']);
    res = await request(app).get(BASE).query({ search: '+966 50 000 0002' });
    expect(names(res.body)).toEqual(['Zed Last']);
    res = await request(app).get(BASE).query({ page: 2, limit: 2 });
    expect(res.body).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(names(res.body)).toEqual(['سارة أحمد']);
  });

  test('an Arabic search term arrives URL-encoded and is found', async () => {
    const res = await request(makeApp()).get(`${BASE}?search=${encodeURIComponent('أَحْمَد')}`);
    expect(names(res.body)).toEqual(['سارة أحمد']);
  });

  test.each(['fr', 'AR', 'all2', '%00'])('language=%s -> 400 INVALID_LANGUAGE', async (value) => {
    const res = await request(makeApp()).get(BASE).query({ language: value });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code: 'INVALID_LANGUAGE' });
  });

  test('operator objects in the query are rejected (extended query parser)', async () => {
    const app = makeApp({ queryParser: 'extended' });
    let res = await request(app).get(`${BASE}?search[$ne]=x`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    res = await request(app).get(`${BASE}?search[$regex]=.*`);
    expect(res.status).toBe(400);
    res = await request(app).get(`${BASE}?language[$ne]=ar`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LANGUAGE');
    expect(Customer.calls).toHaveLength(0);
  });

  test('a repeated search parameter is rejected, not coerced', async () => {
    const res = await request(makeApp()).get(`${BASE}?search=a&search=b`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  test('an absurdly long search is rejected before any query', async () => {
    const res = await request(makeApp()).get(BASE).query({ search: 'x'.repeat(600) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(Customer.calls).toHaveLength(0);
  });

  test('regex metacharacters in the search never break the request', async () => {
    for (const search of ['(', '[', '.*', '\\', '+966', '$', 'a|b', '(?<n>x)', '%', '\u{0}']) {
      const res = await request(makeApp()).get(BASE).query({ search });
      expect(res.status).toBe(200);
    }
  });

  test('a database failure is a generic 500 without internals or a stack', async () => {
    const original = Customer.find;
    Customer.find = () => { throw new Error('secret connection string mongodb://user:pw@host'); };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(makeApp()).get(BASE);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Something went wrong' });
      expect(JSON.stringify(res.body)).not.toMatch(/secret|mongodb|stack|at /);
    } finally {
      Customer.find = original;
      spy.mockRestore();
    }
  });
});

describe('PUT /customers/:id/language', () => {
  const put = (app, id, body) => request(app).put(`${BASE}/${id}/language`).send(body);

  test('sets the language and returns the row', async () => {
    const res = await put(makeApp(), c.zed._id, { language: 'ar' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: c.zed._id, name: 'Zed Last', language: 'ar', languageSource: 'merchant_set', effectiveLanguage: 'ar' });
    expect(CustomerLanguage.docs.find((d) => d.customerId === c.zed._id)).toMatchObject({ workspaceId: W1, language: 'ar', languageSource: 'merchant_set', updatedBy: USER });
  });

  test('unknown clears the source (so the first message can still infer a language)', async () => {
    const res = await put(makeApp(), c.sara._id, { language: 'unknown' });
    expect(res.body).toMatchObject({ language: 'unknown', languageSource: null });
  });

  test('body fields other than language are ignored (no mass assignment)', async () => {
    const res = await put(makeApp(), c.zed._id, {
      language: 'en', workspaceId: W2, customerId: c.theirs._id, languageSource: 'customer_chose', updatedBy: oid(0xdead), inferenceAttempts: 99, _id: oid(1), $set: { language: 'ar' },
    });
    expect(res.status).toBe(200);
    const doc = CustomerLanguage.docs.find((d) => d.customerId === c.zed._id);
    expect(doc).toMatchObject({ workspaceId: W1, customerId: c.zed._id, language: 'en', languageSource: 'merchant_set', updatedBy: USER, inferenceAttempts: 0 });
    expect(CustomerLanguage.docs).toHaveLength(3);
    expectOnlyWorkspace(W1, W2);
  });

  test('another workspace\'s customer is a 404, even when the body names the other workspace', async () => {
    const res = await put(makeApp(), c.theirs2._id, { language: 'ar', workspaceId: W2 });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: expect.any(String), code: 'CUSTOMER_NOT_FOUND' });
    expect(CustomerLanguage.docs).toHaveLength(2);
  });

  test.each([['erased'], ['demo']])('a %s customer is a 404', async (key) => {
    const res = await put(makeApp(), c[key]._id, { language: 'ar' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
  });

  test.each([['abc'], ['12345'], [`${oid(1)}0`], ['%7B%22%24ne%22%3Anull%7D'], ['null'], ['undefined'], ['..%2F..%2Fx']])('id %s -> 400 INVALID_ID', async (id) => {
    const res = await put(makeApp(), id, { language: 'ar' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code: 'INVALID_ID' });
    expect(Customer.calls).toHaveLength(0);
  });

  test.each([[{ language: 'fr' }], [{ language: { $ne: 'ar' } }], [{ language: ['ar'] }], [{ language: null }], [{}], [{ lang: 'ar' }], [{ language: 'AR' }]])('body %j -> 400 INVALID_LANGUAGE', async (body) => {
    const res = await put(makeApp(), c.zed._id, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code: 'INVALID_LANGUAGE' });
    expect(Customer.calls).toHaveLength(0);
  });

  test('no body at all -> 400 INVALID_LANGUAGE (Express 5 leaves req.body undefined)', async () => {
    const res = await request(makeApp()).put(`${BASE}/${c.zed._id}/language`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LANGUAGE');
  });
});

describe('POST /customers/language/bulk', () => {
  const post = (app, body) => request(app).post(`${BASE}/language/bulk`).send(body);

  test('updates only the caller\'s customers and counts exactly those', async () => {
    const res = await post(makeApp(), { customerIds: [c.zed._id, c.mona._id, c.theirs._id, c.theirs2._id, c.erased._id, c.demo._id, oid(0xfeed)], language: 'ar' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2 });
    const byCustomer = Object.fromEntries(CustomerLanguage.docs.map((d) => [d.customerId, d]));
    expect(byCustomer[c.zed._id]).toMatchObject({ workspaceId: W1, language: 'ar', languageSource: 'merchant_set', updatedBy: USER });
    expect(byCustomer[c.mona._id]).toMatchObject({ workspaceId: W1, language: 'ar' });
    expect(byCustomer[c.theirs._id]).toMatchObject({ workspaceId: W2, language: 'en', languageSource: 'merchant_set' }); // untouched
    expect(byCustomer[c.theirs2._id]).toBeUndefined();
    expect(byCustomer[c.erased._id]).toBeUndefined();
    expect(byCustomer[c.demo._id]).toBeUndefined();
    expectOnlyWorkspace(W1, W2);
  });

  test('a workspaceId in the body is ignored', async () => {
    const res = await post(makeApp(), { customerIds: [c.theirs2._id], language: 'ar', workspaceId: W2 });
    expect(res.body).toEqual({ updated: 0 });
    expect(CustomerLanguage.docs.find((d) => d.customerId === c.theirs2._id)).toBeUndefined();
  });

  test('works for the other workspace with its own token', async () => {
    const res = await request(makeApp()).post(`${BASE}/language/bulk`).set('x-test-workspace', W2).send({ customerIds: [c.theirs2._id, c.zed._id], language: 'en' });
    expect(res.body).toEqual({ updated: 1 });
    expect(CustomerLanguage.docs.find((d) => d.customerId === c.zed._id)).toBeUndefined();
  });

  test.each([
    [{ customerIds: [{ $ne: null }], language: 'ar' }, 'INVALID_ID'],
    [{ customerIds: [{ $gt: '' }, oid(1)], language: 'ar' }, 'INVALID_ID'],
    [{ customerIds: ['abc'], language: 'ar' }, 'INVALID_ID'],
    [{ customerIds: [null], language: 'ar' }, 'INVALID_ID'],
    [{ customerIds: { $ne: null }, language: 'ar' }, 'INVALID_INPUT'],
    [{ customerIds: 'x', language: 'ar' }, 'INVALID_INPUT'],
    [{ customerIds: [], language: 'ar' }, 'INVALID_INPUT'],
    [{ language: 'ar' }, 'INVALID_INPUT'],
    [{ customerIds: [oid(1)], language: 'fr' }, 'INVALID_LANGUAGE'],
    [{ customerIds: [oid(1)], language: { $ne: 'ar' } }, 'INVALID_LANGUAGE'],
    [{ customerIds: [oid(1)] }, 'INVALID_LANGUAGE'],
  ])('body %j -> 400 %s before any query', async (body, code) => {
    const res = await post(makeApp(), body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code });
    expect(Customer.calls).toHaveLength(0);
    expect(CustomerLanguage.calls).toHaveLength(0);
  });

  test('more than 1000 ids -> 400', async () => {
    const res = await post(makeApp(), { customerIds: Array.from({ length: 1001 }, (_, i) => oid(i + 1)), language: 'ar' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  test('exactly 1000 ids is accepted', async () => {
    const res = await post(makeApp(), { customerIds: Array.from({ length: 1000 }, (_, i) => oid(i + 1)), language: 'ar' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 0 });
  });

  test('no body -> 400', async () => {
    const res = await request(makeApp()).post(`${BASE}/language/bulk`);
    expect(res.status).toBe(400);
  });
});

describe('POST /customers/language/import', () => {
  const FILE = 'phone,language\n0500000001,ar\n0500000002,English\n966599999999,ar\nbad,ar\n';
  const upload = (app, { fields = { dryRun: 'true' }, file = Buffer.from(FILE), name = 'langs.csv', type = 'text/csv', field = 'file' } = {}) => {
    let req = request(app).post(`${BASE}/language/import`);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return file === null ? req : req.attach(field, file, { filename: name, contentType: type });
  };

  test('dry run: the LanguageImportResult contract, nothing written', async () => {
    const before = JSON.stringify(CustomerLanguage.docs);
    const res = await upload(makeApp());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      dryRun: true,
      encoding: 'utf-8',
      delimiter: ',',
      summary: expect.any(Object),
      rows: [
        { line: 2, phone: '0500000001', language: 'ar', outcome: 'unchanged' },
        { line: 3, phone: '0500000002', language: 'English', outcome: 'updated' },
        { line: 4, phone: '966599999999', language: 'ar', outcome: 'unmatched' },
        { line: 5, phone: 'bad', language: 'ar', outcome: 'invalid_phone' },
      ],
      truncated: false,
    });
    expect(res.body.summary).toEqual({ rows: 4, updated: 1, unchanged: 1, unmatched: 1, invalid: 1, duplicate: 0, protected: 0 });
    expect(JSON.stringify(CustomerLanguage.docs)).toBe(before);
  });

  test('apply (dryRun=false) writes with source csv_import', async () => {
    const res = await upload(makeApp(), { fields: { dryRun: 'false' } });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(false);
    expect(CustomerLanguage.docs.find((d) => d.customerId === c.zed._id)).toMatchObject({ workspaceId: W1, language: 'en', languageSource: 'csv_import', updatedBy: USER });
    expect(CustomerLanguage.docs.find((d) => d.customerId === c.sara._id)).toMatchObject({ language: 'ar', languageSource: 'inferred' }); // unchanged: same language
  });

  test.each([[undefined], [''], ['true'], ['TRUE'], ['1'], ['yes'], ['maybe'], ['null']])('dryRun=%j is a dry run (a missing or odd value can never write)', async (value) => {
    const fields = value === undefined ? {} : { dryRun: value };
    const res = await upload(makeApp(), { fields });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(CustomerLanguage.docs).toHaveLength(2);
  });

  test.each([['false'], ['FALSE'], ['0'], ['no']])('dryRun=%s applies', async (value) => {
    const res = await upload(makeApp(), { fields: { dryRun: value } });
    expect(res.body.dryRun).toBe(false);
    expect(CustomerLanguage.docs).toHaveLength(3);
  });

  test('a workspaceId field in the multipart form is ignored: the other workspace\'s customers are never matched', async () => {
    const res = await upload(makeApp(), { fields: { dryRun: 'false', workspaceId: W2 }, file: Buffer.from('phone,language\n966500000009,ar\n') });
    expect(res.body.summary).toMatchObject({ rows: 1, unmatched: 1 });
    expect(CustomerLanguage.docs.find((d) => d.customerId === c.theirs2._id)).toBeUndefined();
    expectOnlyWorkspace(W1, W2);
  });

  test('Arabic file in every encoding the browsers/Excel produce', async () => {
    const body = 'رقم الجوال;اللغة\r\n966500000002;عربي\r\n';
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body.replaceAll(';', '\t'), 'utf16le')]);
    for (const [file, encoding] of [[bom, 'utf-8-bom'], [Buffer.from(body, 'utf8'), 'utf-8'], [utf16, 'utf-16le']]) {
      const res = await upload(makeApp(), { file });
      expect(res.status).toBe(200);
      expect(res.body.encoding).toBe(encoding);
      expect(res.body.rows).toEqual([expect.objectContaining({ outcome: 'updated', language: 'عربي' })]);
    }
  });

  test('no file -> 400 FILE_REQUIRED', async () => {
    const res = await upload(makeApp(), { file: null });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code: 'FILE_REQUIRED' });
  });

  test('a file under the wrong field name -> 400 FILE_INVALID', async () => {
    const res = await upload(makeApp(), { field: 'upload' });
    expect(res.status).toBe(400);
    expect(['FILE_INVALID', 'FILE_REQUIRED']).toContain(res.body.code);
  });

  test('wrong file type -> 400 FILE_INVALID', async () => {
    const res = await upload(makeApp(), { name: 'evil.exe', type: 'application/x-msdownload', file: Buffer.from('MZ') });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code: 'FILE_INVALID' });
  });

  test('over 5 MB -> 413 FILE_TOO_LARGE', async () => {
    const res = await upload(makeApp(), { file: Buffer.alloc(5 * 1024 * 1024 + 10, 97) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: expect.any(String), code: 'FILE_TOO_LARGE' });
  });

  test('an .xlsx renamed to .csv -> 400 FILE_INVALID', async () => {
    const res = await upload(makeApp(), { file: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FILE_INVALID');
  });

  test('an empty file -> 400 FILE_INVALID', async () => {
    const res = await upload(makeApp(), { file: Buffer.alloc(0) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FILE_INVALID');
  });

  test('missing columns -> 400 CSV_NO_PHONE_COLUMN / CSV_NO_LANGUAGE_COLUMN', async () => {
    let res = await upload(makeApp(), { file: Buffer.from('name,language\nSara,ar\n') });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code: 'CSV_NO_PHONE_COLUMN' });
    res = await upload(makeApp(), { file: Buffer.from('phone,name\n0500000001,Sara\n') });
    expect(res.body.code).toBe('CSV_NO_LANGUAGE_COLUMN');
  });

  test('more than 50,000 rows -> 413 FILE_TOO_LARGE', async () => {
    const res = await upload(makeApp(), { file: Buffer.from(`phone,language\n${'0500000001,ar\n'.repeat(50001)}`) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });

  test('a body that is not multipart at all -> 400 FILE_REQUIRED', async () => {
    const res = await request(makeApp()).post(`${BASE}/language/import`).send({ file: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FILE_REQUIRED');
  });

  test('importing never creates or changes customers', async () => {
    const before = JSON.stringify(Customer.docs);
    await upload(makeApp(), { fields: { dryRun: 'false' } });
    expect(JSON.stringify(Customer.docs)).toBe(before);
  });
});

describe('CSV downloads', () => {
  test('template.csv', async () => {
    const res = await request(makeApp()).get(`${BASE}/language/template.csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="waflow-customer-languages-template.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text.charCodeAt(0)).toBe(BOM.charCodeAt(0));
    expect(res.text.split('\r\n')[0].slice(1)).toBe('phone,language');
    expect(parseCsv(res.text).rows.map((r) => r.language)).toEqual(['ar', 'en', 'Arabic']);
  });

  test('export.csv: the caller\'s customers only, BOM + CRLF, Arabic intact', async () => {
    const res = await request(makeApp()).get(`${BASE}/language/export.csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="waflow-customer-languages.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const { headers, rows } = parseCsv(res.text);
    expect(headers).toEqual(['name', 'phone', 'language', 'source']);
    expect(rows.map((r) => r.name)).toEqual(['Mona', 'Zed Last', 'سارة أحمد']);
    expect(rows.find((r) => r.name === 'سارة أحمد')).toMatchObject({ phone: '966500000001', language: 'ar', source: 'inferred' });
    expect(res.text).not.toContain('Their');
    expectOnlyWorkspace(W1, W2);
  });

  test('export.csv for the other workspace', async () => {
    const res = await request(makeApp()).get(`${BASE}/language/export.csv`).set('x-test-workspace', W2);
    expect(parseCsv(res.text).rows.map((r) => r.name)).toEqual(['Other Person', 'Their Customer']);
    expect(res.text).not.toContain('سارة');
  });

  test('a failure while exporting is a JSON 500, not a half-sent file', async () => {
    const original = Customer.find;
    Customer.find = () => { throw new Error('boom'); };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(makeApp()).get(`${BASE}/language/export.csv`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Something went wrong' });
    } finally {
      Customer.find = original;
      spy.mockRestore();
    }
  });
});

describe('routing', () => {
  test('routes that do not exist are 404, and verbs are respected', async () => {
    const app = makeApp();
    expect((await request(app).get(`${BASE}/language/nothing`)).status).toBe(404);
    expect((await request(app).delete(`${BASE}/${c.zed._id}/language`)).status).toBe(404);
    expect((await request(app).get(`${BASE}/${c.zed._id}/language`)).status).toBe(404);
    expect((await request(app).post(`${BASE}/language/export.csv`)).status).toBe(404);
  });

  test('nothing in the router can delete: it exposes no DELETE route', () => {
    const router = require('../../routes/localization/customers');
    const verbs = router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods));
    expect(verbs.sort()).toEqual(['get', 'get', 'get', 'post', 'post', 'put']);
  });
});
