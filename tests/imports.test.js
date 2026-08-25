require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const { authedAgent, getTestWorkspaceId } = require('./testAuth');
const app = require('../server');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const PointsLedgerEntry = require('../models/PointsLedgerEntry');
const ImportJob = require('../models/ImportJob');
const ConsentEvent = require('../models/ConsentEvent');
const { normalizePhoneForDedup } = require('../utils/phoneNormalize');

function csvBuffer(rows) {
  return Buffer.from(rows.map(r => r.join(',')).join('\n'));
}

describe('Bulk CSV/XLSX import', () => {
  let request, workspaceId, countryCode;
  // Local (leading-0) format, as a merchant's CSV would actually contain —
  // the test derives the expected NORMALIZED value from the real function
  // under test + the workspace's actual configured country code, rather
  // than hardcoding an assumed result.
  const localPhones = ['0555999701', '0555999702', '0555999703', '0555999704'];
  const testProductNames = ['__test_import_widget_a__', '__test_import_widget_b__'];

  beforeAll(async () => {
    await connectOnce();
    request = await authedAgent(app);
    workspaceId = await getTestWorkspaceId(app);
    const settings = await request.get('/api/settings/loyalty');
    countryCode = settings.body.defaultCountryCode;
  }, 30000);

  afterEach(async () => {
    const normalizedPhones = localPhones.map(p => normalizePhoneForDedup(p, countryCode));
    const customers = await Customer.find({ workspaceId, phone: { $in: normalizedPhones } }).select('_id').lean();
    const ids = customers.map(c => c._id);
    await PointsLedgerEntry.deleteMany({ customerId: { $in: ids } });
    await ConsentEvent.deleteMany({ customerId: { $in: ids } });
    await Customer.deleteMany({ _id: { $in: ids } });
    await Customer.deleteMany({ workspaceId, firstname: 'Import', lastname: 'Test Two' });
    await Product.deleteMany({ name: { $in: testProductNames } });
    await ImportJob.deleteMany({ workspaceId, originalFilename: /^__test_import/ });
  });

  test('sample template download works without a job', async () => {
    const res = await request.get('/api/imports/sample-template?entityType=customer');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Name,Phone/);
  });

  test('rejects an unknown entityType at upload', async () => {
    const res = await request.post('/api/imports')
      .field('entityType', 'not_a_real_type')
      .attach('file', csvBuffer([['Name', 'Phone'], ['A', localPhones[0]]]), '__test_import_bad.csv');
    expect(res.status).toBe(400);
  });

  test('customer import: auto-detects mapping, creates new, and flags a same-file duplicate', async () => {
    const csv = csvBuffer([
      ['Name', 'Phone', 'Email', 'Starting Loyalty Points Balance'],
      ['Import Test One', localPhones[0], 'one@example.com', '250'],
      ['Import Test One', localPhones[0], 'one@example.com', '250'], // same-file duplicate
    ]);
    const upload = await request.post('/api/imports')
      .field('entityType', 'customer')
      .attach('file', csv, '__test_import_customers.csv');
    expect(upload.status).toBe(201);
    expect(upload.body.columnMapping.phone).toBe('Phone');
    expect(upload.body.columnMapping.name).toBe('Name');

    const validate = await request.patch(`/api/imports/${upload.body.id}/mapping`).send({ columnMapping: upload.body.columnMapping });
    expect(validate.status).toBe(200);
    expect(validate.body.summary).toEqual({ totalRows: 2, clean: 1, duplicate: 1, error: 0, discrepancy: 0 });

    const run = await request.post(`/api/imports/${upload.body.id}/run`).send({});
    expect(run.status).toBe(200);
    expect(run.body.importedCount).toBe(1);
    expect(run.body.skippedDuplicateCount).toBe(1);

    const normalizedPhone = normalizePhoneForDedup(localPhones[0], countryCode);
    const created = await Customer.find({ workspaceId, phone: normalizedPhone }).lean();
    expect(created.length).toBe(1); // the same-file duplicate must not create a second record
    expect(created[0].loyaltyPoints).toBe(250);

    const ledgerEntries = await PointsLedgerEntry.find({ customerId: created[0]._id, type: 'imported_balance' }).lean();
    expect(ledgerEntries.length).toBe(1);
    expect(ledgerEntries[0].amount).toBe(250);
  }, 30000);

  test('customer re-import: flags a points discrepancy and applies only the delta when resolved', async () => {
    const normalizedPhone = normalizePhoneForDedup(localPhones[1], countryCode);
    const existing = await Customer.create({ workspaceId, firstname: 'Import', lastname: 'Test Two', phone: normalizedPhone, loyaltyPoints: 100 });
    await PointsLedgerEntry.create({ workspaceId, customerId: existing._id, type: 'imported_balance', amount: 100, importJobId: existing._id });

    const csv = csvBuffer([
      ['Name', 'Phone', 'Starting Loyalty Points Balance'],
      ['Import Test Two', localPhones[1], '180'],
    ]);
    const upload = await request.post('/api/imports')
      .field('entityType', 'customer')
      .attach('file', csv, '__test_import_reimport.csv');

    const validate = await request.patch(`/api/imports/${upload.body.id}/mapping`).send({ columnMapping: upload.body.columnMapping });
    expect(validate.body.summary.discrepancy).toBe(1);
    expect(validate.body.discrepancies[0]).toMatchObject({ previousImportedBalance: 100, newFileValue: 180 });

    // Default (no resolution passed) must skip — never silently overwrite.
    const runSkip = await request.post(`/api/imports/${upload.body.id}/run`).send({ discrepancyResolutions: [] });
    expect(runSkip.status).toBe(200);
    let after = await Customer.findById(existing._id).lean();
    expect(after.loyaltyPoints).toBe(100);

    // Re-run with an explicit 'apply' resolution — must apply the DELTA (80), not overwrite to 180.
    const upload2 = await request.post('/api/imports')
      .field('entityType', 'customer')
      .attach('file', csv, '__test_import_reimport2.csv');
    await request.patch(`/api/imports/${upload2.body.id}/mapping`).send({ columnMapping: upload2.body.columnMapping });
    const runApply = await request.post(`/api/imports/${upload2.body.id}/run`).send({ discrepancyResolutions: [{ rowIndex: 0, action: 'apply' }] });
    expect(runApply.status).toBe(200);
    after = await Customer.findById(existing._id).lean();
    expect(after.loyaltyPoints).toBe(180); // 100 + delta(80), not a raw overwrite artifact
  }, 30000);

  test('customer import: a row missing the required Name field is reported as an error, not silently dropped', async () => {
    const csv = csvBuffer([
      ['Name', 'Phone'],
      ['', localPhones[2]],
    ]);
    const upload = await request.post('/api/imports')
      .field('entityType', 'customer')
      .attach('file', csv, '__test_import_error.csv');
    const validate = await request.patch(`/api/imports/${upload.body.id}/mapping`).send({ columnMapping: upload.body.columnMapping });
    expect(validate.body.summary.error).toBe(1);

    const run = await request.post(`/api/imports/${upload.body.id}/run`).send({});
    expect(run.body.failedCount).toBe(1);
    expect(run.body.importedCount).toBe(0);

    const report = await request.get(`/api/imports/${upload.body.id}/error-report`);
    expect(report.status).toBe(200);
    expect(report.text).toMatch(/Name is required/);
  }, 30000);

  test('product import: matches by exact name (case-insensitive) and updates price instead of duplicating', async () => {
    const first = csvBuffer([
      ['Product Name', 'Price', 'Category'],
      [testProductNames[0], 'SAR 45.00', 'Gadgets'],
    ]);
    const upload1 = await request.post('/api/imports')
      .field('entityType', 'product')
      .attach('file', first, '__test_import_products1.csv');
    await request.patch(`/api/imports/${upload1.body.id}/mapping`).send({ columnMapping: upload1.body.columnMapping });
    const run1 = await request.post(`/api/imports/${upload1.body.id}/run`).send({});
    expect(run1.body.importedCount).toBe(1);

    // Re-import the same product name (different case) with a new price.
    const second = csvBuffer([
      ['Product Name', 'Price', 'Category'],
      [testProductNames[0].toUpperCase(), 'SAR 60.00', 'Gadgets'],
    ]);
    const upload2 = await request.post('/api/imports')
      .field('entityType', 'product')
      .attach('file', second, '__test_import_products2.csv');
    await request.patch(`/api/imports/${upload2.body.id}/mapping`).send({ columnMapping: upload2.body.columnMapping });
    const run2 = await request.post(`/api/imports/${upload2.body.id}/run`).send({});
    expect(run2.body.importedCount).toBe(0);
    expect(run2.body.skippedDuplicateCount).toBe(1);

    const products = await Product.find({ workspaceId, name: testProductNames[0] }).lean();
    expect(products.length).toBe(1); // never duplicated
    expect(products[0].basePrice).toBe(60); // price updated in place
  }, 30000);

  test('product import: Size/Color/Stock/Image columns populate variants and images', async () => {
    const csv = csvBuffer([
      ['Product Name', 'Price', 'Category', 'Size', 'Color', 'Stock Quantity', 'SKU', 'Image URL'],
      [testProductNames[0], 'SAR 45.00', 'Gadgets', 'S', 'Red', '12', 'W-S-RED', 'https://example.com/img.jpg'],
    ]);
    const upload = await request.post('/api/imports')
      .field('entityType', 'product')
      .attach('file', csv, '__test_import_products_variant1.csv');
    expect(upload.body.columnMapping.size).toBe('Size');
    expect(upload.body.columnMapping.color).toBe('Color');
    expect(upload.body.columnMapping.stock).toBe('Stock Quantity');
    expect(upload.body.columnMapping.imageUrl).toBe('Image URL');
    await request.patch(`/api/imports/${upload.body.id}/mapping`).send({ columnMapping: upload.body.columnMapping });
    const run = await request.post(`/api/imports/${upload.body.id}/run`).send({});
    expect(run.body.importedCount).toBe(1);

    const product = await Product.findOne({ workspaceId, name: testProductNames[0] }).lean();
    expect(product.variants).toEqual([{ size: 'S', color: 'Red', stock: 12, sku: 'W-S-RED' }]);
    expect(product.images).toEqual(['https://example.com/img.jpg']);
  }, 30000);

  test('product import: a second row with the same name adds another variant instead of overwriting the product', async () => {
    const first = csvBuffer([
      ['Product Name', 'Price', 'Category', 'Size', 'Color', 'Stock Quantity'],
      [testProductNames[0], 'SAR 45.00', 'Gadgets', 'S', 'Red', '10'],
      [testProductNames[0], 'SAR 45.00', 'Gadgets', 'M', 'Red', '5'],
    ]);
    const upload = await request.post('/api/imports')
      .field('entityType', 'product')
      .attach('file', first, '__test_import_products_variant2.csv');
    await request.patch(`/api/imports/${upload.body.id}/mapping`).send({ columnMapping: upload.body.columnMapping });
    const run = await request.post(`/api/imports/${upload.body.id}/run`).send({});
    expect(run.body.importedCount).toBe(1); // one product...
    expect(run.body.skippedDuplicateCount).toBe(1); // ...the second row merged as a variant, not a new product

    let product = await Product.findOne({ workspaceId, name: testProductNames[0] }).lean();
    expect(product.variants.length).toBe(2);
    expect(product.variants.map(v => `${v.size}/${v.color}/${v.stock}`).sort()).toEqual(['M/Red/5', 'S/Red/10']);

    // Re-importing the same size+color again updates stock in place, not a third variant.
    const second = csvBuffer([
      ['Product Name', 'Price', 'Category', 'Size', 'Color', 'Stock Quantity'],
      [testProductNames[0], 'SAR 45.00', 'Gadgets', 'S', 'Red', '99'],
    ]);
    const upload2 = await request.post('/api/imports')
      .field('entityType', 'product')
      .attach('file', second, '__test_import_products_variant3.csv');
    await request.patch(`/api/imports/${upload2.body.id}/mapping`).send({ columnMapping: upload2.body.columnMapping });
    await request.post(`/api/imports/${upload2.body.id}/run`).send({});

    product = await Product.findOne({ workspaceId, name: testProductNames[0] }).lean();
    expect(product.variants.length).toBe(2); // still 2, not 3
    expect(product.variants.find(v => v.size === 'S' && v.color === 'Red').stock).toBe(99);
  }, 30000);

  test('a row missing the required Price field is a plain-language error, not a raw parser exception', async () => {
    const csv = csvBuffer([
      ['Product Name', 'Price'],
      [testProductNames[1], ''],
    ]);
    const upload = await request.post('/api/imports')
      .field('entityType', 'product')
      .attach('file', csv, '__test_import_products3.csv');
    const validate = await request.patch(`/api/imports/${upload.body.id}/mapping`).send({ columnMapping: upload.body.columnMapping });
    expect(validate.body.preview.error[0].errors[0].reason).toBe('Price is required');
  }, 30000);

  test('marketing consent attestation checkbox: checked grants consent, unchecked leaves customers unconsented', async () => {
    // Unattested — the default, safe behaviour.
    const csvA = csvBuffer([
      ['Name', 'Phone'],
      ['Import Test One', localPhones[0]],
    ]);
    const uploadA = await request.post('/api/imports')
      .field('entityType', 'customer')
      .attach('file', csvA, '__test_import_noconsent.csv');
    await request.patch(`/api/imports/${uploadA.body.id}/mapping`).send({ columnMapping: uploadA.body.columnMapping });
    await request.post(`/api/imports/${uploadA.body.id}/run`).send({});

    const normalizedA = normalizePhoneForDedup(localPhones[0], countryCode);
    const createdA = await Customer.findOne({ workspaceId, phone: normalizedA }).lean();
    expect(createdA.marketingConsent).toBe(false);
    const eventsA = await ConsentEvent.find({ customerId: createdA._id });
    expect(eventsA.length).toBe(0);

    // Attested — the file-level checkbox checked.
    const csvB = csvBuffer([
      ['Name', 'Phone'],
      ['Import Test Consented', localPhones[3]],
    ]);
    const uploadB = await request.post('/api/imports')
      .field('entityType', 'customer')
      .field('marketingConsentAttested', 'true')
      .attach('file', csvB, '__test_import_consent.csv');
    await request.patch(`/api/imports/${uploadB.body.id}/mapping`).send({ columnMapping: uploadB.body.columnMapping });
    await request.post(`/api/imports/${uploadB.body.id}/run`).send({});

    const normalizedB = normalizePhoneForDedup(localPhones[3], countryCode);
    const createdB = await Customer.findOne({ workspaceId, phone: normalizedB }).lean();
    expect(createdB.marketingConsent).toBe(true);
    expect(createdB.marketingConsentMethod).toBe('manual_staff_entry');
    const eventsB = await ConsentEvent.find({ customerId: createdB._id });
    expect(eventsB.length).toBe(1);
    expect(eventsB[0].type).toBe('consent_given');

    // Re-importing the same attested file again must not double-log a second event.
    const uploadC = await request.post('/api/imports')
      .field('entityType', 'customer')
      .field('marketingConsentAttested', 'true')
      .attach('file', csvB, '__test_import_consent2.csv');
    await request.patch(`/api/imports/${uploadC.body.id}/mapping`).send({ columnMapping: uploadC.body.columnMapping });
    await request.post(`/api/imports/${uploadC.body.id}/run`).send({});
    const eventsAfterReimport = await ConsentEvent.find({ customerId: createdB._id });
    expect(eventsAfterReimport.length).toBe(1); // still just the one — no duplicate consent_given
  }, 30000);
});
