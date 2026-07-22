require('dotenv').config();
const request = require('supertest');

const { connectOnce } = require('./dbSetup');
const app = require('../server');
const ops = require('../shared/operations');
const Customer = require('../models/Customer');
const Flow = require('../models/Flow');
const CampaignMessage = require('../models/CampaignMessage');
const MessageNode = require('../models/MessageNode');
const { WINBACK_TEMPLATE } = require('../utils/whatsapp');

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

describe('MessageNode tree lifecycle', () => {
  let flow;

  beforeAll(async () => {
    await connectOnce();
    flow = await Flow.create({ name: '__test_tree_flow__', triggerType: 'inactive_customer', inactivityDays: 60, templateName: WINBACK_TEMPLATE });
  }, 15000);

  afterAll(async () => {
    await MessageNode.deleteMany({ ownerId: flow._id });
    await Flow.findByIdAndDelete(flow._id);
  });

  test('a button cannot target a node already targeted by another button (tree-only)', async () => {
    const shared = await ops.createMessageNode({ ownerId: flow._id, bodyText: 'Shared target', depth: 1 });
    const nodeA = await ops.createMessageNode({
      ownerId: flow._id, bodyText: 'A', depth: 0,
      buttons: [{ position: 0, label: 'Go', nextAction: { type: 'send_message', targetNodeId: shared._id } }],
    });
    try {
      await expect(ops.createMessageNode({
        ownerId: flow._id, bodyText: 'B', depth: 0,
        buttons: [{ position: 0, label: 'Also go', nextAction: { type: 'send_message', targetNodeId: shared._id } }],
      })).rejects.toThrow('already linked from another button');
    } finally {
      await MessageNode.findByIdAndDelete(nodeA._id);
      await MessageNode.findByIdAndDelete(shared._id);
    }
  }, 15000);

  test('retargeting a button cascade-deletes its old target subtree', async () => {
    const oldTarget = await ops.createMessageNode({ ownerId: flow._id, bodyText: 'Old target', depth: 1 });
    const grandchild = await ops.createMessageNode({ ownerId: flow._id, bodyText: 'Grandchild', depth: 2 });
    await ops.updateMessageNode({
      id: oldTarget._id, buttons: [{ position: 0, label: 'Deeper', nextAction: { type: 'send_message', targetNodeId: grandchild._id } }],
    });
    const parent = await ops.createMessageNode({
      ownerId: flow._id, bodyText: 'Parent', depth: 0,
      buttons: [{ position: 0, label: 'Go', nextAction: { type: 'send_message', targetNodeId: oldTarget._id } }],
    });

    const newTarget = await ops.createMessageNode({ ownerId: flow._id, bodyText: 'New target', depth: 1 });
    try {
      await ops.updateMessageNode({
        id: parent._id, buttons: [{ position: 0, label: 'Go', nextAction: { type: 'send_message', targetNodeId: newTarget._id } }],
      });

      // oldTarget and its grandchild are now orphaned (nothing else could
      // reference them per the tree-only constraint) — both should be gone.
      expect(await MessageNode.findById(oldTarget._id)).toBeNull();
      expect(await MessageNode.findById(grandchild._id)).toBeNull();
      expect(await MessageNode.findById(newTarget._id)).toBeTruthy();
    } finally {
      await MessageNode.findByIdAndDelete(parent._id);
      await MessageNode.findByIdAndDelete(newTarget._id);
    }
  }, 15000);

  test('deleting a flow cascade-deletes its entire MessageNode tree', async () => {
    const testFlow = await Flow.create({ name: '__test_tree_delete_flow__', triggerType: 'inactive_customer', inactivityDays: 60, templateName: WINBACK_TEMPLATE });
    const level2 = await ops.createMessageNode({ ownerId: testFlow._id, bodyText: 'Level 2', depth: 2 });
    const level1 = await ops.createMessageNode({
      ownerId: testFlow._id, bodyText: 'Level 1', depth: 1,
      buttons: [{ position: 0, label: 'Deeper', nextAction: { type: 'send_message', targetNodeId: level2._id } }],
    });
    const entry = await ops.createMessageNode({
      ownerId: testFlow._id, isEntryNode: true, bodyText: 'Entry', depth: 0, templateStatus: 'approved',
      buttons: [{ position: 0, label: 'Go', nextAction: { type: 'send_message', targetNodeId: level1._id } }],
    });
    await Flow.findByIdAndUpdate(testFlow._id, { entryNodeId: entry._id });

    await ops.deleteFlow({ id: testFlow._id });

    expect(await MessageNode.findById(entry._id)).toBeNull();
    expect(await MessageNode.findById(level1._id)).toBeNull();
    expect(await MessageNode.findById(level2._id)).toBeNull();
    expect(await Flow.findById(testFlow._id)).toBeNull();
  }, 15000);

  test('deleteMessageNode cascades to its own subtree', async () => {
    const child = await ops.createMessageNode({ ownerId: flow._id, bodyText: 'Child', depth: 1 });
    const parent = await ops.createMessageNode({
      ownerId: flow._id, bodyText: 'Parent', depth: 0,
      buttons: [{ position: 0, label: 'Go', nextAction: { type: 'send_message', targetNodeId: child._id } }],
    });
    await ops.deleteMessageNode({ id: parent._id });
    expect(await MessageNode.findById(parent._id)).toBeNull();
    expect(await MessageNode.findById(child._id)).toBeNull();
  }, 15000);
});

