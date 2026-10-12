// HTTP tests for /api/localization/catalog: the real router and the real service, with a
// stub auth middleware (workspace and user come from request headers so one app can play
// several tenants) and in-memory model fakes — no database, no network. They prove tenant
// scoping, the allow-listed save body, operator-injection safety, the error contract
// ({error, code} from the closed set, nothing internal leaked) and the CSV endpoints.
// Arabic is written raw; invisible characters are \u{...} escapes.
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { createRouter } = require('../../routes/localization/catalog');
const { createCatalogService, LIMITS } = require('../../shared/localization/catalogTranslations');
const { parseRows } = require('../../shared/localization/csv');

// ── fakes (same query shapes as the service uses; select projections applied) ──
const NOW = new Date('2026-10-11T12:00:00.000Z');
let idCounter = 0;
const oid = () => new mongoose.Types.ObjectId((++idCounter).toString(16).padStart(24, '0'));
const isOid = (v) => v instanceof mongoose.Types.ObjectId;
const same = (a, b) => String(a) === String(b);

function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (cond !== null && typeof cond === 'object' && !isOid(cond) && !(cond instanceof Date)) {
      const [op, ...rest] = Object.keys(cond);
      if (rest.length || !['$in', '$ne'].includes(op)) throw new Error(`fake model: unsupported filter ${key}: ${JSON.stringify(cond)}`);
      return op === '$in' ? cond.$in.some((v) => same(v, doc[key])) : !same(cond.$ne, doc[key]);
    }
    return same(cond, doc[key]);
  });
}

function project(doc, fields) {
  if (!fields) return { ...doc };
  const out = { _id: doc._id };
  for (const field of fields.split(/\s+/).filter(Boolean)) if (field in doc) out[field] = doc[field];
  return out;
}

function query(run) {
  const state = {};
  const q = {
    select(fields) { state.fields = fields; return q; },
    limit(n) { state.limit = n; return q; },
    lean() { return q; },
    then(resolve, reject) { return Promise.resolve().then(() => run(state)).then(resolve, reject); },
  };
  return q;
}

function fakeModel({ rows = [], readOnly = false, defaults = {} } = {}) {
  const docs = rows.map((r) => ({ ...r }));
  const model = { docs, calls: [], hooks: {} };
  const record = (op, filter, extra) => model.calls.push({ op, filter, ...extra });
  const forbidden = (method) => () => { throw new Error(`fake model: forbidden operation ${method}`); };
  for (const m of ['create', 'insertMany', 'updateOne', 'updateMany', 'findByIdAndUpdate', 'replaceOne', 'bulkWrite', 'save',
    'deleteOne', 'deleteMany', 'findOneAndDelete', 'findByIdAndDelete', 'remove', 'drop']) model[m] = forbidden(m);
  model.findOneAndUpdate = forbidden('findOneAndUpdate');

  model.find = (filter) => {
    record('find', filter);
    return query((s) => {
      if (model.hooks.onFind) model.hooks.onFind();
      let out = docs.filter((d) => matches(d, filter));
      if (s.limit !== undefined) out = out.slice(0, s.limit);
      return out.map((d) => project(d, s.fields));
    });
  };
  model.findOne = (filter) => {
    record('findOne', filter);
    return query((s) => {
      const doc = docs.find((d) => matches(d, filter));
      return doc ? project(doc, s.fields) : null;
    });
  };
  model.findById = (id) => model.findOne({ _id: id });

  if (!readOnly) {
    model.findOneAndUpdate = (filter, update, options = {}) => {
      record('findOneAndUpdate', filter, { update, options });
      return query(() => {
        if (model.hooks.beforeUpdate) model.hooks.beforeUpdate();
        let doc = docs.find((d) => matches(d, filter));
        if (!doc) {
          if (!options.upsert) return null;
          const base = {};
          for (const [k, v] of Object.entries(filter)) if (v === null || typeof v !== 'object' || isOid(v)) base[k] = v;
          doc = { _id: oid(), ...defaults, ...base, createdAt: NOW };
          docs.push(doc);
        }
        Object.assign(doc, update.$set || {});
        for (const field of Object.keys(update.$unset || {})) delete doc[field];
        doc.updatedAt = NOW;
        return { ...doc };
      });
    };
  }
  return model;
}

const WS_A = oid();
const WS_B = oid();
const USER_A = oid();
const USER_B = oid();
const BASE = '/api/localization/catalog';

const item = (overrides = {}) => ({ _id: oid(), workspaceId: WS_A, name: 'Item', description: '', category: 'Cat', active: true, ...overrides });
const translation = (kind, refId, overrides = {}) => ({
  _id: oid(), workspaceId: WS_A, kind, refId, language: 'ar', name: 'ترجمة', description: '', status: 'draft', source: 'merchant',
  createdAt: NOW, updatedAt: NOW, ...overrides,
});

