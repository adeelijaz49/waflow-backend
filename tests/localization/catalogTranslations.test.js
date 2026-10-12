// Unit tests for the Arabic product/service name service. Every collaborator is a small
// in-memory fake (no database, no network): the fakes understand only the query shapes the
// service really uses, apply `select` projections like MongoDB does, and the Product/Service/
// User fakes THROW on any write so "read-only on the existing models" is proven, not assumed.
// Arabic is written raw; invisible characters are \u{...} escapes (see sourceHygiene.test.js).
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const catalogModule = require('../../shared/localization/catalogTranslations');
const { createCatalogService, cleanName, cleanDescription, LIMITS } = catalogModule;
const { parseCsv, parseRows, stringifyCsv, BOM } = require('../../shared/localization/csv');

// ── fakes ──────────────────────────────────────────────────────────────────
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

const WRITE_METHODS = ['create', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'replaceOne', 'bulkWrite', 'save'];
const DELETE_METHODS = ['deleteOne', 'deleteMany', 'findOneAndDelete', 'findByIdAndDelete', 'remove', 'drop'];
const TRANSLATION_DEFAULTS = { language: 'ar', name: '', description: '', status: 'draft', source: 'merchant' };

// readOnly: any write/delete throws. Otherwise only findOneAndUpdate (the one write the
// service is allowed to make) works; deletes always throw.
function fakeModel({ rows = [], readOnly = false, defaults = {} } = {}) {
  const docs = rows.map((r) => ({ ...r }));
  const model = { docs, calls: [], hooks: {}, writes: 0 };
  const record = (op, filter, extra) => model.calls.push({ op, filter, ...extra });
  const forbidden = (method) => () => { throw new Error(`fake model: forbidden operation ${method}`); };
  for (const m of DELETE_METHODS) model[m] = forbidden(m);
  for (const m of WRITE_METHODS) model[m] = forbidden(m);

  model.find = (filter) => {
    record('find', filter);
    return query((s) => {
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
      return query(async () => {
        model.writes += 1;
        if (model.hooks.beforeUpdate) await model.hooks.beforeUpdate(model.writes, model);
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

const dupKey = () => Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });

const WS_A = oid();
const WS_B = oid();
const USER_ID = oid();
const ws = String(WS_A);

const item = (overrides = {}) => ({ _id: oid(), workspaceId: WS_A, name: 'Item', description: '', category: 'Cat', active: true, ...overrides });
const translation = (kind, refId, overrides = {}) => ({
  _id: oid(), workspaceId: WS_A, kind, refId, language: 'ar', name: 'ترجمة', description: '', status: 'draft', source: 'merchant',
  createdAt: NOW, updatedAt: NOW, ...overrides,
});

function build(seed = {}) {
  const Product = fakeModel({ rows: seed.products, readOnly: true });
  const Service = fakeModel({ rows: seed.services, readOnly: true });
  const ProductTranslation = fakeModel({ rows: seed.translations, defaults: TRANSLATION_DEFAULTS });
  const User = fakeModel({ rows: seed.users, readOnly: true });
  const svc = createCatalogService({ Product, Service, ProductTranslation, User, now: () => NOW });
  return { svc, Product, Service, ProductTranslation, User };
}

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to be rejected');
}
async function expectError(promise, status, code) {
  const err = await failure(promise);
  expect({ status: err.status, code: err.code }).toEqual({ status, code });
  return err;
}
const writesTo = (model) => model.calls.filter((c) => c.op === 'findOneAndUpdate');
const noQueries = (...models) => models.forEach((m) => expect(m.calls).toEqual([]));

const bytes = (text) => Buffer.from(text, 'utf8');
const bom8 = (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(text)]);
const lines = (...rows) => rows.join('\r\n');

// windows-1256 has no encoder in Node: invert the decoder's table (letters only — Excel
// writes "?" for characters the code page lacks, e.g. Arabic-Indic digits).
function encodeWin1256(text) {
  const decoder = new TextDecoder('windows-1256');
  const table = new Map();
  for (let b = 0; b < 256; b += 1) table.set(decoder.decode(Uint8Array.of(b)), b);
  return Buffer.from(Array.from(text, (ch) => {
    if (!table.has(ch)) throw new Error(`not in windows-1256: ${ch}`);
    return table.get(ch);
  }));
}

// ── text hygiene ───────────────────────────────────────────────────────────
describe('cleanName / cleanDescription', () => {
  test.each([
    ['zero-width space', 'قهوة\u{200B}عربية', 'قهوةعربية'],
    ['LRM / RLM marks', '\u{200E}قهوة\u{200F}', 'قهوة'],
    ['bidi embeddings and overrides', '\u{202A}a\u{202B}b\u{202C}c\u{202D}d\u{202E}e', 'abcde'],
    ['bidi isolates', '\u{2066}a\u{2067}b\u{2068}c\u{2069}', 'abc'],
    ['BOM / zero-width no-break space', '\u{FEFF}قهوة', 'قهوة'],
    ['soft hyphen, word joiner, Arabic letter mark', 'a\u{00AD}b\u{2060}c\u{061C}d', 'abcd'],
    ['zero-width non-joiner and joiner between letters', 'a\u{200C}b\u{200D}c', 'abc'],
    ['C0 controls and DEL', 'a\u{0001}b\u{0007}c\u{007F}d', 'abcd'],
    ['C1 controls', 'a\u{0090}b\u{009F}c', 'abc'],
  ])('both strip %s', (label, input, expected) => {
    expect(cleanName(input)).toBe(expected);
    expect(cleanDescription(input)).toBe(expected);
  });

  test('a name is one line: breaks and tabs become a single space', () => {
    expect(cleanName('قهوة\r\nعربية')).toBe('قهوة عربية');
    expect(cleanName('a\n\n\tb')).toBe('a b');
    expect(cleanName('a\u{2028}b\u{2029}c\u{0085}d')).toBe('a b c d');
  });

  test('a description keeps its paragraphs: every break style becomes \\n, tabs become spaces', () => {
    expect(cleanDescription('a\r\nb\rc\nd\u{2028}e\u{2029}f\u{0085}g')).toBe('a\nb\nc\nd\ne\nf\ng');
    expect(cleanDescription('a\tb')).toBe('a b');
    expect(cleanDescription('\n\n  line one\n\nline two  \n')).toBe('line one\n\nline two');
  });

  test('nothing else is normalised: diacritics, tatweel, alef forms, Arabic-Indic digits, spacing, Latin mix', () => {
    const exact = 'قَهْوَة ـ أحمد إبراهيم آل  كوب ٣٠٠ مل (Nike®) – 50%';
    expect(cleanName(exact)).toBe(exact);
    expect(cleanDescription(exact)).toBe(exact);
    expect(cleanName('a\u{00A0}b')).toBe('a\u{00A0}b');
  });

  test('a zero-width joiner that holds an emoji sequence together survives; stray ones do not', () => {
    const chef = '\u{1F469}\u{200D}\u{1F373}';
    expect(cleanName(`${chef} درس طبخ`)).toBe(`${chef} درس طبخ`);
    const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
    expect(cleanName(family)).toBe(family);
    const heartOnFire = '\u{2764}\u{FE0F}\u{200D}\u{1F525}';
    expect(cleanName(heartOnFire)).toBe(heartOnFire);
    expect(cleanName(`${chef}\u{200B}x\u{200D}y`)).toBe(`${chef}xy`);
  });

  test('trims the ends and is idempotent', () => {
    const messy = '  \u{200F}قهوة\u{200B}  \n';
    expect(cleanName(messy)).toBe('قهوة');
    expect(cleanName(cleanName(messy))).toBe('قهوة');
    expect(cleanDescription(cleanDescription(messy))).toBe(cleanDescription(messy));
  });
});

// ── list ───────────────────────────────────────────────────────────────────
describe('listItems', () => {
  function catalogue() {
    const coffee = item({ name: 'Arabic Coffee', category: 'Drinks', description: 'Cardamom coffee' });
    const tea = item({ name: 'Mint Tea', category: 'Drinks', active: false });
    const shirt = item({ name: 'قميص أبيض', category: 'ملابس' });
    const facial = item({ name: 'Facial', category: 'Spa' });
    const cut = item({ name: 'Hair Cut', category: 'Salon' });
    const otherTenant = item({ workspaceId: WS_B, name: 'Other Tenant Item' });
    return {
      coffee, tea, shirt, facial, cut, otherTenant,
      seed: {
        products: [coffee, tea, shirt, otherTenant],
        services: [facial, cut],
        translations: [
          translation('product', coffee._id, { name: 'قهوة عربية', description: 'قهوة بالهيل', status: 'reviewed', reviewedBy: 'Noura', reviewedAt: NOW }),
          translation('service', facial._id, { name: 'جلسة عناية بالبشرة' }),
          translation('product', tea._id, { name: '   ' }), // blank name = no usable translation
          translation('product', otherTenant._id, { workspaceId: WS_B, name: 'عنصر', status: 'reviewed' }),
        ],
      },
    };
  }

  test('joins products and services (active or not) with their translation, for this workspace only', async () => {
    const c = catalogue();
    const { svc } = build(c.seed);
    const res = await svc.listItems({ workspaceId: ws });
    expect(res.total).toBe(5);
    expect(res.page).toBe(1);
    expect(res.limit).toBe(50);
    expect(res.items.map((i) => i.name)).toEqual(['Arabic Coffee', 'Mint Tea', 'قميص أبيض', 'Facial', 'Hair Cut']);

    const coffeeRow = res.items[0];
    expect(coffeeRow).toEqual({
      kind: 'product', refId: String(c.coffee._id), name: 'Arabic Coffee', description: 'Cardamom coffee', category: 'Drinks', active: true,
      translation: {
        name: 'قهوة عربية', description: 'قهوة بالهيل', status: 'reviewed', source: 'merchant', reviewedBy: 'Noura',
        reviewedAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      },
    });
    const tea = res.items.find((i) => i.name === 'Mint Tea');
    expect(tea.active).toBe(false);
    expect(tea.translation).toBeNull(); // a blank-name row is not a translation
    expect(res.items.find((i) => i.name === 'Facial').translation.reviewedBy).toBeNull();
    expect(res.items.some((i) => i.name === 'Other Tenant Item')).toBe(false);
  });

  test('counts cover the whole catalogue and never change with kind, status, search or paging', async () => {
    const { svc } = build(catalogue().seed);
    const base = await svc.listItems({ workspaceId: ws });
    expect(base.counts).toEqual({ missing: 3, draft: 1, reviewed: 1 });
    for (const filters of [{ kind: 'service' }, { status: 'draft' }, { search: 'coffee' }, { limit: 1, page: 3 }, { status: 'missing', kind: 'product', search: 'zzz' }]) {
      expect((await svc.listItems({ workspaceId: ws, ...filters })).counts).toEqual(base.counts);
    }
  });

  test('kind and status filters', async () => {
    const { svc } = build(catalogue().seed);
    const names = async (filters) => (await svc.listItems({ workspaceId: ws, ...filters })).items.map((i) => i.name);
    expect(await names({ kind: 'service' })).toEqual(['Facial', 'Hair Cut']);
    expect(await names({ kind: 'product' })).toEqual(['Arabic Coffee', 'Mint Tea', 'قميص أبيض']);
    expect(await names({ kind: 'all' })).toHaveLength(5);
    expect(await names({ status: 'missing' })).toEqual(['Mint Tea', 'قميص أبيض', 'Hair Cut']);
    expect(await names({ status: 'draft' })).toEqual(['Facial']);
    expect(await names({ status: 'reviewed' })).toEqual(['Arabic Coffee']);
    expect(await names({ status: 'missing', kind: 'service' })).toEqual(['Hair Cut']);
    expect(await names({ status: 'all' })).toHaveLength(5);
  });

  test('products come before services, then natural name order; ties break on id so paging is stable', async () => {
    const a = item({ name: 'Item 10' });
    const b = item({ name: 'Item 2' });
    const c = item({ name: 'item 2' });
    const s = item({ name: 'AAA service' });
    const { svc } = build({ products: [a, b, c], services: [s] });
    const res = await svc.listItems({ workspaceId: ws });
    expect(res.items.map((i) => i.name)).toEqual(['Item 2', 'item 2', 'Item 10', 'AAA service']);
    expect(res.items.slice(0, 2).map((i) => i.refId)).toEqual([String(b._id), String(c._id)].sort());
  });

  test('pagination: page and limit, limit clamped to 1..200, junk falls back to defaults, past-the-end is empty', async () => {
    const products = Array.from({ length: 120 }, (_, i) => item({ name: `P${String(i).padStart(3, '0')}` }));
    const { svc } = build({ products });
    const page = (args) => svc.listItems({ workspaceId: ws, ...args });
    const third = await page({ page: 3, limit: 50 });
    expect(third.items).toHaveLength(20);
    expect(third.items[0].name).toBe('P100');
    expect(third.total).toBe(120);
    expect((await page({ limit: 1000 })).limit).toBe(200);
    expect((await page({ limit: 1000 })).items).toHaveLength(120);
    expect((await page({ limit: 0 })).limit).toBe(1);
    expect((await page({ limit: '-7' })).limit).toBe(1);
    expect((await page({ limit: 'abc', page: 'x' }))).toMatchObject({ limit: 50, page: 1 });
    expect((await page({ page: '0' })).page).toBe(1);
    expect((await page({ limit: '10', page: '2' })).items[0].name).toBe('P010');
    const beyond = await page({ page: 99, limit: 50 });
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(120);
  });

  describe('Arabic-aware search', () => {
    const pool = () => {
      const rows = {
        coffee: item({ name: 'Arabic Coffee', category: 'Drinks' }),
        ahmad: item({ name: 'أحمد للعطور', category: 'عطور' }),
        hospital: item({ name: 'مستشفى الأمل', category: 'Health' }),
        school: item({ name: 'مدرسة النور', category: 'Education' }),
        cup: item({ name: 'كوب ٣٠٠ مل', category: 'Home' }),
        cup2: item({ name: 'Cup 300 ml', category: 'Home' }),
        girl: item({ name: 'Gift Box', category: 'Gifts' }),
      };
      const translations = [
        translation('product', rows.coffee._id, { name: 'قَهْوَة عَرَبِيَّة' }),
        translation('product', rows.girl._id, { name: 'علبة هدايا' }),
      ];
      return { rows, seed: { products: Object.values(rows), translations } };
    };
    const found = async (seed, search) => (await build(seed).svc.listItems({ workspaceId: ws, search })).items.map((i) => i.name);

    test.each([
      ['plain query finds a diacritic-vowelled Arabic name', 'قهوة', ['Arabic Coffee']],
      ['vowelled query finds the same name', 'قَهْوَة', ['Arabic Coffee']],
      ['tatweel in the query', 'قـهـوة', ['Arabic Coffee']],
      ['alef-with-hamza stored, bare alef searched', 'احمد', ['أحمد للعطور']],
      ['bare alef stored, hamza-below searched', 'إحمد', ['أحمد للعطور']],
      ['alef maksura stored, yeh searched', 'مستشفي', ['مستشفى الأمل']],
      ['teh marbuta stored, heh searched', 'مدرسه', ['مدرسة النور']],
      ['teh marbuta searched, matches heh-less stored form too', 'مدرسة', ['مدرسة النور']],
      ['Western digits find Arabic-Indic digits', '300', ['Cup 300 ml', 'كوب ٣٠٠ مل']],
      ['Arabic-Indic digits find Western digits', '٣٠٠', ['Cup 300 ml', 'كوب ٣٠٠ مل']],
      ['Latin is case-insensitive', 'ARABIC coffee', ['Arabic Coffee']],
      ['category is searched', 'drinks', ['Arabic Coffee']],
      ['Arabic category is searched', 'عطور', ['أحمد للعطور']],
      ['the Arabic translation is searched', 'هدايا', ['Gift Box']],
      ['partial words match', 'cof', ['Arabic Coffee']],
      ['every token must match (across name, translation and category)', 'coffee drinks', ['Arabic Coffee']],
      ['tokens that do not all match find nothing', 'coffee gifts', []],
      ['emoji and punctuation in the query are ignored', '☕ coffee!!', ['Arabic Coffee']],
      ['no match', 'zzz', []],
    ])('%s', async (label, search, expected) => {
      expect(await found(pool().seed, search)).toEqual(expected);
    });

    test('a query with nothing searchable (punctuation only) behaves like no search', async () => {
      const { seed } = pool();
      expect(await found(seed, '!!! --- ???')).toHaveLength(7);
      expect(await found(seed, '   ')).toHaveLength(7);
    });

    test('too-long and non-string searches are rejected without touching the database', async () => {
      const { svc, Product, Service, ProductTranslation } = build(pool().seed);
      await expectError(svc.listItems({ workspaceId: ws, search: 'a'.repeat(LIMITS.searchMax + 1) }), 400, 'INVALID_INPUT');
      await expectError(svc.listItems({ workspaceId: ws, search: ['a', 'b'] }), 400, 'INVALID_INPUT');
      await expectError(svc.listItems({ workspaceId: ws, search: { $ne: null } }), 400, 'INVALID_INPUT');
      noQueries(Product, Service, ProductTranslation);
      await expect(svc.listItems({ workspaceId: ws, search: 'a'.repeat(LIMITS.searchMax) })).resolves.toBeDefined();
    });

    test('the query is never used as a database filter (no regex injection)', async () => {
      const { svc, Product } = build(pool().seed);
      const res = await svc.listItems({ workspaceId: ws, search: '.*(zz+)+$[' });
      expect(res.items).toEqual([]);
      expect(JSON.stringify(Product.calls)).not.toContain('regex');
      expect(Product.calls.every((c) => Object.keys(c.filter).sort().join() === 'workspaceId')).toBe(true);
    });
  });

  test('input validation and tenancy', async () => {
    const { svc, Product, Service, ProductTranslation } = build(catalogue().seed);
    await expectError(svc.listItems({ workspaceId: ws, kind: 'widget' }), 400, 'INVALID_INPUT');
    await expectError(svc.listItems({ workspaceId: ws, kind: ['product', 'service'] }), 400, 'INVALID_INPUT');
    await expectError(svc.listItems({ workspaceId: ws, kind: { $ne: 'x' } }), 400, 'INVALID_INPUT');
    await expectError(svc.listItems({ workspaceId: ws, status: 'approved' }), 400, 'INVALID_INPUT');
    await expectError(svc.listItems({ workspaceId: ws, page: { $gt: 0 } }), 400, 'INVALID_INPUT');
    await expectError(svc.listItems({}), 403, 'FORBIDDEN');
    await expectError(svc.listItems(), 403, 'FORBIDDEN');
    await expectError(svc.listItems({ workspaceId: { $ne: null } }), 403, 'FORBIDDEN');
    await expectError(svc.listItems({ workspaceId: 'nope' }), 403, 'FORBIDDEN');
    noQueries(Product, Service, ProductTranslation);
  });

  test('every query is scoped to the caller workspace; another workspace sees only its own rows', async () => {
    const c = catalogue();
    const { svc, Product, Service, ProductTranslation } = build(c.seed);
    await svc.listItems({ workspaceId: ws });
    for (const model of [Product, Service, ProductTranslation]) {
      expect(model.calls.length).toBeGreaterThan(0);
      for (const call of model.calls) expect(String(call.filter.workspaceId)).toBe(ws);
    }
    const other = await svc.listItems({ workspaceId: String(WS_B) });
    expect(other.items.map((i) => i.name)).toEqual(['Other Tenant Item']);
    expect(other.items[0].translation.name).toBe('عنصر');
    expect(other.counts).toEqual({ missing: 0, draft: 0, reviewed: 1 });
  });

  test('an oversized catalogue is capped and the cap is logged, never silent', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const products = Array.from({ length: LIMITS.scanPerKind + 1 }, (_, i) => item({ name: `Bulk ${i}` }));
      const { svc } = build({ products });
      const res = await svc.listItems({ workspaceId: ws, limit: 1 });
      expect(res.total).toBe(LIMITS.scanPerKind);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain('only the first');
    } finally {
      spy.mockRestore();
    }
  });
});

