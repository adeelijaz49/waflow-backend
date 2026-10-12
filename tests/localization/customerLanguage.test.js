// Customers' languages service: list/search/counts, single + bulk set, CSV import
// and export. Every collaborator is an in-memory fake (see helpers/fakeMongo.js) —
// no database, no network, nothing is ever deleted.
const fs = require('fs');
const path = require('path');
const svc = require('../../shared/localization/customerLanguage');
const { parseCsv, parseRows, BOM } = require('../../shared/localization/csv');
const { FakeModel, oid } = require('./helpers/fakeMongo');

const W1 = oid(0xa1);
const W2 = oid(0xa2);
const USER = oid(0xbb);
let seq = 0x1000;

const cust = (firstname, lastname, phone, extra = {}, workspaceId = W1) => ({ _id: oid(seq++), workspaceId, firstname, lastname, phone, ...extra });
const lang = (customer, language, languageSource, extra = {}) => ({ _id: oid(seq++), workspaceId: customer.workspaceId, customerId: customer._id, language, languageSource, ...extra });

function world({ customers = [], languages = [], merchantDefault = 'en', countryCode, limits } = {}) {
  const Customer = new FakeModel(customers);
  const CustomerLanguage = new FakeModel(languages, { unique: ['workspaceId', 'customerId'], defaults: { language: 'unknown', inferenceAttempts: 0 } });
  const Settings = new FakeModel(countryCode ? [{ workspaceId: W1, defaultCountryCode: countryCode }] : []);
  const localeSettings = { getSettings: jest.fn(async () => ({ defaultCustomerLanguage: merchantDefault })) };
  const deps = { Customer, CustomerLanguage, Settings, localeSettings };
  if (limits) deps.limits = limits;
  return { deps, Customer, CustomerLanguage, Settings, localeSettings };
}

// Every query and write the service made carried the caller's workspace.
function expectScoped(w, workspaceId = W1) {
  for (const model of [w.Customer, w.CustomerLanguage, w.Settings]) {
    for (const call of model.calls) {
      if (call.method === 'bulkWrite') for (const op of call.operations) expect(String(op.updateOne.filter.workspaceId)).toBe(workspaceId);
      else expect(String(call.filter.workspaceId)).toBe(workspaceId);
    }
  }
}

async function rejection(promise) {
  try { await promise; } catch (err) { return err; }
  throw new Error('expected a rejection');
}

// ── list ───────────────────────────────────────────────────────────────────

function listWorld(extra = {}) {
  const c = {
    zed: cust('Zed', 'Last', '966500000001'),
    adam: cust('adam', 'first', '966500000002'),
    sara: cust('سارة', 'أحمد', '966500000003'),
    mohammed: cust('محمد', 'العتيبي', '966500000004'),
    mona: cust('Mona', 'Mona', '966500000005'),
    emoji: cust('😀', 'Emoji', '966500000006'),
    erased: cust('Deleted', 'Customer', 'deleted-x', { deletedAt: new Date('2026-01-01') }),
    demo: cust('Demo', 'Person', '61400000001', { isDemo: true }),
    other: cust('Other', 'Tenant', '966500000001', {}, W2),
    consented: cust('Consented', 'Person', '966500000007', { marketingConsent: true }),
    optedOut: cust('OptedOut', 'Person', '966500000008', { optedOut: true }),
    notDemo: cust('NotDemo', 'Person', '966500000009', { isDemo: false }),
  };
  const languages = [
    lang(c.sara, 'ar', 'inferred'),
    lang(c.mohammed, 'ar', 'customer_chose'),
    lang(c.zed, 'en', 'merchant_set'),
    lang(c.adam, 'unknown'),
    lang(c.erased, 'ar', 'merchant_set'),
    lang(c.demo, 'en', 'merchant_set'),
    lang(c.other, 'ar', 'merchant_set'),
  ];
  return { c, ...world({ customers: Object.values(c), languages, ...extra }) };
}

const names = (result) => result.items.map((i) => i.name);
const ALL_NAMES = ['Consented Person', 'Mona', 'NotDemo Person', 'OptedOut Person', 'Zed Last', 'adam first', 'سارة أحمد', 'محمد العتيبي', '😀 Emoji'];

