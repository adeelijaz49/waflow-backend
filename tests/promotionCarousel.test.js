require('dotenv').config();
const request = require('supertest');

const { connectOnce } = require('./dbSetup');
const { getTestWorkspaceId } = require('./testAuth');
const app = require('../server');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const Service = require('../models/Service');
const Promotion = require('../models/Promotion');
const CampaignMessage = require('../models/CampaignMessage');
const { createConsentedCustomer } = require('./testFixtures');
const { resolveCarouselEligibleItems, sendCarouselPromotion } = require('../shared/promotionCarousel');
const { pendingSlotSelections } = require('../utils/state');

const TEST_PHONE = '15550003333';

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitUntil(checkFn, { timeout = 4000, interval = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await checkFn();
    if (result) return result;
    await wait(interval);
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

describe('Promotion.sendFormat', () => {
  let promotion;

  beforeAll(async () => { await connectOnce(); }, 15000);
  afterEach(async () => { if (promotion) { await Promotion.findByIdAndDelete(promotion._id); promotion = null; } });

  test('defaults to "separate" for a document created without it — existing promotions keep working exactly as before', async () => {
    promotion = await Promotion.create({ name: '__test_carousel_default__', scope: 'products' });
    expect(promotion.sendFormat).toBe('separate');

    // Re-fetch to prove this isn't just an in-memory default on the just-created
    // doc — a promotion loaded fresh from Mongo with the field entirely absent
    // (i.e. every promotion that existed before this field was added) hydrates
    // the same way, with zero migration needed.
    const reloaded = await Promotion.findById(promotion._id).lean();
    expect(reloaded.sendFormat === undefined || reloaded.sendFormat === 'separate').toBe(true);
  });

  test('accepts an explicit "carousel" value', async () => {
    promotion = await Promotion.create({ name: '__test_carousel_explicit__', scope: 'products', sendFormat: 'carousel' });
    expect(promotion.sendFormat).toBe('carousel');
  });
});

describe('resolveCarouselEligibleItems', () => {
  let workspaceId, promotion, productA, productB, productNoImage, productWebp;

  beforeAll(async () => {
    await connectOnce();
    workspaceId = await getTestWorkspaceId(app);
    productA = await Product.create({ name: '__test_carousel_prod_a__', category: 'Test', basePrice: 10, images: ['https://example.com/a.jpg'], workspaceId, active: true });
    productB = await Product.create({ name: '__test_carousel_prod_b__', category: 'Test', basePrice: 20, images: ['https://example.com/b.jpg'], workspaceId, active: true });
    productNoImage = await Product.create({ name: '__test_carousel_prod_noimg__', category: 'Test', basePrice: 15, images: [], workspaceId, active: true });
    productWebp = await Product.create({ name: '__test_carousel_prod_webp__', category: 'Test', basePrice: 15, images: ['https://example.com/c.webp'], workspaceId, active: true });
  }, 20000);

  afterAll(async () => {
    await Product.deleteMany({ _id: { $in: [productA._id, productB._id, productNoImage._id, productWebp._id] } });
    if (promotion) await Promotion.findByIdAndDelete(promotion._id);
  });

  test('excludes items with no image or an unsupported (webp) image, caps eligible at 10, flags <2 as ineligible', async () => {
    promotion = await Promotion.create({
      name: '__test_carousel_eligibility__', scope: 'products', workspaceId,
      products: [productA._id, productNoImage._id, productWebp._id], // only 1 eligible (productA)
    });
    const populated = await Promotion.findById(promotion._id).populate('products');
    const { items, cardCount, ineligibleReason } = await resolveCarouselEligibleItems(populated);
    expect(items.length).toBe(1);
    expect(items[0]._id.toString()).toBe(productA._id.toString());
    expect(cardCount).toBe(1);
    expect(ineligibleReason).toMatch(/at least 2/);
  });

  test('two eligible imaged products pass with no ineligibleReason', async () => {
    await Promotion.findByIdAndUpdate(promotion._id, { products: [productA._id, productB._id] });
    const populated = await Promotion.findById(promotion._id).populate('products');
    const { items, cardCount, ineligibleReason } = await resolveCarouselEligibleItems(populated);
    expect(items.length).toBe(2);
    expect(cardCount).toBe(2);
    expect(ineligibleReason).toBeNull();
  });
});

describe('sendCarouselPromotion', () => {
  let workspaceId, promotion, customerA, customerB, optedOutCustomer, productA, productB;

  beforeAll(async () => {
    await connectOnce();
    workspaceId = await getTestWorkspaceId(app);
    productA = await Product.create({ name: '__test_carousel_send_a__', category: 'Test', basePrice: 10, images: ['https://example.com/a.jpg'], workspaceId, active: true });
    productB = await Product.create({ name: '__test_carousel_send_b__', category: 'Test', basePrice: 20, images: ['https://example.com/b.jpg'], workspaceId, active: true });
    promotion = await Promotion.create({
      name: '__test_carousel_send_promo__', scope: 'products', sendFormat: 'carousel', workspaceId,
      products: [productA._id, productB._id], discountPercent: 10,
    });
    // isDemo:true on the customer (not the promotion) so it goes through the
    // fully-simulated branch — zero real image uploads/WhatsApp calls, same
    // "demo data never triggers real sends" rule shared/promotionCarousel.js
    // itself relies on. This keeps the test fast and deterministic instead of
    // depending on example.com/a.jpg actually being a fetchable image Meta
    // will accept — the consent gate and CampaignMessage-writing logic under
    // test here don't care whether the underlying send was real or simulated.
    customerA = await createConsentedCustomer({ firstname: '__test_carousel_customer_a__', lastname: 'Test', phone: '15559991111', workspaceId, isDemo: true });
    optedOutCustomer = await createConsentedCustomer({ firstname: '__test_carousel_customer_optedout__', lastname: 'Test', phone: '15559992222', workspaceId, optedOut: true });
  }, 20000);

  afterAll(async () => {
    await CampaignMessage.deleteMany({ promotion: promotion._id });
    await Customer.deleteMany({ _id: { $in: [customerA._id, optedOutCustomer._id] } });
    await Promotion.findByIdAndDelete(promotion._id);
    await Product.deleteMany({ _id: { $in: [productA._id, productB._id] } });
  }, 15000);

  test('respects the consent gate (opted-out customer skipped) and records messageType/templateName', async () => {
    const res = await sendCarouselPromotion({ promotionId: promotion._id, customerIds: [customerA._id, optedOutCustomer._id], workspaceId });
    expect(res.skippedOptedOut).toBe(1);
    expect(res.sentCount + res.errors.length).toBe(1); // only customerA was attempted

    const cm = await waitUntil(async () => CampaignMessage.findOne({ promotion: promotion._id, customer: customerA._id }));
    expect(cm.messageType).toBe('template'); // existing CampaignMessage enum value — no schema change needed
    expect(cm.templateName).toBe('waflow_carousel_2');

    const optedOutCm = await CampaignMessage.findOne({ promotion: promotion._id, customer: optedOutCustomer._id });
    expect(optedOutCm).toBeNull(); // never attempted at all, not even a 'failed' record
  }, 30000);
});

describe('webhook: carouselsvc_ dispatch (service-carousel "Book Now" tap)', () => {
  let workspaceId, service;

  beforeAll(async () => {
    await connectOnce();
    workspaceId = await getTestWorkspaceId(app);
    service = await Service.create({ name: '__test_carouselsvc_service__', basePrice: 50, duration: 30, images: ['https://example.com/s.jpg'], workspaceId, active: true });
  }, 20000);

  afterAll(async () => {
    pendingSlotSelections.delete(TEST_PHONE);
    await Service.findByIdAndDelete(service._id);
  });

  test('a template-shaped carouselsvc_ tap resolves the specific tapped service (not just the first one)', async () => {
    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        messages: [{ from: TEST_PHONE, type: 'button', button: { payload: `carouselsvc_${service._id}_none` } }],
      } }] }],
    });

    const pending = await waitUntil(() => pendingSlotSelections.get(TEST_PHONE) || null);
    expect(pending.service._id.toString()).toBe(service._id.toString());
  });
});
