require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const ops = require('../shared/operations');
const scheduler = require('../utils/flowScheduler');
const pointsThreshold = require('../utils/flowTriggers/pointsThreshold');
const purchaseFrequency = require('../utils/flowTriggers/purchaseFrequency');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Promotion = require('../models/Promotion');
const Flow = require('../models/Flow');
const FlowEnrollment = require('../models/FlowEnrollment');
const CampaignMessage = require('../models/CampaignMessage');
const MessageNode = require('../models/MessageNode');

const DAYS = 24 * 60 * 60 * 1000;

// DEFECT-03 §8.1 — new rule metrics beyond the original 4.
describe('flowTriggers: points_threshold', () => {
  let flow, customer;

  beforeAll(async () => {
    await connectOnce();
    flow = await Flow.create({ name: '__test_points_threshold_flow__', triggerType: 'points_threshold', pointsThreshold: 1000 });
    customer = await Customer.create({ firstname: '__test_pt_customer__', lastname: 'Test', phone: '15559100', loyaltyPoints: 1500 });
  });

  afterAll(async () => {
    await CampaignMessage.deleteMany({ customer: customer._id });
    await FlowEnrollment.deleteMany({ customer: customer._id });
    await Customer.findByIdAndDelete(customer._id);
    await Flow.findByIdAndDelete(flow._id);
  });

  test('a customer above the threshold is eligible', async () => {
    const eligible = await pointsThreshold.findEligible(flow);
    expect(eligible.some(e => e.customerId.toString() === customer._id.toString())).toBe(true);
  });

  test('once ever enrolled (any state), never eligible again — one-time crossing, not a recurring reminder', async () => {
    await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'completed' });
    const eligible = await pointsThreshold.findEligible(flow);
    expect(eligible.some(e => e.customerId.toString() === customer._id.toString())).toBe(false);
  });

  test('revalidate exits if points dropped below threshold (e.g. redeemed) since enrollment', async () => {
    await Customer.findByIdAndUpdate(customer._id, { loyaltyPoints: 100 });
    const enrollment = { customer: customer._id };
    const verdict = await pointsThreshold.revalidate(flow, enrollment);
    expect(verdict.outcome).toBe('exit');
    expect(verdict.reason).toBe('points_dropped_below_threshold');
  });

  test('buildSend throws — no fixed default template exists for this promotion-only trigger type', async () => {
    await expect(pointsThreshold.buildSend()).rejects.toThrow('no message configured');
  });
});

describe('flowTriggers: purchase_frequency', () => {
  let flow, customer;

  beforeAll(async () => {
    await connectOnce();
    flow = await Flow.create({ name: '__test_purchase_freq_flow__', triggerType: 'purchase_frequency', inactivityDays: 30, orderCountThreshold: 2 });
    customer = await Customer.create({ firstname: '__test_pf_customer__', lastname: 'Test', phone: '15559101' });
    await Order.create({ customer: customer._id, subtotal: 10, total: 10, status: 'confirmed', createdAt: new Date(Date.now() - 5 * DAYS) });
    await Order.create({ customer: customer._id, subtotal: 10, total: 10, status: 'confirmed', createdAt: new Date(Date.now() - 10 * DAYS) });
  });

  afterAll(async () => {
    await CampaignMessage.deleteMany({ customer: customer._id });
    await FlowEnrollment.deleteMany({ customer: customer._id });
    await Order.deleteMany({ customer: customer._id });
    await Customer.findByIdAndDelete(customer._id);
    await Flow.findByIdAndDelete(flow._id);
  });

  test('a customer with 2+ orders within the window is eligible', async () => {
    const eligible = await purchaseFrequency.findEligible(flow);
    expect(eligible.some(e => e.customerId.toString() === customer._id.toString())).toBe(true);
  });

  test('a customer with only 1 order in the window is not eligible', async () => {
    const lonelyCustomer = await Customer.create({ firstname: '__test_pf_lonely__', lastname: 'Test', phone: '15559102' });
    await Order.create({ customer: lonelyCustomer._id, subtotal: 10, total: 10, status: 'confirmed', createdAt: new Date() });
    try {
      const eligible = await purchaseFrequency.findEligible(flow);
      expect(eligible.some(e => e.customerId.toString() === lonelyCustomer._id.toString())).toBe(false);
    } finally {
      await Order.deleteMany({ customer: lonelyCustomer._id });
      await Customer.findByIdAndDelete(lonelyCustomer._id);
    }
  });

  test('once ever enrolled, never eligible again', async () => {
    await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'exited', exitReason: 'test' });
    const eligible = await purchaseFrequency.findEligible(flow);
    expect(eligible.some(e => e.customerId.toString() === customer._id.toString())).toBe(false);
  });
});