function world() {
  const coffee = item({ name: 'Arabic Coffee', category: 'Drinks', description: 'Cardamom coffee' });
  const tea = item({ name: 'Mint Tea', category: 'Drinks', active: false });
  const facial = item({ name: 'Facial', category: 'Spa' });
  const theirs = item({ workspaceId: WS_B, name: 'Their Product' });
  const Product = fakeModel({ rows: [coffee, tea, theirs], readOnly: true });
  const Service = fakeModel({ rows: [facial], readOnly: true });
  const ProductTranslation = fakeModel({
    rows: [translation('service', facial._id, { name: 'عناية', status: 'reviewed', reviewedBy: 'Noura', reviewedAt: NOW })],
    defaults: { language: 'ar', name: '', description: '', status: 'draft', source: 'merchant' },
  });
  const User = fakeModel({
    rows: [{ _id: USER_A, name: 'Noura Al-Harbi' }, { _id: USER_B, name: 'Bader Other-Tenant' }],
    readOnly: true,
  });
  const service = createCatalogService({ Product, Service, ProductTranslation, User, now: () => NOW });
  return { coffee, tea, facial, theirs, Product, Service, ProductTranslation, User, service, app: appWith(service) };
}

// The stub plays requireAuth: x-ws / x-user become req.user. No x-ws = no workspace on the token.
function appWith(service) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const workspaceId = req.get('x-ws');
    if (workspaceId !== undefined) req.user = { id: req.get('x-user'), workspaceId, role: 'owner' };
    next();
  });
  app.use(BASE, createRouter(service));
  return app;
}
const as = (req, workspaceId = WS_A, userId = USER_A) => req.set('x-ws', String(workspaceId)).set('x-user', String(userId));
const call = (w, verb, url, ...rest) => as(request(w.app)[verb](`${BASE}${url}`), ...rest);

const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const expectError = (res, status, code) => {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({ error: expect.any(String), code });
};
const writesTo = (model) => model.calls.filter((c) => c.op === 'findOneAndUpdate');

