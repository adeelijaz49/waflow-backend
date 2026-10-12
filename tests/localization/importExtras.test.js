// Pure unit tests (no database): Arabic additions to the existing import wizard.
//  * arabicHeaderFor  - approved global change B2c (Arabic header aliases, fallback only)
//  * createImportExtras - flagged-workspace extras: gate, wizard fields, auto-mapping, row reader,
//    collector and finish() with fake collaborators.
const importExtras = require('../../shared/localization/importExtras');

const { arabicHeaderFor, createImportExtras, LANGUAGE_ERROR } = importExtras;

// Arabic header words, written as escapes so the table is reviewable and hygiene-safe.
const H = {
  name: '\u{0627}\u{0644}\u{0627}\u{0633}\u{0645}', // الاسم
  customerName: '\u{0627}\u{0633}\u{0645} \u{0627}\u{0644}\u{0639}\u{0645}\u{064A}\u{0644}', // اسم العميل
  phone: '\u{0627}\u{0644}\u{062C}\u{0648}\u{0627}\u{0644}', // الجوال
  phoneNo: '\u{0631}\u{0642}\u{0645} \u{0627}\u{0644}\u{062C}\u{0648}\u{0627}\u{0644}', // رقم الجوال
  price: '\u{0627}\u{0644}\u{0633}\u{0639}\u{0631}', // السعر
  language: '\u{0627}\u{0644}\u{0644}\u{063A}\u{0629}', // اللغة
  nameAr: '\u{0627}\u{0644}\u{0627}\u{0633}\u{0645} \u{0628}\u{0627}\u{0644}\u{0639}\u{0631}\u{0628}\u{064A}\u{0629}', // الاسم بالعربية
  productName: '\u{0627}\u{0633}\u{0645} \u{0627}\u{0644}\u{0645}\u{0646}\u{062A}\u{062C}', // اسم المنتج
  email: '\u{0627}\u{0644}\u{0628}\u{0631}\u{064A}\u{062F} \u{0627}\u{0644}\u{0625}\u{0644}\u{0643}\u{062A}\u{0631}\u{0648}\u{0646}\u{064A}', // البريد الإلكتروني
  points: '\u{0627}\u{0644}\u{0646}\u{0642}\u{0627}\u{0637}', // النقاط
  notes: '\u{0645}\u{0644}\u{0627}\u{062D}\u{0638}\u{0627}\u{062A}', // ملاحظات
  duration: '\u{0627}\u{0644}\u{0645}\u{062F}\u{0629}', // المدة
};
const SARA = '\u{0633}\u{0627}\u{0631}\u{0629}'; // سارة
const ARABIC = '\u{0639}\u{0631}\u{0628}\u{064A}'; // عربي