describe('listCustomers', () => {
  test('a database that refuses the multi-field name sort (Cosmos DB without a compound index) still lists the page, with the single-field sort the existing customers list uses', async () => {
    const w = listWorld();
    const sorts = [];
    const find = w.Customer.find.bind(w.Customer);
    w.Customer.find = (filter) => {
      const q = find(filter);
      const run = q.run;
      q.run = (self) => {
        sorts.push(Object.keys(self.order || {}));
        if (self.order && Object.keys(self.order).length > 1) throw Object.assign(new Error('The index path corresponding to the specified order-by item is excluded.'), { code: 2 });
        return run(self);
      };
      return q;
    };
    const res = await svc.listCustomers({ workspaceId: W1 }, w.deps);
    expect(sorts.filter((keys) => keys.length)).toEqual([['firstname', 'lastname', '_id'], ['firstname']]);
    expect(res.items).toHaveLength(9);
    expectScoped(w);
  });

  test('lists the managed customers (not erased, not demo, not another workspace), sorted by name in binary order', async () => {
    const w = listWorld();
    const res = await svc.listCustomers({ workspaceId: W1 }, w.deps);
    expect(names(res)).toEqual(ALL_NAMES);
    expect(res.total).toBe(9);
    expect(res.page).toBe(1);
    expect(res.limit).toBe(50);
    expectScoped(w);
  });

  test('a row carries language, source, effective language, consent and opt-out', async () => {
    const w = listWorld();
    const res = await svc.listCustomers({ workspaceId: W1 }, w.deps);
    const byName = Object.fromEntries(res.items.map((i) => [i.name, i]));
    expect(byName['سارة أحمد']).toEqual({
      id: w.c.sara._id, name: 'سارة أحمد', phone: '966500000003', language: 'ar', languageSource: 'inferred', effectiveLanguage: 'ar', marketingConsent: false, optedOut: false,
    });
    expect(byName['Zed Last']).toMatchObject({ language: 'en', languageSource: 'merchant_set', effectiveLanguage: 'en' });
    expect(byName['Consented Person']).toMatchObject({ marketingConsent: true, optedOut: false });
    expect(byName['OptedOut Person']).toMatchObject({ marketingConsent: false, optedOut: true });
  });

  test('no document -> unknown / null source; the effective language follows customer -> merchant default -> en', async () => {
    const en = await svc.listCustomers({ workspaceId: W1 }, listWorld({ merchantDefault: 'en' }).deps);
    const ar = await svc.listCustomers({ workspaceId: W1 }, listWorld({ merchantDefault: 'ar' }).deps);
    const pick = (res, name) => res.items.find((i) => i.name === name);
    expect(pick(en, 'Mona')).toMatchObject({ language: 'unknown', languageSource: null, effectiveLanguage: 'en' });
    expect(pick(ar, 'Mona')).toMatchObject({ language: 'unknown', languageSource: null, effectiveLanguage: 'ar' });
    expect(pick(ar, 'adam first')).toMatchObject({ language: 'unknown', effectiveLanguage: 'ar' }); // a stored 'unknown' document
    expect(pick(ar, 'Zed Last')).toMatchObject({ language: 'en', effectiveLanguage: 'en' }); // the customer's own language wins
    expect(pick(en, 'سارة أحمد')).toMatchObject({ language: 'ar', effectiveLanguage: 'ar' });
  });

  test('an invalid merchant default still resolves to English', async () => {
    const res = await svc.listCustomers({ workspaceId: W1 }, listWorld({ merchantDefault: 'xx' }).deps);
    expect(res.items.find((i) => i.name === 'Mona').effectiveLanguage).toBe('en');
  });

  test('a one-word name is shown once; a name-less customer falls back to the phone', async () => {
    const w = world({ customers: [cust('Mona', 'Mona', '1'), cust('Sara', 'Ahmed', '2'), cust('', '', '966500000009'), cust('Ali', 'Ali', '4', {}, W1)] });
    const res = await svc.listCustomers({ workspaceId: W1 }, w.deps);
    expect(names(res).sort()).toEqual(['966500000009', 'Ali', 'Mona', 'Sara Ahmed']);
  });

  test('sort order: uppercase Latin, lowercase Latin, Arabic, then astral characters (code point order, like MongoDB)', async () => {
    const w = world({ customers: [cust('😀', 'x', '1'), cust('ｆull', 'x', '2'), cust('b', 'x', '3'), cust('B', 'x', '4'), cust('ب', 'x', '5'), cust('أ', 'x', '6')] });
    const res = await svc.listCustomers({ workspaceId: W1 }, w.deps);
    expect(res.items.map((i) => i.name.split(' ')[0])).toEqual(['B', 'b', 'أ', 'ب', 'ｆull', '😀']);
  });

  test('ties on the first name are broken by last name, then _id, so paging is stable', async () => {
    const a = cust('Sam', 'Zed', '1');
    const b = cust('Sam', 'Alpha', '2');
    const c = cust('Sam', 'Alpha', '3');
    const w = world({ customers: [a, c, b] });
    const res = await svc.listCustomers({ workspaceId: W1 }, w.deps);
    expect(res.items.map((i) => i.id)).toEqual([b._id, c._id, a._id]);
  });

  describe('language filter', () => {
    test.each([
      ['ar', ['سارة أحمد', 'محمد العتيبي']],
      ['en', ['Zed Last']],
      ['unknown', ['Consented Person', 'Mona', 'NotDemo Person', 'OptedOut Person', 'adam first', '😀 Emoji']],
      ['all', ALL_NAMES],
    ])('%s', async (language, expected) => {
      const w = listWorld();
      const res = await svc.listCustomers({ workspaceId: W1, language }, w.deps);
      expect(names(res)).toEqual(expected);
      expect(res.total).toBe(expected.length);
      expectScoped(w);
    });

    test('unknown = customers with no document AND customers with a stored unknown document', async () => {
      const w = listWorld();
      const res = await svc.listCustomers({ workspaceId: W1, language: 'unknown' }, w.deps);
      expect(names(res)).toContain('adam first'); // stored unknown
      expect(names(res)).toContain('Mona'); // no document
      expect(names(res)).not.toContain('Zed Last');
    });

    test('a class nobody is in is an empty page, not everyone', async () => {
      const w = world({ customers: [cust('A', 'B', '1')] });
      const res = await svc.listCustomers({ workspaceId: W1, language: 'ar' }, w.deps);
      expect(res).toMatchObject({ items: [], total: 0 });
    });

    test('erased and demo customers with a language never appear, and are not counted', async () => {
      const w = listWorld();
      const ar = await svc.listCustomers({ workspaceId: W1, language: 'ar' }, w.deps);
      expect(names(ar)).not.toContain('Deleted Customer');
      expect(ar.counts.ar).toBe(2);
      const en = await svc.listCustomers({ workspaceId: W1, language: 'en' }, w.deps);
      expect(names(en)).not.toContain('Demo Person');
      expect(en.counts.en).toBe(1);
    });

    test.each([['fr'], ['AR'], ['xx'], [{ $ne: 'ar' }], [['ar']], [1]])('invalid value %j -> 400 INVALID_LANGUAGE', async (value) => {
      const err = await rejection(svc.listCustomers({ workspaceId: W1, language: value }, listWorld().deps));
      expect(err).toMatchObject({ status: 400, code: 'INVALID_LANGUAGE' });
    });

    test('missing / empty language means all', async () => {
      const w = listWorld();
      for (const language of [undefined, null, '']) {
        expect((await svc.listCustomers({ workspaceId: W1, language }, w.deps)).total).toBe(9);
      }
    });

    test('the big-class fallback returns exactly what the $in/$nin path returns (every filter, search, page)', async () => {
      const cases = [
        { language: 'ar' }, { language: 'en' }, { language: 'unknown' }, { language: 'unknown', limit: 2, page: 2 }, { language: 'unknown', limit: 2, page: 3 },
        { language: 'ar', search: 'محمد' }, { language: 'unknown', search: 'person' }, { language: 'unknown', search: 'zzz' }, { language: 'ar', limit: 1, page: 2 },
      ];
      for (const args of cases) {
        const normal = await svc.listCustomers({ workspaceId: W1, ...args }, listWorld().deps);
        const w = listWorld({ limits: { clauseMax: 0 } });
        const fallback = await svc.listCustomers({ workspaceId: W1, ...args }, w.deps);
        expect(fallback.items).toEqual(normal.items.map((i) => ({ ...i, id: expect.any(String) })));
        expect(fallback.total).toBe(normal.total);
        expect(names(fallback)).toEqual(names(normal));
        expectScoped(w);
      }
    });

    test('the fallback never sends a big id list to the database', async () => {
      const many = Array.from({ length: 30 }, (_, i) => cust(`N${String(i).padStart(2, '0')}`, 'X', `96650000${1000 + i}`));
      const w = world({ customers: many, languages: many.map((c) => lang(c, 'ar', 'csv_import')), limits: { clauseMax: 10 } });
      const res = await svc.listCustomers({ workspaceId: W1, language: 'ar', limit: 5, page: 2 }, w.deps);
      expect(res.total).toBe(30);
      expect(res.items.map((i) => i.name)).toEqual(['N05 X', 'N06 X', 'N07 X', 'N08 X', 'N09 X']);
      for (const call of w.Customer.calls) {
        const ids = call.filter._id && (call.filter._id.$in || call.filter._id.$nin);
        if (ids) expect(ids.length).toBeLessThanOrEqual(5); // only the page's ids
      }
    });

    test('a small class uses one $in query on the page query (no per-customer lookups)', async () => {
      const w = listWorld();
      await svc.listCustomers({ workspaceId: W1, language: 'ar' }, w.deps);
      const idFilters = w.Customer.calls.map((c) => c.filter._id).filter(Boolean);
      // the workspace has three Arabic rows (one belongs to an erased customer, which the base filter then drops)
      expect(idFilters.filter((f) => f.$in && f.$in.length === 3)).toHaveLength(2); // the page query and its count
    });
  });

  describe('pagination', () => {
    const many = () => Array.from({ length: 120 }, (_, i) => cust(`P${String(i).padStart(3, '0')}`, 'Q', `966${String(100000000 + i)}`));

    test('pages are contiguous, stable and cover everything exactly once', async () => {
      const w = world({ customers: many() });
      const seen = [];
      for (let page = 1; page <= 3; page += 1) {
        const res = await svc.listCustomers({ workspaceId: W1, page, limit: 50 }, w.deps);
        expect(res.total).toBe(120);
        seen.push(...res.items.map((i) => i.name));
      }
      expect(seen).toEqual(many().map((c) => `${c.firstname} Q`));
    });

    test.each([
      [{ page: 0 }, { page: 1, limit: 50 }], [{ page: -5 }, { page: 1, limit: 50 }], [{ page: 'x' }, { page: 1, limit: 50 }], [{ page: '2' }, { page: 2, limit: 50 }],
      [{ limit: 0 }, { page: 1, limit: 1 }], [{ limit: -3 }, { page: 1, limit: 1 }], [{ limit: 1000 }, { page: 1, limit: 200 }], [{ limit: 'abc' }, { page: 1, limit: 50 }], [{ limit: '25' }, { page: 1, limit: 25 }],
      [{ page: 99999999 }, { page: 100000, limit: 50 }], [{ page: ['2', '3'] }, { page: 2, limit: 50 }], [{ limit: { a: 1 } }, { page: 1, limit: 50 }],
    ])('page/limit %j is clamped to %j', async (input, expected) => {
      const w = world({ customers: many() });
      const res = await svc.listCustomers({ workspaceId: W1, ...input }, w.deps);
      expect(res).toMatchObject(expected);
      expect(res.items.length).toBeLessThanOrEqual(expected.limit);
    });

    test('a page past the end is empty but keeps the true total', async () => {
      const w = world({ customers: many() });
      const res = await svc.listCustomers({ workspaceId: W1, page: 50 }, w.deps);
      expect(res).toMatchObject({ items: [], total: 120 });
    });
  });

  describe('search', () => {
    test('is Arabic-aware (alef/teh-marbuta variants, tashkeel, digits) and ANDs the tokens', async () => {
      const w = listWorld();
      expect(names(await svc.listCustomers({ workspaceId: W1, search: 'احمد' }, w.deps))).toEqual(['سارة أحمد']);
      expect(names(await svc.listCustomers({ workspaceId: W1, search: 'أحمد سارة' }, w.deps))).toEqual(['سارة أحمد']);
      expect(names(await svc.listCustomers({ workspaceId: W1, search: 'سارَة' }, w.deps))).toEqual(['سارة أحمد']);
      expect(names(await svc.listCustomers({ workspaceId: W1, search: 'ساره' }, w.deps))).toEqual(['سارة أحمد']);
      expect(names(await svc.listCustomers({ workspaceId: W1, search: 'سارة محمد' }, w.deps))).toEqual([]);
      expect(names(await svc.listCustomers({ workspaceId: W1, search: 'zed last' }, w.deps))).toEqual(['Zed Last']);
    });

    test('phone search in every format, Arabic-Indic digits included; never another workspace', async () => {
      const w = listWorld();
      for (const term of ['966500000003', '0500000003', '+966 50 000 0003', '٠٥٠٠٠٠٠٠٠٣', '00966500000003']) {
        expect(names(await svc.listCustomers({ workspaceId: W1, search: term }, w.deps))).toEqual(['سارة أحمد']);
      }
      // 966500000001 belongs to Zed (W1) AND to a W2 customer: only W1's is visible
      expect(names(await svc.listCustomers({ workspaceId: W1, search: '966500000001' }, w.deps))).toEqual(['Zed Last']);
      expect(names(await svc.listCustomers({ workspaceId: W2, search: '966500000001' }, w.deps))).toEqual(['Other Tenant']);
    });

    test("the workspace's own country code is used (Settings.defaultCountryCode)", async () => {
      const au = world({ customers: [cust('Bob', 'Aus', '61412345678'), cust('Sue', 'Aus', '0412345678')], countryCode: '61' });
      expect(names(await svc.listCustomers({ workspaceId: W1, search: '+61 412 345 678' }, au.deps)).sort()).toEqual(['Bob Aus', 'Sue Aus']);
      const sa = world({ customers: [cust('Bob', 'Aus', '61412345678'), cust('Sue', 'Aus', '0412345678')] }); // no Settings doc -> 966
      expect(names(await svc.listCustomers({ workspaceId: W1, search: '+61 412 345 678' }, sa.deps))).toEqual(['Bob Aus']);
    });

    test('Settings is only read when there is something to search for', async () => {
      const w = listWorld();
      await svc.listCustomers({ workspaceId: W1 }, w.deps);
      await svc.listCustomers({ workspaceId: W1, search: '   ' }, w.deps);
      expect(w.Settings.calls).toHaveLength(0);
      await svc.listCustomers({ workspaceId: W1, search: 'zed' }, w.deps);
      expect(w.Settings.calls).toHaveLength(1);
    });

    test('combines with the language filter and paging; total counts the matches', async () => {
      const w = listWorld();
      const res = await svc.listCustomers({ workspaceId: W1, search: 'person', language: 'unknown', limit: 2, page: 2 }, w.deps);
      expect(names(res)).toEqual(['OptedOut Person']);
      expect(res.total).toBe(3);
    });

    test('counts ignore the search term', async () => {
      const w = listWorld();
      const res = await svc.listCustomers({ workspaceId: W1, search: 'zed' }, w.deps);
      expect(res.items).toHaveLength(1);
      expect(res.counts).toEqual({ en: 1, ar: 2, unknown: 6, total: 9 });
    });

    test('hostile terms never throw and are never pattern syntax (nothing matches them literally)', async () => {
      const w = listWorld();
      for (const term of ['(', '[', '.*', '\\', '^', 'a|b', '"; drop"', '{"$ne":null}']) {
        const res = await svc.listCustomers({ workspaceId: W1, search: term }, w.deps);
        expect(res.items.length).toBe(0);
        expect(res.total).toBe(0);
      }
    });

    test('edge punctuation is trimmed, so "(?i)" simply searches for "i" and "$ne" for "ne"', async () => {
      const w = listWorld();
      for (const [hostile, plain] of [['(?i)', 'i'], ['$ne', 'ne'], ['^zed$', 'zed'], ['(a+)+$', 'a']]) {
        const a = await svc.listCustomers({ workspaceId: W1, search: hostile }, w.deps);
        const b = await svc.listCustomers({ workspaceId: W1, search: plain }, w.deps);
        expect(names(a)).toEqual(names(b));
      }
    });

    test.each([[{ $ne: '' }], [['a']], [5]])('a non-string search %j -> 400 INVALID_INPUT', async (term) => {
      const err = await rejection(svc.listCustomers({ workspaceId: W1, search: term }, listWorld().deps));
      expect(err).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    });
  });

  test('without a workspace nothing is queried', async () => {
    const w = listWorld();
    const err = await rejection(svc.listCustomers({ workspaceId: undefined }, w.deps));
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(w.Customer.calls).toHaveLength(0);
    expect(w.CustomerLanguage.calls).toHaveLength(0);
  });
});

