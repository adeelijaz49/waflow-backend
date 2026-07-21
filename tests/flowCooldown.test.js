require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const scheduler = require('../utils/flowScheduler');
const Customer = require('../models/Customer');
const Flow = require('../models/Flow');
const FlowEnrollment = require('../models/FlowEnrollment');
const CampaignMessage = require('../models/CampaignMessage');
const { POINTS_NUDGE_TEMPLATE } = require('../utils/whatsapp');

const DAYS = 24 * 60 * 60 * 1000;

// Two separate Flow documents sharing a triggerType — the guardrail cares
// about any two flows racing for the same customer, not which specific
// triggers they are. Both use points_balance_reminder so a single synthetic
// customer (stale, positive balance) is genuinely eligible for both at once.
describe('cross-flow cooldown guardrail', () => {
  let flowA, flowB;

  beforeAll(async () => {
    await connectOnce();
    flowA = await Flow.create({ name: '__test_cooldown_flow_a__', triggerType: 'points_balance_reminder', inactivityDays: 30, templateName: POINTS_NUDGE_TEMPLATE, status: 'active' });
    flowB = await Flow.create({ name: '__test_cooldown_flow_b__', triggerType: 'points_balance_reminder', inactivityDays: 30, templateName: POINTS_NUDGE_TEMPLATE, status: 'active' });
  }, 15000);

  afterAll(async () => {
    await Flow.findByIdAndDelete(flowA._id);
    await Flow.findByIdAndDelete(flowB._id);
  });

  async function makeCustomer(phoneSuffix) {
    return Customer.create({
      firstname: '__test_cooldown_customer__', lastname: 'Test', phone: `1555400${phoneSuffix}`,
      loyaltyPoints: 500, loyaltyPointsUpdatedAt: new Date(Date.now() - 40 * DAYS),
    });
  }

  async function cleanup(customer, enrollmentIds) {
    await CampaignMessage.deleteMany({ customer: customer._id });
    await FlowEnrollment.deleteMany({ _id: { $in: enrollmentIds } });
    await Customer.findByIdAndDelete(customer._id);
  }

  test('two simultaneously-eligible flows for one customer → exactly one send', async () => {
    const customer = await makeCustomer('01');
    const enrollmentA = await FlowEnrollment.create({ flow: flowA._id, customer: customer._id, state: 'enrolled' });
    const enrollmentB = await FlowEnrollment.create({ flow: flowB._id, customer: customer._id, state: 'enrolled' });
    try {
      await scheduler.processEnrollment(flowA, enrollmentA);
      await scheduler.processEnrollment(flowB, enrollmentB);

      const updatedA = await FlowEnrollment.findById(enrollmentA._id);
      const updatedB = await FlowEnrollment.findById(enrollmentB._id);
      const states = [updatedA.state, updatedB.state].sort();
      expect(states).toEqual(['enrolled', 'messaged']); // one sent, the other skipped (not exited) this tick

      const messageCount = await CampaignMessage.countDocuments({ flowEnrollment: { $in: [enrollmentA._id, enrollmentB._id] } });
      expect(messageCount).toBe(1);
    } finally {
      await cleanup(customer, [enrollmentA._id, enrollmentB._id]);
    }
  }, 15000);

  test('cooldownDaysOverride on the second flow takes precedence over the global setting', async () => {
    const customer = await makeCustomer('02');
    const enrollmentA = await FlowEnrollment.create({ flow: flowA._id, customer: customer._id, state: 'enrolled' });
    const enrollmentB = await FlowEnrollment.create({ flow: flowB._id, customer: customer._id, state: 'enrolled' });
    try {
      await scheduler.processEnrollment(flowA, enrollmentA); // sends, starts the cooldown clock

      await Flow.findByIdAndUpdate(flowB._id, { cooldownDaysOverride: 0 }); // opts flowB out of the cooldown entirely
      const freshFlowB = await Flow.findById(flowB._id);
      await scheduler.processEnrollment(freshFlowB, enrollmentB);

      const updatedB = await FlowEnrollment.findById(enrollmentB._id);
      expect(updatedB.state).toBe('messaged'); // not blocked, despite flowA's very recent send
    } finally {
      await Flow.findByIdAndUpdate(flowB._id, { $unset: { cooldownDaysOverride: 1 } });
      await cleanup(customer, [enrollmentA._id, enrollmentB._id]);
    }
  }, 15000);

  test('after the cooldown window rolls past, the previously-skipped flow sends', async () => {
    const customer = await makeCustomer('03');
    const enrollmentA = await FlowEnrollment.create({ flow: flowA._id, customer: customer._id, state: 'enrolled' });
    const enrollmentB = await FlowEnrollment.create({ flow: flowB._id, customer: customer._id, state: 'enrolled' });
    try {
      await scheduler.processEnrollment(flowA, enrollmentA);
      await scheduler.processEnrollment(flowB, enrollmentB);

      const blockedB = await FlowEnrollment.findById(enrollmentB._id);
      expect(blockedB.state).toBe('enrolled'); // skipped this tick, blocked by flowA's recent send

      // Backdate flowA's send past the default 3-day cooldown window
      await CampaignMessage.updateMany({ flowEnrollment: enrollmentA._id }, { sentAt: new Date(Date.now() - 4 * DAYS) });

      await scheduler.processEnrollment(flowB, blockedB);
      const updatedB = await FlowEnrollment.findById(enrollmentB._id);
      expect(updatedB.state).toBe('messaged');
    } finally {
      await cleanup(customer, [enrollmentA._id, enrollmentB._id]);
    }
  }, 15000);
});
