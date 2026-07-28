require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const ops              = require('../shared/operations');
const scheduler        = require('../utils/flowScheduler');
const Customer         = require('../models/Customer');
const Promotion        = require('../models/Promotion');
const CampaignMessage  = require('../models/CampaignMessage');
const Order            = require('../models/Order');
const Flow             = require('../models/Flow');
const FlowEnrollment   = require('../models/FlowEnrollment');
const { WINBACK_TEMPLATE } = require('../utils/whatsapp');

const DAYS = 24 * 60 * 60 * 1000;

// DEFECT-01: Demo Mode must never trigger a real WhatsApp API call. A real send
// would throw/reject against a bogus or shared phone number in this test
// environment — these tests assert the demo path never reaches that code at
// all, via the synthetic 'demo_' wamid prefix and (for flows) zero enrollment.
describe('Demo Mode isolation — zero real WhatsApp API calls', () => {
  let demoCustomer, demoPromotion;

  beforeAll(async () => {
    await connectOnce();
    demoCustomer = await Customer.create({
      firstname: '__test_demo_customer__', lastname: 'Test', phone: '61400000001',
      loyaltyPoints: 500, loyaltyPointsUpdatedAt: new Date(), isDemo: true,
    });
    demoPromotion = await Promotion.create({
      name: '__test_demo_promotion__', scope: 'products', customerType: 'cash',
      discountPercent: 20, isDemo: true,
    });
  });

  afterAll(async () => {
    await CampaignMessage.deleteMany({ customer: demoCustomer._id });
    await Order.deleteMany({ customer: demoCustomer._id });
    await Promotion.findByIdAndDelete(demoPromotion._id);
    await Customer.findByIdAndDelete(demoCustomer._id);
  });

  test('sendPromotion to a demo customer produces only a synthetic wamid, never a real send', async () => {
    const res = await ops.sendPromotion({ promotionId: demoPromotion._id, customerIds: [demoCustomer._id] });
    expect(res.sentCount).toBe(1);

    const cm = await CampaignMessage.findOne({ promotion: demoPromotion._id, customer: demoCustomer._id });
    expect(cm).toBeTruthy();
    expect(cm.wamid).toMatch(/^demo_/);
    expect(['sent', 'delivered', 'read']).toContain(cm.status);
  });

  test('sendLoyaltyReminders to a demo customer produces only a synthetic wamid', async () => {
    const res = await ops.sendLoyaltyReminders({ customerIds: [demoCustomer._id] });
    expect(res.sentCount).toBe(1);

    const cm = await CampaignMessage.findOne({ kind: 'loyalty_reminder', customer: demoCustomer._id });
    expect(cm).toBeTruthy();
    expect(cm.wamid).toMatch(/^demo_/);
  });

  test('a promotion flagged isDemo simulates even for a non-demo customer targeted by mistake', async () => {
    const otherCustomer = await Customer.create({ firstname: '__test_demo_other__', lastname: 'Test', phone: '61400000002' });
    try {
      const res = await ops.sendPromotion({ promotionId: demoPromotion._id, customerIds: [otherCustomer._id] });
      expect(res.sentCount).toBe(1);
      const cm = await CampaignMessage.findOne({ promotion: demoPromotion._id, customer: otherCustomer._id });
      expect(cm.wamid).toMatch(/^demo_/);
    } finally {
      await CampaignMessage.deleteMany({ customer: otherCustomer._id });
      await Order.deleteMany({ customer: otherCustomer._id });
      await Customer.findByIdAndDelete(otherCustomer._id);
    }
  });

  // allowRealDemoSend exists solely for the dedicated /demo sales-presentation
  // page's confirmed real send (routes/promotions.js's /:id/send-live-demo) — it
  // must default to false so every other caller keeps simulating. This does
  // attempt a real WhatsApp API call (to an obviously-fake number, matching the
  // existing convention in tests/flowScheduler.test.js), proving the bypass
  // actually bypasses rather than checking a mock.
  test('allowRealDemoSend bypasses simulation (default stays false everywhere else)', async () => {
    const res = await ops.sendPromotion({
      promotionId: demoPromotion._id, customerIds: [demoCustomer._id], allowRealDemoSend: true,
    });
    expect(res.sentCount + res.errors.length).toBe(1); // attempted a real send, whichever way it landed

    const cm = await CampaignMessage.findOne({ promotion: demoPromotion._id, customer: demoCustomer._id }).sort({ createdAt: -1 });
    expect(cm.wamid || '').not.toMatch(/^demo_/);
  });
});

describe('Demo Mode isolation — Automated Flows never enroll demo customers', () => {
  let flow, demoCustomer;

  beforeAll(async () => {
    await connectOnce();
    flow = await Flow.create({ name: '__test_demo_flow__', triggerType: 'inactive_customer', inactivityDays: 60, templateName: WINBACK_TEMPLATE, status: 'active' });
    demoCustomer = await Customer.create({ firstname: '__test_demo_flow_customer__', lastname: 'Test', phone: '61400000003', isDemo: true });
    await Order.create({ customer: demoCustomer._id, subtotal: 10, total: 10, status: 'delivered', createdAt: new Date(Date.now() - 70 * DAYS) });
  }, 15000);

  afterAll(async () => {
    await CampaignMessage.deleteMany({ customer: demoCustomer._id });
    await FlowEnrollment.deleteMany({ customer: demoCustomer._id });
    await Order.deleteMany({ customer: demoCustomer._id });
    await Customer.findByIdAndDelete(demoCustomer._id);
    await Flow.findByIdAndDelete(flow._id);
  });

  test('a stale demo customer is never enrolled by the inactive_customer trigger', async () => {
    await scheduler.enrollEligibleCustomers(flow);
    const count = await FlowEnrollment.countDocuments({ flow: flow._id, customer: demoCustomer._id });
    expect(count).toBe(0);
  });

  test('revalidate exits a demo customer even if somehow already enrolled', async () => {
    const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: demoCustomer._id, state: 'enrolled' });
    await scheduler.sendPendingEnrollments(flow);
    const updated = await FlowEnrollment.findById(enrollment._id);
    expect(updated.state).toBe('exited');
    expect(updated.exitReason).toBe('demo_customer');
    const messageCount = await CampaignMessage.countDocuments({ flowEnrollment: enrollment._id });
    expect(messageCount).toBe(0);
  }, 15000);
});