// ── counts ─────────────────────────────────────────────────────────────────

describe('getCounts', () => {
  test('en / ar / unknown / total over the managed customers only', async () => {
    const w = listWorld();
    expect(await svc.getCounts(W1, w.deps)).toEqual({ en: 1, ar: 2, unknown: 6, total: 9 });
    expectScoped(w);
  });

  test('another workspace is counted separately', async () => {
    const w = listWorld();
    expect(await svc.getCounts(W2, w.deps)).toEqual({ en: 0, ar: 1, unknown: 0, total: 1 });
  });

  test('everyone is unknown when no language was ever stored (and no extra lookups run)', async () => {
    const w = world({ customers: [cust('A', 'B', '1'), cust('C', 'D', '2')] });
    expect(await svc.getCounts(W1, w.deps)).toEqual({ en: 0, ar: 0, unknown: 2, total: 2 });
    expect(w.Customer.calls.filter((c) => c.method === 'find')).toHaveLength(0);
  });

  test('sidecar rows of many erased/demo customers are subtracted in id chunks', async () => {
    const real = Array.from({ length: 5 }, (_, i) => cust(`R${i}`, 'x', `${i}`));
    const demos = Array.from({ length: 1500 }, (_, i) => cust(`D${i}`, 'x', `d${i}`, { isDemo: true }));
    const w = world({ customers: [...real, ...demos], languages: [...real.slice(0, 2).map((c) => lang(c, 'ar')), ...demos.map((c) => lang(c, 'en'))] });
    expect(await svc.getCounts(W1, w.deps)).toEqual({ en: 0, ar: 2, unknown: 3, total: 5 });
    const chunked = w.CustomerLanguage.calls.filter((c) => c.filter.customerId && c.filter.customerId.$in);
    expect(chunked.length).toBeGreaterThanOrEqual(2); // 1500 ids -> 1000 + 500 per language
    for (const call of chunked) expect(call.filter.customerId.$in.length).toBeLessThanOrEqual(1000);
  });

  test('never negative, even if the data is odd', async () => {
    const c = cust('A', 'B', '1');
    const w = world({ customers: [c], languages: [lang(c, 'ar'), { ...lang(c, 'ar'), _id: oid(seq++), customerId: oid(0xdead) }, { ...lang(c, 'en'), _id: oid(seq++), customerId: oid(0xbeef) }] });
    const counts = await svc.getCounts(W1, w.deps);
    expect(counts.unknown).toBe(0);
    expect(counts.total).toBe(1);
  });
});

// ── single set ─────────────────────────────────────────────────────────────

describe('setCustomerLanguage', () => {
  test('creates the document: merchant_set, updatedBy, defaults; returns the row', async () => {
    const c = cust('سارة', 'أحمد', '966500000003');
    const w = world({ customers: [c] });
    const row = await svc.setCustomerLanguage({ workspaceId: W1, customerId: c._id, language: 'ar', userId: USER }, w.deps);
    expect(row).toMatchObject({ id: c._id, name: 'سارة أحمد', language: 'ar', languageSource: 'merchant_set', effectiveLanguage: 'ar' });
    expect(w.CustomerLanguage.docs).toHaveLength(1);
    expect(w.CustomerLanguage.docs[0]).toMatchObject({ workspaceId: W1, customerId: c._id, language: 'ar', languageSource: 'merchant_set', updatedBy: USER, inferenceAttempts: 0 });
    expectScoped(w);
  });

  test('overrides ANY existing source, customer_chose included (an explicit merchant act)', async () => {
    for (const source of ['inferred', 'csv_import', 'merchant_set', 'customer_chose']) {
      const c = cust('A', 'B', '1');
      const w = world({ customers: [c], languages: [lang(c, 'ar', source)] });
      const row = await svc.setCustomerLanguage({ workspaceId: W1, customerId: c._id, language: 'en', userId: USER }, w.deps);
      expect(row).toMatchObject({ language: 'en', languageSource: 'merchant_set' });
      expect(w.CustomerLanguage.docs).toHaveLength(1);
    }
  });

  test('unknown keeps/creates the document with languageSource null so inference can still fill it', async () => {
    const created = cust('A', 'B', '1');
    const kept = cust('C', 'D', '2');
    const w = world({ customers: [created, kept], languages: [lang(kept, 'ar', 'merchant_set')] });
    const a = await svc.setCustomerLanguage({ workspaceId: W1, customerId: created._id, language: 'unknown', userId: USER }, w.deps);
    const b = await svc.setCustomerLanguage({ workspaceId: W1, customerId: kept._id, language: 'unknown', userId: USER }, w.deps);
    for (const row of [a, b]) expect(row).toMatchObject({ language: 'unknown', languageSource: null, effectiveLanguage: 'en' });
    expect(w.CustomerLanguage.docs).toHaveLength(2);
    expect(w.CustomerLanguage.docs.every((d) => d.language === 'unknown' && d.languageSource === null)).toBe(true);
  });

  test('the effective language of the returned row uses the merchant default', async () => {
    const c = cust('A', 'B', '1');
    const w = world({ customers: [c], merchantDefault: 'ar' });
    expect(await svc.setCustomerLanguage({ workspaceId: W1, customerId: c._id, language: 'unknown' }, w.deps)).toMatchObject({ effectiveLanguage: 'ar' });
  });

  test.each([
    ['another workspace', (c) => ({ customerId: c.other._id })],
    ['an erased customer', (c) => ({ customerId: c.erased._id })],
    ['a demo customer', (c) => ({ customerId: c.demo._id })],
    ['a customer that does not exist', () => ({ customerId: oid(0xfeed) })],
  ])('%s -> 404 CUSTOMER_NOT_FOUND and nothing is written', async (label, pickTarget) => {
    const w = listWorld();
    const before = w.CustomerLanguage.docs.map((d) => ({ ...d }));
    const err = await rejection(svc.setCustomerLanguage({ workspaceId: W1, language: 'ar', userId: USER, ...pickTarget(w.c) }, w.deps));
    expect(err).toMatchObject({ status: 404, code: 'CUSTOMER_NOT_FOUND' });
    expect(w.CustomerLanguage.docs).toEqual(before);
    expect(w.CustomerLanguage.calls.filter((c) => c.method === 'findOneAndUpdate')).toHaveLength(0);
  });

  test.each([['abc'], [''], [undefined], [null], [{ $ne: null }], [{ $gt: '' }], [['x']], [oid(1).slice(1)], [`${oid(1)}0`], [42]])('invalid id %j -> 400 INVALID_ID before any query', async (id) => {
    const w = world({ customers: [cust('A', 'B', '1')] });
    const err = await rejection(svc.setCustomerLanguage({ workspaceId: W1, customerId: id, language: 'ar' }, w.deps));
    expect(err).toMatchObject({ status: 400, code: 'INVALID_ID' });
    expect(w.Customer.calls).toHaveLength(0);
  });

  test.each([['fr'], ['AR'], [''], [undefined], [null], [{ $ne: 'ar' }], [['ar']], ['all']])('invalid language %j -> 400 INVALID_LANGUAGE before any query', async (language) => {
    const c = cust('A', 'B', '1');
    const w = world({ customers: [c] });
    const err = await rejection(svc.setCustomerLanguage({ workspaceId: W1, customerId: c._id, language }, w.deps));
    expect(err).toMatchObject({ status: 400, code: 'INVALID_LANGUAGE' });
    expect(w.Customer.calls).toHaveLength(0);
  });

  test('updatedBy is only stored when it is a valid id', async () => {
    const c = cust('A', 'B', '1');
    const w = world({ customers: [c] });
    await svc.setCustomerLanguage({ workspaceId: W1, customerId: c._id, language: 'ar', userId: 'not-an-id' }, w.deps);
    expect(w.CustomerLanguage.docs[0].updatedBy).toBeUndefined();
  });

  test('a double click (concurrent identical requests) leaves exactly one document', async () => {
    const c = cust('A', 'B', '1');
    const w = world({ customers: [c] });
    const [a, b] = await Promise.all([
      svc.setCustomerLanguage({ workspaceId: W1, customerId: c._id, language: 'ar', userId: USER }, w.deps),
      svc.setCustomerLanguage({ workspaceId: W1, customerId: c._id, language: 'ar', userId: USER }, w.deps),
    ]);
    expect(a.language).toBe('ar');
    expect(b.language).toBe('ar');
    expect(w.CustomerLanguage.docs).toHaveLength(1);
  });

  test('losing an insert race (E11000) is retried once and the winner row is updated', async () => {
    const c = cust('A', 'B', '1');
    const w = world({ customers: [c] });
    let armed = true;
    w.CustomerLanguage.hooks.loseInsertRace = (model) => {
      if (!armed) return false;
      armed = false;
      model.insert({ workspaceId: W1, customerId: c._id, language: 'en', languageSource: 'inferred' });
      return true;
    };
    const row = await svc.setCustomerLanguage({ workspaceId: W1, customerId: c._id, language: 'ar', userId: USER }, w.deps);
    expect(row).toMatchObject({ language: 'ar', languageSource: 'merchant_set' });
    expect(w.CustomerLanguage.docs).toHaveLength(1);
    expect(w.CustomerLanguage.docs[0]).toMatchObject({ language: 'ar', languageSource: 'merchant_set' });
  });

  test('other database errors are not swallowed', async () => {
    const c = cust('A', 'B', '1');
    const w = world({ customers: [c] });
    w.CustomerLanguage.findOneAndUpdate = () => ({ lean: async () => { throw new Error('db down'); } });
    await expect(svc.setCustomerLanguage({ workspaceId: W1, customerId: c._id, language: 'ar' }, w.deps)).rejects.toThrow('db down');
  });
});