// ── save ───────────────────────────────────────────────────────────────────
describe('saveTranslation', () => {
  const setup = (extra = {}) => {
    const coffee = item({ name: 'Arabic Coffee' });
    const facial = item({ name: 'Facial' });
    return { coffee, facial, ...build({ products: [coffee], services: [facial], users: [{ _id: USER_ID, name: 'Noura' }], ...extra }) };
  };
  const save = (svc, product, body = {}, userId = String(USER_ID)) =>
    svc.saveTranslation({ workspaceId: ws, userId, kind: 'product', refId: String(product._id), ...body });

  test('creates a draft stored exactly as typed, for this workspace, kind and item', async () => {
    const { svc, coffee, ProductTranslation } = setup();
    const view = await save(svc, coffee, { name: 'قَهْوَة  عربية ٣٠٠', description: 'قهوة بالهيل\nمحمصة' });
    expect(view).toEqual({
      name: 'قَهْوَة  عربية ٣٠٠', description: 'قهوة بالهيل\nمحمصة', status: 'draft', source: 'merchant', reviewedBy: null, reviewedAt: null,
      updatedAt: NOW.toISOString(),
    });
    expect(ProductTranslation.docs).toHaveLength(1);
    const stored = ProductTranslation.docs[0];
    expect(String(stored.workspaceId)).toBe(ws);
    expect(stored).toMatchObject({ kind: 'product', language: 'ar', name: 'قَهْوَة  عربية ٣٠٠', status: 'draft', source: 'merchant' });
    expect(String(stored.refId)).toBe(String(coffee._id));
    expect(String(stored.updatedBy)).toBe(String(USER_ID));
    const [call] = writesTo(ProductTranslation);
    expect(call.options).toMatchObject({ upsert: true, returnDocument: 'after' });
    expect(call.options).not.toHaveProperty('new');
  });

  test('works for services and for inactive items', async () => {
    const hidden = item({ name: 'Seasonal', active: false });
    const { svc, facial, ProductTranslation } = setup({ products: [hidden] });
    await svc.saveTranslation({ workspaceId: ws, kind: 'service', refId: String(facial._id), name: 'عناية' });
    await svc.saveTranslation({ workspaceId: ws, kind: 'product', refId: String(hidden._id), name: 'موسمي' });
    expect(ProductTranslation.docs.map((d) => d.kind).sort()).toEqual(['product', 'service']);
  });

  test('control and invisible characters are stripped; the rest is untouched', async () => {
    const { svc, coffee } = setup();
    const view = await save(svc, coffee, { name: '\u{200F}قهوة\u{200B} عربية\u{0007}\r\n', description: 'سطر 1\r\nسطر 2\u{202E}\t.' });
    expect(view.name).toBe('قهوة عربية');
    expect(view.description).toBe('سطر 1\nسطر 2 .');
  });

  test.each([[undefined], [null], [''], ['   '], ['\u{200B}'], ['\u{200F}\u{202E}'], ['\n\t'], ['\u{0007}']])(
    'a blank name (%j) is TRANSLATION_NAME_REQUIRED and writes nothing',
    async (name) => {
      const { svc, coffee, ProductTranslation } = setup();
      await expectError(save(svc, coffee, { name }), 400, 'TRANSLATION_NAME_REQUIRED');
      expect(writesTo(ProductTranslation)).toHaveLength(0);
    },
  );

  test.each([[{ $ne: null }], [42], [true], [['قهوة']], [{ ar: 'قهوة' }]])('a non-string name (%j) is INVALID_INPUT', async (name) => {
    const { svc, coffee, ProductTranslation } = setup();
    await expectError(save(svc, coffee, { name }), 400, 'INVALID_INPUT');
    expect(writesTo(ProductTranslation)).toHaveLength(0);
  });

  test.each([[{ $gt: '' }], [7], [['x']], [false]])('a non-string description (%j) is INVALID_INPUT', async (description) => {
    const { svc, coffee } = setup();
    await expectError(save(svc, coffee, { name: 'قهوة', description }), 400, 'INVALID_INPUT');
  });

  test('length caps count code points after cleaning: name 200, description 2000', async () => {
    const { svc, coffee } = setup();
    const ok = await save(svc, coffee, { name: 'ا'.repeat(LIMITS.nameMax), description: 'و'.repeat(LIMITS.descriptionMax) });
    expect(Array.from(ok.name)).toHaveLength(200);
    expect(Array.from(ok.description)).toHaveLength(2000);
    await expectError(save(svc, coffee, { name: 'ا'.repeat(LIMITS.nameMax + 1) }), 400, 'INVALID_INPUT');
    await expectError(save(svc, coffee, { name: 'قهوة', description: 'و'.repeat(LIMITS.descriptionMax + 1) }), 400, 'INVALID_INPUT');
    // emoji are two UTF-16 units but one character each
    await expect(save(svc, coffee, { name: '\u{1F600}'.repeat(LIMITS.nameMax) })).resolves.toBeDefined();
    await expectError(save(svc, coffee, { name: '\u{1F600}'.repeat(LIMITS.nameMax + 1) }), 400, 'INVALID_INPUT');
    // invisible padding does not eat the budget
    await expect(save(svc, coffee, { name: `${'\u{200B}'.repeat(500)}${'ب'.repeat(LIMITS.nameMax)}` })).resolves.toBeDefined();
  });

  test('a change of name saves as draft and clears the reviewer in the same update', async () => {
    const coffee = item({ name: 'Arabic Coffee' });
    const { svc, ProductTranslation } = build({
      products: [coffee],
      translations: [translation('product', coffee._id, { name: 'قهوة', description: 'وصف', status: 'reviewed', reviewedBy: 'Noura', reviewedAt: NOW })],
    });
    const view = await save(svc, coffee, { name: 'قهوة عربية' });
    expect(view).toMatchObject({ name: 'قهوة عربية', description: 'وصف', status: 'draft', reviewedBy: null, reviewedAt: null });
    const stored = ProductTranslation.docs[0];
    expect(stored).not.toHaveProperty('reviewedBy');
    expect(stored).not.toHaveProperty('reviewedAt');
    const [call] = writesTo(ProductTranslation);
    expect(call.update.$set).toMatchObject({ status: 'draft', name: 'قهوة عربية' });
    expect(call.update.$unset).toEqual({ reviewedBy: '', reviewedAt: '' }); // text, status and reviewer change atomically
  });

  test('a change of description alone also resets to draft', async () => {
    const coffee = item({ name: 'Arabic Coffee' });
    const { svc, ProductTranslation } = build({
      products: [coffee], translations: [translation('product', coffee._id, { name: 'قهوة', description: 'قديم', status: 'reviewed', reviewedBy: 'Noura', reviewedAt: NOW })],
    });
    const view = await save(svc, coffee, { name: 'قهوة', description: 'جديد' });
    expect(view).toMatchObject({ status: 'draft', description: 'جديد', reviewedBy: null });
    expect(ProductTranslation.docs[0]).not.toHaveProperty('reviewedBy');
  });

  test('saving identical text keeps reviewed and writes nothing', async () => {
    const coffee = item({ name: 'Arabic Coffee' });
    const { svc, ProductTranslation } = build({
      products: [coffee], translations: [translation('product', coffee._id, { name: 'قهوة عربية', description: 'بالهيل', status: 'reviewed', reviewedBy: 'Noura', reviewedAt: NOW })],
    });
    const view = await save(svc, coffee, { name: 'قهوة عربية', description: 'بالهيل' });
    expect(view).toMatchObject({ status: 'reviewed', reviewedBy: 'Noura', reviewedAt: NOW.toISOString() });
    expect(writesTo(ProductTranslation)).toHaveLength(0);
    // identical after cleaning (stray invisible characters / padding) is still identical
    const again = await save(svc, coffee, { name: '  \u{200F}قهوة عربية\u{200B} ', description: 'بالهيل\n' });
    expect(again.status).toBe('reviewed');
    expect(writesTo(ProductTranslation)).toHaveLength(0);
    // an AI-labelled save of the same text does not downgrade it either
    expect((await save(svc, coffee, { name: 'قهوة عربية', source: 'ai' })).status).toBe('reviewed');
    expect(writesTo(ProductTranslation)).toHaveLength(0);
  });

  test('an omitted (or null) description keeps the stored one; an explicit empty string clears it', async () => {
    const coffee = item({ name: 'Arabic Coffee' });
    const { svc, ProductTranslation } = build({ products: [coffee], translations: [translation('product', coffee._id, { name: 'قهوة', description: 'وصف قديم' })] });
    expect((await save(svc, coffee, { name: 'قهوة عربية' })).description).toBe('وصف قديم');
    expect((await save(svc, coffee, { name: 'قهوة عربية جدا', description: null })).description).toBe('وصف قديم');
    expect(ProductTranslation.docs[0].description).toBe('وصف قديم');
    expect((await save(svc, coffee, { name: 'قهوة عربية جدا', description: '' })).description).toBe('');
    expect(ProductTranslation.docs[0].description).toBe('');
  });

  test('source: merchant by default; "ai" is a label on a draft; anything else is refused', async () => {
    const coffee = item({ name: 'Arabic Coffee' });
    const { svc, ProductTranslation } = build({
      products: [coffee], translations: [translation('product', coffee._id, { name: 'قهوة', status: 'reviewed', reviewedBy: 'Noura', reviewedAt: NOW })],
    });
    const ai = await save(svc, coffee, { name: 'قهوة مقترحة', source: 'ai' });
    expect(ai).toMatchObject({ status: 'draft', source: 'ai', reviewedBy: null });
    expect(ProductTranslation.docs[0].status).toBe('draft');
    expect((await save(svc, coffee, { name: 'قهوة معدلة', source: 'merchant' })).source).toBe('merchant');
    expect((await save(svc, coffee, { name: 'قهوة معدلة ٢' })).source).toBe('merchant');
    for (const source of ['csv', 'AI', 'human', '', { $ne: 'x' }, 1]) {
      await expectError(save(svc, coffee, { name: 'قهوة', source }), 400, 'INVALID_INPUT');
    }
  });

  test('ownership: another workspace, an unknown id or the wrong kind is ITEM_NOT_FOUND and nothing is written', async () => {
    const mine = item({ name: 'Mine' });
    const theirs = item({ workspaceId: WS_B, name: 'Theirs' });
    const service = item({ name: 'A service' });
    const { svc, ProductTranslation } = build({ products: [mine, theirs], services: [service] });
    await expectError(save(svc, theirs, { name: 'x' }), 404, 'ITEM_NOT_FOUND');
    await expectError(save(svc, { _id: oid() }, { name: 'x' }), 404, 'ITEM_NOT_FOUND');
    await expectError(svc.saveTranslation({ workspaceId: ws, kind: 'service', refId: String(mine._id), name: 'x' }), 404, 'ITEM_NOT_FOUND');
    await expectError(svc.saveTranslation({ workspaceId: ws, kind: 'product', refId: String(service._id), name: 'x' }), 404, 'ITEM_NOT_FOUND');
    await expectError(svc.saveTranslation({ workspaceId: String(WS_B), kind: 'product', refId: String(mine._id), name: 'x' }), 404, 'ITEM_NOT_FOUND');
    expect(ProductTranslation.docs).toEqual([]);
    expect(writesTo(ProductTranslation)).toHaveLength(0);
  });

  test.each([['not-an-id'], [''], ['123'], ['g'.repeat(24)], [{ $ne: null }], [['a'.repeat(24)]], [null], [undefined]])(
    'an invalid refId (%j) is INVALID_ID with no query run',
    async (refId) => {
      const { svc, Product, Service, ProductTranslation } = setup();
      await expectError(svc.saveTranslation({ workspaceId: ws, kind: 'product', refId, name: 'x' }), 400, 'INVALID_ID');
      noQueries(Product, Service, ProductTranslation);
    },
  );

  test.each([['Product'], ['all'], ['products'], [''], [undefined], [{ $ne: 'x' }]])('an invalid kind (%j) is INVALID_INPUT', async (kind) => {
    const { svc, coffee } = setup();
    await expectError(svc.saveTranslation({ workspaceId: ws, kind, refId: String(coffee._id), name: 'x' }), 400, 'INVALID_INPUT');
  });

  test('a missing workspace is FORBIDDEN', async () => {
    const { svc, coffee } = setup();
    await expectError(svc.saveTranslation({ kind: 'product', refId: String(coffee._id), name: 'x' }), 403, 'FORBIDDEN');
  });

  test('updatedBy is recorded only for a real user id', async () => {
    const { svc, coffee, ProductTranslation } = setup();
    await save(svc, coffee, { name: 'a' }, 'not-an-id');
    expect(ProductTranslation.docs[0]).not.toHaveProperty('updatedBy');
    await save(svc, coffee, { name: 'b' }, String(USER_ID));
    expect(String(ProductTranslation.docs[0].updatedBy)).toBe(String(USER_ID));
  });

  test('losing the unique-index insert race re-runs the decision: identical competing text is not overwritten', async () => {
    const coffee = item({ name: 'Arabic Coffee' });
    const { svc, ProductTranslation } = build({ products: [coffee] });
    ProductTranslation.hooks.beforeUpdate = (n, model) => {
      if (n !== 1) return;
      model.docs.push(translation('product', coffee._id, { name: 'قهوة', status: 'reviewed', reviewedBy: 'Noura', reviewedAt: NOW }));
      throw dupKey();
    };
    const view = await save(svc, coffee, { name: 'قهوة' });
    expect(view).toMatchObject({ name: 'قهوة', status: 'reviewed', reviewedBy: 'Noura' });
    expect(ProductTranslation.docs).toHaveLength(1);
    expect(ProductTranslation.writes).toBe(1); // the retry found identical text and did not write again
  });

  test('losing the race with different text ends as the draft of the last writer; one row only', async () => {
    const coffee = item({ name: 'Arabic Coffee' });
    const { svc, ProductTranslation } = build({ products: [coffee] });
    ProductTranslation.hooks.beforeUpdate = (n, model) => {
      if (n !== 1) return;
      model.docs.push(translation('product', coffee._id, { name: 'نص آخر', status: 'reviewed', reviewedBy: 'Noura', reviewedAt: NOW }));
      throw dupKey();
    };
    const view = await save(svc, coffee, { name: 'نصي' });
    expect(view).toMatchObject({ name: 'نصي', status: 'draft', reviewedBy: null });
    expect(ProductTranslation.docs).toHaveLength(1);
    expect(ProductTranslation.docs[0]).not.toHaveProperty('reviewedBy');
  });

  test('a second lost race, or any other database error, is not swallowed', async () => {
    const coffee = item({ name: 'Arabic Coffee' });
    const twice = build({ products: [coffee] });
    twice.ProductTranslation.hooks.beforeUpdate = () => { throw dupKey(); };
    await expect(save(twice.svc, coffee, { name: 'x' })).rejects.toMatchObject({ code: 11000 });
    expect(twice.ProductTranslation.writes).toBe(2);

    const other = build({ products: [coffee] });
    other.ProductTranslation.hooks.beforeUpdate = () => { throw new Error('connection lost'); };
    await expect(save(other.svc, coffee, { name: 'x' })).rejects.toThrow('connection lost');
    expect(other.ProductTranslation.writes).toBe(1);
  });

  test('the existing Product, Service and User models are only ever read', async () => {
    const { svc, coffee, facial, Product, Service, User } = setup();
    await save(svc, coffee, { name: 'قهوة' });
    await svc.saveTranslation({ workspaceId: ws, kind: 'service', refId: String(facial._id), name: 'عناية' });
    await svc.reviewTranslation({ workspaceId: ws, userId: String(USER_ID), kind: 'product', refId: String(coffee._id), status: 'reviewed' });
    await svc.listItems({ workspaceId: ws });
    await svc.exportCsv({ workspaceId: ws });
    for (const model of [Product, Service, User]) {
      expect(model.calls.every((c) => c.op === 'find' || c.op === 'findOne')).toBe(true);
    }
  });
});

