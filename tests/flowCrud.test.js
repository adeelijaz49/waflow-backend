require('dotenv').config();
const mongoose = require('mongoose');

const { connectOnce } = require('./dbSetup');
const ops = require('../shared/operations');
const Customer = require('../models/Customer');
const Flow = require('../models/Flow');
const FlowEnrollment = require('../models/FlowEnrollment');
const CampaignMessage = require('../models/CampaignMessage');
const MessageNode = require('../models/MessageNode');
const { WINBACK_TEMPLATE, POST_PURCHASE_TEMPLATE } = require('../utils/whatsapp');

const TEST_PHONE = '15550006666';

describe('Flow CRUD', () => {
  let flow;

  beforeAll(async () => {
    await connectOnce();
  }, 15000);

  afterEach(async () => {
    if (flow) { await Flow.findByIdAndDelete(flow._id); flow = null; }
  });

  test('createFlow applies per-triggerType defaults', async () => {
    flow = await ops.createFlow({ name: '__test_flow_defaults__', triggerType: 'inactive_customer' });
    expect(flow.inactivityDays).toBe(60);
    expect(flow.templateName).toBe(WINBACK_TEMPLATE);
    expect(flow.status).toBe('paused'); // safe by default
  });

  test('createFlow lets an explicit inactivityDays override the default', async () => {
    flow = await ops.createFlow({ name: '__test_flow_override__', triggerType: 'inactive_customer', inactivityDays: 30 });
    expect(flow.inactivityDays).toBe(30);
  });

  test('createFlow rejects an unsupported triggerType', async () => {
    await expect(ops.createFlow({ name: '__test_flow_bad__', triggerType: 'not_a_real_type' }))
      .rejects.toThrow('Unknown or not-yet-supported triggerType');
  });

  test('activateFlow / pauseFlow toggle status', async () => {
    flow = await ops.createFlow({ name: '__test_flow_toggle__', triggerType: 'inactive_customer' });
    const active = await ops.activateFlow({ id: flow._id });
    expect(active.status).toBe('active');
    const paused = await ops.pauseFlow({ id: flow._id });
    expect(paused.status).toBe('paused');
  });

  test('updateFlow updates config but ignores triggerType/templateName changes', async () => {
    flow = await ops.createFlow({ name: '__test_flow_update__', triggerType: 'inactive_customer' });
    const updated = await ops.updateFlow({
      id: flow._id, name: '__test_flow_renamed__', inactivityDays: 45,
      triggerType: 'booking_no_show', templateName: 'something_else',
    });
    expect(updated.name).toBe('__test_flow_renamed__');
    expect(updated.inactivityDays).toBe(45);
    expect(updated.triggerType).toBe('inactive_customer'); // unchanged
    expect(updated.templateName).toBe(WINBACK_TEMPLATE); // unchanged
  });

  test('listFlows filters by status', async () => {
    flow = await ops.createFlow({ name: '__test_flow_list__', triggerType: 'inactive_customer' });
    await ops.activateFlow({ id: flow._id });
    const active = await ops.listFlows({ status: 'active' });
    expect(active.some(f => f._id.toString() === flow._id.toString())).toBe(true);
    const paused = await ops.listFlows({ status: 'paused' });
    expect(paused.some(f => f._id.toString() === flow._id.toString())).toBe(false);
  });

  test('deleteFlow removes it', async () => {
    const f = await ops.createFlow({ name: '__test_flow_delete__', triggerType: 'inactive_customer' });
    await ops.deleteFlow({ id: f._id });
    await expect(ops.getFlow({ id: f._id })).rejects.toThrow('Flow not found');
  });
});

describe('previewFlowMessage', () => {
  test('substitutes sample values into the real template body per triggerType', async () => {
    const preview = await ops.previewFlowMessage({ triggerType: 'post_purchase_points' });
    expect(preview.messageType).toBe('template');
    expect(preview.templateName).toBe(POST_PURCHASE_TEMPLATE);
    expect(preview.body).not.toMatch(/\{\{\d\}\}/); // no leftover placeholders
    expect(preview.body).toContain('Alex');
    expect(preview.body).toContain('250 loyalty points');
    expect(preview.buttonLabel).toBe('Shop Now');
  });

  test('booking_no_show gets its own button label and substituted service name', async () => {
    const preview = await ops.previewFlowMessage({ triggerType: 'booking_no_show' });
    expect(preview.body).toContain('Haircut');
    expect(preview.buttonLabel).toBe('Rebook Free');
  });

  test('rejects an unsupported triggerType', async () => {
    await expect(ops.previewFlowMessage({ triggerType: 'not_a_real_type' }))
      .rejects.toThrow('Unknown or not-yet-supported triggerType');
  });
});

