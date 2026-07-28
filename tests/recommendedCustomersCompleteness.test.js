require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const ops       = require('../shared/operations');
const Customer  = require('../models/Customer');
const Order     = require('../models/Order');
const Promotion = require('../models/Promotion');

// DEFECT-04B: getRecommendedCustomers previously scored/ranked only customers
// appearing in the Order aggregation (i.e. ≥1 non-cancelled order) — a brand-new
// or freshly-imported customer with zero orders was silently and permanently
// absent from the promotion send panel, regardless of the limit. Every
// opted-in customer must now be a candidate, scoring 0 (last-ranked) rather
// than being excluded outright.
describe('getRecommendedCustomers includes customers with zero order history', () => {
  let promotion, orderedCustomer, neverOrderedCustomer;

  beforeAll(async () => {
    await connectOnce();
    promotion = await Promotion.create({ name: '__test_zero_order_visibility__', scope: 'products', customerType: 'cash', type: 'store_wide' });
    orderedCustomer = await Customer.create({ firstname: '__test_has_orders__', lastname: 'Test', phone: '15559990101' });
    neverOrderedCustomer = await Customer.create({ firstname: '__test_never_ordered__', lastname: 'Test', phone: '15559990102' });
    await Order.create({ customer: orderedCustomer._id, subtotal: 50, total: 50, status: 'confirmed', createdAt: new Date() });
  });

  afterAll(async () => {
    const ids = [orderedCustomer._id, neverOrderedCustomer._id];
    await Order.deleteMany({ customer: { $in: ids } });
    await Customer.deleteMany({ _id: { $in: ids } });
    await Promotion.findByIdAndDelete(promotion._id);
  });

  test('a customer with zero orders still appears, scored 0, ranked below one with order history', async () => {
    const recs = await ops.getRecommendedCustomers({ promotionId: promotion._id, limit: 1000 });
    const byId = Object.fromEntries(recs.map(c => [c._id.toString(), c]));

    const zeroOrderRec = byId[neverOrderedCustomer._id.toString()];
    const hasOrderRec  = byId[orderedCustomer._id.toString()];

    expect(zeroOrderRec).toBeTruthy(); // the actual regression: previously undefined
    expect(hasOrderRec).toBeTruthy();
    expect(zeroOrderRec.rfmScore).toBe(0);
    expect(zeroOrderRec.orderCount).toBe(0);
    expect(hasOrderRec.rfmScore).toBeGreaterThan(zeroOrderRec.rfmScore);
  });
});
