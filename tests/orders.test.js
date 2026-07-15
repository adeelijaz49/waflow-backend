require('dotenv').config();
const Stripe = require('stripe');

const { connectOnce } = require('./dbSetup');
const ops      = require('../shared/operations');
const Customer = require('../models/Customer');
const Order    = require('../models/Order');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const TEST_PHONE = '15550003333';

describe('orders: source filter + refund', () => {
  let customer;

  beforeAll(async () => {
    await connectOnce();
    customer = await Customer.create({ firstname: 'Order', lastname: 'Test', phone: TEST_PHONE });
  }, 15000);

  afterAll(async () => {
    await Order.deleteMany({ customer: customer._id });
    await Customer.findByIdAndDelete(customer._id);
  });

  test('listOrders filters by source', async () => {
    await Order.create({ customer: customer._id, subtotal: 10, total: 10, source: 'manual', paymentStatus: 'paid' });
    await Order.create({ customer: customer._id, subtotal: 20, total: 20, source: 'booking', paymentStatus: 'paid' });

    const manualOnly = await ops.listOrders({ source: 'manual', limit: 200 });
    const ids = manualOnly.orders.filter(o => o.customer._id.toString() === customer._id.toString());
    expect(ids.every(o => o.source === 'manual')).toBe(true);
    expect(ids.length).toBeGreaterThanOrEqual(1);
  });

  test('refundOrder rejects an order that has not been paid', async () => {
    const order = await Order.create({ customer: customer._id, subtotal: 10, total: 10, paymentStatus: 'pending' });
    await expect(ops.refundOrder({ id: order._id })).rejects.toThrow('Only paid orders can be refunded');
  });

  test('refundOrder issues a real Stripe test-mode refund and marks the order refunded', async () => {
    const pi = await stripe.paymentIntents.create({
      amount: 1000,
      currency: 'usd',
      payment_method: 'pm_card_visa',
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });
    const order = await Order.create({
      customer: customer._id, subtotal: 10, total: 10,
      paymentStatus: 'paid', stripePaymentIntentId: pi.id,
    });

    const refunded = await ops.refundOrder({ id: order._id });
    expect(refunded.paymentStatus).toBe('refunded');

    const refunds = await stripe.refunds.list({ payment_intent: pi.id });
    expect(refunds.data.length).toBeGreaterThanOrEqual(1);
  }, 15000);
});