const lines = (...rows) => rows.join('\r\n');
const bom8 = (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
const upload = (w, buffer, { dryRun, name = 'catalog.csv', type = 'text/csv', workspaceId = WS_A } = {}) => {
  let req = call(w, 'post', '/import', workspaceId);
  if (dryRun !== undefined) req = req.field('dryRun', dryRun);
  return req.attach('file', buffer, { filename: name, contentType: type });
};
const HEADER = 'kind,id,name,category,name_ar,description_ar,status';

// ── GET /items ─────────────────────────────────────────────────────────────
describe('GET /items', () => {
  test('200 with the CatalogList shape, for the caller workspace only', async () => {
    const w = world();
    const res = await call(w, 'get', '/items');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['counts', 'items', 'limit', 'page', 'total']);
    expect(res.body).toMatchObject({ total: 3, page: 1, limit: 50, counts: { missing: 2, draft: 0, reviewed: 1 } });
    expect(res.body.items.map((i) => i.name)).toEqual(['Arabic Coffee', 'Mint Tea', 'Facial']);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(['active', 'category', 'description', 'kind', 'name', 'refId', 'translation']);
    expect(res.body.items[2].translation).toEqual({
      name: 'عناية', description: '', status: 'reviewed', source: 'merchant', reviewedBy: 'Noura', reviewedAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    expect(res.body.items[1].active).toBe(false);
  });

  test('another tenant sees only its own rows (the workspace comes from the token, not the request)', async () => {
    const w = world();
    const theirs = await call(w, 'get', '/items', WS_B);
    expect(theirs.body.items.map((i) => i.name)).toEqual(['Their Product']);
    const spoof = await call(w, 'get', '/items').query({ workspaceId: String(WS_B) }).set('x-workspace-id', String(WS_B));
    expect(spoof.body.items.map((i) => i.name)).toEqual(['Arabic Coffee', 'Mint Tea', 'Facial']);
    for (const model of [w.Product, w.Service, w.ProductTranslation]) {
      for (const c of model.calls) expect([String(WS_A), String(WS_B)]).toContain(String(c.filter.workspaceId));
    }
  });

  test('kind, status, search (Arabic-aware), page and limit come from the query string', async () => {
    const w = world();
    expect((await call(w, 'get', '/items').query({ kind: 'service' })).body.items.map((i) => i.name)).toEqual(['Facial']);
    expect((await call(w, 'get', '/items').query({ status: 'missing' })).body.total).toBe(2);
    expect((await call(w, 'get', '/items').query({ search: 'عنايه' })).body.items.map((i) => i.name)).toEqual(['Facial']);
    const paged = await call(w, 'get', '/items').query({ limit: 1, page: 2 });
    expect(paged.body).toMatchObject({ page: 2, limit: 1, total: 3 });
    expect(paged.body.items.map((i) => i.name)).toEqual(['Mint Tea']);
    expect((await call(w, 'get', '/items').query({ limit: 1000 })).body.limit).toBe(200);
    expect((await call(w, 'get', '/items').query({ limit: 'abc', page: '-4' })).body).toMatchObject({ limit: 50, page: 1 });
  });

  test('bad values are INVALID_INPUT: unknown enum, repeated params, over-long search', async () => {
    const w = world();
    expectError(await call(w, 'get', '/items').query({ kind: 'widget' }), 400, 'INVALID_INPUT');
    expectError(await call(w, 'get', '/items').query({ status: 'approved' }), 400, 'INVALID_INPUT');
    expectError(await call(w, 'get', '/items?kind=product&kind=service'), 400, 'INVALID_INPUT');
    expectError(await call(w, 'get', '/items?search=a&search=b'), 400, 'INVALID_INPUT');
    expectError(await call(w, 'get', '/items').query({ search: 'x'.repeat(LIMITS.searchMax + 1) }), 400, 'INVALID_INPUT');
  });

  test('operator-style query keys are inert: they are not filters, so nothing is bypassed', async () => {
    const w = world();
    const res = await call(w, 'get', '/items?search[$ne]=zzz&kind[$ne]=product&status[$in][]=draft&workspaceId[$ne]=x');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    for (const model of [w.Product, w.Service, w.ProductTranslation]) {
      for (const c of model.calls) expect(JSON.stringify(c.filter)).not.toContain('$ne');
    }
  });

  test('without a workspace on the token: 403 FORBIDDEN and nothing is read', async () => {
    const w = world();
    expectError(await request(w.app).get(`${BASE}/items`), 403, 'FORBIDDEN');
    expectError(await call(w, 'get', '/items', 'not-an-object-id'), 403, 'FORBIDDEN');
    expect(w.Product.calls).toEqual([]);
  });
});

// ── GET /:kind/:refId/translation (product / service form, IM-D) ────────────
describe('GET /:kind/:refId/translation', () => {
  const get = (w, kind, refId, ...rest) => call(w, 'get', `/${kind}/${refId}/translation`, ...rest);

  test('{ translation: view } for an item that has Arabic text, read-only', async () => {
    const w = world();
    const res = await get(w, 'service', w.facial._id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      translation: { name: 'عناية', description: '', status: 'reviewed', source: 'merchant', reviewedBy: 'Noura', reviewedAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
    });
    expect(writesTo(w.ProductTranslation)).toEqual([]);
  });

  test('{ translation: null } for an item without Arabic text', async () => {
    const w = world();
    const res = await get(w, 'product', w.coffee._id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ translation: null });
  });

  test('a stored row with a blank name counts as no translation', async () => {
    const w = world();
    w.ProductTranslation.docs.push({ ...translation('product', w.coffee._id, { name: '  ' }) });
    expect((await get(w, 'product', w.coffee._id)).body).toEqual({ translation: null });
  });

  test("another tenant's item is a 404 ITEM_NOT_FOUND and its translation is never read", async () => {
    const w = world();
    expectError(await get(w, 'product', w.theirs._id), 404, 'ITEM_NOT_FOUND');
    expect(w.ProductTranslation.calls.filter((c) => c.op === 'findOne')).toEqual([]);
    expect((await get(w, 'product', w.theirs._id, WS_B)).status).toBe(200);
  });

  test('the item kind must match: a product id asked as a service is a 404', async () => {
    const w = world();
    expectError(await get(w, 'service', w.coffee._id), 404, 'ITEM_NOT_FOUND');
  });

  test('bad kind / bad id are 400s with codes; no workspace is a 403', async () => {
    const w = world();
    expectError(await get(w, 'widget', w.coffee._id), 400, 'INVALID_INPUT');
    expectError(await get(w, 'product', 'not-an-id'), 400, 'INVALID_ID');
    expectError(await request(w.app).get(`${BASE}/product/${w.coffee._id}/translation`), 403, 'FORBIDDEN');
  });
});

describe('saveImportedDrafts (main import wizard Arabic columns, IM-D)', () => {
  const run = (w, items, workspaceId = WS_A) => w.service.saveImportedDrafts({ workspaceId: String(workspaceId), userId: String(USER_A), items });

  test('creates drafts with source csv; identical text is a no-op; changed text clears a review', async () => {
    const w = world();
    const first = await run(w, [{ kind: 'product', refId: String(w.coffee._id), name: 'قهوة عربية', description: 'بالهيل' }]);
    expect(first).toEqual({ saved: 1, unchanged: 0, failed: 0 });
    expect(w.ProductTranslation.docs.find((d) => same(d.refId, w.coffee._id))).toMatchObject({ name: 'قهوة عربية', description: 'بالهيل', status: 'draft', source: 'csv' });
    expect(await run(w, [{ kind: 'product', refId: String(w.coffee._id), name: 'قهوة عربية', description: 'بالهيل' }])).toEqual({ saved: 0, unchanged: 1, failed: 0 });
    // a reviewed translation keeps its review when the text is identical, and returns to draft when it changes
    expect(await run(w, [{ kind: 'service', refId: String(w.facial._id), name: 'عناية' }])).toEqual({ saved: 0, unchanged: 1, failed: 0 });
    expect(w.ProductTranslation.docs.find((d) => same(d.refId, w.facial._id)).status).toBe('reviewed');
    expect(await run(w, [{ kind: 'service', refId: String(w.facial._id), name: 'عناية بالبشرة' }])).toEqual({ saved: 1, unchanged: 0, failed: 0 });
    expect(w.ProductTranslation.docs.find((d) => same(d.refId, w.facial._id))).toMatchObject({ status: 'draft', name: 'عناية بالبشرة' });
  });

  test("a blank description keeps the stored one; another workspace's item and bad rows are counted as failed, never thrown", async () => {
    const w = world();
    await run(w, [{ kind: 'product', refId: String(w.coffee._id), name: 'قهوة', description: 'وصف' }]);
    await run(w, [{ kind: 'product', refId: String(w.coffee._id), name: 'قهوة 2', description: '' }]);
    expect(w.ProductTranslation.docs.find((d) => same(d.refId, w.coffee._id))).toMatchObject({ name: 'قهوة 2', description: 'وصف' });
    const result = await run(w, [
      { kind: 'product', refId: String(w.theirs._id), name: 'ليس لك' }, // another workspace's item
      { kind: 'product', refId: 'bogus', name: 'x' },
      { kind: 'widget', refId: String(w.coffee._id), name: 'x' },
      { kind: 'product', refId: String(w.tea._id), name: '   ' },
      null,
    ]);
    expect(result).toEqual({ saved: 0, unchanged: 0, failed: 4 });
    expect(w.ProductTranslation.docs.some((d) => d.name === 'ليس لك')).toBe(false);
  });

  test('the first entry for an item wins; Latin text, emoji and Arabic-Indic digits are stored as typed', async () => {
    const w = world();
    const typed = 'قهوة \u{2615} Special \u{0661}\u{0662}\u{0663}';
    const result = await run(w, [
      { kind: 'product', refId: String(w.coffee._id), name: typed },
      { kind: 'product', refId: String(w.coffee._id), name: 'second' },
    ]);
    expect(result.saved).toBe(1);
    expect(w.ProductTranslation.docs.find((d) => same(d.refId, w.coffee._id)).name).toBe(typed);
  });

  test('no workspace is refused; empty input writes nothing', async () => {
    const w = world();
    await expect(w.service.saveImportedDrafts({ workspaceId: undefined, items: [] })).rejects.toMatchObject({ status: 403 });
    expect(await run(w, [])).toEqual({ saved: 0, unchanged: 0, failed: 0 });
    expect(writesTo(w.ProductTranslation)).toEqual([]);
  });
});

// ── PUT /:kind/:refId/translation ──────────────────────────────────────────
describe('PUT /:kind/:refId/translation', () => {
  const put = (w, kind, refId, body, ...rest) => call(w, 'put', `/${kind}/${refId}/translation`, ...rest).send(body);

  test('200 + CatalogTranslation: a draft, text exactly as typed, workspace and user from the token', async () => {
    const w = world();
    const res = await put(w, 'product', w.coffee._id, { name: 'قَهْوَة عربية ٣٠٠', description: 'سطر 1\nسطر 2' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: 'قَهْوَة عربية ٣٠٠', description: 'سطر 1\nسطر 2', status: 'draft', source: 'merchant', reviewedBy: null, reviewedAt: null, updatedAt: NOW.toISOString(),
    });
    const saved = w.ProductTranslation.docs.find((d) => same(d.refId, w.coffee._id));
    expect(saved).toMatchObject({ kind: 'product', language: 'ar', status: 'draft' });
    expect(String(saved.workspaceId)).toBe(String(WS_A));
    expect(String(saved.updatedBy)).toBe(String(USER_A));
  });

  test('only name, description and source are read from the body — status, reviewer, workspace, kind, id and language are not', async () => {
    const w = world();
    const res = await put(w, 'product', w.coffee._id, {
      name: 'قهوة', description: 'وصف', source: 'ai',
      status: 'reviewed', reviewedBy: 'Mallory', reviewedAt: '2020-01-01T00:00:00Z', workspaceId: String(WS_B), kind: 'service',
      refId: String(w.facial._id), language: 'en', _id: String(oid()), updatedBy: String(USER_B), createdAt: '1999-01-01',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'draft', source: 'ai', reviewedBy: null, reviewedAt: null });
    const saved = w.ProductTranslation.docs.find((d) => d.name === 'قهوة');
    expect(String(saved.workspaceId)).toBe(String(WS_A));
    expect(saved.kind).toBe('product');
    expect(String(saved.refId)).toBe(String(w.coffee._id));
    expect(saved.language).toBe('ar');
    expect(saved.status).toBe('draft');
    expect(saved).not.toHaveProperty('reviewedBy');
    expect(String(saved.updatedBy)).toBe(String(USER_A));
  });

  test('prototype-pollution keys in a raw JSON body are not read and do not pollute anything', async () => {
    const w = world();
    const raw = '{"name":"قهوة","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"source":"ai"}';
    const res = await call(w, 'put', `/product/${w.coffee._id}/translation`).set('Content-Type', 'application/json').send(raw);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'قهوة', source: 'ai', status: 'draft' });
    expect(({}).polluted).toBeUndefined();
    expect(w.ProductTranslation.docs.find((d) => d.name === 'قهوة')).not.toHaveProperty('polluted');
  });

  test('an AI-labelled save is a draft; a reviewed translation edited through the API drops back to draft', async () => {
    const w = world();
    const res = await put(w, 'service', w.facial._id, { name: 'جلسة عناية', source: 'ai' });
    expect(res.body).toMatchObject({ status: 'draft', source: 'ai', reviewedBy: null, reviewedAt: null });
    const again = await put(w, 'service', w.facial._id, { name: 'جلسة عناية', source: 'merchant' });
    expect(again.body.status).toBe('draft');
  });

  test('saving identical text through the API keeps a reviewed translation reviewed', async () => {
    const w = world();
    const res = await put(w, 'service', w.facial._id, { name: 'عناية', description: '' });
    expect(res.body).toMatchObject({ status: 'reviewed', reviewedBy: 'Noura' });
    expect(writesTo(w.ProductTranslation)).toHaveLength(0);
  });

  test('another tenant\'s item, an unknown id or the wrong kind is 404 ITEM_NOT_FOUND and nothing is written', async () => {
    const w = world();
    expectError(await put(w, 'product', w.theirs._id, { name: 'x' }), 404, 'ITEM_NOT_FOUND');
    expectError(await put(w, 'product', w.coffee._id, { name: 'x' }, WS_B, USER_B), 404, 'ITEM_NOT_FOUND');
    expectError(await put(w, 'product', oid(), { name: 'x' }), 404, 'ITEM_NOT_FOUND');
    expectError(await put(w, 'service', w.coffee._id, { name: 'x' }), 404, 'ITEM_NOT_FOUND');
    expect(writesTo(w.ProductTranslation)).toHaveLength(0);
    expect(w.ProductTranslation.docs).toHaveLength(1);
  });

  test.each([
    ['no body at all', undefined],
    ['an empty object', {}],
    ['an array body', [{ name: 'x' }]],
    ['a blank name', { name: '' }],
    ['a whitespace name', { name: '   \n' }],
    ['an invisible-only name', { name: '\u{200B}\u{200F}' }],
    ['a null name', { name: null }],
  ])('%s is 400 TRANSLATION_NAME_REQUIRED', async (label, body) => {
    const w = world();
    const req = call(w, 'put', `/product/${w.coffee._id}/translation`);
    expectError(await (body === undefined ? req : req.send(body)), 400, 'TRANSLATION_NAME_REQUIRED');
    expect(writesTo(w.ProductTranslation)).toHaveLength(0);
  });

  test.each([
    ['operator object as name', { name: { $ne: null } }],
    ['number as name', { name: 7 }],
    ['array as name', { name: ['قهوة'] }],
    ['operator object as description', { name: 'قهوة', description: { $gt: '' } }],
    ['operator object as source', { name: 'قهوة', source: { $ne: 'ai' } }],
    ['csv as source (API callers cannot claim an import)', { name: 'قهوة', source: 'csv' }],
    ['unknown source', { name: 'قهوة', source: 'robot' }],
    ['name over the cap', { name: 'ا'.repeat(LIMITS.nameMax + 1) }],
    ['description over the cap', { name: 'قهوة', description: 'ا'.repeat(LIMITS.descriptionMax + 1) }],
  ])('%s is 400 INVALID_INPUT', async (label, body) => {
    const w = world();
    expectError(await put(w, 'product', w.coffee._id, body), 400, 'INVALID_INPUT');
    expect(writesTo(w.ProductTranslation)).toHaveLength(0);
    for (const c of w.Product.calls) expect(JSON.stringify(c.filter)).not.toContain('$ne');
  });

  test('a malformed id in the path is 400 INVALID_ID before any query; an unknown kind is 400 INVALID_INPUT', async () => {
    const w = world();
    expectError(await put(w, 'product', 'not-an-id', { name: 'x' }), 400, 'INVALID_ID');
    expectError(await put(w, 'product', encodeURIComponent('{"$ne":null}'), { name: 'x' }), 400, 'INVALID_ID');
    expectError(await put(w, 'product', `${w.coffee._id}00`, { name: 'x' }), 400, 'INVALID_ID');
    expectError(await put(w, 'Product', w.coffee._id, { name: 'x' }), 400, 'INVALID_INPUT');
    expectError(await put(w, 'all', w.coffee._id, { name: 'x' }), 400, 'INVALID_INPUT');
    expect(w.Product.calls).toEqual([]);
    expect(w.Service.calls).toEqual([]);
  });

  test('without a workspace on the token: 403 FORBIDDEN', async () => {
    const w = world();
    const res = await request(w.app).put(`${BASE}/product/${w.coffee._id}/translation`).send({ name: 'x' });
    expectError(res, 403, 'FORBIDDEN');
  });

  test('the existing product and service models are never written through this route', async () => {
    const w = world();
    await put(w, 'product', w.coffee._id, { name: 'قهوة' });
    await put(w, 'service', w.facial._id, { name: 'عناية بالبشرة' });
    for (const model of [w.Product, w.Service]) expect(model.calls.every((c) => c.op === 'find' || c.op === 'findOne')).toBe(true);
  });
});

