const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();
const h = require('./helpers/_harness');
const Product = require('../../../models/Product');
const Service = require('../../../models/Service');
const ProductTranslation = require('../../../models/ProductTranslation');
const catalog = require('../../../shared/localization/catalogTranslations');

const BOM = String.fromCodePoint(0xFEFF);
const csv = (text) => Buffer.from(`${BOM}${text}`, 'utf8');
const mkProduct = (ws, name, extra = {}) => Product.create({ workspaceId: ws, name, category: 'Shoes', basePrice: 10, ...extra });
const mkService = (ws, name, extra = {}) => Service.create({ workspaceId: ws, name, category: 'Care', ...extra });

describe('B5 catalogue on real MongoDB', () => {
  let ctx; let a; let b; let c;
  const A = {};
  beforeAll(async () => {
    ctx = await h.setup();
    a = ctx.api(ctx.A); b = ctx.api(ctx.B); c = ctx.api(ctx.C);
    A.shoe = await mkProduct(ctx.A.wsId, 'Red Sneaker');
    A.hat = await mkProduct(ctx.A.wsId, 'Blue Hat');
    A.twin1 = await mkProduct(ctx.A.wsId, 'Twin Item');
    A.twin2 = await mkProduct(ctx.A.wsId, 'Twin Item');
    A.massage = await mkService(ctx.A.wsId, 'Massage');
    A.bShoe = await mkProduct(ctx.B.wsId, 'Red Sneaker');
  });

  test('list is workspace scoped and joins translation status', async () => {
    const r = await a.get('/catalog/items?limit=100');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(5);
    expect(r.body.counts).toMatchObject({ missing: 5, draft: 0, reviewed: 0 });
    const ids = r.body.items.map((i) => String(i.refId || i.id));
    expect(ids).not.toContain(String(A.bShoe._id));
    const rb = await b.get('/catalog/items?limit=100');
    expect(rb.body.total).toBe(1);
  });

  test('save creates a draft; identical re-save is a no-op; changed text drops review back to draft', async () => {
    const put = await a.put(`/catalog/product/${A.shoe._id}/translation`).send({ name: 'حذاء رياضي أحمر', description: 'مريح' });
    expect(put.status).toBe(200);
    expect(await ProductTranslation.findOne({ workspaceId: ctx.A.wsId, refId: A.shoe._id })).toMatchObject({ name: 'حذاء رياضي أحمر', status: 'draft', kind: 'product', language: 'ar' });
    const rev = await a.post(`/catalog/product/${A.shoe._id}/translation/review`).send({ status: 'reviewed' });
    expect(rev.status).toBe(200);
    let t = await ProductTranslation.findOne({ workspaceId: ctx.A.wsId, refId: A.shoe._id }).lean();
    expect(t.status).toBe('reviewed'); expect(t.reviewedBy).toBe(ctx.A.user.name); expect(t.reviewedAt).toBeTruthy();
    await a.put(`/catalog/product/${A.shoe._id}/translation`).send({ name: 'حذاء رياضي أحمر', description: 'مريح' });
    t = await ProductTranslation.findOne({ workspaceId: ctx.A.wsId, refId: A.shoe._id }).lean();
    expect(t.status).toBe('reviewed'); // unchanged text keeps the review
    await a.put(`/catalog/product/${A.shoe._id}/translation`).send({ name: 'حذاء أحمر', description: 'مريح' });
    t = await ProductTranslation.findOne({ workspaceId: ctx.A.wsId, refId: A.shoe._id }).lean();
    expect(t).toMatchObject({ status: 'draft', name: 'حذاء أحمر' }); expect(t.reviewedBy).toBeUndefined(); expect(t.reviewedAt).toBeUndefined();
  });

  test('unique index exists: raw duplicate (workspace, kind, refId, language) is rejected', async () => {
    await expect(ProductTranslation.create({ workspaceId: ctx.A.wsId, kind: 'product', refId: A.shoe._id, language: 'ar', name: 'dup' })).rejects.toMatchObject({ code: 11000 });
  });

  test('10 concurrent first-saves of one item leave exactly one translation row (upsert race)', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => a.put(`/catalog/product/${A.hat._id}/translation`).send({ name: `قبعة زرقاء ${i}` })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await ProductTranslation.countDocuments({ workspaceId: ctx.A.wsId, kind: 'product', refId: A.hat._id })).toBe(1);
  });

  test('a service translation is separate from a product with the same id space (kind in the key)', async () => {
    const r = await a.put(`/catalog/service/${A.massage._id}/translation`).send({ name: 'تدليك' });
    expect(r.status).toBe(200);
    // wrong kind for that id is a 404, never a cross-kind write
    const wrong = await a.put(`/catalog/product/${A.massage._id}/translation`).send({ name: 'x' });
    expect(wrong.status).toBe(404); expect(wrong.body.code).toBe('ITEM_NOT_FOUND');
    expect(await ProductTranslation.countDocuments({ workspaceId: ctx.A.wsId, refId: A.massage._id })).toBe(1);
  });

  test('tenant isolation: B cannot save or review a translation for A\'s item; ids with operators are 400', async () => {
    const before = await ProductTranslation.countDocuments({ refId: A.twin1._id });
    const w = await b.put(`/catalog/product/${A.twin1._id}/translation`).send({ name: 'مخترق' });
    expect(w.status).toBe(404); expect(w.body.code).toBe('ITEM_NOT_FOUND');
    const rv = await b.post(`/catalog/product/${A.shoe._id}/translation/review`).send({ status: 'draft' });
    expect(rv.status).toBe(404);
    expect(await ProductTranslation.countDocuments({ refId: A.twin1._id })).toBe(before);
    expect((await ProductTranslation.findOne({ workspaceId: ctx.A.wsId, refId: A.shoe._id }).lean()).status).toBe('draft');
    const bad = await a.put('/catalog/product/%7B%22%24ne%22%3Anull%7D/translation').send({ name: 'x' });
    expect(bad.status).toBe(400);
    const badKind = await a.put(`/catalog/%7B%22%24ne%22%3Anull%7D/${A.shoe._id}/translation`).send({ name: 'x' });
    expect(badKind.status).toBe(400);
    const badBody = await a.put(`/catalog/product/${A.shoe._id}/translation`).send({ name: { $ne: null } });
    expect(badBody.status).toBe(400);
    const badStatus = await a.post(`/catalog/product/${A.shoe._id}/translation/review`).send({ status: { $ne: 'x' } });
    expect(badStatus.status).toBe(400);
  });

  test('review of an untranslated item is a clean 404, not a created row', async () => {
    const r = await a.post(`/catalog/product/${A.twin2._id}/translation/review`).send({ status: 'reviewed' });
    expect(r.status).toBe(404);
    expect(await ProductTranslation.countDocuments({ refId: A.twin2._id })).toBe(0);
  });

  test('resolveItemNames: string ids are cast for $in, reviewed-only by default, tenant-scoped', async () => {
    await a.post(`/catalog/product/${A.shoe._id}/translation/review`).send({ status: 'reviewed' });
    const ws = ctx.A.wsId;
    const ids = [String(A.shoe._id), String(A.hat._id), String(A.bShoe._id), 'not-an-id'];
    const reviewedOnly = await catalog.resolveItemNames({ workspaceId: ws, kind: 'product', ids, language: 'ar' });
    expect(reviewedOnly.get(String(A.shoe._id))).toBe('حذاء أحمر');
    expect(reviewedOnly.get(String(A.hat._id))).toBe('Blue Hat'); // draft Arabic => English fallback
    expect(reviewedOnly.has(String(A.bShoe._id))).toBe(false); // other tenant: absent
    const withDraft = await catalog.resolveItemNames({ workspaceId: ws, kind: 'product', ids, language: 'ar', allowDraft: true });
    expect(withDraft.get(String(A.hat._id))).toMatch(/^قبعة زرقاء/);
    const english = await catalog.resolveItemNames({ workspaceId: ws, kind: 'product', ids, language: 'en' });
    expect(english.get(String(A.shoe._id))).toBe('Red Sneaker');
    // positional spelling from the contract
    const positional = await catalog.resolveItemNames(ws, 'product', [String(A.shoe._id)], 'ar');
    expect(positional.get(String(A.shoe._id))).toBe('حذاء أحمر');
  });

  describe('CSV export / import', () => {
    test('export lists only own items, with guarded cells', async () => {
      await mkProduct(ctx.A.wsId, '=cmd|calc', { category: '@x' });
      const ex = await a.get('/catalog/export.csv');
      expect(ex.status).toBe(200); expect(ex.headers['content-type']).toMatch(/text\/csv/);
      expect(ex.text).toContain(String(A.shoe._id)); expect(ex.text).not.toContain(String(A.bShoe._id));
      expect(ex.text).toContain("'=cmd|calc"); // formula injection guard
    });

    test('dry run writes nothing; real run applies drafts by id and by exact name; ambiguous names are reported not guessed', async () => {
      const before = await ProductTranslation.countDocuments({ workspaceId: ctx.A.wsId });
      const text = [
        'kind,id,name,name_ar,description_ar',
        `product,${A.twin1._id},,توأم واحد,وصف`,
        'product,,Blue Hat,قبعة من الملف,',
        'product,,Twin Item,غامض,',
        'service,,Massage,تدليك ملكي,',
        `product,${A.bShoe._id},,حذاء الغير,`, // other tenant's id: never applied
        'product,,No Such Thing,لا شيء,',
      ].join('\n');
      const dry = await a.post('/catalog/import').field('dryRun', 'true').attach('file', csv(text), 'c.csv');
      expect(dry.status).toBe(200); expect(dry.body.dryRun).toBe(true);
      expect(await ProductTranslation.countDocuments({ workspaceId: ctx.A.wsId })).toBe(before);
      const real = await a.post('/catalog/import').field('dryRun', 'false').attach('file', csv(text), 'c.csv');
      expect(real.status).toBe(200); expect(real.body.dryRun).toBe(false);
      expect(await ProductTranslation.findOne({ workspaceId: ctx.A.wsId, refId: A.twin1._id }).lean()).toMatchObject({ name: 'توأم واحد', source: 'csv', status: 'draft' });
      expect((await ProductTranslation.findOne({ workspaceId: ctx.A.wsId, refId: A.hat._id }).lean()).name).toBe('قبعة من الملف');
      expect((await ProductTranslation.findOne({ workspaceId: ctx.A.wsId, refId: A.massage._id }).lean()).name).toBe('تدليك ملكي');
      expect(await ProductTranslation.countDocuments({ workspaceId: ctx.A.wsId, refId: A.twin2._id })).toBe(0); // ambiguous => not applied
      expect(await ProductTranslation.countDocuments({ workspaceId: ctx.B.wsId })).toBe(0);
      expect(await ProductTranslation.countDocuments({ refId: A.bShoe._id })).toBe(0);
      expect(JSON.stringify(real.body)).toMatch(/ambiguous/i);
    });

    test('import never marks reviewed and a status column cannot sneak a review in', async () => {
      await a.put(`/catalog/product/${A.shoe._id}/translation`).send({ name: 'حذاء أحمر' });
      await a.post(`/catalog/product/${A.shoe._id}/translation/review`).send({ status: 'reviewed' });
      const text = `kind,id,name_ar,status\nproduct,${A.shoe._id},حذاء مختلف,reviewed\n`;
      const real = await a.post('/catalog/import').field('dryRun', 'false').attach('file', csv(text), 'c.csv');
      expect(real.status).toBe(200);
      expect(await ProductTranslation.findOne({ workspaceId: ctx.A.wsId, refId: A.shoe._id }).lean()).toMatchObject({ name: 'حذاء مختلف', status: 'draft', source: 'csv' });
    });

    test('concurrent real imports of the same workspace: second is refused or serialised, never a duplicate row', async () => {
      const p = await mkProduct(ctx.A.wsId, `Concurrent ${h.uniq()}`);
      const text = `kind,id,name_ar\nproduct,${p._id},اسم متزامن\n`;
      const rs = await Promise.all([1, 2, 3].map(() => a.post('/catalog/import').field('dryRun', 'false').attach('file', csv(text), 'c.csv')));
      expect(rs.every((r) => r.status === 200 || r.status === 409 || r.status === 429)).toBe(true);
      expect(await ProductTranslation.countDocuments({ workspaceId: ctx.A.wsId, refId: p._id })).toBe(1);
    });
  });

  test('gate: 401 without token, 402 for the unflagged workspace', async () => {
    expect((await ctx.anon.get('/catalog/items')).status).toBe(401);
    const r = await c.get('/catalog/items');
    expect(r.status).toBe(402); expect(r.body.code).toBe('ARABIC_NOT_ENABLED');
  });
});