describe('multi-level branching: two-level tap-through', () => {
  let customer, level0, level1, level2;

  beforeAll(async () => {
    await connectOnce();
    customer = await Customer.create({ firstname: '__test_multilevel_customer__', lastname: 'Test', phone: '15559099' });
    level2 = await MessageNode.create({ ownerType: 'flow', ownerId: customer._id, bodyText: 'Level 2 message for {{1}}', depth: 2, buttons: [] });
    level1 = await MessageNode.create({
      ownerType: 'flow', ownerId: customer._id, bodyText: 'Level 1 message for {{1}}', depth: 1,
      buttons: [{ position: 0, label: 'Go Deeper', nextAction: { type: 'send_message', targetNodeId: level2._id } }],
    });
    level0 = await MessageNode.create({
      ownerType: 'flow', ownerId: customer._id, isEntryNode: true, bodyText: 'Entry for {{1}}', depth: 0,
      buttons: [{ position: 0, label: 'Start', nextAction: { type: 'send_message', targetNodeId: level1._id } }],
    });
  }, 15000);

  afterAll(async () => {
    await MessageNode.deleteMany({ _id: { $in: [level0._id, level1._id, level2._id] } });
    await CampaignMessage.deleteMany({ customer: customer._id });
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

  test('tapping through two levels sends level 1 then level 2', async () => {
    const testStart = new Date();
    const entrySend = await CampaignMessage.create({
      kind: 'flow', customer: customer._id, phone: customer.phone,
      wamid: 'wamid.MULTILEVEL_0', messageType: 'template', messageNode: level0._id, status: 'sent', sentAt: new Date(),
    });

    await tapButton('wamid.MULTILEVEL_0', level0._id, 0);
    const level1Send = await waitUntil(() => CampaignMessage.findOne({ messageNode: level1._id, customer: customer._id, createdAt: { $gte: testStart } }));
    expect(level1Send).toBeTruthy();

    // The real WhatsApp send attempted above has no guaranteed wamid (it's a
    // fake test phone number, so it very likely fails, same as every other
    // real send in this suite) — inject a synthetic one to simulate the
    // customer replying to it, matching how every other webhook test here
    // already does this rather than depending on real API delivery.
    await CampaignMessage.findByIdAndUpdate(level1Send._id, { wamid: 'wamid.MULTILEVEL_1' });
    await tapButton('wamid.MULTILEVEL_1', level1._id, 0);
    const level2Send = await waitUntil(() => CampaignMessage.findOne({ messageNode: level2._id, customer: customer._id, createdAt: { $gte: testStart } }));
    expect(level2Send).toBeTruthy();

    const updatedEntry = await CampaignMessage.findById(entrySend._id);
    expect(updatedEntry.clickedButtonPosition).toBe(0);
  }, 15000);
});