// ── bulk set ───────────────────────────────────────────────────────────────

describe('bulkSetCustomerLanguage', () => {
  test('updates exactly the requested customers that belong to the workspace and counts exactly those', async () => {
    const w = listWorld();
    const ids = [w.c.zed._id, w.c.adam._id, w.c.other._id, w.c.erased._id, w.c.demo._id, oid(0xfeed), w.c.zed._id];
    const res = await svc.bulkSetCustomerLanguage({ workspaceId: W1, customerIds: ids, language: 'ar', userId: USER }, w.deps);
    expect(res).toEqual({ updated: 2 });
    const byCustomer = Object.fromEntries(w.CustomerLanguage.docs.map((d) => [d.customerId, d]));
    expect(byCustomer[w.c.zed._id]).toMatchObject({ language: 'ar', languageSource: 'merchant_set', updatedBy: USER });
    expect(byCustomer[w.c.adam._id]).toMatchObject({ language: 'ar', languageSource: 'merchant_set' });
    // untouched: other workspace, erased, demo (their existing documents are unchanged)
    expect(byCustomer[w.c.other._id]).toMatchObject({ language: 'ar', languageSource: 'merchant_set', workspaceId: W2 });
    expect(byCustomer[w.c.erased._id].updatedBy).toBeUndefined();
    expect(byCustomer[w.c.demo._id]).toMatchObject({ language: 'en' });
    expectScoped(w);
  });

  test('overrides every source, customer_chose included; unknown clears the source', async () => {
    const a = cust('A', 'B', '1');
    const b = cust('C', 'D', '2');
    const w = world({ customers: [a, b], languages: [lang(a, 'ar', 'customer_chose'), lang(b, 'en', 'inferred')] });
    await svc.bulkSetCustomerLanguage({ workspaceId: W1, customerIds: [a._id, b._id], language: 'unknown', userId: USER }, w.deps);
    expect(w.CustomerLanguage.docs.every((d) => d.language === 'unknown' && d.languageSource === null)).toBe(true);
    await svc.bulkSetCustomerLanguage({ workspaceId: W1, customerIds: [a._id], language: 'en', userId: USER }, w.deps);
    expect(w.CustomerLanguage.docs.find((d) => d.customerId === a._id)).toMatchObject({ language: 'en', languageSource: 'merchant_set' });
  });

  test('writes with bulkWrite upserts, unordered, every operation scoped to the workspace', async () => {
    const list = Array.from({ length: 3 }, (_, i) => cust(`N${i}`, 'x', `${i}`));
    const w = world({ customers: list });
    await svc.bulkSetCustomerLanguage({ workspaceId: W1, customerIds: list.map((c) => c._id), language: 'en', userId: USER }, w.deps);
    const calls = w.CustomerLanguage.calls.filter((c) => c.method === 'bulkWrite');
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toEqual({ ordered: false });
    for (const op of calls[0].operations) {
      expect(op.updateOne.upsert).toBe(true);
      expect(op.updateOne.setDefaultsOnInsert).toBe(true);
      expect(Object.keys(op.updateOne.filter).sort()).toEqual(['customerId', 'workspaceId']);
      expect(op.updateOne.update).toEqual({ $set: { language: 'en', languageSource: 'merchant_set', updatedBy: USER } });
    }
  });

  test('1000 customers go out in bulkWrite batches of at most 500', async () => {
    const list = Array.from({ length: 1000 }, (_, i) => cust(`N${i}`, 'x', `${i}`));
    const w = world({ customers: list });
    const res = await svc.bulkSetCustomerLanguage({ workspaceId: W1, customerIds: list.map((c) => c._id), language: 'ar', userId: USER }, w.deps);
    expect(res).toEqual({ updated: 1000 });
    const sizes = w.CustomerLanguage.calls.filter((c) => c.method === 'bulkWrite').map((c) => c.operations.length);
    expect(sizes).toEqual([500, 500]);
    expect(w.CustomerLanguage.docs).toHaveLength(1000);
  });

  test('more than 1000 ids is rejected before any query', async () => {
    const w = world();
    const ids = Array.from({ length: 1001 }, (_, i) => oid(i + 1));
    const err = await rejection(svc.bulkSetCustomerLanguage({ workspaceId: W1, customerIds: ids, language: 'ar' }, w.deps));
    expect(err).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    expect(w.Customer.calls).toHaveLength(0);
  });

  test.each([
    [undefined, 'INVALID_INPUT'], [null, 'INVALID_INPUT'], ['abc', 'INVALID_INPUT'], [{ $ne: null }, 'INVALID_INPUT'], [[], 'INVALID_INPUT'],
    [['abc'], 'INVALID_ID'], [[{ $ne: null }], 'INVALID_ID'], [[oid(1), { $gt: '' }], 'INVALID_ID'], [[null], 'INVALID_ID'], [[oid(1), 12], 'INVALID_ID'],
  ])('customerIds %j -> 400 %s before any query', async (customerIds, code) => {
    const w = world();
    const err = await rejection(svc.bulkSetCustomerLanguage({ workspaceId: W1, customerIds, language: 'ar' }, w.deps));
    expect(err).toMatchObject({ status: 400, code });
    expect(w.Customer.calls).toHaveLength(0);
  });

  test('an invalid language is rejected before any query', async () => {
    const w = world();
    const err = await rejection(svc.bulkSetCustomerLanguage({ workspaceId: W1, customerIds: [oid(1)], language: 'xx' }, w.deps));
    expect(err).toMatchObject({ status: 400, code: 'INVALID_LANGUAGE' });
    expect(w.Customer.calls).toHaveLength(0);
  });

  test('none owned -> { updated: 0 } and no write', async () => {
    const w = world({ customers: [cust('A', 'B', '1', {}, W2)] });
    const res = await svc.bulkSetCustomerLanguage({ workspaceId: W1, customerIds: [w.Customer.docs[0]._id], language: 'ar' }, w.deps);
    expect(res).toEqual({ updated: 0 });
    expect(w.CustomerLanguage.docs).toHaveLength(0);
  });

  test('a unique-index conflict (a concurrent insert) is retried once and succeeds', async () => {
    const a = cust('A', 'B', '1');
    const b = cust('C', 'D', '2');
    const w = world({ customers: [a, b] });
    let armed = true;
    w.CustomerLanguage.hooks.loseInsertRace = (model, doc) => {
      if (!armed || doc.customerId !== a._id) return false;
      armed = false;
      model.insert({ workspaceId: W1, customerId: a._id, language: 'en', languageSource: 'inferred' });
      return true;
    };
    const res = await svc.bulkSetCustomerLanguage({ workspaceId: W1, customerIds: [a._id, b._id], language: 'ar', userId: USER }, w.deps);
    expect(res).toEqual({ updated: 2 });
    expect(w.CustomerLanguage.docs).toHaveLength(2);
    expect(w.CustomerLanguage.docs.every((d) => d.language === 'ar' && d.languageSource === 'merchant_set')).toBe(true);
  });

  test('a conflict that never clears is an error, not a silent partial success', async () => {
    const a = cust('A', 'B', '1');
    const w = world({ customers: [a] });
    w.CustomerLanguage.hooks.loseInsertRace = () => true;
    await expect(svc.bulkSetCustomerLanguage({ workspaceId: W1, customerIds: [a._id], language: 'ar' }, w.deps)).rejects.toThrow(/could not complete/);
  });

  test('other write errors are not swallowed', async () => {
    const a = cust('A', 'B', '1');
    const w = world({ customers: [a] });
    w.CustomerLanguage.bulkWrite = async () => { throw new Error('db down'); };
    await expect(svc.bulkSetCustomerLanguage({ workspaceId: W1, customerIds: [a._id], language: 'ar' }, w.deps)).rejects.toThrow('db down');
  });
});

// ── CSV import ─────────────────────────────────────────────────────────────

const utf8 = (text) => Buffer.from(text, 'utf8');
const utf8Bom = (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(text)]);
const utf16le = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
// Exact Windows-1256 bytes (built from the decoder so the test does not trust a hand-made table).
const cp1256 = (() => {
  const decoder = new TextDecoder('windows-1256');
  const byChar = new Map();
  for (let b = 0; b < 256; b += 1) byChar.set(decoder.decode(Uint8Array.of(b)), b);
  return (text) => Buffer.from(Array.from(text, (ch) => {
    if (!byChar.has(ch)) throw new Error(`not representable in windows-1256: ${ch}`);
    return byChar.get(ch);
  }));
})();

function importWorld() {
  const c = {
    sara: cust('Sara', 'A', '966501234567'),
    ali: cust('Ali', 'B', '0551234567'),
    omar: cust('Omar', 'C', '+966 53 123 4567'),
    noor: cust('Noor', 'D', '61412345678'),
    dup1: cust('Dup1', 'E', '966561111111'),
    dup2: cust('Dup2', 'E', '0561111111'),
    erased: cust('Erased', 'F', 'deleted-abc', { deletedAt: new Date() }),
    erasedReal: cust('ErasedReal', 'F', '966577777777', { deletedAt: new Date() }),
    demo: cust('Demo', 'G', '966571111111', { isDemo: true }),
    other: cust('Other', 'H', '966581111111', {}, W2),
    blank: cust('Blank', 'I', '966591111111'),
    chose: cust('Chose', 'J', '966502222222'),
  };
  const languages = [lang(c.omar, 'en', 'merchant_set'), lang(c.chose, 'en', 'customer_chose')];
  return { c, ...world({ customers: Object.values(c), languages }) };
}

