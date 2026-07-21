require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const scheduler = require('../utils/flowScheduler');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Flow = require('../models/Flow');
const FlowEnrollment = require('../models/FlowEnrollment');
const CampaignMessage = require('../models/CampaignMessage');
const { WINBACK_TEMPLATE } = require('../utils/whatsapp');

const DAYS = 24 * 60 * 60 * 1000;

describe('flow scheduler: enrollment + send concurrency, exit-before-send', () => {
  let flow;

  beforeAll(async () => {
    await connectOnce();
    // Short inactivityDays so a "70 days ago" order is comfortably stale without
    // needing to fabricate an unrealistic date; kept well clear of any real demo data.
    flow = await Flow.create({ name: '__test_scheduler_flow__', triggerType: 'inactive_customer', inactivityDays: 60, templateName: WINBACK_TEMPLATE, status: 'active' });
  }, 15000);

  afterAll(async () => {
    await Flow.findByIdAndDelete(flow._id);
  });

  async function makeStaleCustomer(phoneSuffix, opts = {}) {
    const customer = await Customer.create({
      firstname: '__test_scheduler_customer__', lastname: 'Test', phone: `1555100${phoneSuffix}`,
      optedOut: opts.optedOut || false,
    });
    await Order.create({ customer: customer._id, subtotal: 10, total: 10, status: 'delivered', createdAt: new Date(Date.now() - 70 * DAYS) });
    return customer;
  }

  async function cleanupCustomer(customer) {
    await CampaignMessage.deleteMany({ customer: customer._id });
    await FlowEnrollment.deleteMany({ customer: customer._id });
    await Order.deleteMany({ customer: customer._id });
    await Customer.findByIdAndDelete(customer._id);
  }

  test('enrollment concurrency: two concurrent sweeps enroll a stale customer exactly once', async () => {
    const customer = await makeStaleCustomer('01');
    try {
      await Promise.all([
        scheduler.enrollEligibleCustomers(flow),
        scheduler.enrollEligibleCustomers(flow),
      ]);
      const count = await FlowEnrollment.countDocuments({ flow: flow._id, customer: customer._id });
      expect(count).toBe(1);
    } finally {
      await cleanupCustomer(customer);
    }
  });

  test('opted-out customers are never enrolled', async () => {
    const customer = await makeStaleCustomer('02', { optedOut: true });
    try {
      await scheduler.enrollEligibleCustomers(flow);
      const count = await FlowEnrollment.countDocuments({ flow: flow._id, customer: customer._id });
      expect(count).toBe(0);
    } finally {
      await cleanupCustomer(customer);
    }
  });

  test('exit-before-send: a customer who reorders while enrolled is exited, not messaged', async () => {
    const customer = await makeStaleCustomer('03');
    try {
      await scheduler.enrollEligibleCustomers(flow);
      const enrollment = await FlowEnrollment.findOne({ flow: flow._id, customer: customer._id });
      expect(enrollment).toBeTruthy();

      // Customer places a fresh order after enrolling but before the send sweep runs.
      await Order.create({ customer: customer._id, subtotal: 20, total: 20, status: 'delivered', createdAt: new Date() });

      await scheduler.sendPendingEnrollments(flow);

      const updated = await FlowEnrollment.findById(enrollment._id);
      expect(updated.state).toBe('exited');
      expect(updated.exitReason).toBe('reordered');
      const messageCount = await CampaignMessage.countDocuments({ flowEnrollment: enrollment._id });
      expect(messageCount).toBe(0);
    } finally {
      await cleanupCustomer(customer);
    }
  }, 15000);

  test('send concurrency: two concurrent claim attempts on one enrollment send exactly once', async () => {
    const customer = await makeStaleCustomer('04');
    try {
      const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'enrolled' });

      await Promise.all([
        scheduler.processEnrollment(flow, enrollment),
        scheduler.processEnrollment(flow, enrollment),
      ]);

      const messageCount = await CampaignMessage.countDocuments({ flowEnrollment: enrollment._id });
      expect(messageCount).toBe(1);
      const updated = await FlowEnrollment.findById(enrollment._id);
      expect(updated.state).toBe('messaged');
    } finally {
      await cleanupCustomer(customer);
    }
  }, 15000);
});