// ── POST /:kind/:refId/translation/review ──────────────────────────────────
describe('POST /:kind/:refId/translation/review', () => {
  const review = (w, kind, refId, body, ...rest) => call(w, 'post', `/${kind}/${refId}/translation/review`, ...rest).send(body);

  test('marks a draft reviewed by the signed-in user (name looked up), then back to draft', async () => {
    const w = world();
    await call(w, 'put', `/product/${w.coffee._id}/translation`).send({ name: 'قهوة عربية' });
    const done = await review(w, 'product', w.coffee._id, { status: 'reviewed' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ name: 'قهوة عربية', status: 'reviewed', reviewedBy: 'Noura Al-Harbi', reviewedAt: NOW.toISOString() });
    const back = await review(w, 'product', w.coffee._id, { status: 'draft' });
    expect(back.body).toMatchObject({ status: 'draft', reviewedBy: null, reviewedAt: null });
  });

  test('a second reviewer does not replace the first; the text is never changed', async () => {
    const w = world();
    const res = await review(w, 'service', w.facial._id, { status: 'reviewed' }, WS_A, USER_B);
    expect(res.body).toMatchObject({ name: 'عناية', status: 'reviewed', reviewedBy: 'Noura' });
  });

  test('404 NOT_FOUND when the item has no translation, 404 ITEM_NOT_FOUND for other tenants and unknown ids', async () => {
    const w = world();
    expectError(await review(w, 'product', w.coffee._id, { status: 'reviewed' }), 404, 'NOT_FOUND');
    expectError(await review(w, 'product', w.theirs._id, { status: 'reviewed' }), 404, 'ITEM_NOT_FOUND');
    expectError(await review(w, 'product', w.coffee._id, { status: 'reviewed' }, WS_B, USER_B), 404, 'ITEM_NOT_FOUND');
    expectError(await review(w, 'product', oid(), { status: 'reviewed' }), 404, 'ITEM_NOT_FOUND');
    expect(w.ProductTranslation.docs).toHaveLength(1);
  });

  test.each([
    ['missing status', {}],
    ['unknown status', { status: 'approved' }],
    ['operator object', { status: { $ne: 'draft' } }],
    ['array', { status: ['reviewed'] }],
  ])('%s is 400 INVALID_INPUT', async (label, body) => {
    const w = world();
    expectError(await review(w, 'service', w.facial._id, body), 400, 'INVALID_INPUT');
    expect(writesTo(w.ProductTranslation)).toHaveLength(0);
  });

  test('bad ids and kinds are rejected; body fields other than status are ignored', async () => {
    const w = world();
    expectError(await review(w, 'service', 'nope', { status: 'reviewed' }), 400, 'INVALID_ID');
    expectError(await review(w, 'widget', w.facial._id, { status: 'reviewed' }), 400, 'INVALID_INPUT');
    const res = await review(w, 'service', w.facial._id, { status: 'draft', reviewedBy: 'Mallory', name: 'مزور', workspaceId: String(WS_B) });
    expect(res.body).toMatchObject({ name: 'عناية', status: 'draft' });
  });
});