const run = (w, text, options = {}) => svc.importLanguages({ workspaceId: W1, userId: USER, file: { buffer: typeof text === 'string' ? utf8(text) : text }, ...options }, w.deps);
const outcomes = (res) => res.rows.map((r) => r.outcome);
const docFor = (w, customer) => w.CustomerLanguage.docs.find((d) => d.customerId === customer._id);

describe('importLanguages: outcomes', () => {
  const FILE = [
    'phone,language',
    '0501234567,ar', // sara: no document -> updated (stored in international form)
    '+966 55 123 4567,English', // ali: stored local -> updated
    '966531234567,en', // omar already en -> unchanged
    '+61412345678,AR', // noor: foreign number matched on its digits -> updated
    '966561111111,ar', // two customers share this number -> both updated, one row
    '966561111111,en', // same number again -> duplicate (first wins)
    '0501234567,en', // sara again in another format -> duplicate
    '966599999999,ar', // nobody -> unmatched
    'abc,ar', // not a phone
    '966501234567,klingon', // invalid language wins over duplicate
    '966571111111,ar', // demo customer -> unmatched
    '966577777777,ar', // erased customer -> unmatched
    '966581111111,ar', // another workspace -> unmatched
    '966591111111,', // blank language: no information -> unchanged
    '966502222222,ar', // customer_chose en -> protected
    '966502222222,en', // customer_chose en, same language -> duplicate of the row above
  ].join('\n');

  test('every outcome, reported per row with its line number', async () => {
    const w = importWorld();
    const res = await run(w, FILE);
    expect(res.rows.map((r) => [r.line, r.outcome])).toEqual([
      [2, 'updated'], [3, 'updated'], [4, 'unchanged'], [5, 'updated'], [6, 'updated'], [7, 'duplicate'], [8, 'duplicate'], [9, 'unmatched'], [10, 'invalid_phone'],
      [11, 'invalid_language'], [12, 'unmatched'], [13, 'unmatched'], [14, 'unmatched'], [15, 'unchanged'], [16, 'protected'], [17, 'duplicate'],
    ]);
    expect(res.summary).toEqual({ rows: 16, updated: 4, unchanged: 2, unmatched: 4, invalid: 2, duplicate: 3, protected: 1 });
    expect(res).toMatchObject({ dryRun: true, encoding: 'utf-8', delimiter: ',', truncated: false });
  });

  test('a dry run writes nothing at all', async () => {
    const w = importWorld();
    const before = JSON.stringify(w.CustomerLanguage.docs);
    await run(w, FILE);
    await run(w, FILE, { dryRun: true });
    expect(JSON.stringify(w.CustomerLanguage.docs)).toBe(before);
    expect(w.CustomerLanguage.calls.filter((c) => ['bulkWrite', 'findOneAndUpdate'].includes(c.method))).toHaveLength(0);
  });

  test('dryRun defaults to true when omitted', async () => {
    const w = importWorld();
    const res = await svc.importLanguages({ workspaceId: W1, file: { buffer: utf8(FILE) } }, w.deps);
    expect(res.dryRun).toBe(true);
    expect(w.CustomerLanguage.docs).toHaveLength(2);
  });

  test('apply writes exactly what the dry run promised: csv_import source, updatedBy, created and updated rows', async () => {
    const w = importWorld();
    const dry = await run(w, FILE);
    const applied = await run(w, FILE, { dryRun: false });
    expect(applied.dryRun).toBe(false);
    expect(applied.summary).toEqual(dry.summary);
    expect(outcomes(applied)).toEqual(outcomes(dry));
    expect(docFor(w, w.c.sara)).toMatchObject({ language: 'ar', languageSource: 'csv_import', updatedBy: USER, workspaceId: W1 });
    expect(docFor(w, w.c.ali)).toMatchObject({ language: 'en', languageSource: 'csv_import' });
    expect(docFor(w, w.c.noor)).toMatchObject({ language: 'ar', languageSource: 'csv_import' });
    expect(docFor(w, w.c.dup1)).toMatchObject({ language: 'ar', languageSource: 'csv_import' });
    expect(docFor(w, w.c.dup2)).toMatchObject({ language: 'ar', languageSource: 'csv_import' });
    expect(docFor(w, w.c.omar)).toMatchObject({ language: 'en', languageSource: 'merchant_set' }); // unchanged rows are not rewritten
    expect(docFor(w, w.c.chose)).toMatchObject({ language: 'en', languageSource: 'customer_chose' }); // protected
    for (const untouched of [w.c.erased, w.c.erasedReal, w.c.demo, w.c.other, w.c.blank]) expect(docFor(w, untouched)).toBeUndefined();
    expectScoped(w);
  });

  test('re-running the same file after applying it reports everything unchanged', async () => {
    const w = importWorld();
    const file = 'phone,language\n0501234567,ar\n0551234567,en\n61412345678,ar\n';
    await run(w, file, { dryRun: false });
    const again = await run(w, file, { dryRun: false });
    expect(again.summary).toMatchObject({ rows: 3, updated: 0, unchanged: 3 });
  });

  test('every write is guarded so a language the customer chose meanwhile cannot be overwritten', async () => {
    const w = importWorld();
    await run(w, 'phone,language\n0501234567,ar\n', { dryRun: false });
    const op = w.CustomerLanguage.calls.find((c) => c.method === 'bulkWrite').operations[0].updateOne;
    expect(op.filter).toEqual({ workspaceId: W1, customerId: w.c.sara._id, languageSource: { $ne: 'customer_chose' } });
    expect(op.upsert).toBe(true);
    expect(op.update.$set).toEqual({ language: 'ar', languageSource: 'csv_import', updatedBy: USER });
  });

  test('customer_chose: a different language is protected, the same language is unchanged, other sources are overridden', async () => {
    const w = importWorld();
    const a = cust('InferredAr', 'x', '966503000001');
    const b = cust('MerchantEn', 'x', '966503000002');
    const c = cust('CsvAr', 'x', '966503000003');
    const d = cust('ChoseAr', 'x', '966503000004');
    w.Customer.docs.push(a, b, c, d);
    w.CustomerLanguage.docs.push(lang(a, 'ar', 'inferred'), lang(b, 'en', 'merchant_set'), lang(c, 'ar', 'csv_import'), lang(d, 'ar', 'customer_chose'));
    const res = await run(w, 'phone,language\n966503000001,en\n966503000002,ar\n966503000003,ar\n966503000004,ar\n966502222222,ar\n', { dryRun: false });
    expect(outcomes(res)).toEqual(['updated', 'updated', 'unchanged', 'unchanged', 'protected']);
    expect(docFor(w, a)).toMatchObject({ language: 'en', languageSource: 'csv_import' });
    expect(docFor(w, b)).toMatchObject({ language: 'ar', languageSource: 'csv_import' });
    expect(docFor(w, d)).toMatchObject({ language: 'ar', languageSource: 'customer_chose' });
    expect(docFor(w, w.c.chose)).toMatchObject({ language: 'en', languageSource: 'customer_chose' });
  });

  test('a customer who chooses a language between the check and the write is still protected (and reported so)', async () => {
    const w = importWorld();
    w.CustomerLanguage.hooks.beforeBulkWrite = (model) => {
      model.insert({ workspaceId: W1, customerId: w.c.sara._id, language: 'en', languageSource: 'customer_chose' });
    };
    const res = await run(w, 'phone,language\n0501234567,ar\n0551234567,ar\n', { dryRun: false });
    expect(outcomes(res)).toEqual(['protected', 'updated']);
    expect(res.summary).toMatchObject({ updated: 1, protected: 1 });
    expect(docFor(w, w.c.sara)).toMatchObject({ language: 'en', languageSource: 'customer_chose' });
    expect(docFor(w, w.c.ali)).toMatchObject({ language: 'ar', languageSource: 'csv_import' });
  });

  test('losing a plain insert race (another writer created the row first) is retried and still applied', async () => {
    const w = importWorld();
    let armed = true;
    w.CustomerLanguage.hooks.loseInsertRace = (model, doc) => {
      if (!armed || doc.customerId !== w.c.sara._id) return false;
      armed = false;
      model.insert({ workspaceId: W1, customerId: w.c.sara._id, language: 'unknown', languageSource: 'inferred' });
      return true;
    };
    const res = await run(w, 'phone,language\n0501234567,ar\n', { dryRun: false });
    expect(outcomes(res)).toEqual(['updated']);
    expect(docFor(w, w.c.sara)).toMatchObject({ language: 'ar', languageSource: 'csv_import' });
    expect(w.CustomerLanguage.docs.filter((d) => d.customerId === w.c.sara._id)).toHaveLength(1);
  });

  test('only the first VALID row of a number counts: an invalid first row does not consume it', async () => {
    const w = importWorld();
    const res = await run(w, 'phone,language\n0501234567,nonsense\n0501234567,ar\n0501234567,en\n');
    expect(outcomes(res)).toEqual(['invalid_language', 'updated', 'duplicate']);
  });

  test('blank / unknown language cells carry no information: unchanged (or unmatched), they never reset a language and never block a later row', async () => {
    const w = importWorld();
    await run(w, 'phone,language\n966531234567,ar\n', { dryRun: false }); // omar en -> ar
    const res = await run(w, 'phone,language\n966531234567,\n966531234567,unknown\n966531234567,ar\n966599999999,\n', { dryRun: false });
    expect(outcomes(res)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unmatched']);
    expect(docFor(w, w.c.omar)).toMatchObject({ language: 'ar' });
  });

  test('a number shared by several customers updates all of them (one row)', async () => {
    const w = importWorld();
    const res = await run(w, 'phone,language\n0561111111,ar\n', { dryRun: false });
    expect(res.summary).toMatchObject({ rows: 1, updated: 1 });
    expect(docFor(w, w.c.dup1).language).toBe('ar');
    expect(docFor(w, w.c.dup2).language).toBe('ar');
  });

  test('two rows that resolve to the same customer through different number forms never write it twice', async () => {
    const w = world({ customers: [cust('Odd', 'x', '500000001')] });
    const res = await svc.importLanguages({ workspaceId: W1, file: { buffer: utf8('phone,language\n0500000001,ar\n+500000001,en\n') }, dryRun: false }, w.deps);
    expect(outcomes(res)).toEqual(['updated', 'duplicate']);
    const ops = w.CustomerLanguage.calls.filter((c) => c.method === 'bulkWrite').flatMap((c) => c.operations);
    expect(ops).toHaveLength(1);
    expect(w.CustomerLanguage.docs[0]).toMatchObject({ language: 'ar' });
  });

  test('never creates, changes or removes a customer', async () => {
    const w = importWorld();
    const before = JSON.stringify(w.Customer.docs);
    await run(w, FILE, { dryRun: false });
    expect(JSON.stringify(w.Customer.docs)).toBe(before);
    for (const call of w.Customer.calls) expect(['find', 'findOne', 'countDocuments']).toContain(call.method);
  });

  test('the customer set is the workspace\'s real customers only', async () => {
    const w = importWorld();
    const res = await run(w, 'phone,language\n966571111111,ar\n966577777777,ar\n966581111111,ar\n');
    expect(outcomes(res)).toEqual(['unmatched', 'unmatched', 'unmatched']);
    for (const call of w.Customer.calls) {
      expect(call.filter).toMatchObject({ workspaceId: W1, deletedAt: { $exists: false }, isDemo: { $ne: true } });
    }
  });
});

describe('importLanguages: phones', () => {
  test.each([
    ['0501234567'], ['+966501234567'], ['+966 50 123 4567'], ['966501234567'], ['00966501234567'], ['501234567'], ['(050) 123-4567'], ['050-123-4567'],
    ['٠٥٠١٢٣٤٥٦٧'], ['+٩٦٦٥٠١٢٣٤٥٦٧'], ['۰۵۰۱۲۳۴۵۶۷'], ['05٠1234567'], ['="0501234567"'], ["'0501234567"], ['  0501234567  '], ['0501234567\u{200F}'],
  ])('%j matches the customer stored as 966501234567', async (phone) => {
    const w = importWorld();
    const res = await run(w, `phone,language\n"${phone.replace(/"/g, '""')}",ar\n`);
    expect(outcomes(res)).toEqual(['updated']);
  });

  test.each([['abc'], [''], ['+'], ['---'], ['9.66501E+11'], ['9.66501e11'], ['1E+15'], ['12345'], ['1234567890123456'], ['=HYPERLINK("http://x")'], ['deleted-abc']])('%j is not a phone number', async (phone) => {
    const w = importWorld();
    const res = await run(w, `phone,language\n"${phone.replace(/"/g, '""')}",ar\n`);
    expect(outcomes(res)).toEqual(['invalid_phone']);
  });

  test('a number with another country code matches a customer stored the same way', async () => {
    const w = importWorld();
    for (const phone of ['+61412345678', '61412345678', '0061412345678']) {
      expect(outcomes(await run(w, `phone,language\n${phone},ar\n`))).toEqual(['updated']);
    }
  });

  test('the country code comes from Settings.defaultCountryCode (default 966)', async () => {
    const au = world({ customers: [cust('Bob', 'Aus', '61412345678')], countryCode: '61' });
    expect(outcomes(await run(au, 'phone,language\n0412345678,ar\n'))).toEqual(['updated']);
    const sa = world({ customers: [cust('Bob', 'Aus', '61412345678')] });
    expect(outcomes(await run(sa, 'phone,language\n0412345678,ar\n'))).toEqual(['unmatched']); // 0412... is Saudi-local there
  });

  test('phones are never logged', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    try {
      const w = importWorld();
      await run(w, 'phone,language\n0501234567,ar\nbad-phone,ar\n', { dryRun: false });
      await rejection(run(w, 'a,b\n1,2\n'));
      for (const spy of spies) {
        for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toMatch(/501234567/);
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe('importLanguages: language values', () => {
  test.each([
    ['ar', 'ar'], ['AR', 'ar'], [' ar ', 'ar'], ['Arabic', 'ar'], ['ARABIC', 'ar'], ['ar-SA', 'ar'], ['عربي', 'ar'], ['عربى', 'ar'], ['العربية', 'ar'], ['العربيه', 'ar'], ['عَرَبِي', 'ar'], ['\u{200F}عربي\u{200F}', 'ar'], ['٪عربي', null],
    ['en', 'en'], ['EN', 'en'], ['English', 'en'], ['english', 'en'], ['en-US', 'en'], ['إنجليزي', 'en'], ['انجليزي', 'en'], ['الإنجليزية', 'en'], ['الانجليزية', 'en'], ['إِنجليزي', 'en'],
    ['klingon', null], ['arabic english', null], ['=cmd', null], ['fr', null], ['1', null],
  ])('%j -> %s', async (value, expected) => {
    const w = importWorld();
    const res = await run(w, `phone,language\n0501234567,"${value.replace(/"/g, '""')}"\n`, { dryRun: false });
    if (expected === null) {
      expect(outcomes(res)).toEqual(['invalid_language']);
      expect(w.CustomerLanguage.docs).toHaveLength(2);
    } else {
      expect(outcomes(res)).toEqual(['updated']);
      expect(docFor(w, w.c.sara).language).toBe(expected);
    }
  });
});

describe('importLanguages: files', () => {
  const BODY_AR = 'جوال,اللغة\r\n0501234567,عربي\r\n0551234567,إنجليزي\r\n';

  test('UTF-8 with BOM', async () => {
    const res = await run(importWorld(), utf8Bom(BODY_AR));
    expect(res).toMatchObject({ encoding: 'utf-8-bom', delimiter: ',' });
    expect(outcomes(res)).toEqual(['updated', 'updated']);
  });

  test('UTF-8 without BOM (Google Sheets, LibreOffice)', async () => {
    const res = await run(importWorld(), utf8(BODY_AR));
    expect(res.encoding).toBe('utf-8');
    expect(outcomes(res)).toEqual(['updated', 'updated']);
  });

  test('UTF-16LE with BOM (Excel "Unicode Text")', async () => {
    const res = await run(importWorld(), utf16le('جوال\tاللغة\r\n0501234567\tعربي\r\n0551234567\tإنجليزي\r\n'));
    expect(res).toMatchObject({ encoding: 'utf-16le', delimiter: '\t' });
    expect(outcomes(res)).toEqual(['updated', 'updated']);
  });

  test('Windows-1256 (Excel "CSV" on an Arabic-locale PC) is decoded, not turned into mojibake', async () => {
    const w = importWorld();
    const res = await run(w, cp1256('جوال;اللغة\r\n0501234567;عربي\r\n0551234567;إنجليزي\r\n'), { dryRun: false });
    expect(res).toMatchObject({ encoding: 'windows-1256', delimiter: ';' });
    expect(outcomes(res)).toEqual(['updated', 'updated']);
    expect(docFor(w, w.c.sara).language).toBe('ar');
    expect(docFor(w, w.c.ali).language).toBe('en');
  });

  test.each([[','], [';'], ['\t']])('delimiter %j is detected', async (delimiter) => {
    const res = await run(importWorld(), `phone${delimiter}language\n0501234567${delimiter}ar\n`);
    expect(res.delimiter).toBe(delimiter);
    expect(outcomes(res)).toEqual(['updated']);
  });

  test('Excel\'s "sep=;" first line states the delimiter and is not read as a header', async () => {
    const res = await run(importWorld(), 'sep=;\r\nphone;language\r\n0501234567;ar\r\n');
    expect(res.delimiter).toBe(';');
    expect(outcomes(res)).toEqual(['updated']);
  });

  test('quoted cells with delimiters, quotes and newlines inside', async () => {
    const res = await run(importWorld(), 'name,phone,language\n"Sara, ""the boss""\nA",0501234567,ar\n');
    expect(outcomes(res)).toEqual(['updated']);
  });

  test.each([
    ['phone', 'language'], ['Phone', 'Language'], ['PHONE', 'LANG'], ['Mobile', 'lang'], ['whatsapp', 'language'], ['WhatsApp Number', 'Language'], ['tel', 'language'], ['number', 'language'],
    ['جوال', 'اللغة'], ['الجوال', 'اللغة'], ['رقم الجوال', 'لغة'], ['رقم الهاتف', 'اللغة'], ['الهاتف', 'اللغة'], ['رقم الجوّال', 'اللُّغة'], ['\u{200F}رقم الجوال\u{200F}', 'اللغة'], [' phone ', ' language '],
  ])('headers %j / %j are understood', async (phoneHeader, languageHeader) => {
    const res = await run(importWorld(), `${phoneHeader},${languageHeader}\n0501234567,ar\n`);
    expect(outcomes(res)).toEqual(['updated']);
  });

  test('extra columns and any column order', async () => {
    const res = await run(importWorld(), 'name,language,email,phone\nSara,ar,a@b.c,0501234567\n');
    expect(outcomes(res)).toEqual(['updated']);
  });

  test('a UTF-8 BOM that was not stripped does not hide the first header', async () => {
    const res = await run(importWorld(), `${BOM}${BOM}phone,language\n0501234567,ar\n`);
    expect(outcomes(res)).toEqual(['updated']);
  });

  test('no phone column -> 400 CSV_NO_PHONE_COLUMN; no language column -> 400 CSV_NO_LANGUAGE_COLUMN', async () => {
    const w = importWorld();
    expect(await rejection(run(w, 'name,language\nSara,ar\n'))).toMatchObject({ status: 400, code: 'CSV_NO_PHONE_COLUMN' });
    expect(await rejection(run(w, 'phone,name\n0501234567,Sara\n'))).toMatchObject({ status: 400, code: 'CSV_NO_LANGUAGE_COLUMN' });
    expect(await rejection(run(w, '0501234567,ar\n0551234567,en\n'))).toMatchObject({ status: 400, code: 'CSV_NO_PHONE_COLUMN' }); // no header row
    expect(await rejection(run(w, 'phone\n0501234567\n'))).toMatchObject({ status: 400, code: 'CSV_NO_LANGUAGE_COLUMN' });
  });

  test('empty, header-only, spreadsheet and malformed files are FILE_INVALID', async () => {
    const w = importWorld();
    expect(await rejection(svc.importLanguages({ workspaceId: W1, file: undefined }, w.deps))).toMatchObject({ status: 400, code: 'FILE_INVALID' });
    expect(await rejection(svc.importLanguages({ workspaceId: W1, file: { buffer: Buffer.alloc(0) } }, w.deps))).toMatchObject({ code: 'FILE_INVALID' });
    expect(await rejection(run(w, 'phone,language\n'))).toMatchObject({ status: 400, code: 'FILE_INVALID' });
    expect(await rejection(run(w, 'phone,language\n,\n  ,  \n'))).toMatchObject({ status: 400, code: 'FILE_INVALID' });
    expect(await rejection(run(w, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])))).toMatchObject({ status: 400, code: 'FILE_INVALID' });
    expect(await rejection(run(w, 'phone,language\n"unterminated,ar\n'))).toMatchObject({ status: 400, code: 'FILE_INVALID' });
  });

  test('over 5 MB -> 413 FILE_TOO_LARGE; over 50,000 rows -> 413 FILE_TOO_LARGE', async () => {
    const w = importWorld();
    expect(await rejection(run(w, Buffer.alloc(5 * 1024 * 1024 + 1, 97)))).toMatchObject({ status: 413, code: 'FILE_TOO_LARGE' });
    const rows = `phone,language\n${'966500000001,ar\n'.repeat(50001)}`;
    expect(await rejection(run(w, rows))).toMatchObject({ status: 413, code: 'FILE_TOO_LARGE' });
  });

  test('a file of exactly 50,000 data rows is accepted', async () => {
    const w = importWorld();
    const res = await run(w, `phone,language\n${'966500000001,ar\n'.repeat(49999)}`);
    expect(res.summary.rows).toBe(49999);
    expect(res.summary.duplicate).toBe(49998);
  });

  test('blank rows are skipped, not counted; rows with other columns but no phone are invalid', async () => {
    const res = await run(importWorld(), 'name,phone,language\n,,\n\n  ,  ,  \nSara,,ar\n');
    expect(res.summary).toMatchObject({ rows: 1, invalid: 1 });
    expect(outcomes(res)).toEqual(['invalid_phone']);
  });

  test('the preview lists at most 200 rows; the summary counts them all', async () => {
    const lines = ['phone,language'];
    for (let i = 0; i < 230; i += 1) lines.push(`96651${String(1000000 + i)},ar`);
    const res = await run(importWorld(), lines.join('\n'));
    expect(res.rows).toHaveLength(200);
    expect(res.truncated).toBe(true);
    expect(res.summary).toMatchObject({ rows: 230, unmatched: 230 });
    expect(res.rows[0].line).toBe(2);
    expect(res.rows[199].line).toBe(201);
  });

  test('exactly 200 rows is not truncated', async () => {
    const lines = ['phone,language'];
    for (let i = 0; i < 200; i += 1) lines.push(`96651${String(1000000 + i)},ar`);
    const res = await run(importWorld(), lines.join('\n'));
    expect(res.truncated).toBe(false);
  });

  test('echoed cells are clipped and carry no formula risk beyond what the client escapes', async () => {
    const res = await run(importWorld(), `phone,language\n${'9'.repeat(100)},${'x'.repeat(100)}\n`);
    expect(res.rows[0].phone.length).toBeLessThanOrEqual(41);
    expect(res.rows[0].language.length).toBeLessThanOrEqual(41);
  });

  test('a hostile CSV (formulas, regex, operators) is only data', async () => {
    const w = importWorld();
    const res = await run(w, 'phone,language\n=1+1,=cmd|\'/C calc\'!A0\n@SUM(1),+HYPERLINK("x")\n{"$ne":null},{"$gt":""}\n.*,.*\n');
    expect(outcomes(res)).toEqual(['invalid_phone', 'invalid_phone', 'invalid_phone', 'invalid_phone']);
    expect(w.CustomerLanguage.docs).toHaveLength(2);
  });

  test('without a workspace nothing is read or written', async () => {
    const w = importWorld();
    const err = await rejection(svc.importLanguages({ workspaceId: '', file: { buffer: utf8('phone,language\n1,ar') } }, w.deps));
    expect(err).toMatchObject({ status: 403 });
    expect(w.Customer.calls).toHaveLength(0);
  });
});

// ── profile panel + main-import language column (IM-D) ─────────────────────

describe('getCustomerLanguage', () => {
  test('one row in the list/PUT shape: stored language, source, effective language and name', async () => {
    const sara = cust('سارة', 'أحمد', '966500000001');
    const mona = cust('Mona', 'Mona', '966500000002');
    const w = world({ customers: [sara, mona], languages: [lang(sara, 'ar', 'inferred')], merchantDefault: 'ar' });
    expect(await svc.getCustomerLanguage({ workspaceId: W1, customerId: sara._id }, w.deps)).toEqual({
      id: sara._id, name: 'سارة أحمد', phone: '966500000001', language: 'ar', languageSource: 'inferred', effectiveLanguage: 'ar', marketingConsent: false, optedOut: false,
    });
    expect(await svc.getCustomerLanguage({ workspaceId: W1, customerId: mona._id }, w.deps)).toMatchObject({ name: 'Mona', language: 'unknown', languageSource: null, effectiveLanguage: 'ar' });
    expectScoped(w);
    expect(w.CustomerLanguage.calls.every((call) => call.method !== 'bulkWrite')).toBe(true);
  });

  test("another workspace's, erased and demo customers are a 404; a missing workspace is refused", async () => {
    const theirs = cust('Their', 'Person', '966500000009', {}, W2);
    const erased = cust('Gone', 'Person', '966500000008', { deletedAt: new Date() });
    const demo = cust('Demo', 'Person', '966500000007', { isDemo: true });
    const w = world({ customers: [theirs, erased, demo] });
    for (const customer of [theirs, erased, demo]) {
      await expect(svc.getCustomerLanguage({ workspaceId: W1, customerId: customer._id }, w.deps)).rejects.toMatchObject({ status: 404, code: 'CUSTOMER_NOT_FOUND' });
    }
    await expect(svc.getCustomerLanguage({ workspaceId: W1, customerId: 'nope' }, w.deps)).rejects.toMatchObject({ status: 400, code: 'INVALID_ID' });
    await expect(svc.getCustomerLanguage({ customerId: theirs._id }, w.deps)).rejects.toMatchObject({ status: 403 });
  });
});

describe('setImportedLanguages', () => {
  const run = (w, entries) => svc.setImportedLanguages({ workspaceId: W1, userId: USER, entries }, w.deps);

  test('writes csv_import, leaves identical languages alone, protects customer_chose, overwrites merchant_set and inferred', async () => {
    const fresh = cust('A', 'A', '966500000001');
    const same = cust('B', 'B', '966500000002');
    const chose = cust('C', 'C', '966500000003');
    const merchant = cust('D', 'D', '966500000004');
    const inferred = cust('E', 'E', '966500000005');
    const w = world({
      customers: [fresh, same, chose, merchant, inferred],
      languages: [lang(same, 'ar', 'merchant_set'), lang(chose, 'en', 'customer_chose'), lang(merchant, 'en', 'merchant_set'), lang(inferred, 'en', 'inferred')],
    });
    const result = await run(w, [
      { customerId: fresh._id, language: 'ar' }, { customerId: same._id, language: 'ar' }, { customerId: chose._id, language: 'ar' },
      { customerId: merchant._id, language: 'ar' }, { customerId: inferred._id, language: 'ar' },
    ]);
    expect(result).toEqual({ written: 3, protected: 1, unchanged: 1, skipped: 0 });
    const doc = (c) => w.CustomerLanguage.docs.find((d) => String(d.customerId) === String(c._id));
    expect(doc(fresh)).toMatchObject({ language: 'ar', languageSource: 'csv_import', updatedBy: USER });
    expect(doc(same)).toMatchObject({ language: 'ar', languageSource: 'merchant_set' }); // untouched
    expect(doc(chose)).toMatchObject({ language: 'en', languageSource: 'customer_chose' });
    expect(doc(merchant)).toMatchObject({ language: 'ar', languageSource: 'csv_import' });
    expect(doc(inferred)).toMatchObject({ language: 'ar', languageSource: 'csv_import' });
    expectScoped(w);
  });

  test('first entry per customer wins; only ar / en are written; foreign, erased and demo customers are skipped', async () => {
    const mine = cust('Mine', 'Mine', '966500000001');
    const theirs = cust('Their', 'Person', '966500000002', {}, W2);
    const erased = cust('Gone', 'Person', '966500000003', { deletedAt: new Date() });
    const demo = cust('Demo', 'Person', '966500000004', { isDemo: true });
    const w = world({ customers: [mine, theirs, erased, demo] });
    const result = await run(w, [
      { customerId: mine._id, language: 'en' }, { customerId: mine._id, language: 'ar' },
      { customerId: theirs._id, language: 'ar' }, { customerId: erased._id, language: 'ar' }, { customerId: demo._id, language: 'ar' },
      { customerId: mine._id, language: 'unknown' }, { customerId: 'bad-id', language: 'ar' }, { language: 'ar' }, null,
    ]);
    expect(result).toEqual({ written: 1, protected: 0, unchanged: 0, skipped: 3 });
    expect(w.CustomerLanguage.docs).toHaveLength(1);
    expect(w.CustomerLanguage.docs[0]).toMatchObject({ language: 'en', languageSource: 'csv_import' });
    expect(String(w.CustomerLanguage.docs[0].workspaceId)).toBe(W1);
  });

  test('a customer who chooses a language between the read and the write is still protected (atomic guard)', async () => {
    const racer = cust('Racer', 'Racer', '966500000001');
    const w = world({ customers: [racer], languages: [lang(racer, 'en', 'merchant_set')] });
    const bulk = w.CustomerLanguage.bulkWrite.bind(w.CustomerLanguage);
    w.CustomerLanguage.bulkWrite = async (ops, options) => {
      w.CustomerLanguage.docs[0].languageSource = 'customer_chose'; // the customer taps a language button right now
      return bulk(ops, options);
    };
    expect(await run(w, [{ customerId: racer._id, language: 'ar' }])).toEqual({ written: 0, protected: 1, unchanged: 0, skipped: 0 });
    expect(w.CustomerLanguage.docs[0]).toMatchObject({ language: 'en', languageSource: 'customer_chose' });
  });

  test('empty input does no queries; no workspace is refused; writes never touch Customer', async () => {
    const w = world();
    expect(await run(w, [])).toEqual({ written: 0, protected: 0, unchanged: 0, skipped: 0 });
    expect(w.Customer.calls).toEqual([]);
    await expect(svc.setImportedLanguages({ entries: [] }, w.deps)).rejects.toMatchObject({ status: 403 });
  });
});

// ── export / template ──────────────────────────────────────────────────────

describe('templateCsv', () => {
  test('BOM, CRLF, headers phone,language and three sample rows (one Arabic value)', () => {
    const text = svc.templateCsv();
    expect(text.startsWith(BOM)).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.split('\r\n')).toHaveLength(5); // header + 3 rows + trailing empty
    const { headers, rows } = parseCsv(text);
    expect(headers).toEqual(['phone', 'language']);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.language)).toEqual(['ar', 'en', 'Arabic']);
    for (const row of rows) expect(row.phone).toMatch(/^\+?[0-9 ]+$/);
  });

  test('the template itself imports cleanly (dry run) and matches nobody', async () => {
    const w = importWorld();
    const res = await svc.importLanguages({ workspaceId: W1, file: { buffer: utf8(svc.templateCsv()) } }, w.deps);
    expect(res.summary).toMatchObject({ rows: 3, invalid: 0, unmatched: 3 });
  });
});

describe('exportCsv', () => {
  test('name,phone,language,source for the managed customers, sorted by name, BOM + CRLF', async () => {
    const w = listWorld();
    const text = await svc.exportCsv({ workspaceId: W1 }, w.deps);
    expect(text.startsWith(BOM)).toBe(true);
    expect(text.split('\r\n').length).toBe(9 + 2);
    const { headers, rows } = parseCsv(text);
    expect(headers).toEqual(['name', 'phone', 'language', 'source']);
    expect(rows.map((r) => r.name)).toEqual(ALL_NAMES);
    expect(rows.find((r) => r.name === 'سارة أحمد')).toMatchObject({ phone: '966500000003', language: 'ar', source: 'inferred' });
    expect(rows.find((r) => r.name === 'Mona')).toMatchObject({ language: 'unknown', source: '' });
    expect(rows.find((r) => r.name === 'adam first')).toMatchObject({ language: 'unknown', source: '' });
    expect(rows.find((r) => r.name === 'محمد العتيبي')).toMatchObject({ language: 'ar', source: 'customer_chose' });
    expectScoped(w);
  });

  test('no erased, demo or other-workspace customers', async () => {
    const text = await svc.exportCsv({ workspaceId: W1 }, listWorld().deps);
    const { rows } = parseCsv(text);
    for (const hidden of ['Deleted Customer', 'Demo Person', 'Other Tenant']) expect(rows.map((r) => r.name)).not.toContain(hidden);
    for (const hidden of ['deleted-x', '61400000001']) expect(rows.map((r) => r.phone)).not.toContain(hidden);
  });

  test('Arabic names round-trip byte-exact; commas, quotes and newlines are quoted', async () => {
    const tricky = [cust('عبد الله', 'المطيري', '966500000001'), cust('Sara, "the boss"', 'Ahmed\nJr', '966500000002'), cust('مُحَمَّد', 'اً', '966500000003')];
    const w = world({ customers: tricky });
    const { rows } = parseCsv(await svc.exportCsv({ workspaceId: W1 }, w.deps));
    expect(rows.map((r) => r.name).sort()).toEqual(['Sara, "the boss" Ahmed\nJr', 'عبد الله المطيري', 'مُحَمَّد اً'].sort());
  });

  test('spreadsheet formulas in names are neutralised (even ones that start like a number); phones with a leading + are not', async () => {
    const w = world({ customers: [
      cust('=HYPERLINK("http://evil")', 'x', '+966500000001'), cust('@cmd', 'y', '966500000002'), cust('-1+1', 'z', '966500000003'),
      cust('+SUM(1)', 'w', '966500000004'), cust('+1+cmd|\' /C calc\'!A0', 'v', '966500000005'), cust('\tTabbed', 'u', '966500000006'),
    ] });
    const { rows } = parseCsv(await svc.exportCsv({ workspaceId: W1 }, w.deps));
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row.name).not.toMatch(/^[=+\-@\t\r]/);
    expect(rows.find((r) => r.name.includes('HYPERLINK')).phone).toBe('+966500000001');
    expect(rows.find((r) => r.name.includes('calc')).name).toBe('\'+1+cmd|\' /C calc\'!A0 v');
  });

  test('spreadsheetSafe leaves plain text and plain numbers alone', () => {
    for (const ok of ['Sara', 'سارة', '', '-5', '+5', '12.5', '5,5', "O'Brien", 'a=b', 'x-1']) expect(svc.spreadsheetSafe(ok)).toBe(ok);
    for (const bad of ['=1', '+a', '-a', '@a', '-1+1', '+1+1', '=-1', '\tx', '\rx']) expect(svc.spreadsheetSafe(bad)).toBe(`'${bad}`);
  });

  test('more than one chunk of customers is exported completely', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => cust(`C${String(i).padStart(4, '0')}`, 'x', `${966500000000 + i}`));
    const w = world({ customers: many });
    const { rows } = parseCsv(await svc.exportCsv({ workspaceId: W1 }, w.deps));
    expect(rows).toHaveLength(2500);
    expect(rows[0].name).toBe('C0000 x');
    expect(rows[2499].name).toBe('C2499 x');
  });

  test('an empty workspace exports just the header', async () => {
    const text = await svc.exportCsv({ workspaceId: W1 }, world().deps);
    expect(text).toBe(`${BOM}name,phone,language,source\r\n`);
  });

  test('export then import (dry run) is a no-op: nothing would change', async () => {
    const w = listWorld();
    const text = await svc.exportCsv({ workspaceId: W1 }, w.deps);
    const res = await svc.importLanguages({ workspaceId: W1, file: { buffer: utf8(text) } }, w.deps);
    expect(res.summary).toMatchObject({ rows: 9, updated: 0, invalid: 0, unmatched: 0 });
  });
});