describe('DEFECT-03: createFlow requires a promotion for promotion-only trigger types', () => {
  test('rejects points_threshold without promotionId', async () => {
    await expect(ops.createFlow({ name: 'x', triggerType: 'points_threshold' })).rejects.toThrow('requires referencing a Promotion');
  });

  test('rejects purchase_frequency without promotionId', async () => {
    await expect(ops.createFlow({ name: 'x', triggerType: 'purchase_frequency' })).rejects.toThrow('requires referencing a Promotion');
  });

  test('accepts points_threshold with a promotionId', async () => {
    const promotion = await Promotion.create({ name: '__test_preq_promo__', scope: 'products', customerType: 'cash' });
    try {
      const flow = await ops.createFlow({ name: '__test_preq_flow__', triggerType: 'points_threshold', promotionId: promotion._id });
      expect(flow.promotionId.toString()).toBe(promotion._id.toString());
      await Flow.findByIdAndDelete(flow._id);
    } finally {
      await Promotion.findByIdAndDelete(promotion._id);
    }
  });
});

describe('DEFECT-03: Flow.promotionId send path', () => {
  // A fresh customer per test — sharing one would trip processEnrollment's
  // cross-flow cooldown guard (a CampaignMessage from one test's flow blocks
  // the very next tick for any *other* flow within the cooldown window),
  // exactly like flowBranching.test.js's makeStaleCustomer per sub-test.
  async function makeStaleCustomer(phoneSuffix) {
    const customer = await Customer.create({ firstname: '__test_flow_promo_customer__', lastname: 'Test', phone: `1555910${phoneSuffix}` });
    await Order.create({ customer: customer._id, subtotal: 10, total: 10, status: 'delivered', createdAt: new Date(Date.now() - 70 * DAYS) });
    return customer;
  }

  async function cleanupCustomer(customer) {
    await CampaignMessage.deleteMany({ customer: customer._id });
    await Order.deleteMany({ customer: customer._id });
    await Customer.findByIdAndDelete(customer._id);
  }

  test('a flow referencing a promotion with no approved entry node fails clearly, not silently', async () => {
    const customer = await makeStaleCustomer('5');
    const promotion = await Promotion.create({ name: '__test_flow_promo_unapproved__', scope: 'products', customerType: 'cash' });
    const flow = await Flow.create({ name: '__test_flow_promo_flow_1__', triggerType: 'inactive_customer', inactivityDays: 60, promotionId: promotion._id });
    try {
      const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'enrolled' });
      await scheduler.processEnrollment(flow, enrollment);
      const cm = await CampaignMessage.findOne({ flowEnrollment: enrollment._id });
      expect(cm.status).toBe('failed');
      expect(cm.statusReason).toMatch(/approved custom message/);
      expect(cm.promotion.toString()).toBe(promotion._id.toString());
    } finally {
      await FlowEnrollment.deleteMany({ flow: flow._id });
      await Flow.findByIdAndDelete(flow._id);
      await Promotion.findByIdAndDelete(promotion._id);
      await cleanupCustomer(customer);
    }
  });

  test('a flow referencing a promotion with an approved entry node sends it (routing, not delivery, is under test)', async () => {
    const customer = await makeStaleCustomer('6');
    const promotion = await Promotion.create({ name: '__test_flow_promo_approved__', scope: 'products', customerType: 'cash' });
    const node = await MessageNode.create({
      ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Hi {{1}}, {{2}} for {{3}}! {{4}}',
      templateName: 'waflow_flow_promo_test', templateStatus: 'approved',
      buttons: [{ position: 0, label: 'Shop', nextAction: { type: 'end_flow' } }],
    });
    await Promotion.findByIdAndUpdate(promotion._id, { entryNodeId: node._id });
    const flow = await Flow.create({ name: '__test_flow_promo_flow_2__', triggerType: 'inactive_customer', inactivityDays: 60, promotionId: promotion._id });
    try {
      const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'enrolled' });
      await scheduler.processEnrollment(flow, enrollment);
      const cm = await CampaignMessage.findOne({ flowEnrollment: enrollment._id });
      expect(cm.templateName).toBe('waflow_flow_promo_test');
      expect(cm.messageNode.toString()).toBe(node._id.toString());
      expect(cm.promotion.toString()).toBe(promotion._id.toString());
      // status may be 'failed' since this template was never really submitted
      // to Meta — matching this codebase's established no-mocking convention.
    } finally {
      await FlowEnrollment.deleteMany({ flow: flow._id });
      await Flow.findByIdAndDelete(flow._id);
      await MessageNode.findByIdAndDelete(node._id);
      await Promotion.findByIdAndDelete(promotion._id);
      await cleanupCustomer(customer);
    }
  }, 15000);
});