// ── GET /export.csv ────────────────────────────────────────────────────────
describe('GET /export.csv', () => {
  test('a downloadable UTF-8 CSV with BOM and CRLF, this workspace only, Arabic intact', async () => {
    const w = world();
    await call(w, 'put', `/product/${w.coffee._id}/translation`).send({ name: 'قَهْوة, "عربية"', description: 'سطر 1\nسطر 2' });
    const res = await call(w, 'get', '/export.csv').buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv;\s*charset=utf-8$/i);
    expect(res.headers['content-disposition']).toBe('attachment; filename="catalog-arabic-names.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body;
    expect(Array.from(body.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = body.toString('utf8');
    expect(text.endsWith('\r\n')).toBe(true);
    const grid = parseRows(text);
    expect(grid[0]).toEqual(['kind', 'id', 'name', 'category', 'name_ar', 'description_ar', 'status']);
    const coffeeRow = grid.find((r) => r[2] === 'Arabic Coffee');
    expect(coffeeRow).toEqual(['product', String(w.coffee._id), 'Arabic Coffee', 'Drinks', 'قَهْوة, "عربية"', 'سطر 1\nسطر 2', 'draft']);
    expect(grid.flat()).not.toContain('Their Product');
    expect(grid).toHaveLength(4);
  });

  test('another tenant gets its own catalogue; no workspace is 403', async () => {
    const w = world();
    const theirs = await call(w, 'get', '/export.csv', WS_B).buffer(true).parse(binaryParser);
    expect(parseRows(theirs.body.toString('utf8')).map((r) => r[2])).toEqual(['name', 'Their Product']);
    expectError(await request(w.app).get(`${BASE}/export.csv`), 403, 'FORBIDDEN');
  });

  test('the export is not shadowed by the :kind/:refId routes and is only a GET', async () => {
    const w = world();
    expect((await call(w, 'get', '/export.csv')).status).toBe(200);
    expect((await call(w, 'post', '/export.csv')).status).toBe(404);
  });
});

// ── POST /import ───────────────────────────────────────────────────────────
describe('POST /import', () => {
  const sheet = (w) => bom8(lines(HEADER, `product,${w.coffee._id},Arabic Coffee,Drinks,قهوة عربية,وصف,`, `service,${w.facial._id},Facial,Spa,جلسة عناية,,`, 'product,,No Such,,x,,'));

  test('dryRun=true previews: the CatalogImportResult shape, nothing written', async () => {
    const w = world();
    const res = await upload(w, sheet(w), { dryRun: 'true' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['dryRun', 'encoding', 'rows', 'summary', 'truncated']);
    expect(res.body).toMatchObject({ dryRun: true, encoding: 'utf-8-bom', truncated: false });
    expect(res.body.summary).toEqual({ rows: 3, updated: 2, unchanged: 0, unmatched: 1, invalid: 0 });
    expect(res.body.rows).toEqual([
      { line: 2, name: 'Arabic Coffee', outcome: 'updated' },
      { line: 3, name: 'Facial', outcome: 'updated' },
      { line: 4, name: 'No Such', outcome: 'unmatched' },
    ]);
    expect(writesTo(w.ProductTranslation)).toHaveLength(0);
    expect(w.ProductTranslation.docs).toHaveLength(1);
  });

  test('dryRun=false applies: drafts with source csv, attributed to the signed-in user', async () => {
    const w = world();
    const res = await upload(w, sheet(w), { dryRun: 'false' });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(false);
    expect(res.body.summary).toEqual({ rows: 3, updated: 2, unchanged: 0, unmatched: 1, invalid: 0 });
    const coffee = w.ProductTranslation.docs.find((d) => same(d.refId, w.coffee._id));
    expect(coffee).toMatchObject({ name: 'قهوة عربية', description: 'وصف', status: 'draft', source: 'csv' });
    expect(String(coffee.updatedBy)).toBe(String(USER_A));
    const facial = w.ProductTranslation.docs.find((d) => same(d.refId, w.facial._id));
    expect(facial).toMatchObject({ name: 'جلسة عناية', status: 'draft' }); // the reviewed one changed, so it is a draft again
    expect(facial).not.toHaveProperty('reviewedBy');
  });

  test.each([[undefined], ['maybe'], [''], ['true'], ['TRUE'], ['1'], ['yes']])('dryRun=%j is only a preview', async (dryRun) => {
    const w = world();
    const res = await upload(w, sheet(w), { dryRun });
    expect(res.body.dryRun).toBe(true);
    expect(writesTo(w.ProductTranslation)).toHaveLength(0);
  });

  test.each([['false'], ['FALSE'], ['0'], ['no'], [' False ']])('dryRun=%j applies the file', async (dryRun) => {
    const w = world();
    const res = await upload(w, sheet(w), { dryRun });
    expect(res.body.dryRun).toBe(false);
    expect(res.body.summary.updated).toBe(2);
  });

  test('Excel-era encodings are decoded: windows-1256 and UTF-16LE', async () => {
    const w = world();
    // "قهوة" in windows-1256: 0xDE 0xE5 0xE6 0xC9
    const win = Buffer.concat([Buffer.from(`name,name_ar\nArabic Coffee,`, 'latin1'), Buffer.from([0xde, 0xe5, 0xe6, 0xc9])]);
    const a = await upload(w, win, { dryRun: 'false' });
    expect(a.body.encoding).toBe('windows-1256');
    expect(w.ProductTranslation.docs.find((d) => same(d.refId, w.coffee._id)).name).toBe('قهوة');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('name\tname_ar\nFacial\tجلسة عناية', 'utf16le')]);
    const b = await upload(w, utf16, { dryRun: 'false' });
    expect(b.body.encoding).toBe('utf-16le');
    expect(w.ProductTranslation.docs.find((d) => same(d.refId, w.facial._id)).name).toBe('جلسة عناية');
  });

  test('ids that belong to another tenant never match, whoever uploads', async () => {
    const w = world();
    const mine = await upload(w, bom8(lines(HEADER, `product,${w.theirs._id},Their Product,,اسم,,`)), { dryRun: 'false' });
    expect(mine.body.summary).toMatchObject({ updated: 0, unmatched: 1 });
    const theirs = await upload(w, bom8(lines(HEADER, `product,${w.coffee._id},Arabic Coffee,,اسم,,`)), { dryRun: 'false', workspaceId: WS_B });
    expect(theirs.body.summary).toMatchObject({ updated: 0, unmatched: 1 });
    expect(w.ProductTranslation.docs).toHaveLength(1);
  });

  test('file problems carry a code from the closed set', async () => {
    const w = world();
    expectError(await call(w, 'post', '/import').field('dryRun', 'true'), 400, 'FILE_REQUIRED');
    expectError(await upload(w, Buffer.from('MZ'), { name: 'evil.exe', type: 'application/x-msdownload' }), 400, 'FILE_INVALID');
    expectError(await upload(w, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), { name: 'sheet.csv' }), 400, 'FILE_INVALID');
    expectError(await upload(w, bom8('kind,id,name\r\nproduct,,Facial')), 400, 'FILE_INVALID');          // no name_ar column
    expectError(await upload(w, bom8('name_ar\r\nقهوة')), 400, 'FILE_INVALID');                            // no id/name column
    expectError(await upload(w, bom8('name,name_ar\r\nFacial,"unterminated')), 400, 'FILE_INVALID');
    expectError(await upload(w, Buffer.alloc(5 * 1024 * 1024 + 10, 97)), 413, 'FILE_TOO_LARGE');
    expect(writesTo(w.ProductTranslation)).toHaveLength(0);
  });

  test('a second applying import while one is running is 429 RATE_LIMITED; a preview is not', async () => {
    const w = world();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let blocked = true;
    const originalFind = w.Product.find;
    w.Product.find = (filter) => {
      const q = originalFind(filter);
      const then = q.then.bind(q);
      q.then = (res, rej) => (blocked ? gate.then(() => then(res, rej)) : then(res, rej));
      return q;
    };
    const first = upload(w, sheet(w), { dryRun: 'false' }).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expectError(await upload(w, sheet(w), { dryRun: 'false' }), 429, 'RATE_LIMITED');
    blocked = false;
    expect((await upload(w, sheet(w), { dryRun: 'true' })).status).toBe(200);
    release();
    expect((await first).status).toBe(200);
  });
});

