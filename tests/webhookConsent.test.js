require('dotenv').config();
const request = require('supertest');

const { connectOnce } = require('./dbSetup');
const { getTestWorkspaceId } = require('./testAuth');
const app = require('../server');
const Customer = require('../models/Customer');
const ConsentEvent = require('../models/ConsentEvent');

const TEST_PHONE = '15550002222';

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

describe('webhook: consent_yes_/consent_no_ button taps', () => {
  let customer, workspaceId;

  beforeAll(async () => {
    await connectOnce();
    workspaceId = await getTestWorkspaceId(app);
  }, 30000);

  afterEach(async () => {
    if (customer) {
      await ConsentEvent.deleteMany({ customerId: customer._id });
      await Customer.findByIdAndDelete(customer._id);
      customer = null;
    }
  });

  test('tapping "Yes, sign me up" grants consent and logs a whatsapp_button event', async () => {
    customer = await Customer.create({ firstname: 'Test', lastname: 'Consent', phone: TEST_PHONE, workspaceId });

    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        messages: [{
          from: TEST_PHONE, type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: `consent_yes_${customer._id}` } },
        }],
      } }] }],
    });

    const updated = await waitUntil(async () => {
      const doc = await Customer.findById(customer._id);
      return doc.marketingConsent ? doc : null;
    });
    expect(updated.marketingConsent).toBe(true);
    expect(updated.marketingConsentMethod).toBe('whatsapp_button');

    const events = await ConsentEvent.find({ customerId: customer._id });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('consent_given');
    expect(events[0].method).toBe('whatsapp_button');
  });

  test('tapping "No thanks" logs a decline without granting consent', async () => {
    customer = await Customer.create({ firstname: 'Test', lastname: 'Decline', phone: TEST_PHONE, workspaceId });

    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        messages: [{
          from: TEST_PHONE, type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: `consent_no_${customer._id}` } },
        }],
      } }] }],
    });

    const updated = await waitUntil(async () => {
      const evs = await ConsentEvent.find({ customerId: customer._id });
      return evs.length ? evs : null;
    });
    expect(updated.length).toBe(1);
    expect(updated[0].type).toBe('consent_declined');

    const doc = await Customer.findById(customer._id);
    expect(doc.marketingConsent).toBe(false);
  });
});
