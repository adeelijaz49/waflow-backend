require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const scheduler = require('../utils/flowScheduler');
const Customer = require('../models/Customer');
const Flow = require('../models/Flow');
const FlowEnrollment = require('../models/FlowEnrollment');
const CampaignMessage = require('../models/CampaignMessage');
const { POINTS_NUDGE_TEMPLATE } = require('../utils/whatsapp');

const DAYS = 24 * 60 * 60 * 1000;

describe('flow trigger: points_balance_reminder', () => {
  let flow;

  beforeAll(async () => {
    await connectOnce();
    flow = await Flow.create({ name: '__test_points_reminder_flow__', triggerType: 'points_balance_reminder', inactivityDays: 30, templateName: POINTS_NUDGE_TEMPLATE, status: 'active' });
  }, 15000);

  afterAll(async () => {
    await Flow.findByIdAndDelete(flow._id);
  });

  async function cleanup(customer) {
    await CampaignMessage.deleteMany({ customer: customer._id });
    await FlowEnrollment.deleteMany({ customer: customer._id });
    await Customer.findByIdAndDelete(customer._id);
  }

  test('a customer with a stale, unused balance is eligible and gets sent', async () => {
    const customer = await Customer.create({
      firstname: '__test_points_stale__', lastname: 'Test', phone: '15552001',
      loyaltyPoints: 500, loyaltyPointsUpdatedAt: new Date(Date.now() - 40 * DAYS),
    });
    try {
      await scheduler.enrollEligibleCustomers(flow);
      const enrollment = await FlowEnrollment.findOne({ flow: flow._id, customer: customer._id });
      expect(enrollment).toBeTruthy();

      await scheduler.sendPendingEnrollments(flow);

      const updated = await FlowEnrollment.findById(enrollment._id);
      expect(updated.state).toBe('messaged');
      const messageCount = await CampaignMessage.countDocuments({ flowEnrollment: enrollment._id });
      expect(messageCount).toBe(1);
    } finally {
      await cleanup(customer);
    }
  }, 15000);

  test('a customer whose balance changed recently is not eligible', async () => {
    const customer = await Customer.create({
      firstname: '__test_points_recent__', lastname: 'Test', phone: '15552002',
      loyaltyPoints: 500, loyaltyPointsUpdatedAt: new Date(), // just changed
    });
    try {
      await scheduler.enrollEligibleCustomers(flow);
      const enrollment = await FlowEnrollment.findOne({ flow: flow._id, customer: customer._id });
      expect(enrollment).toBeNull();
    } finally {
      await cleanup(customer);
    }
  });

  test('a customer with zero points is never eligible', async () => {
    const customer = await Customer.create({
      firstname: '__test_points_zero__', lastname: 'Test', phone: '15552003',
      loyaltyPoints: 0, loyaltyPointsUpdatedAt: new Date(Date.now() - 40 * DAYS),
    });
    try {
      await scheduler.enrollEligibleCustomers(flow);
      const enrollment = await FlowEnrollment.findOne({ flow: flow._id, customer: customer._id });
      expect(enrollment).toBeNull();
    } finally {
      await cleanup(customer);
    }
  });

  test('a balance that changes between enrollment and send exits instead of sending', async () => {
    const customer = await Customer.create({
      firstname: '__test_points_changes__', lastname: 'Test', phone: '15552004',
      loyaltyPoints: 500, loyaltyPointsUpdatedAt: new Date(Date.now() - 40 * DAYS),
    });
    try {
      await scheduler.enrollEligibleCustomers(flow);
      const enrollment = await FlowEnrollment.findOne({ flow: flow._id, customer: customer._id });
      expect(enrollment).toBeTruthy();

      // Customer redeems points after enrolling but before the send sweep runs —
      // mirrors what the real $inc sites in server.js now do on every points change.
      await Customer.findByIdAndUpdate(customer._id, { loyaltyPoints: 0, loyaltyPointsUpdatedAt: new Date() });

      await scheduler.sendPendingEnrollments(flow);

      const updated = await FlowEnrollment.findById(enrollment._id);
      expect(updated.state).toBe('exited');
      expect(updated.exitReason).toBe('points_redeemed');
      const messageCount = await CampaignMessage.countDocuments({ flowEnrollment: enrollment._id });
      expect(messageCount).toBe(0);
    } finally {
      await cleanup(customer);
    }
  }, 15000);
});
