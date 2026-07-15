require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const ops       = require('../shared/operations');
const Customer  = require('../models/Customer');
const Order     = require('../models/Order');
const Promotion = require('../models/Promotion');

// getRecommendedCustomers normalizes recency/frequency/monetary against the max
// found across ALL customers in the system, not just these test ones — so real
// demo data (or anything else already in the DB) shares the same pool. Rather
// than trying to isolate from that, "returning" and "highValue" are given order
// counts/spend large enough to become the new max themselves (guaranteeing
// their own normalized score is exactly 1.0, safely above any threshold), and
// "inactive"/"best" use values low enough to stay low relative to that new max
// regardless of what else exists. Recency similarly uses a 200-day-old last
// order, far outside the ~60-day window seed-demo.js generates, to safely
// dominate maxDays.
const DAYS = 24 * 60 * 60 * 1000;

describe('getRecommendedCustomers segment labels', () => {
  let promotion;
  let customers = {};

  beforeAll(async () => {
    await connectOnce();
    promotion = await Promotion.create({ name: '__test_segments__', scope: 'products', customerType: 'cash', type: 'store_wide' });

    const specs = {
      inactive:  { firstname: '__segA_inactive__',  phone: '15559990001' },
      returning: { firstname: '__segB_returning__', phone: '15559990002' },
      highValue: { firstname: '__segC_highvalue__', phone: '15559990003' },
      best:      { firstname: '__segD_best__',      phone: '15559990004' },
    };
    for (const [key, spec] of Object.entries(specs)) {
      customers[key] = await Customer.create({ ...spec, lastname: 'Test' });
    }

    const orderDefaults = { status: 'confirmed', shippingCost: 0 };
    const orders = [];
    // Inactive: one small order, 200 days ago — low volume/spend, old.
    orders.push({ ...orderDefaults, customer: customers.inactive._id, subtotal: 10, total: 10, createdAt: new Date(Date.now() - 200 * DAYS) });
    // Returning: 30 orders x $200 = $6000 — large enough to set the pool's own
    // max regardless of other data — but the last one was 200 days ago.
    for (let i = 0; i < 30; i++) {
      orders.push({ ...orderDefaults, customer: customers.returning._id, subtotal: 200, total: 200, createdAt: new Date(Date.now() - (200 + i) * DAYS) });
    }
    // High-value: same volume/spend as "returning" (also sets the max), but recent.
    for (let i = 0; i < 30; i++) {
      orders.push({ ...orderDefaults, customer: customers.highValue._id, subtotal: 200, total: 200, createdAt: new Date(Date.now() - (1 + i * 0.1) * DAYS) });
    }
    // Best: recent, but modest order count/spend — comfortably below the
    // high-value bar even against the $6000/30-order max set above.
    orders.push({ ...orderDefaults, customer: customers.best._id, subtotal: 66, total: 66, createdAt: new Date(Date.now() - 5 * DAYS) });
    orders.push({ ...orderDefaults, customer: customers.best._id, subtotal: 67, total: 67, createdAt: new Date(Date.now() - 6 * DAYS) });
    orders.push({ ...orderDefaults, customer: customers.best._id, subtotal: 67, total: 67, createdAt: new Date(Date.now() - 7 * DAYS) });
    await Order.insertMany(orders);
  }, 20000);

  afterAll(async () => {
    const ids = Object.values(customers).map(c => c._id);
    await Order.deleteMany({ customer: { $in: ids } });
    await Customer.deleteMany({ _id: { $in: ids } });
    await Promotion.findByIdAndDelete(promotion._id);
  });

  test('assigns all four segment labels correctly', async () => {
    const recs = await ops.getRecommendedCustomers({ promotionId: promotion._id, limit: 500 });
    const byId = Object.fromEntries(recs.map(c => [c._id.toString(), c]));

    expect(byId[customers.inactive._id.toString()].segment).toBe('Inactive customers');
    expect(byId[customers.returning._id.toString()].segment).toBe('Customers likely to return');
    expect(byId[customers.highValue._id.toString()].segment).toBe('High-value customers');
    expect(byId[customers.best._id.toString()].segment).toBe('Best customers to target');
  });
});