// ── pure helpers ───────────────────────────────────────────────────────────

describe('helpers', () => {
  test('compareStrings orders by code point, not by UTF-16 unit', () => {
    expect(svc.compareStrings('a', 'b')).toBeLessThan(0);
    expect(svc.compareStrings('B', 'a')).toBeLessThan(0);
    expect(svc.compareStrings('a', 'أ')).toBeLessThan(0);
    expect(svc.compareStrings('ｆ', '😀')).toBeLessThan(0); // U+FF46 < U+1F600 although 0xD83D < 0xFF46
    expect(svc.compareStrings('😀', '😁')).toBeLessThan(0);
    expect(svc.compareStrings('ab', 'a')).toBeGreaterThan(0);
    expect(svc.compareStrings('x', 'x')).toBe(0);
    expect(svc.compareStrings(undefined, '')).toBe(0);
    expect(svc.compareStrings(null, 'a')).toBeLessThan(0);
  });

  test('parseDryRun is safe by default: only an explicit false applies', () => {
    for (const v of [undefined, null, '', 'true', 'TRUE', '1', 'yes', 'maybe', 'null', ['false', 'false'], {}]) expect(svc.parseDryRun(v)).toBe(true);
    for (const v of ['false', 'FALSE', ' false ', '0', 'no', 'off']) expect(svc.parseDryRun(v)).toBe(false);
  });

  test('parseSearch accepts strings only', () => {
    expect(svc.parseSearch(undefined)).toBeUndefined();
    expect(svc.parseSearch('سارة')).toBe('سارة');
    expect(() => svc.parseSearch({ $ne: '' })).toThrow(expect.objectContaining({ status: 400, code: 'INVALID_INPUT' }));
    expect(() => svc.parseSearch('x'.repeat(501))).toThrow(expect.objectContaining({ status: 400, code: 'INVALID_INPUT' }));
  });

  test('languagesFor fetches by id chunks and ignores other workspaces', async () => {
    const a = cust('A', 'B', '1');
    const other = cust('C', 'D', '2', {}, W2);
    const w = world({ customers: [a, other], languages: [lang(a, 'ar', 'inferred'), lang(other, 'en', 'merchant_set')] });
    const map = await svc.languagesFor(W1, [a._id, other._id, a._id], w.deps);
    expect(Array.from(map.keys())).toEqual([a._id]);
    expect(map.get(a._id).language).toBe('ar');
    expect((await svc.languagesFor(W1, [], w.deps)).size).toBe(0);
  });
});

