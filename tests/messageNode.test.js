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

// The first message of a promotion is a WhatsApp template (button text up to 25 characters); every follow-up is an interactive
// message (20). Opt in / Opt out / Interested exist on the first message of a PROMOTION only. (No rows are created here:
// rejected creates write nothing, accepted ones are checked through the validator.)
describe('button limits and consent actions', () => {
  const { Types } = require('mongoose');
  const btn = (label, type = 'end_flow', extra = {}) => ({ position: 0, label, nextAction: { type, ...extra } });
  const L20 = 'A'.repeat(20); const L21 = 'A'.repeat(21); const L25 = 'B'.repeat(25); const L26 = 'B'.repeat(26);

  test('a follow-up message allows 20 characters and refuses 21', () => {
    expect(() => ops.validateButtons([btn(L20)])).not.toThrow();
    expect(() => ops.validateButtons([btn(L21)])).toThrow('exceeds 20 characters');
  });

  test('an entry message allows 25 characters and refuses 26', () => {
    expect(() => ops.validateButtons([btn(L25)], { isEntryNode: true })).not.toThrow();
    expect(() => ops.validateButtons([btn(L26)], { isEntryNode: true })).toThrow('exceeds 25 characters');
  });

  test('createMessageNode applies the right limit for an entry message and a follow-up', async () => {
    const ownerId = new Types.ObjectId();
    await expect(ops.createMessageNode({ ownerType: 'promotion', ownerId, isEntryNode: true, bodyText: 'Hi', buttons: [btn(L26)] }))
      .rejects.toThrow('exceeds 25 characters');
    await expect(ops.createMessageNode({ ownerType: 'promotion', ownerId, isEntryNode: false, depth: 1, bodyText: 'Hi', buttons: [btn(L21)] }))
      .rejects.toThrow('exceeds 20 characters');
  });

  test('the consent actions are refused on a follow-up and on a flow message, allowed on a promotion entry message', async () => {
    for (const type of ['opt_in', 'opt_out', 'interested']) {
      expect(() => ops.validateButtons([btn('Yes', type)], { isEntryNode: false, ownerType: 'promotion' })).toThrow('first message of a promotion');
      expect(() => ops.validateButtons([btn('Yes', type)], { isEntryNode: true, ownerType: 'flow' })).toThrow('first message of a promotion');
      expect(() => ops.validateButtons([btn('Yes', type)], { isEntryNode: true, ownerType: 'promotion' })).not.toThrow();
    }
    await expect(ops.createMessageNode({ ownerType: 'promotion', ownerId: new Types.ObjectId(), isEntryNode: false, depth: 1, bodyText: 'Hi', buttons: [btn('Yes', 'opt_in')] }))
      .rejects.toThrow('first message of a promotion');
  });

  test('a reply text over 1000 characters is refused', () => {
    expect(() => ops.validateButtons([btn('Yes', 'opt_in', { replyText: 'x'.repeat(1001) })], { isEntryNode: true, ownerType: 'promotion' })).toThrow('at most 1000');
    expect(() => ops.validateButtons([btn('Yes', 'opt_in', { replyText: 'x'.repeat(1000) })], { isEntryNode: true, ownerType: 'promotion' })).not.toThrow();
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