describe('arabicHeaderFor (B2c)', () => {
  test.each([
    ['customer', 'name', H.name], ['customer', 'name', H.customerName],
    ['customer', 'phone', H.phone], ['customer', 'phone', H.phoneNo],
    ['customer', 'email', H.email], ['customer', 'startingPoints', H.points], ['customer', 'notes', H.notes],
    ['product', 'name', H.productName], ['product', 'basePrice', H.price],
    ['service', 'basePrice', H.price], ['service', 'duration', H.duration],
  ])('%s.%s <- %s', (entity, field, header) => {
    expect(arabicHeaderFor(entity, field, ['x', header, 'y'])).toBe(header);
  });

  test('spelling variants collapse: tashkeel, alef forms, teh marbuta, tatweel, spacing', () => {
    expect(arabicHeaderFor('customer', 'phone', [`${'\u{0627}\u{0644}\u{062C}\u{0648}\u{0627}\u{0644}'}\u{064E}`])).toBeDefined(); // with fatha
    expect(arabicHeaderFor('customer', 'email', ['\u{0627}\u{0644}\u{0628}\u{0631}\u{064A}\u{062F} \u{0627}\u{0644}\u{0627}\u{0644}\u{0643}\u{062A}\u{0631}\u{0648}\u{0646}\u{064A}'])).toBeDefined(); // without hamza
    expect(arabicHeaderFor('customer', 'phone', [`  ${H.phoneNo}  `])).toBeDefined();
    expect(arabicHeaderFor('customer', 'name', ['\u{0627}\u{0644}\u{0627}\u{0633}\u{0640}\u{0640}\u{0645}'])).toBeDefined(); // tatweel
  });

  test('returns undefined for English / unknown / non-array headers and unknown fields, never throws', () => {
    expect(arabicHeaderFor('customer', 'name', ['name', 'Phone', 'Email'])).toBeUndefined();
    expect(arabicHeaderFor('customer', 'name', [H.phone])).toBeUndefined();
    expect(arabicHeaderFor('customer', 'language', [H.language])).toBeUndefined(); // extras are flagged-only, not a base alias
    expect(arabicHeaderFor('widget', 'name', [H.name])).toBeUndefined();
    expect(arabicHeaderFor('customer', 'name', undefined)).toBeUndefined();
    expect(arabicHeaderFor('customer', 'name', [null, undefined, 5, {}])).toBeUndefined();
    expect(arabicHeaderFor(undefined, undefined, [])).toBeUndefined();
  });

  test('Arabic-name header of the extras is NOT a base name alias (no stealing)', () => {
    expect(arabicHeaderFor('product', 'name', [H.nameAr])).toBeUndefined();
  });
});

// ── fake collaborators ───────────────────────────────────────────────────────
function makeExtras({ flagged = true, setImported, saveDrafts, flagThrows = false } = {}) {
  const customerLanguage = { setImportedLanguages: jest.fn(setImported || (async ({ entries }) => ({ written: entries.length, protected: 0, unchanged: 0, skipped: 0 }))) };
  const catalogTranslations = { saveImportedDrafts: jest.fn(saveDrafts || (async ({ items }) => ({ saved: items.length, unchanged: 0, failed: 0 }))) };
  const isArabicEnabled = jest.fn(async () => { if (flagThrows) throw new Error('db down'); return flagged; });
  const extras = createImportExtras({ isArabicEnabled, customerLanguage: () => customerLanguage, catalogTranslations: () => catalogTranslations });
  return { extras, customerLanguage, catalogTranslations, isArabicEnabled };
}

describe('forWorkspace: only flagged workspaces get extras', () => {
  test('flagged -> an object per entity type; not flagged / kill switch / error / bad input -> null', async () => {
    const on = makeExtras();
    for (const type of ['customer', 'product', 'service']) expect(await on.extras.forWorkspace(type, 'ws1', 'u1')).toEqual(expect.objectContaining({ entityType: type }));
    expect(await makeExtras({ flagged: false }).extras.forWorkspace('customer', 'ws1', 'u1')).toBeNull();
    expect(await makeExtras({ flagThrows: true }).extras.forWorkspace('customer', 'ws1', 'u1')).toBeNull();
    expect(await on.extras.forWorkspace('widget', 'ws1', 'u1')).toBeNull();
    expect(await on.extras.forWorkspace('customer', undefined, 'u1')).toBeNull();
    expect(await on.extras.forWorkspace('customer', null, 'u1')).toBeNull();
  });

  test('the real module is null for the kill switch and when nothing can be read (no DB here)', async () => {
    const saved = process.env.LOCALIZATION_DISABLED;
    process.env.LOCALIZATION_DISABLED = '1';
    try {
      expect(await importExtras.forWorkspace('customer', '0123456789abcdef01234567', 'u')).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.LOCALIZATION_DISABLED; else process.env.LOCALIZATION_DISABLED = saved;
    }
  });

  test('withExtraFields / withExtraMapping return the SAME reference when there are no extras', () => {
    const fields = [{ key: 'name' }];
    const mapping = { name: 'Name' };
    expect(importExtras.withExtraFields(null, fields)).toBe(fields);
    expect(importExtras.withExtraMapping(null, ['Name'], mapping)).toBe(mapping);
  });

  test('wizard fields: customer gets language; product and service get Arabic name + description; base fields untouched', async () => {
    const { extras } = makeExtras();
    const customer = await extras.forWorkspace('customer', 'ws1', 'u1');
    const base = [{ key: 'name', label: 'Name', required: true, type: 'string', aliases: ['name'] }];
    const merged = extras.withExtraFields(customer, base);
    expect(merged[0]).toBe(base[0]);
    expect(merged.slice(1).map((f) => f.key)).toEqual(['language']);
    expect(merged[1]).toMatchObject({ label: 'Language', required: false, type: 'language', hint: 'ar, en, Arabic or English' });
    expect(base).toHaveLength(1); // the engine's own array is never mutated
    for (const type of ['product', 'service']) {
      const e = await extras.forWorkspace(type, 'ws1', 'u1');
      expect(extras.withExtraFields(e, base).slice(1).map((f) => [f.key, f.required, f.hint])).toEqual([
        ['nameAr', false, 'Saved as a draft for review'], ['descriptionAr', false, 'Saved as a draft for review'],
      ]);
    }
  });
});

