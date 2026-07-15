require('dotenv').config();
const request  = require('supertest');

const { connectOnce } = require('./dbSetup');
const app             = require('../server');
const Customer        = require('../models/Customer');
const Promotion       = require('../models/Promotion');
const CampaignMessage = require('../models/CampaignMessage');

// Obviously-synthetic number — not a real WhatsApp account, used only so the
// webhook's own (try/catch-guarded) reply attempts have somewhere to fail quietly.
const TEST_PHONE = '15550001111';

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// The webhook responds 200 immediately (res.sendStatus(200)) and keeps
// processing asynchronously afterward — Supertest's request resolving tells
// you nothing about whether that background work has finished. A fixed sleep
// is a guess at how long that takes against a real (cloud, latency-variable)
// Mongo instance; poll instead so the test is correct at whatever speed the
// DB happens to respond, not flaky at a guessed threshold.
async function waitUntil(checkFn, { timeout = 4000, interval = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await checkFn();
    if (result) return result;
    await wait(interval);
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

describe('webhook: status callbacks, opt-out, and click correlation', () => {
  let customer, promotion, cm;

  beforeAll(async () => {
    await connectOnce();
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
  });

  test('statuses[] "delivered" updates the matching CampaignMessage', async () => {
    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        statuses: [{ id: 'wamid.TEST123', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) }],
      } }] }],
    });
    const updated = await waitUntil(async () => {
      const doc = await CampaignMessage.findById(cm._id);
      return doc.status === 'delivered' ? doc : null;
    });
    expect(updated.status).toBe('delivered');
    expect(updated.deliveredAt).toBeTruthy();
  });

  test('monotonic guard: an out-of-order "sent" cannot downgrade "read"', async () => {
    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        statuses: [{ id: 'wamid.TEST123', status: 'read', timestamp: String(Math.floor(Date.now() / 1000)) }],
      } }] }],
    });
    await waitUntil(async () => {
      const doc = await CampaignMessage.findById(cm._id);
      return doc.status === 'read' ? doc : null;
    });

    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        statuses: [{ id: 'wamid.TEST123', status: 'sent', timestamp: String(Math.floor(Date.now() / 1000)) }],
      } }] }],
    });
    // Give the (should-be-ignored) event a moment to land, then confirm no downgrade.
    await wait(500);
    const updated = await CampaignMessage.findById(cm._id);
    expect(updated.status).toBe('read'); // unchanged — not downgraded
  });

  test('STOP opts the customer out', async () => {
    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        messages: [{ from: TEST_PHONE, type: 'text', text: { body: 'STOP' } }],
      } }] }],
    });
    const updated = await waitUntil(async () => {
      const doc = await Customer.findById(customer._id);
      return doc.optedOut ? doc : null;
    });
    expect(updated.optedOut).toBe(true);
    expect(updated.optedOutAt).toBeTruthy();
  });

  test('START opts the customer back in', async () => {
    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        messages: [{ from: TEST_PHONE, type: 'text', text: { body: 'START' } }],
      } }] }],
    });
    const updated = await waitUntil(async () => {
      const doc = await Customer.findById(customer._id);
      return doc.optedOut === false ? doc : null;
    });
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
    const updated = await waitUntil(async () => {
      const doc = await CampaignMessage.findById(cm._id);
      return doc.clickedAt ? doc : null;
    });
    expect(updated.clickedAt).toBeTruthy();
  });
});