// ── review ─────────────────────────────────────────────────────────────────
describe('reviewTranslation', () => {
  function setup(rowOverrides = {}, users = [{ _id: USER_ID, name: 'Noura Al-Harbi', email: 'noura@example.com', phone: '966500000001' }]) {
    const coffee = item({ name: 'Arabic Coffee' });
    const row = translation('product', coffee._id, { name: 'قهوة عربية', ...rowOverrides });
    return { coffee, row, ...build({ products: [coffee], translations: [row], users }) };
  }
  const review = (env, status, userId = String(USER_ID)) =>
    env.svc.reviewTranslation({ workspaceId: ws, userId, kind: 'product', refId: String(env.coffee._id), status });

  test('marks reviewed, recording the signed-in user name and time; the text is untouched', async () => {
    const env = setup();
    const view = await review(env, 'reviewed');
    expect(view).toMatchObject({ name: 'قهوة عربية', status: 'reviewed', reviewedBy: 'Noura Al-Harbi', reviewedAt: NOW.toISOString() });
    expect(env.ProductTranslation.docs[0]).toMatchObject({ status: 'reviewed', reviewedBy: 'Noura Al-Harbi', name: 'قهوة عربية' });
    const [call] = writesTo(env.ProductTranslation);
    expect(Object.keys(call.update.$set).sort()).toEqual(['reviewedAt', 'reviewedBy', 'status']);
  });

  test.each([
    ['name', [{ _id: USER_ID, name: 'Noura', email: 'n@example.com', phone: '1' }], 'Noura'],
    ['email when there is no name', [{ _id: USER_ID, email: 'n@example.com', phone: '1' }], 'n@example.com'],
    ['phone when there is no name or email', [{ _id: USER_ID, phone: '966500000001' }], '966500000001'],
    ['the user id when the user cannot be found', [], String(USER_ID)],
  ])('the reviewer is recorded by %s', async (label, users, expected) => {
    const env = setup({}, users);
    expect((await review(env, 'reviewed')).reviewedBy).toBe(expected);
  });

  test('back to draft clears the reviewer fields', async () => {
    const env = setup({ status: 'reviewed', reviewedBy: 'Noura', reviewedAt: NOW });
    const view = await review(env, 'draft');
    expect(view).toMatchObject({ status: 'draft', reviewedBy: null, reviewedAt: null });
    expect(env.ProductTranslation.docs[0]).not.toHaveProperty('reviewedBy');
    expect(env.ProductTranslation.docs[0]).not.toHaveProperty('reviewedAt');
  });

  test('asking for the state it is already in changes nothing, so the first reviewer stays on record', async () => {
    const env = setup({ status: 'reviewed', reviewedBy: 'First Reviewer', reviewedAt: new Date('2026-01-01T00:00:00Z') });
    const view = await review(env, 'reviewed');
    expect(view).toMatchObject({ status: 'reviewed', reviewedBy: 'First Reviewer', reviewedAt: '2026-01-01T00:00:00.000Z' });
    expect(env.ProductTranslation.docs[0].reviewedBy).toBe('First Reviewer');
    const draft = setup({ status: 'draft' });
    expect((await review(draft, 'draft')).status).toBe('draft');
  });

  test('the status filter in the write protects against a racing change: it only ever flips the other state', async () => {
    const env = setup();
    await review(env, 'reviewed');
    const [call] = writesTo(env.ProductTranslation);
    expect(call.filter.status).toEqual({ $ne: 'reviewed' });
    expect(String(call.filter.workspaceId)).toBe(ws);
  });

  test('NOT_FOUND when the item exists but has no translation; ITEM_NOT_FOUND when the item is not in the workspace', async () => {
    const bare = item({ name: 'Untranslated' });
    const theirs = item({ workspaceId: WS_B, name: 'Theirs' });
    const env = build({ products: [bare, theirs], users: [{ _id: USER_ID, name: 'Noura' }] });
    const call = (refId, workspaceId = ws) => env.svc.reviewTranslation({ workspaceId, userId: String(USER_ID), kind: 'product', refId: String(refId), status: 'reviewed' });
    await expectError(call(bare._id), 404, 'NOT_FOUND');
    await expectError(call(theirs._id), 404, 'ITEM_NOT_FOUND');
    await expectError(call(oid()), 404, 'ITEM_NOT_FOUND');
    expect(env.ProductTranslation.docs).toEqual([]);
  });

  test('a translation belonging to another workspace is never touched', async () => {
    const coffee = item({ name: 'Arabic Coffee' });
    const env = build({ products: [coffee], translations: [translation('product', coffee._id, { workspaceId: WS_B })], users: [] });
    await expectError(env.svc.reviewTranslation({ workspaceId: ws, userId: String(USER_ID), kind: 'product', refId: String(coffee._id), status: 'reviewed' }), 404, 'NOT_FOUND');
    expect(env.ProductTranslation.docs[0].status).toBe('draft');
  });

  test.each([['approved'], [''], [undefined], [null], [{ $ne: 'x' }], [['reviewed']], [true]])('an invalid status (%j) is INVALID_INPUT', async (status) => {
    const env = setup();
    await expectError(review(env, status), 400, 'INVALID_INPUT');
    expect(writesTo(env.ProductTranslation)).toHaveLength(0);
  });

  test('invalid ids and kinds are rejected before any query', async () => {
    const env = setup();
    await expectError(env.svc.reviewTranslation({ workspaceId: ws, kind: 'product', refId: { $ne: null }, status: 'reviewed' }), 400, 'INVALID_ID');
    await expectError(env.svc.reviewTranslation({ workspaceId: ws, kind: 'nope', refId: String(env.coffee._id), status: 'reviewed' }), 400, 'INVALID_INPUT');
    await expectError(env.svc.reviewTranslation({ kind: 'product', refId: String(env.coffee._id), status: 'reviewed' }), 403, 'FORBIDDEN');
    noQueries(env.Product, env.Service, env.ProductTranslation, env.User);
  });

  test('editing after a review sends it back to draft (a reviewed row never holds unseen text)', async () => {
    const env = setup();
    await review(env, 'reviewed');
    const view = await env.svc.saveTranslation({ workspaceId: ws, kind: 'product', refId: String(env.coffee._id), name: 'قهوة عربية أصلية' });
    expect(view.status).toBe('draft');
    expect(view.reviewedBy).toBeNull();
  });
});

