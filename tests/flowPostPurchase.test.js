require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const scheduler = require('../utils/flowScheduler');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Flow = require('../models/Flow');
const FlowEnrollment = require('../models/FlowEnrollment');
const CampaignMessage = require('../models/CampaignMessage');
const { POST_PURCHASE_TEMPLATE } = require('../utils/whatsapp');

const HOURS = 60 * 60 * 1000;

describe('flow trigger: post_purchase_points', () => {
  let flow;

  beforeAll(async () => {
    await connectOnce();
    flow = await Flow.create({ name: '__test_post_purchase_flow__', triggerType: 'post_purchase_points', delayHours: 2, templateName: POST_PURCHASE_TEMPLATE, status: 'active' });
  }, 15000);

  afterAll(async () => {
    await Flow.findByIdAndDelete(flow._id);
  });

  async function makeCustomer(phoneSuffix) {
    return Customer.create({ firstname: '__test_pp_customer__', lastname: 'Test', phone: `1555200${phoneSuffix}` });
  }

  async function cleanup(customer, order) {
    await CampaignMessage.deleteMany({ customer: customer._id });
    await FlowEnrollment.deleteMany({ customer: customer._id });
    await Order.findByIdAndDelete(order._id);
    await Customer.findByIdAndDelete(customer._id);
  }

  test('an order not yet past its delay stays enrolled, unsent', async () => {
    const customer = await makeCustomer('01');
    const order = await Order.create({ customer: customer._id, subtotal: 10, total: 10, paymentStatus: 'paid', paidAt: new Date() });
    try {
      await scheduler.enrollEligibleCustomers(flow);
      const enrollment = await FlowEnrollment.findOne({ flow: flow._id, sourceRef: order._id });
      expect(enrollment).toBeTruthy();

      await scheduler.sendPendingEnrollments(flow);

      const updated = await FlowEnrollment.findById(enrollment._id);
      expect(updated.state).toBe('enrolled'); // still waiting — delayHours (2h) hasn't elapsed
      const messageCount = await CampaignMessage.countDocuments({ flowEnrollment: enrollment._id });
      expect(messageCount).toBe(0);
    } finally {
      await cleanup(customer, order);
    }
  }, 15000);

  test('an order past its delay gets sent', async () => {
    const customer = await makeCustomer('02');
    const order = await Order.create({ customer: customer._id, subtotal: 10, total: 10, paymentStatus: 'paid', paidAt: new Date(Date.now() - 3 * HOURS) });
    try {
      await scheduler.enrollEligibleCustomers(flow);
      const enrollment = await FlowEnrollment.findOne({ flow: flow._id, sourceRef: order._id });
      expect(enrollment).toBeTruthy();

      await scheduler.sendPendingEnrollments(flow);

      const updated = await FlowEnrollment.findById(enrollment._id);
      expect(updated.state).toBe('messaged');
      const messageCount = await CampaignMessage.countDocuments({ flowEnrollment: enrollment._id });
      expect(messageCount).toBe(1);
    } finally {
      await cleanup(customer, order);
    }
  }, 15000);

  test('an order refunded before send exits instead of sending', async () => {
    const customer = await makeCustomer('03');
    const order = await Order.create({ customer: customer._id, subtotal: 10, total: 10, paymentStatus: 'paid', paidAt: new Date(Date.now() - 3 * HOURS) });
    try {
      await scheduler.enrollEligibleCustomers(flow);
      const enrollment = await FlowEnrollment.findOne({ flow: flow._id, sourceRef: order._id });
      expect(enrollment).toBeTruthy();

      await Order.findByIdAndUpdate(order._id, { paymentStatus: 'refunded' });
      await scheduler.sendPendingEnrollments(flow);

      const updated = await FlowEnrollment.findById(enrollment._id);
      expect(updated.state).toBe('exited');
      expect(updated.exitReason).toBe('order_refunded');
      const messageCount = await CampaignMessage.countDocuments({ flowEnrollment: enrollment._id });
      expect(messageCount).toBe(0);
    } finally {
      await cleanup(customer, order);
    }
  }, 15000);

  test('the same order never enrolls twice, even across repeated sweeps', async () => {
    const customer = await makeCustomer('04');
    const order = await Order.create({ customer: customer._id, subtotal: 10, total: 10, paymentStatus: 'paid', paidAt: new Date() });
    try {
      await scheduler.enrollEligibleCustomers(flow);
      await scheduler.enrollEligibleCustomers(flow);
      await scheduler.enrollEligibleCustomers(flow);
      const count = await FlowEnrollment.countDocuments({ flow: flow._id, sourceRef: order._id });
      expect(count).toBe(1);
    } finally {
      await cleanup(customer, order);
    }
  }, 15000);
});
