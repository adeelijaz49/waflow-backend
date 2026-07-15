require('dotenv').config();
const request  = require('supertest');
const mongoose = require('mongoose');

const app             = require('../server');
const Customer        = require('../models/Customer');
const Promotion       = require('../models/Promotion');
const CampaignMessage = require('../models/CampaignMessage');

// Obviously-synthetic number — not a real WhatsApp account, used only so the
// webhook's own (try/catch-guarded) reply attempts have somewhere to fail quietly.
const TEST_PHONE = '15550001111';

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

describe('webhook: status callbacks, opt-out, and click correlation', () => {
  let customer, promotion, cm;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
    }
    customer = await Customer.create({ firstname: 'Test', lastname: 'Webhook', phone: TEST_PHONE });
    promotion = await Promotion.create({ name: '__test_campaign__', scope: 'products', customerType: 'cash' });
    cm = await CampaignMessage.create({
      kind: 'promotion', promotion: promotion._id, customer: customer._id, phone: TEST_PHONE,
      wamid: 'wamid.TEST123', messageType: 'interactive', status: 'sent', sentAt: new Date(),
    });
  });

  afterAll(async () => {
    await CampaignMessage.deleteMany({ customer: customer._id });
    await Promotion.findByIdAndDelete(promotion._id);
    await Customer.findByIdAndDelete(customer._id);
    await mongoose.disconnect();
  });

  test('statuses[] "delivered" updates the matching CampaignMessage', async () => {
    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        statuses: [{ id: 'wamid.TEST123', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) }],
      } }] }],
    });
    await wait(300);
    const updated = await CampaignMessage.findById(cm._id);
    expect(updated.status).toBe('delivered');
    expect(updated.deliveredAt).toBeTruthy();
  });

  test('monotonic guard: an out-of-order "sent" cannot downgrade "read"', async () => {
    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        statuses: [{ id: 'wamid.TEST123', status: 'read', timestamp: String(Math.floor(Date.now() / 1000)) }],
      } }] }],
    });
    await wait(300);
    let updated = await CampaignMessage.findById(cm._id);
    expect(updated.status).toBe('read');

    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        statuses: [{ id: 'wamid.TEST123', status: 'sent', timestamp: String(Math.floor(Date.now() / 1000)) }],
      } }] }],
    });
    await wait(300);
    updated = await CampaignMessage.findById(cm._id);
    expect(updated.status).toBe('read'); // unchanged — not downgraded
  });

  test('STOP opts the customer out', async () => {
    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        messages: [{ from: TEST_PHONE, type: 'text', text: { body: 'STOP' } }],
      } }] }],
    });
    await wait(300);
    const updated = await Customer.findById(customer._id);
    expect(updated.optedOut).toBe(true);
    expect(updated.optedOutAt).toBeTruthy();
  });

  test('START opts the customer back in', async () => {
    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        messages: [{ from: TEST_PHONE, type: 'text', text: { body: 'START' } }],
      } }] }],
    });
    await wait(300);
    const updated = await Customer.findById(customer._id);
    expect(updated.optedOut).toBe(false);
  });

  test('a button tap correlates back to the CampaignMessage via context.id', async () => {
    await CampaignMessage.findByIdAndUpdate(cm._id, { clickedAt: null });
    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        messages: [{
          from: TEST_PHONE, type: 'interactive', context: { id: 'wamid.TEST123' },
          interactive: { type: 'button_reply', button_reply: { id: `promo_${promotion._id}` } },
        }],
      } }] }],
    });
    await wait(500);
    const updated = await CampaignMessage.findById(cm._id);
    expect(updated.clickedAt).toBeTruthy();
  });
});
