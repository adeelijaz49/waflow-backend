const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();
const h = require('./helpers/_harness');
const Customer = require('../../../models/Customer');
const CustomerLanguage = require('../../../models/CustomerLanguage');
const Settings = require('../../../models/Settings');
const localeSettings = require('../../../shared/localization/settings');
const svc = require('../../../shared/localization/customerLanguage');

const deps = (extra = {}) => ({ Customer, CustomerLanguage, Settings, localeSettings, ...extra });
const BOM = String.fromCodePoint(0xFEFF);
const csv = (text) => Buffer.from(`${BOM}${text}`, 'utf8');
const idOf = (row) => String(row.customerId || row.id);

describe('B1 customers on real MongoDB', () => {
  let ctx; let a; let b;
  const A = {}; // fixtures in workspace A
  beforeAll(async () => {
    ctx = await h.setup();
    a = ctx.api(ctx.A); b = ctx.api(ctx.B);
    const w = ctx.A.wsId;
    A.mohammed = await h.makeCustomer(w, { firstname: 'محمد', lastname: 'العتيبي', phone: '966501110001' });
    A.ahmad = await h.makeCustomer(w, { firstname: 'أحمد', lastname: 'القحطاني', phone: '966501110002' });
    A.sara = await h.makeCustomer(w, { firstname: 'Sara', lastname: 'Smith', phone: '966501110003' });
    A.omar = await h.makeCustomer(w, { firstname: 'Omar', lastname: 'Khan', phone: '966501110004' });
    A.erased = await h.makeCustomer(w, { firstname: 'محمد', lastname: 'محذوف', phone: '966501110005', deletedAt: new Date() });
    A.demo = await h.makeCustomer(w, { firstname: 'محمد', lastname: 'تجريبي', phone: '966501110006', isDemo: true });
    A.chose = await h.makeCustomer(w, { firstname: 'Fatima', lastname: 'Chose', phone: '966501110007' });
    A.bOwn = await h.makeCustomer(ctx.B.wsId, { firstname: 'محمد', lastname: 'ب', phone: '966501110001' }); // SAME phone, other tenant
    await CustomerLanguage.create({ workspaceId: w, customerId: A.sara._id, language: 'en', languageSource: 'merchant_set' });
    await CustomerLanguage.create({ workspaceId: w, customerId: A.chose._id, language: 'ar', languageSource: 'customer_chose' });
  });

  test('search is Arabic-aware and excludes erased and demo customers', async () => {
    const r = await a.get('/customers?search=' + encodeURIComponent('محمد'));
    expect(r.status).toBe(200);
    expect(r.body.items.map(idOf)).toEqual([String(A.mohammed._id)]);
    const hamza = await a.get('/customers?search=' + encodeURIComponent('احمد'));
    expect(hamza.body.items.map(idOf)).toContain(String(A.ahmad._id));
    const tashkeel = await a.get('/customers?search=' + encodeURIComponent('أَحْمَد'));
    expect(tashkeel.body.items.map(idOf)).toContain(String(A.ahmad._id));
  });

  test('search by phone: Arabic-Indic digits, national format and AND of tokens', async () => {
    const indic = await a.get('/customers?search=' + encodeURIComponent('٩٦٦٥٠١١١٠٠٠٤'));
    expect(indic.body.items).toHaveLength(1);
    const national = await a.get('/customers?search=0501110004');
    expect(national.body.items).toHaveLength(1);
    const both = await a.get('/customers?search=' + encodeURIComponent('Omar Khan'));
    expect(both.body.items).toHaveLength(1);
    const none = await a.get('/customers?search=' + encodeURIComponent('Omar Smith'));
    expect(none.body.items).toHaveLength(0);
  });

  test('regex metacharacters in search never act as a pattern', async () => {
    for (const q of ['.*', '(', '[a-z]+', 'a|b', '\\']) {
      const r = await a.get('/customers?search=' + encodeURIComponent(q));
      expect(r.status).toBe(200);
      expect(r.body.items).toHaveLength(0);
    }
  });

  test('language filter + counts: en / ar / unknown over real sidecar rows', async () => {
    const en = await a.get('/customers?language=en&limit=200');
    expect(en.body.items.map((i) => i.language)).toEqual(['en']);
    expect(en.body.total).toBe(1);
    const ar = await a.get('/customers?language=ar');
    expect(ar.body.total).toBe(1);
    const unk = await a.get('/customers?language=unknown&limit=200');
    expect(unk.body.total).toBe(3); // mohammed, ahmad, omar; erased/demo/other tenant never listed
    expect(unk.body.counts).toMatchObject({ en: 1, ar: 1, unknown: 3, total: 5 });
  });

  test('counts ignore sidecar rows of erased/demo customers', async () => {
    await CustomerLanguage.create({ workspaceId: ctx.A.wsId, customerId: A.erased._id, language: 'ar', languageSource: 'merchant_set' });
    await CustomerLanguage.create({ workspaceId: ctx.A.wsId, customerId: A.demo._id, language: 'en', languageSource: 'merchant_set' });
    const counts = await svc.getCounts(ctx.A.wsId);
    expect(counts).toMatchObject({ en: 1, ar: 1, unknown: 3, total: 5 });
  });

  test('CLAUSE_MAX fallback (id lists above the cap) returns the same page as the $in/$nin path', async () => {
    const w = ctx.A.wsId;
    const small = deps({ limits: { clauseMax: 1 } });
    const extra = await h.makeCustomer(w, { firstname: 'Zed', lastname: 'Arabicspeaker', phone: '966501119999' });
    await CustomerLanguage.create({ workspaceId: w, customerId: extra._id, language: 'ar', languageSource: 'merchant_set' });
    for (const language of ['ar', 'en', 'unknown']) {
      const viaIn = await svc.listCustomers({ workspaceId: w, language, limit: 200 }, deps());
      const viaIntersect = await svc.listCustomers({ workspaceId: w, language, limit: 200 }, small);
      expect(viaIntersect.total).toBe(viaIn.total);
      expect(viaIntersect.items.map(idOf)).toEqual(viaIn.items.map(idOf));
    }
    const p1 = await svc.listCustomers({ workspaceId: w, language: 'unknown', limit: 2, page: 1 }, small);
    const p2 = await svc.listCustomers({ workspaceId: w, language: 'unknown', limit: 2, page: 2 }, small);
    expect(p1.items).toHaveLength(2); expect(p2.items).toHaveLength(1);
    expect(new Set([...p1.items, ...p2.items].map(idOf)).size).toBe(3);
  });

  test('large set: 1,200 customers with language rows page and count correctly (real $in chunking)', async () => {
    const t = await h.makeTenant('Big', { flagged: true });
    const docs = Array.from({ length: 1200 }, (_, i) => ({ workspaceId: t.wsId, firstname: `N${i}`, lastname: 'Big', phone: `9665${String(20000000 + i)}` }));
    const created = await Customer.insertMany(docs);
    await CustomerLanguage.insertMany(created.slice(0, 700).map((c) => ({ workspaceId: t.wsId, customerId: c._id, language: 'ar', languageSource: 'inferred' })));
    const ar = await svc.listCustomers({ workspaceId: t.wsId, language: 'ar', limit: 200, page: 4 }, deps({ limits: { clauseMax: 100 } }));
    expect(ar.total).toBe(700); expect(ar.items).toHaveLength(100);
    const unk = await svc.listCustomers({ workspaceId: t.wsId, language: 'unknown', limit: 200 }, deps());
    expect(unk.total).toBe(500);
    expect((await svc.getCounts(t.wsId)).ar).toBe(700);
  });

  test('set one: sets merchant_set, 404 for other tenant, 400 for operator injection and bad id', async () => {
    const ok = await a.put(`/customers/${A.omar._id}/language`).send({ language: 'ar' });
    expect(ok.status).toBe(200); expect(ok.body.language).toBe('ar');
    const stored = await CustomerLanguage.findOne({ workspaceId: ctx.A.wsId, customerId: A.omar._id }).lean();
    expect(stored.languageSource).toBe('merchant_set');
    expect(String(stored.updatedBy)).toBe(String(ctx.A.userId));
    const cross = await b.put(`/customers/${A.omar._id}/language`).send({ language: 'en' });
    expect(cross.status).toBe(404); expect(cross.body.code).toBe('CUSTOMER_NOT_FOUND');
    expect((await CustomerLanguage.findOne({ workspaceId: ctx.A.wsId, customerId: A.omar._id }).lean()).language).toBe('ar');
    expect(await CustomerLanguage.countDocuments({ workspaceId: ctx.B.wsId, customerId: A.omar._id })).toBe(0);
    const inj = await a.put(`/customers/${A.omar._id}/language`).send({ language: { $ne: null } });
    expect(inj.status).toBe(400);
    const badId = await a.put('/customers/not-an-id/language').send({ language: 'ar' });
    expect(badId.status).toBe(400); expect(badId.body.code).toBe('INVALID_ID');
  });

  test('re-setting keeps a single sidecar row (unique index); unknown clears', async () => {
    await a.put(`/customers/${A.mohammed._id}/language`).send({ language: 'en' });
    await a.put(`/customers/${A.mohammed._id}/language`).send({ language: 'ar' });
    expect(await CustomerLanguage.countDocuments({ workspaceId: ctx.A.wsId, customerId: A.mohammed._id })).toBe(1);
    await a.put(`/customers/${A.mohammed._id}/language`).send({ language: 'unknown' });
    expect((await CustomerLanguage.findOne({ workspaceId: ctx.A.wsId, customerId: A.mohammed._id }).lean()).language).toBe('unknown');
  });

  test('the unique (workspaceId, customerId) index is really built', async () => {
    await expect(CustomerLanguage.create({ workspaceId: ctx.A.wsId, customerId: A.sara._id, language: 'ar' })).rejects.toMatchObject({ code: 11000 });
  });

  test('concurrent set-language on a brand-new customer yields exactly one row (E11000 retry path)', async () => {
    const c = await h.makeCustomer(ctx.A.wsId, { firstname: 'Race', lastname: 'One' });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => svc.setCustomerLanguage({ workspaceId: ctx.A.wsId, customerId: String(c._id), language: i % 2 ? 'ar' : 'en', userId: String(ctx.A.userId) })));
    expect(results.every((r) => ['ar', 'en'].includes(r.language))).toBe(true);
    expect(await CustomerLanguage.countDocuments({ workspaceId: ctx.A.wsId, customerId: c._id })).toBe(1);
  });

  test('bulk: only own customers are written; other tenant ids are skipped; injections are 400s', async () => {
    const r = await a.post('/customers/language/bulk').send({ customerIds: [String(A.sara._id), String(A.bOwn._id), String(A.erased._id)], language: 'ar' });
    expect(r.status).toBe(200); expect(r.body.updated).toBe(1);
    expect(await CustomerLanguage.countDocuments({ workspaceId: ctx.B.wsId })).toBe(0);
    expect((await CustomerLanguage.findOne({ workspaceId: ctx.A.wsId, customerId: A.sara._id }).lean()).language).toBe('ar');
    expect((await a.post('/customers/language/bulk').send({ customerIds: [{ $ne: null }], language: 'ar' })).status).toBe(400);
    expect((await a.post('/customers/language/bulk').send({ customerIds: { $ne: null }, language: 'ar' })).status).toBe(400);
    expect((await a.post('/customers/language/bulk').send({ customerIds: Array(1001).fill(String(A.sara._id)), language: 'ar' })).status).toBe(400);
  });

  test('bulk of 1,000 real customers (> BULK_CHUNK) upserts every row', async () => {
    const t = await h.makeTenant('Bulk', { flagged: true });
    const created = await Customer.insertMany(Array.from({ length: 1000 }, (_, i) => ({ workspaceId: t.wsId, firstname: `B${i}`, lastname: 'Bulk', phone: `9665${String(30000000 + i)}` })));
    const r = await ctx.api(t).post('/customers/language/bulk').send({ customerIds: created.map((c) => String(c._id)), language: 'ar' });
    expect(r.body.updated).toBe(1000);
    expect(await CustomerLanguage.countDocuments({ workspaceId: t.wsId, language: 'ar', languageSource: 'merchant_set' })).toBe(1000);
  });

  describe('CSV import', () => {
    test('dry run writes nothing and reports outcomes (tenant B with the same phone is invisible)', async () => {
      const before = await CustomerLanguage.countDocuments({ workspaceId: ctx.A.wsId });
      const text = 'phone,language\n966501110002,ar\n٠٥٠١١١٠٠٠٤,English\n966509999999,ar\nabc,ar\n966501110007,en\n';
      const r = await a.post('/customers/language/import').field('dryRun', 'true').attach('file', csv(text), 'x.csv');
      expect(r.status).toBe(200); expect(r.body.dryRun).toBe(true);
      expect(r.body.summary).toMatchObject({ rows: 5, updated: 2, unmatched: 1, invalid: 1, protected: 1 });
      expect(await CustomerLanguage.countDocuments({ workspaceId: ctx.A.wsId })).toBe(before);
      expect(await CustomerLanguage.countDocuments({ workspaceId: ctx.B.wsId })).toBe(0);
    });

    test('missing dryRun field is a dry run (never writes by accident)', async () => {
      const before = await CustomerLanguage.countDocuments({ workspaceId: ctx.A.wsId });
      const r = await a.post('/customers/language/import').attach('file', csv('phone,language\n966501110002,ar\n'), 'x.csv');
      expect(r.body.dryRun).toBe(true);
      expect(await CustomerLanguage.countDocuments({ workspaceId: ctx.A.wsId })).toBe(before);
    });

    test('real run writes csv_import rows, never touches customer_chose or tenant B', async () => {
      const text = 'phone;language\n966501110002;ar\n966501110007;en\n966501110001;ar\n';
      const r = await a.post('/customers/language/import').field('dryRun', 'false').attach('file', csv(text), 'x.csv');
      expect(r.status).toBe(200); expect(r.body.dryRun).toBe(false); expect(r.body.delimiter).toBe(';');
      expect(r.body.summary.protected).toBe(1);
      expect(await CustomerLanguage.findOne({ workspaceId: ctx.A.wsId, customerId: A.ahmad._id }).lean()).toMatchObject({ language: 'ar', languageSource: 'csv_import' });
      expect(await CustomerLanguage.findOne({ workspaceId: ctx.A.wsId, customerId: A.chose._id }).lean()).toMatchObject({ language: 'ar', languageSource: 'customer_chose' });
      expect(await CustomerLanguage.countDocuments({ workspaceId: ctx.B.wsId })).toBe(0);
    });

    test('atomic guard: a language the customer chose BETWEEN matching and writing is not overwritten', async () => {
      const c = await h.makeCustomer(ctx.A.wsId, { firstname: 'Late', lastname: 'Chooser', phone: '966501117777' });
      const racing = {
        find: (...x) => CustomerLanguage.find(...x),
        countDocuments: (...x) => CustomerLanguage.countDocuments(...x),
        bulkWrite: async (ops, opts) => {
          if (!racing.done) { racing.done = true; await CustomerLanguage.create({ workspaceId: ctx.A.wsId, customerId: c._id, language: 'ar', languageSource: 'customer_chose' }); }
          return CustomerLanguage.bulkWrite(ops, opts);
        },
      };
      const r = await svc.importLanguages({ workspaceId: ctx.A.wsId, userId: String(ctx.A.userId), file: { buffer: Buffer.from('phone,language\n966501117777,en\n') }, dryRun: false }, deps({ CustomerLanguage: racing }));
      expect(r.summary.protected).toBe(1); expect(r.summary.updated).toBe(0);
      expect(await CustomerLanguage.findOne({ workspaceId: ctx.A.wsId, customerId: c._id }).lean()).toMatchObject({ language: 'ar', languageSource: 'customer_chose' });
    });

    test('an insert race on the unique index is retried once and then succeeds', async () => {
      const c = await h.makeCustomer(ctx.A.wsId, { firstname: 'Dup', lastname: 'Racer', phone: '966501118888' });
      let first = true;
      const racing = {
        find: (...x) => CustomerLanguage.find(...x),
        countDocuments: (...x) => CustomerLanguage.countDocuments(...x),
        bulkWrite: async (ops, opts) => {
          if (first) { first = false; await CustomerLanguage.create({ workspaceId: ctx.A.wsId, customerId: c._id, language: 'en', languageSource: 'inferred' }); }
          return CustomerLanguage.bulkWrite(ops, opts);
        },
      };
      const r = await svc.importLanguages({ workspaceId: ctx.A.wsId, userId: String(ctx.A.userId), file: { buffer: Buffer.from('phone,language\n966501118888,ar\n') }, dryRun: false }, deps({ CustomerLanguage: racing }));
      expect(r.summary.updated).toBe(1);
      expect(await CustomerLanguage.findOne({ workspaceId: ctx.A.wsId, customerId: c._id }).lean()).toMatchObject({ language: 'ar', languageSource: 'csv_import' });
    });

    test('Arabic headers and rejects (no phone column / no file)', async () => {
      await h.makeCustomer(ctx.A.wsId, { firstname: 'Hdr', lastname: 'Case', phone: '966501116666' });
      const r1 = await a.post('/customers/language/import').field('dryRun', 'true').attach('file', csv('رقم الجوال,اللغة\n966501116666,عربي\n'), 'ar.csv');
      expect(r1.status).toBe(200); expect(r1.body.summary.updated).toBe(1);
      const r2 = await a.post('/customers/language/import').field('dryRun', 'true').attach('file', csv('name,language\nx,ar\n'), 'bad.csv');
      expect(r2.status).toBe(400); expect(r2.body.code).toBe('CSV_NO_PHONE_COLUMN');
      const r3 = await a.post('/customers/language/import').field('dryRun', 'true');
      expect(r3.status).toBe(400); expect(r3.body.code).toBe('FILE_REQUIRED');
    });

    test('export and template are scoped to the workspace', async () => {
      const ex = await a.get('/customers/language/export.csv');
      expect(ex.status).toBe(200); expect(ex.headers['content-type']).toMatch(/text\/csv/);
      expect(ex.text).toContain('966501110004'); expect(ex.text).not.toContain('محذوف'); expect(ex.text).not.toContain('تجريبي');
      const exB = await b.get('/customers/language/export.csv');
      expect(exB.text).not.toContain('966501110004');
      const tpl = await a.get('/customers/language/template.csv');
      expect(tpl.status).toBe(200); expect(tpl.text).toContain('phone,language');
    });
  });
});
