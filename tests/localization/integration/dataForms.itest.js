'use strict';
// Integration (real mongod on 127.0.0.1:27099, no network): design D4 - customer data, import, phone /
// CSV safety, one-word names and the Arabic switch link on the English pay pages.
//  * B2a/B2b/B2c/O4  digits, upload decoding, header aliases, price parsing, OTP code digits
//  * B1              customer language column in the EXISTING import wizard + the profile lookup
//  * B3-forms        Arabic name / description columns for products + services, translation lookup
//  * B4              nameGuard against the real Customer model
//  * D1              switch link on /pay and /payment-result
// Every flagged scenario has an unflagged / kill-switch twin that must leave the sidecars empty.
const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();

const mockPaymentIntents = {};
jest.mock('stripe', () => () => ({
  paymentIntents: {
    retrieve: async (id) => {
      if (!mockPaymentIntents[id]) { const err = new Error('No such payment_intent'); err.code = 'resource_missing'; throw err; }
      return mockPaymentIntents[id];
    },
  },
}));

const h = require('./helpers/_harness'); // sets the JWT secret / dummy keys before the routers load
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_dummy_itest';
const express = require('express');
const { requireAuth } = require('../../../middleware/requireAuth');
const Customer = require('../../../models/Customer');
const CustomerLanguage = require('../../../models/CustomerLanguage');
const Product = require('../../../models/Product');
const Service = require('../../../models/Service');
const ProductTranslation = require('../../../models/ProductTranslation');
const LoginChallenge = require('../../../models/LoginChallenge');
const PointsLedgerEntry = require('../../../models/PointsLedgerEntry');
const Settings = require('../../../models/Settings');
const settings = require('../../../shared/localization/settings');
const { oneWordLastname } = require('../../../shared/localization/nameGuard');

const request = h.request;
const AR_DIGITS = '\u{0660}\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667}\u{0668}\u{0669}';
const arDigits = (text) => String(text).replace(/\d/g, (d) => AR_DIGITS[Number(d)]);
const utf8 = (text) => Buffer.from(text, 'utf8'); // NO byte-order mark, like many Arabic CSV exports

// windows-1256 encoder from the platform decoder (what Excel on an Arabic PC saves as "CSV")
const CP1256 = new Map();
{
  const decoder = new TextDecoder('windows-1256');
  for (let b = 0; b < 256; b += 1) { const ch = decoder.decode(Uint8Array.of(b)); if (!CP1256.has(ch)) CP1256.set(ch, b); }
}
const cp1256 = (text) => Buffer.from(Array.from(text, (ch) => CP1256.get(ch)));

let app; let ctx; let tag;
const P = (n) => `96650${tag}${String(n).padStart(2, '0')}`; // unique-per-run 12-digit phones
const local = (n) => `050${tag}${String(n).padStart(2, '0')}`;

beforeAll(async () => {
  ctx = await h.setup(); // tenants: A flagged, B flagged, C unflagged
  tag = String(Date.now()).slice(-5); // 5 digits
  app = express();
  app.use(express.json());
  app.use('/api/auth', require('../../../routes/auth'));
  app.use('/api/imports', requireAuth, require('../../../routes/imports'));
  app.use('/api/localization', requireAuth, require('../../../routes/localization'));
  app.use(require('../../../routes/localization/pages'));
  app.use(require('../../../routes/pay'));
  for (const t of [ctx.A, ctx.B, ctx.C]) await Settings.create({ workspaceId: t.wsId, merchantName: `m-${tag}`, defaultCountryCode: '966' });
});

const as = (tenant) => (req) => req.set('Authorization', `Bearer ${tenant.token}`);

async function upload(tenant, entityType, buffer, name = 'upload.csv') {
  return as(tenant)(request(app).post('/api/imports')).field('entityType', entityType).attach('file', buffer, { filename: name, contentType: 'text/csv' });
}
const mapping = (tenant, id, columnMapping) => as(tenant)(request(app).patch(`/api/imports/${id}/mapping`)).send({ columnMapping });
const run = (tenant, id) => as(tenant)(request(app).post(`/api/imports/${id}/run`)).send({});
const errorReport = (tenant, id) => as(tenant)(request(app).get(`/api/imports/${id}/error-report`));