describe('getFlowReport', () => {
  let flow, customer;

  beforeAll(async () => {
    await connectOnce();
    flow = await Flow.create({ name: '__test_flow_report__', triggerType: 'inactive_customer', inactivityDays: 60, templateName: WINBACK_TEMPLATE });
    customer = await Customer.create({ firstname: 'FlowReport', lastname: 'Test', phone: TEST_PHONE });
  }, 15000);

  afterAll(async () => {
    await CampaignMessage.deleteMany({ flow: flow._id });
    await FlowEnrollment.deleteMany({ flow: flow._id });
    await Flow.findByIdAndDelete(flow._id);
    await Customer.findByIdAndDelete(customer._id);
  });

  // Same regression this codebase already fixed for getCampaignReport: a
  // genuinely missing field is a distinct BSON type from null in aggregation
  // expressions, so $ne incorrectly counts every never-clicked/ordered
  // message. getFlowReport must use the same $gt idiom.
  test('a message with clickedAt/order left unset does not count as clicked/ordered', async () => {
    await CampaignMessage.create({
      kind: 'flow', flow: flow._id, customer: customer._id, phone: TEST_PHONE,
      wamid: 'wamid.FLOW_NOCLICK', messageType: 'template', templateName: WINBACK_TEMPLATE,
      status: 'sent', sentAt: new Date(),
    });

    const report = await ops.getFlowReport({ flowId: flow._id });
    expect(report.messagesSent).toBe(1);
    expect(report.clicked).toBe(0);
    expect(report.ordersCreated).toBe(0);
  });

  test('a message with clickedAt and order explicitly set counts correctly', async () => {
    const fakeOrderId = new mongoose.Types.ObjectId();
    await CampaignMessage.create({
      kind: 'flow', flow: flow._id, customer: customer._id, phone: TEST_PHONE,
      wamid: 'wamid.FLOW_CLICKED', messageType: 'template', templateName: WINBACK_TEMPLATE,
      status: 'delivered', sentAt: new Date(), clickedAt: new Date(), order: fakeOrderId, revenue: 42, pointsIssued: 10,
    });

    const report = await ops.getFlowReport({ flowId: flow._id });
    expect(report.clicked).toBe(1);
    expect(report.ordersCreated).toBe(1);
    expect(report.revenue).toBeCloseTo(42);
    expect(report.pointsIssued).toBe(10);
  });

  test('enrollment state counts reflect FlowEnrollment documents', async () => {
    await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'exited', exitedAt: new Date(), exitReason: 'reordered' });
    const report = await ops.getFlowReport({ flowId: flow._id });
    expect(report.exited).toBe(1);
  });
});

describe('listFlowEnrollments: tappedButtonLabel (Phase 5 reporting touch-up)', () => {
  let flow, customer, node;

  beforeAll(async () => {
    await connectOnce();
    flow = await Flow.create({ name: '__test_enrollments_tap_flow__', triggerType: 'inactive_customer', inactivityDays: 60, templateName: WINBACK_TEMPLATE });
    node = await MessageNode.create({
      ownerType: 'flow', ownerId: flow._id, isEntryNode: true, bodyText: 'Hi {{1}}',
      buttons: [{ position: 0, label: 'Shop Now', nextAction: { type: 'end_flow' } }],
    });
  }, 15000);

  afterAll(async () => {
    await CampaignMessage.deleteMany({ flow: flow._id });
    await FlowEnrollment.deleteMany({ flow: flow._id });
    await MessageNode.findByIdAndDelete(node._id);
    await Flow.findByIdAndDelete(flow._id);
  });

  afterEach(async () => {
    if (customer) { await Customer.findByIdAndDelete(customer._id); customer = null; }
  });

  test('resolves the tapped button label when a response was recorded', async () => {
    customer = await Customer.create({ firstname: '__test_enrollments_tap_customer__', lastname: 'Test', phone: '15559299' });
    const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'messaged', messagedAt: new Date() });
    await CampaignMessage.create({
      kind: 'flow', flow: flow._id, flowEnrollment: enrollment._id, customer: customer._id, phone: customer.phone,
      wamid: 'wamid.ENROLL_TAP', messageType: 'template', messageNode: node._id,
      status: 'sent', sentAt: new Date(), respondedAt: new Date(), clickedButtonPosition: 0,
    });

    const { enrollments } = await ops.listFlowEnrollments({ flowId: flow._id });
    const found = enrollments.find(e => e._id.toString() === enrollment._id.toString());
    expect(found.tappedButtonLabel).toBe('Shop Now');
  }, 15000);

  test('is null when no response has been recorded yet', async () => {
    customer = await Customer.create({ firstname: '__test_enrollments_notap_customer__', lastname: 'Test', phone: '15559298' });
    const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'messaged', messagedAt: new Date() });
    await CampaignMessage.create({
      kind: 'flow', flow: flow._id, flowEnrollment: enrollment._id, customer: customer._id, phone: customer.phone,
      wamid: 'wamid.ENROLL_NOTAP', messageType: 'template', messageNode: node._id,
      status: 'sent', sentAt: new Date(),
    });

    const { enrollments } = await ops.listFlowEnrollments({ flowId: flow._id });
    const found = enrollments.find(e => e._id.toString() === enrollment._id.toString());
    expect(found.tappedButtonLabel).toBeNull();
  }, 15000);
});