// ── CSV export ─────────────────────────────────────────────────────────────
describe('exportCsv', () => {
  function env() {
    const coffee = item({ name: 'Arabic Coffee', category: 'Drinks' });
    const formula = item({ name: '=HYPERLINK("http://evil.example","click")', category: '+cmd' });
    const plus = item({ name: '@SUM(A1)', category: '-1+2' });
    const numeric = item({ name: '-5% promo', category: '+966 pack' });
    const dde = item({ name: "-2+3+cmd|' /C calc'!A0", category: '\t=1+1' });
    const plain = item({ name: '-5', category: '+966501234567' });
    const facial = item({ name: 'Facial, deluxe "spa"', category: 'Spa' });
    const other = item({ workspaceId: WS_B, name: 'Other Tenant Item' });
    return {
      coffee, facial, formula,
      ...build({
        products: [coffee, formula, plus, numeric, dde, plain, other],
        services: [facial],
        translations: [
          translation('product', coffee._id, { name: 'قَهْوة, "عربية"', description: 'سطر 1\nسطر 2', status: 'reviewed' }),
          translation('service', facial._id, { name: 'عناية', description: '' }),
        ],
      }),
    };
  }

  test('BOM + CRLF, the exact header, and only this workspace', async () => {
    const { svc } = env();
    const csv = await svc.exportCsv({ workspaceId: ws });
    expect(csv.codePointAt(0)).toBe(0xFEFF);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(/\r\n/g, '').includes('\n')).toBe(true); // only the description keeps a bare \n (inside quotes)
    const grid = parseRows(csv);
    expect(grid[0]).toEqual(['kind', 'id', 'name', 'category', 'name_ar', 'description_ar', 'status']);
    expect(grid).toHaveLength(1 + 7);
    expect(grid.flat().join('|')).not.toContain('Other Tenant Item');
  });

  test('rows carry the id, Arabic text and a missing/draft/reviewed status; Arabic and quoting round-trip', async () => {
    const e = env();
    const grid = parseRows(await e.svc.exportCsv({ workspaceId: ws }));
    const byName = Object.fromEntries(grid.slice(1).map((r) => [r[2], r]));
    expect(byName['Arabic Coffee']).toEqual(['product', String(e.coffee._id), 'Arabic Coffee', 'Drinks', 'قَهْوة, "عربية"', 'سطر 1\nسطر 2', 'reviewed']);
    expect(byName['Facial, deluxe "spa"']).toEqual(['service', String(e.facial._id), 'Facial, deluxe "spa"', 'Spa', 'عناية', '', 'draft']);
    expect(byName["'@SUM(A1)"][4]).toBe('');
    expect(grid.filter((r) => r[6] === 'missing')).toHaveLength(5);
  });

  test('every cell that could be read as a spreadsheet formula is guarded; plain numbers are left alone', async () => {
    const csv = await env().svc.exportCsv({ workspaceId: ws });
    const cells = parseRows(csv).flat();
    expect(cells).toContain(`'=HYPERLINK("http://evil.example","click")`);
    expect(cells).toContain("'+cmd");
    expect(cells).toContain("'@SUM(A1)");
    expect(cells).toContain("'-1+2");
    expect(cells).toContain("'-5% promo");
    expect(cells).toContain("'+966 pack");
    expect(cells).toContain("'-2+3+cmd|' /C calc'!A0"); // starts with a signed digit: the shared writer alone would let it through
    expect(cells).toContain("'\t=1+1");
    expect(cells).toContain('-5');
    expect(cells).toContain('+966501234567');
    for (const cell of cells) {
      expect(/^[=+\-@\t\r]/.test(cell) && !/^[+-]?\d+(\.\d+)?$/.test(cell)).toBe(false);
    }
  });

  test('a fresh export re-imports as all "unchanged" (id match, guarded cells restored)', async () => {
    const e = env();
    const csv = await e.svc.exportCsv({ workspaceId: ws });
    const res = await e.svc.importCsv({ workspaceId: ws, buffer: Buffer.from(csv, 'utf8'), dryRun: true });
    expect(res.summary).toEqual({ rows: 7, updated: 0, unchanged: 7, unmatched: 0, invalid: 0 });
    // and with the BOM-less text a spreadsheet may save
    const plain = await e.svc.importCsv({ workspaceId: ws, buffer: Buffer.from(csv.slice(1), 'utf8'), dryRun: true });
    expect(plain.summary.unchanged).toBe(7);
  });

  test('guarded names are matched again by name once the id column is gone', async () => {
    const e = env();
    const sheet = stringifyCsv([
      ['name', 'name_ar'],
      [`'=HYPERLINK("http://evil.example","click")`, 'رابط'],
      ["'-5% promo", 'خصم'],
      ["'-2+3+cmd|' /C calc'!A0", 'أمر'],
      ['-5', 'سالب خمسة'],
    ], { bom: false });
    const res = await e.svc.importCsv({ workspaceId: ws, buffer: bom8(sheet), dryRun: false });
    expect(res.rows.map((r) => r.outcome)).toEqual(['updated', 'updated', 'updated', 'updated']);
    expect(e.ProductTranslation.docs.filter((d) => d.source === 'csv')).toHaveLength(4);
    expect(String(e.ProductTranslation.docs.find((d) => d.name === 'رابط').refId)).toBe(String(e.formula._id));
  });

  test('another workspace exports only its own catalogue; an empty catalogue is just the header', async () => {
    const e = env();
    const theirs = parseRows(await e.svc.exportCsv({ workspaceId: String(WS_B) }));
    expect(theirs.map((r) => r[2])).toEqual(['name', 'Other Tenant Item']);
    const none = build();
    expect(parseRows(await none.svc.exportCsv({ workspaceId: ws }))).toEqual([['kind', 'id', 'name', 'category', 'name_ar', 'description_ar', 'status']]);
    await expectError(e.svc.exportCsv({}), 403, 'FORBIDDEN');
  });
});