async function wizard(tenant, entityType, buffer, columnMapping) {
  const created = await upload(tenant, entityType, buffer);
  expect(created.status).toBe(201);
  const m = await mapping(tenant, created.body.id, columnMapping || created.body.columnMapping);
  expect(m.status).toBe(200);
  const done = await run(tenant, created.body.id);
  expect(done.status).toBe(200);
  return { created: created.body, validated: m.body, done: done.body };
}

const langOf = async (tenant, phone) => {
  const customer = await Customer.findOne({ workspaceId: tenant.wsId, phone });
  const doc = customer && await CustomerLanguage.findOne({ workspaceId: tenant.wsId, customerId: customer._id });
  return { customer, doc };
};

// ───────────────────────────── customers: flagged workspace ─────────────────────────────
describe('customer import, flagged workspace (BOM-less UTF-8 Arabic file, Arabic headers, Arabic digits)', () => {
  const NAME = 'الاسم'; const PHONE = 'الجوال'; const LANG = 'اللغة'; const POINTS = 'النقاط'; const NOTES = 'ملاحظات';
  let first; let saraId;

  test('upload: the file is decoded, Arabic headers auto-map (B2b + B2c), the Language field is offered with a hint', async () => {
    const csv = [`${NAME},${PHONE},${LANG},${POINTS},${NOTES}`,
      `سارة أحمد,${arDigits(local(1))},ar,${arDigits(100)},عميل مميز`,
      `John Smith,${local(2)},English,50,`,
      `Mona,+${arDigits('966')} ${arDigits('50')} ${arDigits(tag)} ${arDigits('03')},,0,one word`,
      `Bad Lang,${local(4)},klingon,0,`,
    ].join('\n');
    const created = await upload(ctx.A, 'customer', utf8(csv));
    expect(created.status).toBe(201);
    expect(created.body.headers).toEqual([NAME, PHONE, LANG, POINTS, NOTES]);
    expect(created.body.columnMapping).toEqual({ name: NAME, phone: PHONE, startingPoints: POINTS, notes: NOTES, language: LANG });
    expect(created.body.fields.map((f) => f.key)).toEqual(['name', 'phone', 'email', 'startingPoints', 'notes', 'language']);
    expect(created.body.fields.find((f) => f.key === 'language')).toMatchObject({ label: 'Language', required: false, hint: 'ar, en, Arabic or English' });
    first = created.body;
  });

  test('validation: an invalid language is an ordinary row error, Arabic-Indic phone / points are accepted', async () => {
    const m = await mapping(ctx.A, first.id, first.columnMapping);
    expect(m.status).toBe(200);
    expect(m.body.summary).toMatchObject({ totalRows: 4, clean: 3, duplicate: 0, error: 1 });
    expect(m.body.preview.error[0].errors).toEqual([{ field: 'language', reason: 'Language must be ar, en, Arabic or English' }]);
    const sara = m.body.preview.clean.find((r) => r.mapped.name === 'سارة أحمد');
    expect(sara.mapped).toMatchObject({ phone: P(1), startingPoints: 100, _language: 'ar' });
  });

  test('run: customers + points + languages; the response carries the localisation summary', async () => {
    const done = await run(ctx.A, first.id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ importedCount: 3, skippedDuplicateCount: 0, failedCount: 1, totalRows: 4 });
    expect(done.body.localization).toEqual({
      languagesSet: 2, languagesProtected: 0, languagesUnchanged: 0, languagesSkipped: 0, languagesFailed: 0,
      translationsSaved: 0, translationsUnchanged: 0, translationsFailed: 0,
    });
    const sara = await langOf(ctx.A, P(1));
    saraId = String(sara.customer._id);
    expect(sara.customer).toMatchObject({ firstname: 'سارة', lastname: 'أحمد', loyaltyPoints: 100, notes: 'عميل مميز' });
    expect(sara.doc).toMatchObject({ language: 'ar', languageSource: 'csv_import' });
    expect((await langOf(ctx.A, P(2))).doc).toMatchObject({ language: 'en', languageSource: 'csv_import' });
    const mona = await langOf(ctx.A, P(3));
    expect(mona.customer.firstname).toBe('Mona'); // the "+٩٦٦ ٥٠ ..." number was understood
    expect(mona.doc).toBeNull(); // blank language cell: nothing stored
    expect(await Customer.countDocuments({ workspaceId: ctx.A.wsId, phone: P(4) })).toBe(0); // the error row was not imported
    expect(await PointsLedgerEntry.countDocuments({ workspaceId: ctx.A.wsId, customerId: sara.customer._id, type: 'imported_balance' })).toBe(1);
  });

  test('the error report CSV lists the language reason', async () => {
    const r = await errorReport(ctx.A, first.id);
    expect(r.status).toBe(200);
    expect(r.text).toContain('klingon');
    expect(r.text).toContain('Language must be ar, en, Arabic or English');
  });

  test('profile lookup: GET /customers/:id/language reflects the import (flagged tenant), 404 for another tenant\'s customer, 402 unflagged', async () => {
    const row = await as(ctx.A)(request(app).get(`/api/localization/customers/${saraId}/language`));
    expect(row.status).toBe(200);
    expect(row.body).toMatchObject({ id: saraId, language: 'ar', languageSource: 'csv_import', effectiveLanguage: 'ar', name: 'سارة أحمد' });
    const cross = await as(ctx.B)(request(app).get(`/api/localization/customers/${saraId}/language`));
    expect(cross.status).toBe(404);
    expect(cross.body.code).toBe('CUSTOMER_NOT_FOUND');
    const unflagged = await as(ctx.C)(request(app).get(`/api/localization/customers/${saraId}/language`));
    expect(unflagged.status).toBe(402);
    expect(unflagged.body.code).toBe('ARABIC_NOT_ENABLED');
    expect((await request(app).get(`/api/localization/customers/${saraId}/language`)).status).toBe(401);
  });

  test('re-import (Windows-1256, semicolons): duplicates get their language updated, customer_chose is protected, blank never clears', async () => {
    const john = (await langOf(ctx.A, P(2))).customer;
    await CustomerLanguage.updateOne({ workspaceId: ctx.A.wsId, customerId: john._id }, { $set: { language: 'en', languageSource: 'customer_chose' } });
    const csv = [`${NAME};${PHONE};${LANG}`,
      `سارة أحمد;${local(1)};en`, // merchant data: update ar -> en
      `John Smith;${local(2)};ar`, // customer chose en: protected
      `Mona;${local(3)};عربي`, // new language for an existing customer, Arabic word for "Arabic"
      `Mona;${local(3)};en`, // second row for the same customer: the first row wins
    ].join('\n');
    const out = await wizard(ctx.A, 'customer', cp1256(csv));
    expect(out.created.headers).toEqual([NAME, PHONE, LANG]);
    expect(out.created.columnMapping).toEqual({ name: NAME, phone: PHONE, language: LANG });
    expect(out.done).toMatchObject({ importedCount: 0, skippedDuplicateCount: 4, failedCount: 0 });
    expect(out.done.localization).toMatchObject({ languagesSet: 2, languagesProtected: 1, languagesUnchanged: 0, languagesFailed: 0 });
    expect((await langOf(ctx.A, P(1))).doc).toMatchObject({ language: 'en', languageSource: 'csv_import' });
    expect((await langOf(ctx.A, P(2))).doc).toMatchObject({ language: 'en', languageSource: 'customer_chose' });
    expect((await langOf(ctx.A, P(3))).doc).toMatchObject({ language: 'ar', languageSource: 'csv_import' });
    // blank / unknown language cells never clear what is stored
    const blank = await wizard(ctx.A, 'customer', utf8(`name,phone,language\nSara,${local(1)},\nMona,${local(3)},unknown\n`));
    expect(blank.done.localization).toMatchObject({ languagesSet: 0, languagesProtected: 0, languagesFailed: 0 });
    expect((await langOf(ctx.A, P(1))).doc.language).toBe('en');
    expect((await langOf(ctx.A, P(3))).doc.language).toBe('ar');
  });

  test('an Arabic-digit phone that matches an existing customer is a duplicate of it, never a second record', async () => {
    const before = await Customer.countDocuments({ workspaceId: ctx.A.wsId });
    const out = await wizard(ctx.A, 'customer', utf8(`name,phone\nسارة,${arDigits(local(1))}\n`));
    expect(out.done).toMatchObject({ importedCount: 0, skippedDuplicateCount: 1 });
    expect(await Customer.countDocuments({ workspaceId: ctx.A.wsId })).toBe(before);
  });

  test('English-header file with an English language column maps the language automatically', async () => {
    const created = await upload(ctx.A, 'customer', utf8(`Name,Phone,Language\nLayla Noor,${local(7)},Arabic\n`));
    expect(created.body.columnMapping).toEqual({ name: 'Name', phone: 'Phone', language: 'Language' });
  });
});

