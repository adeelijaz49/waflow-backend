require('dotenv').config();
const request = require('supertest');

const { connectOnce } = require('./dbSetup');
const app = require('../server');
const scheduler = require('../utils/flowScheduler');
const ops = require('../shared/operations');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Flow = require('../models/Flow');
const FlowEnrollment = require('../models/FlowEnrollment');
const CampaignMessage = require('../models/CampaignMessage');
const MessageNode = require('../models/MessageNode');
const { WINBACK_TEMPLATE } = require('../utils/whatsapp');

const DAYS = 24 * 60 * 60 * 1000;

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitUntil(checkFn, { timeout = 4000, interval = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await checkFn();
    if (result) return result;
    await wait(interval);
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

async function makeStaleCustomer(phoneSuffix) {
  const customer = await Customer.create({ firstname: '__test_branch_customer__', lastname: 'Test', phone: `1555700${phoneSuffix}` });
  await Order.create({ customer: customer._id, subtotal: 10, total: 10, status: 'delivered', createdAt: new Date(Date.now() - 70 * DAYS) });
  return customer;
}

async function cleanupCustomer(customer) {
  await CampaignMessage.deleteMany({ customer: customer._id });
  await FlowEnrollment.deleteMany({ customer: customer._id });
  await Order.deleteMany({ customer: customer._id });
  await Customer.findByIdAndDelete(customer._id);
}

describe('flow branching: entry send (entryNodeId)', () => {
  let flow;

  beforeAll(async () => {
    await connectOnce();
    flow = await Flow.create({ name: '__test_branch_entry_flow__', triggerType: 'inactive_customer', inactivityDays: 60, templateName: WINBACK_TEMPLATE, status: 'active' });
  }, 15000);

  afterAll(async () => { await Flow.findByIdAndDelete(flow._id); });

  test('a flow with no entryNodeId sends its fixed default exactly as before', async () => {
    const customer = await makeStaleCustomer('01');
    try {
      const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'enrolled' });
      await scheduler.processEnrollment(flow, enrollment);

      const cm = await CampaignMessage.findOne({ flowEnrollment: enrollment._id });
      expect(cm).toBeTruthy();
      expect(cm.templateName).toBe(WINBACK_TEMPLATE);
      expect(cm.messageNode).toBeFalsy();
    } finally {
      await cleanupCustomer(customer);
    }
  }, 15000);

  test('a flow with an approved entryNodeId sends the custom template instead', async () => {
    const customer = await makeStaleCustomer('02');
    const node = await MessageNode.create({
      ownerType: 'flow', ownerId: flow._id, isEntryNode: true, bodyText: 'Hi {{1}}, custom message!',
      templateName: 'waflow_flow_test_custom', templateStatus: 'approved',
      buttons: [{ position: 0, label: 'End', nextAction: { type: 'end_flow' } }],
    });
    // findByIdAndUpdate returns the updated doc — processEnrollment must see the
    // fresh entryNodeId, not the stale in-memory `flow` captured in beforeAll.
    const freshFlow = await Flow.findByIdAndUpdate(flow._id, { entryNodeId: node._id }, { new: true });
    try {
      const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'enrolled' });
      await scheduler.processEnrollment(freshFlow, enrollment);

      const cm = await CampaignMessage.findOne({ flowEnrollment: enrollment._id });
      expect(cm).toBeTruthy();
      expect(cm.templateName).toBe('waflow_flow_test_custom');
      expect(cm.messageNode.toString()).toBe(node._id.toString());
      // status may be 'failed' — this template isn't actually approved on Meta's
      // side (no real template was submitted) — what's under test here is
      // routing, not delivery, matching this codebase's established no-mocking
      // pattern for WhatsApp sends (real calls tolerated to fail).
    } finally {
      await Flow.findByIdAndUpdate(flow._id, { $unset: { entryNodeId: 1 } });
      await MessageNode.findByIdAndDelete(node._id);
      await cleanupCustomer(customer);
    }
  }, 15000);

  test('a flow with an unapproved entryNodeId falls back to the fixed default', async () => {
    const customer = await makeStaleCustomer('03');
    const node = await MessageNode.create({
      ownerType: 'flow', ownerId: flow._id, isEntryNode: true, bodyText: 'Hi {{1}}!',
      templateStatus: 'pending', buttons: [],
    });
    const freshFlow = await Flow.findByIdAndUpdate(flow._id, { entryNodeId: node._id }, { new: true });
    try {
      const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'enrolled' });
      await scheduler.processEnrollment(freshFlow, enrollment);

      const cm = await CampaignMessage.findOne({ flowEnrollment: enrollment._id });
      expect(cm.templateName).toBe(WINBACK_TEMPLATE); // fixed default, not the unapproved custom one
      expect(cm.messageNode).toBeFalsy();
    } finally {
      await Flow.findByIdAndUpdate(flow._id, { $unset: { entryNodeId: 1 } });
      await MessageNode.findByIdAndDelete(node._id);
      await cleanupCustomer(customer);
    }
  }, 15000);
});

