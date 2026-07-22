require('dotenv').config();
const request = require('supertest');

const { connectOnce } = require('./dbSetup');
const app = require('../server');
const Customer = require('../models/Customer');
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

describe('flow branching: apply_discount / redeem_points are visible no-ops', () => {
  let customer, node;

  beforeAll(async () => {
    await connectOnce();
    customer = await Customer.create({ firstname: '__test_notimpl_customer__', lastname: 'Test', phone: '15559199' });
    node = await MessageNode.create({
      ownerType: 'flow', ownerId: customer._id, isEntryNode: true, bodyText: 'Pick one, {{1}}',
      buttons: [
        { position: 0, label: 'Discount', nextAction: { type: 'apply_discount' } },
        { position: 1, label: 'Redeem', nextAction: { type: 'redeem_points' } },
      ],
    });
  }, 15000);

  afterAll(async () => {
    await MessageNode.findByIdAndDelete(node._id);
    await CampaignMessage.deleteMany({ customer: customer._id });
    await Customer.findByIdAndDelete(customer._id);
  });

  function tapButton(wamid, position) {
    return request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        messages: [{
          from: customer.phone, type: 'interactive', context: { id: wamid },
          interactive: { type: 'button_reply', button_reply: { id: `msgnode_${node._id}_${position}` } },
        }],
      } }] }],
    });
  }

  test('tapping "apply_discount" does not crash and records a visible not-implemented marker', async () => {
    const cm = await CampaignMessage.create({
      kind: 'flow', customer: customer._id, phone: customer.phone,
      wamid: 'wamid.NOTIMPL_DISCOUNT', messageType: 'template', messageNode: node._id, status: 'sent', sentAt: new Date(),
    });
    await tapButton('wamid.NOTIMPL_DISCOUNT', 0);

    const updated = await waitUntil(async () => {
      const doc = await CampaignMessage.findById(cm._id);
      return doc.respondedAt ? doc : null;
    });
    expect(updated.clickedButtonPosition).toBe(0);

    const marker = await waitUntil(() => CampaignMessage.findOne({ customer: customer._id, statusReason: 'action_not_implemented:apply_discount' }));
    expect(marker.status).toBe('failed');
  }, 15000);

  test('tapping "redeem_points" does not crash and records a visible not-implemented marker', async () => {
    const cm = await CampaignMessage.create({
      kind: 'flow', customer: customer._id, phone: customer.phone,
      wamid: 'wamid.NOTIMPL_REDEEM', messageType: 'template', messageNode: node._id, status: 'sent', sentAt: new Date(),
    });
    await tapButton('wamid.NOTIMPL_REDEEM', 1);

    const updated = await waitUntil(async () => {
      const doc = await CampaignMessage.findById(cm._id);
      return doc.respondedAt ? doc : null;
    });
    expect(updated.clickedButtonPosition).toBe(1);

    const marker = await waitUntil(() => CampaignMessage.findOne({ customer: customer._id, statusReason: 'action_not_implemented:redeem_points' }));
    expect(marker.status).toBe('failed');
  }, 15000);
});