// ───────────────────────────── customers: unflagged twin ─────────────────────────────
describe('customer import, UNFLAGGED workspace: sidecars untouched, wizard unchanged', () => {
  test('same file: no language field offered or mapped, no localization key, sidecar empty; B2 still accepts Arabic digits', async () => {
    const csv = ['name,phone,language,points',
      `Sara Ahmed,${arDigits(local(11))},ar,${arDigits(100)}`,
      `John Smith,${local(12)},en,50`].join('\n');
    const created = await upload(ctx.C, 'customer', utf8(csv));
    expect(created.status).toBe(201);
    expect(created.body.fields.map((f) => f.key)).toEqual(['name', 'phone', 'email', 'startingPoints', 'notes']);
    expect(created.body.fields.every((f) => f.hint === undefined)).toBe(true);
    expect(created.body.columnMapping).toEqual({ name: 'name', phone: 'phone', startingPoints: 'points' });
    const m = await mapping(ctx.C, created.body.id, created.body.columnMapping);
    expect(m.body.summary).toMatchObject({ clean: 2, error: 0 });
    expect(m.body.preview.clean[0].mapped._language).toBeUndefined();
    const done = await run(ctx.C, created.body.id);
    expect(Object.keys(done.body).sort()).toEqual(['failedCount', 'id', 'importedCount', 'skippedDuplicateCount', 'status', 'totalRows']);
    expect(done.body.importedCount).toBe(2);
    expect(await CustomerLanguage.countDocuments({ workspaceId: ctx.C.wsId })).toBe(0);
    expect((await Customer.findOne({ workspaceId: ctx.C.wsId, phone: P(11) })).loyaltyPoints).toBe(100);
  });

  test('a language column the merchant maps by hand is ignored (the mapping key is unknown to the engine)', async () => {
    const created = await upload(ctx.C, 'customer', utf8(`name,phone,language\nOmar,${local(13)},klingon\n`));
    const m = await mapping(ctx.C, created.body.id, { ...created.body.columnMapping, language: 'language' });
    expect(m.body.summary).toMatchObject({ clean: 1, error: 0 }); // not validated, not an error
    await run(ctx.C, created.body.id);
    expect(await CustomerLanguage.countDocuments({ workspaceId: ctx.C.wsId })).toBe(0);
  });

  test('kill switch: a flagged workspace behaves exactly like an unflagged one', async () => {
    process.env.LOCALIZATION_DISABLED = '1';
    try {
      const created = await upload(ctx.A, 'customer', utf8(`name,phone,language\nKilled Switch,${local(14)},ar\n`));
      expect(created.body.fields.map((f) => f.key)).toEqual(['name', 'phone', 'email', 'startingPoints', 'notes']);
      expect(created.body.columnMapping).toEqual({ name: 'name', phone: 'phone' });
      const done = await run(ctx.A, created.body.id); // validation step skipped on purpose: run reads the stored mapping
      expect(done.body.localization).toBeUndefined();
      expect(await CustomerLanguage.countDocuments({ workspaceId: ctx.A.wsId, customerId: (await Customer.findOne({ workspaceId: ctx.A.wsId, phone: P(14) }))._id })).toBe(0);
    } finally {
      delete process.env.LOCALIZATION_DISABLED;
    }
  });
});