describe('flow branching: activateFlow template-approval guard', () => {
  let flow, node;

  beforeAll(async () => {
    await connectOnce();
    flow = await Flow.create({ name: '__test_branch_activate_flow__', triggerType: 'inactive_customer', inactivityDays: 60, templateName: WINBACK_TEMPLATE });
    node = await MessageNode.create({ ownerType: 'flow', ownerId: flow._id, isEntryNode: true, bodyText: 'Hi!', templateStatus: 'pending' });
    await Flow.findByIdAndUpdate(flow._id, { entryNodeId: node._id });
  }, 15000);

  afterAll(async () => {
    await MessageNode.findByIdAndDelete(node._id);
    await Flow.findByIdAndDelete(flow._id);
  });

  test('rejects activation while the entry node template is unapproved', async () => {
    await expect(ops.activateFlow({ id: flow._id })).rejects.toThrow('approved WhatsApp template');
  });

  test('allows activation once the template is approved', async () => {
    await MessageNode.findByIdAndUpdate(node._id, { templateStatus: 'approved' });
    const activated = await ops.activateFlow({ id: flow._id });
    expect(activated.status).toBe('active');
  });
});

describe('flow branching: webhook button-tap routing', () => {
  let customer, entryNode, targetA, targetB;

  beforeAll(async () => {
    await connectOnce();
    customer = await Customer.create({ firstname: '__test_branch_tap_customer__', lastname: 'Test', phone: '15557099' });
    targetA = await MessageNode.create({ ownerType: 'flow', ownerId: customer._id, bodyText: 'Follow-up A for {{1}}', buttons: [] });
    targetB = await MessageNode.create({ ownerType: 'flow', ownerId: customer._id, bodyText: 'Follow-up B for {{1}}', buttons: [] });
    entryNode = await MessageNode.create({
      ownerType: 'flow', ownerId: customer._id, isEntryNode: true, bodyText: 'Pick one, {{1}}',
      buttons: [
        { position: 0, label: 'Option A', nextAction: { type: 'send_message', targetNodeId: targetA._id } },
        { position: 1, label: 'Option B', nextAction: { type: 'send_message', targetNodeId: targetB._id } },
      ],
    });
  }, 15000);

  afterAll(async () => {
    await MessageNode.deleteMany({ _id: { $in: [entryNode._id, targetA._id, targetB._id] } });
    await CampaignMessage.deleteMany({ customer: customer._id });
    await FlowEnrollment.deleteMany({ customer: customer._id });
    await Customer.findByIdAndDelete(customer._id);
  });

  function tapButton(wamid, nodeId, position) {
    return request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        messages: [{
          from: customer.phone, type: 'interactive', context: { id: wamid },
          interactive: { type: 'button_reply', button_reply: { id: `msgnode_${nodeId}_${position}` } },
        }],
      } }] }],
    });
  }

  function makeSentCampaignMessage(wamid) {
    return CampaignMessage.create({
      kind: 'flow', customer: customer._id, phone: customer.phone,
      wamid, messageType: 'template', messageNode: entryNode._id,
      status: 'sent', sentAt: new Date(),
    });
  }

  test('tapping a button sends the correctly-mapped follow-up', async () => {
    const testStart = new Date();
    const cm = await makeSentCampaignMessage('wamid.BRANCH_A');
    await tapButton('wamid.BRANCH_A', entryNode._id, 0);

    const updated = await waitUntil(async () => {
      const doc = await CampaignMessage.findById(cm._id);
      return doc.respondedAt ? doc : null;
    });
    expect(updated.clickedButtonPosition).toBe(0);

    const followUp = await waitUntil(() => CampaignMessage.findOne({ messageNode: targetA._id, customer: customer._id, createdAt: { $gte: testStart } }));
    expect(followUp).toBeTruthy();
  }, 15000);

  test('a second tap on an already-responded message does not fire another action', async () => {
    const testStart = new Date();
    const cm = await makeSentCampaignMessage('wamid.BRANCH_IDEMPOTENT');
    await tapButton('wamid.BRANCH_IDEMPOTENT', entryNode._id, 0);
    // Wait for the first tap's action to fully land (not just respondedAt) —
    // this drains its real WhatsApp send attempt so nothing from it can bleed
    // into this test's own count below, or leak into the next test.
    await waitUntil(() => CampaignMessage.findOne({ messageNode: { $in: [targetA._id, targetB._id] }, customer: customer._id, createdAt: { $gte: testStart } }));

    await tapButton('wamid.BRANCH_IDEMPOTENT', entryNode._id, 1); // different button, same already-claimed message
    await wait(500); // the second tap short-circuits synchronously at the claim check — no external call to wait on

    const followUpCount = await CampaignMessage.countDocuments({
      customer: customer._id, messageNode: { $in: [targetA._id, targetB._id] }, createdAt: { $gte: testStart },
    });
    expect(followUpCount).toBe(1); // only the first tap's action fired
    const unchanged = await CampaignMessage.findById(cm._id);
    expect(unchanged.clickedButtonPosition).toBe(0); // not overwritten by the second tap
  }, 15000);

  test('two different buttons tapped concurrently on the same message: exactly one next_action fires', async () => {
    const testStart = new Date();
    const cm = await makeSentCampaignMessage('wamid.BRANCH_RACE');
    await Promise.all([
      tapButton('wamid.BRANCH_RACE', entryNode._id, 0),
      tapButton('wamid.BRANCH_RACE', entryNode._id, 1),
    ]);

    // Wait for the winning tap's action to fully land before asserting/finishing
    // — draining this fully (not a fixed sleep) is what keeps this test's async
    // work from bleeding into the next one.
    await waitUntil(() => CampaignMessage.findOne({ messageNode: { $in: [targetA._id, targetB._id] }, customer: customer._id, createdAt: { $gte: testStart } }));
    await wait(500); // extra margin in case the losing tap somehow also reached a send attempt

    const totalFollowUps = await CampaignMessage.countDocuments({
      customer: customer._id, messageNode: { $in: [targetA._id, targetB._id] }, createdAt: { $gte: testStart },
    });
    expect(totalFollowUps).toBe(1); // exactly one next_action fired, not both
  }, 15000);

  test('opted-out customer does not receive a follow-up', async () => {
    const testStart = new Date();
    await Customer.findByIdAndUpdate(customer._id, { optedOut: true });
    const cm = await makeSentCampaignMessage('wamid.BRANCH_OPTOUT');
    try {
      await tapButton('wamid.BRANCH_OPTOUT', entryNode._id, 0);
      await waitUntil(async () => {
        const doc = await CampaignMessage.findById(cm._id);
        return doc.respondedAt ? doc : null; // the claim itself still succeeds — opt-out is checked after
      });
      // optedOut short-circuits before any external call, so this settles fast —
      // no lingering send from THIS test to worry about. Prior tests' sends are
      // now guaranteed drained (see the waitUntil additions above), so nothing
      // stale can land in this test's createdAt window either.
      await wait(500);

      const followUpCount = await CampaignMessage.countDocuments({
        customer: customer._id, messageNode: { $in: [targetA._id, targetB._id] }, createdAt: { $gte: testStart },
      });
      expect(followUpCount).toBe(0);
    } finally {
      await Customer.findByIdAndUpdate(customer._id, { optedOut: false });
    }
  }, 15000);

  test('tapping end_flow marks the FlowEnrollment completed', async () => {
    const flow = await Flow.create({ name: '__test_branch_endflow_flow__', triggerType: 'inactive_customer', inactivityDays: 60, templateName: WINBACK_TEMPLATE });
    const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'messaged', messagedAt: new Date() });
    const endNode = await MessageNode.create({
      ownerType: 'flow', ownerId: flow._id, isEntryNode: true, bodyText: 'Bye {{1}}',
      buttons: [{ position: 0, label: 'Done', nextAction: { type: 'end_flow' } }],
    });
    await CampaignMessage.create({
      kind: 'flow', flow: flow._id, flowEnrollment: enrollment._id, customer: customer._id, phone: customer.phone,
      wamid: 'wamid.BRANCH_END', messageType: 'template', messageNode: endNode._id, status: 'sent', sentAt: new Date(),
    });
    try {
      await tapButton('wamid.BRANCH_END', endNode._id, 0);
      const updated = await waitUntil(async () => {
        const doc = await FlowEnrollment.findById(enrollment._id);
        return doc.state === 'completed' ? doc : null;
      });
      expect(updated.state).toBe('completed');
    } finally {
      await CampaignMessage.deleteMany({ flowEnrollment: enrollment._id });
      await FlowEnrollment.findByIdAndDelete(enrollment._id);
      await MessageNode.findByIdAndDelete(endNode._id);
      await Flow.findByIdAndDelete(flow._id);
    }
  }, 15000);
});