describe('auto-mapping of the extra fields', () => {
  test.each([
    ['customer', ['Name', 'Phone', 'Language'], { language: 'Language' }],
    ['customer', [H.name, H.phone, H.language], { language: H.language }],
    ['customer', ['name', 'lang'], { language: 'lang' }],
    ['customer', ['Preferred Language'], { language: 'Preferred Language' }],
    ['product', ['name', 'price', 'name_ar', 'description_ar'], { nameAr: 'name_ar', descriptionAr: 'description_ar' }],
    ['product', ['Name (Arabic)', 'Arabic Description'], { nameAr: 'Name (Arabic)', descriptionAr: 'Arabic Description' }],
    ['service', [H.nameAr], { nameAr: H.nameAr }],
    ['customer', ['Name', 'Phone'], {}],
  ])('%s %j -> %j', async (type, headers, expected) => {
    const { extras } = makeExtras();
    const e = await extras.forWorkspace(type, 'ws1', 'u1');
    expect(extras.withExtraMapping(e, headers, {})).toEqual(expected);
  });

  test('never steals a header already mapped to a base field; keeps the base mapping', async () => {
    const { extras } = makeExtras();
    const e = await extras.forWorkspace('customer', 'ws1', 'u1');
    const merged = extras.withExtraMapping(e, ['Language', 'Phone'], { name: 'Language', phone: 'Phone' });
    expect(merged).toEqual({ name: 'Language', phone: 'Phone' });
  });
});

