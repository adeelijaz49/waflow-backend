require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const { getTestWorkspaceId } = require('./testAuth');
const app = require('../server');
const Customer = require('../models/Customer');
const ConsentEvent = require('../models/ConsentEvent');
const {
  canSendMarketing, grantMarketingConsent, withdrawMarketingConsent,
  reinstateMarketingConsent, declineMarketingConsent,
} = require('../shared/consent');

describe('shared/consent.js', () => {
  let customer, workspaceId;

  beforeAll(async () => {
    await connectOnce();
    workspaceId = await getTestWorkspaceId(app);
  });

  beforeEach(async () => {
    customer = await Customer.create({ firstname: '__test_consent__', lastname: 'Test', phone: '15559991000' + Math.floor(Math.random() * 1000), workspaceId });
  });

  afterEach(async () => {
    await ConsentEvent.deleteMany({ customerId: customer._id });
    await Customer.findByIdAndDelete(customer._id);
  });

  test('canSendMarketing requires both consent and not-opted-out', () => {
    expect(canSendMarketing({ marketingConsent: false, optedOut: false })).toBe(false);
    expect(canSendMarketing({ marketingConsent: true, optedOut: true })).toBe(false);
    expect(canSendMarketing({ marketingConsent: true, optedOut: false })).toBe(true);
    expect(canSendMarketing(null)).toBe(false);
  });

  test('grantMarketingConsent sets fields and writes exactly one consent_given event', async () => {
    await grantMarketingConsent({ customer, method: 'checkbox_manual', source: 'test' });
    const updated = await Customer.findById(customer._id);
    expect(updated.marketingConsent).toBe(true);
    expect(updated.marketingConsentAt).toBeTruthy();
    expect(updated.marketingConsentMethod).toBe('checkbox_manual');

    const events = await ConsentEvent.find({ customerId: customer._id });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('consent_given');
    expect(events[0].method).toBe('checkbox_manual');
    expect(events[0].phone).toBe(customer.phone);
  });

  test('withdrawMarketingConsent sets optedOut and writes a consent_withdrawn event', async () => {
    await withdrawMarketingConsent({ customer, method: 'whatsapp_stop_command', source: 'test' });
    const updated = await Customer.findById(customer._id);
    expect(updated.optedOut).toBe(true);
    expect(updated.optedOutAt).toBeTruthy();

    const events = await ConsentEvent.find({ customerId: customer._id });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('consent_withdrawn');
  });

  test('reinstateMarketingConsent is a no-op and logs nothing if the customer never consented', async () => {
    await withdrawMarketingConsent({ customer, method: 'whatsapp_stop_command', source: 'test' });
    const reinstated = await reinstateMarketingConsent({ customer, method: 'whatsapp_start_command', source: 'test' });
    expect(reinstated).toBe(false);

    const updated = await Customer.findById(customer._id);
    expect(updated.optedOut).toBe(true); // still opted out — never fabricated consent

    const events = await ConsentEvent.find({ customerId: customer._id });
    expect(events.map(e => e.type)).toEqual(['consent_withdrawn']); // no reinstated event
  });

  test('reinstateMarketingConsent clears optedOut and logs an event when consent was real', async () => {
    await grantMarketingConsent({ customer, method: 'checkbox_manual', source: 'test' });
    await withdrawMarketingConsent({ customer, method: 'whatsapp_stop_command', source: 'test' });

    const reinstated = await reinstateMarketingConsent({ customer, method: 'whatsapp_start_command', source: 'test' });
    expect(reinstated).toBe(true);

    const updated = await Customer.findById(customer._id);
    expect(updated.optedOut).toBe(false);
    expect(updated.optedOutAt).toBeNull();

    const events = await ConsentEvent.find({ customerId: customer._id }).sort({ createdAt: 1 });
    expect(events.map(e => e.type)).toEqual(['consent_given', 'consent_withdrawn', 'consent_reinstated']);
  });

  test('declineMarketingConsent logs a consent_declined event without changing marketingConsent', async () => {
    await declineMarketingConsent({ customer, method: 'whatsapp_button', source: 'test' });
    const updated = await Customer.findById(customer._id);
    expect(updated.marketingConsent).toBe(false);

    const events = await ConsentEvent.find({ customerId: customer._id });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('consent_declined');
  });
});
