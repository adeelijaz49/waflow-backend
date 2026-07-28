require('dotenv').config();
const request = require('supertest');

const { connectOnce } = require('./dbSetup');
const app = require('../server');
const ops = require('../shared/operations');
const Customer = require('../models/Customer');
const Promotion = require('../models/Promotion');
const CampaignMessage = require('../models/CampaignMessage');
const MessageNode = require('../models/MessageNode');

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

// DEFECT-02: the same MessageNode branching infrastructure Flows already had
// (see tests/flowBranching.test.js) is now also reachable from Promotions,
// via Promotion.entryNodeId — reusing the exact same tree/approval/webhook
// machinery rather than a second implementation.
describe('promotion branching: entry send (entryNodeId)', () => {
  let promotion, customer;

  beforeAll(async () => {
    await connectOnce();
    promotion = await Promotion.create({ name: '__test_promo_branch_entry__', scope: 'products', customerType: 'cash', type: 'store_wide', discountPercent: 10 });
    customer = await Customer.create({ firstname: '__test_promo_branch_customer__', lastname: 'Test', phone: '15558800' });
  }, 15000);

  afterAll(async () => {
    await CampaignMessage.deleteMany({ customer: customer._id });
    await Customer.findByIdAndDelete(customer._id);
    await Promotion.findByIdAndDelete(promotion._id);
  });

  test('a promotion with no entryNodeId sends its fixed default exactly as before', async () => {
    const res = await ops.sendPromotion({ promotionId: promotion._id, customerIds: [customer._id] });
    expect(res.sentCount + res.errors.length).toBe(1); // attempted a real send, whichever way it landed

    const cm = await CampaignMessage.findOne({ promotion: promotion._id, customer: customer._id }).sort({ createdAt: -1 });
    expect(cm.messageNode).toBeFalsy();
  });

  test('a promotion with an approved entryNodeId sends the custom template instead', async () => {
    const node = await MessageNode.create({
      ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Hi {{1}}, check out {{2}} for {{3}}! — {{4}}',
      templateName: 'waflow_promo_test_custom', templateStatus: 'approved',
      buttons: [{ position: 0, label: 'Shop', nextAction: { type: 'end_flow' } }],
    });
    await Promotion.findByIdAndUpdate(promotion._id, { entryNodeId: node._id });
    try {
      const res = await ops.sendPromotion({ promotionId: promotion._id, customerIds: [customer._id] });
      expect(res.sentCount + res.errors.length).toBe(1);

      const cm = await CampaignMessage.findOne({ promotion: promotion._id, customer: customer._id }).sort({ createdAt: -1 });
      expect(cm.templateName).toBe('waflow_promo_test_custom');
      expect(cm.messageNode.toString()).toBe(node._id.toString());
      // status may be 'failed' — this template isn't actually approved on Meta's
      // side (no real template was submitted) — matching flowBranching.test.js's
      // established no-mocking convention: routing is under test, not delivery.
    } finally {
      await Promotion.findByIdAndUpdate(promotion._id, { $unset: { entryNodeId: 1 } });
      await MessageNode.findByIdAndDelete(node._id);
    }
  });

  test('a promotion with an unapproved entryNodeId falls back to the fixed default', async () => {
    const node = await MessageNode.create({
      ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Hi {{1}}!',
      templateStatus: 'pending', buttons: [],
    });
    await Promotion.findByIdAndUpdate(promotion._id, { entryNodeId: node._id });
    try {
      const res = await ops.sendPromotion({ promotionId: promotion._id, customerIds: [customer._id] });
      expect(res.sentCount + res.errors.length).toBe(1);

      // The unapproved entry node must never be used — but unlike the entry-node
      // branch, the default path's own interactive announcement typically
      // succeeds synchronously even outside the 24h window (Meta only fails it
      // asynchronously later), so it never actually reaches the PROMO_TEMPLATE
      // fallback here. What matters is that nothing routed through the custom node.
      const cm = await CampaignMessage.findOne({ promotion: promotion._id, customer: customer._id }).sort({ createdAt: -1 });
      expect(cm.templateName).not.toBe('waflow_promo_test_custom');
      expect(cm.messageNode).toBeFalsy();
    } finally {
      await Promotion.findByIdAndUpdate(promotion._id, { $unset: { entryNodeId: 1 } });
      await MessageNode.findByIdAndDelete(node._id);
    }
  });
});