// ───────────────────────────── products / services ─────────────────────────────
describe('product + service import: Arabic name / description drafts and B2c price parsing', () => {
  const header = 'name,price,category,name_ar,description_ar';
  let coffeeName; let teaName;

  test('flagged: Arabic columns are offered, mapped, saved as csv DRAFTS; prices in Arabic digits / SAR text parse', async () => {
    coffeeName = `Arabic Coffee ${tag}`; teaName = `Mint Tea ${tag}`;
    const csv = [header, `${coffeeName},٤٥ ر.س,Drinks,قهوة عربية,قهوة بالهيل`, `${teaName},"1,200.50",Drinks,شاي بالنعناع,`].join('\n');
    const created = await upload(ctx.A, 'product', utf8(csv));
    expect(created.body.fields.map((f) => f.key).slice(-2)).toEqual(['nameAr', 'descriptionAr']);
    expect(created.body.columnMapping).toMatchObject({ name: 'name', basePrice: 'price', nameAr: 'name_ar', descriptionAr: 'description_ar' });
    const m = await mapping(ctx.A, created.body.id, created.body.columnMapping);
    expect(m.body.summary).toMatchObject({ clean: 2, error: 0 });
    const done = await run(ctx.A, created.body.id);
    expect(done.body).toMatchObject({ importedCount: 2, failedCount: 0 });
    expect(done.body.localization).toMatchObject({ translationsSaved: 2, translationsUnchanged: 0, translationsFailed: 0, languagesSet: 0 });
    const coffee = await Product.findOne({ workspaceId: ctx.A.wsId, name: coffeeName });
    const tea = await Product.findOne({ workspaceId: ctx.A.wsId, name: teaName });
    expect(coffee.basePrice).toBe(45);
    expect(tea.basePrice).toBe(1200.5);
    const tr = await ProductTranslation.findOne({ workspaceId: ctx.A.wsId, kind: 'product', refId: coffee._id, language: 'ar' });
    expect(tr).toMatchObject({ name: 'قهوة عربية', description: 'قهوة بالهيل', status: 'draft', source: 'csv' });
    expect((await ProductTranslation.findOne({ workspaceId: ctx.A.wsId, kind: 'product', refId: tea._id })).description || '').toBe('');
  });

  test('translation lookup: draft visible to its workspace, 404 across tenants, null when none, 402 unflagged', async () => {
    const coffee = await Product.findOne({ workspaceId: ctx.A.wsId, name: coffeeName });
    const ok = await as(ctx.A)(request(app).get(`/api/localization/catalog/product/${coffee._id}/translation`));
    expect(ok.status).toBe(200);
    expect(ok.body.translation).toMatchObject({ name: 'قهوة عربية', status: 'draft', source: 'csv' });
    expect((await as(ctx.B)(request(app).get(`/api/localization/catalog/product/${coffee._id}/translation`))).status).toBe(404);
    expect((await as(ctx.A)(request(app).get(`/api/localization/catalog/service/${coffee._id}/translation`))).status).toBe(404); // wrong kind
    const plain = await Product.create({ workspaceId: ctx.A.wsId, name: `Plain ${tag}`, basePrice: 1, category: 'x' });
    const none = await as(ctx.A)(request(app).get(`/api/localization/catalog/product/${plain._id}/translation`));
    expect(none.body).toEqual({ translation: null });
    expect((await as(ctx.C)(request(app).get(`/api/localization/catalog/product/${plain._id}/translation`))).status).toBe(402);
  });

  test('re-import: identical text is unchanged (a reviewed row stays reviewed), changed text becomes a draft again, others are untouched', async () => {
    const coffee = await Product.findOne({ workspaceId: ctx.A.wsId, name: coffeeName });
    await ProductTranslation.updateOne({ workspaceId: ctx.A.wsId, kind: 'product', refId: coffee._id, language: 'ar' }, { $set: { status: 'reviewed', reviewedBy: 'Noura' } });
    const same = [header, `${coffeeName},45,Drinks,قهوة عربية,قهوة بالهيل`].join('\n');
    const r1 = await wizard(ctx.A, 'product', utf8(same));
    expect(r1.done).toMatchObject({ importedCount: 0, skippedDuplicateCount: 1 });
    expect(r1.done.localization).toMatchObject({ translationsSaved: 0, translationsUnchanged: 1 });
    expect((await ProductTranslation.findOne({ workspaceId: ctx.A.wsId, kind: 'product', refId: coffee._id })).status).toBe('reviewed');
    const changed = [header, `${coffeeName},45,Drinks,قهوة سعودية,`].join('\n');
    const r2 = await wizard(ctx.A, 'product', utf8(changed));
    expect(r2.done.localization).toMatchObject({ translationsSaved: 1, translationsUnchanged: 0 });
    const tr = await ProductTranslation.findOne({ workspaceId: ctx.A.wsId, kind: 'product', refId: coffee._id });
    expect(tr).toMatchObject({ name: 'قهوة سعودية', description: 'قهوة بالهيل', status: 'draft', source: 'csv' }); // blank description keeps the old one
    expect(tr.reviewedBy).toBeUndefined();
  });

  test('a description without a name, an over-long name and non-product columns are row errors, not silent drops', async () => {
    const csv = [header, `Bad One ${tag},5,x,,وصف بدون اسم`, `Bad Two ${tag},5,x,${'ع'.repeat(201)},`].join('\n');
    const created = await upload(ctx.A, 'product', utf8(csv));
    const m = await mapping(ctx.A, created.body.id, created.body.columnMapping);
    expect(m.body.summary).toMatchObject({ clean: 0, error: 2 });
    const reasons = m.body.preview.error.flatMap((r) => r.errors.map((e) => e.reason));
    expect(reasons).toEqual(expect.arrayContaining(['Arabic description needs an Arabic name', 'Arabic name is too long (max 200 characters)']));
  });

  test('service import: Arabic name + description drafts for services', async () => {
    const name = `Haircut ${tag}`;
    const csv = ['name,price,duration,name_ar', `${name},"SAR 60.00",45,قص شعر`].join('\n');
    const out = await wizard(ctx.A, 'service', utf8(csv));
    expect(out.done.localization).toMatchObject({ translationsSaved: 1 });
    const service = await Service.findOne({ workspaceId: ctx.A.wsId, name });
    expect(service).toMatchObject({ basePrice: 60, duration: 45 });
    expect(await ProductTranslation.findOne({ workspaceId: ctx.A.wsId, kind: 'service', refId: service._id })).toMatchObject({ name: 'قص شعر', status: 'draft' });
  });

  test('UNFLAGGED twin: same product file -> no Arabic fields, no localization key, no ProductTranslation; B2 price still parses', async () => {
    const csv = [header, `Twin Coffee ${tag},٤٥ ر.س,Drinks,قهوة عربية,قهوة بالهيل`].join('\n');
    const created = await upload(ctx.C, 'product', utf8(csv));
    expect(created.body.fields.map((f) => f.key)).not.toContain('nameAr');
    expect(created.body.columnMapping).toEqual({ name: 'name', basePrice: 'price', category: 'category' }); // description_ar is not a base alias
    const m = await mapping(ctx.C, created.body.id, created.body.columnMapping);
    expect(m.body.summary).toMatchObject({ clean: 1, error: 0 });
    const done = await run(ctx.C, created.body.id);
    expect(done.body.localization).toBeUndefined();
    expect(await ProductTranslation.countDocuments({ workspaceId: ctx.C.wsId })).toBe(0);
    expect((await Product.findOne({ workspaceId: ctx.C.wsId, name: `Twin Coffee ${tag}` })).basePrice).toBe(45);
  });

  test('wizard with Arabic headers for a product file maps the base fields (B2c) in any workspace, flagged or not', async () => {
    const csv = ['اسم المنتج,السعر,الفئة,الوصف', `Arabic Header Item ${tag},٩٩,Misc,desc`].join('\n');
    for (const tenant of [ctx.A, ctx.C]) {
      const created = await upload(tenant, 'product', utf8(csv));
      expect(created.body.columnMapping).toMatchObject({ name: 'اسم المنتج', basePrice: 'السعر', category: 'الفئة', description: 'الوصف' });
    }
  });
});