// ── CSV import ─────────────────────────────────────────────────────────────
describe('importCsv', () => {
  function env(extra = {}) {
    const coffee = item({ name: 'Arabic Coffee', category: 'Drinks' });
    const tea = item({ name: 'Mint Tea', category: 'Drinks', active: false });
    const twinA = item({ name: 'Twin' });
    const twinB = item({ name: 'twin ' });
    const shared1 = item({ name: 'Massage' });
    const facial = item({ name: 'Facial', category: 'Spa' });
    const shared2 = item({ name: 'massage' });
    const theirs = item({ workspaceId: WS_B, name: 'Theirs' });
    return {
      coffee, tea, twinA, twinB, shared1, shared2, facial, theirs,
      ...build({
        products: [coffee, tea, twinA, twinB, shared1, theirs],
        services: [facial, shared2],
        users: [{ _id: USER_ID, name: 'Noura' }],
        ...extra,
      }),
    };
  }
  const run = (e, text, opts = {}) => e.svc.importCsv({
    workspaceId: ws, userId: String(USER_ID), buffer: Buffer.isBuffer(text) ? text : bom8(text), dryRun: false, ...opts,
  });
  const HEADER = 'kind,id,name,category,name_ar,description_ar,status';
  const outcomes = (res) => res.rows.map((r) => r.outcome);

  test('matches by kind + id and saves a draft with source "csv", attributed to the importing user', async () => {
    const e = env();
    const res = await run(e, lines(HEADER, `product,${e.coffee._id},ignored name,x,قهوة عربية,وصف القهوة,reviewed`));
    expect(res).toMatchObject({ dryRun: false, encoding: 'utf-8-bom', truncated: false, summary: { rows: 1, updated: 1, unchanged: 0, unmatched: 0, invalid: 0 } });
    expect(res.rows).toEqual([{ line: 2, name: 'ignored name', outcome: 'updated' }]);
    expect(e.ProductTranslation.docs).toHaveLength(1);
    expect(e.ProductTranslation.docs[0]).toMatchObject({
      kind: 'product', language: 'ar', name: 'قهوة عربية', description: 'وصف القهوة', status: 'draft', source: 'csv',
    });
    expect(String(e.ProductTranslation.docs[0].refId)).toBe(String(e.coffee._id));
    expect(String(e.ProductTranslation.docs[0].updatedBy)).toBe(String(USER_ID));
  });

  test('the id wins over the name and a status column can never mark anything reviewed', async () => {
    const e = env();
    await run(e, lines(HEADER, `product,${e.tea._id},Arabic Coffee,x,شاي,,reviewed`));
    expect(String(e.ProductTranslation.docs[0].refId)).toBe(String(e.tea._id));
    expect(e.ProductTranslation.docs[0].status).toBe('draft');
  });

  test('matches by exact English name + kind: case-insensitive, trimmed, spaces collapsed', async () => {
    const e = env();
    const res = await run(e, lines(HEADER, 'product,,  ARABIC   coffee ,,قهوة,,', 'service,,facial,,عناية,,'));
    expect(outcomes(res)).toEqual(['updated', 'updated']);
    expect(e.ProductTranslation.docs.map((d) => [d.kind, String(d.refId)]).sort()).toEqual(
      [['product', String(e.coffee._id)], ['service', String(e.facial._id)]].sort(),
    );
  });

  test('a file without kind and id columns matches names across both kinds when unique', async () => {
    const e = env();
    const res = await run(e, lines('Name,Arabic Name', 'Mint Tea,شاي بالنعناع', 'Facial,عناية بالبشرة'));
    expect(outcomes(res)).toEqual(['updated', 'updated']);
    expect(res.summary.updated).toBe(2);
  });

  test('a name that matches several items is "ambiguous" and is NOT applied (never guessed)', async () => {
    const e = env();
    const res = await run(e, lines(
      HEADER,
      'product,,Twin,,توأم,,',          // two products named twin (case/space-insensitively)
      ',,Massage,,مساج,,',              // a product and a service
      'service,,Massage,,مساج,,',       // kind narrows it to one service: fine
    ));
    expect(outcomes(res)).toEqual(['ambiguous', 'ambiguous', 'updated']);
    expect(res.summary).toEqual({ rows: 3, updated: 1, unchanged: 0, unmatched: 2, invalid: 0 });
    expect(e.ProductTranslation.docs).toHaveLength(1);
    expect(e.ProductTranslation.docs[0].kind).toBe('service');
  });

  test('unmatched: unknown name, unknown id, other workspace id, wrong kind for the id', async () => {
    const e = env();
    const res = await run(e, lines(
      HEADER,
      'product,,No such product,,اسم,,',
      `product,${oid()},Arabic Coffee,,اسم,,`,
      `product,${e.theirs._id},Theirs,,اسم,,`,
      `service,${e.coffee._id},Arabic Coffee,,اسم,,`,
      ',,Theirs,,اسم,,',
    ));
    expect(outcomes(res)).toEqual(['unmatched', 'unmatched', 'unmatched', 'unmatched', 'unmatched']);
    expect(e.ProductTranslation.docs).toEqual([]);
    expect(res.summary.unmatched).toBe(5);
  });

  test('blank Arabic cells are skipped, never a delete: an existing translation is left exactly as it was', async () => {
    const e = env();
    e.ProductTranslation.docs.push(translation('product', e.coffee._id, { name: 'قهوة', description: 'وصف', status: 'reviewed', reviewedBy: 'Noura', reviewedAt: NOW }));
    const res = await run(e, lines(HEADER, `product,${e.coffee._id},Arabic Coffee,,,,`, `product,${e.tea._id},Mint Tea,,   ,  ,`));
    expect(outcomes(res)).toEqual(['unchanged', 'unchanged']);
    expect(res.summary).toMatchObject({ unchanged: 2, updated: 0 });
    expect(e.ProductTranslation.docs).toHaveLength(1);
    expect(e.ProductTranslation.docs[0]).toMatchObject({ name: 'قهوة', description: 'وصف', status: 'reviewed', reviewedBy: 'Noura' });
    expect(writesTo(e.ProductTranslation)).toHaveLength(0);
  });

  test('a description without an Arabic name is invalid (it cannot be applied) and writes nothing', async () => {
    const e = env();
    const res = await run(e, lines(HEADER, `product,${e.coffee._id},Arabic Coffee,,,وصف بلا اسم,`));
    expect(outcomes(res)).toEqual(['invalid']);
    expect(e.ProductTranslation.docs).toEqual([]);
  });

  test('a blank description keeps the stored description; a new description replaces it', async () => {
    const e = env();
    e.ProductTranslation.docs.push(translation('product', e.coffee._id, { name: 'قهوة', description: 'وصف قديم' }));
    await run(e, lines(HEADER, `product,${e.coffee._id},Arabic Coffee,,قهوة عربية,,`));
    expect(e.ProductTranslation.docs[0]).toMatchObject({ name: 'قهوة عربية', description: 'وصف قديم' });
    expect(writesTo(e.ProductTranslation)[0].update.$set).not.toHaveProperty('description', undefined);
    await run(e, lines(HEADER, `product,${e.coffee._id},Arabic Coffee,,قهوة عربية,وصف جديد,`));
    expect(e.ProductTranslation.docs[0].description).toBe('وصف جديد');
  });

  test('identical text is "unchanged"; changed text on a reviewed row falls back to draft; identical reviewed rows stay reviewed', async () => {
    const e = env();
    e.ProductTranslation.docs.push(
      translation('product', e.coffee._id, { name: 'قهوة', description: 'وصف', status: 'reviewed', reviewedBy: 'Noura', reviewedAt: NOW }),
      translation('product', e.tea._id, { name: 'شاي', status: 'reviewed', reviewedBy: 'Noura', reviewedAt: NOW }),
    );
    const res = await run(e, lines(HEADER, `product,${e.coffee._id},,,قهوة,وصف,`, `product,${e.tea._id},,,شاي أخضر,,`));
    expect(outcomes(res)).toEqual(['unchanged', 'updated']);
    const [coffeeDoc, teaDoc] = e.ProductTranslation.docs;
    expect(coffeeDoc).toMatchObject({ status: 'reviewed', reviewedBy: 'Noura' });
    expect(teaDoc).toMatchObject({ name: 'شاي أخضر', status: 'draft', source: 'csv' });
    expect(teaDoc).not.toHaveProperty('reviewedBy');
  });

  test('dryRun writes nothing but reports exactly what an apply would', async () => {
    const make = () => env();
    const sheet = (e) => lines(
      HEADER,
      `product,${e.coffee._id},,,قهوة,,`,
      'product,,Twin,,توأم,,',
      `product,${oid()},,,x,,`,
      `service,${e.facial._id},,,عناية,,`,
      `product,${e.coffee._id},,,مكرر,,`,
      'product,,Mint Tea,,,,',
    );
    const preview = make();
    const previewRes = await run(preview, sheet(preview), { dryRun: true });
    expect(previewRes.dryRun).toBe(true);
    expect(preview.ProductTranslation.docs).toEqual([]);
    expect(preview.ProductTranslation.calls.filter((c) => c.op === 'findOneAndUpdate')).toHaveLength(0);
    expect(preview.ProductTranslation.writes).toBe(0);

    const applied = make();
    const appliedRes = await run(applied, sheet(applied), { dryRun: false });
    expect(appliedRes.dryRun).toBe(false);
    expect(appliedRes.summary).toEqual(previewRes.summary);
    expect(outcomes(appliedRes)).toEqual(outcomes(previewRes));
    expect(applied.ProductTranslation.docs).toHaveLength(2);
  });

  test('without an explicit dryRun:false the file is only previewed', async () => {
    const e = env();
    const buffer = bom8(lines(HEADER, `product,${e.coffee._id},,,قهوة,,`));
    for (const args of [{ buffer }, { buffer, dryRun: undefined }, { buffer, dryRun: 'false' }, { buffer, dryRun: 0 }, { buffer, dryRun: null }]) {
      const res = await e.svc.importCsv({ workspaceId: ws, ...args });
      expect(res.dryRun).toBe(true);
    }
    expect(e.ProductTranslation.docs).toEqual([]);
    expect((await e.svc.importCsv({ workspaceId: ws, buffer, dryRun: false })).dryRun).toBe(false);
    expect(e.ProductTranslation.docs).toHaveLength(1);
  });

  describe('encodings and delimiters', () => {
    const sheetText = (e) => lines('kind,id,name,name_ar,description_ar', `product,${e.coffee._id},Arabic Coffee,قهوة عربية,قهوة محمصة طازجة`);
    const expectApplied = (e, encoding, res) => {
      expect(res.encoding).toBe(encoding);
      expect(res.summary.updated).toBe(1);
      expect(e.ProductTranslation.docs[0]).toMatchObject({ name: 'قهوة عربية', description: 'قهوة محمصة طازجة' });
    };

    test('UTF-8 with BOM', async () => {
      const e = env();
      expectApplied(e, 'utf-8-bom', await run(e, bom8(sheetText(e))));
    });
    test('UTF-8 without BOM (Google Sheets)', async () => {
      const e = env();
      expectApplied(e, 'utf-8', await run(e, bytes(sheetText(e))));
    });
    test('UTF-16LE with BOM (Excel "Unicode Text")', async () => {
      const e = env();
      const text = sheetText(e).replace(/,/g, '\t');
      expectApplied(e, 'utf-16le', await run(e, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])));
    });
    test('windows-1256 (Excel "CSV" on an Arabic-locale PC) is decoded, not turned into mojibake', async () => {
      const e = env();
      expectApplied(e, 'windows-1256', await run(e, encodeWin1256(sheetText(e))));
    });
    test('semicolon-delimited (Arabic-locale Excel) and tab-delimited files', async () => {
      const semi = env();
      expectApplied(semi, 'utf-8-bom', await run(semi, bom8(sheetText(semi).replace(/,/g, ';'))));
      const tab = env();
      expectApplied(tab, 'utf-8-bom', await run(tab, bom8(sheetText(tab).replace(/,/g, '\t'))));
    });
    test('quoted cells with commas, quotes and newlines survive', async () => {
      const e = env();
      await run(e, lines(HEADER, `product,${e.coffee._id},,,"قهوة، ""عربية""","سطر 1\nسطر 2",`));
      expect(e.ProductTranslation.docs[0]).toMatchObject({ name: 'قهوة، "عربية"', description: 'سطر 1\nسطر 2' });
    });
  });

  test('header aliases: Arabic and English spellings, any order, spacing and case', async () => {
    const arabic = env();
    await run(arabic, lines('المعرف,الاسم بالعربية,الوصف بالعربية', `${arabic.coffee._id},قهوة,وصف`));
    expect(arabic.ProductTranslation.docs[0]).toMatchObject({ name: 'قهوة', description: 'وصف' });

    const english = env();
    await run(english, lines('Arabic Name , Name  , Arabic_Description', 'قهوة عربية, arabic coffee ,وصف'));
    expect(english.ProductTranslation.docs[0]).toMatchObject({ name: 'قهوة عربية', description: 'وصف' });

    const mixed = env();
    await run(mixed, lines('الاسم بالإنجليزية,النوع,NAME_AR', 'Facial,خدمة,عناية'));
    expect(mixed.ProductTranslation.docs[0]).toMatchObject({ kind: 'service', name: 'عناية' });
  });

  test('Arabic words for the kind column; an unknown kind makes the row invalid', async () => {
    const e = env();
    const res = await run(e, lines(HEADER, 'منتج,,Mint Tea,,شاي,,', 'خدمة,,Facial,,عناية,,', 'widget,,Mint Tea,,شاي 2,,'));
    expect(outcomes(res)).toEqual(['updated', 'updated', 'invalid']);
  });

  test('names and Arabic-Indic digits are kept exactly as written; only hidden characters are removed', async () => {
    const e = env();
    await run(e, lines(HEADER, `product,${e.coffee._id},,,"قَهْوَة ٣٠٠ مل\u{200F}",كوب ٢٥٠ مل\u{200B},`));
    expect(e.ProductTranslation.docs[0]).toMatchObject({ name: 'قَهْوَة ٣٠٠ مل', description: 'كوب ٢٥٠ مل' });
  });

  test('neutralised cells from our own export are restored before matching and saving', async () => {
    const weird = item({ name: '=Special Offer' });
    const e = env({ products: [weird] });
    const res = await run(e, lines(HEADER, "product,,'=Special Offer,,'=عرض خاص,,"));
    expect(res.rows[0]).toEqual({ line: 2, name: '=Special Offer', outcome: 'updated' });
    expect(e.ProductTranslation.docs[0].name).toBe('=عرض خاص');
  });

  test('an id mangled by a spreadsheet falls back to the exact name; a valid id for the wrong item is not second-guessed', async () => {
    const e = env();
    const res = await run(e, lines(HEADER, 'product,6.52346E+23,Arabic Coffee,,قهوة,,', 'product,,,,بلا هوية,,'));
    expect(outcomes(res)).toEqual(['updated', 'invalid']);
    expect(String(e.ProductTranslation.docs[0].refId)).toBe(String(e.coffee._id));
    const wrong = await run(e, lines(HEADER, `product,${e.tea._id},Arabic Coffee,,شاي,,`));
    expect(String(e.ProductTranslation.docs.find((d) => d.name === 'شاي').refId)).toBe(String(e.tea._id));
    expect(outcomes(wrong)).toEqual(['updated']);
  });

  test('Arabic-Indic digits in the id cell are read as digits', async () => {
    const hex = '652345678901234567890123';
    const known = item({ _id: new mongoose.Types.ObjectId(hex), name: 'Digits' });
    const e = env({ products: [known] });
    const arabicDigits = hex.replace(/\d/g, (d) => String.fromCodePoint(0x0660 + Number(d)));
    const res = await run(e, lines(HEADER, `product,${arabicDigits},,,أرقام,,`));
    expect(outcomes(res)).toEqual(['updated']);
  });

  test('too-long Arabic text makes only that row invalid', async () => {
    const e = env();
    const res = await run(e, lines(
      HEADER,
      `product,${e.coffee._id},,,${'ا'.repeat(LIMITS.nameMax + 1)},,`,
      `product,${e.tea._id},,,شاي,${'و'.repeat(LIMITS.descriptionMax + 1)},`,
      `service,${e.facial._id},,,عناية,,`,
    ));
    expect(outcomes(res)).toEqual(['invalid', 'invalid', 'updated']);
    expect(res.summary).toMatchObject({ invalid: 2, updated: 1 });
  });

  test('a file that names the same item twice applies the first row only; the later one is reported', async () => {
    const e = env();
    const res = await run(e, lines(HEADER, `product,${e.coffee._id},,,الأول,,`, `product,,Arabic Coffee,,الثاني,,`, `product,${e.coffee._id},,,الثالث,,`));
    expect(outcomes(res)).toEqual(['updated', 'duplicate', 'duplicate']);
    expect(res.summary).toMatchObject({ updated: 1, invalid: 2 });
    expect(e.ProductTranslation.docs).toHaveLength(1);
    expect(e.ProductTranslation.docs[0].name).toBe('الأول');
  });

  test('blank lines and all-empty rows are ignored and not counted; short rows are tolerated; line numbers follow the file', async () => {
    const e = env();
    const res = await run(e, `${HEADER}\r\n\r\n,,,,,,\r\nproduct,${e.coffee._id},Arabic Coffee,,قهوة\r\n  ,  ,,,,,\r\nservice,${e.facial._id},Facial,,عناية,,\r\n`);
    expect(res.summary.rows).toBe(2);
    expect(res.rows.map((r) => r.outcome)).toEqual(['updated', 'updated']);
    expect(res.rows[0].line).toBeGreaterThanOrEqual(2);
  });

  test('the report is capped at 200 rows with problems first, shown in file order, and flags truncation', async () => {
    const products = Array.from({ length: 300 }, (_, i) => item({ name: `Bulk ${i}` }));
    const e = env({ products });
    const okRows = products.slice(0, 250).map((p, i) => `product,${p._id},,,اسم ${i},,`);
    const noops = products.slice(250).map((p) => `product,${p._id},,,,,`);
    const problems = Array.from({ length: 30 }, (_, i) => `product,,No such ${i},,x,,`);
    const res = await run(e, lines(HEADER, ...noops, ...okRows, ...problems), { dryRun: true });
    expect(res.summary).toEqual({ rows: 330, updated: 250, unchanged: 50, unmatched: 30, invalid: 0 });
    expect(res.rows).toHaveLength(LIMITS.reportRows);
    expect(res.truncated).toBe(true);
    expect(res.rows.filter((r) => r.outcome === 'unmatched')).toHaveLength(30); // every problem is kept
    expect(res.rows.filter((r) => r.outcome === 'unchanged')).toHaveLength(0);  // the no-ops are what got cut
    const lineNumbers = res.rows.map((r) => r.line);
    expect(lineNumbers).toEqual([...lineNumbers].sort((a, b) => a - b));
    const small = await run(e, lines(HEADER, ...okRows.slice(0, 5)), { dryRun: true });
    expect(small.truncated).toBe(false);
  });

  test('echoed names are cleaned and shortened; an id-only row is labelled by its id', async () => {
    const e = env();
    const long = 'N'.repeat(500);
    const res = await run(e, lines(HEADER, `product,,${long},,x,,`, `product,${e.coffee._id},,,قهوة,,`, `product,${oid()},,,x,,`), { dryRun: true });
    expect(Array.from(res.rows[0].name)).toHaveLength(LIMITS.displayNameMax);
    expect(res.rows[1].name).toBe('Arabic Coffee'); // the matched item's name when the sheet has none
    expect(res.rows[2].name).toMatch(/^[a-f0-9]{24}$/);
  });

  test('file-level problems are rejected with a code and nothing is written', async () => {
    const e = env();
    const code = async (buffer, status, expected) => expectError(run(e, buffer), status, expected);
    await code(Buffer.alloc(0), 400, 'FILE_INVALID');
    await code(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), 400, 'FILE_INVALID');                 // an .xlsx
    await code(bom8('kind,id,name\r\nproduct,,Mint Tea'), 400, 'FILE_INVALID');                     // no name_ar column
    await code(bom8('name_ar,category\r\nشاي,Drinks'), 400, 'FILE_INVALID');                        // no id or name column
    await code(bom8('kind,id,name,name_ar\r\nproduct,,"Mint Tea,شاي'), 400, 'FILE_INVALID');        // unterminated quote
    await code(Buffer.alloc(5 * 1024 * 1024 + 1, 97), 413, 'FILE_TOO_LARGE');
    const many = lines('id,name_ar', ...Array.from({ length: LIMITS.importRows + 1 }, () => `${oid()},x`));
    await code(bom8(many), 413, 'FILE_TOO_LARGE');
    await expectError(e.svc.importCsv({ workspaceId: ws, dryRun: false }), 400, 'FILE_REQUIRED');
    await expectError(e.svc.importCsv({ workspaceId: ws, buffer: 'a,b', dryRun: false }), 400, 'FILE_REQUIRED');
    await expectError(e.svc.importCsv({ buffer: bom8(HEADER) }), 403, 'FORBIDDEN');
    expect(e.ProductTranslation.docs).toEqual([]);
    // a header-only file is a valid, empty import
    expect((await run(e, HEADER)).summary).toEqual({ rows: 0, updated: 0, unchanged: 0, unmatched: 0, invalid: 0 });
  });

  test('only this workspace is read, matched and written', async () => {
    const e = env();
    await run(e, lines(HEADER, `product,${e.coffee._id},,,قهوة,,`));
    for (const model of [e.Product, e.Service, e.ProductTranslation]) {
      for (const call of model.calls) expect(String(call.filter.workspaceId)).toBe(ws);
    }
    const other = await e.svc.importCsv({ workspaceId: String(WS_B), buffer: bom8(lines(HEADER, `product,${e.coffee._id},Arabic Coffee,,قهوة,,`)), dryRun: false });
    expect(other.summary.unmatched).toBe(1);
    expect(e.ProductTranslation.docs.every((d) => String(d.workspaceId) === ws)).toBe(true);
  });

  test('never logs names or any row content', async () => {
    const e = env();
    const spies = ['log', 'error', 'warn', 'info', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    try {
      await run(e, lines(HEADER, `product,${e.coffee._id},Secret Product Name,,اسم سري جدا,وصف سري,`, 'product,,No Such Thing Here,,اسم آخر,,'));
      await run(e, lines(HEADER, 'product,,Secret Product Name,,اسم سري جدا,,'), { dryRun: true });
      const logged = spies.flatMap((s) => s.mock.calls).map((args) => args.join(' ')).join('\n');
      expect(logged).not.toMatch(/Secret|سري|No Such Thing|اسم آخر/);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  test('writes run in bounded parallel batches (not one by one, not all at once)', async () => {
    const products = Array.from({ length: 120 }, (_, i) => item({ name: `Bulk ${i}` }));
    const e = env({ products });
    let inflight = 0;
    let peak = 0;
    e.ProductTranslation.hooks.beforeUpdate = async () => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inflight -= 1;
    };
    const res = await run(e, lines(HEADER, ...products.map((p, i) => `product,${p._id},,,اسم ${i},,`)));
    expect(res.summary.updated).toBe(120);
    expect(e.ProductTranslation.docs).toHaveLength(120);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(LIMITS.importConcurrency);
  });

  test('a row that was changed meanwhile is re-read before writing, so the report stays truthful', async () => {
    const e = env();
    e.ProductTranslation.hooks.beforeUpdate = (n, model) => {
      // another editor saves the very same text between the snapshot and this write
      if (n === 1) model.docs.push(translation('product', e.coffee._id, { name: 'قهوة', status: 'reviewed', reviewedBy: 'Noura', reviewedAt: NOW }));
      if (n === 1) throw dupKey();
    };
    const res = await run(e, lines(HEADER, `product,${e.coffee._id},,,قهوة,,`));
    expect(res.summary).toMatchObject({ updated: 0, unchanged: 1 });
    expect(e.ProductTranslation.docs[0].status).toBe('reviewed');
  });

  describe('one applying import per workspace at a time', () => {
    const slowEnv = () => {
      const e = env();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      e.Product.find = ((original) => (filter) => {
        const q = original(filter);
        const originalThen = q.then.bind(q);
        q.then = (res, rej) => gate.then(() => originalThen(res, rej));
        return q;
      })(e.Product.find);
      return { e, release };
    };
    const buffer = (e) => bom8(lines(HEADER, `product,${e.coffee._id},,,قهوة,,`));

    test('a second apply is refused with RATE_LIMITED while the first runs; previews and other workspaces are not', async () => {
      const { e, release } = slowEnv();
      const first = e.svc.importCsv({ workspaceId: ws, buffer: buffer(e), dryRun: false });
      await Promise.resolve();
      await expectError(e.svc.importCsv({ workspaceId: ws, buffer: buffer(e), dryRun: false }), 429, 'RATE_LIMITED');
      const preview = e.svc.importCsv({ workspaceId: ws, buffer: buffer(e), dryRun: true });
      const elsewhere = e.svc.importCsv({ workspaceId: String(WS_B), buffer: buffer(e), dryRun: false });
      release();
      await expect(first).resolves.toMatchObject({ summary: { updated: 1 } });
      await expect(preview).resolves.toMatchObject({ dryRun: true });
      await expect(elsewhere).resolves.toMatchObject({ dryRun: false });
      expect(e.ProductTranslation.docs.filter((d) => String(d.workspaceId) === ws)).toHaveLength(1);
      // the claim is released once the import is over
      await expect(e.svc.importCsv({ workspaceId: ws, buffer: buffer(e), dryRun: false })).resolves.toMatchObject({ summary: { unchanged: 1 } });
    });

    test('the claim is released when an import fails', async () => {
      const e = env();
      e.ProductTranslation.hooks.beforeUpdate = () => { throw new Error('connection lost'); };
      await expect(e.svc.importCsv({ workspaceId: ws, buffer: buffer(e), dryRun: false })).rejects.toThrow('connection lost');
      e.ProductTranslation.hooks.beforeUpdate = undefined;
      await expect(e.svc.importCsv({ workspaceId: ws, buffer: buffer(e), dryRun: false })).resolves.toMatchObject({ summary: { updated: 1 } });
    });
  });

  test('a failing write stops the remaining writes and surfaces the error', async () => {
    const products = Array.from({ length: 60 }, (_, i) => item({ name: `Bulk ${i}` }));
    const e = env({ products });
    e.ProductTranslation.hooks.beforeUpdate = (n) => { if (n === 3) throw new Error('throttled'); };
    await expect(run(e, lines(HEADER, ...products.map((p, i) => `product,${p._id},,,اسم ${i},,`)))).rejects.toThrow('throttled');
    expect(e.ProductTranslation.writes).toBeLessThan(60);
  });
});

// ── message-rendering helper ───────────────────────────────────────────────
describe('resolveItemNames / resolveItemName', () => {
  function env() {
    const reviewed = item({ name: 'Arabic Coffee' });
    const drafty = item({ name: 'Mint Tea' });
    const none = item({ name: 'Plain Water' });
    const blank = item({ name: 'Blank Name Item' });
    const spaces = item({ name: 'Spaces Item' });
    const theirs = item({ workspaceId: WS_B, name: 'Theirs' });
    const service = item({ name: 'Facial' });
    return {
      reviewed, drafty, none, blank, spaces, theirs, service,
      ...build({
        products: [reviewed, drafty, none, blank, spaces, theirs],
        services: [service],
        translations: [
          translation('product', reviewed._id, { name: 'قهوة عربية', status: 'reviewed' }),
          translation('product', drafty._id, { name: 'شاي بالنعناع', status: 'draft' }),
          translation('product', blank._id, { name: '', status: 'reviewed' }),
          translation('product', spaces._id, { name: '   ', status: 'reviewed' }),
          translation('product', theirs._id, { workspaceId: WS_B, name: 'عنصر', status: 'reviewed' }),
          translation('service', service._id, { name: 'عناية', status: 'reviewed' }),
          translation('service', reviewed._id, { name: 'خطأ: نوع آخر', status: 'reviewed' }), // same refId, other kind
        ],
      }),
    };
  }
  const ids = (...docs) => docs.map((d) => String(d._id));
  const resolve = (e, args) => e.svc.resolveItemNames({ workspaceId: ws, kind: 'product', language: 'ar', ...args });

  test('Arabic customers get the reviewed Arabic name; everything else falls back to English', async () => {
    const e = env();
    const names = await resolve(e, { ids: ids(e.reviewed, e.drafty, e.none, e.blank, e.spaces) });
    expect(Array.from(names)).toEqual([
      [String(e.reviewed._id), 'قهوة عربية'],
      [String(e.drafty._id), 'Mint Tea'],     // a draft is not good enough for a customer
      [String(e.none._id), 'Plain Water'],    // no translation
      [String(e.blank._id), 'Blank Name Item'], // empty Arabic name
      [String(e.spaces._id), 'Spaces Item'],    // whitespace-only Arabic name
    ]);
  });

  test('drafts are used only when the caller explicitly allows them', async () => {
    const e = env();
    const names = await resolve(e, { ids: ids(e.drafty), allowDraft: true });
    expect(names.get(String(e.drafty._id))).toBe('شاي بالنعناع');
    expect((await resolve(e, { ids: ids(e.drafty), allowDraft: false })).get(String(e.drafty._id))).toBe('Mint Tea');
  });

  test('English (or any other) language always returns the English name', async () => {
    const e = env();
    for (const language of ['en', 'fr', undefined, null, 'bilingual', '']) {
      const names = await resolve(e, { ids: ids(e.reviewed), language });
      expect(names.get(String(e.reviewed._id))).toBe('Arabic Coffee');
    }
    expect((await resolve(e, { ids: ids(e.reviewed), language: 'AR' })).get(String(e.reviewed._id))).toBe('قهوة عربية');
  });

  test('another workspace, unknown and malformed ids are simply absent', async () => {
    const e = env();
    const names = await resolve(e, { ids: [...ids(e.theirs), String(oid()), 'nonsense', '', null, undefined, { $ne: null }, 42, ['x']] });
    expect(names.size).toBe(0);
    const mixed = await resolve(e, { ids: [String(e.reviewed._id), 'nonsense', { $ne: null }] });
    expect(Array.from(mixed.keys())).toEqual([String(e.reviewed._id)]);
  });

  test('kinds do not leak into each other, even for the same id', async () => {
    const e = env();
    const asProduct = await resolve(e, { ids: ids(e.reviewed) });
    expect(asProduct.get(String(e.reviewed._id))).toBe('قهوة عربية');
    const asService = await e.svc.resolveItemNames({ workspaceId: ws, kind: 'service', ids: ids(e.service), language: 'ar' });
    expect(asService.get(String(e.service._id))).toBe('عناية');
    expect((await e.svc.resolveItemNames({ workspaceId: ws, kind: 'service', ids: ids(e.reviewed), language: 'ar' })).size).toBe(0);
  });

  test('ids may repeat, arrive as ObjectIds or upper-case hex; keys are lower-case hex strings', async () => {
    const e = env();
    const names = await resolve(e, { ids: [e.reviewed._id, String(e.reviewed._id).toUpperCase(), String(e.reviewed._id)] });
    expect(Array.from(names.keys())).toEqual([String(e.reviewed._id)]);
    expect(await resolve(e, { ids: [] })).toEqual(new Map());
    expect(e.ProductTranslation.calls.filter((c) => c.op === 'find')).toHaveLength(1); // the empty call did not query
  });

  test('queries are scoped to the workspace and kind and ask for reviewed translations only by default', async () => {
    const e = env();
    await resolve(e, { ids: ids(e.reviewed) });
    const [itemCall] = e.Product.calls;
    expect(String(itemCall.filter.workspaceId)).toBe(ws);
    const [trCall] = e.ProductTranslation.calls;
    expect(trCall.filter).toMatchObject({ kind: 'product', language: 'ar', status: 'reviewed' });
    expect(String(trCall.filter.workspaceId)).toBe(ws);
    await resolve(e, { ids: ids(e.reviewed), allowDraft: true });
    expect(e.ProductTranslation.calls[1].filter).not.toHaveProperty('status');
    await resolve(e, { ids: ids(e.reviewed), language: 'en' });
    expect(e.ProductTranslation.calls).toHaveLength(2); // English never reads translations
  });

  test('resolveItemName returns the single name, or null when there is none', async () => {
    const e = env();
    const one = (id, extra = {}) => e.svc.resolveItemName({ workspaceId: ws, kind: 'product', id, language: 'ar', ...extra });
    expect(await one(String(e.reviewed._id))).toBe('قهوة عربية');
    expect(await one(String(e.reviewed._id), { language: 'en' })).toBe('Arabic Coffee');
    expect(await one(String(e.theirs._id))).toBeNull();
    expect(await one('nonsense')).toBeNull();
    expect(await one(undefined)).toBeNull();
  });

  test('the contract\'s positional spelling works too: (workspaceId, kind, ids, language) and (…, { allowDraft })', async () => {
    const e = env();
    const names = await e.svc.resolveItemNames(ws, 'product', ids(e.reviewed, e.drafty), 'ar');
    expect(Array.from(names)).toEqual([[String(e.reviewed._id), 'قهوة عربية'], [String(e.drafty._id), 'Mint Tea']]);
    const withDraft = await e.svc.resolveItemNames(WS_A, 'product', ids(e.drafty), 'ar', { allowDraft: true }); // an ObjectId workspace id is fine
    expect(withDraft.get(String(e.drafty._id))).toBe('شاي بالنعناع');
    expect(await e.svc.resolveItemName(ws, 'product', String(e.reviewed._id), 'ar')).toBe('قهوة عربية');
    expect(await e.svc.resolveItemName(ws, 'product', String(e.drafty._id), 'ar', { allowDraft: true })).toBe('شاي بالنعناع');
    expect(await e.svc.resolveItemName(ws, 'product', String(e.drafty._id), 'ar')).toBe('Mint Tea');
    expect(await e.svc.resolveItemName(ws, 'product', String(e.theirs._id), 'ar')).toBeNull();
    // the options argument cannot smuggle in another workspace
    const smuggle = await e.svc.resolveItemNames(ws, 'product', ids(e.theirs), 'ar', { workspaceId: String(WS_B), allowDraft: true });
    expect(smuggle.size).toBe(0);
  });

  test('bad arguments are rejected', async () => {
    const e = env();
    await expectError(e.svc.resolveItemNames({ workspaceId: ws, kind: 'product', ids: 'abc', language: 'ar' }), 400, 'INVALID_INPUT');
    await expectError(e.svc.resolveItemNames({ workspaceId: ws, kind: 'product', ids: { $ne: null }, language: 'ar' }), 400, 'INVALID_INPUT');
    await expectError(e.svc.resolveItemNames({ workspaceId: ws, kind: 'order', ids: [], language: 'ar' }), 400, 'INVALID_INPUT');
    await expectError(e.svc.resolveItemNames({ workspaceId: ws, kind: 'product', ids: Array.from({ length: LIMITS.resolveIds + 1 }, () => String(oid())), language: 'ar' }), 400, 'INVALID_INPUT');
    await expect(e.svc.resolveItemNames({ kind: 'product', ids: [], language: 'ar' })).rejects.toThrow('workspaceId is required');
    await expect(e.svc.resolveItemNames()).rejects.toThrow();
  });

  test('only reads: no write method of any model is ever called', async () => {
    const e = env();
    await resolve(e, { ids: ids(e.reviewed, e.drafty) });
    for (const model of [e.Product, e.Service, e.ProductTranslation]) {
      expect(model.calls.every((c) => c.op === 'find')).toBe(true);
    }
  });
});

// ── guards ─────────────────────────────────────────────────────────────────
describe('module guarantees', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
  const sources = ['shared/localization/catalogTranslations.js', 'routes/localization/catalog.js'];

  test.each(sources)('%s contains no delete operation (standing rule: nothing is ever removed from the database)', (rel) => {
    expect(read(rel)).not.toMatch(/\b(deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|findOneAndRemove|findByIdAndRemove|dropDatabase|dropCollection)\b|\.(remove|drop|destroy)\(/);
  });

  test.each(sources)('%s never writes the existing Product/Service models', (rel) => {
    expect(read(rel)).not.toMatch(/\b(Product|Service)\.(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|replaceOne|bulkWrite|save)\b/);
  });

  test('requiring the module loads no Mongoose model (the real ones are bound on first use)', () => {
    expect(mongoose.modelNames()).not.toEqual(expect.arrayContaining(['ProductTranslation']));
    expect(Object.keys(catalogModule)).toEqual(expect.arrayContaining([
      'listItems', 'saveTranslation', 'reviewTranslation', 'exportCsv', 'importCsv', 'resolveItemNames', 'resolveItemName', 'createCatalogService',
    ]));
  });

  test('the CSV columns are the documented ones and the limits match the brief', () => {
    expect(LIMITS).toMatchObject({ nameMax: 200, descriptionMax: 2000, reportRows: 200, pageMax: 200 });
    expect(Object.isFrozen(LIMITS)).toBe(true);
  });
});

// parseCsv is only here to keep the import honest about the shared reader's line numbering
test('the report numbers lines like the shared CSV reader (header = line 1)', async () => {
  const a = item({ name: 'A' });
  const b = item({ name: 'B' });
  const e = build({ products: [a, b] });
  const text = lines('name,name_ar', 'A,ألف', 'B,باء');
  const reader = parseCsv(text).rows.map((r) => r._line);
  const res = await e.svc.importCsv({ workspaceId: ws, buffer: bom8(text), dryRun: true });
  expect(res.rows.map((r) => r.line)).toEqual(reader);
});