describe('readRow', () => {
  const customerRow = async (cell, mapping = { language: 'Language' }) => {
    const { extras } = makeExtras();
    const e = await extras.forWorkspace('customer', 'ws1', 'u1');
    const mapped = {};
    const errors = [];
    e.readRow({ Language: cell, Other: 'x' }, mapping, mapped, errors);
    return { mapped, errors };
  };

  test.each([
    ['ar', 'ar'], ['en', 'en'], ['Arabic', 'ar'], ['English', 'en'], [ARABIC, 'ar'], ['AR', 'ar'], [' ar-SA ', 'ar'], ['en-US', 'en'],
    ['\u{0627}\u{0644}\u{0639}\u{0631}\u{0628}\u{064A}\u{0629}', 'ar'], // العربية
    ['\u{0625}\u{0646}\u{062C}\u{0644}\u{064A}\u{0632}\u{064A}', 'en'], // إنجليزي
  ])('language cell %j -> %s', async (cell, expected) => {
    const { mapped, errors } = await customerRow(cell);
    expect(errors).toEqual([]);
    expect(mapped._language).toBe(expected);
  });

  test.each([[''], ['   '], [undefined], [null], ['unknown']])('blank / unknown cell %j is "no information": no value, no error', async (cell) => {
    const { mapped, errors } = await customerRow(cell);
    expect(errors).toEqual([]);
    expect(mapped._language).toBeUndefined();
  });

  test.each([['fr'], ['klingon'], ['\u{1F600}'], ['12']])('an invalid language %j is an ordinary row error', async (cell) => {
    const { mapped, errors } = await customerRow(cell);
    expect(errors).toEqual([{ field: 'language', reason: LANGUAGE_ERROR }]);
    expect(mapped._language).toBeUndefined();
  });

  test('an unmapped language column is ignored entirely', async () => {
    const { mapped, errors } = await customerRow('fr', {});
    expect(mapped).toEqual({});
    expect(errors).toEqual([]);
  });

  const productRow = async (row, mapping = { nameAr: 'NameAr', descriptionAr: 'DescAr' }, type = 'product') => {
    const { extras } = makeExtras();
    const e = await extras.forWorkspace(type, 'ws1', 'u1');
    const mapped = {};
    const errors = [];
    e.readRow(row, mapping, mapped, errors);
    return { mapped, errors };
  };

  test('Arabic name + description are cleaned and kept as typed (Latin, emoji, Arabic-Indic digits survive)', async () => {
    const typed = `${SARA} Special \u{2615} \u{0661}\u{0662}\u{0663} \u{0631}.\u{0633}`;
    const { mapped, errors } = await productRow({ NameAr: `  ${typed}\u{200E} `, DescAr: ' line1\r\nline2 ' });
    expect(errors).toEqual([]);
    expect(mapped._nameAr).toBe(typed); // trimmed, bidi mark removed
    expect(mapped._descriptionAr).toBe('line1\nline2');
  });

  test('name without description is fine; description without name is an error; both blank is nothing', async () => {
    expect((await productRow({ NameAr: SARA, DescAr: '' })).mapped).toEqual({ _nameAr: SARA });
    expect((await productRow({ NameAr: '', DescAr: 'text' })).errors).toEqual([{ field: 'descriptionAr', reason: 'Arabic description needs an Arabic name' }]);
    expect(await productRow({ NameAr: ' ', DescAr: ' ' })).toEqual({ mapped: {}, errors: [] });
  });

  test('length limits count code points (200 / 2000), emoji count as one', async () => {
    expect((await productRow({ NameAr: '\u{1F600}'.repeat(200), DescAr: '' })).errors).toEqual([]);
    expect((await productRow({ NameAr: '\u{1F600}'.repeat(201), DescAr: '' })).errors).toEqual([{ field: 'nameAr', reason: 'Arabic name is too long (max 200 characters)' }]);
    expect((await productRow({ NameAr: 'a', DescAr: 'b'.repeat(2001) })).errors).toEqual([{ field: 'descriptionAr', reason: 'Arabic description is too long (max 2000 characters)' }]);
    expect((await productRow({ NameAr: 'a', DescAr: 'b'.repeat(2000) })).errors).toEqual([]);
  });

  test('the service entity reads the same columns; readRow never throws on hostile rows', async () => {
    expect((await productRow({ NameAr: SARA }, { nameAr: 'NameAr' }, 'service')).mapped._nameAr).toBe(SARA);
    const { extras } = makeExtras();
    const e = await extras.forWorkspace('product', 'ws1', 'u1');
    const errors = [];
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => e.readRow(undefined, { nameAr: 'x' }, {}, errors)).not.toThrow();
      expect(() => e.readRow({ x: { toString() { throw new Error('boom'); } } }, { nameAr: 'x' }, {}, errors)).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('afterRow + finish', () => {
  test('customers: first row per customer wins; finish passes entries, workspace and user, and reports the counts', async () => {
    const { extras, customerLanguage, catalogTranslations } = makeExtras({
      setImported: async () => ({ written: 2, protected: 1, unchanged: 3, skipped: 4 }),
    });
    const e = await extras.forWorkspace('customer', 'ws1', 'user1');
    e.afterRow('customer', 'c1', { _language: 'ar' });
    e.afterRow('customer', 'c1', { _language: 'en' });
    e.afterRow('customer', 'c2', { _language: 'en' });
    e.afterRow('customer', 'c3', {}); // no language: nothing collected
    e.afterRow('customer', undefined, { _language: 'ar' });
    e.afterRow('customer', 'c4', undefined);
    const summary = await e.finish();
    expect(customerLanguage.setImportedLanguages).toHaveBeenCalledWith({
      workspaceId: 'ws1', userId: 'user1', entries: [{ customerId: 'c1', language: 'ar' }, { customerId: 'c2', language: 'en' }],
    });
    expect(catalogTranslations.saveImportedDrafts).not.toHaveBeenCalled();
    expect(summary).toEqual({
      languagesSet: 2, languagesProtected: 1, languagesUnchanged: 3, languagesSkipped: 4, languagesFailed: 0,
      translationsSaved: 0, translationsUnchanged: 0, translationsFailed: 0,
    });
  });

  test('products and services: items keyed by kind + id, first wins, description optional', async () => {
    const { extras, catalogTranslations, customerLanguage } = makeExtras({ saveDrafts: async () => ({ saved: 1, unchanged: 1, failed: 2 }) });
    const e = await extras.forWorkspace('product', 'ws1', 'user1');
    e.afterRow('product', 'p1', { _nameAr: 'a', _descriptionAr: 'd' });
    e.afterRow('product', 'p1', { _nameAr: 'zzz' });
    e.afterRow('product', 'p2', { _nameAr: 'b' });
    e.afterRow('product', 'p3', {});
    const summary = await e.finish();
    expect(catalogTranslations.saveImportedDrafts).toHaveBeenCalledWith({
      workspaceId: 'ws1', userId: 'user1',
      items: [{ kind: 'product', refId: 'p1', name: 'a', description: 'd' }, { kind: 'product', refId: 'p2', name: 'b', description: undefined }],
    });
    expect(customerLanguage.setImportedLanguages).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ translationsSaved: 1, translationsUnchanged: 1, translationsFailed: 2, languagesSet: 0 });
  });

  test('nothing collected: finish does no work and returns zeros', async () => {
    const { extras, customerLanguage, catalogTranslations } = makeExtras();
    const e = await extras.forWorkspace('service', 'ws1', 'u1');
    expect(await e.finish()).toEqual({
      languagesSet: 0, languagesProtected: 0, languagesUnchanged: 0, languagesSkipped: 0, languagesFailed: 0,
      translationsSaved: 0, translationsUnchanged: 0, translationsFailed: 0,
    });
    expect(customerLanguage.setImportedLanguages).not.toHaveBeenCalled();
    expect(catalogTranslations.saveImportedDrafts).not.toHaveBeenCalled();
  });

  test('a failing collaborator is counted, never thrown (the import itself has already succeeded)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const a = makeExtras({ setImported: async () => { throw new Error('E11000'); } });
      const c = await a.extras.forWorkspace('customer', 'ws1', 'u1');
      c.afterRow('customer', 'c1', { _language: 'ar' });
      c.afterRow('customer', 'c2', { _language: 'ar' });
      await expect(c.finish()).resolves.toMatchObject({ languagesFailed: 2, languagesSet: 0 });
      const b = makeExtras({ saveDrafts: async () => { throw new Error('db down'); } });
      const p = await b.extras.forWorkspace('product', 'ws1', 'u1');
      p.afterRow('product', 'p1', { _nameAr: 'x' });
      await expect(p.finish()).resolves.toMatchObject({ translationsFailed: 1, translationsSaved: 0 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('source guards', () => {
  const fs = require('fs');
  const path = require('path');
  test.each(['importExtras.js', 'importDecode.js', 'nameGuard.js', 'pages/switchLink.js'])('%s never deletes anything and does not touch the Customer / Product models', (file) => {
    const text = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'localization', file), 'utf8');
    expect(text).not.toMatch(/deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|\.remove\(|\.drop\(/);
    expect(text).not.toMatch(/models\/(Customer|Product|Service)['"]/);
  });
});