describe('DEFECT-03: activateFlow guards on the referenced promotion\'s approval', () => {
  test('rejects activation while the referenced promotion has no approved entry node', async () => {
    const promotion = await Promotion.create({ name: '__test_activate_promo_unapproved__', scope: 'products', customerType: 'cash' });
    const flow = await Flow.create({ name: '__test_activate_promo_flow__', triggerType: 'inactive_customer', inactivityDays: 60, promotionId: promotion._id });
    try {
      await expect(ops.activateFlow({ id: flow._id })).rejects.toThrow('approved custom message');
    } finally {
      await Flow.findByIdAndDelete(flow._id);
      await Promotion.findByIdAndDelete(promotion._id);
    }
  });

  test('allows activation once the referenced promotion has an approved entry node', async () => {
    const promotion = await Promotion.create({ name: '__test_activate_promo_approved__', scope: 'products', customerType: 'cash' });
    const node = await MessageNode.create({ ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Hi!', templateStatus: 'approved' });
    await Promotion.findByIdAndUpdate(promotion._id, { entryNodeId: node._id });
    const flow = await Flow.create({ name: '__test_activate_promo_flow_2__', triggerType: 'inactive_customer', inactivityDays: 60, promotionId: promotion._id });
    try {
      const activated = await ops.activateFlow({ id: flow._id });
      expect(activated.status).toBe('active');
    } finally {
      await Flow.findByIdAndDelete(flow._id);
      await MessageNode.findByIdAndDelete(node._id);
      await Promotion.findByIdAndDelete(promotion._id);
    }
  });
});

describe('DEFECT-03 §8.3: requiresPriorFlowId cascade exclusion', () => {
  let priorFlow, cascadeFlow, customer;

  beforeAll(async () => {
    await connectOnce();
    priorFlow = await Flow.create({ name: '__test_cascade_prior_flow__', triggerType: 'inactive_customer', inactivityDays: 30 });
    customer = await Customer.create({ firstname: '__test_cascade_customer__', lastname: 'Test', phone: '15559104' });
    await Order.create({ customer: customer._id, subtotal: 10, total: 10, status: 'delivered', createdAt: new Date(Date.now() - 70 * DAYS) });
  });

  afterAll(async () => {
    await CampaignMessage.deleteMany({ customer: customer._id });
    await FlowEnrollment.deleteMany({ customer: customer._id });
    await Order.deleteMany({ customer: customer._id });
    await Customer.findByIdAndDelete(customer._id);
    await Flow.findByIdAndDelete(priorFlow._id);
  });

  test('a customer never enrolled in the prior-stage flow is not eligible for the escalation flow', async () => {
    cascadeFlow = await Flow.create({ name: '__test_cascade_flow_1__', triggerType: 'inactive_customer', inactivityDays: 60, requiresPriorFlowId: priorFlow._id });
    try {
      await scheduler.enrollEligibleCustomers(cascadeFlow);
      const count = await FlowEnrollment.countDocuments({ flow: cascadeFlow._id, customer: customer._id });
      expect(count).toBe(0);
    } finally {
      await FlowEnrollment.deleteMany({ flow: cascadeFlow._id });
      await Flow.findByIdAndDelete(cascadeFlow._id);
    }
  });

  test('a customer messaged (not completed) by the prior-stage flow becomes eligible for the escalation flow', async () => {
    await FlowEnrollment.create({ flow: priorFlow._id, customer: customer._id, state: 'messaged', messagedAt: new Date() });
    cascadeFlow = await Flow.create({ name: '__test_cascade_flow_2__', triggerType: 'inactive_customer', inactivityDays: 60, requiresPriorFlowId: priorFlow._id });
    try {
      await scheduler.enrollEligibleCustomers(cascadeFlow);
      const count = await FlowEnrollment.countDocuments({ flow: cascadeFlow._id, customer: customer._id });
      expect(count).toBe(1);
    } finally {
      await FlowEnrollment.deleteMany({ flow: cascadeFlow._id });
      await Flow.findByIdAndDelete(cascadeFlow._id);
    }
  });

  test('a customer who completed (converted) the prior-stage flow is not eligible for the escalation', async () => {
    await FlowEnrollment.findOneAndUpdate({ flow: priorFlow._id, customer: customer._id }, { state: 'completed' });
    cascadeFlow = await Flow.create({ name: '__test_cascade_flow_3__', triggerType: 'inactive_customer', inactivityDays: 60, requiresPriorFlowId: priorFlow._id });
    try {
      await scheduler.enrollEligibleCustomers(cascadeFlow);
      const count = await FlowEnrollment.countDocuments({ flow: cascadeFlow._id, customer: customer._id });
      expect(count).toBe(0);
    } finally {
      await FlowEnrollment.deleteMany({ flow: cascadeFlow._id });
      await Flow.findByIdAndDelete(cascadeFlow._id);
    }
  });
});

describe('getFlowPresets', () => {
  test('returns the §9 catalog with buildable flagged correctly', () => {
    const presets = ops.getFlowPresets();
    expect(presets.length).toBe(15);
    const a1 = presets.find(p => p.id === 'A1');
    expect(a1.buildable).toBe(true);
    expect(a1.category).toBe('repeat_business');
    const a4 = presets.find(p => p.id === 'A4');
    expect(a4.buildable).toBe(false); // no order_count=1-exactly + days_since_first_order trigger exists
    const c1 = presets.find(p => p.id === 'C1');
    expect(c1.buildable).toBe(true);
  });
});