// ── error contract ─────────────────────────────────────────────────────────
describe('error contract', () => {
  test('an unexpected failure is a generic 500 INTERNAL: no message, stack, connection string or driver code leaks', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const w = world();
      w.Product.hooks.onFind = () => { throw new Error('connect ECONNREFUSED mongodb://admin:hunter2@cosmos.example:10255'); };
      const res = await call(w, 'get', '/items');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Something went wrong', code: 'INTERNAL' });
      expect(JSON.stringify(res.body)).not.toMatch(/hunter2|ECONNREFUSED|stack|at /);
      expect(spy).toHaveBeenCalled(); // the real cause is logged server-side
      expect(spy.mock.calls.flat().join(' ')).toContain('ECONNREFUSED');

      const w2 = world();
      w2.ProductTranslation.hooks.beforeUpdate = () => { throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); };
      const dup = await call(w2, 'put', `/product/${w2.coffee._id}/translation`).send({ name: 'قهوة' });
      expect(dup.status).toBe(500);
      expect(dup.body).toEqual({ error: 'Something went wrong', code: 'INTERNAL' });
    } finally {
      spy.mockRestore();
    }
  });

  test('thrown errors keep their status and code; a missing code is filled in from the status', async () => {
    const boom = (err) => appWith({ listItems: async () => { throw err; } });
    const get = (app) => request(app).get(`${BASE}/items`).set('x-ws', String(WS_A));
    const status = async (err) => get(boom(err));
    expect((await status(Object.assign(new Error('nope'), { status: 404, code: 'ITEM_NOT_FOUND' }))).body).toEqual({ error: 'nope', code: 'ITEM_NOT_FOUND' });
    expect((await status(Object.assign(new Error('bad'), { status: 400 }))).body).toEqual({ error: 'bad', code: 'INVALID_INPUT' });
    expect((await status(Object.assign(new Error('missing'), { status: 404 }))).body).toEqual({ error: 'missing', code: 'NOT_FOUND' });
    expect((await status(Object.assign(new Error('slow down'), { status: 429 }))).body).toEqual({ error: 'slow down', code: 'RATE_LIMITED' });
    expect((await status(Object.assign(new Error('big'), { status: 413 }))).body).toEqual({ error: 'big', code: 'FILE_TOO_LARGE' });
    expect((await status(Object.assign(new Error('who'), { status: 403 }))).body).toEqual({ error: 'who', code: 'FORBIDDEN' });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const odd = await status(Object.assign(new Error('weird'), { status: 'teapot', code: 42 }));
      expect(odd.status).toBe(500);
      expect(odd.body).toEqual({ error: 'Something went wrong', code: 'INTERNAL' });
    } finally {
      spy.mockRestore();
    }
  });
});

// ── wiring ─────────────────────────────────────────────────────────────────
describe('wiring', () => {
  test('the default export is a router that routes.localization mounts behind the Arabic gate', () => {
    const catalogRouter = require('../../routes/localization/catalog');
    expect(typeof catalogRouter).toBe('function');
    expect(typeof catalogRouter.createRouter).toBe('function');
    const index = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'localization', 'index.js'), 'utf8');
    expect(index).toMatch(/['"]\/catalog['"][^;\n]*requireArabicEnabled[^;\n]*require\(['"]\.\/catalog['"]\)/);
  });

  test('the router declares exactly the five contract endpoints plus the single-item lookup (IM-D)', () => {
    const routes = createRouter(createCatalogService({})).stack
      .filter((layer) => layer.route)
      .map((layer) => `${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`);
    expect(routes).toEqual([
      'GET /items',
      'GET /export.csv',
      'POST /import',
      'GET /:kind/:refId/translation',
      'PUT /:kind/:refId/translation',
      'POST /:kind/:refId/translation/review',
    ]);
  });
});