describe('English-header files are untouched by the decoder', () => {
  test('Latin-1 and UTF-8-with-BOM files import exactly as before', async () => {
    const latin = await wizard(ctx.C, 'customer', Buffer.from(`name,phone\nÉric Dupont,${local(21)}\n`, 'latin1'));
    expect(latin.done.importedCount).toBe(1);
    expect((await Customer.findOne({ workspaceId: ctx.C.wsId, phone: P(21) })).firstname).toBe('Éric');
    const bom = await wizard(ctx.C, 'customer', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(`name,phone\nJosé García,${local(22)}\n`)]));
    expect(bom.done.importedCount).toBe(1);
    expect((await Customer.findOne({ workspaceId: ctx.C.wsId, phone: P(22) })).firstname).toBe('José');
  });
});

// ───────────────────────────── OTP login with Arabic digits ─────────────────────────────
describe('WhatsApp OTP login (AUTH_TEST_MODE) accepts Arabic-Indic digits in the phone and the code', () => {
  test('request with an Arabic-digit phone stores the Western number; verify with Arabic phone + code issues a session', async () => {
    const western = `9665${String(Date.now()).slice(-8)}`;
    const reqRes = await request(app).post('/api/auth/otp/request').send({ phone: `+${arDigits(western)}` });
    expect(reqRes.status).toBe(200);
    expect(await LoginChallenge.countDocuments({ contact: western, method: 'whatsapp_otp' })).toBe(1);
    const verify = await request(app).post('/api/auth/otp/verify').send({ phone: arDigits(western), code: arDigits(reqRes.body.testCode) });
    expect(verify.status).toBe(200);
    expect(verify.body.token).toBeTruthy();
  });

  test('Western digits still work, a wrong code is still rejected, an empty phone is still a 400', async () => {
    const western = `9665${String(Date.now() + 1).slice(-8)}`;
    const reqRes = await request(app).post('/api/auth/otp/request').send({ phone: `+${western}` });
    expect((await request(app).post('/api/auth/otp/verify').send({ phone: western, code: arDigits('000000') })).status).toBe(400);
    expect((await request(app).post('/api/auth/otp/verify').send({ phone: western, code: reqRes.body.testCode })).status).toBe(200);
    expect((await request(app).post('/api/auth/otp/request').send({ phone: 'abc' })).status).toBe(400);
  });
});

