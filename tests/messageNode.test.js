require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const ops = require('../shared/operations');
const Flow = require('../models/Flow');
const MessageNode = require('../models/MessageNode');
const { WINBACK_TEMPLATE } = require('../utils/whatsapp');

describe('MessageNode CRUD + validation', () => {
  let flow;

  beforeAll(async () => {
    await connectOnce();
    flow = await Flow.create({ name: '__test_msgnode_flow__', triggerType: 'inactive_customer', inactivityDays: 60, templateName: WINBACK_TEMPLATE });
  }, 15000);

  afterAll(async () => {
    await MessageNode.deleteMany({ ownerId: flow._id });
    await Flow.findByIdAndDelete(flow._id);
  });

  test('createMessageNode creates an entry node with buttons', async () => {
    const node = await ops.createMessageNode({
      ownerId: flow._id, isEntryNode: true, bodyText: 'Hi {{1}}!',
      buttons: [{ position: 0, label: 'Shop Now', nextAction: { type: 'end_flow' } }],
    });
    try {
      expect(node.ownerType).toBe('flow');
      expect(node.isEntryNode).toBe(true);
      expect(node.templateStatus).toBe('not_created');
      expect(node.buttons).toHaveLength(1);
      expect(node.buttons[0].nextAction.type).toBe('end_flow');
    } finally {
      await MessageNode.findByIdAndDelete(node._id);
    }
  });

  test('rejects more than 3 buttons', async () => {
    await expect(ops.createMessageNode({
      ownerId: flow._id, bodyText: 'Hi',
      buttons: [0, 1, 2, 3].map(position => ({ position, label: `B${position}`, nextAction: { type: 'end_flow' } })),
    })).rejects.toThrow('at most 3 buttons');
  });

  test('rejects a button label over 20 characters', async () => {
    await expect(ops.createMessageNode({
      ownerId: flow._id, bodyText: 'Hi',
      buttons: [{ position: 0, label: 'This label is way too long', nextAction: { type: 'end_flow' } }],
    })).rejects.toThrow('exceeds 20 characters');
  });

  test('rejects depth over the branch cap', async () => {
    await expect(ops.createMessageNode({ ownerId: flow._id, bodyText: 'Hi', depth: 4 }))
      .rejects.toThrow('branch');
  });

  test('updateMessageNode updates body text and buttons', async () => {
    const node = await ops.createMessageNode({ ownerId: flow._id, bodyText: 'Original', buttons: [] });
    try {
      const updated = await ops.updateMessageNode({
        id: node._id, bodyText: 'Updated',
        buttons: [{ position: 0, label: 'Go', nextAction: { type: 'end_flow' } }],
      });
      expect(updated.bodyText).toBe('Updated');
      expect(updated.buttons).toHaveLength(1);
    } finally {
      await MessageNode.findByIdAndDelete(node._id);
    }
  });

  test('updateMessageNode rejects an over-limit button set on an existing node', async () => {
    const node = await ops.createMessageNode({ ownerId: flow._id, bodyText: 'Hi', buttons: [] });
    try {
      await expect(ops.updateMessageNode({
        id: node._id,
        buttons: [0, 1, 2, 3].map(position => ({ position, label: `B${position}`, nextAction: { type: 'end_flow' } })),
      })).rejects.toThrow('at most 3 buttons');
    } finally {
      await MessageNode.findByIdAndDelete(node._id);
    }
  });

  test('deleteMessageNode removes it', async () => {
    const node = await ops.createMessageNode({ ownerId: flow._id, bodyText: 'To delete' });
    await ops.deleteMessageNode({ id: node._id });
    await expect(ops.getMessageNode({ id: node._id })).rejects.toThrow('MessageNode not found');
  });
});

describe('getFlowMessageVariables', () => {
  test('returns the right variables per triggerType, customerName always slot 1', async () => {
    const winback = await ops.getFlowMessageVariables({ triggerType: 'inactive_customer' });
    expect(winback).toEqual([{ key: 'customerName', label: 'Customer Name', slot: 1 }]);

    const noShow = await ops.getFlowMessageVariables({ triggerType: 'booking_no_show' });
    expect(noShow.map(v => v.key)).toEqual(['customerName', 'serviceName']);
    expect(noShow[0].slot).toBe(1);
  });

  test('returns an empty array for an unknown triggerType', async () => {
    const result = await ops.getFlowMessageVariables({ triggerType: 'not_a_real_type' });
    expect(result).toEqual([]);
  });
});
