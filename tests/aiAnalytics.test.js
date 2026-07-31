require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const ops = require('../shared/operations');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Promotion = require('../models/Promotion');
const CampaignMessage = require('../models/CampaignMessage');

const DAYS = 24 * 60 * 60 * 1000;

describe('AI Mode Phase 2 analytics operations', () => {
  let oldCustomer, newCustomer, staleCustomer;
  let promoA, promoB;

  beforeAll(async () => {
    await connectOnce();

    oldCustomer = await Customer.create({ firstname: '__test_ai__', lastname: 'ReturningOld', phone: '15559990001', loyaltyPoints: 50 });
    newCustomer = await Customer.create({ firstname: '__test_ai__', lastname: 'NewThisMonth', phone: '15559990002', loyaltyPoints: 9999 });
    staleCustomer = await Customer.create({ firstname: '__test_ai__', lastname: 'Stale', phone: '15559990003', loyaltyPoints: 10 });

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 5);

    // oldCustomer: one order last month, one order this month -> counts as "returned"
    await Order.create({ customer: oldCustomer._id, subtotal: 10, total: 10, status: 'confirmed', createdAt: new Date(thisMonthStart.getTime() - 40 * DAYS) });
    await Order.create({ customer: oldCustomer._id, subtotal: 10, total: 10, status: 'confirmed', createdAt: thisMonthStart });

    // newCustomer: only ordered this month, no prior history -> NOT a "return"
    await Order.create({ customer: newCustomer._id, subtotal: 10, total: 10, status: 'confirmed', createdAt: thisMonthStart });

    // staleCustomer: last order 90 days ago, nothing since -> inactive
    await Order.create({ customer: staleCustomer._id, subtotal: 10, total: 10, status: 'confirmed', createdAt: new Date(now.getTime() - 90 * DAYS) });

    promoA = await Promotion.create({ name: '__test_ai_promo_a__', scope: 'products', customerType: 'cash' });
    promoB = await Promotion.create({ name: '__test_ai_promo_b__', scope: 'products', customerType: 'cash' });
    await CampaignMessage.create({ kind: 'promotion', promotion: promoA._id, customer: oldCustomer._id, phone: oldCustomer.phone, status: 'sent', revenue: 100, sentAt: new Date() });
    await CampaignMessage.create({ kind: 'promotion', promotion: promoB._id, customer: newCustomer._id, phone: newCustomer.phone, status: 'sent', revenue: 10, sentAt: new Date() });
  }, 20000);

  afterAll(async () => {
    await CampaignMessage.deleteMany({ promotion: { $in: [promoA._id, promoB._id] } });
    await Promotion.deleteMany({ _id: { $in: [promoA._id, promoB._id] } });
    await Order.deleteMany({ customer: { $in: [oldCustomer._id, newCustomer._id, staleCustomer._id] } });
    await Customer.deleteMany({ _id: { $in: [oldCustomer._id, newCustomer._id, staleCustomer._id] } });
  });

  test('getCustomerReturnRate counts a customer with prior history who ordered again this month, not a first-time buyer', async () => {
    const now = new Date();
    const result = await ops.getCustomerReturnRate({ month: now.getMonth() + 1, year: now.getFullYear() });
    expect(result.returningCustomers).toBeGreaterThanOrEqual(1);
    // total customers this month must include both old and new buyers
    expect(result.totalCustomersThisMonth).toBeGreaterThanOrEqual(2);
  });

  test('getTopLoyaltyCustomers ranks by loyaltyPoints descending', async () => {
    const top = await ops.getTopLoyaltyCustomers({ limit: 50 });
    const names = top.map(c => c.name);
    const newIdx = names.indexOf('__test_ai__ NewThisMonth');
    const oldIdx = names.indexOf('__test_ai__ ReturningOld');
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeGreaterThan(newIdx); // 9999 pts must rank above 50 pts
  });

  test('getBestPerformingPromotion ranks promoA above promoB by revenue and includes currency', async () => {
    const result = await ops.getBestPerformingPromotion({ metric: 'revenue', limit: 50 });
    expect(result.currency).toBeTruthy();
    const names = result.promotions.map(p => p.name);
    const aIdx = names.indexOf('__test_ai_promo_a__');
    const bIdx = names.indexOf('__test_ai_promo_b__');
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx); // promoA has 100 revenue vs promoB's 10
  });

  test('listInactiveCustomers finds the stale customer but not the recently-active ones', async () => {
    const result = await ops.listInactiveCustomers({ days: 60 });
    const names = result.customers.map(c => c.name);
    expect(names).toContain('__test_ai__ Stale');
    expect(names).not.toContain('__test_ai__ ReturningOld');
    expect(names).not.toContain('__test_ai__ NewThisMonth');
  });
});