// ───────────────────────────── B4: one-word names ─────────────────────────────
describe('nameGuard against the real Customer model', () => {
  test('flagged workspace: a one-word customer can be created (single space last name); unflagged: still refused as today', async () => {
    const lastname = await oneWordLastname(ctx.A.wsId);
    expect(lastname).toBe(' ');
    const created = await Customer.create({ workspaceId: ctx.A.wsId, firstname: 'سارة', lastname, phone: P(31) });
    expect(`${created.firstname} ${created.lastname}`.trim()).toBe('سارة');
    expect(await oneWordLastname(ctx.C.wsId)).toBe('');
    await expect(Customer.create({ workspaceId: ctx.C.wsId, firstname: 'Sara', lastname: '', phone: P(32) })).rejects.toThrow(/lastname/);
    process.env.LOCALIZATION_DISABLED = '1';
    try { expect(await oneWordLastname(ctx.A.wsId)).toBe(''); } finally { delete process.env.LOCALIZATION_DISABLED; }
  });
});

// ───────────────────────────── D1: Arabic switch link on the English pay pages ─────────────────────────────
describe('Arabic switch link on the English pay pages', () => {
  let flaggedService; let plainService;
  const pi = (id, status, serviceId) => {
    mockPaymentIntents[id] = {
      id, status, amount: 15000, currency: 'sar', client_secret: `${id}_secret_x`,
      metadata: { buyerPhone: '966500000001', subtotal: '145', shippingCost: '5', ...(serviceId ? { serviceId: String(serviceId) } : {}) },
    };
    return id;
  };
  const LINK = /<a class="exit" href="[^"]*lang=ar" hreflang="ar" lang="ar" dir="rtl" rel="nofollow">العربية<\/a>/;

  beforeAll(async () => {
    flaggedService = await Service.create({ workspaceId: ctx.A.wsId, name: `Pay svc A ${tag}`, basePrice: 10 });
    plainService = await Service.create({ workspaceId: ctx.C.wsId, name: `Pay svc C ${tag}`, basePrice: 10 });
    settings.clearCache();
  });

  test('flagged merchant, no language signal / English browser / ?lang=en: the English page gets the link; ?lang=ar is the Arabic page', async () => {
    const id = pi(`pi_flagged_${tag}`, 'requires_payment_method', flaggedService._id);
    const plain = await request(app).get(`/pay/${id}`);
    expect(plain.status).toBe(200);
    expect(plain.text).toContain('<html lang="en">');
    expect(plain.text).toMatch(LINK);
    expect(plain.text).toContain(`href="/pay/${id}?lang=ar"`);
    expect((await request(app).get(`/pay/${id}`).set('Accept-Language', 'en-US,en;q=0.9')).text).toMatch(LINK);
    const explicit = await request(app).get(`/pay/${id}?lang=en`);
    expect(explicit.text).toContain('<html lang="en">');
    expect(explicit.text).toMatch(LINK); // the visitor came from the Arabic page's own English link
    const arabic = await request(app).get(`/pay/${id}?lang=ar`);
    expect(arabic.text).toContain('dir="rtl"');
  });

  test('UNFLAGGED merchant: no link anywhere on the English page, with or without ?lang', async () => {
    const id = pi(`pi_plain_${tag}`, 'requires_payment_method', plainService._id);
    for (const url of [`/pay/${id}`, `/pay/${id}?lang=en`, `/pay/${id}?lang=ar`]) {
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/hreflang="ar"/);
      expect(res.text).toContain('<html lang="en">'); // ?lang=ar for an unflagged merchant stays English (flag off)
    }
  });

  test('kill switch: no link even for a flagged merchant', async () => {
    process.env.LOCALIZATION_DISABLED = '1';
    try {
      const id = `pi_flagged_${tag}`;
      for (const url of [`/pay/${id}`, `/pay/${id}?lang=en`]) expect((await request(app).get(url)).text).not.toMatch(/hreflang="ar"/);
    } finally {
      delete process.env.LOCALIZATION_DISABLED;
    }
  });

  test('already paid, payment-result success and failed pages carry the link for a flagged merchant only', async () => {
    const paid = pi(`pi_paid_${tag}`, 'succeeded', flaggedService._id);
    const failed = pi(`pi_failed_${tag}`, 'requires_payment_method', flaggedService._id);
    const paidPlain = pi(`pi_paid_plain_${tag}`, 'succeeded', plainService._id);
    expect((await request(app).get(`/pay/${paid}`)).text).toMatch(LINK);
    const ok = await request(app).get(`/payment-result?payment_intent=${paid}`);
    expect(ok.text).toMatch(LINK);
    expect(ok.text).toContain(`href="/payment-result?payment_intent=${paid}&amp;lang=ar"`);
    expect((await request(app).get(`/payment-result?payment_intent=${failed}`)).text).toMatch(LINK);
    expect((await request(app).get(`/pay/${paidPlain}`)).text).not.toMatch(/hreflang="ar"/);
    expect((await request(app).get(`/payment-result?payment_intent=${paidPlain}`)).text).not.toMatch(/hreflang="ar"/);
  });

  test('unknown payment id / missing id pages are unchanged (no link, no crash)', async () => {
    const nf = await request(app).get('/pay/pi_does_not_exist');
    expect(nf.status).toBe(404);
    expect(nf.text).not.toMatch(/hreflang="ar"/);
    expect((await request(app).get('/payment-result')).text).not.toMatch(/hreflang="ar"/);
  });
});