describe('promotion branching: deletePromotion cascades to its MessageNode subtree', () => {
  test('deleting a promotion removes its entry node and follow-up nodes', async () => {
    await connectOnce();
    const promotion = await Promotion.create({ name: '__test_promo_branch_delete__', scope: 'products', customerType: 'cash', type: 'store_wide' });
    const followUp = await MessageNode.create({ ownerType: 'promotion', ownerId: promotion._id, bodyText: 'Follow-up', buttons: [] });
    const entry = await MessageNode.create({
      ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Entry',
      buttons: [{ position: 0, label: 'Next', nextAction: { type: 'send_message', targetNodeId: followUp._id } }],
    });
    await Promotion.findByIdAndUpdate(promotion._id, { entryNodeId: entry._id });

    await ops.deletePromotion({ id: promotion._id });

    expect(await MessageNode.findById(entry._id)).toBeNull();
    expect(await MessageNode.findById(followUp._id)).toBeNull();
    expect(await Promotion.findById(promotion._id)).toBeNull();
  });
});

describe('promotion branching: webhook button-tap attributes the follow-up to the promotion', () => {
  let customer, entryNode, target;

  beforeAll(async () => {
    await connectOnce();
    customer = await Customer.create({ firstname: '__test_promo_tap_customer__', lastname: 'Test', phone: '15558801' });
    target = await MessageNode.create({ ownerType: 'promotion', ownerId: customer._id, bodyText: 'Follow-up for {{1}}', buttons: [] });
    entryNode = await MessageNode.create({
      ownerType: 'promotion', ownerId: customer._id, isEntryNode: true, bodyText: 'Pick one, {{1}}',
      buttons: [{ position: 0, label: 'Option A', nextAction: { type: 'send_message', targetNodeId: target._id } }],
    });
  }, 15000);

  afterAll(async () => {
    await MessageNode.deleteMany({ _id: { $in: [entryNode._id, target._id] } });
    await CampaignMessage.deleteMany({ customer: customer._id });
    await Customer.findByIdAndDelete(customer._id);
  });

  test('a tap on a promotion-sourced message creates a promotion-kind follow-up, not flow-kind', async () => {
    const promotionId = customer._id; // any real-looking ObjectId works — nothing dereferences it in this test
    const cm = await CampaignMessage.create({
      kind: 'promotion', promotion: promotionId, customer: customer._id, phone: customer.phone,
      wamid: 'wamid.PROMO_BRANCH_TAP', messageType: 'template', messageNode: entryNode._id,
      status: 'sent', sentAt: new Date(),
    });

    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        messages: [{
          from: customer.phone, type: 'interactive', context: { id: 'wamid.PROMO_BRANCH_TAP' },
          interactive: { type: 'button_reply', button_reply: { id: `msgnode_${entryNode._id}_0` } },
        }],
      } }] }],
    });

    const followUp = await waitUntil(() => CampaignMessage.findOne({ messageNode: target._id, customer: customer._id }));
    expect(followUp.kind).toBe('promotion');
    expect(followUp.promotion?.toString()).toBe(promotionId.toString());
    expect(followUp.flow).toBeFalsy();

    const updatedEntry = await CampaignMessage.findById(cm._id);
    expect(updatedEntry.clickedButtonPosition).toBe(0);
  }, 15000);
});

describe('getPromotionMessageVariables', () => {
  test('returns the fixed 4-slot variable list', () => {
    const vars = ops.getPromotionMessageVariables();
    expect(vars.map(v => v.key)).toEqual(['customerName', 'itemName', 'priceOrPoints', 'promoName']);
    expect(vars.map(v => v.slot)).toEqual([1, 2, 3, 4]);
  });
});