// ── source guards ──────────────────────────────────────────────────────────

describe('source guards', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const FILES = ['shared/localization/customerLanguage.js', 'shared/localization/arabicSearch.js', 'routes/localization/customers.js', 'tests/localization/helpers/fakeMongo.js'];

  test.each(FILES.map((f) => [f]))('%s never deletes anything', (file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect(source).not.toMatch(/\b(deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|findByIdAndRemove|findOneAndRemove|dropDatabase|dropCollection|destroy)\b/);
    expect(source).not.toMatch(/\.(remove|drop)\s*\(/);
  });

  test('the service never writes to the Customer model', () => {
    const source = fs.readFileSync(path.join(ROOT, 'shared/localization/customerLanguage.js'), 'utf8');
    expect(source).not.toMatch(/Customer\.(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|bulkWrite|save|replaceOne)/);
  });

  test('requiring the service and the router has no side effects (no connection, no network)', () => {
    jest.isolateModules(() => {
      require('../../routes/localization/customers');
      expect(require('mongoose').connection.readyState).toBe(0);
    });
  });

  test('requires nothing that talks to the outside world', () => {
    for (const file of FILES.slice(0, 3)) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(source).not.toMatch(/require\(['"][^'"]*(whatsapp|ai\/client|ai\/tools|server|dbSetup|testAuth|stripe)[^'"]*['"]\)/);
    }
  });

  test('parseRows is the CSV reader used (sanity for line numbering)', () => {
    expect(parseRows('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});
